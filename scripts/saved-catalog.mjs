#!/usr/bin/env node
/**
 * Search a saved catalog — the deterministic answer to "agentic search finds
 * my store" when the store is not in the open global index.
 *
 * A saved catalog is a Global Catalog configuration you store in the Shopify
 * Dev Dashboard, optionally scoped to a single store. Unlike the keyless global
 * and storefront catalogs, it is credentialed: you exchange a Dev Dashboard
 * client id and secret for a 60-minute access token.
 *
 * That is why this is a CLI script and not part of the published page. A client
 * secret in a static site is a public secret. The browser demo stays keyless.
 *
 * Setup (see docs/saved-catalog.md):
 *   Dev Dashboard → Catalogs → create a catalog, scope its source to your store
 *   Dev Dashboard → Catalogs → Get an API key → client id + secret
 *   Copy the catalog's URL and id.
 *
 *   cp .env.example .env.local      # then fill it in; .env.local is gitignored
 *   node scripts/saved-catalog.mjs --query "giclee print"
 */
import { readFileSync } from 'node:fs';
import {
  UcpError,
  descriptionText,
  formatMoney,
  getAccessToken,
  safeSellerDomain,
  searchCatalog,
} from '../src/ucp-client.js';
import { agentProfile, buyerContext, c, kv, step, storeDomain } from '../src/node-env.js';

loadEnvFile('.env.local');

const args = parseArgs(process.argv.slice(2));
const query = args.query || 'print';
const store = args.store || storeDomain();

const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
const catalogUrl = args['catalog-url'] || process.env.SHOPIFY_CATALOG_URL;
const catalogId = args['catalog-id'] || process.env.SHOPIFY_CATALOG_ID || null;

async function main() {
  console.log(c.bold('\nSaved catalog search'));
  kv('catalog URL', catalogUrl || c.red('not set'));
  kv('catalog id', catalogId || c.dim('(none — the URL alone identifies it)'));
  kv('expecting', store);

  if (!catalogUrl) return setupHelp('SHOPIFY_CATALOG_URL is not set.');
  if (!clientId || !clientSecret) return setupHelp('SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not set.');

  /* ---- 1. Token ---- */
  step(1, 'Authenticate — client_credentials exchange');
  const { accessToken } = await getAccessToken({ clientId, clientSecret });
  kv('token', `${accessToken.slice(0, 8)}… (60 minute TTL)`);

  /* ---- 2. Search ---- */
  step(2, `Search the saved catalog for “${query}”`);
  const { products } = await searchCatalog(
    { endpoint: catalogUrl, query, context: buyerContext(), limit: 20, catalogId },
    { agentProfile: agentProfile(), accessToken },
  );
  kv('results', String(products.length));

  const sellers = new Map();
  for (const p of products) {
    const d = safeSellerDomain(((p.variants || [])[0] || {}).seller?.domain);
    sellers.set(d || 'unknown', (sellers.get(d || 'unknown') || 0) + 1);
  }

  for (const p of products) {
    const v = (p.variants || [])[0] || {};
    const d = safeSellerDomain(v.seller?.domain);
    const mine = d === store;
    console.log(`    ${formatMoney(p.price_range?.min?.amount, p.price_range?.min?.currency).padStart(10)}  ` +
      `${truncate(p.title, 42).padEnd(42)} ${mine ? c.green(d) : c.dim(d || '—')}`);
    const desc = descriptionText(p);
    if (mine && desc) console.log(`                ${c.dim(truncate(desc, 76))}`);
  }

  /* ---- 3. Did the scoping actually work? ---- */
  step(3, 'Scope check');
  const mine = sellers.get(store) || 0;
  const others = [...sellers.entries()].filter(([d]) => d !== store);
  kv(`from ${store}`, mine ? c.green(String(mine)) : c.red('0'));
  kv('from other sellers', others.length
    ? c.yellow(`${others.reduce((a, [, n]) => a + n, 0)} across ${others.length} seller(s)`)
    : c.green('none'));

  if (mine && !others.length) {
    console.log(`\n${c.green(c.bold('Scoped correctly.'))} ${c.dim('An open-ended agent search against this catalog reaches only your store.')}`);
    console.log(c.dim('    Feed the results into the cart step: node scripts/demo-cycle.mjs\n'));
  } else if (mine) {
    console.log(`\n${c.yellow('Partially scoped.')} Your store is present but so are others — check the catalog's Source/Inputs setting in the Dev Dashboard.\n`);
  } else {
    console.log(`\n${c.red('Your store is not in these results.')}`);
    console.log('  Either the catalog is not scoped to it, or its products are still ineligible for the\n' +
      '  global index that saved catalogs draw from. Re-run scripts/audit-catalog.mjs and check\n' +
      '  that the products are published to the agentic sales channel.\n');
  }
}

function setupHelp(why) {
  console.log(`\n${c.yellow('Not configured:')} ${why}\n`);
  console.log('  1. Dev Dashboard → Catalogs → Create a catalog');
  console.log(`     Set its source to this store only: ${store}`);
  console.log('  2. Copy URL (the saved catalog\'s MCP endpoint) and the catalog id');
  console.log('  3. Dev Dashboard → Catalogs → Get an API key → copy client id and secret');
  console.log('     (In a Partner org you may first have to click "Verify to unlock".)');
  console.log('  4. cp .env.example .env.local, fill it in, and re-run this script.\n');
  console.log(c.dim('  Full walkthrough: docs/saved-catalog.md\n'));
  process.exitCode = 1;
}

/** Minimal .env reader — no dependency, and it never overwrites a real env var. */
function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

main().catch((err) => {
  if (err instanceof UcpError) {
    console.error(`\n${c.red('✗ UCP error')} ${err.code || ''}: ${err.message}`);
    if (err.data) console.error(c.dim(`  ${typeof err.data === 'string' ? err.data : JSON.stringify(err.data).slice(0, 300)}`));
    console.error();
    process.exit(1);
  }
  throw err;
});
