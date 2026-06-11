const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PCO_APP_ID = process.env.PCO_APP_ID || '';
const PCO_SECRET = process.env.PCO_SECRET || '';
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN || '';
const AIRTABLE_BASE = process.env.AIRTABLE_BASE || '';

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
        // Follow redirects
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

// ── Airtable helpers ────────────────────────────────────────────────────────

function airtableRequest(method, endpoint, body) {
  const opts = {
    hostname: 'api.airtable.com',
    path: `/v0/${AIRTABLE_BASE}/${endpoint}`,
    method,
    headers: {
      'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  return httpsRequest(opts, body ? JSON.stringify(body) : undefined);
}

function mapAirtableToItem(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    item: f.ITEM || '',
    brand: f.BRAND || '',
    category: f.CATEGORY || '',
    value: f.VALUE || 0,
    retailValue: f.RETAIL_VALUE || 0,
    quantity: f.QUANTITY || 1,
    location: f.LOCATION || '',
    notes: f.NOTES || '',
  };
}

function mapItemToAirtable(item) {
  const fields = {};
  if (item.item !== undefined) fields.ITEM = item.item;
  if (item.brand !== undefined) fields.BRAND = item.brand;
  if (item.category !== undefined) fields.CATEGORY = item.category;
  if (item.value !== undefined) fields.VALUE = Number(item.value) || 0;
  if (item.retailValue !== undefined) fields.RETAIL_VALUE = Number(item.retailValue) || 0;
  if (item.quantity !== undefined) fields.QUANTITY = Number(item.quantity) || 1;
  // Only include LOCATION if non-empty (Airtable single-select rejects empty strings)
  if (item.location) fields.LOCATION = item.location;
  if (item.notes !== undefined) fields.NOTES = item.notes;
  return fields;
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
    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE) {
      return jsonResponse(res, 200, []);
    }
    try {
      let allRecords = [];
      let offset = null;
      do {
        const endpoint = `Inventory${offset ? `?offset=${offset}` : ''}`;
        const result = await airtableRequest('GET', endpoint);
        const data = JSON.parse(result.body);
        if (data.records) allRecords = allRecords.concat(data.records.map(mapAirtableToItem));
        offset = data.offset || null;
      } while (offset);
      return jsonResponse(res, 200, allRecords);
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
      const fields = mapItemToAirtable(item);
      const result = await airtableRequest('POST', 'Inventory', { fields });
      const data = JSON.parse(result.body);
      if (data.id) {
        return jsonResponse(res, 200, mapAirtableToItem(data));
      }
      return jsonResponse(res, 400, data);
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
      const item = JSON.parse(body);
      const fields = mapItemToAirtable(item);
      const result = await airtableRequest('PATCH', `Inventory/${id}`, { fields });
      const data = JSON.parse(result.body);
      if (data.id) {
        return jsonResponse(res, 200, mapAirtableToItem(data));
      }
      return jsonResponse(res, 400, data);
    } catch (e) {
      console.warn('PATCH /inventory/update error:', e);
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // ── DELETE /inventory/delete/:id ────────────────────────────────────────
  if (pathname.startsWith('/inventory/delete/') && method === 'DELETE') {
    try {
      const id = pathname.replace('/inventory/delete/', '');
      const result = await airtableRequest('DELETE', `Inventory/${id}`);
      const data = JSON.parse(result.body);
      return jsonResponse(res, 200, data);
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
