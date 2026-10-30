/* ============================================================
   App lease gas for a deployment an existing credit vault owns.

   The live EnclaveLeaseGasReserve (0x12A3f873…, source 1d173473) can
   never be enabled for such a deployment: configure/setClaimant/withdraw
   must come from the owner of record, and a credit vault can only call
   the ledger's control functions. A PARALLEL reserve is PROPOSED
   (EnclaveLeaseGasReserveSig: the same source plus configureBySig /
   setClaimantBySig / withdrawBySig, verified through the owner's own
   ERC-1271 isValidSignature; work/credit-vault-final-integration). It
   is not approved or deployed. Everything here is inert until the owner
   (or the page's config) supplies that reserve's REVIEWED deployment
   record; without one, reserveRefusal() in credit-vault-independent.js
   stays the answer and no deposit is ever built.

   With a record:
   - the reserve is checked at one agreed block: its runtime code hash
     is the record's, it is bound to the record's ledger and executor,
     and that ledger is the one the platform book names for the vault;
   - configure / claimant / withdraw are prepared from the owner's own
     numbers (every policy field explicit, no defaults; a withdrawal
     needs an explicit recipient: never zero, the reserve or the vault),
     the digest is recomputed here AND read from the reserve's own view,
     and the vault's passkey signs it at the vault's pinned origin;
   - the older credit-vault build (no on-chain origin check) is refused
     here and by the reserve's constructor-pinned code hash;
   - the signed request is submitted like a vault request (wallet, CLI
     key, untrusted relay) and held until the reserve's sigNonce or the
     deadline decides it;
   - a deposit is a plain payer transaction (anyone may pay; it is
     credited to the vault's reserve there, which the vault CAN enable).
   ============================================================ */
import { VaultRefusal, PRODUCTION_PINS, MAX_DEADLINE_SEC, DEFAULT_DEADLINE_SEC, validateProfile, isCreditVaultClone, assertionShape,
  assertionVerifies, keyHash } from "./credit-vault-independent.js";

export const RESERVE_PREPARED_KIND = "enclave-credit-vault-reserve-prepared";
export const RESERVE_REQUEST_KIND = "enclave-credit-vault-reserve-request";
export const RESERVE_RECORD_FORMAT = "enclave-lease-gas-deployment/v1";      // the lease-gas deployment record format, reused
export const RESERVE_JOURNAL_PREFIX = "enclave_credit_vault_reserve_pending:v1:";
export const TAGS = Object.freeze({ configure: "EnclaveLeaseGasReserve.configureBySig.v1", claimant: "EnclaveLeaseGasReserve.setClaimantBySig.v1",
  withdraw: "EnclaveLeaseGasReserve.withdrawBySig.v1" });
const no = (m, code = "refused") => { throw new VaultRefusal(m, code); };
const lc = (a) => String(a || "").toLowerCase();
const ADDR = /^0x[0-9a-f]{40}$/, B32 = /^0x[0-9a-f]{64}$/, UINT = /^(0|[1-9]\d{0,77})$/;
const ZERO = "0x0000000000000000000000000000000000000000";

const fn = (name, inputs, outputs = [], stateMutability = "nonpayable") => ({ type: "function", name, stateMutability,
  inputs: inputs.map((t, i) => (typeof t === "string" ? { type: t, name: "a" + i } : t)), outputs: outputs.map((t) => (typeof t === "string" ? { type: t } : t)) });
const POLICY_T = { type: "tuple", name: "p", components: [["enabled", "bool"], ["claimPolicy", "uint8"], ["sponsorRelease", "bool"], ["maxClaimsPerEpoch", "uint8"],
  ["maxPerOpWei", "uint64"], ["epochCapWei", "uint64"], ["epochSec", "uint32"], ["renewWindow", "uint32"], ["minExtension", "uint32"], ["claimCooldown", "uint32"],
  ["maxGasPrice", "uint64"]].map(([name, type]) => ({ name, type })) };
const RESERVE_T = { type: "tuple", components: [["balanceWei", "uint128"], ["maxPerOpWei", "uint64"], ["epochCapWei", "uint64"], ["enabled", "bool"], ["claimPolicy", "uint8"],
  ["sponsorRelease", "bool"], ["renewWindow", "uint32"], ["minExtension", "uint32"], ["claimCooldown", "uint32"], ["epochSec", "uint32"], ["maxGasPrice", "uint64"],
  ["maxClaimsPerEpoch", "uint8"], ["epochIndex", "uint32"], ["epochSpentWei", "uint96"], ["epochClaims", "uint8"], ["lastClaimAt", "uint64"], ["lastClaimOperator", "address"]]
  .map(([name, type]) => ({ name, type })) };
const SIG_T = { type: "tuple", components: [{ name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "string" },
  { name: "r", type: "uint256" }, { name: "s", type: "uint256" }, { name: "x", type: "uint256" }, { name: "y", type: "uint256" }] };
export const RESERVE_ABI = [fn("ledger", [], ["address"], "view"), fn("executor", [], ["address"], "view"), fn("paused", [], ["bool"], "view"),
  fn("budgetKey", ["bytes32", "address"], ["bytes32"], "view"), fn("sigNonce", ["bytes32"], ["uint256"], "view"), fn("signerCodeRefused", ["bytes32"], ["bool"], "view"),
  fn("reserveOf", ["bytes32", "address"], [RESERVE_T], "view"), fn("claimantAllowed", ["bytes32", "address"], ["bool"], "view"),
  fn("configureDigest", ["bytes32", "address", POLICY_T, "uint256", "uint256"], ["bytes32"], "view"),
  fn("claimantDigest", ["bytes32", "address", "address", "bool", "uint256", "uint256"], ["bytes32"], "view"),
  fn("withdrawDigest", ["bytes32", "address", "uint256", "address", "uint256", "uint256"], ["bytes32"], "view"),
  fn("configureBySig", ["bytes32", POLICY_T, "uint256", "bytes"]), fn("setClaimantBySig", ["bytes32", "address", "bool", "uint256", "bytes"]),
  fn("withdrawBySig", ["bytes32", "address", "uint256", "address", "uint256", "bytes"]), fn("deposit", ["bytes32"], [], "payable"),
  { type: "event", name: "SignedAction", inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "owner", type: "address", indexed: true },
    { name: "tag", type: "bytes32", indexed: false }, { name: "nonce", type: "uint256", indexed: false }] }];
const EXECUTOR_ABI = [fn("reserve", [], ["address"], "view")];
const BOOK_ABI = [fn("addr", ["bytes32"], ["address"], "view")];
const VAULT_ABI = [fn("book", [], ["address"], "view")];
const BOOK_DEPLOYMENTS = "0x6465706c6f796d656e7473" + "0".repeat(42);
const ACTION_FN = { configure: "configureBySig", claimant: "setClaimantBySig", withdraw: "withdrawBySig" };

/** The reviewed record of the parallel reserve (the lease-gas deployment record shape; its sha256 is the owner's pin). */
export function validateReserveRecord(r, pins = PRODUCTION_PINS){
  if (!r || typeof r !== "object" || r.format !== RESERVE_RECORD_FORMAT) no("not a lease-gas reserve deployment record", "input");
  if (r.chainId !== pins.chainId) no(`the reserve record is for chain ${r.chainId}, these pins are chain ${pins.chainId}`, "input");
  for (const k of ["reserve", "executor", "ledger", "registry"]) if (!ADDR.test(lc(r[k]))) no(`reserve record: ${k}`, "input");
  for (const k of ["reserveCodeHash", "executorCodeHash"]) if (!B32.test(lc(r[k]))) no(`reserve record: ${k}`, "input");
  return Object.freeze({ format: RESERVE_RECORD_FORMAT, chainId: r.chainId, reserve: lc(r.reserve), executor: lc(r.executor), ledger: lc(r.ledger), registry: lc(r.registry),
    reserveCodeHash: lc(r.reserveCodeHash), executorCodeHash: lc(r.executorCodeHash) });
}
async function read(lib, r, snap, to, abi, functionName, args = []){
  const data = lib.encodeFunctionData({ abi, functionName, args });
  return lib.decodeFunctionResult({ abi, functionName, data: await r.call(snap, to, data) });
}

/** The parallel reserve as the chain reports it for this vault and record id, at one agreed block (refuses any mismatch). */
export async function reserveState(lib, profile, record, id, { reader, pins = PRODUCTION_PINS, snap = null }){
  validateProfile(profile, pins);
  const rec = validateReserveRecord(record, pins);
  if (!B32.test(lc(id))) no("a deployment id is 0x + 64 hex", "input");
  snap ||= await reader.snapshot();
  const [rc, ec, vc] = [await reader.code(snap, rec.reserve), await reader.code(snap, rec.executor), lc(await reader.code(snap, profile.vault))];
  if (!rc || rc === "0x" || lc(lib.keccak256(rc)) !== rec.reserveCodeHash) no(`reserve ${rec.reserve} is not the reviewed code`, "mismatch");
  if (!ec || ec === "0x" || lc(lib.keccak256(ec)) !== rec.executorCodeHash) no(`executor ${rec.executor} is not the reviewed code`, "mismatch");
  const R = (f, a = []) => read(lib, reader, snap, rec.reserve, RESERVE_ABI, f, a);
  if (lc(await R("ledger")) !== rec.ledger || lc(await R("executor")) !== rec.executor || lc(await read(lib, reader, snap, rec.executor, EXECUTOR_ABI, "reserve")) !== rec.reserve)
    no("the reserve, its executor and its ledger are not bound as the record says", "mismatch");
  // the vault pays and controls the ledger the platform book names: the reserve must be bound to that same ledger
  const book = lc(await read(lib, reader, snap, profile.vault, VAULT_ABI, "book"));
  const bookLedger = lc(await read(lib, reader, snap, book, BOOK_ABI, "addr", [BOOK_DEPLOYMENTS]));
  if (bookLedger !== rec.ledger) no(`this reserve is bound to ledger ${rec.ledger}; the platform book names ${bookLedger} for the vault`, "mismatch");
  const factory = isCreditVaultClone(lib, vc, pins);
  if (!factory) no("the profile's vault address does not hold a pinned factory's vault clone", "mismatch");
  const refused = await R("signerCodeRefused", [lc(lib.keccak256(vc))]);
  const ret = String(await reader.call(snap, rec.ledger, "0x8eaa6ac0" + lc(id).slice(2))).replace(/^0x/, "");
  if (ret.length < 192 || "0x" + ret.slice(64, 128) !== lc(id)) no("no such deployment on the reserve's ledger", "input");
  const owner = lc("0x" + ret.slice(128 + 24, 192));
  const key = await R("budgetKey", [lc(id), profile.vault]);
  const [nonce, reserve, paused] = [await R("sigNonce", [key]), await R("reserveOf", [lc(id), profile.vault]), await R("paused")];
  return { snap, record: rec, id: lc(id), owner, ownedByVault: owner === lc(profile.vault), factory, originBound: factory.originBound !== false, signerRefused: refused,
    budgetKey: lc(key), sigNonce: nonce, reserve, paused };
}

const P_KEYS = ["enabled", "claimPolicy", "sponsorRelease", "maxClaimsPerEpoch", "maxPerOpWei", "epochCapWei", "epochSec", "renewWindow", "minExtension", "claimCooldown", "maxGasPrice"];
const CLAIM_POLICY = { any: 0, "self-hosted": 1, allowlist: 2 };
/** Every policy field, explicit and within the reserve's own bounds (no field defaults). */
export function policyArg(p){
  if (!p || typeof p !== "object" || Object.keys(p).some((k) => !P_KEYS.includes(k)) || P_KEYS.some((k) => p[k] === undefined || p[k] === ""))
    no("the policy needs every field, explicitly: " + P_KEYS.join(", "), "input");
  const big = (k, max) => { const s = String(p[k]); if (!UINT.test(s) || BigInt(s) > max) no(`policy.${k} out of range`, "input"); return BigInt(s); };
  const int = (k, lo, hi) => { const n = Number(p[k]); if (!Number.isInteger(n) || n < lo || n > hi) no(`policy.${k} must be ${lo}..${hi}`, "input"); return n; };
  if (typeof p.enabled !== "boolean" || typeof p.sponsorRelease !== "boolean") no("policy.enabled and policy.sponsorRelease are true or false", "input");
  const cp = typeof p.claimPolicy === "string" ? CLAIM_POLICY[p.claimPolicy] : p.claimPolicy;
  if (![0, 1, 2].includes(cp)) no("policy.claimPolicy is any | self-hosted | allowlist", "input");
  const out = { enabled: p.enabled, claimPolicy: cp, sponsorRelease: p.sponsorRelease, maxClaimsPerEpoch: int("maxClaimsPerEpoch", 0, 255),
    maxPerOpWei: big("maxPerOpWei", 2n ** 64n - 1n), epochCapWei: big("epochCapWei", 2n ** 64n - 1n), epochSec: int("epochSec", 600, 30 * 86400),
    renewWindow: int("renewWindow", 30, 86400), minExtension: int("minExtension", 1, 2 ** 32 - 1), claimCooldown: int("claimCooldown", 0, 2 ** 32 - 1),
    maxGasPrice: big("maxGasPrice", 2n ** 64n - 1n) };
  if (out.maxPerOpWei > out.epochCapWei) no("policy.maxPerOpWei cannot exceed policy.epochCapWei", "input");
  return out;
}
/** The digest the reserve's _consume checks - its abi.encode, reproduced. */
export function reserveDigest(lib, action, { reserve, chainId, id, owner, nonce, deadline, args }){
  const W = (type) => ({ type });
  const head = [W("bytes32"), W("address"), W("uint256"), W("bytes32"), W("address")];
  const headV = [lib.keccak256(lib.toHex(TAGS[action])), lib.getAddress(reserve), BigInt(chainId), id, lib.getAddress(owner)];
  const tail = {
    configure: () => [[W("bytes32")], [lib.keccak256(lib.encodeAbiParameters([POLICY_T], [policyArg(args.policy)]))]],
    claimant: () => [[W("address"), W("bool")], [lib.getAddress(args.operator), !!args.allowed]],
    withdraw: () => [[W("uint256"), W("address")], [BigInt(args.amountWei), lib.getAddress(args.to)]],
  }[action];
  if (!tail) no("unknown reserve action " + action, "input");
  const [t, v] = tail();
  return lc(lib.keccak256(lib.encodeAbiParameters([...head, ...t, W("uint256"), W("uint256")], [...headV, ...v, BigInt(nonce), BigInt(deadline)])));
}

/**
 * One owner action on the parallel reserve, ready to sign. action: configure {id, policy} | claimant {id, operator, allowed}
 * | withdraw {id, amountWei, to}. The recipient of a withdrawal is the owner's explicit choice: never defaulted.
 */
export async function prepareReserveAction(lib, profile, record, action, params = {}, { reader, pins = PRODUCTION_PINS, journal = null }){
  if (!ACTION_FN[action]) no("reserve action must be configure, claimant or withdraw", "input");
  const st = await reserveState(lib, profile, record, params.id, { reader, pins });
  if (journal){ const p = await journal.get(profile.vault); if (p) no(`a signed reserve request for this vault (nonce ${p.request.nonce}) is still undecided: reconcile it first`, "pending"); }
  if (!st.originBound) no("this vault is the OLDER credit-vault build, which does not check the signing site on chain: the parallel reserve refuses its signatures, and so does this page", "origin");
  if (st.signerRefused) no("the reserve refuses signatures from this vault's code", "refused");
  if (st.paused && action !== "withdraw") no("the platform has paused this reserve", "state");
  if (action !== "withdraw" && !st.ownedByVault) no(`deployment ${st.id} is owned by ${st.owner}, not this vault`, "input");
  const deadlineSec = params.deadlineSec == null ? DEFAULT_DEADLINE_SEC : Number(params.deadlineSec);
  if (!Number.isInteger(deadlineSec) || deadlineSec < 30 || deadlineSec > MAX_DEADLINE_SEC) no(`deadlineSec must be 30..${MAX_DEADLINE_SEC}`, "input");
  const deadline = BigInt(st.snap.timestamp + deadlineSec);
  let args, summary;
  if (action === "configure"){
    const policy = policyArg(params.policy);
    args = { policy: Object.fromEntries(Object.entries(policy).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])) };
    summary = [`${policy.enabled ? "Enable" : "Disable"} app-funded lease gas for ${st.id}: claims by ${Object.keys(CLAIM_POLICY)[policy.claimPolicy]} hosts, `
      + `≤ ${policy.maxPerOpWei} wei per operation, ≤ ${policy.epochCapWei} wei per ${policy.epochSec}s, gas price ≤ ${policy.maxGasPrice} wei, release ${policy.sponsorRelease ? "sponsored" : "not sponsored"}.`];
  } else if (action === "claimant"){
    if (!ADDR.test(lc(params.operator)) || lc(params.operator) === ZERO) no("claimant needs the host operator address", "input");
    if (typeof params.allowed !== "boolean") no("claimant needs allowed: true or false", "input");
    args = { operator: lc(params.operator), allowed: params.allowed };
    summary = [`${params.allowed ? "Allow" : "Disallow"} host operator ${lc(params.operator)} to claim ${st.id} at this app's expense (allowlist policy).`];
  } else {
    const to = lc(params.to);
    if (!ADDR.test(to) || to === ZERO) no("a withdrawal needs the recipient you choose (an address you control); there is no default", "input");
    if (to === st.record.reserve || to === lc(profile.vault)) no("the recipient cannot be the reserve or the vault (a vault cannot receive ETH)", "input");
    if (!UINT.test(String(params.amountWei ?? "")) || BigInt(params.amountWei) <= 0n) no("a withdrawal needs a positive amountWei", "input");
    if (BigInt(params.amountWei) > BigInt(st.reserve.balanceWei)) no(`the vault's reserve for ${st.id} holds ${st.reserve.balanceWei} wei`, "funds");
    args = { amountWei: String(params.amountWei), to };
    summary = [`Withdraw ${params.amountWei} wei of lease-gas ETH from this vault's reserve for ${st.id} to ${to}.`];
  }
  const base = { reserve: st.record.reserve, chainId: pins.chainId, id: st.id, owner: lc(profile.vault), nonce: st.sigNonce, deadline, args };
  const digest = reserveDigest(lib, action, base);
  // the reserve's own digest view must agree with the local recomputation (same block)
  const view = { configure: () => ["configureDigest", [st.id, profile.vault, policyArg(args.policy), st.sigNonce, deadline]],
    claimant: () => ["claimantDigest", [st.id, profile.vault, args.operator, args.allowed, st.sigNonce, deadline]],
    withdraw: () => ["withdrawDigest", [st.id, profile.vault, BigInt(args.amountWei), args.to, st.sigNonce, deadline]] }[action]();
  if (lc(await read(lib, reader, st.snap, st.record.reserve, RESERVE_ABI, view[0], view[1])) !== digest) no("the reserve's digest is not the digest computed here", "mismatch");
  return { v: 1, kind: RESERVE_PREPARED_KIND, op: "reserve-" + action, action, chainId: pins.chainId, vault: lc(profile.vault), reserve: st.record.reserve,
    id: st.id, nonce: st.sigNonce.toString(), deadline: deadline.toString(), args, digest, block: st.snap.number, blockTimestamp: st.snap.timestamp,
    summary, limits: ["Gas for this request is paid in ETH by the sender you choose; it gains no say over the reserve."] };
}

/** Is `prepared` exactly the reserve action the owner asked for? Rebuilt from the owner's own params, digest recomputed. */
export function verifyReserveIntent(lib, prepared, action, params = {}){
  const bad = (w) => no(`the prepared reserve action is not what you asked for (${w}). Nothing was signed.`, "intent");
  if (!prepared || prepared.kind !== RESERVE_PREPARED_KIND || prepared.action !== action) bad("a different action");
  if (lc(prepared.id) !== lc(params.id)) bad("a different deployment");
  const a = prepared.args || {};
  if (action === "configure"){
    const want = policyArg(params.policy), have = policyArg(a.policy);
    if (P_KEYS.some((k) => String(want[k]) !== String(have[k]))) bad("a different policy");
  } else if (action === "claimant"){
    if (lc(a.operator) !== lc(params.operator) || a.allowed !== params.allowed) bad("a different operator or choice");
  } else if (lc(a.to) !== lc(params.to) || String(a.amountWei) !== String(params.amountWei)) bad("a different recipient or amount");
  if (Number(prepared.deadline) - Number(prepared.blockTimestamp) > MAX_DEADLINE_SEC) bad("a deadline beyond " + MAX_DEADLINE_SEC + " s");
  if (reserveDigest(lib, action, { reserve: prepared.reserve, chainId: prepared.chainId, id: prepared.id, owner: prepared.vault, nonce: prepared.nonce,
    deadline: prepared.deadline, args: a }) !== lc(prepared.digest)) bad("a digest that is not the digest of its fields");
}
const b64 = (lib, hex) => { let s = ""; for (const b of lib.hexToBytes(hex)) s += String.fromCharCode(b); return btoa(s); };
/** Sign a prepared reserve action with the profile's passkey, at exactly the vault's origin, re-checked against intent. */
export async function signReserveAction(lib, prepared, profile, { pins = PRODUCTION_PINS, origin = globalThis.location && globalThis.location.origin, getFn, intent } = {}){
  validateProfile(profile, pins);
  if (origin !== profile.origin) no(`signing works only at ${profile.origin}: a passkey signature made anywhere else is refused by the vault. Nothing was signed.`, "origin");
  if (!intent) no("signing needs the owner's own request (action and params) to check the prepared action against", "input");
  verifyReserveIntent(lib, prepared, intent.action, intent.params);
  const f = pins.factories.find((x) => lc(x.address) === lc(profile.factory));
  if (f && f.originBound === false) no("this vault is the OLDER credit-vault build (no on-chain origin check): reserve signatures are refused", "origin");
  let a;
  try { a = await lib.WebAuthnP256.sign({ challenge: prepared.digest, credentialId: profile.credentialId, rpId: profile.rpId, userVerification: "required", ...(getFn ? { getFn } : {}) }); }
  catch (e){ const c = e && (e.cause || e); no(c && c.name === "NotAllowedError" ? "The passkey prompt was cancelled or timed out. Nothing was signed." : "Passkey signing failed: " + String(c && c.message || e).slice(0, 160), "cancelled"); }
  const assertion = { authenticatorData: a.metadata.authenticatorData, clientDataJSON: a.metadata.clientDataJSON, r: a.signature.r, s: a.signature.s };
  if (!(await assertionVerifies(lib, assertion, profile.x, profile.y))) no("that passkey is not this vault's key", "assertion");
  return assembleReserveRequest(lib, prepared, profile, assertion);
}
export function assembleReserveRequest(lib, prepared, profile, assertion){
  assertionShape(lib, assertion, prepared.digest, profile.origin);
  const signature = lib.encodeAbiParameters([SIG_T], [{ authenticatorData: assertion.authenticatorData, clientDataJSON: assertion.clientDataJSON,
    r: BigInt(assertion.r), s: BigInt(assertion.s), x: BigInt(profile.x), y: BigInt(profile.y) }]);
  const a = prepared.args, dl = BigInt(prepared.deadline);
  const callArgs = { configure: () => [prepared.id, policyArg(a.policy), dl, signature], claimant: () => [prepared.id, a.operator, a.allowed, dl, signature],
    withdraw: () => [prepared.id, prepared.vault, BigInt(a.amountWei), a.to, dl, signature] }[prepared.action]();
  return { v: 1, kind: RESERVE_REQUEST_KIND, chainId: prepared.chainId, vault: prepared.vault, reserve: prepared.reserve, id: prepared.id, op: prepared.op,
    action: prepared.action, nonce: prepared.nonce, deadline: prepared.deadline, digest: lc(prepared.digest), to: prepared.reserve,
    data: lc(lib.encodeFunctionData({ abi: RESERVE_ABI, functionName: ACTION_FN[prepared.action], args: callArgs })), fromBlock: prepared.block,
    preparedAt: prepared.blockTimestamp, summary: prepared.summary };
}
/** Re-derive a reserve request from its bytes (CLI, relay, reload): the function, the digest of its arguments at its
 *  nonce, and the assertion's challenge and origin. The reserve and the vault judge the signature itself. */
export function verifyReserveRequest(lib, req, { pins = PRODUCTION_PINS, record = null } = {}){
  if (!req || req.kind !== RESERVE_REQUEST_KIND || req.v !== 1) no("that is not a signed credit-vault reserve request", "input");
  if (req.chainId !== pins.chainId) no(`the request is for chain ${req.chainId}, these pins are chain ${pins.chainId}`, "input");
  if (record && lc(validateReserveRecord(record, pins).reserve) !== lc(req.to)) no("the request targets another reserve than the reviewed record", "input");
  if (!ADDR.test(lc(req.to)) || lc(req.to) !== lc(req.reserve) || !/^0x([0-9a-f]{2})+$/.test(req.data)) no("malformed reserve request", "input");
  let d; try { d = lib.decodeFunctionData({ abi: RESERVE_ABI, data: req.data }); } catch { no("the request's data is not a reserve call", "input"); }
  const action = Object.keys(ACTION_FN).find((k) => ACTION_FN[k] === d.functionName);
  if (!action || action !== req.action) no("the request's data is not the reserve action it names", "input");
  const a = d.args, sigBytes = a[a.length - 1], dl = a[a.length - 2];
  if (lc(a[0]) !== lc(req.id) || String(dl) !== String(req.deadline)) no("the request's record or deadline does not match its data", "input");
  const owner = action === "withdraw" ? lc(a[1]) : lc(req.vault);
  if (owner !== lc(req.vault)) no("the withdrawal names another owner than the request's vault", "input");
  const args = { configure: () => ({ policy: a[1] }), claimant: () => ({ operator: a[1], allowed: a[2] }), withdraw: () => ({ amountWei: a[2], to: a[3] }) }[action]();
  const digest = reserveDigest(lib, action, { reserve: req.to, chainId: req.chainId, id: req.id, owner, nonce: req.nonce, deadline: dl, args });
  if (digest !== lc(req.digest)) no("the request's digest is not the digest of its data at its nonce", "mismatch");
  const [sig] = lib.decodeAbiParameters([SIG_T], sigBytes);
  assertionShape(lib, sig, digest, pins.origin);
  return { action, args, sig };
}

/* ---- journal, submission and reconciliation (the reserve's sigNonce decides) ---- */
export function reserveStorageJournal(ls = globalThis.localStorage, chainId = PRODUCTION_PINS.chainId){
  const k = (vault) => RESERVE_JOURNAL_PREFIX + chainId + ":" + lc(vault);
  return { async get(vault){ try { return JSON.parse(ls.getItem(k(vault)) || "null"); } catch { return null; } },
    async put(entry){ ls.setItem(k(entry.request.vault), JSON.stringify(entry)); }, async clear(vault){ ls.removeItem(k(vault)); } };
}
export async function submitReserveRequest(lib, req, transport, { journal, reader = null, pins = PRODUCTION_PINS, record = null } = {}){
  verifyReserveRequest(lib, req, { pins, record });
  if (!journal) no("submission needs a journal", "input");
  const held = await journal.get(req.vault);
  if (held && held.request.digest !== req.digest) no(`another reserve request for this vault (nonce ${held.request.nonce}) is undecided: reconcile it first`, "pending");
  const entry = held || { request: req, txHashes: [], via: transport.name || "transport", status: "sending", at: Date.now() };
  await journal.put(entry);
  try {
    if (reader && transport.payer){
      const snap = await reader.snapshot();
      try { await reader.call(snap, req.to, req.data, { from: transport.payer }); }
      catch (e){ if (e && e.revert){ await journal.clear(req.vault); no("the reserve would refuse this request at the agreed block (expired, replayed, wrong key or a refused signer). Nothing was sent.", "simulation"); } throw e; }
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
/** executed (the reserve's SignedAction for this nonce came from a transaction with exactly these bytes) | superseded (the
 *  nonce went to another signed action) | expired | pending. */
export async function reconcileReserve(lib, entry, { reader, journal = null }){
  const req = entry.request, snap = await reader.snapshot();
  const key = await read(lib, reader, snap, req.to, RESERVE_ABI, "budgetKey", [req.id, req.vault]);
  const nonce = await read(lib, reader, snap, req.to, RESERVE_ABI, "sigNonce", [key]);
  const decided = async (status, extra = {}) => { if (journal) await journal.clear(req.vault); return { status, block: snap.number, nonce: nonce.toString(), ...extra }; };
  if (nonce > BigInt(req.nonce)){
    const from = Number(req.fromBlock || 0), to = Math.min(snap.number, from + (Number(req.deadline) - Number(req.preparedAt || 0)) + 60);
    const topic = lib.keccak256(lib.toHex("SignedAction(bytes32,address,bytes32,uint256)"));
    const seen = new Set();
    for (const h of [...(entry.txHashes || []), ...(await reader.logs(snap, { address: req.to, topics: [topic, req.id], fromBlock: from, toBlock: Math.max(from, to) })).map((l) => l.transactionHash)]){
      const hh = lc(h); if (!hh || seen.has(hh)) continue; seen.add(hh);
      const tx = await reader.tx(hh);
      if (!tx || lc(tx.to) !== lc(req.to) || lc(tx.input) !== lc(req.data)) continue;
      const rc = await reader.receipt(hh);
      if (rc && rc.status === "success" && rc.blockNumber <= snap.number) return decided("executed", { txHash: hh, blockNumber: rc.blockNumber });
    }
    return decided("superseded");
  }
  if (snap.timestamp > Number(req.deadline)) return decided("expired");
  return { status: "pending", block: snap.number, nonce: nonce.toString(), deadline: req.deadline, txHashes: entry.txHashes || [] };
}

/** A deposit for the vault-owned deployment into the parallel reserve: a plain payer transaction (anyone may pay; the vault's
 *  reserve there is credited, and the vault CAN enable and withdraw it). -> {to, data, value, summary}. */
export async function prepareReserveDeposit(lib, profile, record, { id, amountWei }, { reader, pins = PRODUCTION_PINS }){
  const st = await reserveState(lib, profile, record, id, { reader, pins });
  if (!st.ownedByVault) no(`deployment ${st.id} is owned by ${st.owner}, not this vault: the deposit would be credited to that owner`, "input");
  if (!st.originBound || st.signerRefused) no("this vault's signatures are refused by the reserve, so it could never enable or withdraw a deposit: none is prepared", "refused");
  if (!UINT.test(String(amountWei ?? "")) || BigInt(amountWei) <= 0n || BigInt(amountWei) >= 2n ** 96n) no("amountWei must be a positive amount below 2^96", "input");
  return { to: st.record.reserve, data: lc(lib.encodeFunctionData({ abi: RESERVE_ABI, functionName: "deposit", args: [st.id] })), value: BigInt(amountWei),
    summary: `Deposit ${amountWei} wei of lease gas for ${st.id}, credited to this vault's reserve in ${st.record.reserve} (anyone may pay; only the vault's passkey can enable or withdraw it).` };
}
export { keyHash };
