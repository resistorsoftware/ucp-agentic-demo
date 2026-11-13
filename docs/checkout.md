# Checkout, and the three tiers of agent identity

The demo stops one call short of placing an order. That boundary is not where
this repo first assumed it was, and the difference matters.

## What was assumed, and what is true

The earlier claim was: *the store publishes `payment_handlers: {}`, so
`complete_checkout` returns `requires_escalation`.* That describes a real
condition, but it is not the wall the agent actually hits.

Tested against `hotwire-resistor.myshopify.com` on 13 November 2026, with no
credentials of any kind:

| Call | Anonymous result |
| --- | --- |
| `search_catalog` | ✅ works |
| `get_product` | ✅ works |
| `create_cart` | ✅ works, with real totals |
| `create_checkout` | ✅ **works** — real checkout, priced, validated |
| `complete_checkout` | ⛔ `AuthenticationRequired` — *"a valid JWT is required to call complete_checkout"* |

The refusal arrives at the **authentication** layer, before the merchant's
payment configuration is ever consulted. Both facts are true; the auth one is
simply reached first. Fixing `payment_handlers` alone would change nothing for
an anonymous agent.

The practical consequence is better than the old story: a keyless demo can go
all the way to a **fully priced, validated checkout**, not merely a cart.
`scripts/demo-cycle.mjs` now does.

## The three tiers

Shopify grades agents by how well they identify themselves, and grants
capability accordingly.

| Tier | How you identify | Unlocks | Rate limit |
| --- | --- | --- | --- |
| **Anonymous** | nothing but an agent profile URL | catalog, cart, **and checkout** on this endpoint | lowest; shared per-IP pool |
| **Signed** | HTTP Message Signatures (RFC 9421, ECDSA P-256) — public key published in your own UCP profile, **no API key** | cart + checkout | middle |
| **Token** | JWT from a Dev Dashboard agent identity, `Authorization: Bearer` | `complete_checkout`, `get_order` | highest; 5 req/s per client on the Global Catalog |

Shopify's own documentation puts checkout tools out of reach for Anonymous. On
this merchant endpoint they are not — `create_checkout` and `update_checkout`
both answer. Trust the observed behaviour over the table, and re-check it, since
it may well tighten.

### What the Token tier additionally demands

A JWT alone is not enough. Every Token-tier `tools/call` to a *merchant*
endpoint must also carry:

```
Shopify-Buyer-IP: <the real IPv4/IPv6 address of the buyer you act for>
```

There is no placeholder, and Shopify will not fall back to the connecting
address. Omit it and the call fails with HTTP 422. It is not required for
`initialize`, `tools/list`, or Global Catalog requests.

`completeCheckout()` in [`../src/ucp-client.js`](../src/ucp-client.js) refuses to
build a request without both, rather than letting the server reject it.

## The anonymous tier's real cost: rate limits

Capability is not the only thing the tiers grade. Observed while building this,
and worth planning around:

**Checkout creation is metered far more tightly than catalog or cart.** After a
few dozen probe runs, `create_checkout` returned `Rate limit exceeded` while
`create_cart` on the same endpoint kept answering normally in the same run. The
quota is per-operation, not per-endpoint, and the window is long — the error
data carries the real number:

```
Too many requests, please retry after 2967 seconds
```

Roughly fifty minutes. Budget for that before you plan a demo, and read
`err.data`: the top-level message says only "Rate limit exceeded".

Three consequences this repo acts on:

1. **CI does not spend the quota.** `scripts/demo-cycle.mjs --no-checkout`
   stops after the cart. The liveness workflow uses it on every push and runs
   the full cycle only on the daily schedule. A workflow that created a checkout
   on every commit would leave nothing for visitors to the demo page.
2. **The page explains rather than alarms.** A rate limit renders as a neutral
   note saying what it is, not a red failure box — because it *is* the protocol
   working. The earlier steps visibly keep answering, which makes the
   per-operation metering legible instead of confusing.
3. **Anonymous traffic shares one pool.** Shopify limits it per IP, with all
   unauthenticated traffic sharing an overall cap, so throughput is explicitly
   not guaranteed. A popular public demo is exactly the case where this bites.

This is the most concrete argument for the Token tier: a Dev Dashboard
credential gets its own quota — documented at 5 requests per second per client
on the Global Catalog — rather than a share of everyone's.

## The bug that said your store offers no shipping

The delivery step first ran green and wrong: `ready_for_complete`, a shipping
line in the totals, no outstanding errors — and **"options offered: 0"**, where
a hand-written probe had seen three.

The cause is one level of nesting. Delivery options are at:

```
fulfillment.methods[].groups[].options[]
```

A delivery **group** is the unit that gets its own rates. Split a basket across
locations or ship-from points and you get several groups, each with its own
option list and its own `selected_option_id`. A single-item order has exactly
one group — which makes the extra level easy to miss in a truncated dump, and
easy to code past. Reading `methods[].options` finds nothing.

The failure deserves a name, because the output actively argues for its own
correctness: a green status, a plausible total, and a factual claim about the
merchant — *this store offers no delivery options* — that is false and
attributed to them rather than to your parser. Had this shipped, the public
page would have told visitors the store cannot ship.

`deliveryOptions()` now reads groups and plain methods both, and carries the
group id with each option, since selecting one means naming its group.

**A first diagnosis, recorded because it was wrong.** The zero was initially
blamed on `carryLineItems()` sending `{"item":{}}` — `item.id` must be a
product variant id, and the helper looked capable of omitting it. The live
response disproved that: `item.id` was present throughout. The guard added
then still stands (it now takes a `fallbackVariantId` and throws
`LINE_ITEM_UNRESOLVED` rather than sending an unresolvable line), but it fixed
nothing, and the explanation built around it was fiction. A plausible story
about a bug is not evidence of its cause.

One real caution does survive from that detour: `update_checkout` is **full
replace** on `line_items`. Send an empty array and the merchant empties the
checkout, then truthfully reports that it cannot ship an empty order — an error
that reads like a broken shipping zone and is nothing of the kind.

### Transient `-32603`

Also seen once, from `update_checkout`: a bare JSON-RPC `Internal error`. The
identical payload succeeded minutes later. Not every refusal from a live
merchant is deterministic; re-run before you theorise.

## Why the published page stays anonymous

Signed and Token both need a secret — a private signing key or a client secret.
A secret in a static page is a public secret. So:

| Surface | Tier | Ceiling |
| --- | --- | --- |
| GitHub Pages demo | Anonymous | checkout, then handoff |
| `scripts/demo-cycle.mjs` | Anonymous | checkout, then handoff |
| A future CLI with `.env.local` | Token | `complete_checkout` |

There is a second, independent reason the browser cannot reach the Token tier:
an `Authorization` header forces a CORS preflight, and `catalog.shopify.com`
answers preflight requests with HTTP 400. Even a perfectly safe token could not
be used from a page.

## If you want to complete a purchase

You already have the identity — Dev Dashboard → **Agents** → **Agent
identities**, handle `default`. What it needs around it:

1. The client ID and secret from that identity, in `.env.local` (gitignored).
   Never in the repo, never in the page.
2. Permission to complete purchases on the shop's behalf, granted to that
   token. For orders, the `read_global_api_orders` scope — and even then you
   only see orders placed through your own agent.
3. A real buyer IP for the `Shopify-Buyer-IP` header.
4. A payment instrument on the merchant side. `create_checkout` currently
   reports `payment.instruments: []`, so once authentication stops being the
   blocker, the empty handler list becomes the next one — and the checkout
   escalates to `continue_url` rather than completing.

Point 4 is the honest reason to stop here anyway: completing a purchase on this
store would mean moving real money through a development store that advertises
no way to do it.

## What the checkout actually says

Worth reading, because the error messages are the most instructive part of the
response:

```
status  incomplete
        Subtotal  CA$600.00
        Total     CA$600.00
        [recoverable] Missing a valid contact method.
        [recoverable] A destination address is required in order to continue.
        [recoverable] Your cart has been updated and the items you added
                      can't be shipped to your address.
```

Three recoverable errors, each one a thing an agent is expected to resolve with
`update_checkout` or hand the buyer off for. `incomplete` is the correct status,
not a failure.

### The third error is not what it looks like

*"The items you added can't be shipped to your address"* reads like a missing
shipping zone. It was read that way here, and that reading was wrong: the store
has Canadian rates — Standard at CA$0.00 and CA$14.90, Express at CA$21.90 —
configured and working. There is no address on the checkout yet, so there is
nothing to match a zone against. Errors two and three are one root cause.

There is a second way to produce the same message, and it is worth knowing
because the error points at the merchant while the fault is yours:
`update_checkout` is **full replace** on `line_items`. Send an empty array,
and the merchant empties the checkout and then truthfully reports that it
cannot ship an empty order. `carryLineItems()` exists to make that hard to get
wrong.

Supply a destination and carry the items forward, and the checkout reaches:

```
status  ready_for_complete
        → Standard   CA$0.00   3 to 9 business days
          Standard   CA$14.90  3 to 9 business days
          Express    CA$21.90  1 to 2 business days
        Subtotal  CA$600.00
        Shipping  CA$0.00
        Total     CA$600.00
```

with no outstanding messages at all. That is one call short of an order, and
the remaining call is the credentialed one.
