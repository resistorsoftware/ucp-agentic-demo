/**
 * The browser agent.
 *
 * It uses the same `src/ucp-client.js` module the Node scripts use, so what you
 * see here is not a mock: it is the UCP conversation, run from the page.
 */
import {
  GLOBAL_CATALOG_ENDPOINT,
  UcpError,
  createCart,
  descriptionText,
  discoverBusiness,
  formatMoney,
  handoffUrl,
  messageObligation,
  pickVariant,
  safeSellerDomain,
  searchCatalog,
  totalsForDisplay,
  totalsReconcile,
} from '../src/ucp-client.js?v=2';
import { DEFAULT_CONTEXT, PUBLISHED_AGENT_PROFILE } from '../src/config.js?v=2';

const $ = (id) => document.getElementById(id);
const exchanges = [];

/* ------------------------------------------------------------------ *
 * Our identity
 *
 * Every UCP request carries `meta.ucp-agent.profile`, a URL the merchant's
 * server fetches during negotiation. Two things must hold, and both were
 * learned by being rejected:
 *
 *   1. It must be publicly reachable. A localhost URL fails outright.
 *   2. Its `Cache-Control` must satisfy the merchant. GitHub Pages sends
 *      `max-age=600`, which Shopify rejects as `Invalid cache control`.
 *
 * So the profile is served from this same repository through jsDelivr, which
 * sends `public, max-age=604800`. That URL works from anywhere — including a
 * page opened on localhost — so the demo always presents its own identity and
 * never has to borrow one.
 * ------------------------------------------------------------------ */
function resolveAgentProfile() {
  const override = new URLSearchParams(window.location.search).get('profile');
  if (override) return { url: override, own: false, reason: 'overridden by the ?profile= query parameter' };
  return { url: PUBLISHED_AGENT_PROFILE, own: true };
}

const AGENT = resolveAgentProfile();
const callOpts = { agentProfile: AGENT.url, onExchange: (e) => { exchanges.push(e); renderLog(); } };

$('idProfile').textContent = AGENT.url;
$('idProfileState').textContent = AGENT.own ? '(published by this repo)' : '(overridden)';
$('idProfileState').className = AGENT.own ? '' : 'unreachable';

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

$('run').addEventListener('click', run);
$('reset').addEventListener('click', reset);
$('query').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
$('store').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

function reset() {
  exchanges.length = 0;
  for (const id of ['stepDiscover', 'stepSearch', 'stepCart', 'stepLog']) $(id).hidden = true;
  $('globalResults').innerHTML = '';
  $('storeResults').innerHTML = '';
  $('cartBody').innerHTML = '';
  $('logBody').innerHTML = '';
}

async function run() {
  const store = $('store').value.trim();
  const query = $('query').value.trim();
  if (!store || !query) return;

  reset();
  busy(true);
  try {
    /* ---- 1. Discovery ---- */
    $('stepDiscover').hidden = false;
    $('discoverBody').innerHTML = '<span class="spinner"></span>';
    const biz = await discoverBusiness(store);
    $('idStore').textContent = biz.domain;
    renderDiscovery(biz);

    /* ---- 2. Search, both catalogs at once ---- */
    $('stepSearch').hidden = false;
    $('stepLog').hidden = false;
    $('storeEndpointLabel').textContent = biz.endpoint || '—';
    $('globalResults').innerHTML = '<span class="spinner"></span>';
    $('storeResults').innerHTML = '<span class="spinner"></span>';

    const context = { ...DEFAULT_CONTEXT, intent: query };
    const [globalRes, storeRes] = await Promise.allSettled([
      searchCatalog({ endpoint: GLOBAL_CATALOG_ENDPOINT, query, context, limit: 8 }, callOpts),
      searchCatalog({ endpoint: biz.endpoint, query, context, limit: 8 }, callOpts),
    ]);

    renderResults($('globalResults'), globalRes, { crossMerchant: true, fallbackDomain: null, biz });
    renderResults($('storeResults'), storeRes, { crossMerchant: false, fallbackDomain: biz.domain, biz });

    /* ---- 3. Cart: first result from this merchant, if there is one ---- */
    const storeProducts = storeRes.status === 'fulfilled' ? storeRes.value.products : [];
    if (storeProducts.length) {
      await addToCart(storeProducts[0], biz.domain, biz.endpoint);
    } else {
      $('stepCart').hidden = false;
      $('cartBody').innerHTML = note('bad',
        `<p><b>No cart to build.</b> ${esc(biz.domain)} returned nothing for “${esc(query)}”.</p>
         <p>Either no product matches, or matching products are not published to the agentic sales channel.</p>`);
    }
  } catch (err) {
    showError(err);
  } finally {
    busy(false);
  }
}

function busy(on) {
  $('run').disabled = on;
  $('run').textContent = on ? 'Running…' : 'Run the full cycle';
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderDiscovery(biz) {
  const capList = biz.capabilities
    .map((cap) => `<span class="cap on">${esc(cap)}</span>`)
    .join('');

  let notes = '';
  if (!AGENT.own) {
    notes += note('', `<p><b>Agent identity ${esc(AGENT.reason)}.</b> The merchant is negotiating against that profile instead of this repo's own.</p>`);
  }
  notes += biz.paymentHandlers.length
    ? note('good', `<p><b>Agent-completable payment:</b> ${biz.paymentHandlers.map(esc).join(', ')}. An agent can complete checkout without handing the buyer off.</p>`)
    : note('', `<p><b>No agent payment handler advertised.</b> <code>payment_handlers</code> is empty, so <code>complete_checkout</code> would return <code>requires_escalation</code> and the buyer finishes at the merchant's own checkout. That is a correct UCP outcome, not a failure — and it is why this demo stops at the cart.</p>`);

  $('discoverBody').innerHTML = `
    <dl class="facts">
      <dt>profile</dt><dd><a href="${esc(biz.profileUrl)}" target="_blank" rel="noopener">${esc(biz.profileUrl)}</a></dd>
      <dt>negotiated</dt><dd>${esc(biz.version || '—')}${biz.supportedVersions.length ? ` <span style="color:var(--muted)">(also offers ${biz.supportedVersions.map(esc).join(', ')})</span>` : ''}</dd>
      <dt>transport</dt><dd>mcp</dd>
      <dt>endpoint</dt><dd>${esc(biz.endpoint || '—')}</dd>
      <dt>capabilities</dt><dd><div class="caps">${capList}</div></dd>
    </dl>${notes}`;
}

function renderResults(host, settled, { crossMerchant, fallbackDomain, biz }) {
  if (settled.status === 'rejected') {
    host.innerHTML = note('bad', `<p>${esc(settled.reason?.message || 'search failed')}</p>`);
    return;
  }
  const { products } = settled.value;
  if (!products.length) {
    host.innerHTML = `<p class="empty">No results.</p>`;
    return;
  }

  host.innerHTML = '';
  for (const p of products) {
    const variant = pickVariant(p) || {};
    const seller = safeSellerDomain(variant.seller?.domain) || fallbackDomain;
    const min = p.price_range?.min;
    const img = (p.media || []).find((m) => m && (m.url || m.preview_url));
    const desc = descriptionText(p);
    const isThisMerchant = seller && biz && seller === biz.domain;

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      ${img ? `<img src="${esc(img.url || img.preview_url)}" alt="" loading="lazy">` : '<img alt="">'}
      <div class="meta">
        <p class="t">${esc(p.title || '(untitled)')}</p>
        <div class="p">${esc(formatMoney(min?.amount, min?.currency))}</div>
        ${crossMerchant ? `<div class="seller">${esc(seller || 'unknown seller')}${isThisMerchant ? ' ← this merchant' : ''}</div>` : ''}
        ${desc
          ? `<p class="d">${esc(desc)}</p>`
          : crossMerchant
            /* Global-catalog search returns trimmed records; the full description
               lives behind get_product. Only the merchant-scoped column, which
               does return descriptions, is worth critiquing here. */
            ? '<p class="d">—</p>'
            : '<p class="d" style="color:var(--bad)">no description — an agent has nothing to tell the buyer</p>'}
        <div class="row"></div>
      </div>`;

    const row = card.querySelector('.row');
    /* A cart can only be built where we can negotiate. For a cross-merchant
       result that is the seller's own UCP endpoint, not this merchant's. */
    if (isThisMerchant || !crossMerchant) {
      const btn = document.createElement('button');
      btn.className = 'small';
      btn.textContent = 'Add to cart';
      btn.addEventListener('click', () => addToCart(p, seller, biz.endpoint, btn));
      row.appendChild(btn);
    } else if (seller) {
      const btn = document.createElement('button');
      btn.className = 'small ghost';
      btn.textContent = `Cart at ${seller}`;
      btn.title = 'Discovers that merchant over UCP, then carts there';
      btn.addEventListener('click', () => cartAtOtherMerchant(p, seller, btn));
      row.appendChild(btn);
    }
    const pdp = variant.url || p.url;
    if (pdp) {
      const a = document.createElement('a');
      a.href = pdp;
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.cssText = 'font-size:12px';
      a.textContent = 'product page';
      row.appendChild(a);
    }
    host.appendChild(card);
  }
}

/** Cart at the merchant we already negotiated with. */
async function addToCart(product, domain, endpoint, btn) {
  if (btn) btn.disabled = true;
  $('stepCart').hidden = false;
  $('cartBody').innerHTML = '<span class="spinner"></span>';
  try {
    const variant = pickVariant(product);
    if (!variant) throw new UcpError('This product exposes no variants to add.');
    const { cart } = await createCart({
      endpoint,
      lineItems: [{ item: { id: variant.id }, quantity: 1 }],
      context: { address_country: DEFAULT_CONTEXT.address_country },
    }, callOpts);
    renderCart(cart, product, variant, domain);
  } catch (err) {
    $('cartBody').innerHTML = errorHtml(err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * The cross-merchant case: a global-catalog result belongs to another seller,
 * so the agent discovers that seller and carts there. One cart per seller.
 */
async function cartAtOtherMerchant(product, domain, btn) {
  btn.disabled = true;
  $('stepCart').hidden = false;
  $('cartBody').innerHTML = '<span class="spinner"></span>';
  try {
    const other = await discoverBusiness(domain);
    await addToCart(product, other.domain, other.endpoint);
  } catch (err) {
    const url = handoffUrl({ variant: pickVariant(product), product, domain });
    $('cartBody').innerHTML = note('bad',
      `<p><b>${esc(domain)} did not complete UCP negotiation.</b> ${esc(err.message)}</p>
       <p>The correct agent behaviour is to say so rather than substituting a different
          merchant, and to hand the buyer off:
          ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : 'no handoff URL available'}.</p>`);
  } finally {
    btn.disabled = false;
  }
}

function renderCart(cart, product, variant, domain) {
  const rows = totalsForDisplay(cart.totals, cart.currency);
  const rec = totalsReconcile(cart.totals);
  const url = handoffUrl({ continueUrl: cart.continueUrl, variant, product, domain });

  const totalsHtml = rows.length
    ? `<table class="totals">${rows.map((r) => `
        <tr class="${r.type === 'total' ? 'total' : ''}"><td>${esc(r.label)}</td><td class="amt">${esc(r.amount)}</td></tr>
        ${r.lines.map((l) => `<tr class="sub"><td>${esc(l.label)}</td><td class="amt">${esc(l.amount)}</td></tr>`).join('')}
      `).join('')}</table>`
    : '<p class="empty">The merchant returned no totals.</p>';

  const messagesHtml = (cart.messages || []).map((m) => {
    const ob = messageObligation(m);
    const label = { disclosure: 'Must be shown', notice: 'Notice', info: 'Info', error: 'Error' }[ob] || 'Info';
    return `<div class="msg ${ob}"><span class="lbl">${label}</span>${esc(m.content || m.code || '')}</div>`;
  }).join('');

  $('cartBody').innerHTML = `
    <dl class="facts">
      <dt>merchant</dt><dd>${esc(domain)}</dd>
      <dt>product</dt><dd>${esc(product.title || '')}</dd>
      <dt>variant</dt><dd>${esc(variant.id)}</dd>
      <dt>cart id</dt><dd>${esc(cart.id || '—')}</dd>
    </dl>
    <h3 style="margin:18px 0 6px;font-size:13px">Totals</h3>
    <p class="hint">
      Rendered in the order the merchant sent them, with the merchant's own labels.
      An agent must not reorder, recompute or aggregate these — tax itemisation and fee
      disclosure depend on the merchant's presentation.
    </p>
    ${totalsHtml}
    ${rec.checked ? note(rec.ok ? 'good' : 'bad', rec.ok
      ? '<p>Line entries sum to the stated total.</p>'
      : '<p><b>Totals do not reconcile.</b> The merchant\'s totals still stand for display, but an agent must not complete this checkout on its own — escalate to the buyer for review.</p>') : ''}
    ${messagesHtml}
    ${url ? `<p style="margin-top:16px"><a href="${esc(url)}" target="_blank" rel="noopener"><b>Hand off to the buyer →</b></a><br>
      <span class="hint">${esc(url)}</span></p>` : ''}
    ${note('', `<p>This is a real, retrievable cart at ${esc(domain)}. The cycle stops here: completing a
      checkout moves money, so it stays a deliberate, separate step.</p>`)}`;
}

function renderLog() {
  $('logBody').innerHTML = exchanges.map((e, i) => {
    let host = '';
    try { host = new URL(e.endpoint).host; } catch { host = e.endpoint; }
    return `
      <details${i === exchanges.length - 1 ? ' open' : ''}>
        <summary>
          <span class="m">${esc(e.toolName)}</span>
          <span class="ms">${e.status} · ${e.ms} ms</span>
          <span class="host">${esc(host)}</span>
        </summary>
        <div class="pair">
          <div><h4>request</h4><pre>${esc(JSON.stringify(e.request, null, 2))}</pre></div>
          <div><h4>response</h4><pre>${esc(trim(JSON.stringify(e.response, null, 2)))}</pre></div>
        </div>
      </details>`;
  }).join('');
}

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */

function showError(err) {
  const host = $('discoverBody').innerHTML.includes('spinner') ? $('discoverBody') : $('cartBody');
  $('stepDiscover').hidden = false;
  host.innerHTML = errorHtml(err);
}

function errorHtml(err) {
  const code = err instanceof UcpError && err.code ? ` <code>${esc(String(err.code))}</code>` : '';
  const cont = err instanceof UcpError && err.continueUrl
    ? `<p>Hand the buyer off: <a href="${esc(err.continueUrl)}" target="_blank" rel="noopener">${esc(err.continueUrl)}</a></p>`
    : '';
  return note('bad', `<p><b>${esc(err.message)}</b>${code}</p>${cont}`);
}

function note(kind, html) {
  return `<div class="note${kind ? ` ${kind}` : ''}">${html}</div>`;
}

function trim(s, n = 24000) {
  return s && s.length > n ? `${s.slice(0, n)}\n… truncated for display` : s;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
