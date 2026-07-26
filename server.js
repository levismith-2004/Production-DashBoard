const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PCO_APP_ID = process.env.PCO_APP_ID || '';
const PCO_SECRET = process.env.PCO_SECRET || '';

// ── Asana (Flags → tasks) ────────────────────────────────────────────────────
const ASANA_TOKEN = process.env.ASANA_TOKEN || '';
const ASANA_WORKSPACE = process.env.ASANA_WORKSPACE || '';
const ASANA_PROJECT = process.env.ASANA_PROJECT || '';
function asanaEnabled() { return !!(ASANA_TOKEN && ASANA_WORKSPACE && ASANA_PROJECT); }

// ── ProPresenter bridge ──────────────────────────────────────────────────────
// The bridge script runs headless at church and pushes live data here using
// this shared key (it has no user login). Set PROPRESENTER_KEY in Railway.
const PROPRESENTER_KEY = process.env.PROPRESENTER_KEY || '';

// ── Supabase config (data + file storage) ────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || '';        // https://xxxx.supabase.co
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';        // sb_secret_... (server-side only)
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'processes';

function supabaseEnabled() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

// Parse the Supabase hostname once
const SUPABASE_HOST = SUPABASE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');

// Generic Supabase REST helper for the app_data key-value table
function supabaseHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  }, extra || {});
}

// Read one key's value from app_data. Returns parsed value or null.
async function supabaseGet(key) {
  const result = await httpsRequest({
    hostname: SUPABASE_HOST,
    path: `/rest/v1/app_data?key=eq.${encodeURIComponent(key)}&select=value`,
    method: 'GET',
    headers: supabaseHeaders(),
  });
  if (result.status >= 200 && result.status < 300) {
    const rows = JSON.parse(result.body || '[]');
    return rows.length ? rows[0].value : null;
  }
  throw new Error(`Supabase GET ${key} failed: ${result.status} ${result.body}`);
}

// Upsert one key's value into app_data
async function supabaseSet(key, value) {
  const body = JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]);
  const result = await httpsRequest({
    hostname: SUPABASE_HOST,
    path: `/rest/v1/app_data?on_conflict=key`,
    method: 'POST',
    headers: supabaseHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
  }, body);
  if (result.status >= 200 && result.status < 300) return true;
  throw new Error(`Supabase SET ${key} failed: ${result.status} ${result.body}`);
}

// True if a value counts as "no data" (handles arrays and objects)
function isEmptyData(v) {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// Read a key from Supabase. If the key doesn't exist yet (first run after
// migration), seed it once from the old GitHub file, then use Supabase forever.
// The GitHub data repo is never modified — it stays as a read-only backup.
async function supabaseReadOrSeed(key, githubPath, fallback) {
  const val = await supabaseGet(key);
  if (val !== null) return val;  // already migrated (even if empty)

  if (githubEnabled() && githubPath) {
    try {
      const { items } = await githubGetFile(githubPath);
      if (!isEmptyData(items)) {
        await supabaseSet(key, items);
        console.log(`Seeded '${key}' from GitHub into Supabase.`);
        return items;
      }
    } catch (e) {
      console.warn(`Seed '${key}' from GitHub failed:`, e.message);
    }
  }
  await supabaseSet(key, fallback);  // mark as migrated so we don't retry each read
  return fallback;
}

// ── Supabase Auth ────────────────────────────────────────────────────────────
// Auth endpoints use the publishable (anon) key, not the secret key.
// Publishable keys are designed to be public, so a default is safe here.
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'sb_publishable_GTYis9vXmNnC8SdgA4Zf2A_1pfcv1w2';

function supabaseAuthRequest(pathSuffix, method, bodyObj, bearerToken) {
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };
  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;
  const body = bodyObj ? JSON.stringify(bodyObj) : undefined;
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  return httpsRequest({
    hostname: SUPABASE_HOST,
    path: '/auth/v1' + pathSuffix,
    method,
    headers,
  }, body);
}

// Sign in with email + password. Returns {ok, token, email} or {ok:false, error}
async function supabaseSignIn(email, password) {
  const result = await supabaseAuthRequest('/token?grant_type=password', 'POST',
    { email, password });
  let parsed = {};
  try { parsed = JSON.parse(result.body || '{}'); } catch (e) { /* ignore */ }
  if (result.status >= 200 && result.status < 300 && parsed.access_token) {
    return {
      ok: true,
      token: parsed.access_token,
      email: (parsed.user && parsed.user.email) || email,
      userId: (parsed.user && parsed.user.id) || null,
    };
  }
  return {
    ok: false,
    error: parsed.error_description || parsed.msg || parsed.error || 'Invalid email or password',
  };
}

// Verify an access token is still valid. Returns the user object or null.
async function supabaseVerifyToken(token) {
  if (!token) return null;
  try {
    const result = await supabaseAuthRequest('/user', 'GET', null, token);
    if (result.status >= 200 && result.status < 300) {
      return JSON.parse(result.body || '{}');
    }
  } catch (e) { console.warn('token verify error:', e.message); }
  return null;
}

// Send a password reset email
async function supabaseSendRecovery(email, redirectTo) {
  const suffix = redirectTo ? `/recover?redirect_to=${encodeURIComponent(redirectTo)}` : '/recover';
  const result = await supabaseAuthRequest(suffix, 'POST', { email });
  // Supabase returns 200 even for unknown emails (prevents email enumeration)
  return result.status >= 200 && result.status < 300;
}

// Set a new password using a recovery token from the emailed link
async function supabaseUpdatePassword(token, newPassword) {
  const result = await supabaseAuthRequest('/user', 'PUT', { password: newPassword }, token);
  let parsed = {};
  try { parsed = JSON.parse(result.body || '{}'); } catch (e) { /* ignore */ }
  if (result.status >= 200 && result.status < 300) return { ok: true };
  return { ok: false, error: parsed.msg || parsed.error_description || 'Could not update password' };
}

// ── Asana API ────────────────────────────────────────────────────────────────
function asanaRequest(method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : undefined;
    const headers = {
      'Authorization': `Bearer ${ASANA_TOKEN}`,
      'Accept': 'application/json',
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const r = https.request({
      hostname: 'app.asana.com',
      path: '/api/1.0' + apiPath,
      method,
      headers,
    }, (resp) => {
      let data = '';
      resp.on('data', c => { data += c; });
      resp.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data || '{}'); } catch (e) { /* ignore */ }
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          resolve(parsed.data);
        } else {
          const msg = (parsed.errors && parsed.errors[0] && parsed.errors[0].message) || data || 'Asana error';
          reject(new Error(`Asana ${resp.statusCode}: ${msg}`));
        }
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// Create a task from a flag. Returns the new task's gid, or null on failure.
async function asanaCreateTask(flag) {
  if (!asanaEnabled()) return null;
  try {
    const msg = flag.message || flag.title || flag.body || 'Flag from Production Dashboard';
    const notes = flag.author ? `Posted by ${flag.author} via Production Dashboard` : 'Posted via Production Dashboard';
    const task = await asanaRequest('POST', '/tasks', {
      data: {
        workspace: ASANA_WORKSPACE,
        projects: [ASANA_PROJECT],
        name: msg.length > 120 ? msg.slice(0, 117) + '…' : msg,
        notes: msg + '\n\n' + notes,
      },
    });
    return task && task.gid ? task.gid : null;
  } catch (e) {
    console.warn('asanaCreateTask failed:', e.message);
    return null;  // never let an Asana hiccup block posting a flag
  }
}

// Mark a task complete (used when a flag is deleted)
async function asanaCompleteTask(gid) {
  if (!asanaEnabled() || !gid) return;
  try {
    await asanaRequest('PUT', `/tasks/${gid}`, { data: { completed: true } });
  } catch (e) {
    console.warn('asanaCompleteTask failed:', e.message);
  }
}

// Fetch completion state for a set of task gids. Returns { gid: bool }.
async function asanaFetchStatuses(gids) {
  const out = {};
  if (!asanaEnabled() || !gids.length) return out;
  await Promise.all(gids.map(async (gid) => {
    try {
      const t = await asanaRequest('GET', `/tasks/${gid}?opt_fields=completed`);
      if (t) out[gid] = !!t.completed;
    } catch (e) { /* task may have been deleted in Asana; skip */ }
  }));
  return out;
}

// ── Supabase Storage (PDF files) ─────────────────────────────────────────────
// Upload a binary buffer to the storage bucket. Returns the public URL.
function supabaseUpload(objectPath, buffer, contentType) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: SUPABASE_HOST,
      path: `/storage/v1/object/${SUPABASE_BUCKET}/${encodeURIComponent(objectPath)}`,
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': buffer.length,
        'x-upsert': 'true',
      },
    };
    const req = https.request(opts, (r) => {
      let data = '';
      r.on('data', c => { data += c; });
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) {
          const publicUrl = `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`;
          resolve(publicUrl);
        } else {
          reject(new Error(`Upload failed: ${r.statusCode} ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

// Delete an object from the storage bucket
async function supabaseDeleteFile(objectPath) {
  const result = await httpsRequest({
    hostname: SUPABASE_HOST,
    path: `/storage/v1/object/${SUPABASE_BUCKET}/${encodeURIComponent(objectPath)}`,
    method: 'DELETE',
    headers: supabaseHeaders(),
  });
  if (result.status >= 200 && result.status < 300) return true;
  throw new Error(`Delete failed: ${result.status} ${result.body}`);
}



// GitHub-backed inventory config (set these in Railway environment variables)
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || '';
const GITHUB_REPO   = process.env.GITHUB_REPO   || ''; // e.g. "yourname/production-dashboard"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_PATH   = 'inventory.json';
const ANNOUNCEMENTS_PATH = 'announcements.json';
const PATCH_PATH = 'patch.json';
const SIGNALFLOW_PATH = 'signalflow.json';
const HOMELAYOUT_PATH = 'homelayout.json';

// Per-user data file path in the data repo
function userDataPath(username) {
  return `users/${username.toLowerCase()}.json`;
}

// Local file fallback (used if GitHub env vars not set)
const INVENTORY_FILE = path.join(__dirname, 'inventory.json');
const ANNOUNCEMENTS_FILE = path.join(__dirname, 'announcements.json');
const PATCH_FILE = path.join(__dirname, 'patch.json');
const SIGNALFLOW_FILE = path.join(__dirname, 'signalflow.json');
const HOMELAYOUT_FILE = path.join(__dirname, 'homelayout.json');

// ── Helpers ────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    function doRequest(opts) {
      const req = https.request(opts, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, `https://${opts.hostname}`);
          const redirectOpts = {
            hostname: redirectUrl.hostname,
            path: redirectUrl.pathname + redirectUrl.search,
            method: opts.method,
            headers: opts.headers,
          };
          return doRequest(redirectOpts);
        }
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    }
    doRequest(options);
  });
}

// ── PCO proxy helper ────────────────────────────────────────────────────────

function pcoOptions(method, pcoPath, authHeader) {
  const base64 = authHeader || Buffer.from(`${PCO_APP_ID}:${PCO_SECRET}`).toString('base64');
  return {
    hostname: 'api.planningcenteronline.com',
    path: pcoPath,
    method,
    headers: {
      'Authorization': `Basic ${base64}`,
      'Content-Type': 'application/json',
      'X-PCO-API-Version': '2018-11-01',
    },
  };
}

// ── GitHub inventory helpers ────────────────────────────────────────────────
// If GITHUB_TOKEN + GITHUB_REPO are set, all reads/writes go to GitHub.
// Otherwise falls back to local inventory.json (useful for local dev).

const githubEnabled = () => !!(GITHUB_TOKEN && GITHUB_REPO);

// Fetch the file content + SHA from GitHub (needed for writes)
async function githubGetFile(filePath) {
  const result = await httpsRequest({
    hostname: 'api.github.com',
    path: `/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'production-dashboard',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (result.status === 404) return { items: [], sha: null };
  const data = JSON.parse(result.body);
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  const items = JSON.parse(content);
  return { items, sha: data.sha };
}

// Write updated items array back to GitHub
async function githubWriteFile(filePath, items, sha, message) {
  const content = Buffer.from(JSON.stringify(items, null, 2)).toString('base64');
  const body = { message: message || 'Update file', content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  const result = await httpsRequest({
    hostname: 'api.github.com',
    path: `/repos/${GITHUB_REPO}/contents/${filePath}`,
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'production-dashboard',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }, JSON.stringify(body));
  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`GitHub write failed: ${result.status} ${result.body}`);
  }
  return JSON.parse(result.body);
}

// ── Local inventory fallback ────────────────────────────────────────────────

function localRead() {
  try {
    if (!fs.existsSync(INVENTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
  } catch (e) {
    console.warn('localRead error:', e);
    return [];
  }
}

function localWrite(items) {
  fs.writeFileSync(INVENTORY_FILE, JSON.stringify(items, null, 2), 'utf8');
}

// ── Unified inventory API ───────────────────────────────────────────────────

async function inventoryRead() {
  if (supabaseEnabled()) {
    const val = await supabaseReadOrSeed('inventory', GITHUB_PATH, []);
    return Array.isArray(val) ? val : [];
  }
  if (githubEnabled()) {
    const { items } = await githubGetFile(GITHUB_PATH);
    return items;
  }
  return localRead();
}

async function inventoryAdd(item) {
  item.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  item.quantity    = Number(item.quantity)    || 1;
  item.value       = Number(item.value)       || 0;
  item.retailValue = Number(item.retailValue) || 0;
  if (supabaseEnabled()) {
    const items = await inventoryRead();
    items.push(item);
    await supabaseSet('inventory', items);
    return item;
  }
  if (githubEnabled()) {
    const { items, sha } = await githubGetFile(GITHUB_PATH);
    items.push(item);
    await githubWriteFile(GITHUB_PATH, items, sha, `Add inventory item: ${item.item}`);
  } else {
    const items = localRead();
    items.push(item);
    localWrite(items);
  }
  return item;
}

async function inventoryUpdate(id, updates) {
  if (supabaseEnabled()) {
    const items = await inventoryRead();
    const idx = items.findIndex(i => i.id === id);
    if (idx === -1) throw new Error('Not found');
    items[idx] = { ...items[idx], ...updates, id };
    items[idx].quantity    = Number(items[idx].quantity)    || 1;
    items[idx].value       = Number(items[idx].value)       || 0;
    items[idx].retailValue = Number(items[idx].retailValue) || 0;
    await supabaseSet('inventory', items);
    return items[idx];
  }
  if (githubEnabled()) {
    const { items, sha } = await githubGetFile(GITHUB_PATH);
    const idx = items.findIndex(i => i.id === id);
    if (idx === -1) throw new Error('Not found');
    items[idx] = { ...items[idx], ...updates, id };
    items[idx].quantity    = Number(items[idx].quantity)    || 1;
    items[idx].value       = Number(items[idx].value)       || 0;
    items[idx].retailValue = Number(items[idx].retailValue) || 0;
    await githubWriteFile(GITHUB_PATH, items, sha, `Update inventory item: ${items[idx].item}`);
    return items[idx];
  } else {
    const items = localRead();
    const idx = items.findIndex(i => i.id === id);
    if (idx === -1) throw new Error('Not found');
    items[idx] = { ...items[idx], ...updates, id };
    items[idx].quantity    = Number(items[idx].quantity)    || 1;
    items[idx].value       = Number(items[idx].value)       || 0;
    items[idx].retailValue = Number(items[idx].retailValue) || 0;
    localWrite(items);
    return items[idx];
  }
}

async function inventoryDelete(id) {
  if (supabaseEnabled()) {
    const items = await inventoryRead();
    const filtered = items.filter(i => i.id !== id);
    if (filtered.length === items.length) throw new Error('Not found');
    await supabaseSet('inventory', filtered);
    return;
  }
  if (githubEnabled()) {
    const { items, sha } = await githubGetFile(GITHUB_PATH);
    const filtered = items.filter(i => i.id !== id);
    if (filtered.length === items.length) throw new Error('Not found');
    await githubWriteFile(GITHUB_PATH, filtered, sha, `Delete inventory item ${id}`);
  } else {
    const items = localRead();
    const filtered = items.filter(i => i.id !== id);
    if (filtered.length === items.length) throw new Error('Not found');
    localWrite(filtered);
  }
}

// ── Announcements CRUD ──────────────────────────────────────────────────────

async function announcementsRead() {
  if (supabaseEnabled()) {
    let val = await supabaseGet('announcements');
    // One-time migration: if Supabase has no announcements yet but GitHub does, copy them over
    if (val === null && githubEnabled()) {
      try {
        const { items } = await githubGetFile(ANNOUNCEMENTS_PATH);
        if (Array.isArray(items) && items.length) {
          await supabaseSet('announcements', items);
          return items;
        }
      } catch (e) { /* ignore, start empty */ }
      await supabaseSet('announcements', []); // mark as migrated (empty)
      return [];
    }
    return Array.isArray(val) ? val : [];
  }
  if (githubEnabled()) {
    const { items } = await githubGetFile(ANNOUNCEMENTS_PATH);
    return items;
  }
  try {
    if (!fs.existsSync(ANNOUNCEMENTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8'));
  } catch (e) { return []; }
}

async function announcementsAdd(ann) {
  ann.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  // Mirror the flag into Asana as a task (non-blocking on failure)
  const gid = await asanaCreateTask(ann);
  if (gid) ann.asanaGid = gid;
  if (supabaseEnabled()) {
    const items = await announcementsRead();
    items.unshift(ann);
    await supabaseSet('announcements', items);
    return ann;
  }
  if (githubEnabled()) {
    const { items, sha } = await githubGetFile(ANNOUNCEMENTS_PATH);
    items.unshift(ann);
    await githubWriteFile(ANNOUNCEMENTS_PATH, items, sha, `Add announcement`);
  } else {
    let items = [];
    try { if (fs.existsSync(ANNOUNCEMENTS_FILE)) items = JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8')); } catch(e) {}
    items.unshift(ann);
    fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(items, null, 2));
  }
  return ann;
}

async function announcementsDelete(id) {
  // Complete the linked Asana task (keeps history rather than destroying it)
  try {
    const all = await announcementsRead();
    const target = all.find(a => a.id === id);
    if (target && target.asanaGid) await asanaCompleteTask(target.asanaGid);
  } catch (e) { /* don't block deletion on Asana */ }

  if (supabaseEnabled()) {
    const items = await announcementsRead();
    await supabaseSet('announcements', items.filter(a => a.id !== id));
    return;
  }
  if (githubEnabled()) {
    const { items, sha } = await githubGetFile(ANNOUNCEMENTS_PATH);
    const filtered = items.filter(a => a.id !== id);
    await githubWriteFile(ANNOUNCEMENTS_PATH, filtered, sha, `Delete announcement`);
  } else {
    let items = [];
    try { if (fs.existsSync(ANNOUNCEMENTS_FILE)) items = JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8')); } catch(e) {}
    fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(items.filter(a => a.id !== id), null, 2));
  }
}

async function announcementsUpdate(id, updates) {
  if (supabaseEnabled()) {
    const items = await announcementsRead();
    const idx = items.findIndex(a => a.id === id);
    if (idx === -1) throw new Error('Not found');
    items[idx] = { ...items[idx], ...updates, id };
    await supabaseSet('announcements', items);
    return items[idx];
  }
  if (githubEnabled()) {
    const { items, sha } = await githubGetFile(ANNOUNCEMENTS_PATH);
    const idx = items.findIndex(a => a.id === id);
    if (idx === -1) throw new Error('Not found');
    items[idx] = { ...items[idx], ...updates, id };
    await githubWriteFile(ANNOUNCEMENTS_PATH, items, sha, `Update announcement`);
    return items[idx];
  } else {
    let items = [];
    try { if (fs.existsSync(ANNOUNCEMENTS_FILE)) items = JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8')); } catch(e) {}
    const idx = items.findIndex(a => a.id === id);
    if (idx === -1) throw new Error('Not found');
    items[idx] = { ...items[idx], ...updates, id };
    fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(items, null, 2));
    return items[idx];
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Patch sheet CRUD ────────────────────────────────────────────────────────

async function patchRead() {
  if (supabaseEnabled()) {
    const val = await supabaseReadOrSeed('patch', PATCH_PATH, {});
    return (val && typeof val === 'object') ? val : {};
  }
  if (githubEnabled()) {
    try {
      const result = await httpsRequest({
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_REPO}/contents/${PATCH_PATH}?ref=${GITHUB_BRANCH}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'production-dashboard',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (result.status === 404) return {};
      const data = JSON.parse(result.body);
      return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    } catch (e) { return {}; }
  }
  try {
    if (!fs.existsSync(PATCH_FILE)) return {};
    return JSON.parse(fs.readFileSync(PATCH_FILE, 'utf8'));
  } catch (e) { return {}; }
}

async function patchSave(data) {
  if (supabaseEnabled()) {
    await supabaseSet('patch', data);
    return;
  }
  if (githubEnabled()) {
    // For patch, we need to get SHA first
    const result = await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${PATCH_PATH}?ref=${GITHUB_BRANCH}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'production-dashboard',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const sha = result.status === 404 ? null : JSON.parse(result.body).sha;
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const body = { message: 'Update patch sheet', content, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${PATCH_PATH}`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'production-dashboard',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, JSON.stringify(body));
  } else {
    fs.writeFileSync(PATCH_FILE, JSON.stringify(data, null, 2), 'utf8');
  }
}

// ── Signal Flow CRUD ────────────────────────────────────────────────────────

async function signalFlowRead() {
  if (supabaseEnabled()) {
    const val = await supabaseReadOrSeed('signalflow', SIGNALFLOW_PATH, {});
    return (val && typeof val === 'object') ? val : {};
  }
  if (githubEnabled()) {
    try {
      const result = await httpsRequest({
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_REPO}/contents/${SIGNALFLOW_PATH}?ref=${GITHUB_BRANCH}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'production-dashboard',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (result.status === 404) return { nodes: [], connections: [] };
      const data = JSON.parse(result.body);
      return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    } catch (e) { return { nodes: [], connections: [] }; }
  }
  try {
    if (!fs.existsSync(SIGNALFLOW_FILE)) return { nodes: [], connections: [] };
    return JSON.parse(fs.readFileSync(SIGNALFLOW_FILE, 'utf8'));
  } catch (e) { return { nodes: [], connections: [] }; }
}

async function signalFlowSave(data) {
  if (supabaseEnabled()) {
    await supabaseSet('signalflow', data);
    return;
  }
  if (githubEnabled()) {
    const result = await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${SIGNALFLOW_PATH}?ref=${GITHUB_BRANCH}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'production-dashboard',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const sha = result.status === 404 ? null : JSON.parse(result.body).sha;
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const body = { message: 'Update signal flow', content, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${SIGNALFLOW_PATH}`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'production-dashboard',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, JSON.stringify(body));
  } else {
    fs.writeFileSync(SIGNALFLOW_FILE, JSON.stringify(data, null, 2), 'utf8');
  }
}

// ── Home layout CRUD ────────────────────────────────────────────────────────

async function homeLayoutRead() {
  if (supabaseEnabled()) {
    const val = await supabaseReadOrSeed('homelayout', HOMELAYOUT_PATH, {});
    return (val && typeof val === 'object') ? val : {};
  }
  if (githubEnabled()) {
    try {
      const result = await httpsRequest({
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_REPO}/contents/${HOMELAYOUT_PATH}?ref=${GITHUB_BRANCH}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'production-dashboard',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (result.status === 404) return {};
      const data = JSON.parse(result.body);
      return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    } catch (e) { return {}; }
  }
  try {
    if (!fs.existsSync(HOMELAYOUT_FILE)) return {};
    return JSON.parse(fs.readFileSync(HOMELAYOUT_FILE, 'utf8'));
  } catch (e) { return {}; }
}

async function homeLayoutSave(data) {
  if (supabaseEnabled()) {
    await supabaseSet('homelayout', data);
    return;
  }
  if (githubEnabled()) {
    const result = await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${HOMELAYOUT_PATH}?ref=${GITHUB_BRANCH}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'production-dashboard',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const sha = result.status === 404 ? null : JSON.parse(result.body).sha;
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const body = { message: 'Update home layout', content, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${HOMELAYOUT_PATH}`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'production-dashboard',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, JSON.stringify(body));
  } else {
    fs.writeFileSync(HOMELAYOUT_FILE, JSON.stringify(data, null, 2), 'utf8');
  }
}

// ── Per-user data (theme + layouts), seeded from defaults ───────────────────
const USER_DATA_DEFAULT = { theme: null, homelayout: {} };

async function userDataRead(username) {
  const p = userDataPath(username);
  if (supabaseEnabled()) {
    const key = 'userdata:' + String(username).toLowerCase();
    const val = await supabaseReadOrSeed(key, p, { ...USER_DATA_DEFAULT });
    return (val && typeof val === 'object') ? val : { ...USER_DATA_DEFAULT };
  }
  if (githubEnabled()) {
    try {
      const result = await httpsRequest({
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_REPO}/contents/${p}?ref=${GITHUB_BRANCH}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'production-dashboard',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (result.status === 404) return { ...USER_DATA_DEFAULT };
      const data = JSON.parse(result.body);
      return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    } catch (e) { return { ...USER_DATA_DEFAULT }; }
  }
  try {
    const lf = path.join(__dirname, `user-${username.toLowerCase()}.json`);
    if (!fs.existsSync(lf)) return { ...USER_DATA_DEFAULT };
    return JSON.parse(fs.readFileSync(lf, 'utf8'));
  } catch (e) { return { ...USER_DATA_DEFAULT }; }
}

async function userDataSave(username, data) {
  const p = userDataPath(username);
  if (supabaseEnabled()) {
    await supabaseSet('userdata:' + String(username).toLowerCase(), data);
    return;
  }
  if (githubEnabled()) {
    const result = await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${p}?ref=${GITHUB_BRANCH}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'production-dashboard',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const sha = result.status === 404 ? null : JSON.parse(result.body).sha;
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const body = { message: `Update user data: ${username}`, content, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${p}`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'production-dashboard',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, JSON.stringify(body));
  } else {
    const lf = path.join(__dirname, `user-${username.toLowerCase()}.json`);
    fs.writeFileSync(lf, JSON.stringify(data, null, 2), 'utf8');
  }
}

// ── Session / access control ─────────────────────────────────────────────────
// Set AUTH_ENFORCE=off in Railway to disable endpoint protection in an
// emergency (e.g. if a bad token change locks everyone out of their data).
const AUTH_ENFORCE = (process.env.AUTH_ENFORCE || 'on').toLowerCase() !== 'off';

// Sessions issued to people who signed in with the legacy shared password.
// Held in memory, so a redeploy signs everyone out — which is fine and normal.
const legacySessions = new Map(); // token -> issuedAt (ms)
const LEGACY_SESSION_MS = 1000 * 60 * 60 * 12; // 12 hours

function issueLegacySession() {
  const token = 'legacy_' + crypto.randomBytes(24).toString('hex');
  legacySessions.set(token, Date.now());
  return token;
}

function legacySessionValid(token) {
  const issued = legacySessions.get(token);
  if (!issued) return false;
  if (Date.now() - issued > LEGACY_SESSION_MS) {
    legacySessions.delete(token);
    return false;
  }
  return true;
}

// Cache verified Supabase tokens briefly so we're not calling out on every request
const tokenCache = new Map(); // token -> expiry (ms)
const TOKEN_CACHE_MS = 1000 * 60 * 5;

// Paths anyone may reach without being signed in
const PUBLIC_PATHS = new Set([
  '/auth', '/auth/forgot', '/auth/set-password', '/auth/check',
  '/manifest.json', '/sw.js', '/icon-192.png', '/icon-512.png', '/config.js',
  '/propresenter/push', // has its own PROPRESENTER_KEY check
]);

function bearerFrom(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// Returns true if this request is allowed to proceed.
async function isAuthorised(req, pathname) {
  if (!AUTH_ENFORCE) return true;
  if (PUBLIC_PATHS.has(pathname)) return true;
  // The app shell itself is public; the data behind it is not.
  if (pathname === '/' || pathname === '/index.html') return true;

  const token = bearerFrom(req);
  if (!token) return false;

  if (token.startsWith('legacy_')) return legacySessionValid(token);

  const cached = tokenCache.get(token);
  if (cached && cached > Date.now()) return true;

  const user = await supabaseVerifyToken(token);
  if (user && user.id) {
    tokenCache.set(token, Date.now() + TOKEN_CACHE_MS);
    return true;
  }
  return false;
}

// ── Router ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-pco-auth, Authorization',
    });
    return res.end();
  }

  // ── Access control ──────────────────────────────────────────────────────
  // Everything that isn't explicitly public requires a valid session.
  if (!(await isAuthorised(req, pathname))) {
    return jsonResponse(res, 401, { error: 'Not signed in' });
  }

  // ── GET /processes — list process documents ─────────────────────────────
  if (pathname === '/processes' && method === 'GET') {
    try {
      const list = await supabaseGet('processes');
      return jsonResponse(res, 200, Array.isArray(list) ? list : []);
    } catch (e) {
      console.warn('GET /processes error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── POST /processes/upload  body: {title, filename, dataBase64} ─────────
  if (pathname === '/processes/upload' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { title, filename, dataBase64 } = JSON.parse(body);
      if (!dataBase64 || !filename) return jsonResponse(res, 400, { error: 'Missing file' });
      // Decode base64 → binary
      const buffer = Buffer.from(dataBase64, 'base64');
      // Unique object path: timestamp + sanitized filename
      const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
      const objectPath = `${Date.now()}_${safeName}`;
      const publicUrl = await supabaseUpload(objectPath, buffer, 'application/pdf');
      // Append to the processes list
      const list = (await supabaseGet('processes')) || [];
      const entry = {
        id: 'proc_' + Date.now(),
        title: title || filename,
        filename: safeName,
        objectPath,
        url: publicUrl,
        uploadedAt: new Date().toISOString(),
      };
      list.unshift(entry);
      await supabaseSet('processes', list);
      return jsonResponse(res, 200, { ok: true, entry });
    } catch (e) {
      console.warn('POST /processes/upload error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── POST /processes/delete  body: {id} ──────────────────────────────────
  if (pathname === '/processes/delete' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { id } = JSON.parse(body);
      const list = (await supabaseGet('processes')) || [];
      const entry = list.find(p => p.id === id);
      if (entry && entry.objectPath) {
        try { await supabaseDeleteFile(entry.objectPath); } catch (e) { /* file may be gone */ }
      }
      const newList = list.filter(p => p.id !== id);
      await supabaseSet('processes', newList);
      return jsonResponse(res, 200, { ok: true });
    } catch (e) {
      console.warn('POST /processes/delete error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── GET /supabase-status — which data has migrated across ───────────────
  if (pathname === '/supabase-status' && method === 'GET') {
    try {
      if (!supabaseEnabled()) {
        return jsonResponse(res, 200, { ok: false, reason: 'Supabase env vars not set' });
      }
      const keys = ['inventory', 'announcements', 'patch', 'signalflow', 'homelayout',
                    'processes', 'userdata:shared'];
      const status = {};
      for (const k of keys) {
        try {
          const v = await supabaseGet(k);
          status[k] = v === null
            ? 'not migrated yet'
            : (Array.isArray(v) ? `${v.length} items` : `${Object.keys(v).length} keys`);
        } catch (e) {
          status[k] = 'error: ' + e.message;
        }
      }
      return jsonResponse(res, 200, { ok: true, status });
    } catch (e) {
      return jsonResponse(res, 200, { ok: false, error: e.message });
    }
  }

  // ── GET /supabase-test — diagnostic: verify Supabase connection ──────────
  if (pathname === '/supabase-test' && method === 'GET') {
    try {
      if (!supabaseEnabled()) {
        return jsonResponse(res, 200, { ok: false, reason: 'Supabase env vars not set' });
      }
      // Write a test value, read it back
      const stamp = new Date().toISOString();
      await supabaseSet('_connection_test', { hello: 'world', at: stamp });
      const readBack = await supabaseGet('_connection_test');
      return jsonResponse(res, 200, {
        ok: true,
        wrote: stamp,
        readBack,
        match: readBack && readBack.at === stamp,
      });
    } catch (e) {
      return jsonResponse(res, 200, { ok: false, error: e.message });
    }
  }

  // ── POST /auth ─────────────────────────────────────────────────────────
  // Two ways in during the transition:
  //   1. email + password  → real Supabase account
  //   2. password only     → legacy shared APP_PASSWORD (safety net)
  if (pathname === '/auth' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { email, password } = JSON.parse(body);

      if (email && supabaseEnabled()) {
        const result = await supabaseSignIn(email, password);
        if (!result.ok) {
          return jsonResponse(res, 401, { ok: false, error: result.error });
        }
        return jsonResponse(res, 200, {
          ok: true, mode: 'supabase', token: result.token,
          email: result.email, userId: result.userId,
          appId: PCO_APP_ID, secret: PCO_SECRET,
        });
      }

      // Legacy shared password
      if (APP_PASSWORD && password !== APP_PASSWORD) {
        return jsonResponse(res, 401, { ok: false, error: 'Incorrect password' });
      }
      return jsonResponse(res, 200, {
        ok: true, mode: 'legacy', token: issueLegacySession(),
        appId: PCO_APP_ID, secret: PCO_SECRET,
      });
    } catch (e) {
      console.warn('POST /auth error:', e);
      return jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // ── POST /auth/forgot  body: {email} — send reset email ─────────────────
  if (pathname === '/auth/forgot' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { email, redirectTo } = JSON.parse(body);
      if (!supabaseEnabled()) return jsonResponse(res, 400, { ok: false, error: 'Auth not configured' });
      if (!email) return jsonResponse(res, 400, { ok: false, error: 'Email required' });
      await supabaseSendRecovery(email, redirectTo);
      // Always report success — don't reveal whether an account exists
      return jsonResponse(res, 200, { ok: true });
    } catch (e) {
      console.warn('POST /auth/forgot error:', e);
      return jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // ── POST /auth/set-password  body: {token, password} ────────────────────
  if (pathname === '/auth/set-password' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { token, password } = JSON.parse(body);
      if (!token || !password) return jsonResponse(res, 400, { ok: false, error: 'Missing token or password' });
      if (password.length < 6) return jsonResponse(res, 400, { ok: false, error: 'Password must be at least 6 characters' });
      const result = await supabaseUpdatePassword(token, password);
      return jsonResponse(res, result.ok ? 200 : 400, result);
    } catch (e) {
      console.warn('POST /auth/set-password error:', e);
      return jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // ── GET /auth/check — is this token still valid? ────────────────────────
  if (pathname === '/auth/check' && method === 'GET') {
    try {
      const auth = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const user = await supabaseVerifyToken(token);
      return jsonResponse(res, 200, { ok: !!user, email: user ? user.email : null });
    } catch (e) {
      return jsonResponse(res, 200, { ok: false });
    }
  }

  // ── GET /pco ────────────────────────────────────────────────────────────
  if (pathname === '/pco' && method === 'GET') {
    try {
      const pcoPath = parsed.query.path;
      if (!pcoPath) return jsonResponse(res, 400, { error: 'path required' });
      const authHeader = req.headers['x-pco-auth'];
      const opts = pcoOptions('GET', pcoPath, authHeader);
      const result = await httpsRequest(opts);
      res.writeHead(result.status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(result.body);
    } catch (e) {
      console.warn('GET /pco error:', e);
      return jsonResponse(res, 502, { error: e.message });
    }
  }

  // ── POST /pco-post ──────────────────────────────────────────────────────
  if (pathname === '/pco-post' && method === 'POST') {
    try {
      const pcoPath = parsed.query.path;
      if (!pcoPath) return jsonResponse(res, 400, { error: 'path required' });
      const body = await readBody(req);
      const authHeader = req.headers['x-pco-auth'];
      const opts = pcoOptions('POST', pcoPath, authHeader);
      const result = await httpsRequest(opts, body);
      res.writeHead(result.status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(result.body);
    } catch (e) {
      console.warn('POST /pco-post error:', e);
      return jsonResponse(res, 502, { error: e.message });
    }
  }

  // ── PATCH /pco-patch ────────────────────────────────────────────────────
  if (pathname === '/pco-patch' && method === 'PATCH') {
    try {
      const pcoPath = parsed.query.path;
      if (!pcoPath) return jsonResponse(res, 400, { error: 'path required' });
      const body = await readBody(req);
      const authHeader = req.headers['x-pco-auth'];
      const opts = pcoOptions('PATCH', pcoPath, authHeader);
      const result = await httpsRequest(opts, body);
      res.writeHead(result.status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(result.body);
    } catch (e) {
      console.warn('PATCH /pco-patch error:', e);
      return jsonResponse(res, 502, { error: e.message });
    }
  }

  // ── DELETE /pco-delete ──────────────────────────────────────────────────
  if (pathname === '/pco-delete' && method === 'DELETE') {
    try {
      const pcoPath = parsed.query.path;
      if (!pcoPath) return jsonResponse(res, 400, { error: 'path required' });
      const authHeader = req.headers['x-pco-auth'];
      const opts = pcoOptions('DELETE', pcoPath, authHeader);
      const result = await httpsRequest(opts);
      res.writeHead(result.status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(result.body || '{}');
    } catch (e) {
      console.warn('DELETE /pco-delete error:', e);
      return jsonResponse(res, 502, { error: e.message });
    }
  }

  // ── GET /inventory ──────────────────────────────────────────────────────
  if (pathname === '/inventory' && method === 'GET') {
    try {
      const items = await inventoryRead();
      return jsonResponse(res, 200, items);
    } catch (e) {
      console.warn('GET /inventory error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── POST /inventory/add ─────────────────────────────────────────────────
  if (pathname === '/inventory/add' && method === 'POST') {
    try {
      const body = await readBody(req);
      const item = await inventoryAdd(JSON.parse(body));
      return jsonResponse(res, 200, item);
    } catch (e) {
      console.warn('POST /inventory/add error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── PATCH /inventory/update/:id ─────────────────────────────────────────
  if (pathname.startsWith('/inventory/update/') && method === 'PATCH') {
    try {
      const id = pathname.replace('/inventory/update/', '');
      const body = await readBody(req);
      const item = await inventoryUpdate(id, JSON.parse(body));
      return jsonResponse(res, 200, item);
    } catch (e) {
      console.warn('PATCH /inventory/update error:', e);
      return jsonResponse(res, e.message === 'Not found' ? 404 : 500, { error: e.message });
    }
  }

  // ── DELETE /inventory/delete/:id ────────────────────────────────────────
  if (pathname.startsWith('/inventory/delete/') && method === 'DELETE') {
    try {
      const id = pathname.replace('/inventory/delete/', '');
      await inventoryDelete(id);
      return jsonResponse(res, 200, { deleted: true });
    } catch (e) {
      console.warn('DELETE /inventory/delete error:', e);
      return jsonResponse(res, e.message === 'Not found' ? 404 : 500, { error: e.message });
    }
  }

  // ── GET /userdata?user=Name ─────────────────────────────────────────────
  if (pathname === '/userdata' && method === 'GET') {
    try {
      const username = parsed.query.user;
      if (!username) return jsonResponse(res, 400, { error: 'Unknown user' });
      return jsonResponse(res, 200, await userDataRead(username));
    } catch (e) {
      console.warn('GET /userdata error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── POST /userdata/save  body: {user, data} ─────────────────────────────
  if (pathname === '/userdata/save' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { user, data } = JSON.parse(body);
      if (!user) return jsonResponse(res, 400, { error: 'Unknown user' });
      await userDataSave(user, data);
      return jsonResponse(res, 200, { ok: true });
    } catch (e) {
      console.warn('POST /userdata/save error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── GET /homelayout ─────────────────────────────────────────────────────
  if (pathname === '/homelayout' && method === 'GET') {
    try {
      return jsonResponse(res, 200, await homeLayoutRead());
    } catch (e) {
      console.warn('GET /homelayout error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── POST /homelayout/save ───────────────────────────────────────────────
  if (pathname === '/homelayout/save' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { key, layout } = JSON.parse(body);
      // Merge into existing object so we don't wipe the other layout
      let existing = await homeLayoutRead();
      if (Array.isArray(existing)) existing = {}; // migrate old array format
      existing[key] = layout;
      await homeLayoutSave(existing);
      return jsonResponse(res, 200, { ok: true });
    } catch (e) {
      console.warn('POST /homelayout/save error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── GET /signalflow ─────────────────────────────────────────────────────
  if (pathname === '/signalflow' && method === 'GET') {
    try {
      return jsonResponse(res, 200, await signalFlowRead());
    } catch (e) {
      console.warn('GET /signalflow error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── POST /signalflow/save ───────────────────────────────────────────────
  if (pathname === '/signalflow/save' && method === 'POST') {
    try {
      const body = await readBody(req);
      await signalFlowSave(JSON.parse(body));
      return jsonResponse(res, 200, { ok: true });
    } catch (e) {
      console.warn('POST /signalflow/save error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── GET /patch ──────────────────────────────────────────────────────────
  if (pathname === '/patch' && method === 'GET') {
    try {
      return jsonResponse(res, 200, await patchRead());
    } catch (e) {
      console.warn('GET /patch error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── POST /patch/save ────────────────────────────────────────────────────
  if (pathname === '/patch/save' && method === 'POST') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      await patchSave(data);
      return jsonResponse(res, 200, { ok: true });
    } catch (e) {
      console.warn('POST /patch/save error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── POST /propresenter/push — bridge writes live data here ──────────────
  if (pathname === '/propresenter/push' && method === 'POST') {
    try {
      const key = req.headers['x-pp-key'] || '';
      if (!PROPRESENTER_KEY || key !== PROPRESENTER_KEY) {
        return jsonResponse(res, 401, { ok: false, error: 'Bad key' });
      }
      const body = await readBody(req);
      const data = JSON.parse(body);
      data.updatedAt = new Date().toISOString();
      if (supabaseEnabled()) {
        await supabaseSet('propresenter', data);
      }
      return jsonResponse(res, 200, { ok: true });
    } catch (e) {
      console.warn('POST /propresenter/push error:', e);
      return jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // ── GET /propresenter — dashboard reads live data ───────────────────────
  if (pathname === '/propresenter' && method === 'GET') {
    try {
      if (!supabaseEnabled()) return jsonResponse(res, 200, { connected: false });
      const data = await supabaseGet('propresenter');
      if (!data) return jsonResponse(res, 200, { connected: false });
      // Consider the feed stale if the bridge hasn't pushed in 15s
      const age = Date.now() - new Date(data.updatedAt || 0).getTime();
      data.stale = age > 15000;
      data.connected = !data.stale;
      return jsonResponse(res, 200, data);
    } catch (e) {
      console.warn('GET /propresenter error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── GET /announcements ──────────────────────────────────────────────────
  if (pathname === '/announcements' && method === 'GET') {
    try {
      return jsonResponse(res, 200, await announcementsRead());
    } catch (e) {
      console.warn('GET /announcements error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── GET /announcements/asana-status — completion state of linked tasks ──
  if (pathname === '/announcements/asana-status' && method === 'GET') {
    try {
      if (!asanaEnabled()) return jsonResponse(res, 200, { enabled: false, statuses: {} });
      const items = await announcementsRead();
      const gids = items.filter(a => a.asanaGid).map(a => a.asanaGid);
      const statuses = await asanaFetchStatuses(gids);
      return jsonResponse(res, 200, { enabled: true, statuses });
    } catch (e) {
      console.warn('GET /announcements/asana-status error:', e);
      return jsonResponse(res, 200, { enabled: false, statuses: {}, error: e.message });
    }
  }

  // ── POST /announcements/add ─────────────────────────────────────────────
  if (pathname === '/announcements/add' && method === 'POST') {
    try {
      const body = await readBody(req);
      const ann = await announcementsAdd(JSON.parse(body));
      return jsonResponse(res, 200, ann);
    } catch (e) {
      console.warn('POST /announcements/add error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── PATCH /announcements/update/:id ────────────────────────────────────
  if (pathname.startsWith('/announcements/update/') && method === 'PATCH') {
    try {
      const id = pathname.replace('/announcements/update/', '');
      const body = await readBody(req);
      const ann = await announcementsUpdate(id, JSON.parse(body));
      return jsonResponse(res, 200, ann);
    } catch (e) {
      console.warn('PATCH /announcements/update error:', e);
      return jsonResponse(res, e.message === 'Not found' ? 404 : 500, { error: e.message });
    }
  }

  // ── DELETE /announcements/delete/:id ────────────────────────────────────
  if (pathname.startsWith('/announcements/delete/') && method === 'DELETE') {
    try {
      const id = pathname.replace('/announcements/delete/', '');
      await announcementsDelete(id);
      return jsonResponse(res, 200, { deleted: true });
    } catch (e) {
      console.warn('DELETE /announcements/delete error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── GET /config.js ──────────────────────────────────────────────────────
  if (pathname === '/config.js' && method === 'GET') {
    const cfgPath = path.join(__dirname, 'config.js');
    if (fs.existsSync(cfgPath)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      return res.end(fs.readFileSync(cfgPath));
    }
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end('// no local config');
  }

  // ── PWA static files ────────────────────────────────────────────────────
  const STATIC_FILES = {
    '/manifest.json': 'application/manifest+json',
    '/sw.js': 'application/javascript',
    '/icon-192.png': 'image/png',
    '/icon-512.png': 'image/png',
  };
  if (STATIC_FILES[pathname] && method === 'GET') {
    const fp = path.join(__dirname, pathname.replace(/^\//, ''));
    if (fs.existsSync(fp)) {
      // sw.js must not be cached by the browser, so updates are picked up
      const headers = { 'Content-Type': STATIC_FILES[pathname] };
      if (pathname === '/sw.js') headers['Cache-Control'] = 'no-cache';
      res.writeHead(200, headers);
      return res.end(fs.readFileSync(fp));
    }
  }

  // ── Fallthrough → index.html ────────────────────────────────────────────
  const htmlPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store',
    });
    return res.end(fs.readFileSync(htmlPath));
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Production Dashboard running on port ${PORT}`);
  console.log(`Inventory backend: ${githubEnabled() ? `GitHub (${GITHUB_REPO})` : 'local file'}`);
});
