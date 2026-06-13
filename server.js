const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PCO_APP_ID = process.env.PCO_APP_ID || '';
const PCO_SECRET = process.env.PCO_SECRET || '';

const INVENTORY_FILE = path.join(__dirname, 'inventory.json');

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

// ── Inventory JSON helpers ──────────────────────────────────────────────────

function readInventory() {
  try {
    if (!fs.existsSync(INVENTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
  } catch (e) {
    console.warn('readInventory error:', e);
    return [];
  }
}

function writeInventory(items) {
  fs.writeFileSync(INVENTORY_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
      return jsonResponse(res, 200, readInventory());
    } catch (e) {
      console.warn('GET /inventory error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── POST /inventory/add ─────────────────────────────────────────────────
  if (pathname === '/inventory/add' && method === 'POST') {
    try {
      const body = await readBody(req);
      const item = JSON.parse(body);
      item.id = newId();
      item.quantity = Number(item.quantity) || 1;
      item.value = Number(item.value) || 0;
      item.retailValue = Number(item.retailValue) || 0;
      const items = readInventory();
      items.push(item);
      writeInventory(items);
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
      const updates = JSON.parse(body);
      const items = readInventory();
      const idx = items.findIndex(i => i.id === id);
      if (idx === -1) return jsonResponse(res, 404, { error: 'Not found' });
      items[idx] = { ...items[idx], ...updates, id };
      items[idx].quantity = Number(items[idx].quantity) || 1;
      items[idx].value = Number(items[idx].value) || 0;
      items[idx].retailValue = Number(items[idx].retailValue) || 0;
      writeInventory(items);
      return jsonResponse(res, 200, items[idx]);
    } catch (e) {
      console.warn('PATCH /inventory/update error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── DELETE /inventory/delete/:id ────────────────────────────────────────
  if (pathname.startsWith('/inventory/delete/') && method === 'DELETE') {
    try {
      const id = pathname.replace('/inventory/delete/', '');
      const items = readInventory();
      const filtered = items.filter(i => i.id !== id);
      if (filtered.length === items.length) return jsonResponse(res, 404, { error: 'Not found' });
      writeInventory(filtered);
      return jsonResponse(res, 200, { deleted: true });
    } catch (e) {
      console.warn('DELETE /inventory/delete error:', e);
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
});
