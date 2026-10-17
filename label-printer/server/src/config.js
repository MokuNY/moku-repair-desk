// All configuration comes from environment variables (see .env.example).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

/** PRINTERS="Front counter=<token>;Back room=<token>" */
function parsePrinters(spec) {
  return String(spec || '')
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.lastIndexOf('=');
      const name = entry.slice(0, i).trim();
      const token = entry.slice(i + 1).trim();
      if (i < 1 || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
        throw new Error(`PRINTERS entry "${entry}" must look like "Name=<token of 16+ letters/digits>"`);
      }
      return { name, token };
    });
}

export const config = {
  port: num(env.PORT, 3000),
  publicUrl: (env.PUBLIC_URL || env.SHOPIFY_APP_URL || '').replace(/\/$/, ''),
  apiKey: env.SHOPIFY_API_KEY || '',
  apiSecret: env.SHOPIFY_API_SECRET || '',
  allowedShops: String(env.ALLOWED_SHOPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  printers: parsePrinters(env.PRINTERS),
  defaultDpi: num(env.PRINTER_DPI, 203),
  maxLabelsPerJob: num(env.MAX_LABELS_PER_JOB, 1000),
  // Shared secret the Repair Desk uses to request repair labels. Empty = the
  // /api/repair-label route is switched off (it is, until approval point A4).
  repairDeskToken: env.REPAIR_DESK_TOKEN || '',
  tls: env.TLS_CERT_FILE && env.TLS_KEY_FILE ? { cert: env.TLS_CERT_FILE, key: env.TLS_KEY_FILE } : null,
  label: {
    widthIn: num(env.LABEL_WIDTH_IN, 2),
    heightIn: num(env.LABEL_HEIGHT_IN, 1),
    marginIn: num(env.LABEL_MARGIN_IN, 0.06),
    // "auto" (default): show the product name when there's room for it.
    showProductTitle: /^(0|false|no|off)$/i.test(env.SHOW_PRODUCT_TITLE || '') ? false : true,
    barcodes: bool(env.BARCODES, true),
    locale: env.PRICE_LOCALE || 'en-US',
    logoPath: env.LOGO_PATH === '' ? null : path.resolve(here, '..', env.LOGO_PATH || 'assets/logo.png'),
    logoMaxWidth: num(env.LOGO_MAX_WIDTH, 0.7), // fraction of printable width
    logoAlign: env.LOGO_ALIGN === 'center' ? 'center' : 'left',
    logoThreshold: num(env.LOGO_THRESHOLD, 128),
    logoDither: bool(env.LOGO_DITHER, false),
  },
};

// Label types offered in the Print labels window. "standard" uses the
// LABEL_* settings above; "butterfly" is a two-wing jewelry/barbell tag.
config.labels = {
  standard: {
    ...config.label,
    type: 'standard',
    name: env.LABEL_NAME || `Price label (${fmtIn(config.label.widthIn)} × ${fmtIn(config.label.heightIn)})`,
  },
  butterfly: {
    ...config.label,
    type: 'butterfly',
    name: env.BUTTERFLY_NAME || 'Butterfly tag (2¼ × ½)',
    widthIn: num(env.BUTTERFLY_WIDTH_IN, 2.2), // printable width across the roll
    heightIn: num(env.BUTTERFLY_HEIGHT_IN, 0.5),
    tagWidthIn: num(env.BUTTERFLY_TAG_WIDTH_IN, 2.25), // die-cut tag width, centred under the head
    wingIn: num(env.BUTTERFLY_WING_IN, 0.875), // each printable wing
    marginIn: num(env.BUTTERFLY_MARGIN_IN, 0.04),
  },
};
if (!bool(env.BUTTERFLY_ENABLED, true)) delete config.labels.butterfly;

function fmtIn(v) {
  const whole = Math.floor(v);
  const frac = { 0.25: '¼', 0.5: '½', 0.75: '¾' }[Math.round((v - whole) * 100) / 100] || '';
  return frac ? `${whole || ''}${frac}"` : `${v}"`;
}

export function checkConfig() {
  const problems = [];
  if (!config.apiKey) problems.push('SHOPIFY_API_KEY is not set');
  if (!config.apiSecret) problems.push('SHOPIFY_API_SECRET is not set');
  if (!config.printers.length) problems.push('PRINTERS is not set — no printer can connect');
  if (config.label.widthIn > 2.25) problems.push('LABEL_WIDTH_IN is wider than a ZD411 can print (about 2.2")');
  return problems;
}
