// Shopify Admin GraphQL client for the Repair Desk.
//
// Auth: client credentials grant (Dev Dashboard app installed on a store in
// the same Shopify organization). The app swaps its client ID + secret for an
// access token valid 24 hours; we cache it and refresh 5 minutes early.
// Docs: shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
//
// Retries: HTTP 429, HTTP 5xx and GraphQL THROTTLED errors back off and retry
// (max 4 attempts). Anything else fails at once with a ShopifyError.

import { normalizeUsPhone } from './phone.js';

export const DEFAULT_API_VERSION = '2026-10'; // current stable release, matches the Dev Dashboard app
const REFRESH_EARLY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 4;

export class ShopifyError extends Error {
  constructor(message, { status, code, userErrors } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.userErrors = userErrors;
  }
}

export class ShopifyClient {
  /**
   * @param {{ shopDomain: string, clientId: string, clientSecret: string,
   *           apiVersion?: string, fetch?: typeof fetch, sleep?: (ms:number)=>Promise<void>, now?: ()=>number }} opts
   */
  constructor({ shopDomain, clientId, clientSecret, apiVersion = DEFAULT_API_VERSION, fetch: f = fetch, sleep, now }) {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain || '')) throw new RangeError(`Bad shop domain: ${shopDomain}`);
    if (!clientId || !clientSecret) throw new RangeError('Shopify client ID and secret are required');
    this.shopDomain = shopDomain;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.apiVersion = apiVersion;
    this.fetch = f;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = now || Date.now;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.pendingToken = null;
  }

  async accessToken() {
    if (this.token && this.now() < this.tokenExpiresAt - REFRESH_EARLY_MS) return this.token;
    // One refresh at a time, even if several requests arrive together.
    this.pendingToken ??= this._fetchToken().finally(() => (this.pendingToken = null));
    return this.pendingToken;
  }

  async _fetchToken() {
    const res = await this._send(`https://${this.shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'client_credentials' }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new ShopifyError(`Could not get a Shopify access token (${res.status}${body.error ? `: ${body.error}` : ''})`, {
        status: res.status,
        code: body.error,
      });
    }
    this.token = body.access_token;
    this.tokenExpiresAt = this.now() + Number(body.expires_in || 86399) * 1000;
    return this.token;
  }

  /** Run a GraphQL operation. Returns `data`. */
  async graphql(query, variables = {}) {
    for (let attempt = 1; ; attempt++) {
      const token = await this.accessToken();
      const res = await this._send(`https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 401) {
        // Token revoked or expired early: drop it and try once more.
        this.token = null;
        if (attempt < 2) continue;
        throw new ShopifyError('Shopify rejected the access token', { status: 401 });
      }
      const retryable = res.status === 429 || res.status >= 500;
      const body = retryable ? null : await res.json().catch(() => null);
      const throttled = body?.errors?.some?.((e) => e?.extensions?.code === 'THROTTLED');
      if ((retryable || throttled) && attempt < MAX_ATTEMPTS) {
        const after = Number(res.headers?.get?.('retry-after'));
        await this.sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** (attempt - 1));
        continue;
      }
      if (retryable || throttled) throw new ShopifyError(`Shopify is busy (HTTP ${res.status}). Try again in a minute.`, { status: res.status, code: 'THROTTLED' });
      if (!res.ok) throw new ShopifyError(`Shopify request failed (HTTP ${res.status})`, { status: res.status });
      if (body?.errors?.length) throw new ShopifyError(`Shopify error: ${body.errors.map((e) => e.message).join('; ')}`, { status: res.status });
      return body.data;
    }
  }

  async _send(url, init) {
    try {
      return await this.fetch(url, init);
    } catch (err) {
      throw new ShopifyError(`Could not reach Shopify: ${err.message}`, { code: 'NETWORK' });
    }
  }

  // ------------------------------------------------------------- customers

  /**
   * Search customers by phone, email or name. Phone input is matched on the
   * normalized number so "516-532-7875" finds "+15165327875".
   */
  async searchCustomers(term, { limit = 10 } = {}) {
    const q = customerSearchQuery(term);
    if (!q) return [];
    const data = await this.graphql(SEARCH_CUSTOMERS, { q, first: limit });
    return data.customers.nodes.map(fromShopifyCustomer);
  }

  async createCustomer({ firstName, lastName, phone, email }) {
    const e164 = phone ? normalizeUsPhone(phone) : null;
    if (phone && !e164) throw new ShopifyError('That phone number is not a valid US number', { code: 'INVALID_PHONE' });
    const input = { firstName: firstName || undefined, lastName: lastName || undefined, phone: e164 || undefined, email: email || undefined };
    if (!input.firstName && !input.lastName) throw new ShopifyError('A customer needs at least a first or last name', { code: 'NAME_REQUIRED' });
    const data = await this.graphql(CREATE_CUSTOMER, { input });
    const { customer, userErrors } = data.customerCreate;
    if (userErrors?.length) {
      throw new ShopifyError(userErrors.map((e) => e.message).join('; '), { code: 'USER_ERROR', userErrors });
    }
    return fromShopifyCustomer(customer);
  }
}

/** Build Shopify's customer search syntax from what staff typed. */
export function customerSearchQuery(term) {
  const t = String(term ?? '').trim();
  if (t.length < 2) return '';
  const phone = normalizeUsPhone(t);
  if (phone) return `phone:${phone}`;
  if (/^[^\s@]+@[^\s@]+$/.test(t)) return `email:${quote(t)}`;
  // Free-text name search; each word must match.
  return t
    .split(/\s+/)
    .slice(0, 4)
    .map((w) => quote(w.replace(/[^\p{L}\p{N}'.-]/gu, '')))
    .filter((w) => w !== '""')
    .join(' ');
}

const quote = (s) => `"${String(s).replace(/["\\]/g, '')}"`;

export function fromShopifyCustomer(c) {
  return {
    shopifyCustomerGid: c.id,
    displayName: c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Customer',
    firstName: c.firstName || null,
    lastName: c.lastName || null,
    phoneE164: normalizeUsPhone(c.defaultPhoneNumber?.phoneNumber) || null,
    email: c.defaultEmailAddress?.emailAddress || null,
    numberOfOrders: c.numberOfOrders === undefined ? undefined : Number(c.numberOfOrders),
  };
}

// Verified against the live Admin API schema on Oct 17, 2026.
const CUSTOMER_FIELDS = `id displayName firstName lastName defaultPhoneNumber { phoneNumber } defaultEmailAddress { emailAddress }`;

export const SEARCH_CUSTOMERS = `query RepairDeskCustomerSearch($q: String!, $first: Int!) {
  customers(first: $first, query: $q, sortKey: UPDATED_AT, reverse: true) {
    nodes { ${CUSTOMER_FIELDS} numberOfOrders }
  }
}`;

export const CREATE_CUSTOMER = `mutation RepairDeskCustomerCreate($input: CustomerInput!) {
  customerCreate(input: $input) {
    customer { ${CUSTOMER_FIELDS} }
    userErrors { field message }
  }
}`;
