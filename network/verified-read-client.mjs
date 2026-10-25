// The explicit local-verifier authority for a node's GENERIC chain client (windows/node/chain.mjs and its callers),
// shipped to the Windows node through its admission bundle (network/host-admission-node.mjs).
//
// A generic viem public client does two different jobs, and only one of them is state the verifier can prove:
//   * STATE reads (contract calls, code, storage, balance) at a block: proof-backed by the local verifier, one block per
//     snapshot, freshness/monotonicity/deadline as LeaseReader authority 'verifier' (network/lease-reader.mjs).
//   * TRANSACTION and HISTORY work (pending nonce, simulation, gas and fee estimates, broadcast, receipts, event logs,
//     transaction input, arbitrary historic or latest blocks): NOT proof-backed here. Under the verifier these go only
//     to an EXPLICITLY configured transport (ENCLAVE_CHAIN_TX_RPCS); without one they refuse by name. The public default
//     RPC list is never used once the verifier is chosen, and nothing a state read refuses falls back to a provider.
import { LeaseReader } from './lease-reader.mjs';
import { chainVerifierOf } from './verified-chain.mjs';
import { rpcEndpoint } from './rpc-identity.mjs';

const ZERO = '0x' + '0'.repeat(40);
/** The state methods a verified client offers (each answered at ONE verified block, proof-backed). */
export const VERIFIED_STATE_METHODS = Object.freeze(['readContract', 'getCode', 'getBytecode', 'getStorageAt', 'getBalance', 'getBlockNumber', 'getChainId']);

/**
 * The node's explicit chain authority from its environment. -> null: the legacy provider mode (default); or
 * { verifier } when ENCLAVE_CHAIN_AUTHORITY=verifier and ENCLAVE_CHAIN_VERIFIER is a LOCAL (loopback) URL. Anything
 * ambiguous (a verifier without the authority, an unknown authority, a remote URL) throws, so a node refuses to start
 * rather than silently reading from providers.
 */
export function chainVerifierFromEnv(env = process.env) {
  const verifier = chainVerifierOf({ chainAuthority: env.ENCLAVE_CHAIN_AUTHORITY || undefined, chainVerifier: env.ENCLAVE_CHAIN_VERIFIER || undefined },
    'ENCLAVE_CHAIN_AUTHORITY');
  return verifier ? { verifier } : null;
}

/**
 * The EXPLICIT transaction/history transport used under the verifier: ENCLAVE_CHAIN_TX_RPCS (comma list; https, or http
 * on loopback). [] = none: transaction and history methods then refuse. It is untrusted for state: nothing read through
 * it ever answers a state question the verifier refused.
 */
export function transactionRpcsFromEnv(env = process.env) {
  const list = String(env.ENCLAVE_CHAIN_TX_RPCS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length > 8) throw new Error('ENCLAVE_CHAIN_TX_RPCS: at most 8 transaction transports');
  for (const u of list) { try { rpcEndpoint(u); } catch (e) { throw new Error(`ENCLAVE_CHAIN_TX_RPCS: ${e.message}`); } }
  return list;
}

/** One verified-state reader (LeaseReader authority 'verifier'); `addressBook` is not used for these reads. */
export function verifiedStateReader({ verifier, chainId = 8453, ...opts }) {
  return new LeaseReader({ authority: 'verifier', verifier, addressBook: ZERO, chainId, ...opts });
}

/**
 * snapshot(fn) -> fn(client, blockNumber) evaluated at ONE verified block, every read inside it at that block: a
 * multi-read decision (an authorization, a paged enumeration) is coherent. Any failure refuses the whole snapshot.
 */
export function verifiedSnapshot(reader) {
  if (typeof reader?.agreed !== 'function' || reader.authority !== 'verifier') throw new Error('a verified snapshot needs a verifier-authority reader');
  return async (fn) => (await reader.agreed(async (c, b) => ({ v: await fn(c, b) }))).v;
}

/**
 * A viem-shaped client for SINGLE state reads: each call is its own verified snapshot. Every other method (nonce,
 * simulation, estimates, receipts, logs, transactions, block reads by tag) refuses by name with `unavailable(method)`;
 * there is no provider behind it.
 */
export function verifiedStateClient(reader, { unavailable = (m) => `${m} is not a verified state read: under ENCLAVE_CHAIN_AUTHORITY=verifier it needs the explicit transaction/history transport` } = {}) {
  const snap = verifiedSnapshot(reader);
  const methods = Object.fromEntries(VERIFIED_STATE_METHODS.map((m) => [m, (args = {}) => snap((c) => c[m](args))]));
  return new Proxy(Object.freeze({}), { get(_t, key) {
    if (Object.hasOwn(methods, key)) return methods[key];
    if (key === 'chainAuthority') return 'local-verifier';
    if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined;
    return async () => { throw Object.assign(new Error(unavailable(String(key))), { code: 'chain_unsupported' }); };
  } });
}
