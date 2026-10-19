// Repair Desk web server: the iPad app and its JSON API. Node built-ins only.
//
// One shop per deployment (MOKU NY now; Hawaii would be its own deployment
// with its own database). Settings come from the environment:
//
//   DATABASE_PATH       SQLite file on the Fly volume, e.g. /data/repair-desk.sqlite
//   SHOP_DOMAIN         moku-repair-test.myshopify.com (test) / moku-surf-shop-ny.myshopify.com
//   PUBLIC_URL          https://repair-desk-test.fly.dev (used in label QR codes)
//   SESSION_SECRET      32+ random characters
//   SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET   Dev Dashboard app; unset = demo customers
//   LABEL_SERVER_URL / REPAIR_DESK_TOKEN        label server; unset = printing off
//   DEMO=1              allow demo customers (never with real Shopify credentials)

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { openDb } from './db.js';
import { getShopByDomain, getShop, PermissionError } from './shops.js';
import { listStaff, getStaff, checkPin, setPin } from './staff.js';
import { createTicket, changeStatus, handOver, ticketView, listOpenTickets, getTicketByJobNumber, STATUS_LABELS } from './tickets.js';
import { money, setPrices, recordPayment, logCall } from './pricing.js';
import { requestLabel, sendLabel, labelServerClient } from './labels.js';
import { searchArchive } from './records.js';
import { toCents } from './money.js';
import { normalizeUsPhone, formatUsPhone } from './phone.js';
import { ShopifyClient, ShopifyError } from './shopify.js';
import { sessionManager } from './sessions.js';
import { verifyPosToken, staffForPosMember, unlinkedStaff, linkPosMember, PosAuthError } from './pos-auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML = fs.readFileSync(path.join(here, 'app.html'), 'utf8');
// Brand images, loaded once. Only these names are served.
const ASSETS = Object.fromEntries(
  ['moku-wordmark.png', 'moku-bolt.png', 'apple-touch-icon.png', 'favicon.png', 'paladins-expanded.ttf'].map((f) => [f, fs.readFileSync(path.join(here, 'assets', f))]),
);
const MAX_BODY = 64 * 1024;

/**
 * Build the request handler. Everything it needs is passed in, so tests can
 * run it against an in-memory database, a fake Shopify and a fake printer.
 */
export function createApp({ db, shopId, sessions, customers, printer = null, baseUrl, timezone = 'America/New_York', pos = null }) {
  const shop = getShop(db, shopId);
  if (!shop) throw new RangeError('Shop not set up in this database');

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || /^\/t\/[A-Za-z0-9-]{4,20}$/.test(p) || p === '/app')) return page(res);
    if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true });
    const asset = req.method === 'GET' && /^\/assets\/([a-z-]+\.(?:png|ttf))$/.exec(p);
    if (asset && ASSETS[asset[1]]) {
      res.writeHead(200, { 'Content-Type': asset[1].endsWith('.ttf') ? 'font/ttf' : 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return res.end(ASSETS[asset[1]]);
    }
    if (!p.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

    // The POS extension calls from Shopify's CDN with a bearer token (never a
    // cookie), so cross-origin requests are allowed for bearer-token calls only.
    const bearer = /^Bearer\s/i.test(req.headers.authorization || '');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Pos-Staff-Member',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
    if (bearer) res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'POST') {
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Send JSON' });
      // Cookie requests must come from this site (SameSite=Strict is the first lock).
      const origin = req.headers.origin;
      if (!bearer && origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Wrong origin' });
    }
    const body = req.method === 'POST' ? await readJson(req) : {};

    // ---------------------------------------------------------- sign-in
    if (req.method === 'GET' && p === '/api/staff') {
      return json(res, 200, { shop: shop.name, staff: listStaff(db, shopId).filter((s) => s.active === 1).map((s) => ({ id: s.id, name: s.name, hasPin: Boolean(s.pin_hash) })) });
    }
    if (req.method === 'POST' && p === '/api/signin') {
      const staff = getStaff(db, shopId, Number(body.staffId));
      if (!staff || staff.active !== 1) return json(res, 400, { error: 'Pick your name' });
      sessions.checkLock(shopId, staff.id);
      if (!staff.pin_hash) {
        // First sign-in: choose a PIN (entered twice on the iPad).
        if (!/^\d{4,6}$/.test(String(body.newPin || ''))) return json(res, 400, { error: 'Choose a 4–6 digit PIN', needsPin: true });
        setPin(db, shopId, staff, staff.id, String(body.newPin));
      } else {
        const ok = checkPin(String(body.pin || ''), staff.pin_hash);
        sessions.recordAttempt(shopId, staff.id, ok);
        if (!ok) return json(res, 401, { error: 'Wrong PIN' });
      }
      res.setHeader('Set-Cookie', sessions.cookie(shopId, staff.id));
      return json(res, 200, { me: meOf(staff) });
    }
    if (req.method === 'POST' && p === '/api/signout') {
      res.setHeader('Set-Cookie', sessions.clearCookie());
      return json(res, 200, { ok: true });
    }

    // ------------------------------------------------- signed in from here
    let me = null;
    if (bearer) {
      // Shopify POS: the token proves the shop; the pinned-in staff member says who.
      if (!pos) return json(res, 401, { error: 'POS sign-in is not set up on this server' });
      try {
        verifyPosToken(req.headers.authorization, { clientId: pos.clientId, clientSecret: pos.clientSecret, shopDomain: shop.shopify_domain });
      } catch (err) {
        if (err instanceof PosAuthError) return json(res, 401, { error: err.message });
        throw err;
      }
      const member = req.headers['x-pos-staff-member'];
      if (req.method === 'POST' && p === '/api/pos/link') {
        const linked = linkPosMember(db, shopId, member, body.staffId);
        return json(res, 200, { me: meOf(linked) });
      }
      me = staffForPosMember(db, shopId, member);
      if (!me) return json(res, 409, { needsLink: true, staff: unlinkedStaff(db, shopId), error: 'Pick your name once to link your POS account' });
    } else {
      const s = sessions.read(req.headers.cookie);
      me = s && s.shopId === shopId ? getStaff(db, shopId, s.staffId) : null;
    }
    if (!me || me.active !== 1) return json(res, 401, { error: 'Sign in' });

    if (req.method === 'GET' && p === '/api/me') {
      const variant = getShop(db, shopId).ding_repair_variant_gid;
      return json(res, 200, {
        me: meOf(me), shop: shop.name, printing: Boolean(printer), demo: customers.demo === true,
        dingRepairVariantId: variant ? variant.replace(/^gid:\/\/shopify\/ProductVariant\//, '') : null,
      });
    }

    if (req.method === 'GET' && p === '/api/board') {
      const rows = listOpenTickets(db, shopId).map((t) => summary(t));
      return json(res, 200, { tickets: rows });
    }

    if (req.method === 'GET' && p === '/api/find') {
      const q = String(url.searchParams.get('q') || '').trim();
      return json(res, 200, { open: findOpen(q), archive: q.length >= 2 ? searchArchive(db, shopId, me, q, { limit: 15 }).map(archiveRow) : [] });
    }

    if (req.method === 'GET' && p === '/api/customers') {
      return json(res, 200, { customers: await customers.searchCustomers(String(url.searchParams.get('q') || '')) });
    }
    if (req.method === 'POST' && p === '/api/customers') {
      return json(res, 200, { customer: await customers.createCustomer({ firstName: body.firstName, lastName: body.lastName, phone: body.phone }) });
    }

    if (req.method === 'POST' && p === '/api/tickets') {
      const { ticket, created } = createTicket(db, shopId, me, {
        requestId: body.requestId, customer: body.customer, boardDescription: body.board, repairRequested: body.repair, notes: body.notes,
      });
      const label = created ? await printLabel(me, ticket.id, 'intake') : null;
      return json(res, 200, { jobNumber: ticket.job_number, created, label });
    }

    const m = /^\/api\/tickets\/([A-Za-z0-9-]{4,20})(?:\/([a-z]+))?$/.exec(p);
    if (m) {
      const t = getTicketByJobNumber(db, shopId, m[1]);
      if (!t) {
        const old = searchArchive(db, shopId, me, m[1], { limit: 1 }).find((a) => a.job_number === m[1].toUpperCase());
        return old ? json(res, 200, { archived: archiveRow(old) }) : json(res, 404, { error: `No job ${m[1].toUpperCase()}` });
      }
      const action = m[2];
      if (req.method === 'GET' && !action) return json(res, 200, { ticket: detail(t.id) });
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
      if (action === 'status') {
        if (body.to === 'completed') handOver(db, shopId, me, t.id);
        else changeStatus(db, shopId, me, t.id, body.to, { note: body.note });
        if (body.call) logCall(db, shopId, me, t.id, { outcome: body.call, note: body.note || '' });
      } else if (action === 'price') {
        const changes = {};
        if ('partnerCharge' in body) changes.partnerChargeCents = dollarsOrNull(body.partnerCharge);
        if ('shopFee' in body) changes.shopFeeCents = toCents(body.shopFee);
        if ('agreedPrice' in body) changes.agreedPriceCents = dollarsOrNull(body.agreedPrice);
        setPrices(db, shopId, me, t.id, changes);
      } else if (action === 'call') {
        logCall(db, shopId, me, t.id, { outcome: body.outcome, note: body.note || '' });
      } else if (action === 'payment') {
        recordPayment(db, shopId, me, t.id, { amountCents: toCents(body.amount), method: body.method || 'cash', note: body.note || '' });
      } else if (action === 'reprint') {
        return json(res, 200, { label: await printLabel(me, t.id, 'reprint'), ticket: detail(t.id) });
      } else return json(res, 404, { error: 'Not found' });
      return json(res, 200, { ticket: detail(t.id) });
    }

    return json(res, 404, { error: 'Not found' });
  }

  // ---------------------------------------------------------- helpers

  async function printLabel(me, ticketId, kind) {
    if (!printer) return { status: 'off' };
    const lp = requestLabel(db, shopId, me, ticketId, { kind });
    const done = await sendLabel(db, shopId, lp.id, printer, { baseUrl, timezone });
    return { status: done.status, error: done.last_error || undefined, warning: done.warning };
  }

  function summary(t) {
    const mny = money(db, shopId, t.id);
    return {
      jobNumber: t.job_number, customer: t.customer_name, phone: formatUsPhone(t.customer_phone), board: t.board_description,
      repair: t.repair_requested, status: t.status, statusLabel: STATUS_LABELS[t.status], receivedAt: t.received_at,
      price: mny.price, balance: mny.balance, payment: mny.status, needsReview: t.needs_review === 1,
    };
  }

  function detail(ticketId) {
    const v = ticketView(db, shopId, ticketId);
    const names = new Map(listStaff(db, shopId).map((s) => [s.id, s.name]));
    const calls = db.prepare('SELECT * FROM call_logs WHERE shop_id = ? AND ticket_id = ? ORDER BY id DESC').all(shopId, ticketId);
    const label = db.prepare('SELECT status, last_error, kind, updated_at FROM label_prints WHERE shop_id = ? AND ticket_id = ? ORDER BY id DESC LIMIT 1').get(shopId, ticketId) || null;
    return {
      jobNumber: v.ticket.job_number, status: v.ticket.status, statusLabel: v.statusLabel, board: v.ticket.board_description, repair: v.ticket.repair_requested,
      notes: v.ticket.notes, receivedAt: v.ticket.received_at, completedAt: v.ticket.completed_at, partner: v.partner?.name || 'Keith',
      acceptedBy: v.ticket.accepted_by_text || names.get(v.ticket.created_by), needsReview: v.ticket.needs_review === 1, reviewNote: v.ticket.review_note,
      customer: { name: v.customer.display_name, phone: formatUsPhone(v.customer.phone_e164), tel: v.customer.phone_e164 },
      money: money(db, shopId, ticketId),
      calls: calls.map((c) => ({ outcome: c.outcome, note: c.note, at: c.created_at, by: c.staff_id ? names.get(c.staff_id) : 'Imported' })),
      history: v.events.filter((e) => e.kind === 'status').map((e) => ({ to: STATUS_LABELS[e.to_status], at: e.created_at, by: e.staff_id ? names.get(e.staff_id) : 'Imported' })),
      label,
    };
  }

  function findOpen(q) {
    const term = q.toLowerCase();
    const phone = normalizeUsPhone(q);
    if (term.length < 2) return [];
    return listOpenTickets(db, shopId)
      .filter((t) => t.job_number.toLowerCase().includes(term) || (phone && t.customer_phone === phone) || t.customer_name.toLowerCase().includes(term) || t.board_description.toLowerCase().includes(term))
      .slice(0, 15)
      .map(summary);
  }

  const archiveRow = (a) => ({
    jobNumber: a.job_number, customer: a.customer_name, phone: a.phone_e164 ? formatUsPhone(a.phone_e164) : a.raw['Phone'], board: a.board, repair: a.repair,
    status: a.status, received: a.raw['Received date'], pickedUp: a.raw['Customer pickup'], price: a.raw['Customer price'], payment: a.raw['Customer payment'], notes: a.raw['Notes / accessories'],
  });

  const meOf = (s) => ({ id: s.id, name: s.name, owner: s.role === 'owner' });

  function page(res) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    res.end(APP_HTML);
  }

  return (req, res) =>
    handle(req, res).catch((err) => {
      const status = err.status || (err instanceof PermissionError ? 403 : err instanceof ShopifyError ? 502 : err instanceof RangeError ? 400 : 500);
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong. Try again.' : err.message });
    });
}

/** Customer lookup without Shopify (test and demo only): local customers table. */
export function demoCustomers(db, shopId) {
  return {
    demo: true,
    async searchCustomers(term) {
      const t = String(term || '').trim().toLowerCase();
      if (t.length < 2) return [];
      const phone = normalizeUsPhone(t);
      return db
        .prepare(`SELECT * FROM customers WHERE shop_id = ? AND (phone_e164 = ? OR lower(display_name) LIKE ?) ORDER BY display_name LIMIT 10`)
        .all(shopId, phone, `%${t}%`)
        .map((c) => ({ shopifyCustomerGid: c.shopify_customer_gid || `gid://demo/Customer/local-${c.id}`, displayName: c.display_name, firstName: c.first_name, lastName: c.last_name, phoneE164: c.phone_e164 }));
    },
    async createCustomer({ firstName, lastName, phone }) {
      const e164 = phone ? normalizeUsPhone(phone) : null;
      if (phone && !e164) throw new RangeError('That phone number is not a valid US number');
      if (!firstName && !lastName) throw new RangeError('A customer needs a first or last name');
      return { shopifyCustomerGid: `gid://demo/Customer/${crypto.randomUUID()}`, displayName: [firstName, lastName].filter(Boolean).join(' '), firstName: firstName || null, lastName: lastName || null, phoneE164: e164 };
    },
  };
}

function dollarsOrNull(v) {
  return v === null || v === '' || v === undefined ? null : toCents(v);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Too much data'), { status: 413 })); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ------------------------------------------------------------- main

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const db = openDb(env.DATABASE_PATH || path.resolve(here, '../data/repair-desk.sqlite'));
  const shop = getShopByDomain(db, env.SHOP_DOMAIN || 'moku-repair-test.myshopify.com');
  if (!shop) throw new Error(`Shop ${env.SHOP_DOMAIN} is not set up. Run scripts/seed-moku.js first.`);
  const shopifyReady = env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET;
  if (!shopifyReady && env.DEMO !== '1') throw new Error('Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, or DEMO=1 for demo customers.');
  const customers = shopifyReady
    ? new ShopifyClient({ shopDomain: shop.shopify_domain, clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET })
    : demoCustomers(db, shop.id);
  const printer = env.LABEL_SERVER_URL && env.REPAIR_DESK_TOKEN ? labelServerClient({ url: env.LABEL_SERVER_URL, token: env.REPAIR_DESK_TOKEN }) : null;
  const publicUrl = env.PUBLIC_URL || `http://localhost:${env.PORT || 8080}`;
  const sessions = sessionManager(env.SESSION_SECRET || (env.DEMO === '1' ? crypto.randomBytes(32).toString('hex') : ''), { secure: publicUrl.startsWith('https://') });
  const pos = shopifyReady ? { clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET } : null;
  const app = createApp({ db, shopId: shop.id, sessions, customers, printer, baseUrl: publicUrl, timezone: shop.timezone, pos });
  http.createServer(app).listen(Number(env.PORT || 8080), () => {
    console.log(`[repair-desk] ${shop.name} on :${env.PORT || 8080} · customers: ${shopifyReady ? 'Shopify' : 'demo'} · printing: ${printer ? 'on' : 'off'}`);
  });
}

