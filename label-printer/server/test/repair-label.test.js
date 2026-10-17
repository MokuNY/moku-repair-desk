import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepairLabel, validateRepairLabel } from '../src/repair-label.js';

const label = validateRepairLabel({
  label: { jobNumber: 'moku-0041', customerName: 'Brendan M.', board: "9'0 Fish Stix ^XZ~JR", received: 'Oct 17', phoneLast4: '2459', url: 'https://r.fly.dev/t/MOKU-0041', repair: 'x'.repeat(500) },
});
const size = { widthIn: 2.2, heightIn: 1.25, marginIn: 0.06 };

test('fits the 2¼" × 1¼" roll at 203 and 300 dpi', () => {
  assert.match(buildRepairLabel(label, 203, size), /\^PW447\^LL254/);
  const z300 = buildRepairLabel(label, 300, size);
  assert.match(z300, /\^PW660\^LL375/);
  assert.match(z300, /\^BQN,2,6\^/); // QR scaled up with the resolution
});

test('job number is upper-cased; text is escaped and truncated, not wrapped', () => {
  const z = buildRepairLabel(label, 203, size);
  assert.equal(label.jobNumber, 'MOKU-0041');
  assert.match(z, /_5EXZ_7EJR/); // ZPL control characters in the board name can't end the label
  assert.equal((z.match(/\^XZ/g) || []).length, 1);
  assert.match(z, /x\.\.\.\^FS/); // long repair text truncated with "..."
});

test('copies are limited to 1–3', () => {
  assert.match(buildRepairLabel(label, 203, size, 9), /\^PQ3,/);
  assert.match(buildRepairLabel(label, 203, size, 0), /\^PQ1,/);
});
