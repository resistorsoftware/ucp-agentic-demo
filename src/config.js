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

/** Buyer context used by the demo. Soft signals only — never exclusions. */
export const DEFAULT_CONTEXT = {
  address_country: 'CA',
  currency: 'CAD',
  language: 'en-CA',
};
