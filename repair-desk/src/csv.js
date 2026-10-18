// CSV read/write (RFC 4180). Handles quoted commas, quotes and line breaks,
// a UTF-8 byte-order mark, and CRLF line endings, as written by Numbers.

/** @returns {string[][]} rows of cells */
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (quoted) throw new SyntaxError('CSV ends inside a quoted cell');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Parse with a header row. @returns {{ header: string[], records: Record<string,string>[] }} */
export function parseCsvRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new SyntaxError('The file is empty');
  const header = rows[0].map((h) => h.trim());
  const records = rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  return { header, records };
}

/**
 * Write CSV. Text that a spreadsheet would run as a formula (=, +, @, or - not
 * followed by a digit) gets a leading apostrophe, so an export can never run
 * code when opened in Numbers or Excel.
 */
export function toCsv(header, rows) {
  const line = (cells) => cells.map(cellOut).join(',');
  return [line(header), ...rows.map((r) => line(header.map((h) => r[h])))].join('\r\n') + '\r\n';
}

function cellOut(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+@\t\r]/.test(s) || /^-(?![\d.])/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
