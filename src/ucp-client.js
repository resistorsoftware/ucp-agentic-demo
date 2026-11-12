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
  { agentProfile, fetchImpl = fetch, onExchange, signal, corsSimple = IS_BROWSER } = {},
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
    headers: corsSimpleHeaders(corsSimple),
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
  { endpoint, query, context, filters, limit = 10, cursor },
  options = {},
) {
  const catalog = { query };
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
