// windows/node/chain-selection.mjs -- THE one rule that turns a Windows node's environment into its chain authority (r9 composition
// of route's Windows verifier reads with the root-qualified consumer authority e4f507d6b/b6ac5d657). chain.mjs builds the node's
// single authority with it once; chain-reader.mjs only VALIDATES an environment with it (it never sends anything). No other
// module parses ENCLAVE_CHAIN_* for the Windows node.
//   * unset: null - the legacy provider list (unchanged);
//   * ENCLAVE_CHAIN_AUTHORITY=verifier + ENCLAVE_CHAIN_VERIFIER (loopback) [+ ENCLAVE_CHAIN_TX_BACKEND]: network/chain-authority.mjs
//     createChainAuthority - reads proven by the local verifier (unsafe tier), pending-pool/fee hints and submissions ONLY to the
//     operator's own backend, bound to the verifier's chain by actionGate before each send;
//   * anything invalid - including the OBSOLETE ENCLAVE_CHAIN_TX_RPCS beside the verifier (an unbound transaction list is never
//     used) - a refusing authority: every chain read and transaction refuses, no provider is used.
import { base } from "viem/chains";
import { chainAuthorityFromEnv, refusingChainAuthority } from "./lease-gas-runtime.bundle.mjs";

export const OBSOLETE_TX_RPCS = "ENCLAVE_CHAIN_TX_RPCS is obsolete: under ENCLAVE_CHAIN_AUTHORITY=verifier transactions go only to the bound own backend ENCLAVE_CHAIN_TX_BACKEND (an unbound transaction list is refused, never used)";
/** -> null (legacy) | the chain authority (network/chain-authority.mjs; describe().authority 'verifier' or 'refusing'). Never throws. */
export function selectChainAuthority(env = process.env) {
  try {
    if (String(env.ENCLAVE_CHAIN_AUTHORITY || "").trim() === "verifier" && String(env.ENCLAVE_CHAIN_TX_RPCS || "").trim()) throw new Error(OBSOLETE_TX_RPCS);
    return chainAuthorityFromEnv(env, { chain: base });
  } catch (e) { return refusingChainAuthority(e.message, { chain: base }); }
}
/** The validated verifier URL of a VALID selection, null in legacy mode; an INVALID selection throws its refusal. */
export function selectedVerifier(env = process.env, authority = selectChainAuthority(env)) {
  if (!authority) return null;
  const d = authority.describe();
  if (d.authority === "refusing") throw Object.assign(new Error(`the chain authority selection is INVALID: ${d.why}`), { code: "chain_authority_invalid" });
  return String(env.ENCLAVE_CHAIN_VERIFIER || "").trim();
}
