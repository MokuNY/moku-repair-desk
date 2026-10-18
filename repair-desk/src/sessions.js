// Staff sign-in sessions for the shared iPad.
//
// A session is a signed cookie: shopId.staffId.expiry.signature (HMAC-SHA256).
// HttpOnly, Secure, SameSite=Strict, 12 hours. Wrong PINs lock that staff
// member out for 5 minutes after 5 tries.

import crypto from 'node:crypto';

const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TRIES = 5;
const LOCK_MS = 5 * 60 * 1000;

export function sessionManager(secret, { now = Date.now, secure = true } = {}) {
  if (!secret || secret.length < 32) throw new RangeError('SESSION_SECRET must be at least 32 characters');
  const sign = (s) => crypto.createHmac('sha256', secret).update(s).digest('base64url');
  const tries = new Map(); // `${shopId}:${staffId}` -> { count, until }

  return {
    cookie(shopId, staffId) {
      const body = `${shopId}.${staffId}.${now() + TTL_MS}`;
      return `rd_session=${body}.${sign(body)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`;
    },
    clearCookie() {
      return `rd_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
    },
    /** @returns {{shopId:number, staffId:number}|null} */
    read(cookieHeader) {
      const m = /(?:^|;\s*)rd_session=([^;]+)/.exec(cookieHeader || '');
      if (!m) return null;
      const parts = m[1].split('.');
      if (parts.length !== 4) return null;
      const body = parts.slice(0, 3).join('.');
      const want = Buffer.from(sign(body));
      const got = Buffer.from(parts[3]);
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
      const [shopId, staffId, exp] = parts.slice(0, 3).map(Number);
      if (!(exp > now())) return null;
      return { shopId, staffId };
    },
    /** Call before checking a PIN. Throws when locked. */
    checkLock(shopId, staffId) {
      const t = tries.get(`${shopId}:${staffId}`);
      if (t?.until && t.until > now()) {
        const mins = Math.ceil((t.until - now()) / 60000);
        throw Object.assign(new Error(`Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`), { status: 429 });
      }
    },
    recordAttempt(shopId, staffId, ok) {
      const k = `${shopId}:${staffId}`;
      if (ok) return tries.delete(k);
      const t = tries.get(k) || { count: 0, until: 0 };
      t.count++;
      if (t.count >= MAX_TRIES) { t.until = now() + LOCK_MS; t.count = 0; }
      tries.set(k, t);
    },
  };
}
