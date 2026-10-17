import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { openDb } from '../src/db.js';
import { createShop } from '../src/shops.js';
import { createStaff } from '../src/staff.js';
import { createTicket, ticketView } from '../src/tickets.js';
import { requestLabel, sendLabel, labelFields, getLabelPrint, labelServerClient } from '../src/labels.js';

const rid = () => crypto.randomBytes(12).toString('base64url');
const BASE = { baseUrl: 'https://repair-desk-test.fly.dev', timezone: 'America/New_York' };

function setup() {
  const db = openDb(':memory:');
  const shop = createShop(db, { name: 'MOKU', shopifyDomain: 'moku-repair-test.myshopify.com', jobPrefix: 'MOKU', nextJobNumber: 41 });
  const tom = createStaff(db, shop.id, null, { name: 'Tom Gleason', role: 'owner' });
  const john = createStaff(db, shop.id, tom, { name: 'John' });
  const { ticket } = createTicket(db, shop.id, john, {
    requestId: rid(),
    customer: { shopifyCustomerGid: 'gid://shopify/Customer/1', displayName: 'Brendan McCarthy', firstName: 'Brendan', lastName: 'McCarthy', phoneE164: '+15167432459' },
    boardDescription: "9'0 Fish Stix",
    repairRequested: 'New center longboard fin box only',
  });
  return { db, shop, tom, john, ticket };
}

/** A label server stand-in that records what it was sent. */
function fakeLabelServer(replies = []) {
  const sent = [];
  const queue = [...replies];
  return {
    sent,
    async send(body) {
      sent.push(body);
      const next = queue.shift() ?? { status: 200, body: { ok: true, printer: 'Front counter' } };
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('label fields: first name + last initial, last four digits, ticket link', () => {
  const { db, shop, ticket } = setup();
  const f = labelFields(db, shop.id, ticket.id, BASE);
  assert.equal(f.jobNumber, 'MOKU-0041');
  assert.equal(f.customerName, 'Brendan M.');
  assert.equal(f.phoneLast4, '2459');
  assert.equal(f.board, "9'0 Fish Stix");
  assert.equal(f.url, 'https://repair-desk-test.fly.dev/t/MOKU-0041');
  assert.match(f.received, /^[A-Z][a-z]{2} \d{1,2}$/);
  assert.ok(!JSON.stringify(f).includes('743')); // full number never leaves the app
});

test('intake label: requested once per ticket, sent, logged on the timeline', async () => {
  const { db, shop, john, ticket } = setup();
  const lp = requestLabel(db, shop.id, john, ticket.id);
  assert.equal(requestLabel(db, shop.id, john, ticket.id).id, lp.id); // second tap: same request
  const server = fakeLabelServer();
  const done = await sendLabel(db, shop.id, lp.id, server, BASE);
  assert.equal(done.status, 'sent');
  assert.equal(done.attempts, 1);
  assert.equal(done.printer_name, 'Front counter');
  assert.equal(server.sent[0].idempotencyKey, lp.idempotency_key);
  // Sending an already-sent label does nothing.
  await sendLabel(db, shop.id, lp.id, server, BASE);
  assert.equal(server.sent.length, 1);
  const actions = ticketView(db, shop.id, ticket.id).events.filter((e) => e.kind === 'label').map((e) => e.detail.action);
  assert.deepEqual(actions, ['requested', 'sent']);
});

test('failed print: recorded with the reason, retried with the SAME key, max 3 tries', async () => {
  const { db, shop, john, ticket } = setup();
  const lp = requestLabel(db, shop.id, john, ticket.id);
  const server = fakeLabelServer([
    { status: 503, body: { error: 'Front counter reports: paper out.' } },
    new Error('fetch failed'),
    { status: 503, body: { error: 'Front counter is not connected.' } },
  ]);
  const a = await sendLabel(db, shop.id, lp.id, server, BASE);
  assert.equal(a.status, 'failed');
  assert.match(a.last_error, /paper out/);
  const b = await sendLabel(db, shop.id, lp.id, server, BASE);
  assert.match(b.last_error, /Could not reach the label printer/);
  await sendLabel(db, shop.id, lp.id, server, BASE);
  await assert.rejects(sendLabel(db, shop.id, lp.id, server, BASE), /failed 3 times/);
  assert.equal(new Set(server.sent.map((s) => s.idempotencyKey)).size, 1);
  assert.equal(getLabelPrint(db, shop.id, lp.id).attempts, 3);
});

test('reprint: a new, separately logged request with its own key', async () => {
  const { db, shop, john, ticket } = setup();
  const server = fakeLabelServer();
  const first = requestLabel(db, shop.id, john, ticket.id);
  await sendLabel(db, shop.id, first.id, server, BASE);
  const again = requestLabel(db, shop.id, john, ticket.id, { kind: 'reprint' });
  assert.notEqual(again.id, first.id);
  assert.notEqual(again.idempotency_key, first.idempotency_key);
  await sendLabel(db, shop.id, again.id, server, BASE);
  assert.equal(server.sent.length, 2);
  const actions = ticketView(db, shop.id, ticket.id).events.filter((e) => e.kind === 'label').map((e) => e.detail.action);
  assert.deepEqual(actions, ['requested', 'sent', 'reprint_requested', 'sent']);
});

test('labels: another shop cannot request or send this shop\'s labels', async () => {
  const { db, shop, john, ticket } = setup();
  const lp = requestLabel(db, shop.id, john, ticket.id);
  const hi = createShop(db, { name: 'HI', shopifyDomain: 'hawaii-test.myshopify.com', jobPrefix: 'HI' });
  const hiOwner = createStaff(db, hi.id, null, { name: 'HI Owner', role: 'owner' });
  assert.throws(() => requestLabel(db, shop.id, hiOwner, ticket.id), /Not allowed/);
  assert.throws(() => requestLabel(db, hi.id, hiOwner, ticket.id), /No such ticket/);
  await assert.rejects(sendLabel(db, hi.id, lp.id, fakeLabelServer(), BASE), /No such label request/);
});

test('label server client: bearer token, JSON body, timeout signal', async () => {
  let seen;
  const c = labelServerClient({
    url: 'https://moku-labels-b228fd.fly.dev/',
    token: 'secret-token',
    fetch: async (url, init) => {
      seen = { url, init };
      return { status: 200, json: async () => ({ ok: true }) };
    },
  });
  const r = await c.send({ idempotencyKey: 'k'.repeat(20) });
  assert.equal(seen.url, 'https://moku-labels-b228fd.fly.dev/api/repair-label');
  assert.equal(seen.init.headers.Authorization, 'Bearer secret-token');
  assert.ok(seen.init.signal);
  assert.deepEqual(r, { status: 200, body: { ok: true } });
  assert.throws(() => labelServerClient({ url: 'ftp://x', token: 't' }));
});
