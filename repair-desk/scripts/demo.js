// Build a demo database with made-up customers and boards in every stage.
//
//   node --no-warnings scripts/demo.js data/demo.sqlite
//   DEMO=1 DATABASE_PATH=data/demo.sqlite node --no-warnings src/server.js
//
// Everyone signs in with PIN 1234 in the demo. Never use a demo database for real work.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { createShop, updateShopSettings } from '../src/shops.js';
import { createStaff, setPin } from '../src/staff.js';
import { createPartner } from '../src/partners.js';
import { createTicket, changeStatus } from '../src/tickets.js';
import { setPrices, recordPayment, logCall } from '../src/pricing.js';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/demo.js <database file>'); process.exit(1); }
if (fs.existsSync(file)) { console.error(`${file} already exists. Delete it first.`); process.exit(1); }

const db = openDb(file);
const shop = createShop(db, { name: 'MOKU Surf Shop NY', shopifyDomain: 'moku-repair-test.myshopify.com', jobPrefix: 'MOKU', nextJobNumber: 186 });
const tom = createStaff(db, shop.id, null, { name: 'Tom Gleason', role: 'owner' });
const staff = [tom, createStaff(db, shop.id, tom, { name: 'Carolyn', canRecordPayouts: true })];
for (const n of ['Emma', 'Danny', 'John']) staff.push(createStaff(db, shop.id, tom, { name: n }));
for (const s of staff) setPin(db, shop.id, tom, s.id, '1234');
const keith = createPartner(db, shop.id, tom, { name: 'Keith' });
updateShopSettings(db, shop.id, tom, { defaultPartnerId: keith.id });
const [, carolyn, emma, danny] = staff;

const boards = [
  // customer, phone, board, repair, notes, by, days ago, steps
  ['Jamie Rivera', '+15165550142', "9'4 Takayama, brown", 'Underside cracks tail and nose, pressure dings', 'Fins in the bag', emma, 1, []],
  ['Chris Morgan', '+15165550177', "6'2 Lost Mayhem, blue rails", 'Left fin box, nose ding', '', carolyn, 0, []],
  ['Dana Whitfield', '+19175550123', "7'6 Solid mint", '2 delams bottom near nose', 'Leash left on', danny, 6, ['at_partner']],
  ['Sam Okafor', '+15165550198', "5'8 Pyzel White Tiger", 'Bottom/rail gash', '', emma, 12, ['at_partner'], 6500],
  ['Lena Park', '+16465550110', "8'6 Spoiler, aqua", 'Leash plug', '', carolyn, 41, ['at_partner']],
  ['Mike Alvarez', '+15165550165', "6'0 Al Merrick Beard Fish", 'Right fin box', '', danny, 9, ['at_partner', 'back_from_partner'], 9500],
  ['Priya Shah', '+19145550188', "9'0 Ricky Carroll", 'Ding on nose and rail, seal board', 'Picking up this weekend', emma, 15, ['at_partner', 'back_from_partner', 'ready_for_pickup'], 10500, 'left_message'],
  ['Ben Torres', '+13475550134', "6'8 Hot Buttered, white/red", 'Nose, tail, rail', '', carolyn, 20, ['at_partner', 'back_from_partner', 'ready_for_pickup'], 10000, 'spoke', 4000],
];
for (const [name, phone, board, repair, notes, by, ago, steps, charge, call, deposit] of boards) {
  const [first, last] = name.split(' ');
  const { ticket } = createTicket(db, shop.id, by, {
    requestId: crypto.randomBytes(12).toString('base64url'),
    customer: { shopifyCustomerGid: `gid://demo/Customer/${crypto.randomUUID()}`, displayName: name, firstName: first, lastName: last, phoneE164: phone },
    boardDescription: board, repairRequested: repair, notes,
  });
  const at = new Date(Date.now() - ago * 864e5).toISOString();
  db.prepare('UPDATE tickets SET received_at = ? WHERE id = ?').run(at, ticket.id);
  for (const s of steps) changeStatus(db, shop.id, by, ticket.id, s);
  if (charge) setPrices(db, shop.id, by, ticket.id, { partnerChargeCents: charge });
  if (call) logCall(db, shop.id, by, ticket.id, { outcome: call, note: 'Board is ready' });
  if (deposit) recordPayment(db, shop.id, by, ticket.id, { amountCents: deposit, note: 'Deposit' });
}
console.log(`Demo database written to ${file}: 5 staff (PIN 1234), Keith, 8 boards. Next new job: MOKU-0194.`);
