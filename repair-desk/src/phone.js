// US phone numbers -> E.164 (+15165550175). The spreadsheet holds every style:
// "516-555-0175", "516.555.0139", "516555-0159", "1203-555-0161".

/** @returns {string|null} E.164 number, or null when it isn't a valid US number. */
export function normalizeUsPhone(input) {
  let d = String(input ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10) return null;
  if (/^[01]/.test(d) || /^\d{3}[01]/.test(d)) return null; // area code / exchange can't start with 0 or 1
  return `+1${d}`;
}

/** +15165550175 -> "(516) 555-0175" */
export function formatUsPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(e164 ?? '');
}

/** Last four digits, for labels (never print the full number). */
export function lastFour(e164) {
  const d = String(e164 ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : '';
}
