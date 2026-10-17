// End to end: Repair Desk -> real label server (child process) -> simulated ZD411.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/db.js';
import { createShop } from '../src/shops.js';
import { createStaff } from '../src/staff.js';
import { createTicket } from '../src/tickets.js';
import { requestLabel, sendLabel, labelServerClient } from '../src/labels.js';
import { startFakePrinter } from '../../label-printer/server/test/fake-printer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 38931;
const PRINTER_TOKEN = 'e2eprinter_ABCDEFGHIJKLMNOP';
const DESK_TOKEN = 'e2e-repair-desk-secret-0123456789';
let server, printer;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: path.resolve(here, '../../label-printer/server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      SHOPIFY_API_KEY: 'k',
      SHOPIFY_API_SECRET: 's',
      PRINTERS: `Front counter=${PRINTER_TOKEN}`,
      REPAIR_DESK_TOKEN: DESK_TOKEN,
      LABEL_WIDTH_IN: '2.2', // the live roll, as in fly.toml
      LABEL_HEIGHT_IN: '1.25',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('listening') && resolve());
    server.on('exit', (c) => reject(new Error(`label server exited ${c}`)));
  });
  printer = startFakePrinter(`ws://127.0.0.1:${PORT}/weblink/${PRINTER_TOKEN}`);
  await printer.rawReady;
  await wait(300); // DPI handshake
});

after(() => {
  printer?.close();
  server?.kill();
});

test('check in a board -> QR label prints on the ZD411, once', async () => {
  const db = openDb(':memory:');
  const shop = createShop(db, { name: 'MOKU', shopifyDomain: 'moku-repair-test.myshopify.com', jobPrefix: 'MOKU', nextJobNumber: 41 });
  const tom = createStaff(db, shop.id, null, { name: 'Tom Gleason', role: 'owner' });
  const { ticket } = createTicket(db, shop.id, tom, {
    requestId: crypto.randomBytes(12).toString('base64url'),
    customer: { shopifyCustomerGid: 'gid://shopify/Customer/7', displayName: 'Russell Carpenter', firstName: 'Russell', lastName: 'Carpenter', phoneE164: '+15163983139' },
    boardDescription: "11'1 Chopwood",
    repairRequested: 'Minor dings bottom/middle',
  });

  const client = labelServerClient({ url: `http://127.0.0.1:${PORT}`, token: DESK_TOKEN });
  const lp = requestLabel(db, shop.id, tom, ticket.id);
  const opts = { baseUrl: 'https://repair-desk-test.fly.dev' };
  const done = await sendLabel(db, shop.id, lp.id, client, opts);
  assert.equal(done.status, 'sent', done.last_error);
  assert.equal(done.printer_name, 'Front counter');

  // Simulate the iPad retrying the same request after a dropped response.
  db.prepare(`UPDATE label_prints SET status = 'pending' WHERE id = ?`).run(lp.id);
  assert.equal((await sendLabel(db, shop.id, lp.id, client, opts)).status, 'sent');

  await wait(200);
  const zpl = printer.received.join('');
  assert.deepEqual(printer.violations, []);
  assert.equal((zpl.match(/\^XA/g) || []).length, 1, 'printed exactly once');
  assert.match(zpl, /\^PW447\^LL254/); // 2.2" x 1.25" at 203 dpi
  assert.match(zpl, /\^BQN,2,4\^FDMA,https:\/\/repair-desk-test\.fly\.dev\/t\/MOKU-0041\^FS/);
  assert.match(zpl, /Russell C\./);
  assert.match(zpl, /••3139/);
  assert.match(zpl, /11'1 Chopwood/);

  // Wrong secret is refused end to end.
  const bad = labelServerClient({ url: `http://127.0.0.1:${PORT}`, token: 'nope' });
  const lp2 = requestLabel(db, shop.id, tom, ticket.id, { kind: 'reprint' });
  const refused = await sendLabel(db, shop.id, lp2.id, bad, opts);
  assert.equal(refused.status, 'failed');
  assert.match(refused.last_error, /Not authorized/);
});
