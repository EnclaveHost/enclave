// Custody chain source: which chain authority a custodian (v1 custodian-daemon, v2 readers given `clients`) reads through.
//
//   quorum (DEFAULT, unchanged): the configured RPC URLs and an explicit minAgree, exactly as before. No verifier setting
//     may be present.
//   verifier (explicit opt-in): the operator's LOCAL VERIFIER (network/chain-authority.mjs, loopback only) as the ONE chain
//     authority: state is executed/proven against the state root of a block on the verifier's sequencer-signed head chain,
//     blocks come from that chain. NO provider RPC may be configured with it (no fallback, no mixed quorum: a verifier is
//     never one vote among RPCs), minAgree is 1, submissions go only to the operator's own backend after it is bound to
//     the verifier's head (txBackend; without it nothing is sent).
// Trust change (stated, not hidden): a quorum trusts that a majority of the configured RPCs is honest; the verifier trusts
// its own proof checks and the sequencer's unsafe-block signature. NEITHER mode has L1 finality: every custody reader keeps
// its own confirmations / maxAgeSec / high-water / checkpoint rules unchanged on top of either source.
// v1 ONLY. v2 readers (custody/v2/quorum.mjs) REFUSE a verifier client: v2 requires strict same-block evidence (EIP-1898
// {blockHash, requireCanonical: true}); the pinned Helios accepts that object and pins STATE to the hash, but its source
// never reads require_canonical (core/src/execution/cache/provider.rs: BlockId::Hash(hash) => hash.into()), so the
// canonical requirement would be silently dropped. Translating the hash to a block number is NOT equivalent (an A-B-A
// reorg between the checks and the read returns another block's state) and is not done. v2 stays on its RPC quorum until
// the verifier enforces canonical hash-pinned reads and a measured-config release carries the change.
import { base } from "viem/chains";
import { createChainAuthority, isVerifierClient } from "../network/chain-authority.mjs";

export const CHAIN_SOURCES = Object.freeze(["quorum", "verifier"]);
const PROVIDER_KEYS = ["rpcs", "rpc", "bindingRpcs", "fallbackRpcs", "minAgree"];
const VERIFIER_KEYS = ["verifier", "txBackend"];
const bad = (m) => Object.assign(new Error(`custody chain source: ${m}`), { code: "bad_config", status: 500 });
const has = (cfg, k) => cfg[k] !== undefined && cfg[k] !== null && String(cfg[k]).trim() !== "";

/** -> { mode: "quorum", rpcs, minAgree, clients: null } | { mode: "verifier", rpcs: null, minAgree: 1, clients: [client], authority } */
export function custodyChainSource(cfg = {}, { chain = base, createAuthority = createChainAuthority, ...authorityOpts } = {}) {
  const mode = cfg.chainSource ?? "quorum";
  if (!CHAIN_SOURCES.includes(mode)) throw bad("chainSource must be quorum or verifier");
  if (mode === "quorum") {
    const stray = VERIFIER_KEYS.filter((k) => has(cfg, k));
    if (stray.length) throw bad(`${stray.join(", ")} set but chainSource is not verifier`);
    return { mode, rpcs: cfg.rpcs, minAgree: cfg.minAgree, clients: null, authority: null };
  }
  const mixed = PROVIDER_KEYS.filter((k) => has(cfg, k));
  if (mixed.length) throw bad(`chainSource verifier: ${mixed.join(", ")} must be unset (the local verifier is the one authority: no RPC fallback, no mixed quorum)`);
  if (!has(cfg, "verifier")) throw bad("chainSource verifier needs verifier (the local verifier URL)");
  if (cfg.chainId !== undefined && cfg.chainId !== null && Number(cfg.chainId) !== chain.id) throw bad(`chainId ${cfg.chainId} is not the verifier's chain ${chain.id}`);
  const authority = createAuthority({ verifier: cfg.verifier, backend: cfg.txBackend || null, chain, ...authorityOpts });
  if (!isVerifierClient(authority.client)) throw bad("the chain authority did not yield a verifier client");
  return { mode, rpcs: null, minAgree: 1, clients: [authority.client], authority };   // v1 readers only (see above)
}
