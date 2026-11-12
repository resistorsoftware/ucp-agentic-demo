# Saved catalog — making agentic search reach your store

`hotwire-resistor.myshopify.com` is not in Shopify's open global catalog. Searching
it for the store's own exact product titles returns nothing, while the store answers
instantly on its own storefront endpoint. A **saved catalog** closes that gap
deterministically: it is a Global Catalog configuration, stored in the Dev Dashboard,
whose source you can scope to a single store.

An agent then searches *that* catalog and reaches only your products — which is the
demo you wanted, without waiting on global-index eligibility.

## The one constraint that shapes everything

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
CLI script, not part of the published page**. That is a deliberate boundary:

| Surface | Catalogs | Credentials |
| --- | --- | --- |
| Published page (GitHub Pages) | global + storefront | none — keyless |
| `scripts/saved-catalog.mjs` (local) | saved catalog | client id + secret, from `.env.local` |

If you ever want the saved catalog behind the public demo, it needs a small server or
Worker holding the secret and proxying the call. Nothing in this repo does that today.

## Setup

### 1. Create the catalog

1. Open the [Dev Dashboard](https://dev.shopify.com/dashboard/) and click **Catalogs**.
2. In a Partner organization you may see **“Catalog search is locked.”** Click
   **Verify to unlock** and complete identity verification — until you do, you cannot
   create an API key or run a preview.
3. Click **Create a catalog**.
4. In **Configuration**, set the source/input to **products from a specific store**
   and choose `hotwire-resistor.myshopify.com`. Leave the other filters open for now;
   a narrow price or taxonomy filter on top of a nine-product store will return
   nothing and look like a failure.
5. Use the **Search preview** panel to run a query — try `floral` or `insurance`.
   You should see the products this repo rewrote. If the preview is empty, the
   problem is scope or eligibility, not your agent.
6. **Save**, then copy the catalog's **URL** and its **id** from the catalog page.

### 2. Get credentials

In **Catalogs → Get an API key**, name a key and create it, then copy the **client ID**
and **client secret**. The scope you want is `read_global_api_catalog_search`.

### 3. Wire it up locally

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
- **Partially scoped** — your store is present but so are others. The catalog's
  source is still broader than one store; fix it in Configuration.
- **Not present** — your products are not in the index the saved catalog draws from.
  A saved catalog filters the global catalog; it does not add products to it. If the
  store is ineligible for the global index, scoping alone will not surface it, and the
  storefront catalog remains the honest path. Re-run
  `node scripts/audit-catalog.mjs` and confirm the agentic sales channel is
  publishing.

That last case is the one worth knowing in advance: a saved catalog narrows, it does
not include. Whether it works for a development store is exactly what step 1's
**Search preview** will tell you in about thirty seconds — before you write any code.

## After it works

A saved catalog only changes *discovery*. Selection, cart, totals and handoff are
unchanged and already working against the storefront endpoint, so:

```bash
node scripts/saved-catalog.mjs --query "floral"   # discovery, scoped to you
node scripts/demo-cycle.mjs --query "floral grass" # selection → cart → handoff
```

is the complete story end to end.
