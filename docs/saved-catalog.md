# Saved catalog — the path we tried, and where it stops

`hotwire-resistor.myshopify.com` is not in Shopify's open global catalog. Searching it
for the store's own exact product titles returns nothing, while the store answers
instantly on its own storefront endpoint. A **saved catalog** looked like it could
close that gap deterministically: it is a Global Catalog configuration, stored in the
Dev Dashboard, whose source you can scope to a specific store.

**It cannot, for this store.** That was checked in the Dev Dashboard on 13 November
2026 and the result is recorded below. The tooling here is kept because the result
will change the day the store is indexed — and because the boundary it draws is worth
understanding either way.

## What we found

Dev Dashboard → **Agents** → **Create a catalog** → Source → **Specific stores**
presents a **Search stores** box. That box is a fuzzy search over the stores already
in Shopify's catalog index — not over your own organization's stores.

| Typed | Returned |
| --- | --- |
| `hotwire` | Hotwire Electronics (`hotwire-electronics.myshopify.com`) — and nothing else |
| `resistor` | **No matching stores** |
| `hotwire-resistor` | Hotwire Electronics, Ngok Fung NG, HeatMeUp, SLYCE Hot Wire … — fuzzy neighbours, never the store itself |

So the question the **Search preview** was supposed to answer gets answered one step
earlier, at the source picker: the store cannot be selected, so there is no catalog to
preview.

This is consistent with everything else observed. A saved catalog **narrows** the
global index; it does not add to it. If a store is not in that index, scoping cannot
conjure it into existence.

Two things are worth noting, because they narrow the diagnosis:

- There was **no** "Catalog search is locked" / **Verify to unlock** gate on this
  organization. The feature is fully available; the store simply isn't in the index.
- At least one plainly-generated dev-store domain (`hf0jwr-xj.myshopify.com`) *is*
  selectable. So "development stores are categorically ineligible" is not the
  explanation. This store has not been indexed **yet** — a merchant-side state, not a
  protocol one.

Nothing was created or saved during this check; the draft was discarded.

## Correction: a saved catalog is *not* credentialed

This file previously said a saved catalog required a client id and secret. **It does
not.** Tested 13 November 2026 against a real saved catalog:

```
POST https://catalog.shopify.com/api/ucp/mcp
{ "catalog": { "query": "snowboard", "catalog_id": "01m7ay…me3mq6" } }
```

with no `Authorization` header at all — same three products as the unscoped global
search, no auth error. `catalog_id` is a configuration identifier, not a credential.

So a saved catalog *could* live in the published static page. A Dev Dashboard token
buys you rate limit (5 req/s per client, versus a shared per-IP pool for anonymous
traffic), not access. See [`checkout.md`](checkout.md) for the three identification
tiers and what each one actually unlocks.

`scripts/saved-catalog.mjs` still supports the credentialed path, because the token
tier is real and worth having — it just isn't a precondition for saved catalogs.
`getAccessToken()` continues to refuse to run in a browser, which stays correct: a
client secret in a static site is a public secret, and an `Authorization` header forces
a CORS preflight that `catalog.shopify.com` answers with HTTP 400.

## If the store does get indexed

Re-check the store picker first — that is the thirty-second test, and it costs
nothing:

1. [Dev Dashboard](https://dev.shopify.com/dashboard/) → **Agents** → **Create a
   catalog**.
2. Source → **Specific stores** → type `resistor`. If the store appears, continue; if
   it still says *No matching stores*, stop here, nothing downstream will work.
3. Leave the other filters open. A narrow price or taxonomy filter on top of a
   six-product store returns nothing and looks exactly like a failure.
4. Use **Search preview** with `floral` or `insurance` to confirm the products this
   repo rewrote come back.
5. **Save**, then copy the catalog's **URL** and **id**.
6. Optional: **Agent identities → New identity** gives a client ID and secret for the
   token tier — higher rate limits, and the only route to `complete_checkout`. Not
   needed just to search the catalog.

Then:

```bash
cp .env.example .env.local
# fill in SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_CATALOG_URL, SHOPIFY_CATALOG_ID
node scripts/saved-catalog.mjs --query "floral"
```

`.env.local` is gitignored. The script fetches a token at runtime rather than storing
one, since tokens expire after an hour.

## What the script tells you

It prints every result with its `seller.domain` and then checks the scoping explicitly:

- **Scoped correctly** — results exist and every one is yours.
- **Partially scoped** — your store is present but so are others. The catalog's source
  is broader than one store; fix it in Configuration.
- **Not present** — your products are not in the index the saved catalog draws from.
  This is the case described at the top of this file.

## Meanwhile

The storefront catalog is the honest path, and it is not a consolation prize — it is a
complete, working UCP cycle against a real store:

```bash
node scripts/demo-cycle.mjs --query "floral grass"   # discovery → selection → cart → handoff
```

Discovery is the only stage a saved catalog would have changed. Selection, cart,
totals and handoff are unaffected and already work.
