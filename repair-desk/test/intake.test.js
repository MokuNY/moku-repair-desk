import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { openDb } from '../src/db.js';
import { createShop, updateShopSettings } from '../src/shops.js';
import { createStaff } from '../src/staff.js';
import { createPartner } from '../src/partners.js';
import { ShopifyClient, ShopifyError, customerSearchQuery, SEARCH_CUSTOMERS } from '../src/shopify.js';
import { createTicket, changeStatus, handOver, ticketView, listOpenTickets, getTicketByJobNumber } from '../src/tickets.js';

const rid = () => crypto.randomBytes(12).toString('base64url');

// ------------------------------------------------------------ fake Shopify

function fakeShopify({ responses = [], tokenResponses } = {}) {
  const calls = [];
  const queue = [...responses];
  const tokens = tokenResponses ? [...tokenResponses] : null;
  let tokenCount = 0;
  const reply = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  });
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/admin/oauth/access_token')) {
      tokenCount++;
      if (tokens?.length) return tokens.shift();
      return reply(200, { access_token: `shpat_test_${tokenCount}`, scope: 'read_customers', expires_in: 86399 });
    }
    const next = queue.shift();
    if (!next) throw new Error('unexpected GraphQL call');
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { fetch, calls, reply, tokenCount: () => tokenCount };
}

const client = (fake, extra = {}) =>
  new ShopifyClient({
    shopDomain: 'moku-repair-test.myshopify.com',
    clientId: 'cid',
    clientSecret: 'secret',
    fetch: fake.fetch,
    sleep: async () => {},
    ...extra,
  });

const shopifyCustomer = {
  id: 'gid://shopify/Customer/1',
  displayName: 'Brendan McCarthy',
  firstName: 'Brendan',
  lastName: 'McCarthy',
  defaultPhoneNumber: { phoneNumber: '+15167432459' },
  defaultEmailAddress: null,
  numberOfOrders: '3',
};

test('search: phone, email and name become Shopify search syntax', () => {
  assert.equal(customerSearchQuery('516743-2459'), 'phone:+15167432459');
  assert.equal(customerSearchQuery('kev@example.com'), 'email:"kev@example.com"');
  assert.equal(customerSearchQuery('Brendan McCarthy'), '"Brendan" "McCarthy"');
  assert.equal(customerSearchQuery('a'), '');
  // Typed text can't inject Shopify search filters: quotes and colons are stripped.
  assert.equal(customerSearchQuery('x" OR tag:vip'), '"x" "OR" "tagvip"');
});

test('client: gets a token once, sends it, maps customers', async () => {
  const f = fakeShopify();
  f.calls.length = 0;
  const responses = [f.reply(200, { data: { customers: { nodes: [shopifyCustomer] } } }), f.reply(200, { data: { customers: { nodes: [] } } })];
  const fake = fakeShopify({ responses });
  const c = client(fake);
  const found = await c.searchCustomers('516-743-2459');
  await c.searchCustomers('nobody here');
  assert.equal(fake.tokenCount(), 1);
  assert.deepEqual(found, [
    { shopifyCustomerGid: 'gid://shopify/Customer/1', displayName: 'Brendan McCarthy', firstName: 'Brendan', lastName: 'McCarthy', phoneE164: '+15167432459', email: null, numberOfOrders: 3 },
  ]);
  const gql = fake.calls.find((x) => x.url.includes('/graphql.json'));
  assert.match(gql.url, /\/admin\/api\/2026-10\/graphql\.json$/);
  assert.equal(gql.init.headers['X-Shopify-Access-Token'], 'shpat_test_1');
  const sent = JSON.parse(gql.init.body);
  assert.equal(sent.query, SEARCH_CUSTOMERS);
  assert.equal(sent.variables.q, 'phone:+15167432459');
  const tokenCall = fake.calls[0];
  assert.match(tokenCall.init.body, /grant_type=client_credentials/);
});

test('client: refreshes the token before it expires', async () => {
  let now = 0;
  const fake = fakeShopify({ responses: [1, 2].map(() => (u, i) => fake.reply(200, { data: { customers: { nodes: [] } } })) });
  const c = client(fake, { now: () => now });
  await c.searchCustomers('Kevin');
  now = 86399 * 1000 - 4 * 60_000; // inside the 5-minute early-refresh window
  await c.searchCustomers('Kevin');
  assert.equal(fake.tokenCount(), 2);
});

test('client: retries 429, 5xx and THROTTLED, then succeeds', async () => {
  const fake = fakeShopify();
  const ok = fake.reply(200, { data: { customers: { nodes: [] } } });
  const f2 = fakeShopify({
    responses: [
      fake.reply(429, null, { 'retry-after': '1' }),
      fake.reply(503, null),
      fake.reply(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
      ok,
    ],
  });
  const waits = [];
  const c = client(f2, { sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await c.searchCustomers('Kevin'), []);
  assert.deepEqual(waits, [1000, 1000, 2000]);
});

test('client: gives up after 4 attempts with a clear message', async () => {
  const fake = fakeShopify();
  const f2 = fakeShopify({ responses: [1, 2, 3, 4].map(() => fake.reply(503, null)) });
  await assert.rejects(client(f2).searchCustomers('Kevin'), (e) => e instanceof ShopifyError && /busy/.test(e.message));
});

test('client: a 401 drops the token and retries once', async () => {
  const fake = fakeShopify();
  const f2 = fakeShopify({ responses: [fake.reply(401, {}), fake.reply(200, { data: { customers: { nodes: [] } } })] });
  await client(f2).searchCustomers('Kevin');
  assert.equal(f2.tokenCount(), 2);
});

test('client: token failure explains itself (wrong organization)', async () => {
  const fake = fakeShopify();
  const f2 = fakeShopify({ tokenResponses: [fake.reply(400, { error: 'shop_not_permitted' })] });
  await assert.rejects(client(f2).searchCustomers('Kevin'), /shop_not_permitted/);
});

test('client: create customer validates, normalizes phone, surfaces Shopify errors', async () => {
  const fake = fakeShopify();
  const f2 = fakeShopify({
    responses: [
      (u, init) => {
        const v = JSON.parse(init.body).variables.input;
        assert.equal(v.phone, '+15163983139');
        return fake.reply(200, { data: { customerCreate: { customer: { ...shopifyCustomer, id: 'gid://shopify/Customer/9', displayName: 'Russell Carpenter' }, userErrors: [] } } });
      },
      fake.reply(200, { data: { customerCreate: { customer: null, userErrors: [{ field: ['phone'], message: 'Phone has already been taken' }] } } }),
    ],
  });
  const c = client(f2);
  const made = await c.createCustomer({ firstName: 'Russell', lastName: 'Carpenter', phone: '516.398.3139' });
  assert.equal(made.shopifyCustomerGid, 'gid://shopify/Customer/9');
  await assert.rejects(c.createCustomer({ firstName: 'R', phone: '516.398.3139' }), /already been taken/);
  await assert.rejects(c.createCustomer({ firstName: 'R', phone: '12' }), /not a valid US number/);
  await assert.rejects(c.createCustomer({ phone: '516.398.3139' }), /first or last name/);
});

test('client: network failure is a ShopifyError, not a crash', async () => {
  const c = new ShopifyClient({ shopDomain: 'moku-repair-test.myshopify.com', clientId: 'a', clientSecret: 'b', fetch: async () => { throw new Error('ENOTFOUND'); } });
  await assert.rejects(c.searchCustomers('Kevin'), (e) => e instanceof ShopifyError && e.code === 'NETWORK');
});

// ----------------------------------------------------------------- tickets

function setup() {
  const db = openDb(':memory:');
  const shop = createShop(db, { name: 'MOKU', shopifyDomain: 'moku-repair-test.myshopify.com', jobPrefix: 'MOKU', nextJobNumber: 41 });
  const tom = createStaff(db, shop.id, null, { name: 'Tom Gleason', role: 'owner' });
  const emma = createStaff(db, shop.id, tom, { name: 'Emma' });
  const keith = createPartner(db, shop.id, tom, { name: 'Keith' });
  updateShopSettings(db, shop.id, tom, { defaultPartnerId: keith.id });
  const customer = { shopifyCustomerGid: 'gid://shopify/Customer/1', displayName: 'Brendan McCarthy', firstName: 'Brendan', lastName: 'McCarthy', phoneE164: '+15167432459' };
  return { db, shop, tom, emma, keith, customer };
}

test('intake: creates MOKU-0041 with Keith and the $20 fee, logs it', () => {
  const { db, shop, emma, keith, customer } = setup();
  const { ticket, created } = createTicket(db, shop.id, emma, { requestId: rid(), customer, boardDescription: "9'0 Fish Stix", repairRequested: 'New center fin box' });
  assert.equal(created, true);
  assert.equal(ticket.job_number, 'MOKU-0041');
  assert.equal(ticket.status, 'received');
  assert.equal(ticket.partner_id, keith.id);
  assert.equal(ticket.shop_fee_cents, 2000);
  assert.equal(ticket.partner_charge_cents, null);
  const v = ticketView(db, shop.id, ticket.id);
  assert.equal(v.customer.display_name, 'Brendan McCarthy');
  assert.equal(v.partner.name, 'Keith');
  assert.equal(v.statusLabel, 'Dropped off');
  assert.equal(v.events[0].to_status, 'received');
  assert.equal(v.events[0].staff_id, emma.id);
});

test('intake: the same request twice makes one ticket and one job number', () => {
  const { db, shop, emma, customer } = setup();
  const requestId = rid();
  const a = createTicket(db, shop.id, emma, { requestId, customer, boardDescription: 'Board', repairRequested: 'Ding' });
  const b = createTicket(db, shop.id, emma, { requestId, customer, boardDescription: 'Board', repairRequested: 'Ding' });
  assert.equal(b.created, false);
  assert.equal(b.ticket.id, a.ticket.id);
  const c = createTicket(db, shop.id, emma, { requestId: rid(), customer, boardDescription: 'Board 2', repairRequested: 'Ding' });
  assert.equal(c.ticket.job_number, 'MOKU-0042');
});

test('intake: one customer record per Shopify customer, refreshed on each visit', () => {
  const { db, shop, emma, customer } = setup();
  createTicket(db, shop.id, emma, { requestId: rid(), customer, boardDescription: 'A', repairRequested: 'x' });
  createTicket(db, shop.id, emma, { requestId: rid(), customer: { ...customer, displayName: 'Brendan McCarthy Jr' }, boardDescription: 'B', repairRequested: 'y' });
  const rows = db.prepare('SELECT * FROM customers').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].display_name, 'Brendan McCarthy Jr');
});

test('intake: rejects missing board, repair, customer or a bad request id', () => {
  const { db, shop, emma, customer } = setup();
  assert.throws(() => createTicket(db, shop.id, emma, { requestId: rid(), customer, boardDescription: ' ', repairRequested: 'x' }), /board/);
  assert.throws(() => createTicket(db, shop.id, emma, { requestId: rid(), customer, boardDescription: 'B', repairRequested: '' }), /repair/);
  assert.throws(() => createTicket(db, shop.id, emma, { requestId: rid(), customer: {}, boardDescription: 'B', repairRequested: 'x' }), /Shopify customer/);
  assert.throws(() => createTicket(db, shop.id, emma, { requestId: 'short', customer, boardDescription: 'B', repairRequested: 'x' }), /requestId/);
  assert.equal(listOpenTickets(db, shop.id).length, 0); // nothing half-saved
  assert.equal(db.prepare('SELECT next_job_number FROM shops').get().next_job_number, 41); // no number burned
});

test('status: follows the custody flow; completion only by handing the board over', () => {
  const { db, shop, emma, customer } = setup();
  const { ticket } = createTicket(db, shop.id, emma, { requestId: rid(), customer, boardDescription: 'B', repairRequested: 'x' });
  assert.throws(() => changeStatus(db, shop.id, emma, ticket.id, 'completed'), /handOver/);
  assert.throws(() => changeStatus(db, shop.id, emma, ticket.id, 'ready_for_pickup'), /Can't go from "Dropped off"/);
  assert.throws(() => handOver(db, shop.id, emma, ticket.id), /ready for pickup/);
  changeStatus(db, shop.id, emma, ticket.id, 'at_partner');
  changeStatus(db, shop.id, emma, ticket.id, 'back_from_partner');
  changeStatus(db, shop.id, emma, ticket.id, 'ready_for_pickup');
  const done = handOver(db, shop.id, emma, ticket.id);
  assert.equal(done.status, 'completed');
  assert.ok(done.completed_at);
  assert.throws(() => changeStatus(db, shop.id, emma, ticket.id, 'at_partner'), /Can't go from "Picked up"/);
  const steps = ticketView(db, shop.id, ticket.id).events.map((e) => e.to_status);
  assert.deepEqual(steps, ['received', 'at_partner', 'back_from_partner', 'ready_for_pickup', 'completed']);
  assert.equal(listOpenTickets(db, shop.id).length, 0);
});

test('tickets: timeline is append-only; lookup by job number', () => {
  const { db, shop, emma, customer } = setup();
  const { ticket } = createTicket(db, shop.id, emma, { requestId: rid(), customer, boardDescription: 'B', repairRequested: 'x' });
  assert.throws(() => db.prepare('UPDATE ticket_events SET kind = ?').run('x'), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM ticket_events').run(), /append-only/);
  assert.equal(getTicketByJobNumber(db, shop.id, 'moku-0041').id, ticket.id);
});

test('tickets: another shop cannot see, change or hand over this shop\'s tickets', () => {
  const { db, shop, emma, customer } = setup();
  const { ticket } = createTicket(db, shop.id, emma, { requestId: rid(), customer, boardDescription: 'B', repairRequested: 'x' });
  const hi = createShop(db, { name: 'HI', shopifyDomain: 'hawaii-test.myshopify.com', jobPrefix: 'HI' });
  const hiOwner = createStaff(db, hi.id, null, { name: 'HI Owner', role: 'owner' });
  assert.equal(ticketView(db, hi.id, ticket.id), null);
  assert.equal(getTicketByJobNumber(db, hi.id, 'MOKU-0041'), null);
  assert.throws(() => changeStatus(db, hi.id, hiOwner, ticket.id, 'at_partner'), /No such ticket/);
  assert.throws(() => changeStatus(db, shop.id, hiOwner, ticket.id, 'at_partner'), /Not allowed/);
  assert.throws(() => createTicket(db, shop.id, hiOwner, { requestId: rid(), customer, boardDescription: 'B', repairRequested: 'x' }), /Not allowed/);
  // A Hawaii ticket can't point at MOKU's customer or partner rows.
  assert.throws(
    () => db.prepare(`INSERT INTO tickets (shop_id, job_number, customer_id, board_description, repair_requested, shop_fee_cents, created_by, intake_request_id)
                      VALUES (?, 'HI-0001', ?, 'B', 'x', 0, ?, ?)`).run(hi.id, ticket.customer_id, hiOwner.id, rid()),
    /FOREIGN KEY/,
  );
});
