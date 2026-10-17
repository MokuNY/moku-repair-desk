#!/usr/bin/env node
// Writes the SGD commands that point a Zebra printer at the print server.
//
//   node scripts/printer-config.js --host labels.example.com --token <token> [--name "Front counter"]
//   node scripts/printer-config.js --new-token          (just prints a fresh token)
//
// Send the resulting file to the printer over Wi-Fi from a computer on the
// same network:   nc <printer-ip> 9100 < weblink-front-counter.txt
// (Windows: Zebra Setup Utilities → Open Communication with Printer → paste.)

import crypto from 'node:crypto';
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]);
    return acc;
  }, []),
);

if (args['new-token']) {
  console.log(crypto.randomBytes(24).toString('base64url'));
  process.exit(0);
}

const host = String(args.host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const token = String(args.token || '');
const name = String(args.name || 'printer');
if (!host || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
  console.error('Usage: node scripts/printer-config.js --host <your-server-host> --token <printer token> [--name "Front counter"]');
  process.exit(1);
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const url = `https://${host}/weblink/${token}`;

// The printer validates the server's TLS certificate, so its clock must be right.
const sgd = [
  `! U1 setvar "rtc.date" "${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${now.getFullYear()}"`,
  `! U1 setvar "rtc.time" "${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}"`,
  `! U1 setvar "weblink.ip.conn1.location" "${url}"`,
  `! U1 setvar "weblink.ip.conn1.retry_interval" "10"`,
  `! U1 setvar "weblink.logging.max_entries" "100"`,
  `! U1 do "device.reset" ""`,
  '',
].join('\r\n');

const file = `weblink-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'printer'}.txt`;
fs.writeFileSync(file, sgd);
console.log(`Wrote ${file}  →  printer will connect to ${url}`);
console.log(`Send it:  nc <printer-ip> 9100 < ${file}`);
