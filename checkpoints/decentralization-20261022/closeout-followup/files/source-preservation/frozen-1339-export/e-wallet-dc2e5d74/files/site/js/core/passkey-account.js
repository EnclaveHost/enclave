/* ============================================================
   An owner-controlled passkey account in the independent dashboard:
   a Safe v1.4.1 whose owners are the owner's passkeys (each a
   SafeWebAuthnSignerProxy from the pinned factory, under its own RP)
   and, optionally, recovery keys - with the pinned Safe4337Module so
   the owner's own ERC-4337 bundler/paymaster can act for it.
   Interface: work/passkey-aa-interface.txt. Pins and recognition:
   account-providers.js.

   This module BUILDS what already-deployed, pinned contracts verify:
   - the account's creation calldata (signer proxies, Safe setup) and
     its CREATE2 address, from agreed reads;
   - Safe-format ERC-1271 signatures from passkey assertions (the Safe
     checks each contract signature with the passkey signer, which runs
     the audited WebAuthn library and the RIP-7212 precompile);
   - Safe owner-management transactions (recovery) and ERC-4337 v0.7
     user operations for the Safe4337Module.
   ABI and EIP-712 encoding is viem's, and WebAuthn credential handling
   is ox's (both from the repository, vendored as /vendor/aa.js). Nothing
   here verifies a signature or implements a curve.

   Nothing is chosen silently: no default bundler, paymaster, RP, key or
   threshold, and never an Enclave relay. Where no owner transport is
   configured, calldata is offered for any submitter instead.
   ============================================================ */
import { reader as quorumReader } from "./independent-chain.js";
import { PROVIDERS, validateAccountTransport, enclaveHost } from "./account-providers.js";

const P = PROVIDERS["safe-passkey"];
const C = Object.fromEntries(Object.entries(P.contracts).map(([k, v]) => [k, v.address]));
export const PROFILE_PREFIX = "enclave_account_profile:v1:";
const ADDR = /^0x[0-9a-fA-F]{40}$/, B64URL = /^[A-Za-z0-9_-]{16,512}$/, DNS = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SENTINEL = "0x0000000000000000000000000000000000000001";
const lower = (a) => String(a || "").toLowerCase();

/* the passkey signer's P-256 verifiers: the RIP-7212 precompile (live on Base), optionally with the pinned Daimo verifier as
   fallback - Safe's packing (uint176: 2-byte precompile << 160 | fallback address) */
export const VERIFIERS_PRECOMPILE = (0x100n << 160n);
export const VERIFIERS_WITH_FALLBACK = (0x100n << 160n) | BigInt(C.daimoP256Verifier);
const ALLOWED_VERIFIERS = new Set([VERIFIERS_PRECOMPILE, VERIFIERS_WITH_FALLBACK]);

let _lib = null;
/** viem + ox (vendored /vendor/aa.js in the browser; injected in tests). */
export function lib(){ return _lib ||= import("/vendor/aa.js"); }
export function _useLibForTests(l){ _lib = Promise.resolve(l); }

export class AccountError extends Error {
  constructor(message, { code = "refused" } = {}){ super(message); this.name = "AccountError"; this.code = code; }
}
const fail = (m, code) => new AccountError(m, { code });

/* ---- ABIs (exactly the functions used; the pinned contracts' published ABIs) ---- */
const PACKED_USEROP = { type: "tuple", components: ["address sender", "uint256 nonce", "bytes initCode", "bytes callData", "bytes32 accountGasLimits",
  "uint256 preVerificationGas", "bytes32 gasFees", "bytes paymasterAndData", "bytes signature"].map((s) => { const [type, name] = s.split(" "); return { type, name }; }) };
const fn = (name, inputs, outputs = [], stateMutability = "nonpayable") => ({ type: "function", name, stateMutability,
  inputs: inputs.map((t, i) => (typeof t === "string" ? { type: t, name: "a" + i } : t)), outputs: outputs.map((t) => (typeof t === "string" ? { type: t } : t)) });
export const ABI = {
  signerFactory: [fn("getSigner", ["uint256", "uint256", "uint176"], ["address"], "view"), fn("createSigner", ["uint256", "uint256", "uint176"], ["address"])],
  proxyFactory: [fn("createProxyWithNonce", ["address", "bytes", "uint256"], ["address"]), fn("proxyCreationCode", [], ["bytes"], "pure")],
  safe: [fn("setup", ["address[]", "uint256", "address", "bytes", "address", "address", "uint256", "address"]),
    fn("getTransactionHash", ["address", "uint256", "bytes", "uint8", "uint256", "uint256", "uint256", "address", "address", "uint256"], ["bytes32"], "view"),
    fn("nonce", [], ["uint256"], "view"), fn("getOwners", [], ["address[]"], "view"), fn("getThreshold", [], ["uint256"], "view"),
    fn("execTransaction", ["address", "uint256", "bytes", "uint8", "uint256", "uint256", "uint256", "address", "address", "bytes"], ["bool"]),
    fn("addOwnerWithThreshold", ["address", "uint256"]), fn("removeOwner", ["address", "address", "uint256"]),
    fn("swapOwner", ["address", "address", "address"]), fn("changeThreshold", ["uint256"])],
  moduleSetup: [fn("enableModules", ["address[]"])],
  module4337: [fn("executeUserOp", ["address", "uint256", "bytes", "uint8"]), fn("getOperationHash", [PACKED_USEROP], ["bytes32"], "view"),
    fn("SUPPORTED_ENTRYPOINT", [], ["address"], "view")],
  entryPoint: [fn("getNonce", ["address", "uint192"], ["uint256"], "view"), fn("handleOps", [{ type: "tuple[]", components: PACKED_USEROP.components }, "address"]),
    fn("getUserOpHash", [PACKED_USEROP], ["bytes32"], "view"), fn("balanceOf", ["address"], ["uint256"], "view")],
  multiSend: [fn("multiSend", ["bytes"])],
  sharedSigner: [fn("configure", [{ type: "tuple", components: [{ name: "x", type: "uint256" }, { name: "y", type: "uint256" }, { name: "verifiers", type: "uint176" }] }]),
    fn("getConfiguration", ["address"], [{ type: "tuple", components: [{ name: "x", type: "uint256" }, { name: "y", type: "uint256" }, { name: "verifiers", type: "uint176" }] }], "view")],
};
/* The pinned SafeWebAuthnSharedSigner: ONE passkey per Safe whose key lives in the Safe's own storage (written by a
   delegatecall from Safe.setup), so the account needs no signer contract deployed first - what a first deployment through
   ERC-4337 with no other gas payer requires. Further passkeys (other RPs) remain per-key signer proxies. */
export const SHARED_SIGNER = C.webauthnSharedSigner;

async function agreedCall(reader, snap, to, abi, functionName, args = []){
  const L = await lib();
  const ret = await reader.call(snap, to, L.encodeFunctionData({ abi, functionName, args }));
  return L.decodeFunctionResult({ abi, functionName, data: ret });
}

/* ---- passkeys ---- */
/** Create a passkey on THIS page's RP (or a registrable parent the browser allows). -> {credentialId, x, y, rpId}. The private
 *  key never leaves the authenticator. createFn: tests only. */
export async function createPasskey({ rpId, rpName, userName, createFn } = {}){
  if (!DNS.test(String(rpId || ""))) throw fail("choose the RP id this passkey will belong to (a domain name)", "input");
  if (!userName || String(userName).length > 64) throw fail("name the passkey (1-64 characters)", "input");
  const { WebAuthnP256 } = await lib();
  const c = await WebAuthnP256.createCredential({ name: String(userName), rp: { id: rpId, name: String(rpName || rpId) }, ...(createFn ? { createFn } : {}) });
  return { credentialId: c.id, x: "0x" + c.publicKey.x.toString(16).padStart(64, "0"), y: "0x" + c.publicKey.y.toString(16).padStart(64, "0"), rpId };
}

/** The signer proxy for a passkey (pinned factory, agreed read) and the permissionless call that deploys it. */
export async function passkeySigner({ x, y, verifiers = VERIFIERS_PRECOMPILE }, { reader = quorumReader() } = {}){
  if (!ALLOWED_VERIFIERS.has(BigInt(verifiers))) throw fail("passkey verifiers must be the RIP-7212 precompile, optionally with the pinned Daimo fallback", "input");
  const L = await lib(), snap = await reader.snapshot();
  const [signer] = [await agreedCall(reader, snap, C.webauthnSignerFactory, ABI.signerFactory, "getSigner", [BigInt(x), BigInt(y), BigInt(verifiers)])];
  const code = await reader.code(snap, signer);
  return { signer: lower(signer), deployed: !!code && code !== "0x", block: snap.number,
    deploy: { to: C.webauthnSignerFactory, data: L.encodeFunctionData({ abi: ABI.signerFactory, functionName: "createSigner", args: [BigInt(x), BigInt(y), BigInt(verifiers)] }) } };
}

/* ---- the account ---- */
function checkOwners(owners, threshold){
  if (!Array.isArray(owners) || owners.length < 1 || owners.length > 16) throw fail("an account needs 1 to 16 owners", "input");
  const set = new Set(owners.map(lower));
  if (set.size !== owners.length || owners.some((o) => !ADDR.test(o) || lower(o) === SENTINEL || /^0x0{40}$/.test(o))) throw fail("owners must be distinct, non-zero addresses", "input");
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > owners.length) throw fail("the threshold must be between 1 and the number of owners", "input");
}
/** Safe.setup with the pinned 4337 module enabled and as fallback handler (it IS a CompatibilityFallbackHandler).
 *  With a shared-signer passkey (`shared` = its {x, y, verifiers}), setup delegatecalls the pinned MultiSend, which in the
 *  SAME initializer enables the module and writes the passkey into the Safe's storage (SafeWebAuthnSharedSigner.configure) -
 *  Safe's own 4337-passkeys setup. The initializer is part of the CREATE2 salt, so whoever deploys this address deploys
 *  exactly these owners, this key, this module and this handler. */
export async function safeInitializer({ owners, threshold, shared = null }){
  checkOwners(owners, threshold);
  const L = await lib();
  const enable = L.encodeFunctionData({ abi: ABI.moduleSetup, functionName: "enableModules", args: [[C.safe4337Module]] });
  let to = C.safeModuleSetup, data = enable;
  if (shared){
    if (!owners.map(lower).includes(SHARED_SIGNER)) throw fail("the shared signer must be an owner to configure it", "input");
    if (!ALLOWED_VERIFIERS.has(BigInt(shared.verifiers))) throw fail("passkey verifiers must be the RIP-7212 precompile, optionally with the pinned Daimo fallback", "input");
    const configure = L.encodeFunctionData({ abi: ABI.sharedSigner, functionName: "configure", args: [{ x: BigInt(shared.x), y: BigInt(shared.y), verifiers: BigInt(shared.verifiers) }] });
    to = C.multiSend;
    data = L.encodeFunctionData({ abi: ABI.multiSend, functionName: "multiSend", args: [await multiSendPack([
      { operation: 1, to: C.safeModuleSetup, value: 0n, data: enable }, { operation: 1, to: SHARED_SIGNER, value: 0n, data: configure }])] });
  }
  return L.encodeFunctionData({ abi: ABI.safe, functionName: "setup",
    args: [owners.map((o) => L.getAddress(o)), BigInt(threshold), L.getAddress(to), data, C.safe4337Module, "0x0000000000000000000000000000000000000000", 0n, "0x0000000000000000000000000000000000000000"] });
}
/** MultiSend's packed transactions: operation(1) || to(20) || value(32) || dataLength(32) || data, per transaction. */
export async function multiSendPack(txs){
  const L = await lib();
  return L.concat(txs.map((t) => L.encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [t.operation, L.getAddress(t.to), BigInt(t.value || 0n), BigInt((t.data.length - 2) / 2), t.data])));
}
/** What a profile's Safe is created from: owners (in profile order), threshold, salt and the shared-signer key, if any. */
export function creationOf(p){
  const sh = p.owners.find((o) => o.kind === "passkey" && o.shared);
  return { owners: p.owners.map(ownerAddress), threshold: p.threshold, saltNonce: p.saltNonce, shared: sh ? { x: sh.x, y: sh.y, verifiers: sh.verifiers } : null };
}
/** The account's creation call and its CREATE2 address (SafeProxyFactory: salt = keccak(keccak(initializer), saltNonce);
 *  code = proxyCreationCode || uint256(singleton)), from an agreed read of the factory's creation code. */
export async function prepareSafeCreation({ owners, threshold, saltNonce, shared = null }, { reader = quorumReader() } = {}){
  if (!/^\d{1,78}$/.test(String(saltNonce))) throw fail("choose a salt (a decimal number) for the account address", "input");
  const L = await lib(), snap = await reader.snapshot();
  const initializer = await safeInitializer({ owners, threshold, shared });
  const creationCode = await agreedCall(reader, snap, C.safeProxyFactory, ABI.proxyFactory, "proxyCreationCode");
  const salt = L.keccak256(L.encodePacked(["bytes32", "uint256"], [L.keccak256(initializer), BigInt(saltNonce)]));
  const initHash = L.keccak256(L.concat([creationCode, L.pad(C.safeL2, { size: 32 })]));
  const safe = lower("0x" + L.keccak256(L.concat(["0xff", C.safeProxyFactory, salt, initHash])).slice(26));
  const code = await reader.code(snap, safe);
  return { safe, deployed: !!code && code !== "0x", block: snap.number, initializer,
    initCode: { factory: C.safeProxyFactory, data: L.encodeFunctionData({ abi: ABI.proxyFactory, functionName: "createProxyWithNonce", args: [C.safeL2, initializer, BigInt(saltNonce)] }) },
    create: { to: C.safeProxyFactory, data: L.encodeFunctionData({ abi: ABI.proxyFactory, functionName: "createProxyWithNonce", args: [C.safeL2, initializer, BigInt(saltNonce)] }) } };
}

/* ---- the owner-selected account profile ---- */
export function validateAccountProfile(p){
  if (!p || typeof p !== "object" || Array.isArray(p)) throw fail("account profile must be an object", "input");
  const keys = ["v", "provider", "chainId", "safe", "saltNonce", "threshold", "owners", "transport"];
  if (Object.keys(p).some((k) => !keys.includes(k)) || keys.some((k) => !(k in p))) throw fail("account profile has missing or unknown fields", "input");
  if (p.v !== 1 || p.provider !== "safe-passkey" || p.chainId !== P.chainId || !ADDR.test(p.safe) || !/^\d{1,78}$/.test(p.saltNonce)) throw fail("unsupported account profile", "input");
  const owners = p.owners;
  if (!Array.isArray(owners) || !owners.length) throw fail("the account profile names no owners", "input");
  for (const o of owners){
    if (o.kind === "passkey"){
      const ok = ["kind", "signer", "x", "y", "verifiers", "credentialId", "rpId", "label", "shared"];
      if ("shared" in o && (o.shared !== true || lower(o.signer) !== SHARED_SIGNER)) throw fail("a shared-signer passkey names the pinned shared signer " + SHARED_SIGNER, "input");
      if (Object.keys(o).some((k) => !ok.includes(k)) || !ADDR.test(o.signer) || !/^0x[0-9a-f]{64}$/.test(o.x) || !/^0x[0-9a-f]{64}$/.test(o.y)
          || !ALLOWED_VERIFIERS.has(BigInt(o.verifiers)) || !B64URL.test(o.credentialId) || !DNS.test(o.rpId) || typeof o.label !== "string")
        throw fail("a passkey owner needs its signer, public key, pinned verifiers, credential id and RP id", "input");
    } else if (o.kind === "key"){
      if (Object.keys(o).some((k) => !["kind", "address", "label"].includes(k)) || !ADDR.test(o.address) || typeof o.label !== "string") throw fail("a key owner needs an address", "input");
    } else throw fail("owners are passkeys or keys", "input");
  }
  checkOwners(owners.map(ownerAddress), p.threshold);
  if (owners.filter((o) => o.shared).length > 1) throw fail("a Safe holds one shared-signer passkey; add further passkeys as their own signers", "input");
  if (p.transport !== null) validateAccountTransport(p.transport);
  return p;
}
export const ownerAddress = (o) => lower(o.kind === "passkey" ? o.signer : o.address);
function storage(){ try { return globalThis.localStorage || null; } catch { return null; } }
export function loadAccountProfile(chainId = P.chainId, ls = storage()){
  try { const p = JSON.parse((ls && ls.getItem(PROFILE_PREFIX + chainId)) || "null"); return p ? validateAccountProfile(p) : null; } catch { return null; }
}
/* only ever on the owner's explicit action, after verifyAccountProfile */
export function saveAccountProfile(p, ls = storage()){ validateAccountProfile(p); ls.setItem(PROFILE_PREFIX + p.chainId, JSON.stringify(p)); }

/** Every passkey signer is what the pinned factory derives; the Safe is either the predicted address of exactly these owners,
 *  threshold and salt, or a deployed Safe whose owners and threshold are exactly these (an agreed read). */
export async function verifyAccountProfile(p, { reader = quorumReader() } = {}){
  validateAccountProfile(p);
  for (const o of p.owners.filter((x) => x.kind === "passkey" && !x.shared)){
    const s = await passkeySigner(o, { reader });
    if (s.signer !== lower(o.signer)) throw fail("passkey " + o.label + " does not derive signer " + o.signer + " on the pinned factory", "mismatch");
  }
  const owners = p.owners.map(ownerAddress), shared = creationOf(p).shared;
  // a DEPLOYED account's shared-signer key is the one in its own storage, read through the pinned shared signer
  const sharedMatches = async (snap) => {
    if (!shared) return;
    const [cfg] = [await agreedCall(reader, snap, SHARED_SIGNER, ABI.sharedSigner, "getConfiguration", [L.getAddress(p.safe)])];
    if (cfg.x !== BigInt(shared.x) || cfg.y !== BigInt(shared.y) || cfg.verifiers !== BigInt(shared.verifiers))
      throw fail("the passkey configured in the deployed account's shared signer is not this description's passkey", "mismatch");
  };
  const L = await lib();
  const pred = await prepareSafeCreation({ owners, threshold: p.threshold, saltNonce: p.saltNonce, shared }, { reader });
  if (pred.safe === lower(p.safe)){
    if (pred.deployed) await sharedMatches(await reader.snapshot());
    return { ok: true, deployed: pred.deployed, block: pred.block, predicted: true };
  }
  const snap = await reader.snapshot();
  const [onOwners, onThreshold] = [await agreedCall(reader, snap, p.safe, ABI.safe, "getOwners"), await agreedCall(reader, snap, p.safe, ABI.safe, "getThreshold")];
  const same = onOwners.length === owners.length && onOwners.every((o) => owners.includes(lower(o))) && Number(onThreshold) === p.threshold;
  if (!same) throw fail("the account's owners or threshold on chain differ from this profile (" + onOwners.length + " owners, threshold " + onThreshold + ")", "mismatch");
  await sharedMatches(snap);
  return { ok: true, deployed: true, block: snap.number, predicted: false };
}

/** Plain capability statements for the profile (the panel shows these verbatim). */
export function accountCapabilities(p){
  const passkeys = p.owners.filter((o) => o.kind === "passkey"), keys = p.owners.filter((o) => o.kind === "key");
  const rps = [...new Set(passkeys.map((o) => o.rpId))];
  const out = [];
  out.push(p.owners.length + " owner(s): " + passkeys.length + " passkey(s) under " + rps.length + " RP id(s)" + (rps.length ? " (" + rps.join(", ") + ")" : "") + ", " + keys.length + " recovery key(s); " + p.threshold + " of " + p.owners.length + " must approve each action.");
  if (p.owners.length === 1) out.push("One owner: losing it loses the account. There is no recovery.");
  else if (p.threshold === 1) out.push("Any single owner controls the account alone, including changing the owners.");
  if (p.owners.length - p.threshold < 1 && p.owners.length > 1) out.push("No spare owner: losing any one blocks the account.");
  if (passkeys.length && rps.length === 1) out.push("Every passkey is under " + rps[0] + ": in a browser they can be used only on that domain, so whoever runs " + rps[0] + " decides whether they stay usable. Add a passkey under another RP, a security key or a recovery key.");
  if (keys.length) out.push("Recovery keys work without any website (a wallet key, a security key or another Safe).");
  const sh = passkeys.find((o) => o.shared);
  if (sh) out.push("Passkey " + sh.label + " is the account's built-in signer: the account can create itself in its own first operation, with no wallet, once its address holds ETH for gas.");
  out.push(p.transport ? "Gas: your own ERC-4337 transport (" + p.transport.bundlers.length + " bundler(s)" + (p.transport.paymaster ? ", paymaster " + p.transport.paymaster.address : ", no paymaster: the account pays in ETH") + ")."
    : "Gas: no ERC-4337 transport chosen. Transactions are sent by a submitter you pick (your connected wallet, or anyone given the calldata).");
  // what the owner chose may itself be Enclave's: name it rather than claim independence
  const hostOf = (u) => new URL(u).hostname.toLowerCase();
  const enc = [...rps.filter(enclaveHost).map((r) => "RP " + r),
    ...(p.transport ? p.transport.bundlers.map(hostOf).filter(enclaveHost).map((h) => "bundler " + h) : []),
    ...(p.transport && p.transport.paymaster && enclaveHost(hostOf(p.transport.paymaster.url)) ? ["paymaster service " + hostOf(p.transport.paymaster.url)] : [])];
  out.push(enc.length ? "Enclave runs part of this account's path (" + enc.join(", ") + "): Enclave decides whether that part stays usable. No Enclave account or relay is involved."
    : "No Enclave account, relay, RP, bundler or paymaster is involved.");
  return out;
}

/* ---- Safe-format signatures ---- */
/** The SafeMessage hash a Safe's ERC-1271 check asks its owners to sign for `digest` (CompatibilityFallbackHandler
 *  getMessageHashForSafe(safe, abi.encode(digest)); EIP-712 domain {chainId, verifyingContract: safe}). */
export async function safeMessageHash(safe, chainId, digest){
  const L = await lib();
  return L.hashTypedData({ domain: { chainId, verifyingContract: L.getAddress(safe) }, types: { SafeMessage: [{ name: "message", type: "bytes" }] },
    primaryType: "SafeMessage", message: { message: L.encodeAbiParameters([{ type: "bytes32" }], [digest]) } });
}
const b64url = (hex) => { const b = String(hex).replace(/^0x/, "").match(/../g).map((h) => parseInt(h, 16)); let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
/** A passkey assertion (ox WebAuthnP256.sign) as the Safe passkey signer's signature: abi.encode(authenticatorData,
 *  clientDataFields, r, s). The signer rebuilds clientDataJSON as '{"type":"webauthn.get","challenge":"<b64url>",' + fields
 *  + '}', so the assertion must have exactly that shape for THIS challenge - refused here otherwise, before anyone pays. */
export async function passkeyContractSignature(assertion, challenge){
  const L = await lib();
  const cdj = assertion.metadata.clientDataJSON;
  const head = '{"type":"webauthn.get","challenge":"' + b64url(challenge) + '",';
  if (!cdj.startsWith(head) || !cdj.endsWith("}")) throw fail("the passkey's answer is not an assertion over this exact challenge", "assertion");
  const flags = parseInt(String(assertion.metadata.authenticatorData).slice(2 + 64, 2 + 66), 16);
  if ((flags & 0x05) !== 0x05) throw fail("the passkey did not report user presence and verification", "assertion");
  return L.encodeAbiParameters([{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
    [assertion.metadata.authenticatorData, cdj.slice(head.length, -1), assertion.signature.r, assertion.signature.s]);
}
/** Safe v1.4.1 signature bytes from owner signatures, in ascending owner order: contract signatures as {r: signer, s: offset,
 *  v: 0} + dynamic (length || data); ECDSA as the 65 bytes the owner produced. */
export async function safeSignatures(parts){
  const L = await lib();
  const sorted = [...parts].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  let staticPart = "0x", dynamicPart = "0x";
  const base = sorted.length * 65;
  for (const p of sorted){
    if (p.ecdsa){ staticPart = L.concat([staticPart, p.ecdsa]); continue; }
    const offset = base + (dynamicPart.length - 2) / 2;
    staticPart = L.concat([staticPart, L.pad(p.signer, { size: 32 }), L.pad(L.toHex(BigInt(offset)), { size: 32 }), "0x00"]);
    dynamicPart = L.concat([dynamicPart, L.pad(L.toHex(BigInt((p.data.length - 2) / 2)), { size: 32 }), p.data]);
  }
  return L.concat([staticPart, dynamicPart]);
}
/** Assert `challenge` with each chosen passkey (each on its own RP) -> Safe contract-signature parts. */
export async function passkeyParts(passkeys, challenge, { getFn } = {}){
  const { WebAuthnP256 } = await lib();
  const parts = [];
  for (const k of passkeys){
    const a = await WebAuthnP256.sign({ challenge, credentialId: k.credentialId, rpId: k.rpId, userVerification: "required", ...(getFn ? { getFn } : {}) });
    parts.push({ signer: lower(k.signer), data: await passkeyContractSignature(a, challenge) });
  }
  return parts;
}

/** The sessions SDK OwnerSigner for this account: what the SDK asks the owner to sign (the SessionGrant, the USDC
 *  ReceiveWithAuthorization for a budget, owner operations) is signed as the SAFE by the chosen passkeys - and by key owners
 *  through `keySigner(hash) -> 65-byte signature` when the threshold needs them. */
export function passkeySafeOwnerSigner({ profile, passkeys, keySigner = null, keyAddress = null, getFn }){
  const approve = safeApprover({ profile, passkeys, keySigner, keyAddress, getFn });
  return { address: lower(profile.safe), signTypedData: async (td) => {
    const L = await lib();
    return approve(await safeMessageHash(profile.safe, profile.chainId, L.hashTypedData(td)));
  } };
}
/** challenge -> Safe signature bytes from `threshold` owners: the chosen passkeys first (each asserts on its own RP), then the
 *  key owner `keyAddress` (default: the first key owner) through `keySigner(hash)` when the passkeys alone are not enough.
 *  Refuses up front when they cannot reach it. */
export function safeApprover({ profile, passkeys, keySigner = null, keyAddress = null, getFn }){
  validateAccountProfile(profile);
  const chosen = passkeys.map((k) => profile.owners.find((o) => o.kind === "passkey" && o.credentialId === k));
  if (chosen.some((o) => !o)) throw fail("a chosen passkey is not an owner of this account", "input");
  if (chosen.length + (keySigner ? 1 : 0) < profile.threshold) throw fail("this account needs " + profile.threshold + " approvals", "input");
  const key = keySigner ? profile.owners.find((o) => o.kind === "key" && (!keyAddress || lower(o.address) === lower(keyAddress))) : null;
  if (keySigner && !key) throw fail(keyAddress + " is not a key owner of this account", "input");
  return async (challenge) => {
    const parts = await passkeyParts(chosen.slice(0, profile.threshold), challenge, { getFn });
    if (parts.length < profile.threshold && keySigner){
      parts.push({ signer: lower(key.address), ecdsa: await keySigner(challenge) });
    }
    return safeSignatures(parts);
  };
}

/* ---- owner management (recovery) through the Safe itself ---- */
/** An owner-management call on the Safe: add, remove or swap an owner, or change the threshold. -> {to, data, safeTxHash, nonce}
 *  for owners to approve; execTransaction then needs `threshold` approvals and can be sent by anyone. */
export async function prepareOwnerChange(profile, change, { reader = quorumReader() } = {}){
  validateAccountProfile(profile);
  const L = await lib(), snap = await reader.snapshot(), safe = L.getAddress(profile.safe);
  const owners = (await agreedCall(reader, snap, safe, ABI.safe, "getOwners")).map(lower);
  const prev = (o) => { const i = owners.indexOf(lower(o)); if (i < 0) throw fail(o + " is not an owner of this account", "input"); return i === 0 ? SENTINEL : owners[i - 1]; };
  let data;
  if (change.op === "add") data = L.encodeFunctionData({ abi: ABI.safe, functionName: "addOwnerWithThreshold", args: [L.getAddress(change.owner), BigInt(change.threshold)] });
  else if (change.op === "remove") data = L.encodeFunctionData({ abi: ABI.safe, functionName: "removeOwner", args: [L.getAddress(prev(change.owner)), L.getAddress(change.owner), BigInt(change.threshold)] });
  else if (change.op === "swap") data = L.encodeFunctionData({ abi: ABI.safe, functionName: "swapOwner", args: [L.getAddress(prev(change.oldOwner)), L.getAddress(change.oldOwner), L.getAddress(change.newOwner)] });
  else if (change.op === "threshold") data = L.encodeFunctionData({ abi: ABI.safe, functionName: "changeThreshold", args: [BigInt(change.threshold)] });
  else throw fail("unknown owner change", "input");
  return prepareSafeCall(profile, { to: safe, data }, { reader, snap });
}
/** execTransaction for a prepared owner change, with the owners' signatures (Safe format). */
export const execOwnerChange = (prepared, signatures) => execSafeCall(prepared, signatures);

/* ---- any call the Safe makes (a ledger call on a record the Safe itself holds) ---- */
const ZERO = "0x0000000000000000000000000000000000000000";
/** One CALL from the Safe (no delegatecall, no refund, no gas price): its safeTxHash (Safe.getTransactionHash at the Safe's
 *  current nonce, an agreed read) is what `threshold` owners approve; execTransaction may then be sent by any gas payer. */
export async function prepareSafeCall(profile, { to, value = 0n, data = "0x" }, { reader = quorumReader(), snap = null } = {}){
  validateAccountProfile(profile);
  if (!ADDR.test(String(to || ""))) throw fail("a Safe call needs a target address", "input");
  if (!/^0x([0-9a-fA-F]{2})*$/.test(String(data))) throw fail("a Safe call's data must be hex bytes", "input");
  const L = await lib(), at = snap || await reader.snapshot(), safe = L.getAddress(profile.safe);
  const nonce = await agreedCall(reader, at, safe, ABI.safe, "nonce");
  const safeTxHash = await agreedCall(reader, at, safe, ABI.safe, "getTransactionHash", [L.getAddress(to), BigInt(value), data, 0, 0n, 0n, 0n, ZERO, ZERO, nonce]);
  return { safe: lower(safe), to: lower(to), value: BigInt(value), data, nonce, safeTxHash, block: at.number };
}
/** The execTransaction for a prepared Safe call with the owners' signatures: {to: the Safe, data}. */
export async function execSafeCall(prepared, signatures){
  const L = await lib();
  const safe = prepared.safe || prepared.to;
  return { to: safe, data: L.encodeFunctionData({ abi: ABI.safe, functionName: "execTransaction",
    args: [L.getAddress(prepared.to), BigInt(prepared.value || 0n), prepared.data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures] }) };
}

/* ---- ERC-4337 v0.7 through the Safe4337Module: only the owner's own transport ---- */
const u128 = (v) => { const b = BigInt(v); if (b < 0n || b >= (1n << 128n)) throw fail("gas value out of range", "input"); return b; };
/** A user operation for one call from the Safe (or its creation plus that call). gas: the owner's limits (a bundler estimate,
 *  for example) - nothing is guessed here. */
export async function prepareUserOperation(profile, { to, value = 0n, data = "0x", operation = 0, initCode = null, gas, paymasterAndData = "0x", validAfter = 0, validUntil = 0 },
  { reader } = {}){
  if (operation !== 0 && !(operation === 1 && [C.multiSend, C.multiSendCallOnly].includes(lower(to))))
    throw fail("a user operation delegatecalls only the pinned MultiSend", "input");
  validateAccountProfile(profile);
  if (!profile.transport) throw fail("no ERC-4337 transport is chosen for this account: send it with a submitter you pick instead", "no-transport");
  if (!gas || ["verificationGasLimit", "callGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas"].some((k) => gas[k] == null)) throw fail("the user operation needs its gas limits and fees", "input");
  reader ||= quorumReader();
  const L = await lib(), snap = await reader.snapshot(), sender = L.getAddress(profile.safe);
  const nonce = await agreedCall(reader, snap, C.entryPoint, ABI.entryPoint, "getNonce", [sender, 0n]);
  const callData = L.encodeFunctionData({ abi: ABI.module4337, functionName: "executeUserOp", args: [L.getAddress(to), BigInt(value), data, operation] });
  const userOp = { sender, nonce, initCode: initCode ? L.concat([initCode.factory, initCode.data]) : "0x", callData,
    accountGasLimits: L.concat([L.pad(L.toHex(u128(gas.verificationGasLimit)), { size: 16 }), L.pad(L.toHex(u128(gas.callGasLimit)), { size: 16 })]),
    preVerificationGas: BigInt(gas.preVerificationGas),
    gasFees: L.concat([L.pad(L.toHex(u128(gas.maxPriorityFeePerGas)), { size: 16 }), L.pad(L.toHex(u128(gas.maxFeePerGas)), { size: 16 })]),
    paymasterAndData, signature: L.concat([L.pad(L.toHex(BigInt(validAfter)), { size: 6 }), L.pad(L.toHex(BigInt(validUntil)), { size: 6 })]) };
  const operationHash = await agreedCall(reader, snap, C.safe4337Module, ABI.module4337, "getOperationHash", [userOp]);
  return { userOp, operationHash, validAfter, validUntil, gas, initCode, block: snap.number };
}
/** The prepared operation with its Safe signatures (validAfter || validUntil || signatures). */
export async function signUserOperation(prepared, signatures){
  const L = await lib();
  return { ...prepared.userOp, signature: L.concat([L.pad(L.toHex(BigInt(prepared.validAfter)), { size: 6 }), L.pad(L.toHex(BigInt(prepared.validUntil)), { size: 6 }), signatures]) };
}
/** The v0.7 JSON-RPC form of a packed user operation (unpacked gas fields; factory/factoryData; split paymaster fields). */
export function toRpcUserOperation(userOp, { gas, initCode } = {}){
  const hex = (v) => "0x" + BigInt(v).toString(16);
  return { sender: userOp.sender, nonce: hex(userOp.nonce), callData: userOp.callData, signature: userOp.signature,
    callGasLimit: hex(gas.callGasLimit), verificationGasLimit: hex(gas.verificationGasLimit), preVerificationGas: hex(gas.preVerificationGas),
    maxFeePerGas: hex(gas.maxFeePerGas), maxPriorityFeePerGas: hex(gas.maxPriorityFeePerGas),
    ...(initCode ? { factory: initCode.factory, factoryData: initCode.data } : {}),
    // v0.7 RPC form of paymasterAndData: paymaster(20) || verificationGasLimit(16) || postOpGasLimit(16) || data
    ...(userOp.paymasterAndData && userOp.paymasterAndData !== "0x" ? (() => { const h = userOp.paymasterAndData.slice(2);
      if (h.length < 104) throw fail("paymasterAndData is too short", "input");
      return { paymaster: "0x" + h.slice(0, 40), paymasterVerificationGasLimit: hex("0x" + h.slice(40, 72)), paymasterPostOpGasLimit: hex("0x" + h.slice(72, 104)), paymasterData: "0x" + h.slice(104) }; })() : {}) };
}
/** One JSON-RPC request to an owner-chosen bundler. A JSON-RPC error is the bundler's ANSWER (`answered: true`); a network or
 *  HTTP failure leaves it unknown whether the bundler received the request. */
export async function bundlerRequest(url, method, params, { fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 15000 } = {}){
  let r;
  try {
    r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", redirect: "error", cache: "no-store",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e){ const x = new Error(String(e.message || e).slice(0, 160)); x.answered = false; throw x; }
  let j; try { j = await r.json(); } catch { const x = new Error("HTTP " + r.status + " without a JSON-RPC answer"); x.answered = false; throw x; }
  if (j && j.error){ const x = new Error(String(j.error.message || "refused").slice(0, 200)); x.answered = true; throw x; }
  return j ? j.result : undefined;
}
/** eth_sendUserOperation to the owner's bundlers, in the owner's order; never anything else. -> {userOpHash, bundler}.
 *  The SAME signed operation may go to the next bundler only after the previous one answered with a refusal or could not
 *  be reached; it has one nonce, so it executes at most once. Throws AccountError "transport" with `delivered`: false when
 *  every bundler answered with a refusal (nothing pending), "unknown" when any of them may have received it. */
export async function sendUserOperation(transport, userOp, { fetchImpl = (...a) => globalThis.fetch(...a), gas, initCode } = {}){
  const t = validateAccountTransport(transport);
  const rpcOp = toRpcUserOperation(userOp, { gas, initCode });
  const errors = [];
  let unanswered = false;
  for (const b of t.bundlers){
    try { return { userOpHash: await bundlerRequest(b, "eth_sendUserOperation", [rpcOp, t.entryPoint], { fetchImpl }), bundler: b }; }
    catch (e){ if (!e.answered) unanswered = true; errors.push(new URL(b).host + ": " + String(e.message || e).slice(0, 160)); }
  }
  const e = fail("none of your bundlers accepted the user operation (" + errors.join("; ") + "). Nothing else was tried.", "transport");
  e.delivered = unanswered ? "unknown" : false;
  throw e;
}

/** A signature of the right SHAPE for gas estimation only: the threshold's owners (passkeys as contract signatures with
 *  WebAuthn-sized data, keys as 65 bytes). It verifies nothing - the account answers "signature invalid", which an
 *  estimating bundler accepts. Never sent as a real operation. */
export async function estimationSignature(profile){
  const L = await lib();
  const fakeAuth = "0x" + "49".repeat(32) + "05" + "00000001";
  const fields = '"origin":"https://' + "x".repeat(24) + '","crossOrigin":false';
  const parts = profile.owners.slice(0, profile.threshold).map((o) => o.kind === "passkey"
    ? { signer: lower(o.signer), data: L.encodeAbiParameters([{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }], [fakeAuth, fields, (1n << 255n) - 1n, (1n << 255n) - 3n]) }
    : { signer: lower(o.address), ecdsa: "0x" + "11".repeat(64) + "1b" });
  return L.concat(["0x" + "00".repeat(12), await safeSignatures(parts)]);
}
/** The EntryPoint's own hash of a packed user operation (what the bundler and UserOperationEvent name it by), agreed. */
export async function userOperationHash(userOp, { reader = quorumReader(), snap = null } = {}){
  const at = snap || await reader.snapshot();
  return lower(await agreedCall(reader, at, C.entryPoint, ABI.entryPoint, "getUserOpHash", [userOp]));
}

/** The account's own signer for storage uploads (upload-auth.js, x-upload-scheme erc1271-v2): the adapter asks the Safe
 *  isValidSignature(eip191(message), signature), and the Safe's handler checks its owners over the SafeMessage of that
 *  digest - the same ERC-1271 path the session grant takes. -> { kind: "erc1271", account, chainId, sign(message) }. */
export function accountUploadSigner({ profile, passkeys, keySigner = null, keyAddress = null, getFn }){
  const approve = safeApprover({ profile, passkeys, keySigner, keyAddress, getFn });
  return { kind: "erc1271", account: lower(profile.safe), chainId: profile.chainId, sign: async (message) => {
    const L = await lib();
    const digest = L.keccak256(L.concat([L.toHex("\x19Ethereum Signed Message:\n" + new TextEncoder().encode(message).length), L.toHex(message)]));
    return approve(await safeMessageHash(profile.safe, profile.chainId, digest));
  } };
}
