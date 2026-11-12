# Store readiness — `hotwire-resistor.myshopify.com`

Everything in the **Verified** sections below was observed directly against the live
store on 2026-11-12, through the store's own UCP endpoints. Everything in
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
2. **Development-store eligibility.** *Needs confirming.* Shopify's docs say the
   global catalog returns products from "any eligible merchant" without defining
   eligible. Development stores cannot process real payments, which is consistent
   with what this store advertises (see Gap 2) and is the most likely reason it is
   absent. Confirm with Shopify whether a dev store can ever be listed.
3. **Product eligibility.** Products with no price, no category and no image are
   routinely excluded. Four of the nine products here are priced at zero and four have
   no category — see [`catalog-audit.md`](catalog-audit.md).
4. **A saved catalog, as a deterministic alternative.** In the Shopify Dev Dashboard
   you can save a catalog configuration scoped to a single store and get a custom
   catalog URL for it. That makes "agentic search finds my store" reproducible for a
   demo without waiting on global-catalog eligibility. This is the recommended next
   step if the store stays out of the global index.

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

## Gap 3 — catalog quality

Full detail in [`catalog-audit.md`](catalog-audit.md); regenerate any time with:

```bash
node scripts/audit-catalog.mjs --markdown docs/catalog-audit.md
```

Current catalog average: **67%** across the 9 products exposed to agents.

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

1. Fix or unpublish the two test products and the four zero-price products.
2. Replace the mismatched and empty descriptions.
3. Assign taxonomy categories and images.
4. Re-run the audit; aim above 85%.
5. Confirm the agentic sales channel is publishing everything you intend.
6. Decide between waiting on global-catalog eligibility and shipping a saved catalog
   scoped to this store.
