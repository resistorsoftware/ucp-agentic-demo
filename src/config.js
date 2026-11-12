/** Shared defaults for the demo. Everything here can be overridden by env vars. */

/** The merchant this demo was built against. */
export const DEFAULT_STORE_DOMAIN = 'hotwire-resistor.myshopify.com';

/** Where this repo publishes its own UCP agent profile once GitHub Pages is on. */
export const PUBLISHED_AGENT_PROFILE =
  'https://resistorsoftware.github.io/ucp-agentic-demo/ucp/agent-profile.json';

/** Buyer context used by the demo. Soft signals only — never exclusions. */
export const DEFAULT_CONTEXT = {
  address_country: 'CA',
  currency: 'CAD',
  language: 'en-CA',
};
