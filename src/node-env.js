/**
 * Node-side resolution of the two things every UCP call needs: which merchant,
 * and which agent profile URL to present as our identity.
 *
 * The agent profile must be publicly reachable — the merchant's server fetches
 * it during negotiation. A localhost URL will fail with `profile_unreachable`.
 */
import { FALLBACK_AGENT_PROFILE } from './ucp-client.js';
import { DEFAULT_CONTEXT, DEFAULT_STORE_DOMAIN, PUBLISHED_AGENT_PROFILE } from './config.js';

export function storeDomain() {
  return process.env.UCP_STORE_DOMAIN || DEFAULT_STORE_DOMAIN;
}

export function agentProfile() {
  if (process.env.UCP_AGENT_PROFILE) return process.env.UCP_AGENT_PROFILE;
  if (process.env.UCP_USE_PUBLISHED_PROFILE === '1') return PUBLISHED_AGENT_PROFILE;
  return FALLBACK_AGENT_PROFILE;
}

export function buyerContext() {
  return { ...DEFAULT_CONTEXT };
}

/** Confirm an agent profile URL is actually fetchable before we hand it out. */
export async function assertProfileReachable(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = await res.json();
    return body && body.ucp ? { ok: true, version: body.ucp.version } : { ok: false, detail: 'no "ucp" object' };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

/* Small terminal helpers — no dependencies. */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));
export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  cyan: wrap(36),
};

export function step(n, title) {
  console.log(`\n${c.cyan(c.bold(`[${n}]`))} ${c.bold(title)}`);
}

export function kv(key, value) {
  console.log(`    ${c.dim(key.padEnd(18))} ${value}`);
}
