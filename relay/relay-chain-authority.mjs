// The relay's ONE chain authority for its viem consumers: api-relay.js chain() (custody and session gating, the ledger,
// placement, discovery, registryProofKey), relay/store.js rpcParts()/rpcPool() (billing, payment indexer, provisioner, vault
// service, SIWE/owner signatures, the network API) and the wallet clients built on rpcParts(), the secrets-release catalog
// and ledger record reads, the custody state reader, the sessions relayer, the host-registration sponsor and the MCP reads.
//
// Unset (or ENCLAVE_CHAIN_AUTHORITY=quorum): null, and every caller keeps its provider path exactly as before.
// ENCLAVE_CHAIN_AUTHORITY=verifier + ENCLAVE_CHAIN_VERIFIER=<loopback URL> [+ ENCLAVE_CHAIN_TX_BACKEND=<own node literal>]:
// network/chain-authority.mjs (state, receipts, transactions and log INCLUSION proven by the local verifier - log
// completeness is not proven; submission, the pending nonce and fee hints only through the own backend after it is bound
// to the verifier's head; everything else refused). One authority per process, never part of a quorum, and no provider
// client is ever built.
//
// A mixed selection is refused, not resolved: under the verifier every provider setting of those consumers
// (relay/relay-chain-env.mjs RELAY_VERIFIER_CONFLICTS) must be unset, and BILLING_NETWORK / SESSIONS_NETWORK must be base.
// The relay stops at startup on any of these, before it loads a key or contacts a chain server; a later caller gets the
// same refusal, never the provider path. Shipped in relay/network-runtime.bundle.mjs (the flat relay directory has no
// network/).
import { base } from 'viem/chains';
import { chainAuthorityFromEnv, AUTHORITY_ENV, TX_BACKEND_ENV } from '../network/chain-authority.mjs';
import { RELAY_CHAIN_ENV, RELAY_VERIFIER_CONFLICTS } from './relay-chain-env.mjs';

export { RELAY_CHAIN_ENV, RELAY_VERIFIER_CONFLICTS };
const set = (env, k) => String(env[k] ?? '').trim() !== '';

/** Does the environment name the chain authority at all? (false: the legacy provider path, nothing else is loaded) */
export const relayChainSelected = (env = process.env) => RELAY_CHAIN_ENV.some((k) => set(env, k));

/** -> null (legacy provider path) | the verifier chain authority. Throws on an invalid or mixed selection. */
export function relayChainSelection(env = process.env, opts = {}) {
  const authority = chainAuthorityFromEnv(env, { chain: base, ...opts });
  if (!authority) return null;
  const mixed = RELAY_VERIFIER_CONFLICTS.filter((k) => set(env, k));
  if (mixed.length) throw new Error(`${AUTHORITY_ENV}=verifier: ${mixed.join(', ')} must be unset (those consumers read through the verifier; an own node belongs in ${TX_BACKEND_ENV}, never as a second authority)`);
  for (const k of ['BILLING_NETWORK', 'SESSIONS_NETWORK']) {
    const net = String(env[k] || 'base').trim();
    if (net !== 'base') throw new Error(`${AUTHORITY_ENV}=verifier: ${k} must be base (the verifier authority is Base mainnet), not ${net}`);
  }
  return authority;
}

let selected;                                              // undefined: not chosen yet; a failed choice is never cached
/** The process's single relay chain authority (the same object for every caller). Throws on an invalid selection. */
export function relayChainAuthority(env = process.env) {
  if (selected === undefined) selected = relayChainSelection(env);
  return selected;
}
