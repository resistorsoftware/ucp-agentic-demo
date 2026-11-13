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

## The constraint that shapes the whole design

The global and storefront catalogs are **keyless** — identity comes from the agent
profile alone, which is why the published demo page can call them from a browser with
no server.

A saved catalog is **credentialed**. You exchange a Dev Dashboard client id and secret
for a 60-minute bearer token:

```
POST https://api.shopify.com/auth/access_token
{ "client_id": "…", "client_secret": "…", "grant_type": "client_credentials" }
```

A client secret in a static site is a public secret, so **the saved catalog path is a
CLI script, never part of the published page**. That is a deliberate boundary:

| Surface | Catalogs | Credentials |
| --- | --- | --- |
| Published page (GitHub Pages) | global + storefront | none — keyless |
| `scripts/saved-catalog.mjs` (local) | saved catalog | client id + secret, from `.env.local` |

`getAccessToken()` in `src/ucp-client.js` throws `UNSAFE_CONTEXT` rather than run in a
browser at all. If you ever want the saved catalog behind the public demo, it needs a
small server or Worker holding the secret and proxying the call. Nothing in this repo
does that today.

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
6. **Agent identities → New identity** gives the client ID and secret. The scope you
   want is `read_global_api_catalog_search`.

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
