// ZPL for small product labels.
//
// With barcodes (default), 2" x 1":          2" x 1.5" adds the product name:
//   ┌──────────────────────────────┐          ┌──────────────────────────────┐
//   │ [LOGO]               $54.00  │          │ [LOGO]               $54.00  │
//   │ Large / Navy     RG-PL-NVY-L │          │ Pipeline Rash Guard          │
//   │   ║│║║│║│║║│║║│║│║║│║│║║│    │          │ Large / Navy     RG-PL-NVY-L │
//   │        012345678905          │          │   ║│║║│║│║║│║║│║│║║│║│║║│    │
//   └──────────────────────────────┘          │        012345678905          │
//                                             └──────────────────────────────┘
// The SKU is printed on the variant line only when the barcode is a vendor
// UPC/EAN; when the barcode encodes the SKU, the text under it is the SKU.
//
// With BARCODES=false, the original text layout is used (logo, product,
// variant, SKU + big price at the bottom).

import { logoGraphic } from './logo.js';
import { chooseBarcode, moduleWidth, barcodeZpl } from './barcode.js';

const LOGO_NAME = 'R:LOGO.GRF'; // printer RAM; re-sent with every job

/**
 * @param {object} job
 * @param {{productTitle?:string, variantTitle?:string, sku?:string, barcode?:string, price:string|number, quantity:number}[]} job.items
 * @param {string} job.currencyCode ISO 4217, e.g. "USD"
 * @param {number} dpi
 * @param {object} settings  see config.js `label`
 * @returns {string} ZPL
 */
export function buildLabelJob({ items, currencyCode }, dpi, settings) {
  if (settings.type === 'butterfly') return buildButterflyJob({ items, currencyCode }, dpi, settings);
  const L = layout(dpi, settings);
  const money = moneyFormatter(currencyCode, settings.locale);
  const logo = logoGraphic(settings.logoPath, L.logoBoxW, L.logoH, {
    threshold: settings.logoThreshold,
    dither: settings.logoDither,
  });

  let out = '';
  if (logo) out += `~DG${LOGO_NAME},${logo.hex.length / 2},${logo.bytesPerRow},${logo.hex}\n`;

  for (const item of items) {
    const qty = Math.max(0, Math.min(999, Math.floor(Number(item.quantity) || 0)));
    if (!qty) continue;
    const body = settings.barcodes
      ? barcodeLabel(item, L, settings, money, logo, dpi)
      : textLabel(item, L, settings, money, logo);
    out += ['^XA', '^CI28', `^PW${L.W}`, `^LL${L.H}`, '^LH0,0', ...body, `^PQ${qty},0,1,Y`, '^XZ'].join('') + '\n';
  }
  return out;
}

// ------------------------------------------------------------ barcode layout

function barcodeLabel(item, L, settings, money, logo, dpi) {
  const variant = cleanVariant(item.variantTitle);
  const title = clean(item.productTitle);
  const price = money(item.price);
  const sku = clean(item.sku);
  const out = [];

  // Row 1: logo left, price right (shrinks to fit beside the logo).
  if (logo) out.push(`^FO${L.m},${L.m + Math.round((L.topH - logo.height) / 2)}^XG${LOGO_NAME},1,1^FS`);
  const priceArea = L.innerW - (logo ? logo.width + L.gap * 2 : 0);
  let priceF = L.topH;
  while (priceF > L.topH * 0.55 && textWidth(price, priceF) + 4 > priceArea) priceF--;
  out.push(textField(L.W - L.m - priceArea, L.m + Math.round((L.topH - priceF) / 2), priceF, priceArea, price, 'R'));

  let y = L.m + L.topH + L.gap;
  const bottom = L.H - L.m;

  // Barcode sizing first, so we know whether the product name fits too.
  let sym = chooseBarcode({ barcode: item.barcode, sku });
  const mw = sym ? moduleWidth(sym, dpi, L.innerW, L.W) : 0;
  if (!mw) sym = null;
  const showSkuText = sku && (!sym || sym.value !== sku);
  const rowsH = (withTitle) => (withTitle ? L.titleF + L.lineGap : 0) + (variant || showSkuText ? L.variantF + L.gap : 0);
  const barSpace = (withTitle) => bottom - y - rowsH(withTitle) - L.humanF - L.lineGap;

  const titleWanted = title && settings.showProductTitle !== false;
  const showTitle = titleWanted && (!sym || barSpace(true) >= L.minBarH);

  if (showTitle) {
    out.push(textField(L.m, y, L.titleF, L.innerW, title, 'L'));
    y += L.titleF + L.lineGap;
  }

  // Variant left, SKU right (unless the barcode already spells out the SKU).
  if (variant || showSkuText) {
    let skuW = 0;
    if (showSkuText) {
      skuW = Math.min(Math.ceil(textWidth(sku, L.skuF)) + 4, variant ? Math.round(L.innerW * 0.5) : L.innerW);
      out.push(textField(L.W - L.m - skuW, y + (L.variantF - L.skuF), L.skuF, skuW, sku, 'R'));
    }
    if (variant) out.push(textField(L.m, y, L.variantF, L.innerW - skuW - (skuW ? L.gap : 0), variant, 'L'));
    y += L.variantF + L.gap;
  }

  if (sym) {
    const barH = Math.min(L.maxBarH, bottom - y - L.humanF - L.lineGap);
    if (barH >= Math.round(L.minBarH * 0.6)) {
      const symW = sym.modules * mw;
      const x = Math.round((L.W - symW) / 2);
      out.push(barcodeZpl(sym, x, y, mw, barH, escapeZpl));
      out.push(textField(L.m, y + barH + L.lineGap, L.humanF, L.innerW, sym.value, 'C'));
    } else if (!showSkuText && sku) {
      out.push(textField(L.m, y, L.skuF, L.innerW, sku, 'L')); // no room: at least keep the SKU
    }
  }
  return out;
}

// --------------------------------------------------------------- text layout

function textLabel(item, L, settings, money, logo) {
  const variant = cleanVariant(item.variantTitle);
  const title = clean(item.productTitle);
  const price = money(item.price);
  const sku = clean(item.sku);
  const out = [];

  if (logo) {
    const x = settings.logoAlign === 'center' ? Math.round((L.W - logo.width) / 2) : L.m;
    out.push(`^FO${x},${L.m}^XG${LOGO_NAME},1,1^FS`);
  }

  // Title + variant, centred between the logo and the bottom row.
  const showTitle = settings.showProductTitle !== false && title;
  const block = [];
  if (showTitle) block.push([title, L.titleF]);
  if (variant) block.push([variant, showTitle ? L.variantF : L.variantSoloF]);
  const blockH = block.reduce((h, [, f]) => h + f, 0) + Math.max(0, block.length - 1) * L.lineGap;
  const top = L.m + (logo ? logo.height + L.gap : 0);
  const bottom = L.H - L.m - L.priceF - L.gap;
  let y = top + Math.max(0, Math.round((bottom - top - blockH) / 2));
  for (const [text, f] of block) {
    out.push(textField(L.m, y, f, L.innerW, text, 'L'));
    y += f + L.lineGap;
  }

  // Bottom row: price right (big), SKU left. Shrink the price before cutting the SKU.
  const gap = L.lineGap * 2;
  let priceF = L.priceF;
  const skuNeed = sku ? Math.ceil(textWidth(sku, L.skuF)) + gap : 0;
  const priceNeed = (f) => Math.ceil(textWidth(price, f)) + 4;
  while (priceF > L.priceF * 0.6 && priceNeed(priceF) + skuNeed > L.innerW) priceF--;
  const priceW = Math.min(L.innerW, priceNeed(priceF));
  out.push(textField(L.W - L.m - priceW, L.H - L.m - priceF, priceF, priceW, price, 'R'));
  if (sku) {
    const skuW = L.innerW - priceW - gap;
    if (skuW > L.skuF * 2) out.push(textField(L.m, L.H - L.m - L.skuF, L.skuF, skuW, sku, 'L'));
  }
  return out;
}

// ------------------------------------------------------------ butterfly tag
//
// Two-wing jewelry/barbell tag, fed across the roll:
//   ┌────────────┐            ┌────────────┐
//   │   $54.00   │────────────│ ║│║║│║│║║│ │
//   │  L / Navy  │   (strip)  │ RG-PL-NVY-L│
//   └────────────┘            └────────────┘
// Left wing: price + variant. Right wing: barcode + its digits when a
// scannable barcode fits in the wing, otherwise the SKU in large text.

function buildButterflyJob({ items, currencyCode }, dpi, s) {
  const money = moneyFormatter(currencyCode, s.locale);
  const W = Math.round(s.widthIn * dpi);
  const H = Math.round(s.heightIn * dpi);
  const m = Math.round(s.marginIn * dpi);
  // The die-cut tag may be a touch wider than the print head: tag x = print x + off.
  const T = s.tagWidthIn || s.widthIn;
  const off = (T - s.widthIn) / 2;
  const dots = (inches) => Math.round(inches * dpi);
  const wing = (t0, t1) => {
    const x0 = Math.max(m, dots(t0 - off) + m);
    const x1 = Math.min(W - m, dots(t1 - off) - m);
    return { x0, x1, w: x1 - x0 };
  };
  const wingL = wing(0, s.wingIn);
  const wingR = wing(T - s.wingIn, T);
  const innerH = H - 2 * m;

  let out = '';
  for (const item of items) {
    const qty = Math.max(0, Math.min(999, Math.floor(Number(item.quantity) || 0)));
    if (!qty) continue;
    const body = [];
    const price = money(item.price);
    const variant = cleanVariant(item.variantTitle);
    const sku = clean(item.sku);

    // Left wing: price big, variant under it, centred vertically.
    let priceF = Math.round(innerH * (variant ? 0.56 : 0.75));
    while (priceF > 14 && textWidth(price, priceF) > wingL.w) priceF--;
    const varF = Math.round(innerH * 0.32);
    const blockH = priceF + (variant ? varF + 2 : 0);
    let y = m + Math.max(0, Math.round((innerH - blockH) / 2));
    body.push(textField(wingL.x0, y, priceF, wingL.w, price, 'C'));
    if (variant) body.push(textField(wingL.x0, y + priceF + 2, varF, wingL.w, variant, 'C'));

    // Right wing: barcode if it fits at a scannable size, else SKU text.
    const sym = chooseBarcode({ barcode: item.barcode, sku });
    let humanF = Math.round(innerH * 0.26);
    if (sym) while (humanF > 10 && textWidth(sym.value, humanF) > wingR.w) humanF--;
    let mw = 0;
    if (sym) {
      // Wings are only ~3/4" wide: on a 203 dpi head a UPC needs 1-dot bars
      // (about 0.5" wide). Tight, but reads on imager-type scanners.
      const minMw = 1;
      const maxMw = dpi >= 300 ? 3 : 2;
      for (let k = maxMw; k >= minMw; k--) {
        if (sym.modules * k + 6 * k <= wingR.w) { mw = k; break; } // ~3-module quiet zone each side
      }
    }
    if (sym && mw) {
      const barH = innerH - humanF - 2;
      const x = wingR.x0 + Math.round((wingR.w - sym.modules * mw) / 2);
      body.push(barcodeZpl(sym, x, m, mw, barH, escapeZpl));
      body.push(textField(wingR.x0, m + barH + 2, humanF, wingR.w, sym.value, 'C'));
    } else {
      const text = sku || clean(item.barcode);
      let f = Math.round(innerH * 0.42);
      while (f > 12 && textWidth(text, f) > wingR.w) f--;
      body.push(textField(wingR.x0, m + Math.round((innerH - f) / 2), f, wingR.w, text, 'C'));
    }

    out += ['^XA', '^CI28', `^PW${W}`, `^LL${H}`, '^LH0,0', ...body, `^PQ${qty},0,1,Y`, '^XZ'].join('') + '\n';
  }
  return out;
}

// -------------------------------------------------------------------- layout

/** All geometry in printer dots. */
export function layout(dpi, s) {
  const W = Math.round(s.widthIn * dpi);
  const H = Math.round(s.heightIn * dpi);
  const m = Math.round(s.marginIn * dpi);
  const innerW = W - 2 * m;
  const innerH = H - 2 * m;
  // Text scales with label height, but no further than the width can carry.
  const base = Math.min(innerH, Math.round(innerW * 0.5));
  const r = (f) => Math.max(12, Math.round(base * f));
  const gap = Math.round(base * 0.04);
  const common = { W, H, m, innerW, innerH, gap, lineGap: Math.max(2, Math.round(base * 0.02)) };

  if (s.barcodes) {
    const topH = r(0.26);
    return {
      ...common,
      topH,
      logoH: s.logoPath ? topH : 0,
      logoBoxW: Math.round(innerW * 0.55),
      titleF: r(0.12),
      variantF: r(0.13),
      skuF: r(0.11),
      humanF: r(0.1),
      minBarH: Math.round(0.3 * dpi), // below this, drop the product name for a taller barcode
      maxBarH: Math.round(0.6 * dpi),
    };
  }
  return {
    ...common,
    logoH: s.logoPath ? Math.round(innerH * 0.3) : 0,
    logoBoxW: Math.round(innerW * s.logoMaxWidth),
    titleF: r(0.15),
    variantF: r(0.14),
    variantSoloF: r(0.18),
    priceF: r(0.27),
    skuF: r(0.12),
  };
}

// ---------------------------------------------------------------------- text

function textField(x, y, fontH, width, text, justify) {
  const fitted = truncate(text, fontH, width);
  return `^FO${x},${y}^A0N,${fontH},${fontH}^FB${width},1,0,${justify}^FH^FD${escapeZpl(fitted)}^FS`;
}

// Font 0 is proportional; estimate widths conservatively so ^FB never wraps
// (a 1-line ^FB overprints the last line instead of clipping).
function charWidth(ch) {
  if (ch === ' ') return 0.3;
  if (/[0-9]/.test(ch)) return 0.6;
  if (/[A-Z]/.test(ch)) return 0.66;
  if (/[ilj.,:;'|!]/.test(ch)) return 0.28;
  if (/[a-z]/.test(ch)) return 0.55;
  return 0.65;
}

export function textWidth(text, fontH) {
  let w = 0;
  for (const ch of text) w += charWidth(ch) * fontH;
  return w;
}

function truncate(text, fontH, maxW) {
  if (textWidth(text, fontH) <= maxW) return text;
  const chars = [...text];
  while (chars.length && textWidth(chars.join('') + '...', fontH) > maxW) chars.pop();
  return chars.join('').trimEnd() + '...';
}

/** With ^FH, "_" starts a hex escape, so escape it and ZPL control chars. */
export function escapeZpl(s) {
  return s.replace(/_/g, '_5F').replace(/\^/g, '_5E').replace(/~/g, '_7E');
}

function clean(v) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanVariant(v) {
  const s = clean(v);
  return s === 'Default Title' ? '' : s;
}

function moneyFormatter(currencyCode, locale) {
  const currency = /^[A-Z]{3}$/.test(currencyCode || '') ? currencyCode : 'USD';
  const fmt = new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency });
  return (amount) => {
    const n = Number(amount);
    return Number.isFinite(n) ? fmt.format(n) : clean(amount);
  };
}
