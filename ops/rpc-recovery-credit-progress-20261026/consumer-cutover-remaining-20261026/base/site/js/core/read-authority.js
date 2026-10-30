/* ============================================================
   The hosted site's READ authority (catalog, ledger, dashboard,
   payments, address book, sessions reads through js/core/chain.js
   baseRpc and the APP_CATALOG_RPCS pool in js/core/config.js).

   A release chooses it at BUILD time, never at runtime:
     node scripts/build-site.mjs --read-authority FILE --read-authority-digest sha256:<64 hex>
   (scripts/site-read-authority.mjs; the same reviewed-file pattern as
   --built-in-profile). Without the flags READ_AUTHORITY_TEXT stays null
   and the site keeps its LEGACY public pool, exactly as before.

   With a release authority ("own-rpc"), every hosted read goes ONLY to
   its listed endpoints: no public pool, no loopback dev override, no
   default origin. An outage or an invalid authority is an error the
   page shows - never a fallback to a public provider.

   TRUST, stated plainly: "own-rpc" is a TRUSTED SELF-HOSTED TRANSPORT
   (HTTPS JSON-RPC to the operator's own Base node). The browser does
   NOT verify proofs or finality of those answers - exactly like the
   legacy public pool, minus the third parties. It is not the local
   proof verifier (network/chain-authority.mjs, loopback-only) and not
   an attested route; nothing here may be labelled either.

   An independent profile (js/core/independent.js) the USER saved or a
   built-in one still takes precedence: it is the user's own explicit
   chain choice, with its own quorum rules. Wallet signing (the wallet's
   own RPC, WalletConnect rpcMap, wallet_addEthereumChain) is the
   wallet's choice and is not governed by this file.
   ============================================================ */
import { parseUniqueJSON } from "./independent.js";

// the ONE declaration scripts/site-read-authority.mjs may replace in the bundle (anything else stops the build)
export const READ_AUTHORITY_TEXT = null;

export const READ_AUTHORITY_MAX_BYTES = 4096;
export const READ_AUTHORITY_TRUST = "self-hosted-transport";
const MAX_RPCS = 4;
/* Third-party Base RPC providers (the hosts the platform uses today, and other well-known ones). Listing one in an
   "own-rpc" authority is a misconfiguration, refused: this guards against mislabelling, it proves no ownership. */
const THIRD_PARTY = ["base.org", "publicnode.com", "drpc.org", "1rpc.io", "blastapi.io", "tenderly.co", "nodies.app",
  "llamarpc.com", "ankr.com", "alchemy.com", "infura.io", "quiknode.pro", "meowrpc.com", "walletconnect.org", "coinbase.com"];
const thirdParty = (host) => THIRD_PARTY.some((d) => host === d || host.endsWith("." + d));

/** Parse a release read-authority file (UTF-8 JSON text) -> { mode: "own-rpc", rpcs, trust, note }. Throws on anything else. */
export function parseReadAuthority(text){
  if (typeof text !== "string") throw new Error("read authority must be JSON text");
  if (new TextEncoder().encode(text).length > READ_AUTHORITY_MAX_BYTES) throw new Error("read authority is larger than " + READ_AUTHORITY_MAX_BYTES + " bytes");
  const v = parseUniqueJSON(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("read authority must be a JSON object");
  const keys = Object.keys(v);
  for (const k of keys) if (!["version", "mode", "rpcs", "trust", "note"].includes(k)) throw new Error("unknown read authority key " + JSON.stringify(k));
  if (v.version !== 1) throw new Error("read authority version must be 1");
  if (v.mode !== "own-rpc") throw new Error('read authority mode must be "own-rpc"');
  if (v.trust !== READ_AUTHORITY_TRUST) throw new Error('read authority trust must be "' + READ_AUTHORITY_TRUST + '" (the browser does not verify these answers)');
  if (v.note !== undefined && (typeof v.note !== "string" || v.note.length > 200)) throw new Error("read authority note must be a short string");
  if (!Array.isArray(v.rpcs) || v.rpcs.length < 1 || v.rpcs.length > MAX_RPCS) throw new Error("read authority needs 1-" + MAX_RPCS + " RPC URLs");
  const rpcs = [], origins = new Set();
  for (const raw of v.rpcs){
    if (typeof raw !== "string") throw new Error("read authority RPC must be a URL string");
    let u; try { u = new URL(raw); } catch { throw new Error("read authority RPC is not a URL"); }
    if (u.protocol !== "https:") throw new Error("read authority RPC must be https");
    if (u.username || u.password || u.search || u.hash || raw.includes("?") || raw.includes("#")) throw new Error("read authority RPC must carry no credentials, query or fragment");
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (thirdParty(host)) throw new Error("read authority RPC " + host + " is a third-party provider, not an own authority");
    if (origins.has(u.origin)) throw new Error("read authority RPCs must be distinct origins");
    origins.add(u.origin); rpcs.push(u.href);
  }
  return Object.freeze({ mode: "own-rpc", rpcs: Object.freeze(rpcs), trust: READ_AUTHORITY_TRUST, note: v.note || "" });
}

/** The hosted read pool. -> { mode: "independent" | "legacy" | "own-rpc" | "invalid", rpcs, trust, error }
 *  independent: the profile decides (config.js keeps its own path); legacy: `legacy` (or the loopback dev override);
 *  own-rpc: ONLY the authority's endpoints; invalid: NO endpoint at all (every read refuses). */
export function resolveReadAuthority({ text = READ_AUTHORITY_TEXT, independentState = "off", legacy = [], devRpc = null } = {}){
  if (independentState !== "off") return Object.freeze({ mode: "independent", rpcs: null, trust: "independent-profile", error: null });
  if (text == null) return Object.freeze({ mode: "legacy", rpcs: Object.freeze(devRpc ? [devRpc] : [...legacy]), trust: "public-providers", error: null });
  try {
    const a = parseReadAuthority(text);
    return Object.freeze({ mode: "own-rpc", rpcs: a.rpcs, trust: a.trust, error: null });
  } catch (e){
    return Object.freeze({ mode: "invalid", rpcs: Object.freeze([]), trust: "none", error: String((e && e.message) || e) });
  }
}

/** sessions.js chain client RPC (hosted mode). legacy: unchanged - the relay config's `rpc`, else the pool's first; own-rpc:
 *  ONLY the authority's pool (a relay-supplied RPC is not this release's authority); invalid: refuse (no URL at all, so the
 *  sessions SDK can never substitute its own public default). */
export function sessionsRpc(relayRpc, authority, pool){
  if (!authority || authority.mode === "legacy") return relayRpc || pool[0];
  if (authority.mode === "own-rpc" && pool.length) return pool[0];
  throw new Error("this site release's chain read authority is " + (authority.mode === "invalid" ? "invalid (" + authority.error + ")" : "not usable for sessions") + ": refusing");
}

/** wallet.js fallbackRead (a read the WALLET could not answer): the legacy hosted page asks Base's public RPC; under an
 *  independent profile or a release read authority it must use the read pool (baseRpc) - never a public default. */
export const fallbackUsesPool = (independentState, authority) => independentState !== "off" || !authority || authority.mode !== "legacy";
