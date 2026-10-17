// Repair intake label for the standard 2¼" × 1¼" roll (2.2" printable).
//
//   ┌────────────────────────────────────────┐
//   │ ▓▓▓▓▓▓▓  MOKU-0041                     │
//   │ ▓ QR  ▓  Brendan M.                    │
//   │ ▓▓▓▓▓▓▓  9'0 Fish Stix                 │
//   │          In Oct 17 · ••2459            │
//   │ New center longboard fin box only      │
//   └────────────────────────────────────────┘
//
// The QR code opens the ticket in the Repair Desk. Only the last four digits
// of the phone number are printed, never the full number.

import { textField } from './zpl.js';

/**
 * @param {{ jobNumber: string, customerName: string, board: string, received: string,
 *           phoneLast4?: string, repair?: string, url: string }} label  already validated
 * @param {number} dpi
 * @param {{ widthIn: number, heightIn: number, marginIn: number }} size
 * @param {number} copies
 */
export function buildRepairLabel(label, dpi, size, copies = 1) {
  const d = (inches) => Math.round(inches * dpi);
  const W = d(size.widthIn);
  const H = d(size.heightIn);
  const m = d(size.marginIn);
  const s = dpi / 203; // scale fonts from the 203 dpi design

  const mag = Math.max(2, Math.round(4 * s)); // ~0.6" QR at either resolution
  const qrSide = 33 * mag; // version 4 worst case for our short URLs
  const x0 = m + qrSide + Math.round(14 * s);
  const colW = W - x0 - m;
  const f = (n) => Math.round(n * s);

  const lines = [
    `^FO${m},${m}^BQN,2,${mag}^FDMA,${qrData(label.url)}^FS`,
    textField(x0, m + f(2), f(44), colW, label.jobNumber, 'L'),
    textField(x0, m + f(54), f(28), colW, label.customerName, 'L'),
    textField(x0, m + f(88), f(24), colW, label.board, 'L'),
    textField(x0, m + f(118), f(22), colW, `In ${label.received}${label.phoneLast4 ? ` · ••${label.phoneLast4}` : ''}`, 'L'),
  ];
  if (label.repair) lines.push(textField(m, H - m - f(26), f(24), W - 2 * m, label.repair, 'L'));

  const n = Math.max(1, Math.min(3, Math.floor(copies) || 1));
  return ['^XA', '^CI28', `^PW${W}`, `^LL${H}`, '^LH0,0', ...lines, `^PQ${n},0,1,Y`, '^XZ'].join('') + '\n';
}

/** QR data can't carry ZPL control characters; URLs are validated before this. */
function qrData(url) {
  if (/[\^~]/.test(url)) throw new RangeError('URL contains ZPL control characters');
  return url;
}

const JOB = /^[A-Z]{2,8}-\d{4,6}$/;
const URL_OK = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/[A-Za-z0-9/._-]{1,80}$/;

/**
 * Validate the label fields sent by the Repair Desk.
 * @returns {object|string} the cleaned label, or an error message
 */
export function validateRepairLabel(body) {
  const l = body?.label;
  if (!l || typeof l !== 'object') return 'Missing label.';
  const out = {
    jobNumber: String(l.jobNumber ?? '').trim().toUpperCase(),
    customerName: clean(l.customerName, 40),
    board: clean(l.board, 60),
    received: clean(l.received, 20),
    phoneLast4: String(l.phoneLast4 ?? '').replace(/\D/g, '').slice(-4),
    repair: clean(l.repair, 120),
    url: String(l.url ?? '').trim(),
  };
  if (!JOB.test(out.jobNumber)) return 'Job number must look like MOKU-0041.';
  if (!out.customerName) return 'Customer name is required.';
  if (!out.board) return 'Board description is required.';
  if (!out.received) return 'Received date is required.';
  if (!URL_OK.test(out.url)) return 'Ticket link must be an https URL.';
  return out;
}

function clean(v, max) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
