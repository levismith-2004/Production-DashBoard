const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PCO_APP_ID = process.env.PCO_APP_ID || '';
const PCO_SECRET = process.env.PCO_SECRET || '';

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



// ── Users / Accounts ──────────────────────────────────────────────────────────
// Accounts are stored in the data repo at users/_accounts.json:
//   { "levi": {"name":"Levi","hash":"...","salt":"...","admin":true}, ... }
// Levi is the bootstrap admin. Passwords are salted+hashed (sha256).
const ACCOUNTS_PATH = 'users/_accounts.json';
const BOOTSTRAP_ADMIN = 'Levi';

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// Read accounts object from data repo (or local fallback)
async function accountsRead() {
  if (githubEnabled()) {
    try {
      const result = await httpsRequest({
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_REPO}/contents/${ACCOUNTS_PATH}?ref=${GITHUB_BRANCH}`,
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
    const lf = path.join(__dirname, '_accounts.json');
    if (!fs.existsSync(lf)) return {};
    return JSON.parse(fs.readFileSync(lf, 'utf8'));
  } catch (e) { return {}; }
}

async function accountsSave(accounts) {
  if (githubEnabled()) {
    const result = await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${ACCOUNTS_PATH}?ref=${GITHUB_BRANCH}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'production-dashboard',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const sha = result.status === 404 ? null : JSON.parse(result.body).sha;
    const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
    const body = { message: 'Update accounts', content, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${ACCOUNTS_PATH}`,
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
    fs.writeFileSync(path.join(__dirname, '_accounts.json'), JSON.stringify(accounts, null, 2), 'utf8');
  }
}

// Ensure the bootstrap admin always exists (so you can never lock yourself out)
async function ensureBootstrap(accounts) {
  const key = BOOTSTRAP_ADMIN.toLowerCase();
  if (!accounts[key]) {
    accounts[key] = { name: BOOTSTRAP_ADMIN, hash: null, salt: null, admin: true };
    return true; // changed
  }
  accounts[key].admin = true; // admin can never be revoked from bootstrap
  return false;
}

// The global admin's password comes ONLY from Railway, never the panel.
// Priority: ADMIN_PASSWORD, then USER_PASS_LEVI, then APP_PASSWORD.
function adminMasterPassword() {
  return ADMIN_PASSWORD || process.env['USER_PASS_' + BOOTSTRAP_ADMIN.toUpperCase()] || APP_PASSWORD || '';
}

// Validate a login. Returns {name, admin} or null.
async function checkUser(username, password) {
  const accounts = await accountsRead();
  await ensureBootstrap(accounts);
  const key = String(username || '').toLowerCase();

  // Global admin (Levi): password is controlled entirely by Railway env vars.
  // This always works and can never be locked out or overridden by the panel.
  if (key === BOOTSTRAP_ADMIN.toLowerCase()) {
    const master = adminMasterPassword();
    // If no env var is set at all, allow any password (first-run convenience)
    if (!master || password === master) {
      return { name: BOOTSTRAP_ADMIN, admin: true };
    }
    return null; // wrong admin password
  }

  const acc = accounts[key];
  if (!acc) return null;
  // If no password set yet, accept any (first-time setup)
  if (!acc.hash) return { name: acc.name, admin: !!acc.admin };
  const h = hashPassword(password, acc.salt);
  return h === acc.hash ? { name: acc.name, admin: !!acc.admin } : null;
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
      'Access-Control-Allow-Headers': 'Content-Type, x-pco-auth',
    });
    return res.end();
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
  if (pathname === '/auth' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { password } = JSON.parse(body);
      if (APP_PASSWORD && password !== APP_PASSWORD) {
        return jsonResponse(res, 401, { ok: false });
      }
      return jsonResponse(res, 200, { ok: true, appId: PCO_APP_ID, secret: PCO_SECRET });
    } catch (e) {
      console.warn('POST /auth error:', e);
      return jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // ── GET /users — list account names (for login dropdown) ─────────────────
  if (pathname === '/users' && method === 'GET') {
    try {
      const accounts = await accountsRead();
      await ensureBootstrap(accounts);
      const users = Object.values(accounts).map(a => a.name);
      // Always include bootstrap admin even if file is empty
      if (!users.find(u => u.toLowerCase() === BOOTSTRAP_ADMIN.toLowerCase())) users.unshift(BOOTSTRAP_ADMIN);
      return jsonResponse(res, 200, { users });
    } catch (e) {
      return jsonResponse(res, 200, { users: [BOOTSTRAP_ADMIN] });
    }
  }

  // ── GET /accounts?admin=Name — list accounts (admin only) ───────────────
  if (pathname === '/accounts' && method === 'GET') {
    try {
      const requester = parsed.query.admin;
      const accounts = await accountsRead();
      await ensureBootstrap(accounts);
      const reqAcc = accounts[String(requester||'').toLowerCase()];
      const isAdmin = (String(requester||'').toLowerCase() === BOOTSTRAP_ADMIN.toLowerCase()) || (reqAcc && reqAcc.admin);
      if (!isAdmin) return jsonResponse(res, 403, { error: 'Not authorised' });
      // Return names + whether password is set + admin flag (never the hash)
      const list = Object.values(accounts).map(a => ({
        name: a.name, hasPassword: !!a.hash, admin: !!a.admin,
      }));
      return jsonResponse(res, 200, { accounts: list });
    } catch (e) {
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── POST /accounts/manage — admin actions ────────────────────────────────
  //   body: { admin, action: 'add'|'remove'|'setpass'|'setadmin', name, password?, makeAdmin? }
  if (pathname === '/accounts/manage' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { admin, action, name, password, makeAdmin } = JSON.parse(body);
      const accounts = await accountsRead();
      await ensureBootstrap(accounts);
      const reqAcc = accounts[String(admin||'').toLowerCase()];
      const isAdmin = (String(admin||'').toLowerCase() === BOOTSTRAP_ADMIN.toLowerCase()) || (reqAcc && reqAcc.admin);
      if (!isAdmin) return jsonResponse(res, 403, { error: 'Not authorised' });

      const key = String(name||'').trim().toLowerCase();
      if (!key) return jsonResponse(res, 400, { error: 'Name required' });

      if (action === 'add') {
        if (accounts[key]) return jsonResponse(res, 400, { error: 'User already exists' });
        accounts[key] = { name: String(name).trim(), hash: null, salt: null, admin: !!makeAdmin };
      } else if (action === 'remove') {
        if (key === BOOTSTRAP_ADMIN.toLowerCase()) return jsonResponse(res, 400, { error: 'Cannot remove the admin account' });
        delete accounts[key];
      } else if (action === 'setpass') {
        if (key === BOOTSTRAP_ADMIN.toLowerCase()) {
          return jsonResponse(res, 400, { error: 'The admin password is set via the Railway ADMIN_PASSWORD variable, not here.' });
        }
        if (!accounts[key]) return jsonResponse(res, 404, { error: 'User not found' });
        const salt = newSalt();
        accounts[key].salt = salt;
        accounts[key].hash = hashPassword(password || '', salt);
      } else if (action === 'setadmin') {
        if (key === BOOTSTRAP_ADMIN.toLowerCase()) return jsonResponse(res, 400, { error: 'Admin status is locked for the main admin' });
        if (!accounts[key]) return jsonResponse(res, 404, { error: 'User not found' });
        accounts[key].admin = !!makeAdmin;
      } else {
        return jsonResponse(res, 400, { error: 'Unknown action' });
      }

      await accountsSave(accounts);
      return jsonResponse(res, 200, { ok: true });
    } catch (e) {
      console.warn('POST /accounts/manage error:', e);
      return jsonResponse(res, 500, { error: e.message });
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

  // ── GET /announcements ──────────────────────────────────────────────────
  if (pathname === '/announcements' && method === 'GET') {
    try {
      return jsonResponse(res, 200, await announcementsRead());
    } catch (e) {
      console.warn('GET /announcements error:', e);
      return jsonResponse(res, 500, { error: e.message });
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
