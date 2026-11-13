# Store readiness — `hotwire-resistor.myshopify.com`

Everything in the **Verified** sections below was observed directly against the live
store on 2026-11-12, through the store's own UCP endpoints. The catalog section
records changes that have since been applied. Everything in
**Needs confirming** is flagged as such because Shopify's public documentation does
not state it and third-party write-ups disagree.

---

## Verified working

| Check | Result |
| --- | --- |
| `GET /.well-known/ucp` | HTTP 200, `ucp.version = 2026-08-25` |
| Older versions offered | `2026-04-08`, `2026-01-23` |
| MCP endpoint | `https://hotwire-resistor.myshopify.com/api/ucp/mcp` |
| Capabilities advertised | 13, including cart, checkout, order, fulfillment, discount, buyer consent, catalog search and lookup, identity linking, permalink |
| `search_catalog` | returns products |
| `get_product` | returns the full option matrix |
| `create_cart` | returns a real cart id, ordered totals and a `continue_url` |
| CORS | `Access-Control-Allow-Origin: *` on the storefront endpoint |

The protocol side of this store is already correct. **Nothing in the UCP plumbing
needs fixing.** The two gaps below are about what the store *exposes* and what it
*can settle*.

---

## Gap 1 — the store is not in Shopify's global catalog

### What was observed

Searching the global catalog (`catalog.shopify.com/api/ucp/mcp`) for this store's own
exact product titles — `wandering waterfall`, `floral grass`, `Stomper` — returned
**zero** results from `hotwire-resistor.myshopify.com`, while `hotwire resistor pedal`
returned 845 products from other sellers. The same titles return immediately from the
store's own storefront catalog.

So: an agent that is *told* about this store finds it instantly and can transact.
An agent doing open-ended discovery does not reach it.

### What this means for the demo

The demo shows both paths side by side and labels them honestly. A cross-merchant
result carries its own `seller.domain`, and the demo will discover and cart at that
seller — real cross-merchant behaviour, just not with this store as the seller.

### What to check, in order

1. **Sales channel publication.** In Shopify admin, `Sales channels → Agentic`
   (some accounts show it under `Settings → Apps and sales channels`). Confirm the
   channel is enabled and that products are published to it. Only 9 products are
   currently visible to agents — if the store holds more, the rest are unpublished to
   this channel.
2. **Development-store eligibility.** *Partly answered.* Shopify's docs say the
   global catalog returns products from "any eligible merchant" without defining
   eligible. Development stores cannot process real payments, which is consistent
   with what this store advertises (see Gap 2). But the Dev Dashboard's store picker
   does list at least one plainly-generated dev-store domain, so dev stores are not
   categorically excluded — this store specifically has not been indexed.
3. **Product eligibility.** Products with no price, no category and no image are
   routinely excluded. Four of the nine products here are priced at zero and four have
   no category — see [`catalog-audit.md`](catalog-audit.md).
4. **A saved catalog — tried, and ruled out.** The Dev Dashboard lets you save a
   catalog configuration scoped to specific stores. Checked 13 November 2026: the
   **Specific stores** picker searches stores already in the catalog index, and
   `hotwire-resistor` returns *No matching stores*. A saved catalog narrows that
   index rather than adding to it, so there is nothing to scope. Full write-up in
   [`saved-catalog.md`](saved-catalog.md). The tooling is kept for the day the store
   is indexed.

---

## Gap 2 — no agent-completable payment

The store's profile publishes `"payment_handlers": {}` — an empty object. No payment
handler means no method an agent can settle on its own, so `complete_checkout` returns
`requires_escalation` and the buyer finishes at the store's own checkout via
`continue_url`.

This is a **valid UCP lifecycle outcome, not an error**, and the demo treats it as
one. To close it, the store needs an active payment provider that supports agentic
checkout — which a development store cannot have. On a production store, enable
Shopify Payments and the agentic checkout terms, then re-run
`node scripts/demo-cycle.mjs` and watch `payment_handlers` fill in.

---

## Gap 3 — catalog quality — largely closed

Full detail in [`catalog-audit.md`](catalog-audit.md); regenerate any time with:

```bash
node scripts/audit-catalog.mjs --markdown docs/catalog-audit.md
```

**Catalog average: 86%**, up from 67%. Six products are exposed to agents, down from
nine, and three of the six now score 100%.

### Applied on 2026-11-12

Through [`scripts/fix-catalog.mjs`](../scripts/fix-catalog.mjs), from
[`data/catalog-plan.json`](../data/catalog-plan.json):

| Product | Change |
| --- | --- |
| `booger with no product` | set to **draft** — test data, zero price |
| `Test 2022 new App Product` | set to **draft** — test data, zero price |
| `BLACK GLASSES WITH BLACK RIMS` | set to **draft** — zero price, no category |
| `Pedal Insurance` | retitled, 104-word description, type `Service Plan`, and **tiered pricing**: the `Order Value` axis (100–2000) was entirely zero-priced and is now 10% of covered value (CA$10–200) |
| `floral grass` → `Floral Grass — Giclée Print` | retitled, 77-word description, type `Print`, vendor corrected from `Liquid Logic`. Its small/medium/large prices (1000/800/600) were **left alone** — the size axis is real and the spread is yours to set |
| `wandering waterfall` → `Wandering Waterfall — Giclée Print` | retitled, 63-word description, type `Print`, vendor corrected from `Sweet Protection` |

Drafts are reversible: flip the product's status back to Active in Shopify admin.

### Held, pending your decision

Two products were deliberately **not** rewritten. Reading the Admin API rather than
the titles showed that what they are is genuinely unclear, and a confident description
of the wrong product is the worst thing an agentic catalog can contain:

- **`Stomper`** — 15 variants on a `Size` axis of 16–44 even. That is an apparel size
  run, not hardware, and the existing women's one-piece swimsuit description is
  consistent with it. So the *title* may be the placeholder rather than the body.
  It still carries another company's support address in the copy, which should go
  either way.
- **`700r4`** — one variant at CA$480, product type `collection`, 18 words that never
  mention the product. `700R4` reads as a GM transmission, but nothing in the store's
  own data confirms it.

### Still open on the products that were fixed

- `Pedal Insurance` has **no image** and **no taxonomy category**. Both need a human:
  an image file, and a category judgement for a service plan rather than a good.

The headline problems, in the order they hurt an agent:

1. **Descriptions that describe a different product.** `Stomper` — a product an agent
   will read as footwear or a pedal — carries a women's one-piece swimsuit
   description, ending with another company's support address. `700r4` has 18 words
   that never mention the product. This is worse than an empty description: an agent
   will confidently tell a buyer the wrong thing, and it is the single most damaging
   fault in the catalog.
2. **Two products with no description at all** (`floral grass`, `wandering waterfall`).
   An agent has nothing to rank on and nothing to say.
3. **Four products priced at zero** — `booger with no product`,
   `Test 2022 new App Product`, `Pedal Insurance`, `BLACK GLASSES WITH BLACK RIMS`.
   Agents read a zero price as a placeholder or an unsellable item.
4. **Two obvious test products** still published to agents. These are what an agent
   would quote to a buyer.
5. **Four products with no taxonomy category.** Categories are what saved catalogs and
   agent filters narrow on.
6. **`Pedal Insurance` has no image.**

### What good looks like

For a store called *hotwire-resistor*, an agentic-ready product reads like something a
buyer would ask for out loud, and answers the next three questions without a follow-up:

> **Hotwire 500Ω Linear Taper Potentiometer — 16mm, Solder Lug**
>
> A 500Ω linear-taper potentiometer for pedal and amp builds. 16mm body, 6mm knurled
> split shaft, three solder lugs, 1/4W. Linear taper gives even travel across the
> sweep, which is what you want for bias, gain and blend controls rather than volume.
> Fits standard 7mm panel holes; nut and washer included. Tolerance ±20%.

Title says brand, value and form factor. Body gives specification, application,
compatibility and what is in the box. Price non-zero, category assigned, image
attached, option names real (`Resistance`, not `Title`).

`scripts/fix-catalog.mjs` applies changes in this shape through the Admin API.

---

## Order of work

1. ~~Fix or unpublish the test products and the zero-price products.~~ Done.
2. ~~Replace the empty descriptions.~~ Done for the two prints.
3. Decide what `Stomper` and `700r4` actually are, then rewrite them.
4. Add an image and a category to `Pedal Insurance`.
5. Confirm the agentic sales channel is publishing everything you intend — six
   products are visible to agents; if the store holds more, the rest are unpublished
   to that channel.
6. ~~Decide between waiting on global-catalog eligibility and shipping a saved
   catalog scoped to this store.~~ The saved catalog is not available — the store is
   not in the index the picker searches. Global-index eligibility is the only route,
   and steps 3–5 are what make the store a plausible candidate for it.

---

## A note on publishing the agent's own profile

Not merchant-side, but it belongs with the verified findings.

Shopify validates the `Cache-Control` header on the agent profile URL passed in
`meta.ucp-agent.profile`. GitHub Pages serves JSON as `max-age=600`, which is
rejected with `profile_malformed: Invalid cache control`, and Pages gives no way to
change it. Serving the same file from the repository through jsDelivr
(`public, max-age=604800`, `application/json`) is accepted. Both results were
observed against this store, not inferred.
