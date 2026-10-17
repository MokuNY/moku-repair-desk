import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startFakePrinter } from './fake-printer.js';

const TOKEN = 'testtoken_ABCDEFGHIJKLMNOP';
const API_KEY = 'test-api-key';
const API_SECRET = 'test-api-secret';
const SHOP = 'example-shop.myshopify.com';

process.env.PORT = '38911';
process.env.SHOPIFY_API_KEY = API_KEY;
process.env.SHOPIFY_API_SECRET = API_SECRET;
process.env.ALLOWED_SHOPS = SHOP;
process.env.PRINTERS = `Front counter=${TOKEN}`;

const base = `http://127.0.0.1:${process.env.PORT}`;
let server, printer;

function sessionToken({ secret = API_SECRET, aud = API_KEY, shop = SHOP, expIn = 60 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud, sub: '42', exp: now + expIn, nbf: now - 5, iat: now - 5 });
  const s = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

const api = (path, body, token = sessionToken()) =>
  fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(25);
  }
  throw new Error('timed out');
}

before(async () => {
  ({ server } = await import('../src/index.js'));
  await until(() => server.listening);
  printer = startFakePrinter(`ws://127.0.0.1:${process.env.PORT}/weblink/${TOKEN}`, { rawProtocol: process.env.RAW_PROTO || 'v1.weblink.zebra.com' });
  await printer.rawReady;
});

after(() => {
  printer?.close();
  server?.close();
  setTimeout(() => process.exit(0), 100).unref();
});

test('rejects requests without a valid Shopify session token', async () => {
  assert.equal((await fetch(base + '/api/printers')).status, 401);
  assert.equal((await api('/api/printers', null, sessionToken({ secret: 'wrong' }))).status, 401);
  assert.equal((await api('/api/printers', null, sessionToken({ aud: 'other-app' }))).status, 401);
  assert.equal((await api('/api/printers', null, sessionToken({ shop: 'evil.myshopify.com' }))).status, 401);
  assert.equal((await api('/api/printers', null, sessionToken({ expIn: -60 }))).status, 401);
});

test('unknown printer tokens cannot connect', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}/weblink/nottherighttoken1234`, ['v1.weblink.zebra.com']);
  const outcome = await new Promise((r) => {
    ws.onopen = () => r('open');
    ws.onerror = () => r('error');
  });
  assert.equal(outcome, 'error');
});

test('printer registers alerts, opens a raw channel and reports its DPI', async () => {
  await until(async () => (await (await api('/api/printers')).json()).printers[0].dpi === 203);
  const { printers } = await (await api('/api/printers')).json();
  assert.equal(printers[0].online, true);
  assert.equal(printers[0].rawReady, true);
  assert.equal(printers[0].serial, 'D4J123456789');
  assert.ok(printer.control.some((m) => m.open === 'v1.raw.zebra.com'));
  assert.ok(printer.control.some((m) => m.configure_alert?.startsWith('PAPER OUT,')));
});

test('prints labels as ZPL over binary frames only', async () => {
  const r = await api('/api/print', {
    currencyCode: 'USD',
    items: [
      { productTitle: 'Pipeline Rash Guard', variantTitle: 'Large / Navy ^~_', sku: 'RG-PL-NVY-L', barcode: '012345678905', price: '54.00', quantity: 3 },
      { productTitle: 'Board Wax', variantTitle: 'Default Title', sku: 'WAX-01', price: '4.5', quantity: 0 },
      { productTitle: 'Leash', variantTitle: '7ft', sku: 'LSH>7', barcode: '', price: '29.99', quantity: 1 },
      { productTitle: 'Moku Hat', variantTitle: 'Sand', sku: 'MK-HAT', barcode: '1000234567', price: '28', quantity: 1 },
    ],
  });
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  assert.equal(data.labels, 5);

  await until(() => printer.received.length > 0);
  const zpl = printer.received.join('');
  assert.deepEqual(printer.violations, []);
  assert.match(zpl, /^~DGR:LOGO\.GRF,\d+,\d+,[0-9A-F]+\n/); // logo downloaded first
  assert.equal((zpl.match(/\^XA/g) || []).length, 3); // qty-0 item skipped
  assert.match(zpl, /\^PQ3,0,1,Y/);
  assert.match(zpl, /\^PW406\^LL203/); // 2" x 1" at 203 dpi
  assert.match(zpl, /\$54\.00/);
  assert.match(zpl, /RG-PL-NVY-L/);
  assert.match(zpl, /Large \/ Navy _5E_7E_5F/); // ZPL control characters escaped
  // Vendor UPC-A: 11 data digits, printer adds the check digit
  assert.match(zpl, /\^BUN,\d+,N,N,N\^FD01234567890\^FS/);
  // No vendor barcode: SKU as Code 128, with ">" written as "><"
  assert.match(zpl, /\^BCN,\d+,N,N,N,N\^FH\^FDLSH><7\^FS/);
  // Numeric in-house code: Code 128 subset C
  assert.match(zpl, /\^BCN,\d+,N,N,N,N\^FD>;1000234567\^FS/);
  assert.doesNotMatch(zpl, /Default Title/);
});

test('blocks printing while the printer reports paper out, resumes when cleared', async () => {
  printer.alert('PAPER OUT', 'SET');
  await until(async () => (await (await api('/api/printers')).json()).printers[0].problems.includes('PAPER OUT'));
  const r = await api('/api/test-print', {});
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /paper out/);

  printer.alert('PAPER OUT', 'CLEAR');
  await until(async () => (await (await api('/api/printers')).json()).printers[0].problems.length === 0);
  assert.equal((await api('/api/test-print', {})).status, 200);
});

test('validates input', async () => {
  assert.equal((await api('/api/print', { items: [] })).status, 400);
  assert.equal((await api('/api/print', { items: [{ sku: 'X', price: 1, quantity: 5000 }] })).status, 400);
  assert.equal((await api('/api/print', { items: [{ sku: 'X', price: 1, quantity: 0 }] })).status, 400);
});

test('prints butterfly tags: two wings, no logo, label type listed', async () => {
  const { label } = await (await api('/api/printers')).json();
  assert.deepEqual(label.types.map((t) => t.id), ['standard', 'butterfly']);
  const before = printer.received.length;
  const r = await api('/api/print', {
    labelType: 'butterfly',
    currencyCode: 'USD',
    items: [{ productTitle: 'Ring', variantTitle: '7', sku: 'RING-7', barcode: '', price: '120', quantity: 2 }],
  });
  assert.equal(r.status, 200, await r.text());
  await until(() => printer.received.length > before);
  const zpl = printer.received.slice(before).join('');
  assert.doesNotMatch(zpl, /~DG/); // no logo download on tags
  assert.match(zpl, /\^PW447\^LL102/); // 2.2" x 0.5" at 203 dpi
  assert.match(zpl, /\$120\.00/);
  assert.match(zpl, /RING-7/);
  assert.match(zpl, /\^BY1,3,\d+\^BCN,\d+,N,N,N,N\^FH\^FDRING-7\^FS/); // barcode fits at 203 dpi
  assert.match(zpl, /\^PQ2,0,1,Y/);
  assert.equal((await api('/api/print', { labelType: 'nope', items: [{ sku: 'X', price: 1, quantity: 1 }] })).status, 400);
});
