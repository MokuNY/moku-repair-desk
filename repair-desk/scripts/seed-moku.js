// One-time setup of MOKU Surf Shop NY in a Repair Desk database.
//
//   node --no-warnings scripts/seed-moku.js <database file> "<owner name>" [shop domain]
//
// The domain defaults to the development store, so a production database is
// never created by accident. Pass moku-surf-shop-ny.myshopify.com explicitly
// for production (approval point A7).

import { openDb } from '../src/db.js';
import { createShop, getShopByDomain, updateShopSettings } from '../src/shops.js';
import { createStaff } from '../src/staff.js';
import { createPartner } from '../src/partners.js';

const [file, ownerName, domain = 'moku-repair-test.myshopify.com'] = process.argv.slice(2);
if (!file || !ownerName) {
  console.error('Usage: node scripts/seed-moku.js <database file> "<owner name>" [shop domain]');
  process.exit(1);
}

// Ding Repair product in the live store (looked up Oct 17, 2026). The dev store
// has its own product; set those IDs in settings after creating it there.
const LIVE_DING_REPAIR = {
  dingRepairProductGid: 'gid://shopify/Product/8723034308766',
  dingRepairVariantGid: 'gid://shopify/ProductVariant/46869476769950',
};

const db = openDb(file);
if (getShopByDomain(db, domain)) {
  console.error(`${domain} is already set up in ${file}. Nothing changed.`);
  process.exit(1);
}

const shop = createShop(db, {
  name: 'MOKU Surf Shop NY',
  shopifyDomain: domain,
  jobPrefix: 'MOKU',
  // Job numbers: importing Moku Ding Repair moves the counter past MOKU-0185.
  timezone: 'America/New_York',
  defaultShopFeeCents: 2000,
});
const owner = createStaff(db, shop.id, null, { name: ownerName, role: 'owner' });
createStaff(db, shop.id, owner, { name: 'Carolyn', role: 'staff', canRecordPayouts: true });
for (const name of ['Emma', 'Danny', 'John']) createStaff(db, shop.id, owner, { name, role: 'staff' });
const keith = createPartner(db, shop.id, owner, { name: 'Keith' });
updateShopSettings(db, shop.id, owner, {
  defaultPartnerId: keith.id,
  ...(domain === 'moku-surf-shop-ny.myshopify.com' ? LIVE_DING_REPAIR : {}),
});

console.log(`Set up ${shop.name} (${domain}) in ${file}: owner ${ownerName}, Carolyn (payouts), Emma, Danny, John, partner Keith. Import Moku Ding Repair next; new jobs then start at MOKU-0186.`);
