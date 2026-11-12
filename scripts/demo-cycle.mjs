#!/usr/bin/env node
/**
 * The complete agentic shopping cycle, end to end, against a real merchant.
 *
 *   1. Discovery   — read the merchant's /.well-known/ucp profile and negotiate
 *   2. Search      — cross-merchant (global catalog) and merchant-scoped
 *   3. Select      — get_product for the live option matrix
 *   4. Cart        — create_cart, then render totals under the printer contract
 *   5. Handoff     — the continue_url a buyer or a checkout step would follow
 *
 * No money moves: this script stops at the cart. Checkout completion is a
 * separate, deliberate step (see docs/checkout.md).
 *
 * Usage:
 *   node scripts/demo-cycle.mjs [--query "<term>"] [--store <domain>] [--json]
 */
import {
  GLOBAL_CATALOG_ENDPOINT,
  UcpError,
  createCart,
  descriptionText,
  discoverBusiness,
  formatMoney,
  getProduct,
  handoffUrl,
  messageObligation,
  pickVariant,
  safeSellerDomain,
  searchCatalog,
  totalsForDisplay,
  totalsReconcile,
} from '../src/ucp-client.js';
import { agentProfile, assertProfileReachable, buyerContext, c, kv, step, storeDomain } from '../src/node-env.js';

const args = parseArgs(process.argv.slice(2));
const store = args.store || storeDomain();
const profile = agentProfile();
const context = buyerContext();
const query = args.query || 'stomper';
const asJson = Boolean(args.json);
const transcript = { store, agentProfile: profile, query, steps: [] };

const record = (name, data) => transcript.steps.push({ step: name, ...data });

async function main() {
  if (!asJson) {
    console.log(c.bold('\nUCP agentic shopping cycle'));
    kv('merchant', store);
    kv('agent profile', profile);
    kv('buyer context', JSON.stringify(context));
  }

  /* ---- 0. Our own identity has to be reachable, or nothing else works ---- */
  const reach = await assertProfileReachable(profile);
  if (!reach.ok) {
    fail(`Agent profile ${profile} is not reachable (${reach.detail}).\n` +
      'The merchant fetches this URL during negotiation. Publish it, or set UCP_AGENT_PROFILE.');
  }
  record('agent-profile', { url: profile, ucpVersion: reach.version });

  /* ---- 1. Discovery ---- */
  step(1, 'Discovery — GET /.well-known/ucp');
  const biz = await discoverBusiness(store);
  if (!asJson) {
    kv('UCP version', biz.version);
    kv('MCP endpoint', biz.endpoint);
    kv('capabilities', `${biz.capabilities.length} advertised`);
    biz.capabilities.forEach((cap) => console.log(`      ${c.dim('·')} ${cap}`));
    kv('payment handlers', biz.paymentHandlers.length
      ? biz.paymentHandlers.join(', ')
      : c.yellow('none — agent-completed checkout will escalate to continue_url'));
  }
  record('discovery', {
    profileUrl: biz.profileUrl,
    version: biz.version,
    endpoint: biz.endpoint,
    capabilities: biz.capabilities,
    paymentHandlers: biz.paymentHandlers,
  });
  if (!biz.endpoint) fail('Merchant advertises no MCP endpoint.');

  /* ---- 2a. Cross-merchant search ---- */
  step('2a', 'Global catalog search — all of Shopify');
  const global = await searchCatalog(
    { endpoint: GLOBAL_CATALOG_ENDPOINT, query, context, limit: 10 },
    { agentProfile: profile },
  );
  const sellers = new Map();
  for (const p of global.products) {
    const d = safeSellerDomain(((p.variants || [])[0] || {}).seller?.domain);
    if (d) sellers.set(d, (sellers.get(d) || 0) + 1);
  }
  const storeInGlobal = sellers.has(store);
  if (!asJson) {
    kv('results', String(global.products.length));
    kv('distinct sellers', String(sellers.size));
    kv(`${store}?`, storeInGlobal
      ? c.green('present in global results')
      : c.yellow('not in these results — see docs/store-readiness.md'));
    global.products.slice(0, 5).forEach((p) => {
      const v = (p.variants || [])[0] || {};
      console.log(`      ${formatMoney(p.price_range?.min?.amount, p.price_range?.min?.currency).padStart(10)}  ` +
        `${truncate(p.title, 44).padEnd(44)} ${c.dim(v.seller?.domain || '—')}`);
    });
  }
  record('global-search', {
    endpoint: GLOBAL_CATALOG_ENDPOINT,
    results: global.products.length,
    sellers: [...sellers.keys()],
    storePresent: storeInGlobal,
  });

  /* ---- 2b. Merchant-scoped search ---- */
  step('2b', `Storefront catalog search — ${store} only`);
  const local = await searchCatalog(
    { endpoint: biz.endpoint, query, context, limit: 10 },
    { agentProfile: profile },
  );
  if (!asJson) {
    kv('results', String(local.products.length));
    local.products.slice(0, 8).forEach((p) => {
      const desc = descriptionText(p);
      console.log(`      ${formatMoney(p.price_range?.min?.amount, p.price_range?.min?.currency).padStart(10)}  ` +
        `${truncate(p.title, 40).padEnd(40)} ${c.dim(desc ? truncate(desc, 50) : 'no description')}`);
    });
  }
  record('store-search', { endpoint: biz.endpoint, results: local.products.map((p) => ({ id: p.id, title: p.title })) });
  if (!local.products.length) fail(`No products matched "${query}" at ${store}.`);

  /* ---- 3. Selection ---- */
  step(3, 'Selection — get_product for the live option matrix');
  const chosen = local.products[0];
  const detail = await getProduct({ endpoint: biz.endpoint, id: chosen.id }, { agentProfile: profile });
  const product = detail.product || chosen;

  /*
   * `get_product` resolves to a selection: with no `selected`/`preferences` it
   * comes back carrying a single variant, not the whole matrix. The search
   * result, meanwhile, carries the full variant array. So read the option
   * matrix from get_product (it is the live one) but choose the variant from
   * whichever response actually lists them all — otherwise a three-size print
   * silently carts as whichever size the merchant happened to resolve to.
   */
  const variantSource = ((chosen.variants || []).length > (product.variants || []).length) ? chosen : product;
  const variant = pickVariant(variantSource);
  if (!variant) fail(`Product "${product.title}" exposes no variants.`);
  if (!asJson) {
    kv('product', product.title);
    kv('options', (product.options || []).map((o) => `${o.name}(${(o.values || o.labels || []).length})`).join(' ') || '—');
    kv('variant', `${variant.id}${variant.title ? ` (${variant.title})` : ''}`);
    kv('chosen from', variantSource === product ? 'get_product' : `search result (${(chosen.variants || []).length} variants)`);
    kv('variant price', formatMoney(variant.price?.amount, variant.price?.currency || product.price_range?.min?.currency));
  }
  record('selection', { productId: product.id, title: product.title, variantId: variant.id });

  /* ---- 4. Cart ---- */
  step(4, 'Cart — create_cart');
  const { cart } = await createCart(
    { endpoint: biz.endpoint, lineItems: [{ item: { id: variant.id }, quantity: 1 }], context },
    { agentProfile: profile },
  );
  if (!asJson) {
    kv('cart id', cart.id);
    kv('line items', String(cart.lineItems.length));
    console.log(`\n    ${c.bold('Totals')} ${c.dim('(rendered in the order the merchant gave, using its labels)')}`);
    for (const row of totalsForDisplay(cart.totals, cart.currency)) {
      console.log(`      ${row.label.padEnd(24)} ${row.amount.padStart(12)}`);
      row.lines.forEach((l) => console.log(`        ${c.dim(l.label.padEnd(22))} ${c.dim(l.amount.padStart(12))}`));
    }
    const rec = totalsReconcile(cart.totals);
    if (rec.checked) {
      kv('reconciles', rec.ok ? c.green('yes') : c.yellow('NO — do not auto-complete; escalate for buyer review'));
    }
    for (const m of cart.messages) {
      const ob = messageObligation(m);
      const tag = ob === 'disclosure' ? c.red('[MUST SHOW]') : ob === 'notice' ? c.yellow('[show]') : c.dim('[info]');
      console.log(`      ${tag} ${m.content || m.code}`);
    }
  }
  record('cart', {
    id: cart.id,
    currency: cart.currency,
    totals: cart.totals,
    messages: cart.messages,
    reconcile: totalsReconcile(cart.totals),
  });

  /* ---- 5. Handoff ---- */
  step(5, 'Handoff — where a buyer finishes');
  const url = handoffUrl({ continueUrl: cart.continueUrl, variant, product, domain: store });
  if (!asJson) {
    kv('continue_url', url || '—');
    console.log(`\n${c.green(c.bold('Cycle complete.'))} ${c.dim('Discovery → search → selection → cart → handoff. No order was placed.')}\n`);
  }
  record('handoff', { continueUrl: url });

  if (asJson) console.log(JSON.stringify(transcript, null, 2));
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'json') out.json = true;
    else out[key] = argv[++i];
  }
  return out;
}

function fail(msg) {
  console.error(`\n${c.red('✗')} ${msg}\n`);
  process.exit(1);
}

main().catch((err) => {
  if (err instanceof UcpError) {
    console.error(`\n${c.red('✗ UCP error')} ${err.code || ''}: ${err.message}`);
    if (err.continueUrl) console.error(`  Hand the buyer off to: ${err.continueUrl}`);
    process.exit(1);
  }
  throw err;
});
