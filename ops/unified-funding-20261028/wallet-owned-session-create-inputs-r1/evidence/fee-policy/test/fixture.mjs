// SCRIPTED stand-ins for the fee-policy tests: an EIP-1193 request function whose answers the test sets. No EVM, no
// network, no key: code bytes, prices and oracle answers are made up. These tests show what the policy DOES with each
// answer; they are not evidence of what Base returns (the root's read-only/fork comparison is that).
import assert from "node:assert/strict";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, keccak256, toHex }
  from "../../../source/node_modules/viem/_esm/index.js";
import { CONFIG_SCHEMA, EXECUTE_ABI, FEED_ABI, ORACLE_ABI } from "../fee-policy.mjs";

export const ORACLE = "0x420000000000000000000000000000000000000f";
export const ORACLE_IMPL = "0xc0d3c0d3c0d3c0d3c0d3c0d3c0d3c0d3c0d3000f";
export const FEED = "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70";        // the address the original host names (fixture only)
export const AGG = "0x000000000000000000000000000000000000a660";
export const SEQ = "0x000000000000000000000000000000000000c0de";
export const SEQ_AGG = "0x000000000000000000000000000000000000c0df";
export const VAULT = "0x2222222222222222222222222222222222222222";
export const RELAYER = "0x1111111111111111111111111111111111111111";
export const SID = `0x${"5a".repeat(32)}`;
export const DEP = `0x${"d0".repeat(32)}`;
export const BH = `0x${"ab".repeat(32)}`;
export const B = 30_000_000n;
export const TS = 1_800_000_000n;
export const NOW = Number(TS) + 2;
export const CODE = Object.freeze({ [ORACLE]: "0x6080600101", [ORACLE_IMPL]: "0x6080600202", [FEED]: "0x6080600303",
  [AGG]: "0x6080600404", [SEQ]: "0x6080600505", [SEQ_AGG]: "0x6080600606" });
export const hashOf = (a) => keccak256(CODE[a]);

/** A complete, valid operator configuration; `mut` edits a fresh copy. */
export function cfg(mut) {
  const c = {
    schema: CONFIG_SCHEMA, chainId: 8453, notAfter: 1_900_000_000, maxBlockAgeSec: 120, quoteTtlSec: 300,
    oracle: { address: ORACLE, proxyCodehash: hashOf(ORACLE), implementation: ORACLE_IMPL, implementationCodehash: hashOf(ORACLE_IMPL) },
    feed: { address: FEED, proxyCodehash: hashOf(FEED), aggregator: AGG, aggregatorCodehash: hashOf(AGG), decimals: 8,
      description: "ETH / USD", maxAgeSec: 3600, minAnswer: "50000000000", maxAnswer: "2000000000000" },
    sequencer: { address: SEQ, proxyCodehash: hashOf(SEQ), aggregator: SEQ_AGG, aggregatorCodehash: hashOf(SEQ_AGG), graceSec: 3600 },
    tx: { gasLimit: 600000, maxFeePerGas: "20000000", maxPriorityFeePerGas: "2000000", maxSignedBytes: 720, maxAttempts: 3,
      replacementBumpBps: 2500 },
    pricing: { marginBps: 2000, maxFee6: "1000000" },
  };
  mut?.(c);
  return c;
}

/** The scripted chain at block B (hash BH). `mut` edits the script; s.log records every request. */
export function chain(mut) {
  const s = {
    chainId: "0x2105",
    header: { number: toHex(B), hash: BH, timestamp: toHex(TS), baseFeePerGas: toHex(5_000_000n) },
    code: { ...CODE },
    implWord: `0x${"0".repeat(24)}${ORACLE_IMPL.slice(2)}`,
    isFjord: true, isIsthmus: true,
    l1: (a) => a * 10_000_000n,
    op: (g) => g * 2n,
    decimals: 8, description: "ETH / USD", aggregator: AGG, seqAggregator: SEQ_AGG,
    round: [(2n << 64n) | 5n, 300_012_345_678n, TS - 100n, TS - 100n, (2n << 64n) | 5n],
    seqRound: [1n, 0n, TS - 7200n, TS - 7200n, 1n],
    estimate: 300_000n,
    fail: new Set(),          // "eth_chainId" | "eth_estimateGas" | "eth_call:<function>"
    raw: {},                  // function -> raw eth_call answer
    log: [],
  };
  mut?.(s);
  const atPinned = (p) => assert.deepEqual(p, { blockHash: s.header.hash, requireCanonical: true }, "every read is at the pinned block hash");
  function answer(to, functionName, args) {
    if (to === ORACLE) {
      if (functionName === "isFjord") return s.isFjord;
      if (functionName === "isIsthmus") return s.isIsthmus;
      if (functionName === "getL1FeeUpperBound") return s.l1(args[0]);
      if (functionName === "getOperatorFee") return s.op(args[0]);
    }
    if (to === FEED) {
      if (functionName === "decimals") return s.decimals;
      if (functionName === "description") return s.description;
      if (functionName === "aggregator") return s.aggregator;
      if (functionName === "latestRoundData") return s.round;
    }
    if (to === SEQ) {
      if (functionName === "aggregator") return s.seqAggregator;
      if (functionName === "latestRoundData") return s.seqRound;
    }
    throw new Error(`unscripted call ${to} ${functionName}`);
  }
  s.request = async ({ method, params }) => {
    s.log.push({ method, params });
    if (s.fail.has(method)) throw new Error(`scripted ${method} failure`);
    switch (method) {
      case "eth_chainId": return s.chainId;
      case "eth_getBlockByNumber": assert.equal(params[0], toHex(B)); assert.equal(params[1], false); return s.header;
      case "eth_getCode": atPinned(params[1]); return s.code[params[0]] ?? "0x";
      case "eth_getStorageAt": atPinned(params[2]); return s.implWord;
      case "eth_call": {
        atPinned(params[1]);
        const to = params[0].to;
        const abi = to === ORACLE ? ORACLE_ABI : FEED_ABI;
        const { functionName, args } = decodeFunctionData({ abi, data: params[0].data });
        if (s.fail.has(`eth_call:${functionName}`)) throw new Error("execution reverted");
        if (functionName in s.raw) return s.raw[functionName];
        return encodeFunctionResult({ abi, functionName, result: answer(to, functionName, args) });
      }
      case "eth_estimateGas": atPinned(params[1]); return toHex(s.estimate);
      default: throw new Error(`unscripted ${method}`);
    }
  };
  return s;
}

const INTENT_PARAMS = [{ type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" },
  { type: "uint24" }, { type: "uint64" }];
export const intent = (over = {}) => ({ payer: VAULT, deployment: DEP, expectedOwner: VAULT, ethOut: 10n ** 15n, maxUsdcIn6: 3_100_000n,
  fee: 500, deadline: TS + 300n, ...over });
export const encodeIntent = (i) => encodeAbiParameters(INTENT_PARAMS, [i.payer, i.deployment, i.expectedOwner, i.ethOut, i.maxUsdcIn6,
  BigInt(i.fee), i.deadline]);
export const quoteCtx = (over = {}) => ({ phase: "quote", chainId: 8453, block: B, vault: VAULT, sid: SID, deployment: DEP,
  ethOut: 10n ** 15n, feeTier: 500, amountIn6: 3_000_000n, maxFee6: 100_000n, envelopeEnforced: true, ...over });
export const execCtx = (fee6, over = {}) => ({ phase: "execute", chainId: 8453, block: B, vault: VAULT, sid: SID, intent: intent(),
  fee6, amountIn6: 3_000_000n, ...over });
export const NONCE = 7n;
export const DEADLINE = TS + 200n;
/** The exact vault.execute calldata the route would encode (a made-up P-256 signature). */
export function executeData(fee6, { sid = SID, nonce = NONCE, action = 10, args = encodeIntent(intent()), deadline = DEADLINE } = {}) {
  return encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute",
    args: [sid, nonce, action, args, fee6, deadline, 11n, 12n, `0x${"0e".repeat(32)}`, `0x${"0f".repeat(32)}`] });
}
export const envelopeCtx = (fee6, over = {}) => ({ phase: "envelope", chainId: 8453, block: B, vault: VAULT, sid: SID, intent: intent(),
  fee6, amountIn6: 3_000_000n, nonce: NONCE, deadline: DEADLINE, to: VAULT, data: executeData(fee6), from: RELAYER, ...over });
