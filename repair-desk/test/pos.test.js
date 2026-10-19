// Shopify POS extension requests: session-token check, staff linking, CORS.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

import { openDb } from '../src/db.js';
import { createShop, updateShopSettings } from '../src/shops.js';
import { createStaff } from '../src/staff.js';
import { createPartner } from '../src/partners.js';
import { createApp, demoCustomers } from '../src/server.js';
import { sessionManager } from '../src/sessions.js';
import { verifyPosToken, unlinkPosMember } from '../src/pos-auth.js';

const CLIENT_ID = 'test-client-id';
const SECRET = 'test-client-secret';
const SHOP = 'moku-repair-test.myshopify.com';
let server, base, db, shop, tom;

function token({ secret = SECRET, aud = CLIENT_ID, dest = `https://${SHOP}`, expIn = 60, alg = 'HS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = b64({ alg, typ: 'JWT' });
  const p = b64({ iss: `https://${SHOP}/admin`, dest, aud, sub: '7001', exp: now + expIn, nbf: now - 5, iat: now - 5, jti: crypto.randomUUID() });
  return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}

before(async () => {
  db = openDb(':memory:');
  shop = createShop(db, { name: 'MOKU', shopifyDomain: SHOP, jobPrefix: 'MOKU', nextJobNumber: 186 });
  tom = createStaff(db, shop.id, null, { name: 'Tom Gleason', role: 'owner' });
  createStaff(db, shop.id, tom, { name: 'Emma' });
  createStaff(db, shop.id, tom, { name: 'Danny' });
  updateShopSettings(db, shop.id, tom, { defaultPartnerId: createPartner(db, shop.id, tom, { name: 'Keith' }).id });
  const app = createApp({ db, shopId: shop.id, sessions: sessionManager('x'.repeat(40), { secure: false }), customers: demoCustomers(db, shop.id), baseUrl: 'https://desk.test', pos: { clientId: CLIENT_ID, clientSecret: SECRET } });
  server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = (path, { tok = token(), member = '111', body, origin = 'https://extensions.shopifycdn.com' } = {}) =>
  fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${tok}`, 'X-Pos-Staff-Member': member, Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

test('token check: signature, app, shop, expiry, algorithm', () => {
  const cfg = { clientId: CLIENT_ID, clientSecret: SECRET, shopDomain: SHOP };
  assert.equal(verifyPosToken(`Bearer ${token()}`, cfg).shopDomain, SHOP);
  assert.equal(verifyPosToken(`Bearer ${token({ dest: SHOP })}`, cfg).shopDomain, SHOP); // bare domain form
  assert.throws(() => verifyPosToken(`Bearer ${token({ secret: 'wrong' })}`, cfg), /signature/);
  assert.throws(() => verifyPosToken(`Bearer ${token({ aud: 'other-app' })}`, cfg), /another app/);
  assert.throws(() => verifyPosToken(`Bearer ${token({ dest: 'https://evil.myshopify.com' })}`, cfg), /another shop/);
  assert.throws(() => verifyPosToken(`Bearer ${token({ expIn: -60 })}`, cfg), /expired/);
  assert.throws(() => verifyPosToken(`Bearer ${token({ alg: 'none' })}`, cfg), /algorithm/);
  assert.throws(() => verifyPosToken('', cfg), /Missing/);
});

test('CORS preflight and headers for the POS extension; cookie calls stay same-origin', async () => {
  const pre = await fetch(base + '/api/board', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /X-Pos-Staff-Member/);
  const r = await call('/api/me', { member: '999' });
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const cookieCall = await fetch(base + '/api/staff');
  assert.equal(cookieCall.headers.get('access-control-allow-origin'), null);
});

test('bad tokens are refused before anything else', async () => {
  assert.equal((await call('/api/board', { tok: token({ secret: 'nope' }) })).status, 401);
  assert.equal((await call('/api/board', { tok: token({ dest: 'https://other.myshopify.com' }) })).status, 401);
});

test('first use: unknown POS staff picks their name once, then is recognised', async () => {
  const first = await call('/api/board', { member: '111' });
  assert.equal(first.status, 409);
  const j = await first.json();
  assert.equal(j.needsLink, true);
  assert.deepEqual(j.staff.map((s) => s.name), ['Danny', 'Emma', 'Tom Gleason']);
  const emma = j.staff.find((s) => s.name === 'Emma');

  const link = await call('/api/pos/link', { member: 'gid://shopify/StaffMember/111', body: { staffId: emma.id } });
  assert.equal(link.status, 200);
  assert.equal((await link.json()).me.name, 'Emma');
  const me = await (await call('/api/me', { member: '111' })).json();
  assert.equal(me.me.name, 'Emma');

  // Nobody else can take Emma's name, and Emma's POS account can't relink.
  const steal = await call('/api/pos/link', { member: '222', body: { staffId: emma.id } });
  assert.equal(steal.status, 400);
  assert.match((await steal.json()).error, /already linked/);
  assert.equal((await call('/api/pos/link', { member: '111', body: { staffId: emma.id } })).status, 400);
});

test('POS staff do the counter work under their own name', async () => {
  const { customer } = await (await call('/api/customers', { member: '111', body: { firstName: 'Lena', lastName: 'Park', phone: '646-555-0110' } })).json();
  const r = await (await call('/api/tickets', { member: '111', body: { requestId: 'pos_req_abcdefghijk1', customer, board: "6'4 Rusty", repair: 'Tail ding' } })).json();
  assert.equal(r.jobNumber, 'MOKU-0186');
  assert.equal(r.label.status, 'off');
  const t = await (await call('/api/tickets/MOKU-0186', { member: '111' })).json();
  assert.equal(t.ticket.acceptedBy, 'Emma');
});

test('an owner can reset a wrong link', async () => {
  const emma = db.prepare(`SELECT * FROM staff WHERE name = 'Emma'`).get();
  assert.throws(() => unlinkPosMember(db, shop.id, emma, emma.id), /owner/);
  unlinkPosMember(db, shop.id, tom, emma.id);
  assert.equal((await call('/api/board', { member: '111' })).status, 409);
});

test('without POS settings the server refuses bearer calls', async () => {
  const app = createApp({ db, shopId: shop.id, sessions: sessionManager('y'.repeat(40), { secure: false }), customers: demoCustomers(db, shop.id), baseUrl: 'https://desk.test' });
  const s = http.createServer(app).listen(0);
  await new Promise((r) => s.once('listening', r));
  const r = await fetch(`http://127.0.0.1:${s.address().port}/api/board`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(r.status, 401);
  s.close();
});
