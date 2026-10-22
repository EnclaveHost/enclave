/* ============================================================
   Who the independent dashboard acts for (work/passkey-dashboard-interface.txt).

   OWNER: the connected wallet (the default, unchanged), or a passkey
   account (a Safe, passkey-account.js) the owner selected explicitly.
   PAYER: the connected wallet when it only submits and pays gas.

   An account is an identity only after one quorum-agreed block shows:
   - every passkey signer re-derived by the pinned factory,
   - the deployed Safe on the pinned singleton, with exactly the
     profile's owners and threshold,
   - no module but the pinned 4337 module, no guard, a pinned handler.
   A stored selection is re-verified on every page load. Until then it
   is "pending"; if it fails it is "refused" with the reason. Neither
   falls back to the wallet: nothing is listed or sent in its name.
   ============================================================ */
import { INDEPENDENT } from "./config.js";

export const IDENTITY_PREFIX = "enclave_identity:v1:";
export const ACCOUNT_SESSION_PREFIX = "enclave_account_session:";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const lower = (a) => String(a || "").toLowerCase();
const WALLET = Object.freeze({ kind: "wallet" });

export class IdentityError extends Error {
  constructor(message, { code = "refused", retryable = false } = {}){ super(message); this.name = "IdentityError"; this.code = code; this.retryable = retryable; this.identityRefused = true; }
}

let _ls = null, _state = null, _verifying = null, _reader = null, _emit = null, _deps = null;
function storage(){ if (_ls) return _ls; try { return globalThis.localStorage || null; } catch { return null; } }
const chainId = () => (INDEPENDENT.profile && INDEPENDENT.profile.chainId) || 8453;
function announce(){
  const s = currentIdentity();
  if (_emit) return _emit(s);
  try { globalThis.document?.dispatchEvent(new CustomEvent("enclave:identity", { detail: s })); } catch {}
}
/** Tests only: storage, an agreed reader, an event sink and stand-ins for the chain verifiers (test/site-independent-identity.test.mjs;
 *  the real verifiers against the pinned code run in test/site-independent-passkey-ui.test.mjs). */
export function _setForTests({ ls = null, reader = null, emit = null, deps = null } = {}){ _ls = ls; _reader = reader; _emit = emit; _deps = deps; _state = null; _verifying = null; }
const modules = async () => {
  const [PA, AP] = await Promise.all([import("./passkey-account.js"), import("./account-providers.js")]);
  return { PA: { ...PA, ...(_deps && _deps.PA) }, AP: { ...AP, ...(_deps && _deps.AP) } };
};

/** The account session pointer: one per account (the wallet keeps "enclave_wallet_session"). */
export const accountSessionKey = (id, safe) => ACCOUNT_SESSION_PREFIX + id + ":" + lower(safe);

/** The stored selection for this chain, or null (the wallet). Only ever written by selectAccountIdentity. */
export function storedIdentity(ls = storage()){
  try {
    const v = JSON.parse((ls && ls.getItem(IDENTITY_PREFIX + chainId())) || "null");
    return v && v.kind === "account" && ADDR.test(v.safe) ? { kind: "account", safe: lower(v.safe), block: Number(v.block) || 0 } : null;
  } catch { return null; }
}

/** { kind: "wallet" } or { kind: "account", safe, state: "pending" | "verified" | "refused", reason, block, warnings }. Synchronous:
 *  a stored selection reads as "pending" until ensureIdentity() has re-verified it on this page. */
export function currentIdentity(){
  if (_state) return _state;
  if (INDEPENDENT.state !== "on") return WALLET;
  const s = storedIdentity();
  _state = s ? { kind: "account", safe: s.safe, state: "pending", reason: null, block: s.block, warnings: [] } : WALLET;
  return _state;
}
/** The address the dashboard acts for: the wallet's (wallet identity), the Safe's once verified, else null (never the wallet). */
export function actingOwner(wallet){
  const s = currentIdentity();
  if (s.kind === "wallet") return wallet ? lower(wallet) : null;
  return s.state === "verified" ? s.safe : null;
}
/** A stable key for "whose rows these are": "" for the wallet identity (the caller keys by wallet), "safe:<address>" for an account. */
export function identityKey(){ const s = currentIdentity(); return s.kind === "account" ? "safe:" + s.safe : ""; }

/** Everything that makes `profile` an identity, at ONE agreed block. -> { safe, block, warnings }; IdentityError otherwise. */
export async function verifyAccountIdentity(profile, { reader } = {}){
  const { PA, AP } = await modules();
  try { PA.validateAccountProfile(profile); } catch (e){ throw new IdentityError("the account description on this browser is invalid: " + e.message, { code: "profile" }); }
  if (profile.chainId !== chainId()) throw new IdentityError("the account is on chain " + profile.chainId + ", the network profile on " + chainId(), { code: "chain" });
  const r = reader || _reader || (await import("./independent-chain.js")).reader();
  let snap;
  try { snap = await r.snapshot(); } catch (e){ throw new IdentityError("could not read the chain at an agreed block: " + (e.message || e), { code: "quorum", retryable: true }); }
  const at = { snapshot: async () => snap, call: (s, to, data) => r.call(s, to, data), code: (s, a) => r.code(s, a) };
  let v, id;
  try {
    v = await PA.verifyAccountProfile(profile, { reader: at });
    id = v.deployed ? await AP.identifyAccount(profile.safe, { reader: at }) : null;
  } catch (e){
    if (e && e.name === "AccountError") throw new IdentityError(e.message, { code: e.code || "mismatch" });
    throw new IdentityError("could not verify the account at an agreed block: " + (e.message || e), { code: "quorum", retryable: true });
  }
  if (!v.deployed) throw new IdentityError("the account is not deployed yet (deploy it first: a predicted address cannot own anything)", { code: "undeployed" });
  if (id.provider !== "safe-passkey" || !id.recognized) throw new IdentityError("the address is not a Safe on the pinned singleton", { code: "provider" });
  const unknown = id.modules.filter((m) => !m.known);
  if (unknown.length) throw new IdentityError("module " + unknown[0].address + " is enabled: it could act without the owners. Disable it first", { code: "module" });
  if (!/^0x0{40}$/.test(id.guard)) throw new IdentityError("guard " + id.guard + " is set: it could block the account's transactions", { code: "guard" });
  const pins = AP.PROVIDERS["safe-passkey"].contracts;
  if (id.fallbackHandler !== pins.fallbackHandler.address && id.fallbackHandler !== pins.safe4337Module.address)
    throw new IdentityError("the fallback handler " + id.fallbackHandler + " is not a pinned handler: its ERC-1271 answers are unreviewed", { code: "handler" });
  const want = profile.owners.map(PA.ownerAddress).sort(), got = id.owners.map((o) => lower(o.address)).sort();
  if (want.length !== got.length || want.some((a, i) => a !== got[i]) || id.threshold !== profile.threshold)
    throw new IdentityError("the account's owners or threshold on chain (" + got.length + " owners, threshold " + id.threshold + ") differ from this browser's description", { code: "mismatch" });
  for (const o of profile.owners.filter((x) => x.kind === "passkey")){
    const w = id.owners.find((w) => w.kind === "passkey" && lower(w.address) === lower(o.signer));
    if (!w) throw new IdentityError("passkey " + o.label + " is not a recognized passkey signer on chain", { code: "mismatch" });
    // the shared signer is one address for every Safe: what counts is the key configured in THIS Safe's storage
    if (o.shared && !(w.configured && BigInt(w.x) === BigInt(o.x) && BigInt(w.y) === BigInt(o.y)))
      throw new IdentityError("the passkey configured for this account's shared signer is not " + o.label, { code: "mismatch" });
  }
  // the enabled 4337 module is the pinned code; its EntryPoint must be the pinned v0.7 one, read from the module itself
  const L = await PA.lib();
  const ep = await at.call(snap, pins.safe4337Module.address, L.encodeFunctionData({ abi: PA.ABI.module4337, functionName: "SUPPORTED_ENTRYPOINT", args: [] }));
  if (lower("0x" + String(ep).slice(-40)) !== pins.entryPoint.address)
    throw new IdentityError("the account's 4337 module names EntryPoint 0x" + String(ep).slice(-40) + ", not the pinned " + pins.entryPoint.address, { code: "entrypoint" });
  return { safe: lower(profile.safe), block: snap.number, warnings: id.warnings };
}

/** Re-verify the stored selection once per page load (and again after a transient failure). Resolves to currentIdentity(). */
export function ensureIdentity({ loadProfile } = {}){
  const s = currentIdentity();
  if (s.kind !== "account" || s.state === "verified" || (s.state === "refused" && !s.retryable)) return Promise.resolve(s);
  return _verifying ||= (async () => {
    const { PA } = await modules();
    const profile = (loadProfile || PA.loadAccountProfile)(chainId(), storage());
    try {
      if (!profile) throw new IdentityError("this browser no longer has the account's description (import it again, or use your wallet)", { code: "profile" });
      if (lower(profile.safe) !== s.safe) throw new IdentityError("this browser's account description is for " + profile.safe + ", not the selected " + s.safe, { code: "profile" });
      const v = await verifyAccountIdentity(profile);
      _state = { kind: "account", safe: s.safe, state: "verified", reason: null, block: v.block, warnings: v.warnings, profile };
    } catch (e){
      _state = { kind: "account", safe: s.safe, state: "refused", reason: e.message || String(e), retryable: !!e.retryable, block: s.block, warnings: [] };
    }
    _verifying = null;
    announce();
    return _state;
  })();
}

/** The explicit "Use this account as my dashboard identity": verified first, then stored. */
export async function selectAccountIdentity(profile){
  if (INDEPENDENT.state !== "on") throw new IdentityError("a passkey account can be the dashboard identity only in independent mode", { code: "mode" });
  const v = await verifyAccountIdentity(profile);
  const ls = storage();
  ls.setItem(IDENTITY_PREFIX + chainId(), JSON.stringify({ kind: "account", safe: v.safe, block: v.block }));
  _verifying = null;
  _state = { kind: "account", safe: v.safe, state: "verified", reason: null, block: v.block, warnings: v.warnings, profile };
  announce();
  return _state;
}

/** "Use my connected wallet": the wallet identity again. The account's session stays in its own pointer for later. */
export function useWalletIdentity(){
  const ls = storage();
  if (ls) ls.removeItem(IDENTITY_PREFIX + chainId());
  _verifying = null;
  _state = WALLET;
  announce();
  return _state;
}

/** The verified account's description (passkeys, threshold), or null. */
export const identityProfile = () => { const s = currentIdentity(); return s.kind === "account" && s.state === "verified" ? s.profile : null; };
