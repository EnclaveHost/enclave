// UNREVIEWED SOURCE (unified-funding relay-owner-r2; extends relay-r1/funding-route.mjs, which stays untouched).
// Additive, opt-in relay routes for the FundingSessionVault successor (EIP-712 "Enclave Sessions" version "2") under
// the EXISTING sessions service:
//
//   GET  /funding/config                 the activation manifest's identities, re-proven on chain at one pinned block
//   POST /funding/quote                  a gas.fund intent priced by the pinned Uniswap V3 QuoterV2
//   POST /funding/execute                vault.execute(action 10), simulated by the real vault, then host simulateAndSend
//   POST /funding/open                   factory.openFor / openWithDepositFor (needs host owner management)
//   POST /funding/owner                  successor owner controls (domain-2 owner signatures, checked by the CONTRACT)
//   POST /funding/end                    terminateBySession (the session key's domain-2 sign-out, checked by the CONTRACT)
//   GET  /funding/session/:vault/:sid    a successor session's state at the pinned block, never more live than the relay
//   GET  /funding/owner/:addr            the successor index for an owner's predicted vault
//   GET  /funding/tx/:hash               read-only reconciliation of a submitted tx that was not yet canonical
//
// What this module does NOT have: a wallet client, a private key, a TxQueue, a nonce manager, a signer, a signature
// verifier. Every write goes through the host's simulateAndSend (simulate, afterSimulate, existing journaled queue,
// receipt). No owner or session signature is "verified" in JS: the real vault decides, in simulation at the pinned
// block and again in the host's simulation, before anything is marked or sent.
//
// Disabled unless ALL of these hold (else every /funding/* route answers 503 funding_disabled, saying why):
//   - an activation manifest (parseFundingManifest) naming chain 8453, every identity and its exact runtime code hash;
//   - a host quote policy { fee(ctx) -> fee6, accept(ctx) -> true } (this module never invents a price or a margin);
//   - the host's simulateAndSend callback, public client, relayer address and store.
// /funding/open, /funding/owner and /funding/end additionally need ownerManagement === true AND the host's rateOwner
// callback. Nothing in a request body can enable anything.
//
// Import path: relative to this stage directory. prepare.py rewrites it to the bare specifier "viem" in the drop-in copy.
import { readFileSync } from "node:fs";
import { decodeAbiParameters, decodeErrorResult, decodeEventLog, encodeAbiParameters, encodeEventTopics, getAddress, isAddress,
  keccak256 } from "viem";
import { fundingSessionVaultAbi, fundingSessionVaultFactoryAbi, leaseGasDexAdapterAbi, fundingLedgerAbi }
  from "./funding-abi.mjs";

// =====================================================================================================================
// Constants and ABIs
// =====================================================================================================================

export const FUNDING_CHAIN_ID = 8453;
export const MANIFEST_SCHEMA = "enclave-funding-activation-r1";
export const ACTION_GAS_FUND = 10;
const RETIRED_ACTION = 9;
const INTENT_BYTES = 224;
const RESULT_BYTES = 64;                           // abi.encode(uint256 used, uint256 refund)
const MAX_DEADLINE_WINDOW = 900n;                  // LeaseGasDexAdapter.MAX_DEADLINE_WINDOW
export const FEE_TIERS = Object.freeze([100, 500, 3000, 10000]);
export const MAX_SLIPPAGE_BPS = 500;
const UINT32_MAX = (1n << 32n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const EMPTY_CODEHASH = keccak256("0x");
const BOOK_DEPLOYMENTS = `0x${Buffer.from("deployments").toString("hex").padEnd(64, "0")}`;
const CLONE_INIT_PREFIX = "3d602d80600a3d3981f3363d3d373d3d3d363d73";
const CLONE_SUFFIX = "5af43d82803e903d91602b57fd5bf3";
/** sessions.mjs revokedBeforeOpen: an in-flight revokeAll covers every session of the vault for this long. */
export const REVOKE_INFLIGHT_SEC = 600;
const PENDING_MAX = 500;

/** Successor owner controls relayed by /funding/owner (the original /owner op names). ownerCall is direct-owner only. */
export const OWNER_OPS = Object.freeze(["topUp", "topUpWithAuthorization", "extend", "terminate", "revokeAll", "withdraw",
  "promote", "adopt", "setEnvironment", "release", "close"]);

export const PIN_KEYS = Object.freeze(["factory", "implementation", "fundingGasLib", "fundingSessionVaultLib", "adapter",
  "legacyFactory", "legacyImplementation", "usdc", "weth", "book", "ledger", "reserve", "swapRouter", "dexFactory", "quoter"]);
const LINKED_LIBS = Object.freeze(["fundingGasLib", "fundingSessionVaultLib"]);

const vaultAbi = fundingSessionVaultAbi;
const factoryAbi = fundingSessionVaultFactoryAbi;
const adapterAbi = leaseGasDexAdapterAbi;
const ledgerAbi = fundingLedgerAbi;

const addrOut = [{ name: "", type: "address" }];
const view = (name, inputs, outputs) => ({ type: "function", name, stateMutability: "view", inputs, outputs });
export const bookAbi = Object.freeze([view("addr", [{ name: "key", type: "bytes32" }], addrOut)]);
export const reserveAbi = Object.freeze([view("ledger", [], addrOut)]);
export const legacyFactoryAbi = Object.freeze([view("implementation", [], addrOut),
  view("isVault", [{ name: "", type: "address" }], [{ name: "", type: "bool" }]),
  view("vaultFor", [{ name: "owner", type: "address" }], addrOut)]);
export const legacyVaultAbi = Object.freeze([view("owner", [], addrOut)]);
export const quoterV2Abi = Object.freeze([view("factory", [], addrOut), view("WETH9", [], addrOut),
  { type: "function", name: "quoteExactOutputSingle", stateMutability: "nonpayable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amount", type: "uint256" },
      { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
    outputs: [{ name: "amountIn", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" }] }]);

const OPEN_FOR = factoryAbi.find((x) => x.type === "function" && x.name === "openFor");
if (!OPEN_FOR || OPEN_FOR.inputs[1]?.type !== "tuple") throw new Error("funding-abi: FundingSessionVaultFactory.openFor(owner, Grant, sig) not found");
export const GRANT_COMPONENTS = Object.freeze(OPEN_FOR.inputs[1].components.map((c) => Object.freeze({ name: c.name, type: c.type })));
const GAS_LIMIT_FIELDS = Object.freeze(["maxGasUsdcPerOp", "maxUsdcPerEth6", "maxEthPerOp"]);
for (const k of GAS_LIMIT_FIELDS) if (!GRANT_COMPONENTS.some((c) => c.name === k)) throw new Error(`funding-abi: Grant lacks ${k}`);
for (const fn of [...OWNER_OPS, "terminateBySession", "epoch"]) {
  if (!vaultAbi.some((x) => x.type === "function" && x.name === fn)) throw new Error(`funding-abi: FundingSessionVault lacks ${fn}`);
}

const INTENT_PARAMS = Object.freeze([{ type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" },
  { type: "uint256" }, { type: "uint24" }, { type: "uint64" }]);

// =====================================================================================================================
// Errors and strict parsing
// =====================================================================================================================

export class FundingRouteError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = "FundingRouteError";
    this.status = status; this.code = code; this.extra = extra;
  }
}
const httpError = (status, code, message, extra) => new FundingRouteError(status, code, message, extra);
const msg = (e) => String(e?.shortMessage || e?.message || e).slice(0, 300);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function uint(v, bits, name) {
  let n;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number" && Number.isSafeInteger(v)) n = BigInt(v);
  else if (typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v)) n = BigInt(v);
  else throw httpError(400, "bad_request", `${name} must be a non-negative integer (bigint, safe number or decimal string)`);
  if (n < 0n || n >= 1n << BigInt(bits)) throw httpError(400, "bad_request", `${name} is out of range for uint${bits}`);
  return n;
}
function address(v, name) {
  if (typeof v !== "string" || !isAddress(v, { strict: false }) || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw httpError(400, "bad_request", `${name} must be an address`);
  const a = getAddress(v.toLowerCase());
  if (v !== v.toLowerCase() && v !== a) throw httpError(400, "bad_request", `${name} has a wrong EIP-55 checksum`);
  return a;
}
function hex32(v, name) {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw httpError(400, "bad_request", `${name} must be 32-byte hex`);
  return v.toLowerCase();
}
function hexBytes(v, name, maxBytes) {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v) || v.length > 2 + 2 * maxBytes) {
    throw httpError(400, "bad_request", `${name} must be even-length hex, at most ${maxBytes} bytes`);
  }
  return v.toLowerCase();
}
function str(v, name, max = 1024) {
  if (typeof v !== "string" || v.length > max) throw httpError(400, "bad_request", `${name} must be a string of at most ${max} chars`);
  return v;
}
function bool(v, name) {
  if (typeof v !== "boolean") throw httpError(400, "bad_request", `${name} must be a boolean`);
  return v;
}
function plain(o, name) {
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw httpError(400, "bad_request", `${name} must be an object`);
}
function exactKeys(o, keys, name, optional = []) {
  plain(o, name);
  const allowed = new Set([...keys, ...optional]);
  const extra = Object.keys(o).filter((k) => !allowed.has(k));
  if (extra.length) throw httpError(400, "bad_request", `${name} has unknown field(s) ${extra.join(", ")}`);
  const missing = keys.filter((k) => !has(o, k) || o[k] === undefined);
  if (missing.length) throw httpError(400, "bad_request", `${name} is missing ${missing.join(", ")}`);
}

export function revertData(e) {
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++) {
    if (typeof x.raw === "string" && /^0x[0-9a-fA-F]{8}/.test(x.raw)) return x.raw;
    if (typeof x.data === "string" && /^0x[0-9a-fA-F]{8}/.test(x.data)) return x.data;
  }
  return undefined;
}

// =====================================================================================================================
// Pure helpers
// =====================================================================================================================

export function predictVault(factory, implementation, owner) {
  const f = getAddress(factory).slice(2).toLowerCase();
  const i = getAddress(implementation).slice(2).toLowerCase();
  const o = getAddress(owner).slice(2).toLowerCase();
  const codeHash = keccak256(`0x${CLONE_INIT_PREFIX}${i}${CLONE_SUFFIX}`).slice(2);
  return getAddress(`0x${keccak256(`0xff${f}${o.padStart(64, "0")}${codeHash}`).slice(26)}`);
}

export function cloneRuntime(implementation) {
  return `0x363d3d373d3d3d363d73${getAddress(implementation).slice(2).toLowerCase()}${CLONE_SUFFIX}`;
}

export function sessionIdOf(vault, sessionKey, grantNonce) {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
    [getAddress(vault), sessionKey, grantNonce]));
}

export function encodeIntent(i) {
  return encodeAbiParameters(INTENT_PARAMS, [i.payer, i.deployment, i.expectedOwner, i.ethOut, i.maxUsdcIn6, BigInt(i.fee), i.deadline]);
}

export function decodeIntent(data) {
  const hex = hexBytes(data, "args", INTENT_BYTES);
  if ((hex.length - 2) / 2 !== INTENT_BYTES) throw httpError(400, "bad_args", `gas.fund args must be exactly ${INTENT_BYTES} bytes`);
  let w;
  try { w = decodeAbiParameters(INTENT_PARAMS, hex); } catch (e) { throw httpError(400, "bad_args", `args do not decode: ${msg(e)}`); }
  const i = { payer: getAddress(w[0]), deployment: w[1].toLowerCase(), expectedOwner: getAddress(w[2]), ethOut: w[3],
    maxUsdcIn6: w[4], fee: Number(w[5]), deadline: BigInt(w[6]) };
  if (encodeIntent(i).toLowerCase() !== hex) throw httpError(400, "bad_args", "args carry non-canonical (dirty) bits");
  if (i.deployment === ZERO_HASH) throw httpError(400, "bad_args", "intent.deployment is zero");
  if (i.ethOut === 0n || i.maxUsdcIn6 === 0n) throw httpError(400, "bad_args", "intent.ethOut and intent.maxUsdcIn6 must be positive");
  if (!FEE_TIERS.includes(i.fee)) throw httpError(400, "bad_args", `intent.fee ${i.fee} is not a Uniswap V3 tier`);
  return Object.freeze(i);
}

/** Strict event decoding: decode, then RE-ENCODE topics and data and require byte equality (no trailing bytes, no dirty
 *  words, no lenient decoding). Throws if the log is not exactly one canonical event of `abi`. */
export function strictEvent(abi, log) {
  const topics = (log.topics ?? []).map((t) => String(t).toLowerCase());
  const data = String(log.data ?? "0x").toLowerCase();
  const ev = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
  for (const item of abi.filter((x) => x.type === "event" && x.name === ev.eventName)) {
    try {
      const t = encodeEventTopics({ abi: [item], eventName: ev.eventName, args: ev.args }).map((x) => String(x).toLowerCase());
      const nonIdx = item.inputs.filter((i) => !i.indexed);
      const d = encodeAbiParameters(nonIdx, nonIdx.map((i) => ev.args[i.name])).toLowerCase();
      if (t.length === topics.length && t.every((x, k) => x === topics[k]) && d === data) return ev;
    } catch { /* next overload */ }
  }
  throw new Error(`log ${ev.eventName} is not canonically encoded`);
}

/** The period/op/nonce guards FundingSessionVault._spend applies (client-r1 preflightGasFund parity), at block time. */
export function spendGuards(s, timestamp, seq) {
  const reset = BigInt(timestamp) >= BigInt(s.periodStart) + BigInt(s.period);
  const periodOps = reset ? 0n : BigInt(s.periodOps);
  if (periodOps >= UINT32_MAX) throw httpError(409, "op_counter_exhausted", "the period operation counter cannot be incremented");
  const opsPerPeriod = BigInt(s.opsPerPeriod);
  if (opsPerPeriod !== 0n && periodOps >= opsPerPeriod) {
    throw httpError(409, "op_limit", `${periodOps} of ${opsPerPeriod} operations used this period`, { periodReset: reset });
  }
  if (seq != null && BigInt(seq) >= UINT64_MAX) throw httpError(409, "nonce_lane_exhausted", "this nonce lane can never advance (no wrap)");
  return { reset, periodSpent6: reset ? 0n : BigInt(s.periodSpent6), periodOps };
}

// =====================================================================================================================
// Activation manifest (unchanged from relay-r1)
// =====================================================================================================================

const MANIFEST_KEYS = ["schema", "chainId", "notAfter", "maxBlockAgeSec", "addresses", "codehashes", "pools", "feeTiers",
  "maxSlippageBps", "deadlineSec"];

function codehash(v, name) {
  if (typeof v !== "string" || !/^0x[0-9a-f]{64}$/.test(v)) throw httpError(400, "bad_manifest", `${name} must be lowercase 0x + 64 hex`);
  if (v === ZERO_HASH || v === EMPTY_CODEHASH) throw httpError(400, "bad_manifest", `${name} is the zero or empty-code hash`);
  return v;
}

export function parseFundingManifest(m) {
  if (m === null || m === undefined) return { why: "funding is not configured on this relay (no activation manifest)" };
  if (m && typeof m === "object" && Object.keys(m).length === 1 && typeof m.invalid === "string") return { why: m.invalid };
  try {
    exactKeys(m, MANIFEST_KEYS, "manifest");
    if (m.schema !== MANIFEST_SCHEMA) throw httpError(400, "bad_manifest", `manifest.schema must be "${MANIFEST_SCHEMA}"`);
    if (uint(m.chainId, 64, "manifest.chainId") !== BigInt(FUNDING_CHAIN_ID)) {
      throw httpError(400, "bad_manifest", `manifest.chainId must be ${FUNDING_CHAIN_ID} (Base)`);
    }
    const notAfter = uint(m.notAfter, 64, "manifest.notAfter");
    const maxBlockAgeSec = uint(m.maxBlockAgeSec, 32, "manifest.maxBlockAgeSec");
    if (maxBlockAgeSec < 1n || maxBlockAgeSec > 600n) throw httpError(400, "bad_manifest", "manifest.maxBlockAgeSec must be 1..600");
    exactKeys(m.addresses, PIN_KEYS, "manifest.addresses");
    exactKeys(m.codehashes, PIN_KEYS, "manifest.codehashes");
    const addresses = {}, codehashes = {};
    for (const k of PIN_KEYS) {
      addresses[k] = address(m.addresses[k], `manifest.addresses.${k}`);
      codehashes[k] = codehash(m.codehashes[k], `manifest.codehashes.${k}`);
    }
    if (!Array.isArray(m.feeTiers) || m.feeTiers.length === 0) throw httpError(400, "bad_manifest", "manifest.feeTiers must be a non-empty array");
    const feeTiers = m.feeTiers.map((t, k) => Number(uint(t, 24, `manifest.feeTiers[${k}]`)));
    if (feeTiers.some((t) => !FEE_TIERS.includes(t)) || new Set(feeTiers).size !== feeTiers.length) {
      throw httpError(400, "bad_manifest", "manifest.feeTiers must be distinct members of 100/500/3000/10000");
    }
    exactKeys(m.pools, feeTiers.map(String), "manifest.pools");
    const pools = {};
    for (const t of feeTiers) {
      exactKeys(m.pools[t], ["address", "codehash"], `manifest.pools.${t}`);
      pools[t] = Object.freeze({ address: address(m.pools[t].address, `manifest.pools.${t}.address`),
        codehash: codehash(m.pools[t].codehash, `manifest.pools.${t}.codehash`) });
    }
    const ids = [...Object.values(addresses), ...Object.values(pools).map((p) => p.address)];
    if (new Set(ids).size !== ids.length) throw httpError(400, "bad_manifest", "manifest identities must be pairwise distinct");
    const maxSlippageBps = Number(uint(m.maxSlippageBps, 16, "manifest.maxSlippageBps"));
    if (maxSlippageBps > MAX_SLIPPAGE_BPS) throw httpError(400, "bad_manifest", `manifest.maxSlippageBps must be <= ${MAX_SLIPPAGE_BPS}`);
    const deadlineSec = uint(m.deadlineSec, 32, "manifest.deadlineSec");
    if (deadlineSec < 30n || deadlineSec > MAX_DEADLINE_WINDOW) throw httpError(400, "bad_manifest", "manifest.deadlineSec must be 30..900");
    return { manifest: Object.freeze({ chainId: FUNDING_CHAIN_ID, notAfter, maxBlockAgeSec, addresses: Object.freeze(addresses),
      codehashes: Object.freeze(codehashes), pools: Object.freeze(pools), feeTiers: Object.freeze(feeTiers), maxSlippageBps,
      deadlineSec }) };
  } catch (e) {
    return { why: `the funding activation manifest is refused: ${e.message}` };
  }
}

export function fundingManifestFromEnv(env) {
  const p = String(env?.SESSIONS_FUNDING_MANIFEST ?? "").trim();
  if (!p) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { return { invalid: `SESSIONS_FUNDING_MANIFEST could not be read: ${msg(e)}` }; }
}

// =====================================================================================================================
// The route
// =====================================================================================================================

/** `ownerManagement` is a HOST-CODE flag and `rateOwner` the host's per-owner quota helper (sessions.mjs rateOwner:
 *  check before simulation, count after acceptance, terminate/revokeAll exempt). Both are required for /funding/open,
 *  /funding/owner and /funding/end. */
export function createFundingRoute({ manifest = null, quotePolicy = null, ownerManagement = false, rateOwner = null, pc = null,
  relayer = null, store = null, log = () => {}, now = () => Math.floor(Date.now() / 1000), simulateAndSend = null } = {}) {
  const setup = parseFundingManifest(manifest);
  let why = setup.why ?? null;
  if (!why && (!quotePolicy || typeof quotePolicy.fee !== "function" || typeof quotePolicy.accept !== "function")) {
    why = "funding needs a reviewed host quote policy ({ fee, accept }); none is wired, so no price is offered";
  }
  if (!why && typeof simulateAndSend !== "function") why = "funding needs the host's simulateAndSend callback";
  if (!why && (!pc || typeof pc.readContract !== "function" || typeof pc.simulateContract !== "function"
    || typeof pc.getTransactionReceipt !== "function" || typeof pc.getBlock !== "function")) why = "funding needs the host's public client";
  if (!why && (typeof relayer !== "string" || !isAddress(relayer))) why = "funding needs the relayer address";
  if (!why && !store?.data) why = "funding needs the host's store";
  const M = why ? null : setup.manifest;
  const A = M?.addresses;
  const R = M ? getAddress(relayer) : null;
  const ownerAllowed = ownerManagement === true && typeof rateOwner === "function";
  const ownerWhy = ownerAllowed ? null : ownerManagement !== true
    ? "successor owner management is not enabled by the host"
    : "successor owner management needs the host's rateOwner callback";
  if (M) {
    store.data.revoked ??= {};          // SHARED with the host: sid -> unix (off-chain revocation)
    store.data.revokedVaults ??= {};    // SHARED with the host: vault -> { at, block, successorEpoch? }
    store.data.fundingOps ??= {};       // sid -> [{ nonce, action, amount6 (ACTUAL), fee6, maxUsdcIn6, ... }]
    store.data.fundingVaults ??= {};    // successor vault -> owner (kept apart from the original factory's index)
    store.data.fundingSessions ??= {};  // successor sid -> { vault, keyHash, expiresAt, openedBlock, ended, ... }
    store.data.fundingPending ??= {};   // txHash -> { kind, at, reason, meta } submitted, not yet canonical
  }
  log(M ? `funding: on (successor factory ${A.factory}, owner management ${ownerAllowed ? "on" : "off"})` : `funding: off (${why})`);

  const rd = (address_, abi, functionName, args, blockNumber) => pc.readContract({ address: address_, abi, functionName, args, blockNumber });
  async function step(fn, code = "chain_unreadable") {
    try { return await fn(); } catch (e) {
      if (e instanceof FundingRouteError) throw e;
      throw httpError(503, code, `a chain read failed: ${msg(e)}`);
    }
  }
  const flush = () => { if (typeof store.flush === "function") store.flush(); else store.saveSoon?.(); };

  // ---- pins (unchanged from relay-r1) -------------------------------------------------------------------------------
  async function readPins() {
    const blk = await step(() => pc.getBlock({ blockTag: "latest" }), "pin_unreadable");
    const chain = await step(() => pc.getChainId(), "pin_unreadable");
    if (Number(chain) !== FUNDING_CHAIN_ID) throw httpError(503, "chain_mismatch", `the RPC serves chain ${chain}, not ${FUNDING_CHAIN_ID}`);
    if (blk?.number == null || blk?.timestamp == null) throw httpError(503, "pin_unreadable", "the latest block has no number/timestamp");
    const B = BigInt(blk.number);
    const ts = BigInt(blk.timestamp);
    const t = BigInt(now());
    if (t > M.notAfter) throw httpError(503, "manifest_stale", `the activation manifest expired at ${M.notAfter}`);
    if (t > ts + M.maxBlockAgeSec) throw httpError(503, "block_stale", `the latest block (${B}) is ${t - ts}s old`);
    const pin = (code, message) => { throw httpError(503, code, message, { block: B.toString() }); };
    const codes = {};
    const checkCode = async (label, a, want) => {
      const code = await step(() => pc.getCode({ address: a, blockNumber: B }), "pin_unreadable");
      if (!code || code === "0x") pin("missing_code", `${label} ${a} has no code at block ${B}`);
      if (keccak256(code) !== want) pin("codehash_mismatch", `${label} ${a} runtime code hash differs from the manifest at block ${B}`);
      return code.toLowerCase();
    };
    for (const k of PIN_KEYS) codes[k] = await checkCode(k, A[k], M.codehashes[k]);
    for (const tier of M.feeTiers) await checkCode(`pool(${tier})`, M.pools[tier].address, M.pools[tier].codehash);
    for (const k of LINKED_LIBS) {
      // address substring only: NOT a call-site proof (see REVIEW: build link verification is required separately)
      if (!codes.implementation.includes(A[k].slice(2).toLowerCase())) pin("library_unlinked", `the implementation does not link ${k} ${A[k]}`);
    }
    const eq = async (label, a, abi, fn, args, want) => {
      const got = await step(() => rd(a, abi, fn, args, B), "pin_unreadable");
      if (typeof got !== "string" || !isAddress(got) || getAddress(got) !== want) pin("identity_mismatch", `${label} is ${got}, the manifest says ${want}`);
    };
    await eq("factory.implementation()", A.factory, factoryAbi, "implementation", [], A.implementation);
    for (const [fn, want] of [["factory", A.factory], ["usdc", A.usdc], ["book", A.book], ["gasAdapter", A.adapter],
      ["legacyFactory", A.legacyFactory]]) await eq(`implementation.${fn}()`, A.implementation, vaultAbi, fn, [], want);
    await eq("book.addr(\"deployments\")", A.book, bookAbi, "addr", [BOOK_DEPLOYMENTS], A.ledger);
    for (const [fn, want] of [["usdc", A.usdc], ["weth", A.weth], ["swapRouter", A.swapRouter], ["factory", A.dexFactory],
      ["ledger", A.ledger], ["reserve", A.reserve]]) await eq(`adapter.${fn}()`, A.adapter, adapterAbi, fn, [], want);
    await eq("reserve.ledger()", A.reserve, reserveAbi, "ledger", [], A.ledger);
    await eq("legacyFactory.implementation()", A.legacyFactory, legacyFactoryAbi, "implementation", [], A.legacyImplementation);
    for (const tier of M.feeTiers) await eq(`adapter.poolFor(${tier})`, A.adapter, adapterAbi, "poolFor", [tier], M.pools[tier].address);
    await eq("quoter.factory()", A.quoter, quoterV2Abi, "factory", [], A.dexFactory);
    await eq("quoter.WETH9()", A.quoter, quoterV2Abi, "WETH9", [], A.weth);
    const adapterMaxEthOut = BigInt(await step(() => rd(A.adapter, adapterAbi, "maxEthOut", [], B), "pin_unreadable"));
    if (adapterMaxEthOut === 0n) pin("identity_mismatch", "adapter.maxEthOut() is 0");
    return Object.freeze({ block: B, timestamp: ts, adapterMaxEthOut });
  }

  async function fundingVault(v, P) {
    const vault = address(v, "vault");
    const B = P.block;
    if (!(await step(() => rd(A.factory, factoryAbi, "isVault", [vault], B)))) {
      throw httpError(404, "not_a_funding_vault", `${vault} is not a vault of the successor factory ${A.factory}`);
    }
    const owner = getAddress(await step(() => rd(vault, vaultAbi, "owner", [], B)));
    if (predictVault(A.factory, A.implementation, owner) !== vault) throw httpError(409, "vault_identity", "the vault is not the CREATE2 clone for its owner");
    const onchain = await step(() => rd(A.factory, factoryAbi, "vaultFor", [owner], B));
    if (getAddress(onchain) !== vault) throw httpError(409, "vault_identity", "factory.vaultFor(owner) is not this vault");
    const code = await step(() => pc.getCode({ address: vault, blockNumber: B }));
    if (String(code ?? "").toLowerCase() !== cloneRuntime(A.implementation)) throw httpError(409, "vault_identity", "the vault's code is not a clone of the pinned implementation");
    return { vault, owner };
  }

  async function sessionAt(vault, sid, B) {
    const [s, live] = await step(() => rd(vault, vaultAbi, "sessionOf", [sid], B));
    const [maxGasUsdc6, maxUsdcPerEth6, maxEthWei] = await step(() => rd(vault, vaultAbi, "gasPolicyOf", [sid], B));
    const vaultEpoch = BigInt(await step(() => rd(vault, vaultAbi, "epoch", [], B)));
    return { s, live: Boolean(live), vaultEpoch,
      policy: { maxGasUsdc6: BigInt(maxGasUsdc6), maxUsdcPerEth6: BigInt(maxUsdcPerEth6), maxEthWei: BigInt(maxEthWei) } };
  }

  async function holderOf(deployment, vault, owner, B) {
    const d = await step(() => rd(A.ledger, ledgerAbi, "get", [deployment], B));
    if (String(d?.id ?? "").toLowerCase() !== deployment) throw httpError(404, "unknown_deployment", `deployment ${deployment} does not exist`);
    const holder = getAddress(d.owner);
    if (holder === vault) return { holder, kind: "vault" };
    if (holder === owner) return { holder, kind: "wallet" };
    const lf = A.legacyFactory;
    const isOld = await step(() => rd(lf, legacyFactoryAbi, "isVault", [holder], B));
    const oldFor = isOld ? getAddress(await step(() => rd(lf, legacyFactoryAbi, "vaultFor", [owner], B))) : null;
    const oldOwner = oldFor === holder ? getAddress(await step(() => rd(holder, legacyVaultAbi, "owner", [], B))) : null;
    if (!isOld || oldFor !== holder || oldOwner !== owner) throw httpError(403, "not_mine", "the record is not held by this vault, its owner, or the owner's original vault");
    return { holder, kind: "legacyVault" };
  }

  async function quoteIn(ethOut, tier, B) {
    let r;
    try {
      r = await rd(A.quoter, quoterV2Abi, "quoteExactOutputSingle",
        [{ tokenIn: A.usdc, tokenOut: A.weth, amount: ethOut, fee: tier, sqrtPriceLimitX96: 0n }], B);
    } catch (e) {
      throw httpError(502, "quote_unavailable", `QuoterV2 gave no exact-output quote at tier ${tier}: ${msg(e)}; no price is offered`);
    }
    const amountIn = BigInt(Array.isArray(r) ? r[0] : r);
    if (amountIn === 0n) throw httpError(502, "quote_unavailable", "QuoterV2 quoted 0; no price is offered");
    return amountIn;
  }

  async function policyCall(name, ctx) {
    try { return await quotePolicy[name](Object.freeze(ctx)); }
    catch (e) { throw httpError(503, "quote_policy_failed", `the host quote policy (${name}) failed: ${msg(e)}`); }
  }

  async function presimulate(to, abi, functionName, args, B) {
    try {
      await pc.simulateContract({ address: to, abi, functionName, args, account: R, blockNumber: B });
    } catch (e) {
      const data = revertData(e);
      let errorName = null;
      if (data) for (const x of [abi, vaultAbi]) { try { errorName = decodeErrorResult({ abi: x, data }).errorName; break; } catch { /* next */ } }
      throw httpError(409, "revert", `the contract refused ${functionName} in simulation at block ${B}${errorName ? ` (${errorName})` : ""}`,
        { revert: data ?? null, errorName });
    }
  }

  // ---- shared off-chain revocation (host semantics + successor epoch) -----------------------------------------------
  const revoked = (sid) => Boolean(store.data.revoked?.[sid]);
  const vaultRevocation = (vault) => {
    const r = store.data.revokedVaults?.[vault];
    return r && typeof r === "object" ? r : null;
  };
  /** A revokeAll this relay submitted that is not yet canonical refuses every session of the vault (host: <= 600 s). */
  const inflightRevoked = (vault) => {
    const r = vaultRevocation(vault);
    return Boolean(r && r.block == null && now() - Number(r.at) < REVOKE_INFLIGHT_SEC);
  };
  /** After that, a session passes only if it was opened in a LATER epoch than the one this relay revoked: fresh sessions
   *  opened after the completed revokeAll carry epoch + 1 and are never permanently blocked. */
  const epochRevoked = (vault, sessionEpoch) => {
    const r = vaultRevocation(vault);
    return Boolean(r && r.successorEpoch != null && BigInt(sessionEpoch) <= BigInt(r.successorEpoch));
  };
  function refuseRevoked(vault, sid) {
    if (revoked(sid)) throw httpError(409, "not_live", "this session has been signed out");
    if (inflightRevoked(vault)) throw httpError(409, "not_live", "every session of this vault is being revoked");
  }
  function refuseRevokedAt(vault, sid, st) {
    refuseRevoked(vault, sid);
    if (!st.live) throw httpError(409, "not_live", "this session is not live");
    if (BigInt(st.s.epoch) !== st.vaultEpoch || epochRevoked(vault, st.s.epoch)) throw httpError(409, "not_live", "every session of this vault was revoked");
  }

  // ---- canonical inclusion: never a zero/null-hash preconfirmation, never an uncanonical receipt --------------------
  function recordPending(txHash, kind, meta, reason) {
    const P = store.data.fundingPending;
    P[txHash] = { kind, at: now(), reason, meta };
    const keys = Object.keys(P);
    if (keys.length > PENDING_MAX) keys.sort((a, b) => P[a].at - P[b].at).slice(0, keys.length - PENDING_MAX).forEach((k) => delete P[k]);
    flush();
  }
  /** { receipt } (the CANONICAL receipt re-read from the node) or { pending: reason }. Read-only; never resubmits. */
  async function canonical(rc) {
    const bh = typeof rc?.blockHash === "string" ? rc.blockHash.toLowerCase() : null;
    if (!bh || !/^0x[0-9a-f]{64}$/.test(bh) || bh === ZERO_HASH) return { pending: "no_canonical_block_hash" };
    if (rc.blockNumber == null || BigInt(rc.blockNumber) <= 0n) return { pending: "no_block_number" };
    const bn = BigInt(rc.blockNumber);
    const hash = rc.transactionHash.toLowerCase();
    let r2, b;
    try { r2 = await pc.getTransactionReceipt({ hash }); } catch { return { pending: "receipt_unavailable" }; }
    if (!r2 || String(r2.transactionHash).toLowerCase() !== hash || String(r2.blockHash ?? "").toLowerCase() !== bh
      || r2.blockNumber == null || BigInt(r2.blockNumber) !== bn) return { pending: "receipt_mismatch" };
    if (r2.status !== "success" && r2.status !== "reverted") return { pending: "unknown_receipt_status" };
    if (!Array.isArray(r2.logs)) return { pending: "missing_receipt_logs" };
    try { b = await pc.getBlock({ blockNumber: bn }); } catch { return { pending: "block_unavailable" }; }
    if (!b || String(b.hash ?? "").toLowerCase() !== bh || BigInt(b.number) !== bn) return { pending: "block_not_canonical" };
    for (const l of r2.logs) {
      if (String(l.blockHash ?? "").toLowerCase() !== bh
        || String(l.transactionHash ?? "").toLowerCase() !== hash
        || l.blockNumber == null || BigInt(l.blockNumber) !== bn || l.removed !== false) return { pending: "log_mismatch" };
    }
    return { receipt: r2 };
  }
  /** Accept the host's receipt only once it is canonical; else record it and answer 202 (bounded, read-only). */
  async function completed(kind, rc, meta) {
    const txHash = typeof rc?.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(rc.transactionHash)
      ? rc.transactionHash.toLowerCase() : null;
    if (!txHash) throw httpError(502, "no_tx_hash", `${kind}: the host returned no transaction hash`);
    const c = await canonical({ ...rc, transactionHash: txHash });
    if (c.pending) {
      recordPending(txHash, kind, meta, c.pending);
      throw httpError(202, "pending_reconciliation", `submitted ${txHash}, not yet canonical (${c.pending}); it is NOT resubmitted, `
        + "NOT treated as failed or refunded, and nothing is indexed until it is", { txHash, reconcile: `/funding/tx/${txHash}` });
    }
    if (c.receipt.status !== "success") {
      delete store.data.fundingPending[txHash]; flush();
      throw httpError(409, "reverted", `${kind} reverted in canonical block ${c.receipt.blockNumber} (${txHash})`, { txHash });
    }
    const out = FINISH[kind](c.receipt, meta);
    delete store.data.fundingPending[txHash];
    flush();
    return out;
  }

  // ---- successor index from canonical receipts only -----------------------------------------------------------------
  function vaultEvents(logs, vault) {
    const out = [];
    for (const l of Array.isArray(logs) ? logs : []) {
      let a;
      try { a = getAddress(l.address); } catch { continue; }
      if (a !== vault) continue;
      let ev;
      try { ev = strictEvent(vaultAbi, l); } catch (e) { throw httpError(502, "settlement_noncanonical_event", `a vault log is not canonical: ${msg(e)}`); }
      out.push({ ...ev, blockNumber: l.blockNumber, transactionHash: l.transactionHash });
    }
    return out;
  }
  function foldVault(events, vault) {
    const S = store.data.fundingSessions;
    for (const { eventName, args: E, blockNumber, transactionHash } of events) {
      const blk = blockNumber != null ? Number(blockNumber) : null;
      const sid = E.sid ? E.sid.toLowerCase() : null;
      if (eventName === "SessionOpened") {
        S[sid] = { ...(S[sid] ?? {}), vault, keyHash: E.keyHash.toLowerCase(), expiresAt: Number(E.expiresAt),
          actions: E.actions.toString(), envs: Number(E.envs), budget6: E.budget6.toString(), label: E.label,
          openedBlock: blk ?? S[sid]?.openedBlock ?? null, tx: transactionHash };
      } else if (eventName === "SessionEnded") {
        store.data.revoked[sid] ??= now();
        if (S[sid]) Object.assign(S[sid], { ended: true, reason: Number(E.reason), refund6: E.refund6.toString(), endTx: transactionHash });
      } else if (eventName === "Extended") { if (S[sid]) S[sid].expiresAt = Number(E.expiresAt); }
      else if (eventName === "ToppedUp") { if (S[sid]) S[sid].toppedUp6 = (BigInt(S[sid].toppedUp6 ?? "0") + E.amount6).toString(); }
      else if (eventName === "RevokedAll") {
        for (const [k, s] of Object.entries(S)) {
          if (s.vault === vault && !s.ended && (blk == null || s.openedBlock == null || s.openedBlock <= blk)) {
            Object.assign(s, { ended: true, reason: 4 });
            store.data.revoked[k] ??= now();
          }
        }
      }
    }
  }
  const expectOne = (events, name, pred, txHash) => {
    const n = events.filter((e) => e.eventName === name && pred(e.args)).length;
    if (n !== 1) throw httpError(502, "settlement_event", `expected one ${name}, found ${n} (tx ${txHash})`, { txHash });
  };
  // the event each relayed op must leave (only where the successor source names it unambiguously)
  const OP_EVENT = { topUp: "ToppedUp", topUpWithAuthorization: "ToppedUp", extend: "Extended", terminate: "SessionEnded",
    close: "SessionEnded", revokeAll: "RevokedAll" };

  const FINISH = {
    execute(rc, m) {
      const intent = decodeIntent(m.args);
      const nonce = BigInt(m.nonce), fee = BigInt(m.fee);
      const settlement = settle(rc, { vault: m.vault, sid: m.sid, nonce, args: m.args, fee, intent });
      const list = (store.data.fundingOps[m.sid] ??= []);
      const tx = rc.transactionHash.toLowerCase();
      if (!list.some((o) => o.tx === tx && o.nonce === m.nonce)) {
        list.push({ nonce: m.nonce, action: ACTION_GAS_FUND, amount6: settlement.actual.usdcSpent6.toString(),
          fee6: m.fee, maxUsdcIn6: intent.maxUsdcIn6.toString(), refund6: settlement.refund6.toString(),
          ethOut: intent.ethOut.toString(), deployment: intent.deployment, holder: intent.expectedOwner,
          tx, block: Number(rc.blockNumber), vault: m.vault });
        if (list.length > 200) list.splice(0, list.length - 200);
      }
      return { txHash: tx, block: Number(rc.blockNumber), vault: m.vault, sid: m.sid, settlement };
    },
    open(rc, m) {
      const events = vaultEvents(rc.logs, m.vault);
      expectOne(events, "SessionOpened", (a) => a.sid.toLowerCase() === m.sid, rc.transactionHash);
      foldVault(events, m.vault);
      store.data.fundingVaults[m.vault] = m.owner;
      return { txHash: rc.transactionHash.toLowerCase(), block: Number(rc.blockNumber), vault: m.vault, sid: m.sid };
    },
    owner(rc, m) {
      const events = vaultEvents(rc.logs, m.vault);
      const want = OP_EVENT[m.op];
      if (want === "RevokedAll") expectOne(events, want, () => true, rc.transactionHash);
      else if (want) expectOne(events, want, (a) => a.sid.toLowerCase() === m.sid, rc.transactionHash);
      foldVault(events, m.vault);
      if (m.op === "revokeAll") {
        // from here a session of this vault passes only from a later epoch (the in-flight window ends)
        const r = vaultRevocation(m.vault) ?? { at: now() };
        store.data.revokedVaults[m.vault] = { ...r, block: Number(rc.blockNumber), successorEpoch: m.epoch };
      }
      return { txHash: rc.transactionHash.toLowerCase(), block: Number(rc.blockNumber), vault: m.vault, op: m.op };
    },
    end(rc, m) {
      const events = vaultEvents(rc.logs, m.vault);
      expectOne(events, "SessionEnded", (a) => a.sid.toLowerCase() === m.sid, rc.transactionHash);
      foldVault(events, m.vault);
      const ev = events.find((e) => e.eventName === "SessionEnded");
      return { txHash: rc.transactionHash.toLowerCase(), block: Number(rc.blockNumber), refund6: ev.args.refund6 };
    },
  };

  // ---- GET /funding/config ------------------------------------------------------------------------------------------
  async function config() {
    const P = await readPins();
    return { enabled: true, chainId: FUNDING_CHAIN_ID, pinnedBlock: P.block, factory: A.factory, implementation: A.implementation,
      adapter: A.adapter, legacyFactory: A.legacyFactory, quoter: A.quoter, feeTiers: [...M.feeTiers], maxSlippageBps: M.maxSlippageBps,
      adapterMaxEthOut: P.adapterMaxEthOut, relayer: R, notAfter: M.notAfter, action: ACTION_GAS_FUND,
      open: { enabled: ownerAllowed, why: ownerWhy }, owner: { enabled: ownerAllowed, ops: ownerAllowed ? [...OWNER_OPS] : [], why: ownerWhy },
      apiScopes: { enabled: false, why: "verifyApiRequest does not serve successor sessions" },
      note: "additive successor; it does not replace the address book's sessionVaultFactory or any original vault" };
  }

  // ---- POST /funding/quote ------------------------------------------------------------------------------------------
  async function quote(body) {
    exactKeys(body, ["vault", "sid", "deployment", "ethOut", "feeTier"], "quote", ["lane"]);
    const vaultIn = address(body.vault, "vault");
    const sid = hex32(body.sid, "sid");
    const deployment = hex32(body.deployment, "deployment");
    const ethOut = uint(body.ethOut, 96, "ethOut");
    const tier = Number(uint(body.feeTier, 24, "feeTier"));
    const lane = body.lane === undefined ? 0n : uint(body.lane, 192, "lane");
    if (ethOut === 0n) throw httpError(400, "bad_request", "ethOut must be positive");
    if (!M.feeTiers.includes(tier)) throw httpError(400, "fee_tier_not_pinned", `tier ${tier} is not pinned by the activation manifest`);
    refuseRevoked(vaultIn, sid);
    const P = await readPins();
    const B = P.block;
    const { vault, owner } = await fundingVault(vaultIn, P);
    const st = await sessionAt(vault, sid, B);
    refuseRevokedAt(vault, sid, st);
    const { s, policy } = st;
    if (((BigInt(s.actions) >> BigInt(ACTION_GAS_FUND)) & 1n) === 0n) throw httpError(403, "not_allowed", "gas.fund is not granted to this session");
    if (policy.maxGasUsdc6 === 0n || policy.maxUsdcPerEth6 === 0n || policy.maxEthWei === 0n) throw httpError(403, "not_allowed", "this session has no gas.fund policy");
    if (ethOut > policy.maxEthWei) throw httpError(409, "quote_exceeds_grant", `ethOut exceeds the grant's maxEthPerOp ${policy.maxEthWei}`);
    if (ethOut > P.adapterMaxEthOut) throw httpError(409, "quote_exceeds_adapter", `ethOut exceeds the adapter's maxEthOut ${P.adapterMaxEthOut}`);
    const seq = BigInt(await step(() => rd(vault, vaultAbi, "seqOf", [sid, lane], B)));
    const { periodSpent6 } = spendGuards(s, P.timestamp, seq);
    const { holder, kind } = await holderOf(deployment, vault, owner, B);
    const amountIn6 = await quoteIn(ethOut, tier, B);
    const maxFee6 = BigInt(s.maxFee6);
    const feeRaw = await policyCall("fee", { phase: "quote", chainId: FUNDING_CHAIN_ID, block: B, vault, sid, deployment, ethOut,
      feeTier: tier, amountIn6, maxFee6 });
    let fee6;
    try { fee6 = uint(feeRaw, 128, "quotePolicy.fee"); } catch { throw httpError(503, "quote_policy_failed", "the host quote policy returned no integer fee"); }
    if (fee6 > maxFee6) throw httpError(409, "fee_exceeds_grant", `the relay fee ${fee6} exceeds the grant's maxFeePerOp ${maxFee6}`);
    const slipped = (amountIn6 * BigInt(10_000 + M.maxSlippageBps) + 9_999n) / 10_000n;
    const priceCap = (policy.maxUsdcPerEth6 * ethOut) / 10n ** 18n;
    let maxUsdcIn6 = slipped;
    if (maxUsdcIn6 > policy.maxGasUsdc6) maxUsdcIn6 = policy.maxGasUsdc6;
    if (maxUsdcIn6 > priceCap) maxUsdcIn6 = priceCap;
    if (maxUsdcIn6 < amountIn6) throw httpError(409, "quote_exceeds_grant", `the pool needs ${amountIn6}, the grant allows at most ${maxUsdcIn6}`);
    const total = maxUsdcIn6 + fee6;
    if (total > BigInt(s.balance6)) throw httpError(409, "quote_exceeds_balance", `needs ${total}, the session holds ${s.balance6}`);
    const left = BigInt(s.perPeriod6) > periodSpent6 ? BigInt(s.perPeriod6) - periodSpent6 : 0n;
    if (total > left) throw httpError(409, "quote_exceeds_period", `needs ${total}, ${left} left this period`);
    const deadline = P.timestamp + M.deadlineSec;
    const intent = { payer: vault, deployment, expectedOwner: holder, ethOut, maxUsdcIn6, fee: tier, deadline };
    const args = encodeIntent(intent);
    return { chainId: FUNDING_CHAIN_ID, pinnedBlock: B, vault, sid, action: ACTION_GAS_FUND, nonce: (lane << 64n) | seq, args,
      argsHash: keccak256(args), fee: fee6, deadline, intent, holderKind: kind,
      maximum: { maxUsdcIn6, fee6, totalMaximum6: total },
      quote: { quoter: A.quoter, feeTier: tier, amountIn6, block: B, slippageBps: M.maxSlippageBps } };
  }

  // ---- POST /funding/execute ----------------------------------------------------------------------------------------
  async function execute(body) {
    exactKeys(body, ["vault", "sid", "nonce", "action", "args", "fee", "deadline", "x", "y", "r", "s"], "execute");
    const action = Number(uint(body.action, 8, "action"));
    if (action === RETIRED_ACTION) throw httpError(400, "bad_action", "action 9 is retired");
    if (action !== ACTION_GAS_FUND) throw httpError(400, "bad_action", `this route executes action ${ACTION_GAS_FUND} (gas.fund) only`);
    const sid = hex32(body.sid, "sid");
    const vaultIn = address(body.vault, "vault");
    const nonce = uint(body.nonce, 256, "nonce");
    const fee = uint(body.fee, 256, "fee");
    const deadline = uint(body.deadline, 64, "deadline");
    const x = uint(body.x, 256, "x"), y = uint(body.y, 256, "y");
    const r = hex32(body.r, "r"), sv = hex32(body.s, "s");
    const args = hexBytes(body.args, "args", INTENT_BYTES);
    const intent = decodeIntent(args);
    if (intent.payer !== vaultIn) throw httpError(400, "wrong_payer", "intent.payer must be exactly the executing vault");
    if (!M.feeTiers.includes(intent.fee)) throw httpError(400, "fee_tier_not_pinned", `tier ${intent.fee} is not pinned by the activation manifest`);
    if (deadline > intent.deadline) throw httpError(400, "bad_deadline", "the call deadline is after the intent deadline");
    if (nonce >> 256n !== 0n) throw httpError(400, "bad_request", "nonce out of range");
    // the host's shared off-chain revocation (sign-out, terminate, revokeAll in flight) before anything is read or sent
    refuseRevoked(vaultIn, sid);

    const P = await readPins();
    const B = P.block;
    const { vault } = await fundingVault(vaultIn, P);
    const st = await sessionAt(vault, sid, B);
    refuseRevokedAt(vault, sid, st);
    spendGuards(st.s, P.timestamp, nonce & UINT64_MAX);
    if (intent.ethOut > P.adapterMaxEthOut) throw httpError(409, "quote_exceeds_adapter", "intent.ethOut exceeds the adapter's maxEthOut");
    if (deadline < P.timestamp) throw httpError(409, "expired", "the call deadline has passed");
    if (intent.deadline > P.timestamp + MAX_DEADLINE_WINDOW) throw httpError(400, "bad_deadline", "the intent deadline is more than 900s ahead");
    const amountIn6 = await quoteIn(intent.ethOut, intent.fee, B);
    if (amountIn6 > intent.maxUsdcIn6) throw httpError(409, "quote_moved", `the pool now needs ${amountIn6}, above the signed maximum ${intent.maxUsdcIn6}; re-quote`);
    const ok = await policyCall("accept", { phase: "execute", chainId: FUNDING_CHAIN_ID, block: B, vault, sid, intent, fee6: fee, amountIn6 });
    if (ok !== true) throw httpError(402, "policy_refused", "the host quote policy refused this fee/maximum; re-quote");

    const execArgs = [sid, nonce, ACTION_GAS_FUND, args, fee, deadline, x, y, r, sv];
    await presimulate(vault, vaultAbi, "execute", execArgs, B);
    refuseRevoked(vault, sid);
    const rc = await simulateAndSend({ to: vault, abi: vaultAbi, functionName: "execute", args: execArgs,
      label: `funding gas.fund ${sid.slice(0, 10)}` });
    return completed("execute", rc, { vault, sid, nonce: nonce.toString(), args, fee: fee.toString() });
  }

  function settle(rc, { vault, sid, nonce, args, fee, intent }) {
    if (!rc || rc.status !== "success") throw httpError(409, "reverted", `gas.fund did not succeed on chain (${rc?.transactionHash ?? "no receipt"})`);
    const ops = [], funded = [], adapted = [];
    const bad = (code, m) => { throw httpError(502, code, `${m} (tx ${rc.transactionHash}); the funding index was not updated`); };
    for (const l of Array.isArray(rc.logs) ? rc.logs : []) {
      let a;
      try { a = getAddress(l.address); } catch { continue; }
      if (a !== vault && a !== A.adapter) continue;
      let ev;
      try { ev = strictEvent(a === vault ? vaultAbi : adapterAbi, l); } catch (e) { bad("settlement_noncanonical_event", `a ${a === vault ? "vault" : "adapter"} log is not canonical: ${msg(e)}`); }
      if (a === vault && ev.eventName === "SessionOp" && ev.args.sid.toLowerCase() === sid && ev.args.nonce === nonce) ops.push(ev.args);
      else if (a === vault && ev.eventName === "GasFunded" && ev.args.sid.toLowerCase() === sid) funded.push(ev.args);
      else if (a === A.adapter && ev.eventName === "GasFunded" && ev.args.deployment.toLowerCase() === intent.deployment) adapted.push(ev.args);
    }
    if (ops.length !== 1) bad("settlement_session_op", `expected one SessionOp for this sid/nonce, found ${ops.length}`);
    if (funded.length !== 1) bad("settlement_gas_funded", `expected one vault GasFunded for this sid, found ${funded.length}`);
    if (adapted.length !== 1) bad("settlement_adapter", `expected one adapter GasFunded for this deployment, found ${adapted.length}`);
    const op = ops[0], gf = funded[0], ad = adapted[0];
    if (Number(op.action) !== ACTION_GAS_FUND) bad("settlement_action", "SessionOp is not action 10");
    if (op.argsHash.toLowerCase() !== keccak256(args)) bad("settlement_args", "SessionOp.argsHash differs from the signed args");
    if (op.fee6 !== fee || gf.fee6 !== fee) bad("settlement_fee", "the signed fee, SessionOp.fee6 and GasFunded.fee6 differ");
    if (getAddress(gf.relayer) !== R) bad("settlement_relayer", "GasFunded.relayer is not this relayer");
    if (gf.deployment.toLowerCase() !== intent.deployment || getAddress(gf.holder) !== intent.expectedOwner) bad("settlement_scope", "GasFunded deployment/holder differ from the intent");
    if (gf.ethOut !== intent.ethOut || gf.maxUsdcIn6 !== intent.maxUsdcIn6) bad("settlement_intent", "GasFunded ethOut/maxUsdcIn6 differ from the intent");
    const used = gf.usdcSpent6;
    if (used === 0n || used > intent.maxUsdcIn6) bad("settlement_actual", `actual ${used} is outside 1..${intent.maxUsdcIn6}`);
    if (op.amount6 !== used) bad("settlement_amount", `SessionOp.amount6 ${op.amount6} is not the actual debit ${used}`);
    // exactly abi.encode(uint256, uint256): 64 bytes, no trailing bytes, canonical re-encoding
    if (typeof op.result !== "string" || op.result.length !== 2 + 2 * RESULT_BYTES) bad("settlement_result", `SessionOp.result is not exactly ${RESULT_BYTES} bytes`);
    const [resUsed, refund] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], op.result);
    if (encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [resUsed, refund]).toLowerCase() !== op.result.toLowerCase()) bad("settlement_result", "SessionOp.result is not canonical");
    if (resUsed !== used || used + refund !== intent.maxUsdcIn6) bad("settlement_result", "SessionOp.result does not reconcile actual + refund = maximum");
    if (getAddress(ad.payer) !== vault || getAddress(ad.owner) !== intent.expectedOwner || Number(ad.fee) !== intent.fee
      || ad.ethOut !== intent.ethOut || ad.usdcSpent6 !== used || ad.maxUsdcIn6 !== intent.maxUsdcIn6) {
      bad("settlement_adapter", "the adapter's GasFunded does not match the vault's");
    }
    return Object.freeze({
      maximum: Object.freeze({ maxUsdcIn6: intent.maxUsdcIn6, fee6: fee, totalMaximum6: intent.maxUsdcIn6 + fee }),
      actual: Object.freeze({ usdcSpent6: used, fee6: fee, totalDebit6: used + fee }),
      refund6: refund, ethOut: intent.ethOut, relayer: R, deployment: intent.deployment, holder: intent.expectedOwner,
    });
  }

  // ---- POST /funding/open (host-gated) ------------------------------------------------------------------------------
  function parseGrant(g) {
    plain(g, "grant");
    const missingGas = GAS_LIMIT_FIELDS.filter((k) => !has(g, k) || g[k] === undefined);
    if (missingGas.length) {
      throw httpError(400, "grant_missing_gas_limits", `grant lacks ${missingGas.join(", ")}: an original grant is never reused or widened`);
    }
    exactKeys(g, GRANT_COMPONENTS.map((c) => c.name), "grant");
    const out = {};
    for (const { name, type } of GRANT_COMPONENTS) {
      const v = g[name];
      if (type === "string") {
        if (typeof v !== "string" || v.length > 200) throw httpError(400, "bad_request", `grant.${name} must be a short string`);
        out[name] = v;
      } else if (type === "string[]") {
        if (!Array.isArray(v) || v.length > 32 || v.some((s) => typeof s !== "string" || s.length > 200)) throw httpError(400, "bad_request", `grant.${name} must be a string list`);
        out[name] = [...v];
      } else if (type === "bytes32") out[name] = hex32(v, `grant.${name}`);
      else if (/^uint\d+$/.test(type)) out[name] = uint(v, Number(type.slice(4)), `grant.${name}`);
      else throw httpError(500, "relay", `unhandled Grant field type ${type}`);
    }
    // successor sessions are not served by verifyApiRequest: this relay opens none that claims an API scope
    if (out.actions.some((action) => action.startsWith("api."))) {
      throw httpError(400, "api_scopes_unsupported", "successor sessions get no api.* scope through this relay");
    }
    return out;
  }

  async function open(body, ctx) {
    if (!ownerAllowed) throw httpError(503, "funding_open_disabled", ownerWhy);
    exactKeys(body, ["owner", "grant", "ownerSig"], "open", ["deposit"]);
    const owner = address(body.owner, "owner");
    if (ctx?.screenAddress?.(owner)?.result === "hit") throw httpError(451, "refused", "this address cannot be served");
    rateOwner(owner, "open");
    const g = parseGrant(body.grant);
    const sig = hexBytes(body.ownerSig, "ownerSig", 2048);
    const P = await readPins();
    const B = P.block;
    const vault = predictVault(A.factory, A.implementation, owner);
    if (getAddress(await step(() => rd(A.factory, factoryAbi, "vaultFor", [owner], B))) !== vault) throw httpError(409, "vault_identity", "factory.vaultFor(owner) differs from the CREATE2 prediction");
    const code = await step(() => pc.getCode({ address: vault, blockNumber: B }));
    if (code && code !== "0x") {
      if (String(code).toLowerCase() !== cloneRuntime(A.implementation)) throw httpError(409, "vault_identity", "the predicted vault holds foreign code");
      if (!(await step(() => rd(A.factory, factoryAbi, "isVault", [vault], B)))) throw httpError(409, "vault_identity", "the predicted vault is not registered by the factory");
      if (getAddress(await step(() => rd(vault, vaultAbi, "owner", [], B))) !== owner) throw httpError(409, "vault_identity", "the predicted vault has another owner");
    }
    let fn, args;
    if (g.budget > 0n) {
      const d = body.deposit;
      exactKeys(d, ["validAfter", "validBefore", "sig"], "deposit");
      fn = "openWithDepositFor";
      args = [owner, g, sig, uint(d.validAfter, 256, "deposit.validAfter"), uint(d.validBefore, 256, "deposit.validBefore"), hexBytes(d.sig, "deposit.sig", 2048)];
    } else {
      if (body.deposit !== undefined) throw httpError(400, "bad_request", "a zero-budget grant takes no deposit");
      fn = "openFor";
      args = [owner, g, sig];
    }
    await presimulate(A.factory, factoryAbi, fn, args, B);
    const rc = await simulateAndSend({ to: A.factory, abi: factoryAbi, functionName: fn, args, label: `funding ${fn} ${owner.slice(0, 8)}`,
      afterSimulate: () => rateOwner(owner, "open", true) });
    return completed("open", rc, { vault, owner, sid: sessionIdOf(vault, g.sessionKey, g.grantNonce) });
  }

  // ---- POST /funding/owner ------------------------------------------------------------------------------------------
  /** The original /owner handler's op set and argument shapes, typed by the SUCCESSOR artifact ABI. No signature is
   *  checked here: the contract is the only verifier (domain version 2). */
  function ownerArgs(op, body) {
    const a = body.args;
    plain(a, "args");
    const sig = () => hexBytes(body.sig, "sig", 2048);
    const opNonce = () => {
      const n = hex32(a.opNonce, "opNonce");
      if (n === ZERO_HASH) throw httpError(400, "bad_request", "opNonce is zero");
      return n;
    };
    const sb = () => uint(a.signBefore, 64, "signBefore");
    const only = (keys) => { exactKeys(a, keys, "args"); };
    const sidOf = () => hex32(a.sessionId, "sessionId");
    const noSig = () => { if (body.sig !== undefined) throw httpError(400, "bad_request", `${op} takes no top-level sig`); };
    switch (op) {
      case "topUp": only(["sessionId", "amount", "opNonce", "signBefore"]);
        return { sid: sidOf(), args: [sidOf(), uint(a.amount, 256, "amount"), opNonce(), sb(), sig()] };
      case "topUpWithAuthorization": only(["sessionId", "amount", "opNonce", "validAfter", "validBefore", "sig"]); noSig();
        return { sid: sidOf(), args: [sidOf(), uint(a.amount, 256, "amount"), opNonce(), uint(a.validAfter, 256, "validAfter"),
          uint(a.validBefore, 64, "validBefore"), hexBytes(a.sig, "args.sig", 2048)] };
      case "extend": only(["sessionId", "expiresAt", "opNonce", "signBefore"]);
        return { sid: sidOf(), args: [sidOf(), uint(a.expiresAt, 64, "expiresAt"), opNonce(), sb(), sig()] };
      case "terminate": only(["sessionId", "opNonce", "signBefore"]);
        return { sid: sidOf(), args: [sidOf(), opNonce(), sb(), sig()] };
      case "revokeAll": only(["withdraw", "opNonce", "signBefore"]);
        return { sid: null, args: [bool(a.withdraw, "withdraw"), opNonce(), sb(), sig()] };
      case "withdraw": only(["amount", "opNonce", "signBefore"]);
        return { sid: null, args: [uint(a.amount, 256, "amount"), opNonce(), sb(), sig()] };
      case "promote": only(["deployment", "app", "publisher", "appRef", "configCid", "versionLabel", "isPublic", "opNonce", "signBefore"]);
        return { sid: null, args: [hex32(a.deployment, "deployment"), str(a.app, "app"), address(a.publisher, "publisher"), str(a.appRef, "appRef"),
          str(a.configCid, "configCid"), str(a.versionLabel, "versionLabel"), bool(a.isPublic, "isPublic"), opNonce(), sb(), sig()] };
      case "adopt": case "setEnvironment": only(["deployment", "environment", "opNonce", "signBefore"]);
        return { sid: null, args: [hex32(a.deployment, "deployment"), str(a.environment, "environment"), opNonce(), sb(), sig()] };
      case "release": only(["deployment", "to", "opNonce", "signBefore"]);
        return { sid: null, args: [hex32(a.deployment, "deployment"), address(a.to, "to"), opNonce(), sb(), sig()] };
      case "close": only(["sessionId"]); noSig();
        return { sid: sidOf(), args: [sidOf()] };
      default: throw httpError(500, "relay", `unhandled owner op ${op}`);
    }
  }

  async function ownerOp(body, ctx) {
    if (!ownerAllowed) throw httpError(503, "funding_owner_disabled", ownerWhy);
    exactKeys(body, ["owner", "vault", "op", "args"], "owner", ["sig"]);
    const owner = address(body.owner, "owner");
    const vaultIn = address(body.vault, "vault");
    const op = body.op;
    if (op === "ownerCall") throw httpError(400, "owner_direct_only", "ownerCall is msg.sender == owner only; submit it from your wallet");
    if (typeof op !== "string" || !OWNER_OPS.includes(op)) throw httpError(400, "bad_request", "unknown owner operation");
    if (op === "topUpWithAuthorization" && ctx?.screenAddress?.(owner)?.result === "hit") throw httpError(451, "refused", "this address cannot be served");
    const { sid, args } = ownerArgs(op, body);
    if (op !== "close") rateOwner(owner, op); // unsigned close must not consume an owner's authenticated quota
    const P = await readPins();
    const B = P.block;
    const { vault, owner: real } = await fundingVault(vaultIn, P);
    if (real !== owner) throw httpError(403, "not_owner", "that vault belongs to someone else");
    const epoch = op === "revokeAll" ? BigInt(await step(() => rd(vault, vaultAbi, "epoch", [], B))).toString() : null;
    // the REAL vault checks the domain-2 owner signature / EIP-3009 authorization first; a forged op stops here
    await presimulate(vault, vaultAbi, op, args, B);
    const afterSimulate = () => {
      // revocation first (only now: the host's simulation accepted the signature), then the quota count
      if (op === "terminate" || op === "close") store.data.revoked[sid] = now();
      if (op === "revokeAll") {
        store.data.revokedVaults[vault] = { at: now(), block: null, successorEpoch: epoch };
        for (const [k, s] of Object.entries(store.data.fundingSessions)) if (s.vault === vault && !s.ended) store.data.revoked[k] = now();
      }
      if (op === "terminate" || op === "close" || op === "revokeAll") flush();
      if (op !== "close") rateOwner(owner, op, true);
    };
    const rc = await simulateAndSend({ to: vault, abi: vaultAbi, functionName: op, args, label: `funding ${op} ${vault.slice(0, 8)}`, afterSimulate });
    return completed("owner", rc, { vault, owner, op, sid, epoch });
  }

  // ---- POST /funding/end --------------------------------------------------------------------------------------------
  async function end(body) {
    if (!ownerAllowed) throw httpError(503, "funding_owner_disabled", ownerWhy);
    exactKeys(body, ["vault", "sid", "deadline", "x", "y", "r", "s"], "end");
    const sid = hex32(body.sid, "sid");
    const args = [sid, uint(body.deadline, 64, "deadline"), uint(body.x, 256, "x"), uint(body.y, 256, "y"), hex32(body.r, "r"), hex32(body.s, "s")];
    const P = await readPins();
    const { vault } = await fundingVault(body.vault, P);
    // the REAL vault checks the session key's domain-2 SessionEnd signature first
    await presimulate(vault, vaultAbi, "terminateBySession", args, P.block);
    const rc = await simulateAndSend({ to: vault, abi: vaultAbi, functionName: "terminateBySession", args, label: `funding end ${sid.slice(0, 10)}`,
      afterSimulate: () => { store.data.revoked[sid] = now(); flush(); } });
    return completed("end", rc, { vault, sid });
  }

  // ---- views and reconciliation -------------------------------------------------------------------------------------
  async function sessionView(vaultHex, sidHex) {
    const sid = hex32(sidHex, "sid");
    const P = await readPins();
    const { vault } = await fundingVault(getAddress(vaultHex.toLowerCase()), P);
    const st = await sessionAt(vault, sid, P.block);
    const rv = revoked(sid) || inflightRevoked(vault) || epochRevoked(vault, st.s.epoch);
    const live = st.live && BigInt(st.s.epoch) === st.vaultEpoch && !rv && !store.data.fundingSessions[sid]?.ended;
    return { vault, sid, pinnedBlock: P.block, state: { ...st.s, live }, policy: st.policy, vaultEpoch: st.vaultEpoch, revoked: rv,
      index: store.data.fundingSessions[sid] ?? null, ops: store.data.fundingOps[sid] ?? [] };
  }
  function ownerView(ownerHex) {
    const owner = getAddress(ownerHex.toLowerCase());
    const vault = predictVault(A.factory, A.implementation, owner);
    const sessions = Object.entries(store.data.fundingSessions).filter(([, s]) => s.vault === vault)
      .map(([sid, s]) => ({ sid, ...s, revoked: revoked(sid), ops: (store.data.fundingOps[sid] ?? []).length }));
    const pending = Object.entries(store.data.fundingPending).filter(([, p]) => p.meta?.vault === vault).map(([txHash, p]) => ({ txHash, kind: p.kind, at: p.at, reason: p.reason }));
    return { owner, vault, indexed: Boolean(store.data.fundingVaults[vault]), sessions, pending, revokedVault: vaultRevocation(vault) };
  }
  async function reconcile(hash) {
    const h = hash.toLowerCase();
    const p = store.data.fundingPending[h];
    if (!p) throw httpError(404, "not_pending", "this relay has no pending successor transaction with that hash");
    let rc;
    try { rc = await pc.getTransactionReceipt({ hash: h }); } catch {
      throw httpError(202, "pending_reconciliation", "no receipt yet; nothing is resubmitted", { txHash: h });
    }
    if (typeof rc?.transactionHash !== "string" || rc.transactionHash.toLowerCase() !== h) {
      throw httpError(202, "pending_reconciliation", "receipt does not match the requested transaction; nothing is resubmitted", { txHash: h });
    }
    return completed(p.kind, rc, p.meta);
  }

  async function route(method, path, body, ctx) {
    if (!M) throw httpError(503, "funding_disabled", why);
    let mm;
    if (method === "GET" && path === "/funding/config") return config();
    if (method === "POST" && path === "/funding/quote") return quote(body);
    if (method === "POST" && path === "/funding/execute") return execute(body);
    if (method === "POST" && path === "/funding/open") return open(body, ctx);
    if (method === "POST" && path === "/funding/owner") return ownerOp(body, ctx);
    if (method === "POST" && path === "/funding/end") return end(body);
    if (method === "GET" && (mm = /^\/funding\/session\/(0x[0-9a-fA-F]{40})\/(0x[0-9a-fA-F]{64})$/.exec(path))) return sessionView(mm[1], mm[2]);
    if (method === "GET" && (mm = /^\/funding\/owner\/(0x[0-9a-fA-F]{40})$/.exec(path))) return ownerView(mm[1]);
    if (method === "GET" && (mm = /^\/funding\/tx\/(0x[0-9a-fA-F]{64})$/.exec(path))) return reconcile(mm[1]);
    throw httpError(404, "not_found", "no such funding endpoint");
  }

  return Object.freeze({ route, enabled: Boolean(M), why, ownerEnabled: Boolean(M) && ownerAllowed, openEnabled: Boolean(M) && ownerAllowed });
}
