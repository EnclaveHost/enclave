// windows/node/chain-reader.mjs -- the ONE place the Windows node builds an agreed(fn) chain reader (owner-committed
// Shield startup in host.mjs, the ownership CLI in host-onchain.mjs, check-endpoint in host-identity.mjs).
//
// Default (legacy) mode is unchanged: host-identity.mjs quorumReader over the given RPCs (two distinct hosts agree at one
// fresh confirmed block). With ENCLAVE_CHAIN_AUTHORITY=verifier + ENCLAVE_CHAIN_VERIFIER=<loopback URL> it is the shared
// LeaseReader under authority 'verifier' from the admission bundle (network/verified-read-client.mjs): one proof-backed
// block, the same agreed((client, blockNumber) => ...) interface, and NO public client is constructed - rpcClients() is
// never called, so a verifier refusal cannot fall back to a provider.
import { chainVerifierFromEnv, verifiedStateReader } from "./host-admission.bundle.mjs";
import { quorumReader, rpcClients } from "./host-identity.mjs";

/** -> { authority: 'provider-quorum' } | { authority: 'local-verifier', verifier, tier: 'unsafe' } (throws if ambiguous) */
export function chainAuthorityOf(env = process.env) {
  const v = chainVerifierFromEnv(env);
  return v ? { authority: "local-verifier", verifier: v.verifier, tier: "unsafe" } : { authority: "provider-quorum" };
}
/** An agreed(fn) reader for `rpcs` (legacy) or the explicit local verifier. `quorum` options apply to the legacy reader. */
export async function chainReader({ rpcs = [], env = process.env, quorum = {} } = {}) {
  const v = chainVerifierFromEnv(env);
  if (v) return verifiedStateReader({ verifier: v.verifier });
  return quorumReader({ clients: await rpcClients(rpcs), ...quorum });
}
