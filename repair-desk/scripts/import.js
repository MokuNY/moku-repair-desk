// Cutover import of the Moku Ding Repair "Repairs" CSV into a Repair Desk database.
//
//   node --no-warnings scripts/import.js <database> <repairs.csv> [--link MOKU-0004=MOKU-0003] [--apply]
//
// Without --apply it only previews: nothing is written. With --apply it takes a
// full copy of the database first, then imports everything in one transaction
// (or nothing, if anything is wrong). Runs as the shop's owner. Importing the
// same file twice is refused.
//
// The CSV holds customer names and phone numbers: copy it to the server's
// volume for the import and delete it afterwards. Never commit it.

import fs from 'node:fs';
import path from 'node:path';
import { openDb, backupDatabase } from '../src/db.js';
import { previewImport, applyImport, ImportError } from '../src/import.js';
import { listStaff } from '../src/staff.js';
import { dollars } from '../src/records.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const links = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--link') {
    const m = /^([A-Z]+-\d+)=([A-Z]+-\d+)$/i.exec(args[++i] || '');
    if (!m) fail('--link needs JOB=JOB, e.g. --link MOKU-0004=MOKU-0003');
    links[m[1].toUpperCase()] = m[2].toUpperCase();
  }
}
const [dbFile, csvFile] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--link');
if (!dbFile || !csvFile) fail('Usage: node --no-warnings scripts/import.js <database> <repairs.csv> [--link MOKU-0004=MOKU-0003] [--apply]');
if (!fs.existsSync(dbFile)) fail(`No database at ${dbFile}. Start the server once first so the shop is set up.`);

const db = openDb(dbFile);
const shop = db.prepare('SELECT * FROM shops ORDER BY id LIMIT 1').get();
if (!shop) fail('This database has no shop set up.');
const owner = listStaff(db, shop.id).find((s) => s.role === 'owner' && s.active === 1);
if (!owner) fail('No owner in this database.');
const input = { fileName: path.basename(csvFile), text: fs.readFileSync(csvFile, 'utf8'), customerLinks: links };

const plan = previewImport(db, shop.id, owner, input);
const t = plan.totals || {};
console.log(`\n${shop.name} · ${shop.shopify_domain}\nFile: ${plan.fileName} (${plan.rowCount} rows, sha256 ${plan.sha256.slice(0, 12)}…)`);
if (plan.alreadyImported) console.log(`!! This exact file was already imported on ${plan.alreadyImported.imported_at.slice(0, 10)}.`);
console.log(`\nLive tickets: ${plan.active.length}   Archive: ${plan.archive.length}   Already in app: ${plan.unchanged.length}   Next job: ${shop.job_prefix}-${String(plan.nextJobNumber).padStart(4, '0')}`);
if (plan.totals) console.log(`Totals: charged ${dollars(t.customerCharges)} on ${t.pricedJobs} priced jobs · received ${dollars(t.receipts)} · customer balances ${dollars(t.customerBalances)} · gross margin ${dollars(t.grossMargin)}`);
for (const a of plan.active) console.log(`  live  ${a.jobNumber}  ${a.sheetStatus.padEnd(18)} ${a.customer || '(no name)'} · ${a.board}${a.linkTo ? `  [same customer as ${a.linkTo}]` : ''}${a.reviewNote ? '  [check]' : ''}`);

if (plan.history) {
  const h = plan.history;
  console.log(`\nCustomer history: ${n(h.linkedJobs, 'job')} join a customer by phone (${n(h.customers, 'customer')}, ${h.repeatCustomers} with more than one repair)${h.linkedByHand ? `; ${n(h.linkedByHand, 'job')} joined by --link` : ''}.`);
  if (h.noPhone.length) {
    console.log(`${n(h.noPhone.length, 'job')} with no usable phone. They're found by name in search, but won't appear on a customer's history:`);
    for (const r of h.noPhone) console.log(`  ${r.jobNumber}  ${r.customer}${r.phoneText ? `  (phone written as "${r.phoneText}")` : ''}`);
  }
  if (h.sharedPhones.length) {
    console.log(`${n(h.sharedPhones.length, 'phone number')} used under different names (check these are the same person or family):`);
    for (const s of h.sharedPhones) console.log(`  ${s.phone}  ${s.names.join(' / ')}  (${s.jobs.join(', ')})`);
  }
}
if (plan.warnings.length) {
  console.log(`\n${plan.warnings.length} warnings (imported as written):`);
  for (const w of plan.warnings) console.log(`  row ${w.row} ${w.jobNumber || ''}: ${w.message}`);
}
if (plan.conflicts.length) {
  console.log(`\n${plan.conflicts.length} conflicts:`);
  for (const c of plan.conflicts) console.log(`  row ${c.row} ${c.jobNumber}: ${c.message}`);
}
if (plan.errors.length) {
  console.log(`\n${plan.errors.length} errors:`);
  for (const e of plan.errors) console.log(`  row ${e.row} ${e.jobNumber || ''}: ${e.message}`);
}

if (!apply) {
  console.log(`\nPreview only: nothing was written. ${plan.errors.length || plan.conflicts.length || plan.alreadyImported ? 'Fix the problems above first.' : 'Run again with --apply to import.'}\n`);
  process.exit(plan.errors.length || plan.conflicts.length ? 2 : 0);
}

if (plan.alreadyImported || plan.errors.length || plan.conflicts.length) fail('\nNothing was imported: fix the problems above first.');
const copy = backupDatabase(db, dbFile, 'pre-import');
console.log(`\nBackup written: ${copy}`);
try {
  const r = applyImport(db, shop.id, owner, input);
  console.log(`Imported: ${r.active} live tickets, ${r.archived} archived, ${r.skipped} skipped. Next job ${shop.job_prefix}-${String(r.nextJobNumber).padStart(4, '0')}.\n`);
} catch (err) {
  if (err instanceof ImportError) fail(`Nothing was imported: ${err.message}`);
  throw err;
}

function n(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
