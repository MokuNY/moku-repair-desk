// Money is always whole cents (integers). Never floats.

/** "$20", "20", "20.5", "20.50" -> 2000 / 2050. Throws on anything else. */
export function toCents(input) {
  if (Number.isInteger(input)) {
    if (input < 0) throw new RangeError('Amount cannot be negative');
    return input * 100;
  }
  const s = String(input ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new RangeError(`Not a dollar amount: "${input}"`);
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
}

/** 2050 -> "$20.50" */
export function formatCents(cents) {
  if (!Number.isInteger(cents)) throw new TypeError('cents must be an integer');
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
}

/** Customer price = partner charge + shop fee. */
export function customerPriceCents({ partnerChargeCents, shopFeeCents }) {
  for (const v of [partnerChargeCents, shopFeeCents]) {
    if (!Number.isInteger(v) || v < 0) throw new RangeError('Charges must be whole, non-negative cents');
  }
  return partnerChargeCents + shopFeeCents;
}
