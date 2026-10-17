// US phone numbers -> E.164 (+15165327875). The spreadsheet holds every style:
// "516-532-7875", "516.398.3139", "516743-2459", "1203-470-6261".

/** @returns {string|null} E.164 number, or null when it isn't a valid US number. */
export function normalizeUsPhone(input) {
  let d = String(input ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10) return null;
  if (/^[01]/.test(d) || /^\d{3}[01]/.test(d)) return null; // area code / exchange can't start with 0 or 1
  return `+1${d}`;
}

/** +15165327875 -> "(516) 532-7875" */
export function formatUsPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(e164 ?? '');
}

/** Last four digits, for labels (never print the full number). */
export function lastFour(e164) {
  const d = String(e164 ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : '';
}
