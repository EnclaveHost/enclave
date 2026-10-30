/* ============================================================
   An EXISTING credit vault, operated without Enclave's billing API.

   EnclaveCreditVault (the production build, source d36100ae) is
   authorized by its owner's passkey alone: every operation carries a
   WebAuthn P-256 assertion over keccak256(abi.encode(OP_TAG, vault,
   chainid, nonce, args..., deadline)), the contract verifies it (RIP-7212
   precompile, the pinned origin), and ANYONE may submit it. The hosted
   path (/v1/billing/vault/prepare + exec, an account session) is a
   convenience on top; it is not an authority and stays the default.
   This module is the same operation with nothing in between:

   - discovery: the vault address is CREATE2 of the passkey's public key
     at each pinned factory, checked against the factory's own vaultFor,
     the exact EIP-1167 clone code, and keyActive - at ONE block that a
     quorum of the owner's RPCs agree on. The ledger the vault will pay
     or control is book.addr("deployments") as the VAULT reads it, so the
     platform book (admin) stays authoritative for ledger versions;
   - the public key, when no record of it is held: recovered from two
     passkey assertions (P-256 public-key recovery, @noble/curves);
   - preparation: exact calldata built HERE from the owner's own numbers
     (zero publisher fee, owner rate cap, amount <= what the owner typed
     and <= the balance, the record owned by this vault), the digest
     recomputed here, a deadline of at most 10 minutes of chain time;
   - signing at exactly the vault's pinned origin (anywhere else is
     refused before a prompt), with the assertion checked locally;
   - a SignedVaultRequest: everything a submitter needs and nothing
     secret. It is valid for ONE nonce until its deadline;
   - submission through a REPLACEABLE transport with an explicit payer
     (the owner's wallet, an owner key in the CLI, or an untrusted relay
     that can only submit the exact bytes), and a journal that HOLDS a
     request whose outcome is unknown until the chain decides it:
     executed, superseded (the nonce went to another op), or expired
     (the nonce unchanged after the deadline). Nothing new is prepared
     for a vault while one of its requests is undecided.

   What this does not do: pay gas from credit (closed-loop USDC cannot
   pay unrelated fees; the payer needs ETH), sell credit (card top-ups
   need Enclave's processor), or sign anywhere but the pinned origin
   (passkeys stay RP/origin bound). App lease gas for a vault-owned
   deployment is unavailable with the current EnclaveLeaseGasReserve:
   reserveRefusal() says why, and no deposit is ever built for one.

   DOM-free. `lib` is viem's ABI/hash helpers plus ox's WebAuthnP256 and
   @noble/curves' p256 (/vendor/credit-vault.js in the browser; the npm
   packages in Node and the CLI). Nothing here implements a curve.
   ============================================================ */

export const PROFILE_KIND = "enclave-credit-vault";
export const REQUEST_KIND = "enclave-credit-vault-request";
export const PREPARED_KIND = "enclave-credit-vault-prepared";
export const PROFILE_PREFIX = "enclave_credit_vault:v1:";
export const JOURNAL_PREFIX = "enclave_credit_vault_pending:v1:";
export const MAX_DEADLINE_SEC = 600;
export const DEFAULT_DEADLINE_SEC = 300;

/** Every credit-vault factory the platform book has named, oldest first (read-only, 2026-10-20: book.addr("vaultFactory")
 *  was 0 before block 48910315, 0x848a… from then, 0xa891… from block 49500388; both factories' on-chain vaultFor equals
 *  deriveVault here). The current one is byte-identical to contracts/EnclaveCreditVault.sol at d36100ae (site/recover/
 *  recover-config.json). The older implementation predates the origin binding (cb68e88e) and the 10-argument create():
 *  its vaults accept a passkey assertion from ANY origin under enclave.host, and cannot deploy on today's ledger. */
export const PRODUCTION_PINS = Object.freeze({
  chainId: 8453, origin: "https://enclave.host", rpId: "enclave.host",
  usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  factories: Object.freeze([
    Object.freeze({ address: "0x848a8a89c3452ce7dc14764114a8c5886b6f0c08", implementation: "0xaf81a59492409ab717afce6e72a425bdb2fac507",
      label: "credit-vault factory 2026-07-21 (superseded 2026-08-03)", originBound: false }),
    Object.freeze({ address: "0xa891e4396e3eb11f364554043bc18e86da834e91", implementation: "0xeca6644333d3a069001203ce5416914a4d830beb",
      label: "credit-vault factory (source d36100ae)" })]),
});

export class VaultRefusal extends Error {
  constructor(message, code = "refused"){ super(message); this.name = "VaultRefusal"; this.code = code; }
}
const no = (m, code) => { throw new VaultRefusal(m, code); };

const ADDR = /^0x[0-9a-f]{40}$/, B32 = /^0x[0-9a-f]{64}$/, UINT = /^(0|[1-9]\d{0,77})$/;
const lc = (a) => String(a || "").toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";
// EIP-1167: the factory's creation code (hashed into the CREATE2 address) and the runtime code a minted vault holds
const CLONE_HEAD = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73", CLONE_TAIL = "0x5af43d82803e903d91602b57fd5bf3";
const RUNTIME_HEAD = "0x363d3d373d3d3d363d73";
const BOOK_KEY = { deployments: "0x6465706c6f796d656e7473" + "0".repeat(42), vaultFactory: "0x7661756c74466163746f7279" + "0".repeat(40) };
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/* ---- ABIs: exactly the functions used (the production build's own ABI, test/fixtures/credit-vault-d36100ae.json) ---- */
const fn = (name, inputs, outputs = [], stateMutability = "nonpayable") => ({ type: "function", name, stateMutability,
  inputs: inputs.map((t, i) => (typeof t === "string" ? { type: t, name: "a" + i } : t)), outputs: outputs.map((t) => (typeof t === "string" ? { type: t } : t)) });
const SIG_T = { type: "tuple", name: "sig", components: [{ name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "string" },
  { name: "r", type: "uint256" }, { name: "s", type: "uint256" }, { name: "x", type: "uint256" }, { name: "y", type: "uint256" }] };
export const ABI = {
  vault: [fn("nonce", [], ["uint256"], "view"), fn("keyActive", ["bytes32"], ["bool"], "view"), fn("keyCount", [], ["uint256"], "view"),
    fn("usdc", [], ["address"], "view"), fn("book", [], ["address"], "view"), fn("treasury", [], ["address"], "view"), fn("factory", [], ["address"], "view"),
    fn("deployAndFund", ["bytes", "uint256", "uint256", SIG_T], ["bytes32"]), fn("fundDeployment", ["bytes32", "uint256", "uint256", SIG_T]),
    fn("controlDeployment", ["bytes", "uint256", SIG_T]), fn("refundToTreasury", ["uint256", "uint256", SIG_T]),
    fn("addKey", ["uint256", "uint256", "uint256", SIG_T]), fn("removeKey", ["bytes32", "uint256", SIG_T]),
    fn("isValidSignature", ["bytes32", "bytes"], ["bytes4"], "view")],
  factory: [fn("vaultFor", ["uint256", "uint256"], ["address"], "view"), fn("createVault", ["uint256", "uint256"], ["address"]),
    fn("implementation", [], ["address"], "view")],
  book: [fn("addr", ["bytes32"], ["address"], "view")],
  erc20: [fn("balanceOf", ["address"], ["uint256"], "view")],
  ledger: [fn("deploymentsSchema", [], ["uint256"], "view"), fn("capOf", ["bytes32"], ["uint256"], "view"),
    fn("refundableOf", ["bytes32"], ["uint256"], "view"),
    fn("setAppRef", ["bytes32", "string"]), fn("setActive", ["bytes32", "bool"]), fn("setShares", ["bytes32", "uint16", "uint16"]),
    fn("setConfig", ["bytes32", "string"]), fn("setMaxRate", ["bytes32", "uint256"]), fn("refund", ["bytes32"]), fn("multicall", ["bytes[]"], ["bytes[]"])],
};
const CREATE_ABI = {
  10: fn("create", ["string", "uint16", "uint16", "uint32", "string", "bool", "string", "address", "uint256", "uint256"], ["bytes32"]),
  9: fn("create", ["string", "uint16", "uint16", "uint32", "string", "bool", "string", "address", "uint256"], ["bytes32"]),
  7: fn("create", ["string", "uint16", "uint16", "uint32", "string", "bool", "string"], ["bytes32"]),
};
/* the vault function per op, and its digest tag (EXACTLY the contract's constants) */
export const OPS = {
  deploy: { fn: "deployAndFund", tag: "EnclaveVault.deployAndFund.v1" },
  fund: { fn: "fundDeployment", tag: "EnclaveVault.fundDeployment.v1" },
  control: { fn: "controlDeployment", tag: "EnclaveVault.controlDeployment.v1" },
  refund: { fn: "refundToTreasury", tag: "EnclaveVault.refundToTreasury.v1" },
  addKey: { fn: "addKey", tag: "EnclaveVault.addKey.v1" },
  removeKey: { fn: "removeKey", tag: "EnclaveVault.removeKey.v1" },
};
export const CONTROL_ACTIONS = ["suspend", "resume", "version", "resize", "options", "maxrate", "cancel"];

/* ---- pins, keys, addresses ---- */
export function validatePins(p){
  if (!p || typeof p !== "object") no("credit-vault pins must be an object", "input");
  if (!Number.isSafeInteger(p.chainId) || p.chainId <= 0) no("pins need a chain id", "input");
  let u; try { u = new URL(p.origin); } catch { no("pins need the vault's signing origin", "input"); }
  if (u.origin !== p.origin || p.rpId !== u.hostname) no("pins: origin must be a bare origin whose host is the rpId", "input");
  if (p.usdc != null && !ADDR.test(lc(p.usdc))) no("pins: usdc must be an address", "input");
  if (!Array.isArray(p.factories) || !p.factories.length || p.factories.length > 8) no("pins name 1 to 8 credit-vault factories", "input");
  for (const f of p.factories) if (!ADDR.test(lc(f.address)) || !ADDR.test(lc(f.implementation)) || typeof f.label !== "string")
    no("each pinned factory needs its address, implementation and a label", "input");
  return p;
}
const u256 = (v, what) => { const s = typeof v === "bigint" ? v : BigInt(v); if (s < 0n || s >= 1n << 256n) no(what + " out of range", "input"); return s; };
export const keyHash = (lib, x, y) => lc(lib.keccak256(lib.encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [u256(x, "x"), u256(y, "y")])));
const hex32 = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
/** A P-256 public key on the curve, as 0x-hex coordinates. */
export function checkKey(lib, x, y){
  try { lib.p256.ProjectivePoint.fromAffine({ x: BigInt(x), y: BigInt(y) }).assertValidity(); }
  catch { no("that is not a P-256 public key", "input"); }
  return { x: hex32(x), y: hex32(y) };
}
export const cloneCode = (lib, implementation) => lc(lib.concat([CLONE_HEAD, lib.getAddress(implementation), CLONE_TAIL]));
/** the code a vault minted by this factory holds: the EIP-1167 forwarder to its implementation */
export const cloneRuntime = (lib, implementation) => lc(lib.concat([RUNTIME_HEAD, lib.getAddress(implementation), CLONE_TAIL]));
/** vaultFor(x, y) of a factory, computed here: CREATE2(factory, keccak(x,y), keccak(EIP-1167 clone of its implementation)). */
export function deriveVault(lib, x, y, factory){
  const code = cloneCode(lib, factory.implementation);
  return lc("0x" + lib.keccak256(lib.concat(["0xff", lib.getAddress(factory.address), keyHash(lib, x, y), lib.keccak256(code)])).slice(-40));
}
/** Is `code` a credit vault minted by one of the pinned factories? -> the factory, or null. (For other clients - e.g. the
 *  lease-gas owner classifier - that must recognize a credit-vault owner of record.) */
export function isCreditVaultClone(lib, code, pins = PRODUCTION_PINS){
  const c = lc(code);
  return pins.factories.find((f) => cloneRuntime(lib, f.implementation) === c) || null;
}

/* ---- the agreed reader ----
   The site's quorum reader (js/core/quorum.js; the CLI and relay use the same one) plus withTxReads below:
   { snapshot() -> snap{number, hash, timestamp}, call(snap, to, data), code(snap, address), logs(snap, filter),
     tx(hash) -> {to, input, blockNumber, blockHash} | null, receipt(hash) -> {status, blockNumber, blockHash, logs} | null } */
async function read(lib, r, snap, to, abi, functionName, args = []){
  const data = lib.encodeFunctionData({ abi, functionName, args });
  return lib.decodeFunctionResult({ abi, functionName, data: await r.call(snap, to, data) });
}
async function readOr(lib, r, snap, to, abi, functionName, args, fallback){
  try { return await read(lib, r, snap, to, abi, functionName, args); } catch (e){ if (e && e.revert) return fallback; throw e; }
}

/** Every pinned factory's vault for this key, at one agreed block. Refuses a factory that does not report its pinned
 *  implementation, an address whose code is not that clone, or a vaultFor that disagrees with the local derivation. */
export async function discoverVaults(lib, key, { reader, pins = PRODUCTION_PINS }){
  validatePins(pins);
  const { x, y } = checkKey(lib, key.x, key.y);
  const kh = keyHash(lib, x, y);
  const snap = await reader.snapshot();
  const out = [];
  for (const f of pins.factories){
    const fcode = await reader.code(snap, f.address);
    if (!fcode || fcode === "0x"){ out.push({ factory: lc(f.address), label: f.label, error: "no factory code at this block" }); continue; }
    const impl = lc(await read(lib, reader, snap, f.address, ABI.factory, "implementation"));
    if (impl !== lc(f.implementation)) no(`factory ${f.address} reports implementation ${impl}, not the pinned ${f.implementation}`, "mismatch");
    const vault = deriveVault(lib, x, y, f);
    const onchain = lc(await read(lib, reader, snap, f.address, ABI.factory, "vaultFor", [BigInt(x), BigInt(y)]));
    if (onchain !== vault) no(`factory ${f.address} derives ${onchain} for this key, this page derives ${vault}`, "mismatch");
    const code = lc(await reader.code(snap, vault));
    const deployed = !!code && code !== "0x";
    if (deployed && code !== cloneRuntime(lib, impl)) no(`${vault} holds code that is not this factory's vault clone`, "mismatch");
    const row = { factory: lc(f.address), label: f.label, implementation: impl, vault, deployed, keyHash: kh, block: snap.number, blockHash: snap.hash };
    const usdc = deployed ? lc(await read(lib, reader, snap, vault, ABI.vault, "usdc")) : lc(pins.usdc || "");
    if (pins.usdc && usdc !== lc(pins.usdc)) no(`vault ${vault} holds USDC ${usdc}, not the pinned ${pins.usdc}`, "mismatch");
    row.usdc = usdc;
    row.balance6 = usdc ? (await read(lib, reader, snap, usdc, ABI.erc20, "balanceOf", [vault])).toString() : null;
    if (deployed){
      const [active, count, nonce, book, treasury] = [
        await read(lib, reader, snap, vault, ABI.vault, "keyActive", [kh]), await read(lib, reader, snap, vault, ABI.vault, "keyCount"),
        await read(lib, reader, snap, vault, ABI.vault, "nonce"), lc(await read(lib, reader, snap, vault, ABI.vault, "book")),
        lc(await read(lib, reader, snap, vault, ABI.vault, "treasury"))];
      Object.assign(row, { keyActive: active, keyCount: Number(count), nonce: nonce.toString(), book, treasury });
      const [current, ledger] = [lc(await read(lib, reader, snap, book, ABI.book, "addr", [BOOK_KEY.vaultFactory])),
        lc(await read(lib, reader, snap, book, ABI.book, "addr", [BOOK_KEY.deployments]))];
      Object.assign(row, { bookVaultFactory: current, current: current === lc(f.address), ledger });
    }
    out.push(row);
  }
  return { block: snap.number, blockHash: snap.hash, timestamp: snap.timestamp, key: { x, y }, vaults: out };
}

/** A vault named by ADDRESS (a passkey added after minting does not derive it): its code must be exactly a pinned factory's
 *  clone and `key` must be one of its active keys, at one agreed block. -> {factory, vault, keyActive, ...} */
export async function checkVaultForKey(lib, vault, key, { reader, pins = PRODUCTION_PINS }){
  validatePins(pins);
  const v = lc(vault); if (!ADDR.test(v)) no("a vault address is 0x + 40 hex", "input");
  const { x, y } = checkKey(lib, key.x, key.y);
  const snap = await reader.snapshot();
  const f = isCreditVaultClone(lib, await reader.code(snap, v), pins);
  if (!f) no(`${v} is not a vault of a pinned credit-vault factory`, "mismatch");
  const kh = keyHash(lib, x, y);
  const active = await read(lib, reader, snap, v, ABI.vault, "keyActive", [kh]);
  if (!active) no("this passkey is not an active key of that vault", "state");
  return { factory: lc(f.address), label: f.label, vault: v, keyActive: true, keyHash: kh, key: { x, y }, block: snap.number };
}

/* ---- the public key from passkey assertions (no account record needed) ---- */
async function sha256(lib, bytes){
  if (lib.sha256) return lib.sha256(bytes);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}
const utf8 = (s) => new TextEncoder().encode(s);
/** The message a WebAuthn assertion signs: sha256(authenticatorData || sha256(clientDataJSON)). */
export async function assertionMessage(lib, authenticatorData, clientDataJSON){
  const ad = lib.hexToBytes(authenticatorData);
  const ch = await sha256(lib, utf8(clientDataJSON));
  const m = new Uint8Array(ad.length + 32); m.set(ad); m.set(ch, ad.length);
  return sha256(lib, m);
}
/** The passkey's public key from TWO assertions by the same credential (each recovers at most two candidate points; the
 *  key is the one both share). assertion: {authenticatorData: 0x-hex, clientDataJSON: string, r, s}. */
export async function recoverPasskeyKey(lib, a, b){
  const cands = async (as) => {
    const msg = await assertionMessage(lib, as.authenticatorData, as.clientDataJSON);
    const out = new Map();
    for (const bit of [0, 1]){
      try {
        const P = new lib.p256.Signature(BigInt(as.r), BigInt(as.s)).addRecoveryBit(bit).recoverPublicKey(msg).toAffine();
        out.set(hex32(P.x) + hex32(P.y).slice(2), { x: hex32(P.x), y: hex32(P.y) });
      } catch { /* no point for this bit */ }
    }
    return out;
  };
  const [A, B] = [await cands(a), await cands(b)];
  const both = [...A.keys()].filter((k) => B.has(k));
  if (both.length !== 1) no("those two passkey answers do not share exactly one public key: sign twice with the SAME passkey", "recover");
  return A.get(both[0]);
}
/** Does this assertion verify under (x, y)? (A wrong credential is caught here, before anyone pays gas.) */
export async function assertionVerifies(lib, as, x, y){
  const msg = await assertionMessage(lib, as.authenticatorData, as.clientDataJSON);
  const pub = lib.concat(["0x04", hex32(x), hex32(y)]);
  try { return lib.p256.verify({ r: BigInt(as.r), s: BigInt(as.s) }, msg, lib.hexToBytes(pub), { prehash: false, lowS: false }); }
  catch { return false; }
}

/* ---- the owner's vault profile (owner-held state; no account database) ---- */
export function validateProfile(p, pins = PRODUCTION_PINS){
  if (!p || typeof p !== "object" || Array.isArray(p)) no("vault profile must be an object", "input");
  const keys = ["v", "kind", "chainId", "factory", "vault", "credentialId", "x", "y", "rpId", "origin", "label"];
  if (Object.keys(p).some((k) => !keys.includes(k)) || keys.some((k) => !(k in p))) no("vault profile has missing or unknown fields", "input");
  if (p.v !== 1 || p.kind !== PROFILE_KIND) no("unsupported vault profile", "input");
  if (p.chainId !== pins.chainId || p.origin !== pins.origin || p.rpId !== pins.rpId) no("this vault profile is for another chain or origin than these pins", "input");
  if (!pins.factories.some((f) => lc(f.address) === lc(p.factory))) no("the profile's factory is not one of the pinned credit-vault factories", "input");
  if (!ADDR.test(lc(p.vault)) || !B32.test(p.x) || !B32.test(p.y) || !/^[A-Za-z0-9_-]{16,1366}$/.test(p.credentialId) || typeof p.label !== "string" || p.label.length > 64)
    no("the vault profile needs the vault, the passkey's public key and credential id", "input");
  return p;
}
export function makeProfile(row, { credentialId, label = "" }, pins = PRODUCTION_PINS){
  return validateProfile({ v: 1, kind: PROFILE_KIND, chainId: pins.chainId, factory: lc(row.factory), vault: lc(row.vault), credentialId,
    x: row.key ? row.key.x : row.x, y: row.key ? row.key.y : row.y, rpId: pins.rpId, origin: pins.origin, label: String(label).slice(0, 64) }, pins);
}
/** Passkeys from an EAB1 account-migration file (the hosted account export; site/recover reads the same file). */
export function passkeysFromMigrationFile(bundle){
  if (!bundle || bundle.kind !== "EAB1-bundle" || !Array.isArray(bundle.credentials)) no("that is not an Enclave account migration file", "input");
  return bundle.credentials.filter((c) => c.kind === "passkey").map((c) => {
    const [, x, y, credId] = String(c.value).split(":");
    if (!/^[0-9a-fA-F]{64}$/.test(x || "") || !/^[0-9a-fA-F]{64}$/.test(y || "") || !/^[A-Za-z0-9_-]{1,1366}$/.test(credId || ""))
      no("that migration file carries a malformed passkey", "input");
    return { credentialId: credId, x: "0x" + x.toLowerCase(), y: "0x" + y.toLowerCase() };
  });
}

/* ---- preparation: the exact operation, from the owner's own numbers ---- */
const usd6 = (usd, what) => {
  const s = String(usd ?? "").trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) no(what + " must be a dollar amount with at most 2 decimals", "input");
  const [w, f = ""] = s.split(".");
  const v = BigInt(w) * 1000000n + BigInt((f + "00").slice(0, 2)) * 10000n;
  if (v <= 0n) no(what + " must be more than $0", "input");
  return v;
};
const strArg = (v, max, what, { min = 0 } = {}) => {
  const s = String(v ?? "");
  if (utf8(s).length > max || utf8(s).length < min) no(`${what} must be ${min ? min + "-" : "at most "}${max} bytes`, "input");
  return s;
};
const intArg = (v, lo, hi, what) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) no(`${what} must be an integer ${lo}..${hi}`, "input"); return n; };
const idArg = (v) => { const s = lc(v); if (!B32.test(s)) no("a deployment id is 0x + 64 hex", "input"); return s; };
const rate6Arg = (v, what = "maxRate6") => { const s = String(v ?? ""); if (!UINT.test(s) || BigInt(s) <= 0n || BigInt(s) >= 1n << 96n) no(what + " must be a positive integer (USDC 6dp per second)", "input"); return BigInt(s); };

/** create(...) calldata in the shape of the ledger revision, ALWAYS with no publisher fee. */
export function buildCreateCall(lib, rev, spec){
  const appRef = strArg(spec.appRef, 100, "appRef", { min: 1 }), gpu = intArg(spec.gpuMilli ?? 0, 0, 1000, "gpuMilli"),
    cpu = intArg(spec.cpuMilli, 1, 1000, "cpuMilli"), port = intArg(spec.appPort ?? 8080, 1, 65535, "appPort"),
    ports = strArg(spec.ports ?? "", 256, "ports"), cfg = strArg(spec.configCid ?? "", 4096, "configCid");
  if (typeof (spec.isPublic ?? false) !== "boolean") no("isPublic must be true or false", "input");
  const base = [appRef, gpu, cpu, port, ports, !!spec.isPublic, cfg];
  const shape = rev >= 8 ? 10 : rev >= 4 ? 9 : 7;
  const args = shape === 10 ? [...base, ZERO, 0n, rate6Arg(spec.maxRate6)] : shape === 9 ? [...base, ZERO, 0n] : base;
  if (shape !== 10 && spec.maxRate6 != null) no(`ledger revision ${rev} has no rate cap; leave maxRate6 out`, "input");
  return lib.encodeFunctionData({ abi: [CREATE_ABI[shape]], functionName: "create", args });
}
/** The control calldata for a vault-owned record (the vault's allowlist: setAppRef/setActive/setShares/setConfig/
 *  setMaxRate/refund, or a multicall of only those). */
export function buildControlCall(lib, p){
  const id = idArg(p.id), L = ABI.ledger, enc = (functionName, args) => lib.encodeFunctionData({ abi: L, functionName, args });
  const ref = () => strArg(p.ref, 100, "ref", { min: 1 });
  switch (p.action){
    case "suspend": case "resume": return enc("setActive", [id, p.action === "resume"]);
    case "version": return enc("setAppRef", [id, ref()]);
    case "options": {
      const env = strArg(p.envelope ?? "", 4096, "the options envelope");
      if (env){ let o; try { o = JSON.parse(env); } catch { o = null; } if (!o || typeof o !== "object" || Array.isArray(o)) no('the options envelope must be a JSON object (or "" to clear)', "input"); }
      return enc("setConfig", [id, env]);
    }
    case "maxrate": return enc("setMaxRate", [id, rate6Arg(p.maxRate6)]);
    case "cancel": return enc("refund", [id]);
    case "resize": {
      const g = intArg(p.gpuMilli, 0, 1000, "gpuMilli"), c = intArg(p.cpuMilli, 1, 1000, "cpuMilli");
      if (p.active !== undefined && typeof p.active !== "boolean") no("active must be true or false", "input");
      const calls = [...(p.ref != null ? [enc("setAppRef", [id, ref()])] : []), enc("setShares", [id, g, c]),
        ...(p.active !== undefined ? [enc("setActive", [id, p.active])] : [])];
      return calls.length === 1 ? calls[0] : enc("multicall", [calls]);
    }
    default: no("control action must be one of " + CONTROL_ACTIONS.join(", "), "input");
  }
}
/** The digest the passkey signs - the contract's abi.encode, reproduced. */
export function opDigest(lib, op, { vault, chainId, nonce, deadline, args }){
  const t = OPS[op]; if (!t) no("unknown vault op " + op, "input");
  const W = (type) => ({ type });
  const head = [W("bytes32"), W("address"), W("uint256"), W("uint256")];
  const headV = [lib.keccak256(lib.toHex(t.tag)), lib.getAddress(vault), BigInt(chainId), BigInt(nonce)];
  const tail = {
    deploy: () => [[W("bytes32"), W("uint256")], [lib.keccak256(args.createCall), BigInt(args.fund6)]],
    fund: () => [[W("bytes32"), W("uint256")], [args.id, BigInt(args.fund6)]],
    control: () => [[W("bytes32")], [lib.keccak256(args.callData)]],
    refund: () => [[W("uint256")], [BigInt(args.amount6)]],
    addKey: () => [[W("uint256"), W("uint256")], [BigInt(args.x), BigInt(args.y)]],
    removeKey: () => [[W("bytes32")], [args.keyHash]],
  }[op]();
  return lc(lib.keccak256(lib.encodeAbiParameters([...head, ...tail[0], W("uint256")], [...headV, ...tail[1], BigInt(deadline)])));
}

/** The vault's state as the CHAIN reports it for this profile, at one agreed block. */
export async function vaultState(lib, profile, { reader, pins = PRODUCTION_PINS, snap = null }){
  validateProfile(profile, pins);
  const f = pins.factories.find((x) => lc(x.address) === lc(profile.factory));
  // a vault's address derives from its MINTING key; a passkey added later signs for the same address. Either way the
  // address must hold exactly this factory's clone, and the signing key must be active (checked before signing).
  const derived = deriveVault(lib, profile.x, profile.y, f) === lc(profile.vault);
  snap ||= await reader.snapshot();
  const code = lc(await reader.code(snap, profile.vault));
  if (!code || code === "0x"){
    if (!derived) no("no vault is minted at the profile's address, and it is not this key's own vault address", "mismatch");
    return { snap, deployed: false, derived };
  }
  if (code !== cloneRuntime(lib, f.implementation)) no("the vault address holds code that is not this factory's clone", "mismatch");
  const kh = keyHash(lib, profile.x, profile.y);
  const v = profile.vault, R = (n, a = []) => read(lib, reader, snap, v, ABI.vault, n, a);
  const [nonce, keyActive, keyCount, usdc, book] = [await R("nonce"), await R("keyActive", [kh]), await R("keyCount"), lc(await R("usdc")), lc(await R("book"))];
  if (pins.usdc && usdc !== lc(pins.usdc)) no("the vault's USDC is not the pinned token", "mismatch");
  const balance6 = await read(lib, reader, snap, usdc, ABI.erc20, "balanceOf", [v]);
  const ledger = lc(await read(lib, reader, snap, book, ABI.book, "addr", [BOOK_KEY.deployments]));
  const bookVaultFactory = lc(await read(lib, reader, snap, book, ABI.book, "addr", [BOOK_KEY.vaultFactory]));
  const rev = ledger === ZERO ? 0 : Number(await readOr(lib, reader, snap, ledger, ABI.ledger, "deploymentsSchema", [], 1n));
  return { snap, deployed: true, derived, nonce, keyActive, keyCount: Number(keyCount), usdc, balance6, book, ledger, rev, bookVaultFactory, keyHash: kh,
    implementationCode: lc(await reader.code(snap, f.implementation)) };
}
/** The id and owner words of ledger.get(id): the first two fields of every Deployment revision. */
async function recordOwner(lib, reader, snap, ledger, id){
  const ret = await reader.call(snap, ledger, "0x8eaa6ac0" + id.slice(2));
  const h = String(ret).replace(/^0x/, "");
  if (h.length < 64 * 3) no("the ledger returned no record", "mismatch");
  const gotId = "0x" + h.slice(64, 128), owner = "0x" + h.slice(128 + 24, 192);
  if (gotId !== id) no("no such deployment on the ledger the book names", "input");
  return lc(owner);
}

/**
 * The exact operation, ready to sign. params:
 *   deploy  {spec: {appRef, gpuMilli, cpuMilli, appPort, ports, isPublic, configCid, maxRate6}, fundUsd}
 *   fund    {id, amountUsd, allowForeign?}
 *   control {id, action: suspend|resume|version|resize|options|maxrate|cancel, ref?, gpuMilli?, cpuMilli?, active?, envelope?, maxRate6?}
 *   refund  {amountUsd, acknowledgeTreasury: true}   (refundToTreasury: credit to the company treasury, nowhere else)
 *   addKey  {x, y}
 *   removeKey {keyHash, allowSelf?}
 *   deadlineSec? (<= 600, chain time)
 * -> a PreparedVaultOp the owner reviews; nothing is signed yet.
 */
export async function prepareVaultOp(lib, profile, op, params = {}, { reader, pins = PRODUCTION_PINS, journal = null }){
  if (!OPS[op]) no("unknown vault op " + op, "input");
  if (journal){ const p = await journal.get(profile.vault); if (p) no(`a signed request for this vault (nonce ${p.request.nonce}, deadline ${p.request.deadline}) is still undecided: reconcile it first`, "pending"); }
  const st = await vaultState(lib, profile, { reader, pins });
  if (!st.deployed){
    if (op !== "deploy" && op !== "addKey") no("this vault is not minted yet: nothing to operate (anyone may mint it with createVault(x, y); credit sent to the address is safe)", "state");
    no("this vault is not minted yet: mint it first (createVault(x, y) on its factory, any payer), then prepare again", "state");
  }
  if (!st.keyActive) no("this passkey is not an active key of the vault (removed, or never added)", "state");
  const deadlineSec = params.deadlineSec == null ? DEFAULT_DEADLINE_SEC : intArg(params.deadlineSec, 30, MAX_DEADLINE_SEC, "deadlineSec");
  const deadline = BigInt(st.snap.timestamp + deadlineSec);
  const summary = [], limits = [];
  let args;
  const needLedger = () => { if (st.ledger === ZERO) no("the platform book names no deployments ledger", "state"); };
  if (op === "deploy"){
    needLedger();
    const fund6 = usd6(params.fundUsd, "the funding amount");
    if (fund6 > st.balance6) no(`this needs $${fmt6(fund6)} of credit; the vault holds $${fmt6(st.balance6)}`, "funds");
    const createCall = buildCreateCall(lib, st.rev, params.spec || {});
    if (!st.implementationCode.includes(createCall.slice(2, 10)))
      no(`this vault's build cannot call create() on ledger revision ${st.rev} (its allowlist predates that shape - the 2026-08-03 wedge). Fund, control and refund still work; deploy from a current vault`, "state");
    args = { createCall, fund6 };
    summary.push(`Create ${params.spec.appRef} on ledger ${st.ledger} (rev ${st.rev}), owned by this vault, and fund it with $${fmt6(fund6)} of credit.`,
      "No publisher fee (fee recipient 0, fee 0)." + (st.rev >= 8 ? ` Rate cap ${params.spec.maxRate6} µUSDC/s (≈ $${(Number(params.spec.maxRate6) * 3600 / 1e6).toFixed(2)}/h).` : ""));
  } else if (op === "fund"){
    needLedger();
    const id = idArg(params.id), fund6 = usd6(params.amountUsd, "the amount");
    if (fund6 > st.balance6) no(`the vault holds $${fmt6(st.balance6)}, less than $${fmt6(fund6)}`, "funds");
    const owner = await recordOwner(lib, reader, st.snap, st.ledger, id);
    if (owner !== lc(profile.vault) && params.allowForeign !== true) no(`deployment ${id} is owned by ${owner}, not this vault: funding it pays for someone else's runtime (pass allowForeign to do that on purpose)`, "input");
    args = { id, fund6 };
    summary.push(`Add $${fmt6(fund6)} of runtime to ${id}${owner === lc(profile.vault) ? " (owned by this vault)" : " (owned by " + owner + ")"}.`);
  } else if (op === "control"){
    needLedger();
    const id = idArg(params.id);
    const owner = await recordOwner(lib, reader, st.snap, st.ledger, id);
    if (owner !== lc(profile.vault)) no(`deployment ${id} is owned by ${owner}, not this vault: the ledger would refuse`, "input");
    const callData = buildControlCall(lib, { ...params, id });
    args = { callData };
    summary.push(`${params.action} ${id}` + (params.action === "cancel" ? ": the ledger pays the unused runtime back into this vault's credit." : "."));
  } else if (op === "refund"){
    if (params.acknowledgeTreasury !== true) no("refundToTreasury sends credit to the company treasury (the card refund is the company's step, off-chain): confirm acknowledgeTreasury", "input");
    const amount6 = usd6(params.amountUsd, "the amount");
    if (amount6 > st.balance6) no(`the vault holds $${fmt6(st.balance6)}, less than $${fmt6(amount6)}`, "funds");
    args = { amount6 };
    summary.push(`Return $${fmt6(amount6)} of credit to the company treasury (the vault's immutable refund destination).`);
    limits.push("Nothing is paid to you on-chain; the card refund is processed by Enclave off-chain.");
  } else if (op === "addKey"){
    const k = checkKey(lib, params.x, params.y);
    if (await read(lib, reader, st.snap, profile.vault, ABI.vault, "keyActive", [keyHash(lib, k.x, k.y)])) no("that passkey is already a key of this vault", "input");
    args = { x: k.x, y: k.y };
    summary.push(`Add passkey ${keyHash(lib, k.x, k.y).slice(0, 18)}… as a key with the same full powers.`);
    limits.push(`The new passkey must also sign at ${profile.origin}: the vault accepts no other origin.`);
  } else {
    const kh = lc(params.keyHash);
    if (!B32.test(kh)) no("removeKey needs the key hash (keccak256(abi.encode(x, y)))", "input");
    if (!(await read(lib, reader, st.snap, profile.vault, ABI.vault, "keyActive", [kh]))) no("that key is not active on this vault", "input");
    if (st.keyCount <= 1) no("the vault's last key cannot be removed", "input");
    if (kh === st.keyHash && params.allowSelf !== true) no("that is the passkey signing this request; switch to another key's profile first, or pass allowSelf", "input");
    args = { keyHash: kh };
    summary.push(`Remove key ${kh.slice(0, 18)}…; ${st.keyCount - 1} key(s) remain.`);
    if (kh === st.keyHash) limits.push("The vault ADDRESS stays derived from its minting key: keep this profile to find it.");
  }
  const base = { vault: lc(profile.vault), chainId: pins.chainId, nonce: st.nonce, deadline, args };
  const digest = opDigest(lib, op, base);
  limits.push("Gas: the payer you choose needs ETH. Vault credit is closed-loop and pays only Enclave runtime, never transaction fees.");
  const pf = pins.factories.find((x) => lc(x.address) === lc(profile.factory));
  if (pf && pf.originBound === false) limits.push("This older vault does not check the signing site on chain: only sign here, and consider moving its credit out (refund to the treasury, then top up your current vault).");
  return { v: 1, kind: PREPARED_KIND, op, chainId: pins.chainId, vault: lc(profile.vault), factory: lc(profile.factory), nonce: st.nonce.toString(),
    deadline: deadline.toString(), args: stringify(args), digest, block: st.snap.number, blockHash: st.snap.hash, blockTimestamp: st.snap.timestamp,
    ledger: st.ledger, ledgerRev: st.rev, book: st.book, balance6: st.balance6.toString(), summary, limits };
}
const fmt6 = (v) => (Number(v) / 1e6).toFixed(2);
const stringify = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

/** Is `prepared` EXACTLY the operation the owner asked for? Every argument is rebuilt from the owner's own params and
 *  compared byte for byte (a prepared op that arrived from anywhere else - a file, another tab, a tool - cannot carry a
 *  different amount, record, fee recipient or rate cap past this), then the digest is recomputed from those fields. */
export function verifyIntent(lib, prepared, op, params = {}){
  const bad = (what) => no(`the prepared operation is not what you asked for (${what}). Nothing was signed.`, "intent");
  if (!prepared || prepared.kind !== PREPARED_KIND) bad("not a prepared credit-vault operation");
  if (prepared.op !== op) bad("a different operation");
  const a = prepared.args || {};
  if (op === "deploy"){
    if (lc(a.createCall) !== lc(buildCreateCall(lib, prepared.ledgerRev, params.spec || {}))) bad("a different create() - app, shares, port, visibility, config, fee or rate cap");
    if (String(a.fund6) !== usd6(params.fundUsd, "the funding amount").toString()) bad("a different amount");
  } else if (op === "fund"){
    if (lc(a.id) !== idArg(params.id)) bad("a different deployment");
    if (String(a.fund6) !== usd6(params.amountUsd, "the amount").toString()) bad("a different amount");
  } else if (op === "control"){
    if (lc(a.callData) !== lc(buildControlCall(lib, params))) bad("a different change to the deployment");
  } else if (op === "refund"){
    if (String(a.amount6) !== usd6(params.amountUsd, "the amount").toString()) bad("a different amount");
  } else if (op === "addKey"){
    const k = checkKey(lib, params.x, params.y);
    if (a.x !== k.x || a.y !== k.y) bad("a different passkey");
  } else if (op === "removeKey"){
    if (lc(a.keyHash) !== lc(params.keyHash)) bad("a different key");
  }
  if (Number(prepared.deadline) - Number(prepared.blockTimestamp) > MAX_DEADLINE_SEC) bad("a deadline beyond " + MAX_DEADLINE_SEC + " s");
  if (opDigest(lib, op, { vault: prepared.vault, chainId: prepared.chainId, nonce: prepared.nonce, deadline: prepared.deadline, args: a }) !== lc(prepared.digest))
    bad("a digest that is not the digest of its fields");
}

/** Transaction reads for reconcile() over a site quorum reader ({rpcs, quorum}): `quorum` identical answers required. */
export function withTxReads(reader, rpc){
  const agreed = async (method, hash, pick) => {
    if (!/^0x[0-9a-f]{64}$/i.test(String(hash))) no("bad transaction hash", "input");
    const answers = await Promise.allSettled(reader.rpcs.map((u) => rpc(u, method, [hash])));
    const tally = new Map();
    for (const x of answers) if (x.status === "fulfilled"){ const v = x.value ? pick(x.value) : null; const k = JSON.stringify(v); const t = tally.get(k) || { n: 0, v }; t.n++; tally.set(k, t); }
    const best = [...tally.values()].sort((p, q) => q.n - p.n)[0];
    if (!best || best.n < reader.quorum) throw new Error(`chain endpoints disagree on ${method} (${best ? best.n : 0} agree, need ${reader.quorum})`);
    return best.v;
  };
  const num = (h) => h == null ? null : Number(BigInt(h));
  return { ...reader,
    tx: (h) => agreed("eth_getTransactionByHash", h, (t) => t.blockHash ? { to: lc(t.to), input: lc(t.input), blockNumber: num(t.blockNumber), blockHash: lc(t.blockHash) } : null),
    receipt: (h) => agreed("eth_getTransactionReceipt", h, (r) => ({ status: r.status === "0x1" ? "success" : "reverted", blockNumber: num(r.blockNumber), blockHash: lc(r.blockHash) })) };
}

/* ---- signing ---- */
const b64url = (lib, hex) => { let s = ""; for (const b of lib.hexToBytes(hex)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
/** The contract's own acceptance rule for an assertion, checked here: UP flag; clientDataJSON starts with exactly
 *  {"type":"webauthn.get","challenge":"<b64url digest>","origin":"<origin>" followed by the closing quote. */
export function assertionShape(lib, assertion, digest, origin){
  const ad = lib.hexToBytes(assertion.authenticatorData);
  if (ad.length < 37 || (ad[32] & 0x01) === 0) no("the passkey did not report user presence", "assertion");
  const head = '{"type":"webauthn.get","challenge":"' + b64url(lib, digest) + '","origin":"' + origin + '"';
  if (!String(assertion.clientDataJSON).startsWith(head)) no(`the passkey's answer is not an assertion over this exact operation at ${origin}`, "assertion");
}
/** The vault call carrying the passkey's signature: the bytes any submitter sends. */
export function assembleRequest(lib, prepared, profile, assertion){
  if (prepared.kind !== PREPARED_KIND || prepared.vault !== lc(profile.vault)) no("that prepared operation is for another vault", "input");
  if (opDigest(lib, prepared.op, { vault: prepared.vault, chainId: prepared.chainId, nonce: prepared.nonce, deadline: prepared.deadline, args: prepared.args }) !== lc(prepared.digest))
    no("the prepared operation's digest does not match its fields", "mismatch");
  assertionShape(lib, assertion, prepared.digest, profile.origin);
  const sig = { authenticatorData: assertion.authenticatorData, clientDataJSON: assertion.clientDataJSON, r: BigInt(assertion.r), s: BigInt(assertion.s),
    x: BigInt(profile.x), y: BigInt(profile.y) };
  const a = prepared.args, dl = BigInt(prepared.deadline);
  const fnArgs = { deploy: () => [a.createCall, BigInt(a.fund6), dl, sig], fund: () => [a.id, BigInt(a.fund6), dl, sig], control: () => [a.callData, dl, sig],
    refund: () => [BigInt(a.amount6), dl, sig], addKey: () => [BigInt(a.x), BigInt(a.y), dl, sig], removeKey: () => [a.keyHash, dl, sig] }[prepared.op]();
  const data = lib.encodeFunctionData({ abi: ABI.vault, functionName: OPS[prepared.op].fn, args: fnArgs });
  return { v: 1, kind: REQUEST_KIND, chainId: prepared.chainId, vault: prepared.vault, factory: prepared.factory, op: prepared.op, nonce: prepared.nonce,
    deadline: prepared.deadline, digest: lc(prepared.digest), to: prepared.vault, data: lc(data), fromBlock: prepared.block, preparedAt: prepared.blockTimestamp,
    summary: prepared.summary };
}
/**
 * Sign a prepared operation with the profile's passkey. Refused unless this page runs at exactly the vault's origin (the
 * vault rejects any other), and the assertion must verify under the profile's key before a request is returned.
 * opts: {origin (default: location.origin), getFn (tests: a WebAuthn get)}.
 */
export async function signPrepared(lib, prepared, profile, { pins = PRODUCTION_PINS, origin = globalThis.location && globalThis.location.origin, getFn, intent } = {}){
  validateProfile(profile, pins);
  if (origin !== profile.origin) no(`signing works only at ${profile.origin}: a passkey signature made anywhere else is refused by the vault. Nothing was signed.`, "origin");
  if (!intent) no("signing needs the owner's own request (op and params) to check the prepared operation against", "input");
  verifyIntent(lib, prepared, intent.op, intent.params);
  let a;
  try {
    a = await lib.WebAuthnP256.sign({ challenge: prepared.digest, credentialId: profile.credentialId, rpId: profile.rpId, userVerification: "required", ...(getFn ? { getFn } : {}) });
  } catch (e){
    const c = e && (e.cause || e);
    no(c && c.name === "NotAllowedError" ? "The passkey prompt was cancelled or timed out. Nothing was signed." : "Passkey signing failed: " + String(c && c.message || e).slice(0, 160), "cancelled");
  }
  const assertion = { authenticatorData: a.metadata.authenticatorData, clientDataJSON: a.metadata.clientDataJSON, r: a.signature.r, s: a.signature.s };
  if (!(await assertionVerifies(lib, assertion, profile.x, profile.y))) no("that passkey is not this vault's key (its signature does not verify under the profile's public key)", "assertion");
  return assembleRequest(lib, prepared, profile, assertion);
}

/** Re-derive everything a request claims from its own bytes (for a CLI, a relay, or a later reload): the selector is a
 *  vault op, the digest is the digest of the encoded arguments at (vault, chainId, nonce, deadline), and the signature's
 *  clientDataJSON asserts exactly that digest at the pinned origin. -> {op, args, sig}. Signature validity itself is the
 *  vault's to judge (simulate before paying). */
export function verifyRequest(lib, req, pins = PRODUCTION_PINS){
  if (!req || req.kind !== REQUEST_KIND || req.v !== 1) no("that is not a signed credit-vault request", "input");
  if (req.chainId !== pins.chainId) no(`the request is for chain ${req.chainId}, these pins are chain ${pins.chainId}`, "input");
  if (!ADDR.test(req.to) || req.to !== req.vault || !/^0x([0-9a-f]{2})+$/.test(req.data)) no("malformed request", "input");
  let d; try { d = lib.decodeFunctionData({ abi: ABI.vault, data: req.data }); } catch { no("the request's data is not a vault call", "input"); }
  const op = Object.keys(OPS).find((k) => OPS[k].fn === d.functionName);
  if (!op || op !== req.op) no("the request's data is not the vault op it names", "input");
  const a = d.args, sig = a[a.length - 1], dl = a[a.length - 2];
  const args = { deploy: () => ({ createCall: a[0], fund6: a[1] }), fund: () => ({ id: a[0], fund6: a[1] }), control: () => ({ callData: a[0] }),
    refund: () => ({ amount6: a[0] }), addKey: () => ({ x: a[0], y: a[1] }), removeKey: () => ({ keyHash: a[0] }) }[op]();
  if (String(dl) !== String(req.deadline)) no("the request's deadline does not match its data", "input");
  const digest = opDigest(lib, op, { vault: req.vault, chainId: req.chainId, nonce: req.nonce, deadline: dl, args });
  if (digest !== lc(req.digest)) no("the request's digest is not the digest of its data at its nonce", "mismatch");
  assertionShape(lib, { authenticatorData: sig.authenticatorData, clientDataJSON: sig.clientDataJSON }, digest, pins.origin);
  if (op === "deploy" && !Object.values(CREATE_ABI).some((f) => lc(a[0]).startsWith(lc(lib.toFunctionSelector ? lib.toFunctionSelector(f) : selectorOf(lib, f)))))
    no("the deploy request does not carry a create() call", "input");
  return { op, args: stringify(args), sig };
}
const selectorOf = (lib, f) => lib.keccak256(lib.toHex(`${f.name}(${f.inputs.map((i) => i.type).join(",")})`)).slice(0, 10);

/* ---- the journal: one undecided request per vault, held until the chain decides it ---- */
/** localStorage journal (site). The CLI passes a file journal with the same {get, put, clear}. */
export function storageJournal(ls = globalThis.localStorage, chainId = PRODUCTION_PINS.chainId){
  const k = (vault) => JOURNAL_PREFIX + chainId + ":" + lc(vault);
  return {
    async get(vault){ try { return JSON.parse(ls.getItem(k(vault)) || "null"); } catch { return null; } },
    async put(entry){ ls.setItem(k(entry.request.vault), JSON.stringify(entry)); },
    async clear(vault){ ls.removeItem(k(vault)); },
  };
}

/**
 * Submit a signed request through `transport` (walletTransport / relayTransport / a CLI raw transport):
 * transport.send(req) -> {txHash} | throws {definite: true} (nothing left this device: e.g. the wallet's own rejection).
 * The request is journaled BEFORE it leaves; any other failure leaves it held (outcome unknown) for reconcile().
 */
export async function submitRequest(lib, req, transport, { journal, reader = null, pins = PRODUCTION_PINS } = {}){
  verifyRequest(lib, req, pins);
  if (!journal) no("submission needs a journal (an undecided request must survive a reload)", "input");
  const held = await journal.get(req.vault);
  if (held && held.request.digest !== req.digest) no(`another request for this vault (nonce ${held.request.nonce}) is undecided: reconcile it first`, "pending");
  const entry = held || { request: req, txHashes: [], via: transport.name || "transport", status: "sending", at: Date.now() };
  await journal.put(entry);
  try {
    if (reader && transport.payer){            // a doomed transaction is refused before the payer spends gas
      const snap = await reader.snapshot();
      try { await reader.call(snap, req.to, req.data, { from: transport.payer }); }
      catch (e){ if (e && e.revert){ await journal.clear(req.vault); no("the vault would refuse this request at the agreed block (expired, replayed, wrong key, or a ledger refusal). Nothing was sent.", "simulation"); } throw e; }
    }
    const r = await transport.send(req);
    if (r && r.txHash && !entry.txHashes.includes(lc(r.txHash))) entry.txHashes.push(lc(r.txHash));
    entry.status = "broadcast"; await journal.put(entry);
    return { status: "broadcast", txHash: r && r.txHash ? lc(r.txHash) : null, entry };
  } catch (e){
    if (e instanceof VaultRefusal) throw e;
    if (e && e.definite){ await journal.clear(req.vault); return { status: "not-sent", reason: String(e.message || e) }; }
    if (e && /^0x[0-9a-f]{64}$/i.test(String(e.txHash || "")) && !entry.txHashes.includes(lc(e.txHash))) entry.txHashes.push(lc(e.txHash));
    entry.status = "unknown"; entry.lastError = String(e && e.message || e).slice(0, 200); await journal.put(entry);
    return { status: "unknown", reason: entry.lastError, entry };
  }
}

/**
 * What became of a journaled request, from an agreed read of the vault's nonce and chain time:
 *   executed   - a transaction carrying exactly these bytes succeeded (by a known hash, or found in the vault's/ledger's
 *                logs within the request's lifetime);
 *   superseded - the nonce moved to another operation: these bytes can never execute;
 *   expired    - the nonce is unchanged and the agreed block is past the deadline: can never execute;
 *   pending    - still executable: hold (rebroadcasting the SAME bytes is the only safe repeat).
 * A decided request is cleared from the journal; `pending` stays.
 */
export async function reconcile(lib, entry, { reader, journal = null }){
  const req = entry.request;
  const snap = await reader.snapshot();
  const nonce = await read(lib, reader, snap, req.vault, ABI.vault, "nonce");
  const decided = async (status, extra = {}) => { if (journal) await journal.clear(req.vault); return { status, block: snap.number, nonce: nonce.toString(), ...extra }; };
  if (nonce > BigInt(req.nonce)){
    const hit = await findExecution(lib, reader, snap, req, entry.txHashes || []);
    return hit ? decided("executed", hit) : decided("superseded");
  }
  if (snap.timestamp > Number(req.deadline)) return decided("expired");
  return { status: "pending", block: snap.number, nonce: nonce.toString(), deadline: req.deadline, txHashes: entry.txHashes || [] };
}
async function findExecution(lib, reader, snap, req, hashes){
  const ok = async (h) => {
    const tx = await reader.tx(h);
    if (!tx || lc(tx.to) !== lc(req.vault) || lc(tx.input) !== lc(req.data)) return null;
    const rc = await reader.receipt(h);
    return rc && rc.status === "success" && rc.blockNumber <= snap.number ? { txHash: lc(h), blockNumber: rc.blockNumber } : null;
  };
  for (const h of hashes){ const r = await ok(h); if (r) return r; }
  // the reply was lost: look for these exact bytes among the transactions that touched the vault (it emits for every op
  // but control) or the ledger record (control) during the request's lifetime (it cannot execute after its deadline)
  const from = Number(req.fromBlock || 0), to = Math.min(snap.number, from + (Number(req.deadline) - Number(req.preparedAt || 0)) + 60);
  const seen = new Set(hashes.map(lc));
  const scan = async (filter) => {
    for (const l of await reader.logs(snap, { ...filter, fromBlock: from, toBlock: Math.max(from, to) })){
      const h = lc(l.transactionHash); if (!h || seen.has(h)) continue; seen.add(h);
      const r = await ok(h); if (r) return r;
    }
    return null;
  };
  const vaultHit = await scan({ address: req.vault });
  if (vaultHit) return vaultHit;
  if (req.op === "control"){
    const d = lib.decodeFunctionData({ abi: ABI.vault, data: req.data });
    let inner = String(d.args[0]);
    if (inner.slice(2, 10) === "ac9650d8") inner = lib.decodeFunctionData({ abi: ABI.ledger, data: inner }).args[0][0];   // multicall: its first call
    const id = "0x" + inner.slice(10, 74);                   // every allowed control call's first argument is the record id
    const ledgerAddr = await readOr(lib, reader, snap, (await read(lib, reader, snap, req.vault, ABI.vault, "book")), ABI.book, "addr", [BOOK_KEY.deployments], ZERO);
    if (lc(ledgerAddr) !== ZERO) return scan({ address: lc(ledgerAddr), topics: [null, id] });
  }
  return null;
}

/* ---- transports (replaceable; the payer is always explicit) ---- */
/** The owner's own wallet (EIP-1193) pays gas and sends the exact bytes. Its user rejection (4001) is definite. */
export function walletTransport(provider, payer){
  if (!provider || typeof provider.request !== "function") no("connect a wallet to pay the gas", "input");
  if (!ADDR.test(lc(payer))) no("choose the paying account", "input");
  return { name: "wallet", payer: lc(payer), async send(req){
    try { return { txHash: await provider.request({ method: "eth_sendTransaction", params: [{ from: payer, to: req.to, data: req.data, value: "0x0" }] }) }; }
    catch (e){ if (e && (e.code === 4001 || e.code === "ACTION_REJECTED")) throw Object.assign(new Error("the wallet declined; nothing was sent"), { definite: true }); throw e; }
  } };
}
/** An untrusted relay that submits the exact bytes and pays its own gas. Nothing it answers is believed: the outcome is
 *  read from the chain (reconcile), and a refusal it reports does not release the hold. */
export function relayTransport(url, { fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 20000 } = {}){
  let u; try { u = new URL(url); } catch { no("the relay URL is not a URL", "input"); }
  if (u.protocol !== "https:" && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) no("a relay must be https", "input");
  return { name: "relay " + u.host, payer: null, async send(req){
    const r = await fetchImpl(new URL("/v1/credit-vault/submit", u).href, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit",
      redirect: "error", cache: "no-store", body: JSON.stringify(req), signal: AbortSignal.timeout(timeoutMs) });
    let j = null; try { j = await r.json(); } catch { /* no answer */ }
    if (r.ok && j && /^0x[0-9a-f]{64}$/i.test(String(j.txHash || ""))) return { txHash: j.txHash };
    throw new Error("the relay answered " + r.status + (j && j.error ? ": " + String(j.error).slice(0, 160) : "") + " (held until the chain decides)");
  } };
}

/* ---- app lease gas: what the current reserve can do for a vault-owned deployment ---- */
/** EnclaveLeaseGasReserve (main 1d173473): configure/setClaimant need msg.sender == owner of record and withdraw is keyed
 *  to msg.sender; a credit vault can originate none of them. Never build a deposit for such a record. */
export function reserveRefusal(ownerIsCreditVault){
  if (!ownerIsCreditVault) return null;
  return "App lease gas is unavailable for a deployment owned by a credit vault: the gas reserve's configure, setClaimant " +
    "and withdraw must be sent by the owner of record, and the vault can only call the ledger's control functions. ETH " +
    "deposited for it could never be enabled or withdrawn, so no deposit is offered. (An optional signature-bound reserve " +
    "is proposed separately; it is not deployed.)";
}
