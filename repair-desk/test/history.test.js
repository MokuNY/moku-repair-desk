// Finding finished repairs, customer history (app + old spreadsheet jobs), the
// import's history report and the iPad's nightly spreadsheet copy.
// All rows are invented; 555 numbers only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { openDb } from '../src/db.js';
import { createShop, updateShopSettings } from '../src/shops.js';
import { createStaff } from '../src/staff.js';
import { createPartner } from '../src/partners.js';
import { toCsv, parseCsvRecords } from '../src/csv.js';
import { COLUMNS, previewImport, applyImport } from '../src/import.js';
import { createTicket, upsertCustomer, changeStatus, handOver } from '../src/tickets.js';
import { setPrices, recordPayment } from '../src/pricing.js';
import { findTickets, customerHistory } from '../src/history.js';
import { createApp, demoCustomers } from '../src/server.js';
import { sessionManager } from '../src/sessions.js';

const row = (o) => Object.fromEntries(COLUMNS.map((c) => [c, o[c] ?? '']));
const SHEET = [
  row({ 'Repair ID': 'MOKU-0001', Customer: 'Pat Example', Phone: '516-555-0101', 'Board description': "Log 9'6", 'Repair requested': 'stringer', 'Received date': '09/01/26', 'Repair status': 'With Keith', 'Markup override': '$20.00', 'Customer payment': 'Unpaid', 'Customer paid amount': '$0.00' }),
  row({ 'Repair ID': 'MOKU-0010', Customer: 'Pat Example', Phone: '(516) 555-0101', 'Board description': "Fish 5'8", 'Repair requested': 'nose', 'Received date': '04/14/24', 'Repair status': 'Completed', 'Keith cost / estimate': '$60.00', 'Markup override': '$20.00', 'Customer price': '$80.00', 'Customer payment': 'Paid', 'Customer paid amount': '$80.00', 'Customer pickup': '05/01/24', 'Customer balance': '$0.00', 'Moku gross margin': '$20.00' }),
  row({ 'Repair ID': 'MOKU-0011', Customer: 'Patty Example', Phone: '516.555.0101', 'Board description': 'Twin', 'Repair requested': 'fin', 'Received date': '06/02/23', 'Repair status': 'Completed', 'Keith cost / estimate': '$40.00', 'Markup override': '$20.00', 'Customer price': '$60.00', 'Customer payment': 'Paid', 'Customer paid amount': '$60.00', 'Customer balance': '$0.00', 'Moku gross margin': '$20.00' }),
  row({ 'Repair ID': 'MOKU-0012', Customer: 'Nobody Phone', 'Board description': 'Gun', 'Repair requested': 'rail', 'Received date': '06/03/23', 'Repair status': 'Completed', 'Customer payment': 'Unknown' }),
];
const csv = '﻿' + toCsv(COLUMNS, SHEET);

function setup() {
  const db = openDb(':memory:');
  const shop = createShop(db, { name: 'MOKU', shopifyDomain: 'moku-repair-test.myshopify.com', jobPrefix: 'MOKU' });
  const tom = createStaff(db, shop.id, null, { name: 'Tom Gleason', role: 'owner' });
  const emma = createStaff(db, shop.id, tom, { name: 'Emma' });
  updateShopSettings(db, shop.id, tom, { defaultPartnerId: createPartner(db, shop.id, tom, { name: 'Keith' }).id });
  applyImport(db, shop.id, tom, { fileName: 'r.csv', text: csv });
  return { db, shop, tom, emma };
}

/** Check a board in for a Shopify customer, then run it all the way to pickup. */
function finishedRepair(db, shop, staff, customer, n) {
  const { ticket } = createTicket(db, shop.id, staff, { requestId: `req_history_test_${n}_xxxx`, customer, boardDescription: `Board ${n}`, repairRequested: 'ding' });
  changeStatus(db, shop.id, staff, ticket.id, 'at_partner');
  setPrices(db, shop.id, staff, ticket.id, { partnerChargeCents: 5000 });
  changeStatus(db, shop.id, staff, ticket.id, 'back_from_partner');
  changeStatus(db, shop.id, staff, ticket.id, 'ready_for_pickup');
  recordPayment(db, shop.id, staff, ticket.id, { amountCents: 7000, method: 'cash' });
  handOver(db, shop.id, staff, ticket.id);
  return ticket;
}

const PAT = { shopifyCustomerGid: 'gid://shopify/Customer/101', displayName: 'Pat Example', firstName: 'Pat', lastName: 'Example', phoneE164: '+15165550101' };

test('search finds finished repairs, not just open ones', () => {
  const { db, shop, emma } = setup();
  const t = finishedRepair(db, shop, emma, PAT, 1);
  for (const q of [t.job_number, 'pat example', '516 555 0101', 'board 1']) {
    const r = findTickets(db, shop.id, q);
    assert.ok(r.done.some((x) => x.job_number === t.job_number), `"${q}" should find the picked-up job`);
  }
  const r = findTickets(db, shop.id, 'pat');
  assert.deepEqual(r.open.map((x) => x.job_number), ['MOKU-0001']); // imported, still with Keith
  assert.deepEqual(findTickets(db, shop.id, 'x'), { open: [], done: [] }); // too short
  assert.deepEqual(findTickets(db, shop.id, '100%_'), { open: [], done: [] }); // LIKE wildcards are literal
});

test('customer history: app repairs and old spreadsheet jobs, joined by phone, newest first', () => {
  const { db, shop, emma } = setup();
  finishedRepair(db, shop, emma, PAT, 2);
  const h = customerHistory(db, shop.id, { shopifyCustomerGid: PAT.shopifyCustomerGid });
  // New app job + imported live job (MOKU-0001) + both archived jobs with that phone in any format.
  assert.equal(h.count, 4);
  assert.deepEqual(h.repairs.filter((r) => r.source === 'archive').map((r) => r.jobNumber), ['MOKU-0010', 'MOKU-0011']);
  assert.ok(h.repairs.some((r) => r.jobNumber === 'MOKU-0001' && r.open));
  assert.equal(h.repairs[0].source, 'app'); // checked in today
  assert.equal(h.spentCents, 7000 + 8000 + 6000); // finished jobs only
  assert.ok(!h.repairs.some((r) => r.jobNumber === 'MOKU-0012')); // no phone: search only

  // A brand-new Shopify customer record with an old phone still sees the old jobs.
  const fresh = customerHistory(db, shop.id, { phone: '516-555-0101' });
  assert.ok(fresh.repairs.some((r) => r.jobNumber === 'MOKU-0010'));
  assert.equal(customerHistory(db, shop.id, { phone: '212-555-0199' }).count, 0);
});

test('import preview reports how old jobs join histories, and which ones will not', () => {
  const db = openDb(':memory:');
  const shop = createShop(db, { name: 'MOKU', shopifyDomain: 'moku-repair-test.myshopify.com', jobPrefix: 'MOKU' });
  const tom = createStaff(db, shop.id, null, { name: 'Tom Gleason', role: 'owner' });
  updateShopSettings(db, shop.id, tom, { defaultPartnerId: createPartner(db, shop.id, tom, { name: 'Keith' }).id });
  const h = previewImport(db, shop.id, tom, { fileName: 'r.csv', text: csv }).history;
  assert.equal(h.linkedJobs, 3);
  assert.equal(h.repeatCustomers, 1);
  assert.deepEqual(h.noPhone.map((r) => r.jobNumber), ['MOKU-0012']);
  assert.deepEqual(h.sharedPhones, [{ phone: '+15165550101', names: ['Pat Example', 'Patty Example'], jobs: ['MOKU-0010', 'MOKU-0011', 'MOKU-0001'] }]);
});

// ------------------------------------------------------------ over HTTP

const KEY = 'k'.repeat(40);
let server, base, ctx;
before(async () => {
  ctx = setup();
  upsertCustomer(ctx.db, ctx.shop.id, PAT);
  finishedRepair(ctx.db, ctx.shop, ctx.emma, PAT, 3);
  const { setPin } = await import('../src/staff.js');
  setPin(ctx.db, ctx.shop.id, ctx.tom, ctx.emma.id, '2468');
  const app = createApp({ db: ctx.db, shopId: ctx.shop.id, sessions: sessionManager('x'.repeat(40), { secure: false }), customers: demoCustomers(ctx.db, ctx.shop.id), baseUrl: 'https://x.test', exportKey: KEY });
  server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function cookie() {
  const staff = (await (await fetch(base + '/api/staff')).json()).staff;
  const r = await fetch(base + '/api/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staffId: staff.find((s) => s.name === 'Emma').id, pin: '2468' }) });
  return r.headers.get('set-cookie').split(';')[0];
}

test('API: find returns open, picked-up and old jobs; history and ticket show past repairs', async () => {
  const c = await cookie();
  const f = await (await fetch(base + '/api/find?q=pat', { headers: { Cookie: c } })).json();
  assert.deepEqual(f.open.map((t) => t.jobNumber), ['MOKU-0001']);
  assert.equal(f.done.length, 1);
  assert.equal(f.done[0].statusLabel, 'Picked up');
  assert.ok(f.archive.length >= 2);

  const h = await (await fetch(base + `/api/history?gid=${encodeURIComponent(PAT.shopifyCustomerGid)}`, { headers: { Cookie: c } })).json();
  assert.equal(h.count, 4);
  assert.equal((await fetch(base + '/api/history', { headers: { Cookie: c } })).status, 400);
  assert.equal((await fetch(base + '/api/history?phone=5165550101')).status, 401); // needs sign-in

  const t = (await (await fetch(base + '/api/tickets/MOKU-0001', { headers: { Cookie: c } })).json()).ticket;
  assert.ok(!t.previousRepairs.repairs.some((r) => r.jobNumber === 'MOKU-0001')); // not itself
  assert.ok(t.previousRepairs.repairs.some((r) => r.jobNumber === 'MOKU-0010'));
});

test('nightly copy: key required, returns the spreadsheet with every job', async () => {
  const url = base + '/export/repairs.csv';
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { 'X-Export-Key': 'wrong' } })).status, 401);
  assert.equal((await fetch(url + '?key=' + KEY)).status, 401); // never in the URL
  const r = await fetch(url, { headers: { 'X-Export-Key': KEY } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /Moku Repair Desk \d{4}-\d{2}-\d{2}\.csv/);
  const { header, records } = parseCsvRecords(await r.text());
  assert.equal(header[0], 'Job #');
  assert.deepEqual(records.map((x) => x['Job #']), ['MOKU-0001', 'MOKU-0010', 'MOKU-0011', 'MOKU-0012', 'MOKU-0013']);
  assert.equal(records.at(-1).Status, 'Completed');
  const logged = ctx.db.prepare("SELECT detail FROM audit_events WHERE action = 'data.exported' ORDER BY id DESC LIMIT 1").get();
  assert.match(logged.detail, /nightly copy/);
});

test('nightly copy is off without a key, and a short key is refused', () => {
  assert.throws(() => createApp({ db: ctx.db, shopId: ctx.shop.id, sessions: sessionManager('x'.repeat(40)), customers: demoCustomers(ctx.db, ctx.shop.id), baseUrl: 'x', exportKey: 'short' }), /32 characters/);
});
