// Production activation of the platform host policy (network/platform-host-policy.mjs).
//
// ON BY DEFAULT IN PRODUCTION, ACTIVATED BY THE ADMIN. A component whose chain and address book are the production ones
// (Base 8453, EnclaveAddressBook 0xab21…) enforces the platform host policy without any user opt-in. The administrator
// ACTIVATES enforcement by anchoring a signed policy in the book (setMany of the two anchor keys): from that block every
// such component enforces it. Before any anchor exists, enforcement is "not activated" and today's behavior applies (no
// policy is accepted unanchored - there is none to accept). A torn/malformed anchor always refuses.
//   activation "anchor"   (production default) unanchored = not activated (admit, reported as such)
//   activation "required" unanchored = refuse (for a later release, once a policy is anchored, or for tests)
// Other chains or books (local rigs, test-only configs) are OFF unless configured, so existing test configs stay compatible.
// Explicit operator configuration (ENCLAVE_PLATFORM_HOST_POLICY) always wins:
//   "production"  the production authority below, regardless of the component's own chain/book settings
//   "off"         explicitly disabled (logged loudly; not a production configuration)
//   JSON          { book, hostOwnership, mirrors[], activation?, rpcs?, minAgree? } - a test or private platform
const lc = (s) => String(s || "").toLowerCase();
export const PRODUCTION_BOOK = "0xab214342d5a490150a4a977063a2f88e21f80907";
export const PRODUCTION_HOST_OWNERSHIP = "0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7";
// Public HTTPS transports verified on 2026-10-20; clients still verify the administrator signature and chain anchor.
// Publish a reviewed signed document to these routes BEFORE anchoring it. Extra operator-chosen mirrors are supported.
// These four regional endpoints share an infrastructure operator; they do not establish independent operation.
export const PRODUCTION_MIRRORS = Object.freeze([]);
// The policy's own read quorum (distinct public Base RPCs; majority 3 of 4), independent of a component's single RPC.
export const PRODUCTION_RPCS = Object.freeze(["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://base.public.blockpi.network/v1/rpc/public"]);
export const PRODUCTION_HOST_POLICY = Object.freeze({ chainId: 8453, book: PRODUCTION_BOOK, hostOwnership: PRODUCTION_HOST_OWNERSHIP,
  mirrors: PRODUCTION_MIRRORS, rpcs: PRODUCTION_RPCS, minAgree: 3, activation: "anchor" });

const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
// The policy's chain authority: the legacy RPC quorum (default), or EXPLICITLY the local proof-backed verifier
// (ENCLAVE_CHAIN_AUTHORITY=verifier + ENCLAVE_CHAIN_VERIFIER=<loopback URL>, or chainAuthority/chainVerifier in the JSON).
// Dependency-free (this module also runs in the browser); the endpoint is refused unless local when it is used.
function chainAuthority(env, c = {}) {
  const a = String(env.ENCLAVE_CHAIN_AUTHORITY ?? c.chainAuthority ?? "").trim(), v = String(env.ENCLAVE_CHAIN_VERIFIER ?? c.chainVerifier ?? "").trim();
  if (!a || a === "quorum") { if (v) throw Error("platform host policy: a chain verifier is set but the chain authority is not verifier"); return {}; }
  if (a !== "verifier") throw Error("platform host policy: chain authority must be quorum or verifier");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/|$)/.test(v)) throw Error("platform host policy: the chain verifier must be a local (loopback) URL");
  return { chainAuthority: "verifier", chainVerifier: v };
}
/**
 * -> { on: false, reason } | { on: true, source, config: { book, hostOwnership, mirrors[], rpcs[]|null, minAgree|null, activation } }
 * env: ENCLAVE_PLATFORM_HOST_POLICY, ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS, ENCLAVE_PLATFORM_HOST_POLICY_RPCS,
 *      ENCLAVE_PLATFORM_HOST_POLICY_ACTIVATION; chainId/book: the component's own chain and address book.
 */
export function resolveHostPolicyConfig({ env = {}, chainId = null, book = null } = {}) {
  const raw = String(env.ENCLAVE_PLATFORM_HOST_POLICY ?? "").trim();
  const extraMirrors = list(env.ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS), rpcs = list(env.ENCLAVE_PLATFORM_HOST_POLICY_RPCS);
  const activation = String(env.ENCLAVE_PLATFORM_HOST_POLICY_ACTIVATION || "").trim() || null;
  if (activation && !["anchor", "required"].includes(activation)) throw Error("ENCLAVE_PLATFORM_HOST_POLICY_ACTIVATION must be anchor or required");
  const production = (source) => ({ on: true, source, config: { book: PRODUCTION_BOOK, hostOwnership: PRODUCTION_HOST_OWNERSHIP,
    mirrors: [...new Set([...PRODUCTION_MIRRORS, ...extraMirrors])], rpcs: rpcs.length ? rpcs : [...PRODUCTION_RPCS],
    minAgree: rpcs.length ? null : PRODUCTION_HOST_POLICY.minAgree, activation: activation || "anchor", ...chainAuthority(env) } });
  if (raw === "off") return { on: false, reason: "ENCLAVE_PLATFORM_HOST_POLICY=off (explicitly disabled)" };
  if (raw === "production") return production("ENCLAVE_PLATFORM_HOST_POLICY=production");
  if (raw) {
    let c; try { c = JSON.parse(raw); } catch { throw Error("ENCLAVE_PLATFORM_HOST_POLICY: production | off | JSON {book, hostOwnership, mirrors}"); }
    if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some((k) => !["book", "hostOwnership", "mirrors", "activation", "rpcs", "minAgree", "chainAuthority", "chainVerifier"].includes(k)))
      throw Error("ENCLAVE_PLATFORM_HOST_POLICY JSON: { book, hostOwnership, mirrors[], activation?, rpcs?, minAgree?, chainAuthority?, chainVerifier? }");
    for (const k of ["book", "hostOwnership"]) if (!/^0x[0-9a-fA-F]{40}$/.test(String(c[k] || "")) || /^0x0{40}$/i.test(c[k])) throw Error(`ENCLAVE_PLATFORM_HOST_POLICY.${k}: a nonzero address`);
    const act = activation || c.activation || "anchor";
    if (!["anchor", "required"].includes(act)) throw Error("ENCLAVE_PLATFORM_HOST_POLICY.activation must be anchor or required");
    return { on: true, source: "ENCLAVE_PLATFORM_HOST_POLICY (explicit)", config: { book: lc(c.book), hostOwnership: lc(c.hostOwnership),
      mirrors: [...new Set([...(Array.isArray(c.mirrors) ? c.mirrors : []), ...extraMirrors])], rpcs: rpcs.length ? rpcs : (Array.isArray(c.rpcs) ? c.rpcs : null),
      minAgree: Number.isSafeInteger(c.minAgree) ? c.minAgree : null, activation: act, ...chainAuthority(env, c) } };
  }
  if (Number(chainId) === 8453 && lc(book) === PRODUCTION_BOOK) return production("production chain and address book (default)");
  return { on: false, reason: `not the production chain/book (chain ${chainId ?? "unset"}, book ${book || "unset"}): platform host policy off unless configured` };
}
