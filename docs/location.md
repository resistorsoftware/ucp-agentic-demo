# Location in UCP: what "near me" can and cannot mean

The expectation worth testing is a reasonable one: if an agent is shopping on
behalf of a buyer in Montreal, results should favour Montreal — or at least
Quebec, or at least sellers who can get a parcel across the city rather than
across a continent.

The protocol does not work that way, and the gap between what the schema
*accepts* and what it *acts on* is wide enough to mislead anyone reading the
field names alone.

## What the schema accepts

`search_catalog` on the global catalog (`catalog.shopify.com/api/ucp/mcp`) takes
three location inputs. Read from a live `tools/list`:

| Input | Shape |
| --- | --- |
| `catalog.context` | `address_country`, `address_region`, `postal_code` |
| `filters.ships_to` | `{ country (required), region, postal_code }` |
| `filters.ships_from` | `[{ country }]` — OR logic, country only |

The descriptions on `ships_to.region` and `ships_to.postal_code` are the tell.
Both read: *"Improves delivery estimate fidelity."* Not "narrows results." Not
"ranks by proximity."

## What the catalog acts on

Three searches for `winter gloves`, eight results each, against the live global
catalog:

| Request | Result |
| --- | --- |
| Montreal — `QC`, `H3B 1A1` | 8 results, CAD |
| Vancouver — `BC`, `V6B 1A1` | **identical list, identical order** |
| Montreal, run a second time | **differed from itself** — two middle results swapped |

That third row is what makes the finding safe to state. Province and postal code
do not reorder results, and the run-to-run noise in the ranking is *larger* than
the difference between two cities 4,500 km apart. Any apparent regional effect
in a single pair of searches is that noise, not geography. Compare a region only
against the same region run twice, or the conclusion will be fiction.

Country is different, and it matters a great deal. The same query with no
location at all returns a USD list weighted toward US merchants; with
`address_country: CA` the prices come back in CAD and the merchant mix shifts.

`ships_from: [{ country: 'CA' }]` is the one lever that genuinely narrows a
cross-merchant search by geography. It visibly changed the merchant set in
testing — generic listings gave way to Superior Glove, Konekt, Milwaukee, TAC.
Its granularity is the country, so a warehouse in Vancouver satisfies a Montreal
buyer's filter exactly as well as one in Laval.

## Origin filtering is global-catalog only

The storefront endpoint's `search_catalog` advertises a much smaller filter set.
Verified against `hotwire-resistor.myshopify.com`:

```
global catalog   categories price available shops condition ships_to ships_from
                 attributes rating price_tier media
storefront       categories price available
```

Nothing geographic. The demo therefore sends `ships_to`/`ships_from` to the
global catalog only, and the merchant-scoped search gets buyer context alone.
This is a deliberate asymmetry in the demo, not an oversight.

## Where proximity actually lives

Real distance search exists, added 2026-10-22 as
`dev.ucp.common.location.search` and `dev.ucp.common.location.lookup`.
`search_locations` accepts a distance relation with an explicit centre and a
max radius in metres, returns each location's address and geo coordinates, and
`filters.items` takes up to 10 variant IDs so an agent can ask which stores
carry the thing.

Three constraints shape what can be built on it:

1. It lives on the **merchant's** storefront endpoint, not the global catalog.
   The achievable flow is *find products across merchants, then ask one
   merchant where its stores are.* A cross-merchant catalog cannot be sorted by
   distance.
2. Only shops with an active retail location marked as a Physical storefront
   advertise it. `hotwire-resistor.myshopify.com` does not — its
   `/.well-known/ucp` carries no `dev.ucp.common.location.*` capability, which
   is expected of a development store with no retail location.
3. Per Shopify's changelog, pickup checkout for a selected location is not
   supported. An agent can find the store; it cannot complete the order as a
   pickup.

So the shape of the answer is: UCP can tell a buyer which of *one merchant's*
stores near them has an item on the shelf. It cannot rank a cross-merchant
catalog by how close the seller is. Local-first discovery across merchants is
not expressible in UCP 2026-08-25.

## Reproducing this

```
node scripts/demo-cycle.mjs --query "winter gloves"
node scripts/demo-cycle.mjs --query "winter gloves" --no-origin-filter
```

The second run drops `ships_from`, which is the clearest way to see origin
filtering do something. To check the region claim, run the first command twice
and compare the two runs against each other before comparing either to a
different province.
