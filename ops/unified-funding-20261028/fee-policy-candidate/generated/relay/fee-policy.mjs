// UNREVIEWED SOURCE (unified-funding fee-policy-r1). Its author executed nothing: no node, no tests, no network.
//
// The injectable quote policy for the FundingSessionVault successor's gas.fund (action 10) and the transaction
// ENVELOPE the host queue must enforce for the call it prices. Nongas actions keep their original fee path untouched
// (sessions.mjs feeFor); nothing here is used by them.
//
//   quote(ctx)     phase "quote", BEFORE any session signature exists. Prices the operator's CAPS, not an estimate:
//                    gasLimit x maxFeePerGas                       (strict for any tx inside the envelope)
//                  + GasPriceOracle.getL1FeeUpperBound(arg(S))     (S = the operator's maximum signed size)
//                  + GasPriceOracle.getOperatorFee(gasLimit)
//                  all at the route's pinned block (by its hash), on Base 8453, with the oracle proxy, its EIP-1967
//                  implementation, the ETH/USD feed proxy and its aggregator pinned by address and runtime code hash,
//                  times a live Chainlink ETH/USD answer (decimals() and latestRoundData() checked), plus a bounded
//                  margin, rounded UP once. Returns { fee6, detail } (every component and assumption).
//   fee(ctx)       { fee6 } of quote(ctx), only when the caller states envelopeEnforced === true. An unpatched route
//                  never says so, so it gets no price (fail closed).
//   accept(ctx)    phase "execute": the signed (intent, fee6) must match a quote this policy issued under the SAME
//                  config (a changed cap invalidates outstanding quotes: no stale over- or under-charge), unexpired, and
//                  fee6 must still cover the zero-margin worst case at the execute block.
//   envelope(ctx)  phase "envelope", AFTER the signature: the exact calldata is decoded and compared with the accepted
//                  quote, estimated at the accepted block (a real signature: a revert refuses), required to fit the gas
//                  cap under the queue's own rule, and sized; returns the frozen envelope the queue enforces on EVERY
//                  broadcast (gas == gasLimit, fee/tip <= caps, signed size <= cap, <= maxAttempts, none after the
//                  call deadline). The fee is fixed by the signature; the envelope only ever narrows what is sent.
//
// The fee is CONSERVATIVE CAPPED COMPENSATION for the relayer's worst-case outlay under the envelope. It is not the
// receipt cost and nothing is refunded when the actual cost is lower. L1 and operator fee terms are observations at the
// pinned block, not guarantees at inclusion: drift is the relayer's risk, never the session's.
//
// Import path: relative to this stage directory. prepare.py rewrites it to the bare specifier "viem" in generated/.
import { decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256 }
  from "viem";

// =====================================================================================================================
// Constants
// =====================================================================================================================

export const QUOTE_POLICY_INTERFACE = "enclave-gasfund-quote-policy/v2";
export const ENVELOPE_GUARD = "enclave-txqueue-envelope/v1";
export const CONFIG_SCHEMA = "enclave-gasfund-fee-policy-r1";
export const CHAIN_ID = 8453n;
export const ACTION_GAS_FUND = 10;
export const INTENT_BYTES = 224;
/** vault.execute(bytes32,uint256,uint8,bytes,uint256,uint64,uint256,uint256,bytes32,bytes32) with 224-byte args:
 *  selector + ten head words + the bytes length word + 224 bytes (a multiple of 32: no padding). Always 580. */
export const EXECUTE_CALLDATA_BYTES = 4 + 32 * 11 + INTENT_BYTES;
/** GasPriceOracle.getL1FeeUpperBound(_unsignedTxSize) adds 68 for the signature (the reviewed cold-funding constant). */
export const ORACLE_SIGNATURE_ALLOWANCE = 68;
export const MAX_MARGIN_BPS = 5_000n;
export const MAX_FEED_DECIMALS = 18n;
export const MAX_FEED_AGE_SEC = 3_600n;
export const MAX_SIGNED_BYTES = 4_096;
export const MAX_ATTEMPTS = 5;
export const REPLACEMENT_FLOOR_BPS = 1_000n;      // geth/op-geth txpool: a same-nonce replacement must raise both by 10%
const MAX_CLOCK_SKEW_SEC = 60n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const EMPTY_CODEHASH = keccak256("0x");
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** host-queue-r1 TxQueue._send's gas rule, verbatim: estimate x 1.25 + 20 000. An enveloped send must fit it. */
export const queueGasFor = (estimate) => (BigInt(estimate) * 125n) / 100n + 20_000n;

const fn = (name, inputs, outputs, stateMutability = "view") => ({ type: "function", name, stateMutability,
  inputs: inputs.map((type) => ({ name: "", type })), outputs: outputs.map((type) => ({ name: "", type })) });
export const ORACLE_ABI = Object.freeze([fn("isFjord", [], ["bool"]), fn("isIsthmus", [], ["bool"]),
  fn("getL1FeeUpperBound", ["uint256"], ["uint256"]), fn("getOperatorFee", ["uint256"], ["uint256"])]);
export const FEED_ABI = Object.freeze([fn("decimals", [], ["uint8"]), fn("description", [], ["string"]),
  fn("aggregator", [], ["address"]), fn("latestRoundData", [], ["uint80", "int256", "uint256", "uint256", "uint80"])]);
export const EXECUTE_ABI = Object.freeze([{ type: "function", name: "execute", stateMutability: "nonpayable",
  inputs: [["sid", "bytes32"], ["nonce", "uint256"], ["action", "uint8"], ["args", "bytes"], ["fee", "uint256"],
    ["deadline", "uint64"], ["x", "uint256"], ["y", "uint256"], ["r", "bytes32"], ["sv", "bytes32"]]
    .map(([name, type]) => ({ name, type })), outputs: [{ name: "result", type: "bytes" }] }]);
const INTENT_PARAMS = Object.freeze([{ type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" },
  { type: "uint256" }, { type: "uint24" }, { type: "uint64" }]);

// =====================================================================================================================
// Errors and strict parsing
// =====================================================================================================================

/** Every refusal carries a stable machine code. Nothing here returns a price after a refusal. */
export class FeePolicyError extends Error {
  constructor(code, message, detail) {
    super(`${code}: ${message}`);
    this.name = "FeePolicyError";
    this.code = code;
    this.detail = detail;
  }
}
const fail = (code, message, detail) => { throw new FeePolicyError(code, message, detail); };
const msg = (e) => String(e?.shortMessage || e?.message || e).slice(0, 200);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const utf8 = new TextEncoder();
const canonical = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

function deepFreeze(o) {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function uint(v, bits, name, code = "bad_config") {
  let n;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number" && Number.isSafeInteger(v)) n = BigInt(v);
  else if (typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v)) n = BigInt(v);
  else fail(code, `${name} must be a non-negative integer (bigint, safe number or canonical decimal string)`);
  if (n < 0n || n >= 1n << BigInt(bits)) fail(code, `${name} is out of range for uint${bits}`);
  return n;
}
function bounded(v, lo, hi, bits, name, code = "bad_config") {
  const n = uint(v, bits, name, code);
  if (n < BigInt(lo) || n > BigInt(hi)) fail(code, `${name} must be ${lo}..${hi}`);
  return n;
}
function address(v, name, code = "bad_config") {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) fail(code, `${name} must be a 20-byte hex address`);
  const body = v.slice(2);
  if (body !== body.toLowerCase() && getAddress(v.toLowerCase()) !== v) fail(code, `${name} has a wrong EIP-55 checksum`);
  if (/^0x0{40}$/.test(v)) fail(code, `${name} is the zero address`);
  return v.toLowerCase();
}
function hex32(v, name, code = "bad_config") {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) fail(code, `${name} must be 32-byte hex`);
  return v.toLowerCase();
}
function codehash(v, name) {
  const h = hex32(v, name);
  if (h !== v) fail("bad_config", `${name} must be lowercase`);
  if (h === ZERO_HASH || h === EMPTY_CODEHASH) fail("bad_config", `${name} is the zero or empty-code hash`);
  return h;
}
function exactKeys(o, keys, name, code = "bad_config") {
  if (o === null || typeof o !== "object" || Array.isArray(o)) fail(code, `${name} must be an object`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) fail(code, `${name} has unknown field(s) ${extra.join(", ")}`);
  const missing = keys.filter((k) => !has(o, k) || o[k] === undefined);
  if (missing.length) fail(code, `${name} is missing ${missing.join(", ")}`);
}
const qty = (v, name) => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) fail("chain_unreadable", `${name} is not a hex quantity`);
  return BigInt(v);
};
const hexOf = (n) => `0x${BigInt(n).toString(16)}`;

// =====================================================================================================================
// Pure arithmetic: integer ceilings, RLP sizes, the L1 oracle argument
// =====================================================================================================================

export function ceilDiv(a, b) {
  if (typeof a !== "bigint" || typeof b !== "bigint" || a < 0n || b <= 0n) fail("arithmetic", "ceilDiv needs a >= 0, b > 0 bigints");
  return (a + b - 1n) / b;
}

/** USDC (6 dp) for `costWei` at a feed answer with `decimals`, times (1 + marginBps/1e4), rounded UP once. */
export function usdc6For(costWei, answer, decimals, marginBps = 0n) {
  if (answer <= 0n) fail("feed_answer_nonpositive", "a non-positive price is never used");
  if (decimals < 0n || decimals > MAX_FEED_DECIMALS) fail("feed_decimals", "decimals out of bounds");
  if (marginBps < 0n || marginBps > MAX_MARGIN_BPS) fail("bad_config", "margin out of bounds");
  return ceilDiv(costWei * answer * (10_000n + marginBps) * 1_000_000n, 10n ** (18n + decimals) * 10_000n);
}

export function byteLength(n) {
  let l = 0;
  for (let x = BigInt(n); x > 0n; x >>= 8n) l++;
  return l;
}
/** RLP length of an unsigned integer (canonical: no leading zeros; 0 is the empty string 0x80). */
export function rlpIntLength(n) {
  const v = BigInt(n);
  if (v < 0n) fail("rlp", "RLP integers are unsigned");
  if (v < 128n) return 1;
  return 1 + byteLength(v);
}
/** RLP length of a byte string of `len` bytes whose first byte is `firstByte` (matters only when len === 1). */
export function rlpStringLength(len, firstByte = 0xff) {
  if (!Number.isSafeInteger(len) || len < 0) fail("rlp", "bad byte-string length");
  if (len === 1 && firstByte < 0x80) return 1;
  if (len <= 55) return 1 + len;
  return 1 + byteLength(len) + len;
}
export function rlpListLength(payload) {
  if (payload <= 55) return 1 + payload;
  return 1 + byteLength(payload) + payload;
}

/** EIP-1559 (type 2) sizes, derived independently of any serializer:
 *  unsigned  = 0x02 || rlp([chainId, nonce, tip, maxFee, gas, to, value, data, accessList=[]])
 *  signedMax = 0x02 || rlp([..., yParity, r, s]) with yParity one byte and r, s at their 32-byte maximum.
 *  Every integer's length is monotone in its value, so maxima of the inputs give the maximum size. */
export function eip1559Sizes({ chainId = CHAIN_ID, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, dataBytes, dataFirstByte = 0xff, value = 0n }) {
  const fields = rlpIntLength(chainId) + rlpIntLength(nonce) + rlpIntLength(maxPriorityFeePerGas) + rlpIntLength(maxFeePerGas)
    + rlpIntLength(gas) + rlpStringLength(20) + rlpIntLength(value) + rlpStringLength(dataBytes, dataFirstByte) + rlpListLength(0);
  const signature = 1 + rlpIntLength((1n << 256n) - 1n) * 2;
  return Object.freeze({ unsigned: 1 + rlpListLength(fields), signedMax: 1 + rlpListLength(fields + signature) });
}

/** op-geth FlzCompressLen: a literal run of r bytes costs r + ceil(r/32); a match never costs more than it covers, so
 *  n bytes never compress to more than n + ceil(n/32). (Derived from the cost structure; root to verify.) */
export const flzStrictUpperBound = (n) => n + Math.ceil(n / 32);
/** GasPriceOracle.getL1FeeUpperBound(a): txSize = a + 68; flz = txSize + txSize/255 + 16 ("covers 99.99% of txs"). */
export const oracleFlzUpperBound = (a) => { const t = a + ORACLE_SIGNATURE_ALLOWANCE; return t + Math.floor(t / 255) + 16; };
/** The argument passed for a transaction of at most `signedBytes` signed bytes: at least signedBytes - 68 (the reviewed
 *  cold-funding rule, so a + 68 covers the signed size), then raised until the oracle's heuristic covers the strict bound. */
export function l1OracleArgument(signedBytes) {
  if (!Number.isSafeInteger(signedBytes) || signedBytes < 1 || signedBytes > MAX_SIGNED_BYTES) fail("size_overflow", "signed size out of bounds");
  let a = Math.max(0, signedBytes - ORACLE_SIGNATURE_ALLOWANCE);
  const need = flzStrictUpperBound(signedBytes);
  while (oracleFlzUpperBound(a) < need) a++;   // each step raises the bound by >= 1: at most `need` steps
  if (a + ORACLE_SIGNATURE_ALLOWANCE < signedBytes) fail("l1_size", "the L1 size undercounts the signed transaction");
  return a;
}

// =====================================================================================================================
// Configuration (operator-supplied; every field explicit; no defaults, no fallbacks)
// =====================================================================================================================

const CONFIG_KEYS = ["schema", "chainId", "notAfter", "maxBlockAgeSec", "quoteTtlSec", "oracle", "feed", "sequencer", "tx", "pricing"];
const ORACLE_KEYS = ["address", "proxyCodehash", "implementation", "implementationCodehash"];
const FEED_KEYS = ["address", "proxyCodehash", "aggregator", "aggregatorCodehash", "decimals", "description", "maxAgeSec", "minAnswer", "maxAnswer"];
const SEQUENCER_KEYS = ["address", "proxyCodehash", "aggregator", "aggregatorCodehash", "graceSec"];
const TX_KEYS = ["gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "maxSignedBytes", "maxAttempts", "replacementBumpBps"];
const PRICING_KEYS = ["marginBps", "maxFee6"];

export function parseFeePolicyConfig(c) {
  exactKeys(c, CONFIG_KEYS, "config");
  if (c.schema !== CONFIG_SCHEMA) fail("bad_config", `config.schema must be "${CONFIG_SCHEMA}"`);
  if (uint(c.chainId, 64, "config.chainId") !== CHAIN_ID) fail("chain_mismatch", "config.chainId must be 8453 (Base); no other chain is priced");
  const o = c.oracle, f = c.feed, s = c.sequencer, t = c.tx, p = c.pricing;
  exactKeys(o, ORACLE_KEYS, "config.oracle");
  exactKeys(f, FEED_KEYS, "config.feed");
  if (s !== null) exactKeys(s, SEQUENCER_KEYS, "config.sequencer");
  exactKeys(t, TX_KEYS, "config.tx");
  exactKeys(p, PRICING_KEYS, "config.pricing");
  if (typeof f.description !== "string" || f.description.length < 1 || f.description.length > 64) fail("bad_config", "config.feed.description must be 1..64 chars");
  const cfg = {
    schema: CONFIG_SCHEMA, chainId: CHAIN_ID,
    notAfter: uint(c.notAfter, 64, "config.notAfter"),
    maxBlockAgeSec: bounded(c.maxBlockAgeSec, 1, 600, 32, "config.maxBlockAgeSec"),
    quoteTtlSec: bounded(c.quoteTtlSec, 30, 900, 32, "config.quoteTtlSec"),
    oracle: { address: address(o.address, "config.oracle.address"), proxyCodehash: codehash(o.proxyCodehash, "config.oracle.proxyCodehash"),
      implementation: address(o.implementation, "config.oracle.implementation"),
      implementationCodehash: codehash(o.implementationCodehash, "config.oracle.implementationCodehash") },
    feed: { address: address(f.address, "config.feed.address"), proxyCodehash: codehash(f.proxyCodehash, "config.feed.proxyCodehash"),
      aggregator: address(f.aggregator, "config.feed.aggregator"), aggregatorCodehash: codehash(f.aggregatorCodehash, "config.feed.aggregatorCodehash"),
      decimals: bounded(f.decimals, 0, MAX_FEED_DECIMALS, 8, "config.feed.decimals"), description: f.description,
      maxAgeSec: bounded(f.maxAgeSec, 60, MAX_FEED_AGE_SEC, 32, "config.feed.maxAgeSec"),
      minAnswer: bounded(f.minAnswer, 1, UINT128_MAX, 128, "config.feed.minAnswer"),
      maxAnswer: bounded(f.maxAnswer, 1, UINT128_MAX, 128, "config.feed.maxAnswer") },
    sequencer: s === null ? null : { address: address(s.address, "config.sequencer.address"),
      proxyCodehash: codehash(s.proxyCodehash, "config.sequencer.proxyCodehash"), aggregator: address(s.aggregator, "config.sequencer.aggregator"),
      aggregatorCodehash: codehash(s.aggregatorCodehash, "config.sequencer.aggregatorCodehash"),
      graceSec: bounded(s.graceSec, 0, 86_400, 32, "config.sequencer.graceSec") },
    tx: { gasLimit: bounded(t.gasLimit, 21_000, 30_000_000, 64, "config.tx.gasLimit"),
      maxFeePerGas: bounded(t.maxFeePerGas, 1, 1_000_000_000_000n, 128, "config.tx.maxFeePerGas"),
      maxPriorityFeePerGas: uint(t.maxPriorityFeePerGas, 128, "config.tx.maxPriorityFeePerGas"),
      maxSignedBytes: Number(bounded(t.maxSignedBytes, 1, MAX_SIGNED_BYTES, 16, "config.tx.maxSignedBytes")),
      maxAttempts: Number(bounded(t.maxAttempts, 1, MAX_ATTEMPTS, 8, "config.tx.maxAttempts")),
      replacementBumpBps: bounded(t.replacementBumpBps, REPLACEMENT_FLOOR_BPS, 10_000, 16, "config.tx.replacementBumpBps") },
    pricing: { marginBps: bounded(p.marginBps, 0, MAX_MARGIN_BPS, 16, "config.pricing.marginBps"),
      maxFee6: bounded(p.maxFee6, 1, UINT128_MAX, 128, "config.pricing.maxFee6") },
  };
  if (cfg.feed.minAnswer > cfg.feed.maxAnswer) fail("bad_config", "config.feed.minAnswer exceeds maxAnswer");
  if (cfg.tx.maxPriorityFeePerGas > cfg.tx.maxFeePerGas) fail("bad_config", "config.tx.maxPriorityFeePerGas exceeds maxFeePerGas");
  const ids = [cfg.oracle.address, cfg.oracle.implementation, cfg.feed.address, cfg.feed.aggregator,
    ...(cfg.sequencer ? [cfg.sequencer.address, cfg.sequencer.aggregator] : [])];
  if (new Set(ids).size !== ids.length) fail("bad_config", "config identities must be pairwise distinct");
  // the cap must hold the largest signed vault.execute this envelope allows (any nonce, fees at their caps)
  const sizes = eip1559Sizes({ nonce: UINT64_MAX, maxPriorityFeePerGas: cfg.tx.maxPriorityFeePerGas, maxFeePerGas: cfg.tx.maxFeePerGas,
    gas: cfg.tx.gasLimit, dataBytes: EXECUTE_CALLDATA_BYTES });
  if (sizes.signedMax > cfg.tx.maxSignedBytes) {
    fail("size_overflow", `the largest signed gas.fund transaction is ${sizes.signedMax} bytes, above config.tx.maxSignedBytes ${cfg.tx.maxSignedBytes}`);
  }
  const configHash = keccak256(utf8.encode(canonical(cfg)));
  return deepFreeze({ ...cfg, derived: { executeSizes: sizes, l1Argument: l1OracleArgument(cfg.tx.maxSignedBytes) }, configHash });
}

// =====================================================================================================================
// Chain reads over the host's EIP-1193 request (pc.request): explicit methods, explicit block, no defaults
// =====================================================================================================================

function chainReader(request) {
  const rpc = async (method, params, code) => {
    try { return await request({ method, params }); } catch (e) { return fail(code, `${method} failed: ${msg(e)}`); }
  };
  return {
    async chainId() { return qty(await rpc("eth_chainId", [], "chain_unreadable"), "eth_chainId"); },
    header: (n) => rpc("eth_getBlockByNumber", [hexOf(n), false], "chain_unreadable"),
    code: (a, at) => rpc("eth_getCode", [a, at], "chain_unreadable"),
    storage: (a, slot, at) => rpc("eth_getStorageAt", [a, slot, at], "chain_unreadable"),
    async call(to, abi, functionName, args, at, code) {
      const data = await rpc("eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args }) }, at], code);
      try { return decodeFunctionResult({ abi, functionName, data }); }
      catch (e) { return fail(code, `${functionName} returned no decodable answer: ${msg(e)}`); }
    },
    async estimateGas(tx, at) { return qty(await rpc("eth_estimateGas", [tx, at], "estimate_failed"), "eth_estimateGas"); },
  };
}

// =====================================================================================================================
// Envelope (pure; shared by the policy and the host queue)
// =====================================================================================================================

const ENVELOPE_FIELDS = ["v", "guard", "chainId", "from", "to", "dataHash", "dataBytes", "gasLimit", "maxFeePerGasCap",
  "maxPriorityFeePerGasCap", "maxSignedBytes", "maxAttempts", "replacementBumpBps", "notAfter", "fee6", "costCeilingWei",
  "estimateGas", "configHash", "block", "blockHash"];
const ENVELOPE_BIG = ["chainId", "gasLimit", "maxFeePerGasCap", "maxPriorityFeePerGasCap", "replacementBumpBps", "notAfter",
  "fee6", "costCeilingWei", "estimateGas", "block"];
const envelopeDigest = (e) => keccak256(utf8.encode(canonical(ENVELOPE_FIELDS.map((k) => [k, e[k]]))));

/** Build a frozen envelope from its fields plus the exact calldata (only its hash and length are kept). */
export function makeEnvelope({ data, ...f }) {
  if (typeof data !== "string" || !/^0x([0-9a-f]{2})+$/.test(data)) fail("envelope_data", "envelope data must be lowercase hex");
  const e = { v: 1, guard: ENVELOPE_GUARD, ...f, dataHash: keccak256(data), dataBytes: (data.length - 2) / 2 };
  exactKeys(e, ENVELOPE_FIELDS, "envelope", "envelope_invalid");
  return deepFreeze({ ...Object.fromEntries(ENVELOPE_FIELDS.map((k) => [k, e[k]])), digest: envelopeDigest(e) });
}

export function verifyEnvelope(e) {
  exactKeys(e, [...ENVELOPE_FIELDS, "digest"], "envelope", "envelope_invalid");
  if (!Object.isFrozen(e)) fail("envelope_invalid", "the envelope must be the frozen object the policy returned");
  if (e.v !== 1 || e.guard !== ENVELOPE_GUARD) fail("envelope_invalid", "unknown envelope version or guard");
  for (const k of ENVELOPE_BIG) if (typeof e[k] !== "bigint" || e[k] < 0n) fail("envelope_invalid", `envelope.${k} must be a bigint`);
  if (e.chainId !== CHAIN_ID) fail("envelope_chain", "the envelope is not for Base 8453");
  if (!Number.isSafeInteger(e.maxSignedBytes) || !Number.isSafeInteger(e.maxAttempts) || !Number.isSafeInteger(e.dataBytes)) fail("envelope_invalid", "bad envelope sizes");
  if (e.digest !== envelopeDigest(e)) fail("envelope_invalid", "the envelope's fields do not match its digest");
  return e;
}

const firstByte = (data) => (data.length >= 4 ? parseInt(data.slice(2, 4), 16) : 0);

/** Every broadcast, first or replacement: the exact signed parameters must sit inside the envelope. Throws otherwise. */
export function checkEnvelopeAttempt(e, a) {
  verifyEnvelope(e);
  const big = (v, name) => { try { return BigInt(v); } catch { return fail("envelope_invalid", `attempt.${name} is not an integer`); } };
  if (a.chainId == null || big(a.chainId, "chainId") !== e.chainId) fail("envelope_chain", `the sender is on chain ${a.chainId}, the envelope on ${e.chainId}`);
  if (String(a.from ?? "").toLowerCase() !== e.from) fail("envelope_sender", "the sending account is not the envelope's relayer");
  if (String(a.to ?? "").toLowerCase() !== e.to) fail("envelope_target", "the target differs from the envelope");
  if (typeof a.data !== "string" || keccak256(a.data.toLowerCase()) !== e.dataHash) fail("envelope_data", "the calldata differs from the checked call");
  if (big(a.value ?? 0n, "value") !== 0n) fail("envelope_value", "a gas.fund call carries no value");
  const gas = big(a.gas, "gas"), maxFee = big(a.maxFeePerGas, "maxFeePerGas"), tip = big(a.maxPriorityFeePerGas, "maxPriorityFeePerGas");
  const nonce = big(a.nonce, "nonce");
  if (gas !== e.gasLimit) fail("envelope_gas", `gas ${gas} is not the envelope's ${e.gasLimit}`);
  if (maxFee <= 0n || maxFee > e.maxFeePerGasCap) fail("envelope_fee", `maxFeePerGas ${maxFee} exceeds the cap ${e.maxFeePerGasCap}`);
  if (tip < 0n || tip > e.maxPriorityFeePerGasCap || tip > maxFee) fail("envelope_tip", `maxPriorityFeePerGas ${tip} exceeds the cap`);
  if (nonce < 0n || nonce >= UINT64_MAX) fail("envelope_nonce", "nonce out of range (EIP-2681)");
  const s = eip1559Sizes({ chainId: e.chainId, nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gas, dataBytes: e.dataBytes, dataFirstByte: firstByte(a.data) });
  if (s.signedMax > e.maxSignedBytes) fail("envelope_size", `the signed transaction can reach ${s.signedMax} bytes, above ${e.maxSignedBytes}`);
  if (!Number.isSafeInteger(a.attempt) || a.attempt < 0 || a.attempt >= e.maxAttempts) fail("envelope_attempts", `broadcast ${a.attempt} exceeds the envelope's ${e.maxAttempts}`);
  if (a.nowSec == null || big(a.nowSec, "nowSec") > e.notAfter) fail("envelope_expired", "the call deadline has passed; nothing more is sent");
  return true;
}

/** First broadcast fees: the queue's usual 2 x base + tip, with the tip capped by the queue AND the envelope, the total
 *  capped by the envelope; refused when the capped fee cannot cover base + tip (it could not be included now). */
export function envelopeInitialFees(e, { baseFeePerGas, tipWei, maxTipWei }) {
  verifyEnvelope(e);
  if (typeof baseFeePerGas !== "bigint" || baseFeePerGas < 0n) fail("envelope_base_fee_unknown", "the latest block has no base fee; nothing is sent");
  let tip = BigInt(tipWei);
  if (tip < 0n) tip = 0n;
  if (tip > BigInt(maxTipWei)) tip = BigInt(maxTipWei);
  if (tip > e.maxPriorityFeePerGasCap) tip = e.maxPriorityFeePerGasCap;
  let maxFee = 2n * baseFeePerGas + tip;
  if (maxFee > e.maxFeePerGasCap) maxFee = e.maxFeePerGasCap;
  if (baseFeePerGas + tip > maxFee) fail("envelope_base_fee", `base fee ${baseFeePerGas} + tip ${tip} exceeds the envelope's fee cap ${e.maxFeePerGasCap}; nothing is sent`);
  return Object.freeze({ maxFeePerGas: maxFee, maxPriorityFeePerGas: tip });
}

/** A same-nonce replacement inside the caps, or null: never above a cap, never below the txpool's 10% floor. */
export function envelopeReplacementFees(e, prev) {
  verifyEnvelope(e);
  const bump = (x) => (x * (10_000n + e.replacementBumpBps)) / 10_000n + 1n;
  const floor = (x) => (x * (10_000n + REPLACEMENT_FLOOR_BPS)) / 10_000n + 1n;
  const pf = BigInt(prev.maxFeePerGas), pt = BigInt(prev.maxPriorityFeePerGas);
  let fee = bump(pf), tip = bump(pt);
  if (fee > e.maxFeePerGasCap) fee = e.maxFeePerGasCap;
  if (tip > e.maxPriorityFeePerGasCap) tip = e.maxPriorityFeePerGasCap;
  if (tip > fee) tip = fee;
  if (fee < floor(pf) || tip < floor(pt)) return null;
  return Object.freeze({ maxFeePerGas: fee, maxPriorityFeePerGas: tip });
}

// =====================================================================================================================
// Quote book: what this policy priced, so accept/envelope can bind to it (bounded, in memory unless injected)
// =====================================================================================================================

export function createQuoteBook({ max = 10_000 } = {}) {
  const m = new Map();
  return Object.freeze({
    get: (k) => m.get(k),
    set(k, v) { m.delete(k); m.set(k, v); while (m.size > max) m.delete(m.keys().next().value); },
    size: () => m.size,
  });
}
const keyOf = (vault, sid, deployment, ethOut, tier, fee6) => [vault, sid, deployment, ethOut, tier, fee6].map(String).join("|");

// =====================================================================================================================
// The policy
// =====================================================================================================================

export function createGasFundQuotePolicy({ config, request, now = () => Math.floor(Date.now() / 1000), book = createQuoteBook() } = {}) {
  const C = parseFeePolicyConfig(config);
  if (typeof request !== "function") fail("bad_setup", "the policy needs the host's EIP-1193 request function (pc.request)");
  if (typeof now !== "function" || !book || typeof book.get !== "function" || typeof book.set !== "function") fail("bad_setup", "bad clock or quote book");
  const R = chainReader(request);
  const { gasLimit: G, maxFeePerGas: F, maxPriorityFeePerGas: T, maxSignedBytes: S } = C.tx;
  const t = () => BigInt(now());

  async function pin(a, want, label, at) {
    const code = await R.code(a, at);
    if (typeof code !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(code) || code === "0x") fail("missing_code", `${label} ${a} has no code at the pinned block`);
    if (keccak256(code.toLowerCase()) !== want) fail("codehash_mismatch", `${label} ${a} runtime code hash differs from the reviewed one`);
  }
  async function aggregatorPinned(p, label, at) {
    await pin(p.address, p.proxyCodehash, `${label} proxy`, at);
    const agg = String(await R.call(p.address, FEED_ABI, "aggregator", [], at, "feed_unreadable")).toLowerCase();
    if (agg !== p.aggregator) fail("feed_aggregator_changed", `${label} proxy now points at ${agg}, not the reviewed ${p.aggregator}`);
    await pin(agg, p.aggregatorCodehash, `${label} aggregator`, at);
  }

  async function readPrice(ts, at) {
    const f = C.feed;
    await aggregatorPinned(f, "ETH/USD", at);
    const decimals = BigInt(await R.call(f.address, FEED_ABI, "decimals", [], at, "feed_unreadable"));
    if (decimals !== f.decimals) fail("feed_decimals", `the feed reports ${decimals} decimals, the config ${f.decimals}`);
    const description = await R.call(f.address, FEED_ABI, "description", [], at, "feed_unreadable");
    if (description !== f.description) fail("feed_description", `the feed describes itself as ${JSON.stringify(description)}`);
    const [roundId, answer, startedAt, updatedAt, answeredInRound] = await R.call(f.address, FEED_ABI, "latestRoundData", [], at, "feed_unreadable");
    if (roundId <= 0n) fail("feed_round", "latestRoundData has no round");
    if (answeredInRound < roundId) fail("feed_round", "the latest round is not complete (answeredInRound < roundId)");
    if (startedAt <= 0n || updatedAt <= 0n || startedAt > updatedAt) fail("feed_round", "the latest round has no consistent timestamps");
    if (answer <= 0n) fail("feed_answer_nonpositive", `the feed answer ${answer} is not positive`);
    if (answer < f.minAnswer || answer > f.maxAnswer) fail("feed_answer_bounds", `the feed answer ${answer} is outside ${f.minAnswer}..${f.maxAnswer}`);
    if (updatedAt > ts) fail("feed_future", `the round is dated ${updatedAt}, after the pinned block ${ts}`);
    if (ts - updatedAt > f.maxAgeSec) fail("feed_stale", `the round is ${ts - updatedAt}s old at the pinned block (max ${f.maxAgeSec})`);
    return { feed: f.address, aggregator: f.aggregator, description, decimals, roundId, answer, startedAt, updatedAt, ageSec: ts - updatedAt };
  }

  async function readSequencer(ts, at) {
    const s = C.sequencer;
    await aggregatorPinned(s, "sequencer uptime", at);
    const [roundId, answer, startedAt] = await R.call(s.address, FEED_ABI, "latestRoundData", [], at, "sequencer_unreadable");
    if (roundId <= 0n || startedAt <= 0n) fail("sequencer_unreadable", "the sequencer uptime feed has no round");
    if (answer !== 0n) fail("sequencer_down", "the sequencer uptime feed reports the sequencer down");
    if (startedAt > ts || ts - startedAt <= s.graceSec) fail("sequencer_grace", `the sequencer came up ${ts - startedAt}s ago (grace ${s.graceSec}s)`);
    return { roundId, startedAt };
  }

  /** Every check at ONE block, read by its hash. */
  async function observe(B) {
    const tn = t();
    if (tn > C.notAfter) fail("config_expired", `the fee policy configuration expired at ${C.notAfter}`);
    const id = await R.chainId();
    if (id !== CHAIN_ID) fail("chain_mismatch", `the RPC serves chain ${id}, not 8453`);
    const h = await R.header(B);
    if (!h || typeof h !== "object") fail("chain_unreadable", `block ${B} is unavailable`);
    if (qty(h.number, "block.number") !== B) fail("chain_unreadable", "the header is not the pinned block");
    const blockHash = hex32(h.hash, "block.hash", "chain_unreadable");
    if (blockHash === ZERO_HASH) fail("chain_unreadable", "the pinned block has a zero hash");
    const ts = qty(h.timestamp, "block.timestamp");
    if (h.baseFeePerGas == null) fail("base_fee_unknown", "the pinned block has no base fee");
    const baseFeePerGas = qty(h.baseFeePerGas, "block.baseFeePerGas");
    if (ts > tn + MAX_CLOCK_SKEW_SEC) fail("block_future", "the pinned block is dated in the future");
    if (tn > ts && tn - ts > C.maxBlockAgeSec) fail("block_stale", `the pinned block is ${tn - ts}s old`);
    const at = { blockHash, requireCanonical: true };
    const o = C.oracle;
    await pin(o.address, o.proxyCodehash, "GasPriceOracle proxy", at);
    const word = hex32(await R.storage(o.address, EIP1967_IMPLEMENTATION_SLOT, at), "GasPriceOracle implementation slot", "chain_unreadable");
    if (!word.startsWith(`0x${"0".repeat(24)}`) || `0x${word.slice(26)}` !== o.implementation) {
      fail("proxy_implementation_changed", `the GasPriceOracle proxy implementation is 0x${word.slice(26)}, not the reviewed ${o.implementation}`);
    }
    await pin(o.implementation, o.implementationCodehash, "GasPriceOracle implementation", at);
    if ((await R.call(o.address, ORACLE_ABI, "isFjord", [], at, "l1_fee_unsupported")) !== true) fail("l1_fee_unsupported", "the GasPriceOracle is not Fjord: no L1 fee upper bound");
    if ((await R.call(o.address, ORACLE_ABI, "isIsthmus", [], at, "operator_fee_unsupported")) !== true) fail("operator_fee_unsupported", "the GasPriceOracle is not Isthmus: the operator fee is undetermined");
    const price = await readPrice(ts, at);
    const sequencer = C.sequencer ? await readSequencer(ts, at) : null;
    return { block: B, blockHash, timestamp: ts, baseFeePerGas, at, price, sequencer };
  }

  async function cost(obs) {
    if (obs.baseFeePerGas + T > F) fail("fee_cap_below_base", `the pinned base fee ${obs.baseFeePerGas} + tip cap ${T} exceeds the fee cap ${F}`);
    const o = C.oracle.address;
    const l1Wei = await R.call(o, ORACLE_ABI, "getL1FeeUpperBound", [BigInt(C.derived.l1Argument)], obs.at, "l1_fee_unavailable");
    if (l1Wei === 0n) fail("l1_fee_zero", "the L1 fee upper bound read as 0; an unknown cost is never priced as zero");
    const operatorWei = await R.call(o, ORACLE_ABI, "getOperatorFee", [G], obs.at, "operator_fee_unavailable");
    const l2Wei = G * F;
    const totalWei = l2Wei + l1Wei + operatorWei;
    const { answer, decimals } = obs.price;
    return { l2Wei, l1Wei, operatorWei, totalWei, required6: usdc6For(totalWei, answer, decimals, 0n),
      fee6: usdc6For(totalWei, answer, decimals, C.pricing.marginBps) };
  }

  function detail(obs, c, expiresAt) {
    const { answer, decimals } = obs.price;
    const u = (wei) => usdc6For(wei, answer, decimals, 0n);
    return {
      kind: "conservative capped compensation (not a receipt cost; no refund when the actual cost is lower)",
      fee6: c.fee6, required6: c.required6, marginBps: C.pricing.marginBps, configHash: C.configHash,
      chainId: CHAIN_ID, block: obs.block, blockHash: obs.blockHash, blockTimestamp: obs.timestamp, expiresAt,
      components: {
        l2: { gasLimit: G, maxFeePerGas: F, wei: c.l2Wei, usdc6Ceil: u(c.l2Wei) },
        l1: { maxSignedBytes: S, oracleArgument: C.derived.l1Argument, wei: c.l1Wei, usdc6Ceil: u(c.l1Wei) },
        operator: { gasLimit: G, wei: c.operatorWei, usdc6Ceil: u(c.operatorWei) },
        totalWei: c.totalWei,
        note: "fee6 = ceil(totalWei x answer x (1 + margin) / 10^(18 + decimals) x 10^6), one rounding; per-component USDC is rounded up separately for display only",
      },
      price: obs.price, sequencer: obs.sequencer, baseFeePerGas: obs.baseFeePerGas,
      envelope: { gasLimit: G, maxFeePerGas: F, maxPriorityFeePerGas: T, maxSignedBytes: S, maxAttempts: C.tx.maxAttempts,
        replacementBumpBps: C.tx.replacementBumpBps, largestSignedExecute: C.derived.executeSizes.signedMax },
      assumptions: [
        "L2: gasLimit x maxFeePerGas bounds the execution fee of every broadcast the host queue may make for this call (replacements included); the queue refuses anything outside the envelope",
        "L1: GasPriceOracle.getL1FeeUpperBound at the pinned block for the maximum signed size, its argument raised so the oracle's fastlz heuristic covers n + ceil(n/32); L1 base/blob fees and scalars at inclusion may differ (observation, not a guarantee; the relayer bears drift)",
        "operator: GasPriceOracle.getOperatorFee(gasLimit) at the pinned block; Isthmus operator fee parameters may change before inclusion (relayer's risk)",
        `price: Chainlink ETH/USD proxy ${obs.price.feed} with aggregator ${obs.price.aggregator} pinned by address and code hash; the proxy owner can repoint it (that refuses until re-review); aggregator-internal min/max circuit breakers are not read, config bounds ${C.feed.minAnswer}..${C.feed.maxAnswer} apply`,
        "oracle: GasPriceOracle predeploy proxy and its EIP-1967 implementation pinned by code hash; a hard-fork upgrade refuses until re-review",
        C.sequencer ? "sequencer: the L2 sequencer uptime feed must report up for longer than the grace period" : "sequencer: NOT checked (config.sequencer is null)",
        "budget: the route requires maxUsdcIn6 + fee6 <= session balance and period remainder and fee6 <= the grant's maxFeePerOp; the vault re-checks on chain; this policy never changes the intent, the grant or the fee after signing",
      ],
    };
  }

  function sessionCtx(ctx, phase) {
    if (ctx === null || typeof ctx !== "object") fail("bad_context", "no context");
    if (ctx.phase !== phase) fail("bad_context", `phase must be "${phase}"`);
    if (uint(ctx.chainId, 64, "ctx.chainId", "bad_context") !== CHAIN_ID) fail("chain_mismatch", "the route is not on 8453");
    return { block: uint(ctx.block, 64, "ctx.block", "bad_context"), vault: address(ctx.vault, "ctx.vault", "bad_context"),
      sid: hex32(ctx.sid, "ctx.sid", "bad_context") };
  }
  function intentOf(i, vault) {
    if (i === null || typeof i !== "object") fail("bad_context", "no intent");
    const out = { payer: address(i.payer, "intent.payer", "bad_context"), deployment: hex32(i.deployment, "intent.deployment", "bad_context"),
      expectedOwner: address(i.expectedOwner, "intent.expectedOwner", "bad_context"), ethOut: uint(i.ethOut, 256, "intent.ethOut", "bad_context"),
      maxUsdcIn6: uint(i.maxUsdcIn6, 256, "intent.maxUsdcIn6", "bad_context"), fee: Number(uint(i.fee, 24, "intent.fee", "bad_context")),
      deadline: uint(i.deadline, 64, "intent.deadline", "bad_context") };
    if (out.payer !== vault) fail("bad_context", "intent.payer is not the vault");
    return out;
  }
  const encodeIntent = (i) => encodeAbiParameters(INTENT_PARAMS, [i.payer, i.deployment, i.expectedOwner, i.ethOut, i.maxUsdcIn6, BigInt(i.fee), i.deadline]);

  async function quote(ctx) {
    const q = sessionCtx(ctx, "quote");
    if (ctx.envelopeEnforced !== true) fail("envelope_guard_absent", "no price without a host queue that enforces the transaction envelope");
    const deployment = hex32(ctx.deployment, "ctx.deployment", "bad_context");
    const ethOut = uint(ctx.ethOut, 256, "ctx.ethOut", "bad_context");
    const tier = Number(uint(ctx.feeTier, 24, "ctx.feeTier", "bad_context"));
    const maxFee6 = uint(ctx.maxFee6, 256, "ctx.maxFee6", "bad_context");
    uint(ctx.amountIn6, 256, "ctx.amountIn6", "bad_context");
    const obs = await observe(q.block);
    const c = await cost(obs);
    if (c.fee6 > C.pricing.maxFee6) fail("fee_above_operator_cap", `fee ${c.fee6} exceeds the operator cap ${C.pricing.maxFee6}`);
    if (c.fee6 > maxFee6) fail("fee_above_signed_cap", `fee ${c.fee6} exceeds the grant's maxFeePerOp ${maxFee6}`);
    const expiresAt = obs.timestamp + C.quoteTtlSec;
    book.set(keyOf(q.vault, q.sid, deployment, ethOut, tier, c.fee6),
      { configHash: C.configHash, fee6: c.fee6, block: q.block, expiresAt, accepted: null });
    return deepFreeze({ fee6: c.fee6, detail: detail(obs, c, expiresAt) });
  }

  async function accept(ctx) {
    const a = sessionCtx(ctx, "execute");
    const intent = intentOf(ctx.intent, a.vault);
    const fee6 = uint(ctx.fee6, 256, "ctx.fee6", "bad_context");
    uint(ctx.amountIn6, 256, "ctx.amountIn6", "bad_context");
    const rec = book.get(keyOf(a.vault, a.sid, intent.deployment, intent.ethOut, intent.fee, fee6));
    if (!rec) fail("no_matching_quote", "this policy issued no quote for this (vault, session, deployment, ethOut, tier, fee); re-quote");
    if (rec.configHash !== C.configHash) fail("config_changed", "the fee policy configuration changed since this quote; re-quote");
    if (t() > rec.expiresAt) fail("quote_expired", "the quote expired; re-quote");
    const obs = await observe(a.block);
    const c = await cost(obs);
    if (fee6 < c.required6) fail("fee_no_longer_covers", `the signed fee ${fee6} no longer covers the worst case ${c.required6} at block ${a.block}; re-quote`);
    rec.accepted = { block: a.block, blockHash: obs.blockHash, totalWei: c.totalWei, required6: c.required6, args: encodeIntent(intent) };
    return true;
  }

  async function envelope(ctx) {
    const e = sessionCtx(ctx, "envelope");
    const intent = intentOf(ctx.intent, e.vault);
    const fee6 = uint(ctx.fee6, 256, "ctx.fee6", "bad_context");
    const nonce = uint(ctx.nonce, 256, "ctx.nonce", "bad_context");
    const deadline = uint(ctx.deadline, 64, "ctx.deadline", "bad_context");
    const to = address(ctx.to, "ctx.to", "bad_context");
    const from = address(ctx.from, "ctx.from", "bad_context");
    if (to !== e.vault) fail("envelope_target", "the call target is not the vault");
    const data = ctx.data;
    if (typeof data !== "string" || !/^0x([0-9a-f]{2})+$/.test(data)) fail("envelope_data", "calldata must be lowercase hex");
    const rec = book.get(keyOf(e.vault, e.sid, intent.deployment, intent.ethOut, intent.fee, fee6));
    if (!rec || !rec.accepted || rec.configHash !== C.configHash) fail("not_accepted", "accept() did not pass for this call under this configuration");
    if (rec.accepted.block !== e.block) fail("block_changed", "the envelope must be built at the block accept() checked");
    if ((data.length - 2) / 2 !== EXECUTE_CALLDATA_BYTES) fail("envelope_data", `vault.execute calldata must be ${EXECUTE_CALLDATA_BYTES} bytes`);
    let d;
    try { d = decodeFunctionData({ abi: EXECUTE_ABI, data }); } catch (err) { fail("envelope_data", `not vault.execute: ${msg(err)}`); }
    if (encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: d.args }) !== data) fail("envelope_data", "non-canonical calldata");
    const [sid, n, action, args, fee, dl] = d.args;
    if (sid.toLowerCase() !== e.sid || n !== nonce || Number(action) !== ACTION_GAS_FUND || fee !== fee6 || dl !== deadline
      || args.toLowerCase() !== rec.accepted.args || args.toLowerCase() !== encodeIntent(intent)) {
      fail("envelope_data", "the calldata is not the accepted gas.fund call (session, nonce, action, intent, fee or deadline differ)");
    }
    if (deadline > intent.deadline) fail("envelope_data", "the call deadline is after the intent deadline");
    if (t() > deadline) fail("envelope_expired", "the call deadline has passed");
    const sizes = eip1559Sizes({ nonce: UINT64_MAX, maxPriorityFeePerGas: T, maxFeePerGas: F, gas: G, dataBytes: EXECUTE_CALLDATA_BYTES, dataFirstByte: firstByte(data) });
    if (sizes.signedMax > S) fail("size_overflow", `the signed call can reach ${sizes.signedMax} bytes, above ${S}`);
    // the REAL signed call at the accepted block: a refused signature or state reverts here, before anything is spent
    const estimate = await R.estimateGas({ from, to, data }, { blockHash: rec.accepted.blockHash, requireCanonical: true });
    if (queueGasFor(estimate) > G) fail("gas_above_cap", `the call needs ${queueGasFor(estimate)} gas under the queue rule, above the priced cap ${G}`);
    return makeEnvelope({ chainId: CHAIN_ID, from, to, data, gasLimit: G, maxFeePerGasCap: F, maxPriorityFeePerGasCap: T,
      maxSignedBytes: S, maxAttempts: C.tx.maxAttempts, replacementBumpBps: C.tx.replacementBumpBps, notAfter: deadline, fee6,
      costCeilingWei: rec.accepted.totalWei, estimateGas: estimate, configHash: C.configHash, block: e.block, blockHash: rec.accepted.blockHash });
  }

  async function fee(ctx) {
    if (ctx?.envelopeEnforced !== true) fail("envelope_guard_absent", "no price without a host queue that enforces the transaction envelope");
    return (await quote(ctx)).fee6;
  }

  return Object.freeze({ interface: QUOTE_POLICY_INTERFACE, configHash: C.configHash, config: C, quote, fee, accept, envelope });
}
