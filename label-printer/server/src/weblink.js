// Zebra Weblink printer hub.
//
// How Weblink works (Zebra app note "Weblink / WebSocket Endpoint Configuration"):
//   1. The printer dials OUT to weblink.ip.conn1.location over TLS and opens the
//      MAIN channel (subprotocol v1.weblink.zebra.com). It sends a discovery
//      packet: {"discovery_b64": "..."}. Alerts also arrive on this channel.
//   2. The server asks for a RAW channel by sending {"open":"v1.raw.zebra.com"}
//      on the main channel.
//   3. The printer opens a brand-new connection to the SAME URL with subprotocol
//      v1.raw.zebra.com and first sends {"unique_id","channel_name","channel_id"}.
//   4. Anything written to the raw channel behaves like TCP port 9100: ZPL, SGD.
// Every frame we send must be binary.
//
// Each printer gets its own secret URL path (/weblink/<token>). Because the raw
// channel reconnects to the same URL, the token is how we pair raw <-> main and
// how we stop unknown devices from registering.

import { acceptUpgrade, rejectUpgrade } from './websocket.js';

const PROTO_MAIN = 'v1.weblink.zebra.com';
const PROTO_RAW = 'v1.raw.zebra.com';
const PROTO_CONFIG = 'v1.config.zebra.com';

// Alerts we ask the printer to push on the main channel (^SX / alerts.add syntax).
const WATCHED_ALERTS = ['PAPER OUT', 'RIBBON OUT', 'HEAD OPEN', 'PRINTER PAUSED'];

const RAW_OPEN_TIMEOUT_MS = 10_000;
const GETVAR_TIMEOUT_MS = 4_000;
const STALE_AFTER_MS = 150_000; // printer pings every ~60 s

export class PrinterHub {
  /**
   * @param {{ printers: {name: string, token: string}[], defaultDpi: number, log?: Function }} opts
   */
  constructor({ printers, defaultDpi, log = console.log }) {
    this.log = log;
    this.defaultDpi = defaultDpi;
    this.byToken = new Map();
    for (const p of printers) {
      this.byToken.set(p.token, {
        name: p.name,
        token: p.token,
        main: null,
        raw: null,
        uniqueId: null,
        dpi: null,
        conditions: new Set(),
        connectedAt: null,
        lastSeen: null,
        rawWaiters: [], // resolve fns waiting for a raw channel
        rawReader: null, // active getvar collector
        queue: Promise.resolve(), // serialises jobs per printer
      });
    }
    this._sweeper = setInterval(() => this._sweep(), 30_000);
    this._sweeper.unref?.();
  }

  /** Called from the HTTP server's 'upgrade' event. Returns true if handled. */
  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/weblink\/([A-Za-z0-9_-]{16,128})\/?$/);
    if (!m) return false;

    const printer = this.byToken.get(m[1]);
    if (!printer) {
      rejectUpgrade(socket, 404, 'Unknown printer');
      return true;
    }
    const conn = acceptUpgrade(req, socket, head, {
      protocols: [PROTO_MAIN, PROTO_RAW, PROTO_CONFIG],
    });
    if (!conn) return true;

    if (conn.protocol === PROTO_RAW) this._attachRaw(printer, conn);
    else if (conn.protocol === PROTO_CONFIG) conn.close(1000, 'Config channel not used');
    else this._classify(printer, conn);
    return true;
  }

  // Real printers (e.g. ZD411, Link-OS 7) open every channel with the
  // v1.weblink.zebra.com subprotocol, so tell main from raw by the first
  // message: main sends {"discovery_b64":...}, raw sends
  // {"unique_id","channel_name":"v1.raw.zebra.com",...}.
  _classify(p, conn) {
    let done = false;
    const route = (buf) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.off('message', route);
      const ch = String(safeJson(buf)?.channel_name || '');
      if (ch.includes('raw')) this._attachRaw(p, conn);
      else if (ch.includes('config')) return conn.close(1000, 'Config channel not used');
      else this._attachMain(p, conn);
      if (buf) conn.emit('message', buf); // replay the first message to the real handler
    };
    const timer = setTimeout(() => route(null), 10_000);
    timer.unref?.();
    conn.on('message', route);
    conn.on('close', () => clearTimeout(timer));
  }

  list() {
    return [...this.byToken.values()].map((p) => this.status(p));
  }

  status(p) {
    return {
      name: p.name,
      online: Boolean(p.main?.open),
      rawReady: Boolean(p.raw?.open && p.raw.ready),
      serial: p.uniqueId,
      dpi: p.dpi || null,
      problems: [...p.conditions],
      connectedAt: p.connectedAt,
      lastSeen: p.lastSeen,
    };
  }

  find(name) {
    const all = [...this.byToken.values()];
    if (!name) return all.find((p) => p.main?.open) || all[0] || null;
    return all.find((p) => p.name === name) || null;
  }

  /** Effective DPI: what the printer reported, else the configured fallback. */
  dpiFor(p) {
    return p.dpi || this.defaultDpi;
  }

  /**
   * Send a print job. Jobs to one printer are serialised so two iPads
   * printing at once don't interleave ZPL.
   * @param {object} p printer record from find()
   * @param {(dpi:number) => Buffer|string} buildJob builds ZPL for the printer's DPI
   */
  print(p, buildJob) {
    const run = async () => {
      if (!p.main?.open) throw new PrinterError('offline', `${p.name} is not connected.`);
      const raw = await this._ensureRaw(p);
      const blocking = [...p.conditions].filter((c) => c !== 'PRINTER PAUSED');
      if (blocking.length) {
        throw new PrinterError('problem', `${p.name} reports: ${blocking.join(', ').toLowerCase()}.`);
      }
      const job = buildJob(this.dpiFor(p));
      raw.send(job);
      return { bytes: Buffer.byteLength(job), paused: p.conditions.has('PRINTER PAUSED') };
    };
    const result = p.queue.then(run, run);
    p.queue = result.catch(() => {});
    return result;
  }

  // ---------------------------------------------------------------- main

  _attachMain(p, conn) {
    if (p.main && p.main !== conn) p.main.close(1000, 'Replaced by new connection');
    p.main = conn;
    p.connectedAt = new Date().toISOString();
    p.lastSeen = p.connectedAt;
    p.conditions.clear();
    this.log(`[weblink] ${p.name}: main channel connected from ${conn.remote}`);

    conn.on('message', (buf) => {
      p.lastSeen = new Date().toISOString();
      const msg = safeJson(buf);
      if (!msg) return;
      if (msg.alert) this._onAlert(p, msg.alert);
      else if (msg.discovery_b64) this.log(`[weblink] ${p.name}: discovery packet received`);
    });
    conn.on('ping', () => (p.lastSeen = new Date().toISOString()));
    conn.on('close', (code) => {
      this.log(`[weblink] ${p.name}: main channel closed (${code})`);
      if (p.main === conn) p.main = null;
      if (p.raw) p.raw.close(1000, 'Main channel closed');
    });

    // Push the alerts we care about, one request each, then open the raw channel.
    for (const a of WATCHED_ALERTS) {
      conn.sendJson({ configure_alert: `${a},SDK,Y,Y,,,N` });
    }
    this._requestRaw(p);
  }

  _onAlert(p, alert) {
    const id = String(alert.condition_id || alert.condition || '').toUpperCase();
    if (!id) return;
    if (String(alert.condition_state).toUpperCase() === 'CLEAR') p.conditions.delete(id);
    else p.conditions.add(id);
    this.log(`[weblink] ${p.name}: alert ${id} ${alert.condition_state}`);
  }

  // ----------------------------------------------------------------- raw

  _requestRaw(p) {
    if (p.main?.open) p.main.sendJson({ open: PROTO_RAW });
  }

  _ensureRaw(p) {
    if (p.raw?.open && p.raw.ready) return Promise.resolve(p.raw);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        p.rawWaiters = p.rawWaiters.filter((w) => w !== waiter);
        reject(new PrinterError('timeout', `${p.name} did not open a print channel in time.`));
      }, RAW_OPEN_TIMEOUT_MS);
      const waiter = (raw) => {
        clearTimeout(timer);
        resolve(raw);
      };
      p.rawWaiters.push(waiter);
      this._requestRaw(p);
    });
  }

  _attachRaw(p, conn) {
    if (p.raw && p.raw !== conn) p.raw.close(1000, 'Replaced');
    p.raw = conn;
    let introduced = false;

    conn.on('message', (buf) => {
      p.lastSeen = new Date().toISOString();
      if (!introduced) {
        // First message is the channel description JSON.
        const intro = safeJson(buf);
        if (intro?.unique_id) {
          introduced = true;
          p.uniqueId = intro.unique_id;
          this.log(`[weblink] ${p.name}: raw channel ${intro.channel_id} open (serial ${intro.unique_id})`);
          this._onRawReady(p, conn);
          return;
        }
      }
      if (p.rawReader) p.rawReader(buf);
    });
    conn.on('close', () => {
      if (p.raw === conn) p.raw = null;
      // Re-open lazily on the next print, but keep one warm if main is still up.
      if (p.main?.open) setTimeout(() => !p.raw && this._requestRaw(p), 2_000).unref?.();
    });
  }

  async _onRawReady(p, conn) {
    if (!p.dpi) {
      const dpi = parseInt(await this._getvar(p, conn, 'head.resolution.in_dpi'), 10);
      if ([152, 203, 300, 600].includes(dpi)) {
        p.dpi = dpi;
        this.log(`[weblink] ${p.name}: ${dpi} dpi`);
      } else {
        this.log(`[weblink] ${p.name}: could not read DPI, using ${this.defaultDpi}`);
      }
    }
    conn.ready = true;
    const waiters = p.rawWaiters;
    p.rawWaiters = [];
    for (const w of waiters) w(conn);
  }

  /** Read one SGD value over the raw channel. Resolves '' on timeout. */
  _getvar(p, conn, name) {
    return new Promise((resolve) => {
      let acc = '';
      const done = (value) => {
        clearTimeout(timer);
        p.rawReader = null;
        resolve(value);
      };
      const timer = setTimeout(() => done(''), GETVAR_TIMEOUT_MS);
      p.rawReader = (buf) => {
        acc += buf.toString('utf8');
        const m = acc.match(/"([^"]*)"/);
        if (m) done(m[1]);
      };
      conn.send(`! U1 getvar "${name}"\r\n`);
    });
  }

  _sweep() {
    const now = Date.now();
    for (const p of this.byToken.values()) {
      for (const c of [p.main, p.raw]) {
        if (!c?.open) continue;
        if (now - c.lastSeen > STALE_AFTER_MS) {
          this.log(`[weblink] ${p.name}: connection stale, dropping`);
          c.terminate();
        } else {
          c.ping();
        }
      }
    }
  }
}

export class PrinterError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function safeJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}
