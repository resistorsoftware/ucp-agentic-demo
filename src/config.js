/** Shared defaults for the demo. Everything here can be overridden by env vars. */

/** The merchant this demo was built against. */
export const DEFAULT_STORE_DOMAIN = 'hotwire-resistor.myshopify.com';

/**
 * This agent's own published UCP profile, served from the repo via jsDelivr.
 *
 * Not GitHub Pages, and that is not an accident. Shopify validates the
 * `Cache-Control` header on an agent profile and rejects
 * `max-age=600` — what Pages sends — with
 * `profile_malformed: Invalid cache control`. Pages gives no way to set headers.
 * jsDelivr serves the same file out of this repository as
 * `application/json` with `public, max-age=604800`, which Shopify accepts.
 * Verified against hotwire-resistor.myshopify.com.
 *
 * Pin to a tag or commit instead of @main if you want the identity frozen.
 */
export const PUBLISHED_AGENT_PROFILE =
  'https://cdn.jsdelivr.net/gh/resistorsoftware/ucp-agentic-demo@main/ucp/agent-profile.json';

/** Where the demo page itself is served. */
export const DEMO_URL = 'https://www.resistorsoftware.com/ucp-agentic-demo/';

/**
 * Buyer context used by the demo. Soft signals only — never exclusions.
 *
 * A Montreal buyer, stated as precisely as the protocol lets us state one.
 * `address_region` and `postal_code` are accepted by the global catalog and
 * documented there as improving *delivery estimate fidelity* — not ranking.
 * Measured, they change neither the result set nor its order: searching from
 * QC/H3B and from BC/V6B returns the same products in the same sequence, while
 * the same QC search run twice returns the same products in a slightly
 * different sequence. The region is honest about where the buyer is; it is not
 * a proximity control. See docs/location.md.
 *
 * `address_country` is the signal that genuinely moves results — it selects the
 * currency and shifts the merchant mix.
 */
export const DEFAULT_CONTEXT = {
  address_country: 'CA',
  address_region: 'QC',
  postal_code: 'H3B 1A1',
  currency: 'CAD',
  language: 'en-CA',
};

/**
 * Hard filters for the cross-merchant search: ship to Canada, ship *from*
 * Canada.
 *
 * `ships_from` is the only lever in the protocol that meaningfully narrows a
 * cross-merchant search by geography, and its granularity is the country — one
 * `{ country }` per entry, OR'd together, with no region, postal code or
 * radius. So this asks for Canadian origin, which a warehouse in Vancouver
 * satisfies exactly as well as one in Laval.
 *
 * Global catalog only. The storefront endpoint's `search_catalog` advertises
 * just `categories`, `price` and `available` — verified against
 * hotwire-resistor.myshopify.com — so these are never sent to a merchant.
 */
export const CANADIAN_ORIGIN_FILTERS = {
  ships_to: {
    country: DEFAULT_CONTEXT.address_country,
    region: DEFAULT_CONTEXT.address_region,
    postal_code: DEFAULT_CONTEXT.postal_code,
  },
  ships_from: [{ country: 'CA' }],
};

/**
 * A sample delivery destination, used only to ask the merchant for shipping
 * options. Deliberately a public civic address and a reserved 555 phone
 * number: no real person's details belong in a public demo, and none are
 * needed — the merchant quotes rates against a postal code, not an identity.
 *
 * Nothing is ever ordered, so nothing is ever delivered here.
 *
 * Kept in the same region as DEFAULT_CONTEXT, so the buyer the agent claims to
 * be and the address it ships to are the same person.
 */
export const DEMO_DESTINATION = {
  first_name: 'Agent',
  last_name: 'Demo',
  phone_number: '+15145550123',
  street_address: '275 Rue Notre-Dame Est',
  address_locality: 'Montréal',
  address_region: 'QC',
  postal_code: 'H2Y 1C6',
  address_country: 'CA',
};
