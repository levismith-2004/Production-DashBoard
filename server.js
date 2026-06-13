const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PCO_APP_ID = process.env.PCO_APP_ID || '';
const PCO_SECRET = process.env.PCO_SECRET || '';

// GitHub-backed inventory config (set these in Railway environment variables)
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || '';
const GITHUB_REPO   = process.env.GITHUB_REPO   || ''; // e.g. "yourname/production-dashboard"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_PATH   = 'inventory.json';
const ANNOUNCEMENTS_PATH = 'announcements.json';
const PATCH_PATH = 'patch.json';

// Local file fallback (used if GitHub env vars not set)
const INVENTORY_FILE = path.join(__dirname, 'inventory.json');
const ANNOUNCEMENTS_FILE = path.join(__dirname, 'announcements.json');
const PATCH_FILE = path.join(__dirname, 'patch.json');

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
