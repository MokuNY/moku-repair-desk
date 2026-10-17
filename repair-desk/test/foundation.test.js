import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, migrate } from '../src/db.js';
import { toCents, formatCents, customerPriceCents } from '../src/money.js';
import { normalizeUsPhone, formatUsPhone, lastFour } from '../src/phone.js';
import { createShop, getShop, getShopByDomain, takeJobNumber, updateShopSettings, PermissionError } from '../src/shops.js';
import { createStaff, getStaff, can, setPin, signInWithPin, hashPin, checkPin } from '../src/staff.js';
import { createPartner, getPartner, listPartners } from '../src/partners.js';
import { recordEvent, listEvents } from '../src/audit.js';

function setup() {
  const db = openDb(':memory:');
  const moku = createShop(db, { name: 'MOKU NY', shopifyDomain: 'moku-surf-shop-ny.myshopify.com', jobPrefix: 'MOKU', nextJobNumber: 41 });
  const owner = createStaff(db, moku.id, null, { name: 'Owner', role: 'owner' });
  const carolyn = createStaff(db, moku.id, owner, { name: 'Carolyn', canRecordPayouts: true });
  const counter = createStaff(db, moku.id, owner, { name: 'Counter', role: 'staff' });
  const keith = createPartner(db, moku.id, owner, { name: 'Keith' });
  return { db, moku, owner, carolyn, counter, keith };
}

// ------------------------------------------------------------------ money

test('money: dollars to cents and back, no floats', () => {
  assert.equal(toCents('20'), 2000);
  assert.equal(toCents('$20.5'), 2050);
  assert.equal(toCents('1,250.99'), 125099);
  assert.equal(toCents(80), 8000);
  assert.throws(() => toCents('-5'));
  assert.throws(() => toCents('12.345'));
  assert.throws(() => toCents('abc'));
  assert.equal(formatCents(125099), '$1,250.99');
  assert.equal(formatCents(5), '$0.05');
  assert.equal(customerPriceCents({ partnerChargeCents: 6000, shopFeeCents: 2000 }), 8000);
  assert.throws(() => customerPriceCents({ partnerChargeCents: 60.5, shopFeeCents: 2000 }));
});

// ------------------------------------------------------------------ phone

test('phone: every format found in the repair spreadsheet', () => {
  assert.equal(normalizeUsPhone('516-532-7875'), '+15165327875');
  assert.equal(normalizeUsPhone('516.398.3139'), '+15163983139');
  assert.equal(normalizeUsPhone('516743-2459'), '+15167432459');
  assert.equal(normalizeUsPhone('1203-470-6261'), '+12034706261');
  assert.equal(normalizeUsPhone('808-445-1183'), '+18084451183');
  assert.equal(normalizeUsPhone('Contact: LM 8/28/26'), null);
  assert.equal(normalizeUsPhone(''), null);
  assert.equal(formatUsPhone('+15165327875'), '(516) 532-7875');
  assert.equal(lastFour('+15165327875'), '7875');
});

// --------------------------------------------------------------- database

test('migrations run once and are recorded', () => {
  const { db } = setup();
  const before = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, before);
});

test('shop defaults: $20 fee, Eastern time, lookup by domain', () => {
  const { db, moku } = setup();
  assert.equal(moku.default_shop_fee_cents, 2000);
  assert.equal(moku.timezone, 'America/New_York');
  assert.equal(getShopByDomain(db, 'moku-surf-shop-ny.myshopify.com').id, moku.id);
  assert.throws(() => createShop(db, { name: 'x', shopifyDomain: 'evil.com', jobPrefix: 'EV' }));
});

// ------------------------------------------------------------ job numbers

test('job numbers continue from the spreadsheet and never repeat', () => {
  const { db, moku } = setup();
  assert.equal(takeJobNumber(db, moku.id), 'MOKU-0041');
  assert.equal(takeJobNumber(db, moku.id), 'MOKU-0042');
  assert.equal(getShop(db, moku.id).next_job_number, 43);
});

test('each shop has its own job number sequence', () => {
  const { db, moku } = setup();
  const hi = createShop(db, { name: 'Hawaii', shopifyDomain: 'hawaii-test.myshopify.com', jobPrefix: 'HI' });
  assert.equal(takeJobNumber(db, hi.id), 'HI-0001');
  assert.equal(takeJobNumber(db, moku.id), 'MOKU-0041');
  assert.equal(takeJobNumber(db, hi.id), 'HI-0002');
});

// ------------------------------------------------------------ permissions

test('only owners and Carolyn can record Keith payouts', () => {
  const { owner, carolyn, counter } = setup();
  assert.equal(can(owner, 'payout.record'), true);
  assert.equal(can(carolyn, 'payout.record'), true);
  assert.equal(can(counter, 'payout.record'), false);
  assert.equal(can(counter, 'ticket.set_price'), true);
  assert.equal(can(counter, 'settings.manage'), false);
});

test('inactive staff can do nothing', () => {
  const { db, moku, carolyn } = setup();
  db.prepare('UPDATE staff SET active = 0 WHERE id = ?').run(carolyn.id);
  const c = getStaff(db, moku.id, carolyn.id);
  assert.equal(can(c, 'ticket.create'), false);
  assert.equal(can(c, 'payout.record'), false);
});

test('first staff member must be an owner; later ones need an owner to add them', () => {
  const db = openDb(':memory:');
  const s = createShop(db, { name: 'S', shopifyDomain: 's.myshopify.com', jobPrefix: 'SS' });
  assert.throws(() => createStaff(db, s.id, null, { name: 'A', role: 'staff' }), /first staff member/);
  const o = createStaff(db, s.id, null, { name: 'O', role: 'owner' });
  const st = createStaff(db, s.id, o, { name: 'B' });
  assert.throws(() => createStaff(db, s.id, st, { name: 'C' }), PermissionError);
});

test('settings: owners only, and every change is audited', () => {
  const { db, moku, owner, counter } = setup();
  assert.throws(() => updateShopSettings(db, moku.id, counter, { defaultShopFeeCents: 2500 }), PermissionError);
  const after = updateShopSettings(db, moku.id, owner, { defaultShopFeeCents: 2500 });
  assert.equal(after.default_shop_fee_cents, 2500);
  const ev = listEvents(db, moku.id, { entityType: 'shop', entityId: moku.id }).at(-1);
  assert.equal(ev.action, 'shop.settings_changed');
  assert.deepEqual(ev.detail.defaultShopFeeCents, { from: 2000, to: 2500 });
  assert.equal(ev.staff_id, owner.id);
});

// -------------------------------------------------------------------- PIN

test('PIN: stored hashed, checked in constant time, set by self or owner', () => {
  const { db, moku, owner, carolyn, counter } = setup();
  const h = hashPin('4821');
  assert.ok(!h.includes('4821'));
  assert.equal(checkPin('4821', h), true);
  assert.equal(checkPin('4822', h), false);
  assert.throws(() => hashPin('12'));

  setPin(db, moku.id, carolyn, carolyn.id, '4821');
  assert.equal(signInWithPin(db, moku.id, carolyn.id, '4821')?.name, 'Carolyn');
  assert.equal(signInWithPin(db, moku.id, carolyn.id, '0000'), null);
  assert.throws(() => setPin(db, moku.id, counter, carolyn.id, '1111'), PermissionError);
  setPin(db, moku.id, owner, counter.id, '1357');
  assert.ok(signInWithPin(db, moku.id, counter.id, '1357'));
});

// ------------------------------------------------------------------ audit

test('audit log cannot be edited or deleted', () => {
  const { db, moku, owner } = setup();
  const id = recordEvent(db, moku.id, { staffId: owner.id, action: 'test.event', entityType: 'test' });
  assert.throws(() => db.prepare('UPDATE audit_events SET action = ? WHERE id = ?').run('changed', id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_events WHERE id = ?').run(id), /append-only/);
});

// -------------------------------------------------------- tenant isolation

test('one shop can never see or reference another shop\'s rows', () => {
  const { db, moku, owner, keith } = setup();
  const hi = createShop(db, { name: 'Hawaii', shopifyDomain: 'hawaii-test.myshopify.com', jobPrefix: 'HI' });
  const hiOwner = createStaff(db, hi.id, null, { name: 'HI Owner', role: 'owner' });

  // Lookups are scoped by shop.
  assert.equal(getPartner(db, hi.id, keith.id), null);
  assert.equal(getStaff(db, hi.id, owner.id), null);
  assert.equal(listPartners(db, hi.id).length, 0);
  assert.equal(listEvents(db, hi.id).every((e) => e.shop_id === hi.id), true);

  // The database itself refuses cross-shop references.
  assert.throws(() => updateShopSettings(db, hi.id, hiOwner, { defaultPartnerId: keith.id }), /FOREIGN KEY/);
  assert.throws(() => recordEvent(db, hi.id, { staffId: owner.id, action: 'x', entityType: 'x' }), /FOREIGN KEY/);

  // An owner of one shop has no power in another.
  assert.throws(() => updateShopSettings(db, moku.id, hiOwner, { defaultShopFeeCents: 0 }), PermissionError);
  assert.throws(() => createPartner(db, moku.id, hiOwner, { name: 'Intruder' }), PermissionError);
  assert.throws(() => createStaff(db, moku.id, hiOwner, { name: 'Intruder' }), PermissionError);

  // Within its own shop, the reference works.
  assert.equal(updateShopSettings(db, moku.id, owner, { defaultPartnerId: keith.id }).default_partner_id, keith.id);
});
