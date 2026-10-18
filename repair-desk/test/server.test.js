// The web server: sign-in, sessions, the check-in flow and request safety.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { openDb } from '../src/db.js';
import { createShop, updateShopSettings } from '../src/shops.js';
import { createStaff, setPin } from '../src/staff.js';
import { createPartner } from '../src/partners.js';
import { createApp, demoCustomers } from '../src/server.js';
import { sessionManager } from '../src/sessions.js';

let server, base, db, shop, printed;
before(async () => {
  db = openDb(':memory:');
  shop = createShop(db, { name: 'MOKU', shopifyDomain: 'moku-repair-test.myshopify.com', jobPrefix: 'MOKU', nextJobNumber: 186 });
  const tom = createStaff(db, shop.id, null, { name: 'Tom Gleason', role: 'owner' });
  const emma = createStaff(db, shop.id, tom, { name: 'Emma' });
  createStaff(db, shop.id, tom, { name: 'Danny' }); // no PIN yet
  setPin(db, shop.id, tom, emma.id, '2468');
  updateShopSettings(db, shop.id, tom, { defaultPartnerId: createPartner(db, shop.id, tom, { name: 'Keith' }).id });
  printed = [];
  const printer = { send: async (body) => { printed.push(body); return { status: 200, body: { ok: true, printer: 'Front counter' } }; } };
  const app = createApp({ db, shopId: shop.id, sessions: sessionManager('x'.repeat(40), { secure: false }), customers: demoCustomers(db, shop.id), printer, baseUrl: 'https://repair-desk-test.fly.dev' });
  server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body, cookie, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body) });
const get = (path, cookie) => fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
const staffId = async (name) => (await (await get('/api/staff')).json()).staff.find((s) => s.name === name).id;
async function signIn(name, pin) {
  const r = await post('/api/signin', { staffId: await staffId(name), pin });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

test('the page loads with a strict content security policy; scanned label links open the app', async () => {
  for (const p of ['/', '/t/MOKU-0186']) {
    const r = await get(p);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await r.text(), /MOKU Repair Desk/);
  }
});

test('everything but the sign-in list needs a session', async () => {
  assert.equal((await get('/api/board')).status, 401);
  assert.equal((await get('/api/tickets/MOKU-0186')).status, 401);
  assert.equal((await get('/api/board', 'rd_session=1.1.9999999999999.forged')).status, 401);
  const list = await (await get('/api/staff')).json();
  assert.deepEqual(list.staff.map((s) => [s.name, s.hasPin]), [['Danny', false], ['Emma', true], ['Tom Gleason', false]]);
  assert.ok(!JSON.stringify(list).includes('pin_hash'));
});

test('sign-in: wrong PIN refused, locked after 5 tries; first sign-in chooses a PIN', async () => {
  const id = await staffId('Emma');
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/signin', { staffId: id, pin: '0000' })).status, 401);
  const locked = await post('/api/signin', { staffId: id, pin: '2468' });
  assert.equal(locked.status, 429); // even the right PIN, while locked
  const danny = await staffId('Danny');
  assert.equal((await post('/api/signin', { staffId: danny, newPin: '12' })).status, 400);
  const ok = await post('/api/signin', { staffId: danny, newPin: '135790' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await post('/api/signin', { staffId: danny, pin: '135790' })).status, 200);
});

test('requests from other sites or without JSON are refused', async () => {
  const cookie = await signInDanny();
  assert.equal((await fetch(base + '/api/tickets/MOKU-0186/call', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await post('/api/customers', { firstName: 'X' }, cookie, { Origin: 'https://evil.example' })).status, 403);
});

test('check in → label → Keith → price → ready → pay → picked up', async () => {
  const cookie = await signInDanny();
  const { customer } = await (await post('/api/customers', { firstName: 'Lena', lastName: 'Park', phone: '646-555-0110' }, cookie)).json();
  const body = { requestId: 'req_abcdefghijklmnop1', customer, board: "6'4 Rusty", repair: 'Tail ding', notes: 'Fins in bag' };
  const first = await (await post('/api/tickets', body, cookie)).json();
  const again = await (await post('/api/tickets', body, cookie)).json(); // double tap
  assert.equal(first.jobNumber, 'MOKU-0186');
  assert.deepEqual([first.created, again.created, again.jobNumber], [true, false, 'MOKU-0186']);
  assert.equal(first.label.status, 'sent');
  assert.equal(printed.length, 1); // one label for the double tap
  assert.equal(printed[0].label.url, 'https://repair-desk-test.fly.dev/t/MOKU-0186');

  const step = async (path, b) => { const r = await post(`/api/tickets/MOKU-0186/${path}`, b, cookie); const j = await r.json(); assert.equal(r.status, 200, j.error); return j.ticket; };
  await step('status', { to: 'at_partner' });
  let t = await step('price', { partnerCharge: '85' });
  assert.deepEqual([t.money.price, t.money.balance], [10500, 10500]);
  await step('status', { to: 'back_from_partner' });
  t = await step('status', { to: 'ready_for_pickup', call: 'left_message', note: 'ready' });
  assert.equal(t.calls[0].outcome, 'left_message');
  t = await step('payment', { amount: '105.00' });
  assert.equal(t.money.status, 'paid');
  t = await step('status', { to: 'completed' });
  assert.equal(t.status, 'completed');
  const bad = await post('/api/tickets/MOKU-0186/price', { partnerCharge: '1' }, cookie);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /closed/);
  const board = await (await get('/api/board', cookie)).json();
  assert.equal(board.tickets.length, 0);
});

test('bad input comes back as a plain message, not a crash', async () => {
  const cookie = await signInDanny();
  const r = await post('/api/tickets', { requestId: 'req_abcdefghijklmnop2', customer: { shopifyCustomerGid: 'gid://demo/Customer/1', displayName: 'X' }, board: '', repair: 'x' }, cookie);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Describe the board/);
  assert.equal((await get('/api/tickets/MOKU-9999', cookie)).status, 404);
});

let dannyCookie;
async function signInDanny() {
  dannyCookie ??= await signIn('Danny', '135790');
  return dannyCookie;
}
