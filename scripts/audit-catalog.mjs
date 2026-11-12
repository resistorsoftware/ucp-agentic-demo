#!/usr/bin/env node
/**
 * Agentic-readiness audit of a merchant's catalog, seen through UCP.
 *
 * This reads exactly what an agent reads — the storefront catalog's own
 * `search_catalog` output — and grades each product on the fields an agent
 * needs to rank it, describe it honestly to a buyer, and add it to a cart.
 *
 * Usage:
 *   node scripts/audit-catalog.mjs [--store <domain>] [--limit 100]
 *                                  [--markdown docs/catalog-audit.md] [--json out.json]
 */
import { writeFileSync } from 'node:fs';
import {
  UcpError,
  descriptionText,
  discoverBusiness,
  formatMoney,
  searchCatalog,
} from '../src/ucp-client.js';
import { agentProfile, buyerContext, c, kv, storeDomain } from '../src/node-env.js';

/**
 * Each check is one thing an agent cannot do without. `weight` is how much of
 * the score it carries; `fix` is what the merchant changes in Shopify admin.
 */
const CHECKS = [
  {
    id: 'title',
    weight: 15,
    label: 'Usable title',
    fix: 'Title the product the way a buyer would ask for it: brand, model, and what it is.',
    run: (p) => {
      const t = (p.title || '').trim();
      if (!t) return bad('no title');
      if (/\b(test|demo|asdf|booger|untitled|copy of|new product|sample)\b/i.test(t)) {
        return bad(`looks like test data ("${t}")`);
      }
      if (t.length < 8) return warn(`very short ("${t}")`);
      if (t === t.toUpperCase() && t.length > 12) return warn('all caps — reads as shouting to a buyer');
      return ok();
    },
  },
  {
    id: 'description',
    weight: 25,
    label: 'Description an agent can quote',
    fix: 'Write 40+ words of specifics: what it does, materials, compatibility, dimensions. No marketing filler.',
    run: (p) => {
      const d = descriptionText(p);
      if (!d) return bad('empty — an agent has nothing to tell the buyer');
      const words = d.split(/\s+/).length;
      if (words < 20) return warn(`only ${words} words`);
      return ok(`${words} words`);
    },
  },
  {
    id: 'description-matches-title',
    weight: 20,
    label: 'Description describes this product',
    fix: 'Replace inherited or sample copy. A mismatched description makes the agent describe the wrong item.',
    run: (p) => {
      const d = descriptionText(p).toLowerCase();
      if (!d) return skip('no description to check');
      const terms = (p.title || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w));
      if (!terms.length) return skip('title has no distinctive words');
      const hits = terms.filter((t) => d.includes(t));
      if (!hits.length) {
        return bad(`description never mentions ${terms.slice(0, 3).map((t) => `"${t}"`).join(', ')}`);
      }
      return ok(`mentions ${hits.slice(0, 3).join(', ')}`);
    },
  },
  {
    id: 'price',
    weight: 15,
    label: 'Real price',
    fix: 'Set a non-zero price, or unpublish the product from the agentic channel.',
    run: (p) => {
      const min = p.price_range?.min?.amount;
      if (min == null) return bad('no price range');
      if (min === 0) return bad('priced at zero — agents read this as unsellable or a placeholder');
      return ok(formatMoney(min, p.price_range?.min?.currency));
    },
  },
  {
    id: 'category',
    weight: 10,
    label: 'Taxonomy category',
    fix: 'Assign a Shopify standard product category; agents and saved catalogs filter on it.',
    run: (p) => {
      const cats = p.categories || [];
      return cats.length ? ok(cats.map((x) => x.name || x.id || x).slice(0, 2).join(', ')) : bad('none');
    },
  },
  {
    id: 'media',
    weight: 5,
    label: 'Image',
    fix: 'Add at least one product image; agent surfaces render it next to the offer.',
    run: (p) => ((p.media || []).length ? ok(`${p.media.length}`) : bad('none')),
  },
  {
    id: 'variants',
    weight: 10,
    label: 'Meaningful variant options',
    fix: 'Name options properly (Size, Colour, Value) and remove "Default Title" placeholders where real options exist.',
    run: (p) => {
      const variants = p.variants || [];
      if (!variants.length) return bad('no variants');
      const opts = (p.options || []).map((o) => o.name).filter(Boolean);
      const placeholder = opts.length === 0 || opts.every((n) => /^(title|default)$/i.test(n));
      if (variants.length > 1 && placeholder) return warn(`${variants.length} variants with no named options`);
      const unavailable = variants.filter((v) => v.available === false).length;
      if (unavailable === variants.length) return bad('every variant is unavailable');
      return ok(opts.length ? `${opts.join(' / ')} · ${variants.length} variants` : `${variants.length} variant`);
    },
  },
];

const STOPWORDS = new Set(['with', 'from', 'this', 'that', 'your', 'ours', 'product', 'item', 'shop']);

const ok = (detail) => ({ status: 'pass', detail });
const warn = (detail) => ({ status: 'warn', detail });
const bad = (detail) => ({ status: 'fail', detail });
const skip = (detail) => ({ status: 'skip', detail });

const SCORE = { pass: 1, warn: 0.5, fail: 0, skip: 1 };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = args.store || storeDomain();
  const profile = agentProfile();
  const limit = Number(args.limit || 100);

  console.log(c.bold(`\nAgentic-readiness audit — ${store}`));
  const biz = await discoverBusiness(store);
  kv('MCP endpoint', biz.endpoint);
  kv('UCP version', biz.version);

  /* An empty query asks the storefront catalog for everything it will expose. */
  const { products } = await searchCatalog(
    { endpoint: biz.endpoint, query: args.query || '', context: buyerContext(), limit },
    { agentProfile: profile },
  );
  kv('products exposed', String(products.length));
  if (!products.length) {
    console.log(c.yellow('\nNothing is exposed to agents. Check that products are published to the agentic sales channel.\n'));
    return;
  }

  const rows = products.map((p) => {
    const results = CHECKS.map((check) => ({ check, result: check.run(p) }));
    const earned = results.reduce((a, r) => a + check_weight(r) * SCORE[r.result.status], 0);
    const possible = results.reduce((a, r) => a + check_weight(r), 0);
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      score: Math.round((earned / possible) * 100),
      results,
      product: p,
    };
  });
  rows.sort((a, b) => a.score - b.score);

  const avg = Math.round(rows.reduce((a, r) => a + r.score, 0) / rows.length);
  console.log(`\n${c.bold('Score')}  ${band(avg)}  ${c.dim('(catalog average)')}\n`);

  for (const row of rows) {
    console.log(`${band(row.score)}  ${c.bold(row.title || '(untitled)')}  ${c.dim(row.id)}`);
    for (const { check, result } of row.results) {
      if (result.status === 'pass' || result.status === 'skip') continue;
      const mark = result.status === 'fail' ? c.red('✗') : c.yellow('!');
      console.log(`        ${mark} ${check.label}: ${result.detail}`);
    }
  }

  const blockers = tally(rows, 'fail');
  console.log(`\n${c.bold('Most common blockers')}`);
  for (const [id, count] of blockers) {
    const check = CHECKS.find((x) => x.id === id);
    console.log(`    ${String(count).padStart(3)} products  ${check.label}`);
    console.log(`                ${c.dim(check.fix)}`);
  }
  console.log();

  if (args.markdown) {
    writeFileSync(args.markdown, markdownReport({ store, biz, rows, avg, blockers }));
    console.log(`${c.green('wrote')} ${args.markdown}`);
  }
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ store, generated: new Date().toISOString(), average: avg, products: rows.map(stripProduct) }, null, 2));
    console.log(`${c.green('wrote')} ${args.json}`);
  }
}

const check_weight = (r) => r.check.weight;

function tally(rows, status) {
  const counts = new Map();
  for (const row of rows) {
    for (const { check, result } of row.results) {
      if (result.status === status) counts.set(check.id, (counts.get(check.id) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function band(score) {
  const label = `${String(score).padStart(3)}%`;
  if (score >= 80) return c.green(label);
  if (score >= 55) return c.yellow(label);
  return c.red(label);
}

function stripProduct(row) {
  return {
    id: row.id,
    title: row.title,
    handle: row.handle,
    score: row.score,
    findings: row.results
      .filter((r) => r.result.status === 'fail' || r.result.status === 'warn')
      .map((r) => ({ check: r.check.id, label: r.check.label, status: r.result.status, detail: r.result.detail, fix: r.check.fix })),
  };
}

function markdownReport({ store, biz, rows, avg, blockers }) {
  const lines = [];
  lines.push(`# Agentic-readiness audit — \`${store}\``, '');
  lines.push(`Generated ${new Date().toISOString().slice(0, 10)} from the store's own UCP storefront catalog (\`${biz.endpoint}\`).`, '');
  lines.push(`**Catalog average: ${avg}%** across ${rows.length} products exposed to agents.`, '');
  lines.push('| Score | Product | Blockers |', '| --- | --- | --- |');
  for (const row of rows) {
    const fails = row.results.filter((r) => r.result.status !== 'pass' && r.result.status !== 'skip');
    lines.push(`| ${row.score}% | ${escapePipe(row.title || '(untitled)')} | ${fails.map((f) => `${f.check.label}: ${escapePipe(f.result.detail)}`).join('<br>') || '—'} |`);
  }
  lines.push('', '## What to fix first', '');
  for (const [id, count] of blockers) {
    const check = CHECKS.find((x) => x.id === id);
    lines.push(`### ${check.label} — ${count} product${count === 1 ? '' : 's'}`, '', check.fix, '');
  }
  lines.push('## How each check is scored', '');
  lines.push('| Check | Weight | Why an agent needs it |', '| --- | --- | --- |');
  for (const check of CHECKS) lines.push(`| ${check.label} | ${check.weight} | ${escapePipe(check.fix)} |`);
  lines.push('');
  return lines.join('\n');
}

const escapePipe = (s) => String(s ?? '').replace(/\|/g, '\\|');

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
    console.error(`\n${c.red('✗ UCP error')} ${err.code || ''}: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
});
