// Barcode selection and sizing.
//
// Source:  the variant's Barcode field (vendor UPC/EAN) if it has one,
//          otherwise the SKU (your private label), as Code 128.
// Either way the scanned value is exactly the string stored in Shopify, so
// Shopify POS finds the variant when it's scanned.

// Blank margin each side of the bars, in modules. 10 is the Code 128 spec;
// handheld/POS scanners reliably read with 6, which lets ~14-character SKUs
// fit on a 2" label at 203 dpi.
const QUIET_PREFERRED = 10;
const QUIET_MIN = 6;

/**
 * @param {{ barcode?: string, sku?: string }} item
 * @returns {{ kind: 'UPCA'|'EAN13'|'EAN8'|'CODE128C'|'CODE128CB'|'CODE128', value: string, data: string, modules: number } | null}
 *   value = human-readable text, data = what goes in ^FD, modules = symbol width in modules
 */
export function chooseBarcode(item) {
  for (const raw of [item.barcode, item.sku]) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    const sym = symbolFor(value);
    if (sym) return sym;
  }
  return null;
}

function symbolFor(value) {
  if (/^\d{12}$/.test(value) && gtinValid(value)) {
    return { kind: 'UPCA', value, data: value.slice(0, 11), modules: 95 };
  }
  if (/^\d{13}$/.test(value) && gtinValid(value)) {
    return { kind: 'EAN13', value, data: value.slice(0, 12), modules: 95 };
  }
  if (/^\d{8}$/.test(value) && gtinValid(value)) {
    return { kind: 'EAN8', value, data: value.slice(0, 7), modules: 67 };
  }
  // All digits, even length: Code 128 subset C packs two digits per symbol,
  // so a 12-digit in-house code is barely wider than a UPC.
  if (/^(\d\d){2,20}$/.test(value)) {
    return { kind: 'CODE128C', value, data: value, modules: 11 * (value.length / 2) + 35 };
  }
  // All digits, odd length: subset C for the pairs, then switch to B for the
  // last digit. Keeps 11-digit codes about as narrow as a UPC.
  if (/^\d{5,39}$/.test(value)) {
    return { kind: 'CODE128CB', value, data: value, modules: 11 * ((value.length - 1) / 2 + 4) + 13 };
  }
  // Code 128 subset B: printable ASCII.
  if (/^[\x20-\x7e]{1,40}$/.test(value)) {
    return { kind: 'CODE128', value, data: value, modules: 11 * value.length + 35 };
  }
  return null;
}

/** GS1 mod-10 check digit (UPC-A, EAN-13, EAN-8). */
export function gtinValid(digits) {
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

/**
 * Pick the widest module (bar width in dots) that fits, preferring
 * ~0.25–0.35 mm bars, which every handheld and POS scanner reads well.
 * @returns {number} module width in dots, or 0 if it can't fit legibly
 */
export function moduleWidth(sym, dpi, innerW, labelW) {
  const max = dpi >= 300 ? 4 : 3;
  const min = 2; // 1 dot at 203 dpi (0.12 mm) is too fine to scan reliably
  for (const quiet of [QUIET_PREFERRED, QUIET_MIN]) {
    for (let mw = max; mw >= min; mw--) {
      const w = sym.modules * mw;
      if (w <= labelW - 2 * quiet * mw && (w <= innerW || quiet === QUIET_MIN)) return mw;
    }
  }
  return 0;
}

/** ZPL for the symbol (no human-readable line; we print our own). */
export function barcodeZpl(sym, x, y, mw, height, escape) {
  const by = `^BY${mw},3,${height}`;
  switch (sym.kind) {
    case 'UPCA':
      return `^FO${x},${y}${by}^BUN,${height},N,N,N^FD${sym.data}^FS`;
    case 'EAN13':
      return `^FO${x},${y}${by}^BEN,${height},N,N^FD${sym.data}^FS`;
    case 'EAN8':
      return `^FO${x},${y}${by}^B8N,${height},N,N^FD${sym.data}^FS`;
    case 'CODE128C':
      // ">;" = start in subset C (pairs of digits)
      return `^FO${x},${y}${by}^BCN,${height},N,N,N,N^FD>;${sym.data}^FS`;
    case 'CODE128CB':
      // ">;" start in C, ">6" switch to B for the final digit
      return `^FO${x},${y}${by}^BCN,${height},N,N,N,N^FD>;${sym.data.slice(0, -1)}>6${sym.data.slice(-1)}^FS`;
    default:
      // In ^BC a literal ">" must be written as "><" (">" starts an invocation code).
      return `^FO${x},${y}${by}^BCN,${height},N,N,N,N^FH^FD${escape(sym.data).replace(/>/g, '><')}^FS`;
  }
}
