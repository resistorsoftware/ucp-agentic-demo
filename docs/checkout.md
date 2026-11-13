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
not a failure. The third is a shipping-zone gap on the merchant side — the store
has no rate covering the buyer context the demo sends.
