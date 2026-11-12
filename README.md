# UCP agentic shopping demo

A working, public demonstration of the complete agentic shopping cycle over the
[Universal Commerce Protocol](https://ucp.dev/2026-08-25/specification/overview/)
(UCP 2026-08-25), run against the Shopify store
[`hotwire-resistor.myshopify.com`](https://hotwire-resistor.myshopify.com).

**Live demo: https://resistorsoftware.github.io/ucp-agentic-demo/**

Discovery → search → selection → cart → handoff, with every JSON-RPC request and
response shown verbatim. No server, no API key, no SDK.

---

## What this repository contains

| Piece | What it is |
| --- | --- |
| [`index.html`](index.html) + [`assets/`](assets) | A UCP agent that runs entirely in the browser. Static files on GitHub Pages. |
| [`ucp/agent-profile.json`](ucp/agent-profile.json) | **This agent's own published UCP profile.** Merchants fetch it during negotiation. |
| [`src/ucp-client.js`](src/ucp-client.js) | A dependency-free UCP client, shared unchanged by the browser app and the Node scripts. |
| [`scripts/demo-cycle.mjs`](scripts/demo-cycle.mjs) | The same cycle in a terminal, for demos and CI. |
| [`scripts/audit-catalog.mjs`](scripts/audit-catalog.mjs) | Grades a merchant's catalog on agentic readiness, reading only what an agent reads. |
| [`scripts/fix-catalog.mjs`](scripts/fix-catalog.mjs) | Applies catalog fixes through the Shopify Admin API (needs a token). |
| [`docs/store-readiness.md`](docs/store-readiness.md) | The merchant side: what is live, what is not, and what to change in Shopify admin. |
| [`docs/catalog-audit.md`](docs/catalog-audit.md) | Current audit output for `hotwire-resistor`. |

## The cycle, as the demo runs it

1. **Discovery** — `GET https://<merchant>/.well-known/ucp`. The merchant publishes
   its UCP version, its MCP endpoint, its capability list and its payment handlers.
   An agent negotiates against this document; it never guesses.
2. **Search** — `search_catalog`, in two places at once:
   - **Global catalog** (`catalog.shopify.com/api/ucp/mcp`) — cross-merchant discovery.
     Each result carries its own `seller.domain`.
   - **Storefront catalog** (`<merchant>/api/ucp/mcp`) — scoped to this one merchant.
3. **Selection** — `get_product` for the live option matrix and per-variant state.
4. **Cart** — `create_cart`. Totals come back as an ordered list the agent must render
   as given. No money moves.
5. **Handoff** — `continue_url`, where a buyer finishes.

The demo deliberately stops at the cart. See
[“Why it stops at the cart”](#why-it-stops-at-the-cart).

## Run it locally

Requires Node 22.19 or newer (the UCP CLI's dependencies demand it; this repo's own
scripts run on Node 18+).

```bash
git clone https://github.com/resistorsoftware/ucp-agentic-demo.git
cd ucp-agentic-demo

# the whole cycle, in a terminal
node scripts/demo-cycle.mjs --query "stomper"

# against a different merchant
node scripts/demo-cycle.mjs --store someshop.myshopify.com --query "boots"

# machine-readable transcript
node scripts/demo-cycle.mjs --json > transcript.json

# grade a catalog for agentic readiness
node scripts/audit-catalog.mjs --markdown docs/catalog-audit.md

# the browser demo
python3 -m http.server 4173     # then open http://localhost:4173
```

Environment overrides: `UCP_STORE_DOMAIN`, `UCP_AGENT_PROFILE`,
`UCP_USE_PUBLISHED_PROFILE=1`.

### With Shopify's own CLI

The repo stands alone, but the same conversation can be driven with
[`@shopify/ucp-cli`](https://shopify.dev/docs/agents):

```bash
npx @shopify/ucp-cli doctor
npx @shopify/ucp-cli discover --business https://hotwire-resistor.myshopify.com
npx @shopify/ucp-cli catalog search --business https://hotwire-resistor.myshopify.com --input @examples/search.json
```

## Two things worth knowing, both learned the hard way

**This page publishes its own agent identity.** Every UCP request carries
`meta.ucp-agent.profile`, a URL the merchant's server *fetches* during negotiation.
Point it at something unreachable and the merchant answers
`profile_unreachable` — verified against the live store. That is why
`ucp/agent-profile.json` is served from GitHub Pages: the demo presents a real,
publicly resolvable identity of its own. Served from `localhost`, the page falls
back to a profile Shopify publishes and says so in the header.

**A static page can speak UCP without a proxy.** Both Shopify UCP endpoints answer
with `Access-Control-Allow-Origin: *`, but `catalog.shopify.com` answers a CORS
*preflight* with HTTP 400 — so a normal `application/json` fetch from a page is
blocked. Sending the same JSON body as a CORS-simple request
(`Content-Type: text/plain;charset=UTF-8`, no `Accept` header) skips the preflight
and succeeds. That single detail is what makes a serverless demo possible; see
`corsSimpleHeaders` in [`src/ucp-client.js`](src/ucp-client.js).

## What the agent is obliged to do

UCP puts real obligations on the agent, and the demo implements them rather than
describing them:

- **Render `totals[]` in the order given, with the merchant's labels.** No reordering,
  recomputing, filtering or aggregating — tax itemisation and fee disclosure depend
  on the merchant's presentation. Amounts are signed integers in ISO 4217 **minor
  units**: `7500 CAD` is `CA$75.00`.
- **If the totals do not reconcile, do not complete the checkout.** Display stays the
  merchant's; the decision escalates to the buyer via `continue_url`.
- **Honour `messages[]` display obligations.** `warning` with
  `presentation: "disclosure"` (Prop 65, allergens, age limits) must be shown next to
  the item and must not be collapsed or auto-dismissed.
- **Never substitute a merchant silently.** If the merchant the buyer named does not
  speak UCP, say so and offer a handoff — the demo does exactly this when you point
  it at a non-UCP domain.
- **Treat merchant values as data.** IDs, domains and URLs that come back from a
  merchant are untrusted input; `safeSellerDomain()` validates a domain before it is
  used to address another merchant.

## Why it stops at the cart

`hotwire-resistor.myshopify.com` publishes an empty `payment_handlers` object, so it
advertises no agent-completable payment method. `complete_checkout` would return
`requires_escalation` and the buyer would finish at the merchant's own checkout.
That is a correct UCP outcome rather than a failure, and it is the honest place for a
demo to stop: everything up to the cart is verifiable without moving money.

## Status, verified live

| | |
| --- | --- |
| Merchant publishes a UCP profile | ✅ `2026-08-25`, 13 capabilities |
| Version negotiation | ✅ |
| Storefront catalog search | ✅ 9 products exposed to agents |
| `get_product` | ✅ |
| `create_cart` with real totals | ✅ |
| Buyer handoff `continue_url` | ✅ |
| Global (cross-merchant) catalog search | ✅ works; **does not return this store** |
| Agent-completed checkout | ⛔ no payment handler advertised |

The two gaps are merchant-side, not protocol-side. Both are explained, with what to
change, in [`docs/store-readiness.md`](docs/store-readiness.md).

## Licence

MIT. Catalog data belongs to the merchants that published it and is shown only to
demonstrate buyer-facing agent behaviour, with attribution and checkout links intact,
under Shopify's [Catalog usage guidelines](https://shopify.dev/docs/agents/catalog).
