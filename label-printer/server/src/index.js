// Print server: Shopify-authenticated HTTP API + Zebra Weblink endpoint.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, checkConfig } from './config.js';
import { verifySessionToken, AuthError } from './auth.js';
import { PrinterHub, PrinterError } from './weblink.js';
import { buildLabelJob } from './zpl.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const homeHtml = fs.readFileSync(path.join(here, 'home.html'), 'utf8');

for (const p of checkConfig()) console.warn(`[config] ${p}`);

const hub = new PrinterHub({ printers: config.printers, defaultDpi: config.defaultDpi });

const MAX_BODY = 512 * 1024;
const MAX_ITEMS = 250;

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  cors(req, res);
  if (req.method === 'OPTIONS') return send(res, 204);

  if (url.pathname === '/health') return json(res, 200, { ok: true });

  if (req.method === 'GET' && url.pathname === '/') return home(req, res, url);

  if (url.pathname.startsWith('/api/')) {
    let session;
    try {
      session = verifySessionToken(req.headers.authorization, config);
    } catch (err) {
      if (err instanceof AuthError) return json(res, 401, { error: err.message });
      throw err;
    }

    if (req.method === 'GET' && url.pathname === '/api/printers') {
      return json(res, 200, { printers: hub.list(), label: labelInfo() });
    }

    if (req.method === 'POST' && url.pathname === '/api/print') {
      const body = await readJson(req);
      return printItems(res, session, body);
    }

    if (req.method === 'POST' && url.pathname === '/api/test-print') {
      const body = await readJson(req);
      return printItems(res, session, {
        printer: body?.printer,
        labelType: body?.labelType,
        currencyCode: body?.currencyCode || 'USD',
        items: [{ productTitle: 'Test label', variantTitle: 'Medium / Blue', sku: 'TEST-SKU-001', barcode: '', price: 24.99, quantity: 1 }],
      });
    }
  }

  return json(res, 404, { error: 'Not found' });
}

async function printItems(res, session, body) {
  const items = validateItems(body?.items);
  if (typeof items === 'string') return json(res, 400, { error: items });

  const total = items.reduce((n, i) => n + i.quantity, 0);
  if (!total) return json(res, 400, { error: 'Nothing to print — every quantity is 0.' });
  if (total > config.maxLabelsPerJob) {
    return json(res, 400, { error: `That's ${total} labels; the limit per job is ${config.maxLabelsPerJob}.` });
  }

  const labelSettings = config.labels[body.labelType || 'standard'];
  if (!labelSettings) return json(res, 400, { error: 'Unknown label type.' });

  const printer = hub.find(body.printer);
  if (!printer) return json(res, 404, { error: 'No printer with that name is configured.' });

  try {
    const result = await hub.print(printer, (dpi) =>
      buildLabelJob({ items, currencyCode: body.currencyCode }, dpi, labelSettings),
    );
    console.log(`[print] ${session.shop}: ${total} label(s) -> ${printer.name} (${result.bytes} bytes)`);
    return json(res, 200, {
      ok: true,
      printer: printer.name,
      labels: total,
      warning: result.paused ? 'The printer is paused — press the pause button to start printing.' : undefined,
    });
  } catch (err) {
    if (err instanceof PrinterError) return json(res, 503, { error: err.message, code: err.code });
    throw err;
  }
}

function validateItems(items) {
  if (!Array.isArray(items) || !items.length) return 'No items to print.';
  if (items.length > MAX_ITEMS) return `Too many variants in one job (max ${MAX_ITEMS}).`;
  const out = [];
  for (const it of items) {
    const quantity = Math.floor(Number(it?.quantity));
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > 999) return 'Each quantity must be 0–999.';
    out.push({
      productTitle: str(it.productTitle, 200),
      variantTitle: str(it.variantTitle, 200),
      sku: str(it.sku, 100),
      barcode: str(it.barcode, 64),
      price: str(it.price, 32),
      quantity,
    });
  }
  return out;
}

const str = (v, max) => String(v ?? '').slice(0, max);

function labelInfo() {
  const l = config.label;
  return {
    widthIn: l.widthIn,
    heightIn: l.heightIn,
    hasLogo: Boolean(l.logoPath && fs.existsSync(l.logoPath)),
    types: Object.entries(config.labels).map(([id, t]) => ({ id, name: t.name })),
  };
}

function home(req, res, url) {
  const shop = url.searchParams.get('shop');
  const frameAncestors = ['https://admin.shopify.com'];
  if (shop && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) frameAncestors.push(`https://${shop}`);
  const weblinkBase = config.publicUrl ? config.publicUrl.replace(/^http:/, 'https:') + '/weblink/' : '';
  const page = homeHtml
    .replace('%API_KEY%', escapeHtml(config.apiKey))
    .replace('%WEBLINK_BASE%', escapeHtml(weblinkBase));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `frame-ancestors ${frameAncestors.join(' ')};`,
    'Cache-Control': 'no-store',
  });
  res.end(page);
}

// Admin UI extensions call us from Shopify's extension sandbox origin.
// Auth is the bearer token, never cookies, so a permissive CORS policy is safe.
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function send(res, status) {
  res.writeHead(status);
  res.end();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// -------------------------------------------------------------------- server

const listener = (req, res) =>
  handle(req, res).catch((err) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Server error' : err.message });
  });

// Optional in-process TLS. Use it if the printer can't negotiate TLS with your
// host's proxy (older Link-OS firmware only speaks AES-CBC RSA suites).
const server = config.tls
  ? https.createServer(
      {
        cert: fs.readFileSync(config.tls.cert),
        key: fs.readFileSync(config.tls.key),
        minVersion: 'TLSv1.2',
        ciphers: [
          'ECDHE-ECDSA-AES128-GCM-SHA256',
          'ECDHE-RSA-AES128-GCM-SHA256',
          'ECDHE-ECDSA-AES256-GCM-SHA384',
          'ECDHE-RSA-AES256-GCM-SHA384',
          'ECDHE-RSA-AES128-SHA',
          'ECDHE-RSA-AES256-SHA',
          'AES128-SHA', // TLS_RSA_WITH_AES_128_CBC_SHA (Zebra legacy)
          'AES256-SHA', // TLS_RSA_WITH_AES_256_CBC_SHA (Zebra legacy)
        ].join(':'),
      },
      listener,
    )
  : http.createServer(listener);

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  if (!hub.handleUpgrade(req, socket, head)) socket.destroy();
});

server.listen(config.port, () => {
  console.log(`[server] listening on :${config.port} (${config.tls ? 'https' : 'http'})`);
  console.log(`[server] printers: ${config.printers.map((p) => p.name).join(', ') || 'none'}`);
});

export { server, hub };
