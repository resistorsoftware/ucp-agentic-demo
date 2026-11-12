#!/usr/bin/env node
/**
 * Apply agentic-readiness fixes to a Shopify catalog through the Admin API.
 *
 * Reads a plan file (default `data/catalog-plan.json`) describing, per product,
 * what should change. Dry run by default: it prints the mutations it would send
 * and changes nothing until you pass --apply.
 *
 * The token is never read from the repo. Supply it as SHOPIFY_ADMIN_TOKEN, or
 * put it in a file outside the repo and pass --token-file.
 *
 *   export SHOPIFY_ADMIN_TOKEN="shpat_…"
 *   node scripts/fix-catalog.mjs                 # dry run
 *   node scripts/fix-catalog.mjs --apply         # write
 *   node scripts/fix-catalog.mjs --apply --only 7493707104511
 *
 * Required Admin API scopes: read_products, write_products.
 * Unpublishing also needs read_publications, write_publications.
 */
import { readFileSync } from 'node:fs';
import { c, kv, storeDomain } from '../src/node-env.js';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-10';

const args = parseArgs(process.argv.slice(2));
const store = args.store || storeDomain();
const apply = Boolean(args.apply);
const planPath = args.plan || 'data/catalog-plan.json';
const token = resolveToken(args);

const endpoint = `https://${store}/admin/api/${API_VERSION}/graphql.json`;

async function main() {
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const items = (plan.products || []).filter((p) => !args.only || String(p.id).includes(String(args.only)));

  console.log(c.bold(`\nCatalog fixes — ${store}`));
  kv('admin API', API_VERSION);
  kv('plan', `${planPath} (${items.length} product${items.length === 1 ? '' : 's'})`);
  kv('mode', apply ? c.yellow('APPLY — this writes to the store') : c.green('dry run'));

  let changed = 0;
  let failed = 0;

  for (const item of items) {
    const gid = item.id.startsWith('gid://') ? item.id : `gid://shopify/Product/${item.id}`;
    console.log(`\n${c.bold(item.title || gid)}  ${c.dim(gid)}`);

    const current = await getProduct(gid);
    if (!current) {
      console.log(`    ${c.red('✗')} not found in this store`);
      failed += 1;
      continue;
    }

    /* ---- Unpublish: the right fix for test data and placeholders ---- */
    if (item.action === 'unpublish') {
      console.log(`    ${c.yellow('→')} unpublish from all sales channels  ${c.dim(item.reason || '')}`);
      if (apply) {
        const res = await gql(UNPUBLISH, { id: gid });
        if (reportErrors(res, 'publishableUnpublish')) failed += 1; else changed += 1;
      }
      continue;
    }

    /* ---- Product fields ---- */
    const input = { id: gid };
    if (item.title && item.title !== current.title) {
      console.log(`    title        ${c.dim(current.title)} → ${c.green(item.title)}`);
      input.title = item.title;
    }
    if (item.descriptionHtml) {
      const words = item.descriptionHtml.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).length;
      console.log(`    description  ${c.dim(`${wordCount(current.descriptionHtml)} words`)} → ${c.green(`${words} words`)}`);
      input.descriptionHtml = item.descriptionHtml;
    }
    if (item.productType) {
      console.log(`    type         ${c.dim(current.productType || '—')} → ${c.green(item.productType)}`);
      input.productType = item.productType;
    }
    if (item.vendor) {
      console.log(`    vendor       ${c.dim(current.vendor || '—')} → ${c.green(item.vendor)}`);
      input.vendor = item.vendor;
    }
    if (item.category) {
      console.log(`    category     ${c.dim(current.category?.fullName || '—')} → ${c.green(item.category)}`);
      input.category = item.category;
    }
    if (item.tags) {
      console.log(`    tags         ${c.green(item.tags.join(', '))}`);
      input.tags = item.tags;
    }

    const hasProductChange = Object.keys(input).length > 1;
    if (hasProductChange && apply) {
      const res = await gql(PRODUCT_UPDATE, { product: input });
      if (reportErrors(res, 'productUpdate')) { failed += 1; continue; }
    }

    /* ---- Variant prices ---- */
    if (item.price != null) {
      const variants = current.variants.map((v) => ({ id: v.id, price: String(item.price) }));
      console.log(`    price        ${c.dim(current.variants.map((v) => v.price).join(', '))} → ${c.green(String(item.price))} ${c.dim(`(${variants.length} variant${variants.length === 1 ? '' : 's'})`)}`);
      if (apply) {
        const res = await gql(VARIANTS_UPDATE, { productId: gid, variants });
        if (reportErrors(res, 'productVariantsBulkUpdate')) { failed += 1; continue; }
      }
    }

    if (!hasProductChange && item.price == null) console.log(`    ${c.dim('nothing to change')}`);
    else changed += 1;
  }

  console.log(`\n${apply ? c.green(`Applied changes to ${changed} product(s).`) : c.dim(`Dry run: ${changed} product(s) would change.`)}` +
    (failed ? ` ${c.red(`${failed} failed.`)}` : ''));
  if (!apply) console.log(c.dim('Re-run with --apply to write, then re-run scripts/audit-catalog.mjs.\n'));
  else console.log(c.dim('Now re-run: node scripts/audit-catalog.mjs --markdown docs/catalog-audit.md\n'));
}

/* ------------------------------------------------------------------ *
 * Admin API
 * ------------------------------------------------------------------ */

async function gql(query, variables) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Admin API HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = JSON.parse(text);
  if (body.errors) throw new Error(`Admin API: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data;
}

/** userErrors are how Shopify reports a rejected mutation; a 200 is not success. */
function reportErrors(data, field) {
  const errs = (data && data[field] && data[field].userErrors) || [];
  for (const e of errs) console.log(`    ${c.red('✗')} ${(e.field || []).join('.')}: ${e.message}`);
  return errs.length > 0;
}

async function getProduct(id) {
  const data = await gql(PRODUCT_QUERY, { id });
  const p = data.product;
  if (!p) return null;
  return { ...p, variants: p.variants.nodes };
}

const PRODUCT_QUERY = `
  query($id: ID!) {
    product(id: $id) {
      id title descriptionHtml productType vendor tags
      category { fullName }
      variants(first: 100) { nodes { id price } }
    }
  }`;

const PRODUCT_UPDATE = `
  mutation($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id title }
      userErrors { field message }
    }
  }`;

const VARIANTS_UPDATE = `
  mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }`;

const UNPUBLISH = `
  mutation($id: ID!) {
    publishableUnpublish(id: $id, input: []) {
      publishable { availablePublicationsCount { count } }
      userErrors { field message }
    }
  }`;

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

function resolveToken(a) {
  if (a['token-file']) return readFileSync(a['token-file'], 'utf8').trim();
  const t = process.env.SHOPIFY_ADMIN_TOKEN;
  if (t) return t.trim();
  console.error(`\n${c.red('✗')} No Admin API token.\n\n` +
    '  Shopify admin → Settings → Apps and sales channels → Develop apps → Create an app\n' +
    '  Admin API scopes: read_products, write_products, read_publications, write_publications\n' +
    '  Install, reveal the token, then:\n\n' +
    '    export SHOPIFY_ADMIN_TOKEN="shpat_…"\n\n' +
    '  Keep it out of this repository.\n');
  process.exit(1);
}

const wordCount = (html) => String(html || '').replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    if (key === 'apply') out.apply = true;
    else out[key] = argv[++i];
  }
  return out;
}

main().catch((err) => {
  console.error(`\n${c.red('✗')} ${err.message}\n`);
  process.exit(1);
});
