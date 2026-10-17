// Verify the Shopify ID token (session token) that admin UI extensions and
// App Bridge attach as "Authorization: Bearer <jwt>". It is an HS256 JWT signed
// with the app's client secret, with aud = the app's client id.

import crypto from 'node:crypto';

const LEEWAY_S = 10;

/**
 * @returns {{ shop: string, userId: string|null }}
 * @throws {AuthError}
 */
export function verifySessionToken(header, { apiKey, apiSecret, allowedShops }) {
  const m = /^Bearer\s+(.+)$/i.exec(header || '');
  if (!m) throw new AuthError('Missing session token');
  const parts = m[1].split('.');
  if (parts.length !== 3) throw new AuthError('Malformed session token');
  const [h, p, sig] = parts;

  const head = parseB64Json(h);
  if (head?.alg !== 'HS256') throw new AuthError('Unexpected token algorithm');

  const expected = crypto.createHmac('sha256', apiSecret).update(`${h}.${p}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new AuthError('Bad token signature');
  }

  const claims = parseB64Json(p);
  const now = Math.floor(Date.now() / 1000);
  if (!claims) throw new AuthError('Unreadable token');
  if (claims.exp && now > claims.exp + LEEWAY_S) throw new AuthError('Token expired');
  if (claims.nbf && now < claims.nbf - LEEWAY_S) throw new AuthError('Token not yet valid');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(apiKey)) throw new AuthError('Token is for another app');

  let shop;
  try {
    shop = new URL(claims.dest).hostname;
  } catch {
    throw new AuthError('Token has no shop');
  }
  if (allowedShops.length && !allowedShops.includes(shop)) {
    throw new AuthError(`Shop ${shop} is not allowed`);
  }
  return { shop, userId: claims.sub || null };
}

export class AuthError extends Error {}

function parseB64Json(s) {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
