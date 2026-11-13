/**
 * Minimal, dependency-free UCP client.
 *
 * Works unchanged in the browser and in Node 18+ (both have fetch + ESM).
 * It speaks the MCP binding of the Universal Commerce Protocol directly over
 * JSON-RPC 2.0, so nothing here is hidden behind an SDK: every request you see
 * in the demo's protocol log is the exact body that went over the wire.
 *
 * Spec: https://ucp.dev/2026-08-25/specification/overview/
 * Shopify's UCP surfaces: https://shopify.dev/docs/agents
 */

export const UCP_VERSION = '2026-08-25';

/** Shopify's cross-merchant catalog. Keyless: identity comes from the agent profile. */
export const GLOBAL_CATALOG_ENDPOINT = 'https://catalog.shopify.com/api/ucp/mcp';

/**
 * A published agent profile that Shopify hosts. Used as a fallback when this
 * demo runs from a file:// or localhost origin, where our own profile URL is
 * not reachable by the merchant's server.
 */
export const FALLBACK_AGENT_PROFILE =
  `https://shopify.dev/ucp/agent-profiles/${UCP_VERSION}/valid-with-capabilities.json`;

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class UcpError extends Error {
  constructor(message, { code, data, continueUrl } = {}) {
    super(message);
    this.name = 'UcpError';
    this.code = code;
    this.data = data;
    /** Where to hand the buyer off when the agent cannot proceed. */
    this.continueUrl = continueUrl;
  }
}

/* ------------------------------------------------------------------ *
 * Discovery — step 1 of any UCP conversation
 * ------------------------------------------------------------------ */

/** Normalise anything a human might type into a bare hostname. */
export function normalizeDomain(input) {
  const raw = String(input || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+$/i.test(raw) || !raw.includes('.')) {
    throw new UcpError(`"${input}" is not a bare hostname`, { code: 'INVALID_DOMAIN' });
  }
  return raw.toLowerCase();
}

export function wellKnownUrl(domain) {
  return `https://${normalizeDomain(domain)}/.well-known/ucp`;
}

/**
 * Fetch a business's UCP profile. A 200 with a `ucp` object means the business
 * speaks UCP; anything else means it does not, and the agent should say so
 * rather than silently substituting a different merchant.
 */
export async function discoverBusiness(domain, { fetchImpl = fetch } = {}) {
  const url = wellKnownUrl(domain);
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (cause) {
    throw new UcpError(`Could not reach ${url}`, { code: 'PROFILE_FETCH_FAILED', data: cause });
  }
  if (!res.ok) {
    throw new UcpError(`${url} returned HTTP ${res.status} — this business does not speak UCP`, {
      code: 'PROFILE_FETCH_FAILED',
    });
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new UcpError(`${url} did not return JSON — this business does not speak UCP`, {
      code: 'PROFILE_FETCH_FAILED',
    });
  }
  if (!body || typeof body.ucp !== 'object') {
    throw new UcpError(`${url} has no "ucp" object`, { code: 'PROFILE_INVALID' });
  }
  return summarizeProfile(body, { domain: normalizeDomain(domain), profileUrl: url });
}

/**
 * Reduce a business profile to what an agent actually plans against:
 * the negotiated version, the MCP endpoint, and the capability list.
 */
export function summarizeProfile(profile, { domain, profileUrl } = {}) {
  const ucp = profile.ucp || {};
  const services = ucp.services || {};
  const mcp = []
    .concat(services['dev.ucp.shopping'] || [], services['dev.ucp.common'] || [])
    .find((s) => s && s.transport === 'mcp' && s.endpoint);

  return {
    domain,
    profileUrl,
    version: ucp.version || null,
    supportedVersions: Object.keys(ucp.supported_versions || {}),
    endpoint: mcp ? mcp.endpoint : null,
    capabilities: Object.keys(ucp.capabilities || {}).sort(),
    /**
     * Empty `payment_handlers` means the business advertises no agent-completable
     * payment method: `complete_checkout` will escalate to `continue_url` instead
     * of placing the order. That is a valid UCP outcome, not a client bug.
     */
    paymentHandlers: Object.keys(ucp.payment_handlers || {}),
    raw: profile,
  };
}

/* ------------------------------------------------------------------ *
 * Transport — JSON-RPC over the MCP binding
 * ------------------------------------------------------------------ */

let rpcId = 0;

export const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

/**
 * Browsers only skip the CORS preflight for a "simple" request, and a simple
 * request may not set `Accept` and may only use a handful of content types.
 *
 * This matters in practice: `catalog.shopify.com` answers `OPTIONS` with
 * HTTP 400, so a preflighted call from a page is blocked outright, while the
 * same call sent as a simple request succeeds and comes back with
 * `Access-Control-Allow-Origin: *`. Both Shopify UCP endpoints parse a JSON
 * body sent as `text/plain`, so a static page can speak UCP with no proxy.
 *
 * Node has no CORS, so there we send the honest JSON content type.
 */
function corsSimpleHeaders(simple) {
  return simple
    ? { 'content-type': 'text/plain;charset=UTF-8' }
    : { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
}

/**
 * Call one UCP tool. `onExchange` receives the request and response bodies so a
 * UI can show the raw protocol traffic.
 */
export async function callTool(
  endpoint,
  toolName,
  args,
  { agentProfile, fetchImpl = fetch, onExchange, signal, corsSimple = IS_BROWSER, accessToken, extraHeaders } = {},
) {
  if (!endpoint) throw new UcpError('No MCP endpoint', { code: 'NO_ENDPOINT' });
  if (!agentProfile) throw new UcpError('No agent profile URL', { code: 'PROFILE_NOT_FOUND' });

  const request = {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: {
      name: toolName,
      // Every UCP request carries the agent's identity. The business fetches
      // this URL and negotiates against it, so it must be publicly reachable.
      arguments: { meta: { 'ucp-agent': { profile: agentProfile } }, ...args },
    },
  };

  const started = Date.now();
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      ...corsSimpleHeaders(corsSimple && !accessToken),
      /* An Authorization header always triggers a CORS preflight, and
         catalog.shopify.com answers preflight with HTTP 400 — so a
         credentialed call cannot be made from a browser at all. Token-tier
         work belongs in a CLI or a server regardless of secret handling. */
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(extraHeaders || {}),
    },
    body: JSON.stringify(request),
    signal,
  });

  const text = await res.text();
  const body = parseRpcBody(text);
  const exchange = { endpoint, toolName, request, response: body, status: res.status, ms: Date.now() - started };
  if (onExchange) onExchange(exchange);

  if (body && body.error) {
    const d = body.error.data || {};
    throw new UcpError(d.content || body.error.message || 'UCP error', {
      code: d.code || body.error.code,
      data: d,
      continueUrl: d.continue_url,
    });
  }
  if (!res.ok) {
    throw new UcpError(`HTTP ${res.status} from ${endpoint}`, { code: 'HTTP_ERROR', data: text.slice(0, 500) });
  }

  const result = body && body.result;
  const payload = unwrapToolResult(result);
  if (result && result.isError) {
    const msg = (payload && payload.messages && payload.messages[0] && payload.messages[0].content) ||
      (typeof payload === 'string' ? payload : 'tool returned an error');
    throw new UcpError(msg, { code: 'TOOL_ERROR', data: payload });
  }
  return { payload, exchange };
}

/** MCP may answer as plain JSON or as a single-event SSE stream. Accept both. */
function parseRpcBody(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('');
  if (!dataLines) throw new UcpError('Unparseable response body', { code: 'BAD_RESPONSE', data: trimmed.slice(0, 500) });
  return JSON.parse(dataLines);
}

/** Prefer structuredContent; fall back to the JSON carried in the text block. */
function unwrapToolResult(result) {
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  const block = (result.content || []).find((c) => c && c.type === 'text');
  if (!block) return null;
  try {
    return JSON.parse(block.text);
  } catch {
    return block.text;
  }
}

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

/**
 * `search_catalog`. Three field groups, and the difference matters:
 *   query   — the literal search term
 *   context — soft signals for ranking and localisation (never exclusions)
 *   filters — hard exclusions; non-matching results are dropped
 */
export async function searchCatalog(
  { endpoint, query, context, filters, limit = 10, cursor, catalogId },
  options = {},
) {
  const catalog = { query };
  /* A saved catalog's own filters always take precedence over anything sent
     here, so treat catalogId as the authority, not a hint. */
  if (catalogId) catalog.catalog_id = catalogId;
  if (context) catalog.context = context;
  if (filters) catalog.filters = filters;
  catalog.pagination = cursor ? { limit, cursor } : { limit };
  const { payload, exchange } = await callTool(endpoint, 'search_catalog', { catalog }, options);
  return {
    products: (payload && payload.products) || [],
    pagination: (payload && payload.pagination) || null,
    messages: (payload && payload.messages) || [],
    exchange,
  };
}

/** `get_product` — full option matrix and live per-variant state for one product. */
export async function getProduct({ endpoint, id, selected }, options = {}) {
  const catalog = { id };
  if (selected) catalog.selected = selected;
  const { payload, exchange } = await callTool(endpoint, 'get_product', { catalog }, options);
  return { product: (payload && (payload.product || (payload.products || [])[0])) || null, exchange };
}

/** `create_cart` — low-commitment basket assembly. No money moves here. */
export async function createCart({ endpoint, lineItems, context, buyer }, options = {}) {
  const cart = { line_items: lineItems };
  if (context) cart.context = context;
  if (buyer) cart.buyer = buyer;
  const { payload, exchange } = await callTool(endpoint, 'create_cart', { cart }, options);
  return { cart: normalizeCart(payload), exchange };
}

/**
 * `update_cart` is FULL REPLACE: whatever `line_items` you send becomes the
 * cart. Always carry the whole array forward.
 */
export async function updateCart({ endpoint, id, lineItems, context, fulfillment }, options = {}) {
  const cart = { id, line_items: lineItems };
  if (context) cart.context = context;
  if (fulfillment) cart.fulfillment = fulfillment;
  const { payload, exchange } = await callTool(endpoint, 'update_cart', { cart }, options);
  return { cart: normalizeCart(payload), exchange };
}

function normalizeCart(payload) {
  const c = (payload && (payload.cart || payload)) || {};
  return {
    id: c.id || null,
    currency: c.currency || null,
    lineItems: c.line_items || [],
    totals: c.totals || [],
    messages: c.messages || [],
    fulfillment: c.fulfillment || null,
    continueUrl: c.continue_url || null,
    raw: c,
  };
}

/* ------------------------------------------------------------------ *
 * Checkout
 *
 * Verified against hotwire-resistor.myshopify.com on 13 November 2026:
 * `create_checkout` and `update_checkout` answer an ANONYMOUS agent — no API
 * key, no request signature. `complete_checkout` does not; it returns
 * `AuthenticationRequired` ("a valid JWT is required") before it ever looks at
 * whether the merchant advertises a payment handler.
 *
 * So the ceiling on a keyless agent is completion, not checkout. A demo can
 * legitimately go all the way to a priced, validated checkout and hand the
 * buyer off — which is a much better demo than stopping at the cart.
 * ------------------------------------------------------------------ */

/** `create_checkout` — convert a cart into a checkout. Keyless. */
export async function createCheckout({ endpoint, cartId, lineItems, context, buyer }, options = {}) {
  /* Converting a cart sends an empty line_items; it is the cart_id that
     carries the contents. Only a true buy-now flow passes line_items. */
  const checkout = cartId ? { cart_id: cartId, line_items: lineItems || [] } : { line_items: lineItems };
  if (context) checkout.context = context;
  if (buyer) checkout.buyer = buyer;
  const { payload, exchange } = await callTool(endpoint, 'create_checkout', { checkout }, options);
  return { checkout: normalizeCheckout(payload), exchange };
}

/**
 * `update_checkout` — full replace on `line_items`, same rule as the cart, and
 * the rule that bites hardest here: send an empty array and the merchant
 * empties the checkout, then reports that it cannot ship an empty order. The
 * misleading error is downstream of your own payload, not the store's setup.
 *
 * `id` is a TOP-LEVEL argument, not a field of `checkout` — unlike every other
 * operation in this file. The merchant rejects it as "Missing required
 * arguments: id" otherwise.
 */
export async function updateCheckout({ endpoint, id, lineItems, buyer, fulfillment }, options = {}) {
  const checkout = { line_items: lineItems || [] };
  if (buyer) checkout.buyer = buyer;
  if (fulfillment) checkout.fulfillment = fulfillment;
  const { payload, exchange } = await callTool(endpoint, 'update_checkout', { id, checkout }, options);
  return { checkout: normalizeCheckout(payload), exchange };
}

/**
 * Carry a checkout's line items forward, for the full-replace rule above.
 *
 * The schema requires `item.id` to be a PRODUCT VARIANT id, not the line id —
 * and requires it on every entry. A merchant's line item does not always
 * expose that variant id where you expect it, and an entry built without one
 * serialises to `{"item":{}}`: structurally present, semantically empty.
 *
 * This merchant accepts such a payload rather than rejecting it, and answers
 * with a checkout carrying no fulfillment methods at all — which reads as "no
 * delivery options offered" when the truth is "you sent an unusable line".
 * Hence `fallbackVariantId`, and hence throwing rather than guessing: a loud
 * failure here is worth far more than a quiet, plausible wrong answer.
 */
export function carryLineItems(checkout, { fallbackVariantId } = {}) {
  return (checkout.lineItems || []).map((li) => {
    const variantId = (li.item && li.item.id)
      || (li.variant && li.variant.id)
      || li.variant_id
      || fallbackVariantId;
    if (!variantId) {
      throw new UcpError(
        'Cannot carry this line item forward: no product variant id on it, and no fallback given. '
        + 'Sending it anyway would silently produce a checkout with no delivery options.',
        { code: 'LINE_ITEM_UNRESOLVED', data: li },
      );
    }
    return {
      ...(li.id ? { id: li.id } : {}),
      item: { id: variantId },
      quantity: li.quantity == null ? 1 : li.quantity,
    };
  });
}

/**
 * The delivery options a merchant offered, flattened for display.
 *
 * Options are nested one level deeper than you would guess:
 * `fulfillment.methods[].groups[].options[]`. A delivery GROUP is the unit
 * that gets its own rates — split a basket across locations or ship-from
 * points and you get several groups, each with its own option list and its own
 * `selected_option_id`. A single-item order has exactly one group, which makes
 * the extra level easy to miss in a truncated dump and easy to code past.
 *
 * Reading `methods[].options` instead finds nothing and reports it as "the
 * merchant offered no delivery options" — wrong, and defamatory about the
 * merchant. Both shapes are accepted here; the group id travels with each
 * option, since selecting one means naming its group.
 */
export function deliveryOptions(checkout) {
  const methods = (checkout.fulfillment && checkout.fulfillment.methods) || [];
  const out = [];
  const take = (o, container, method, groupId) => {
    const total = (o.totals || []).find((t) => t.type === 'total') || (o.totals || [])[0];
    out.push({
      id: o.id,
      groupId: groupId || null,
      title: o.title || 'Delivery',
      description: (o.description && (o.description.plain || o.description.html)) || '',
      amount: total ? total.amount : null,
      selected: o.id === container.selected_option_id,
      methodType: method.type || 'shipping',
    });
  };
  for (const m of methods) {
    for (const g of m.groups || []) for (const o of g.options || []) take(o, g, m, g.id);
    /* Some merchants put options straight on the method. Accept that too. */
    for (const o of m.options || []) take(o, m, m, null);
  }
  return out;
}

/**
 * `complete_checkout` — the only operation here that needs a credential.
 *
 * Requires Token-tier auth: a JWT from a Dev Dashboard agent identity, plus a
 * `Shopify-Buyer-IP` header carrying the real IP of the buyer you act for.
 * Shopify will not fall back to the connecting address, and sends HTTP 422 if
 * the header is missing. There is no placeholder value.
 */
export async function completeCheckout({ endpoint, id, buyerIp }, options = {}) {
  if (!options.accessToken) {
    throw new UcpError(
      'complete_checkout needs a Token-tier JWT. Anonymous and signed agents cannot complete a purchase.',
      { code: 'AUTH_REQUIRED' },
    );
  }
  if (!buyerIp) {
    throw new UcpError(
      'complete_checkout needs a Shopify-Buyer-IP header with the real buyer IP. Shopify rejects the call without it.',
      { code: 'BUYER_IP_REQUIRED' },
    );
  }
  const { payload, exchange } = await callTool(
    endpoint,
    'complete_checkout',
    { checkout: { id } },
    { ...options, extraHeaders: { 'shopify-buyer-ip': buyerIp } },
  );
  return { checkout: normalizeCheckout(payload), exchange };
}

function normalizeCheckout(payload) {
  const k = (payload && (payload.checkout || payload)) || {};
  return {
    id: k.id || null,
    status: k.status || null,
    currency: k.currency || null,
    lineItems: k.line_items || [],
    totals: k.totals || [],
    messages: (payload && payload.messages) || k.messages || [],
    fulfillment: k.fulfillment || null,
    payment: k.payment || null,
    continueUrl: k.continue_url || null,
    raw: k,
  };
}

/* ------------------------------------------------------------------ *
 * Credentialed access (saved catalogs)
 * ------------------------------------------------------------------ */

export const TOKEN_ENDPOINT = 'https://api.shopify.com/auth/access_token';

/**
 * Exchange Dev Dashboard client credentials for an agent access token.
 *
 * Tokens live 60 minutes, so fetch one at runtime rather than storing it.
 * The client secret must never reach a browser: this is for Node only.
 */
export async function getAccessToken({ clientId, clientSecret, fetchImpl = fetch } = {}) {
  if (IS_BROWSER) {
    throw new UcpError('Refusing to exchange client credentials in a browser — the secret would be public.', {
      code: 'UNSAFE_CONTEXT',
    });
  }
  if (!clientId || !clientSecret) {
    throw new UcpError('Missing client credentials', { code: 'NO_CREDENTIALS' });
  }
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new UcpError(`Token exchange failed: HTTP ${res.status}`, { code: 'AUTH_FAILED', data: text.slice(0, 300) });
  }
  const body = JSON.parse(text);
  if (!body.access_token) {
    throw new UcpError('Token exchange returned no access_token', { code: 'AUTH_FAILED', data: body });
  }
  return { accessToken: body.access_token, tokenType: body.token_type || 'Bearer' };
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XOF', 'XAF', 'XPF', 'BIF', 'DJF', 'GNF', 'KMF', 'MGA', 'PYG', 'RWF', 'UGX', 'VUV']);

/**
 * UCP amounts are integers in ISO 4217 minor units: 7500 CAD is $75.00.
 * Never show a raw amount to a buyer.
 */
export function formatMoney(amount, currency) {
  if (amount == null) return '—';
  const code = (currency || 'USD').toUpperCase();
  const major = ZERO_DECIMAL.has(code) ? amount : amount / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(major);
  } catch {
    return `${major} ${code}`;
  }
}

/**
 * The printer contract: render `totals[]` in the order the business gave,
 * using its `display_text`. Do not reorder, recompute, filter or aggregate —
 * tax itemisation and fee disclosure depend on the business's presentation.
 * Signs are meaningful: negative is subtractive.
 */
export function totalsForDisplay(totals, currency) {
  return (totals || []).map((entry) => ({
    label: entry.display_text || entry.type,
    type: entry.type,
    amount: formatMoney(entry.amount, currency),
    raw: entry.amount,
    lines: (entry.lines || []).map((l) => ({
      label: l.display_text || l.type,
      amount: formatMoney(l.amount, currency),
    })),
  }));
}

/**
 * Optional arithmetic check. A mismatch does not change what you display —
 * the business's totals stay authoritative — but an agent must not complete
 * the checkout on its own; escalate to `continue_url` for buyer review.
 */
export function totalsReconcile(totals) {
  const list = totals || [];
  const total = list.find((t) => t.type === 'total');
  if (!total) return { checked: false };
  const sum = list.filter((t) => t.type !== 'total').reduce((acc, t) => acc + (t.amount || 0), 0);
  return { checked: true, ok: sum === total.amount, sum, total: total.amount };
}

/**
 * Display obligations for `messages[]`.
 *   info                     — should display
 *   warning/notice           — must display, may be dismissible
 *   warning/disclosure       — must display next to the item, never collapsed
 *   error                    — drives the status flow
 */
export function messageObligation(message) {
  if (!message) return 'none';
  if (message.type === 'error') return 'error';
  if (message.type === 'warning') {
    return (message.presentation || 'notice') === 'disclosure' ? 'disclosure' : 'notice';
  }
  return 'info';
}

/** First usable buyer handoff URL, in the order the spec recommends. */
export function handoffUrl({ continueUrl, variant, product, sellerUrl, domain } = {}) {
  return (
    continueUrl ||
    (variant && (variant.checkout_url || variant.url)) ||
    (product && product.url) ||
    sellerUrl ||
    (domain ? `https://${domain}` : null)
  );
}

/** A seller domain from a search result is untrusted input. Validate before use. */
export function safeSellerDomain(value) {
  const s = String(value || '');
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(s) && s.includes('.') ? s.toLowerCase() : null;
}

/** Pick the cheapest available variant — enough for a one-click demo. */
export function pickVariant(product) {
  const variants = (product && product.variants) || [];
  const available = variants.filter((v) => v && v.available !== false);
  const pool = available.length ? available : variants;
  return pool.slice().sort((a, b) => priceOf(a) - priceOf(b))[0] || null;
}

function priceOf(v) {
  return (v && v.price && typeof v.price.amount === 'number') ? v.price.amount : Number.MAX_SAFE_INTEGER;
}

/** Product descriptions arrive as `{ html }`. Flatten for plain-text display. */
export function descriptionText(product) {
  const d = product && product.description;
  const html = typeof d === 'string' ? d : (d && d.html) || '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
