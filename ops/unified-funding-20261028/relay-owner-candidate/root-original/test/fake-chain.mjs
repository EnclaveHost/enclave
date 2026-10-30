// OFFLINE TEST HARNESS (relay-owner-r2; extends relay-r1/test/fake-chain.mjs). A real viem public client over a MOCKED
// JSON-RPC transport: eth_call answers come from per-address handler tables, ABI-encoded with the same ABIs the route
// uses. No contract code runs, no P-256 / EIP-712 / ERC-1271 / EIP-3009 signature is verified, no EVM exists here.
// "BadSignature" is a SCRIPTED revert keyed on a marker value. A passing test proves the relay module's control flow
// against these scripted answers - never that the contracts behave this way.
import {
  createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics,
  encodeFunctionResult, getAddress, keccak256, toHex,
} from "../../../source/node_modules/viem/_esm/index.js";
import {
  bookAbi, cloneRuntime, legacyFactoryAbi, legacyVaultAbi, predictVault, quoterV2Abi, reserveAbi, sessionIdOf,
} from "../funding-route.mjs";
import {
  fundingLedgerAbi, fundingSessionVaultAbi, fundingSessionVaultFactoryAbi, leaseGasDexAdapterAbi,
} from "../generated/funding-abi.mjs";

export const T = 1_800_000_000;
export const BLOCK = 1000n;
export const SESSION_KEY = `0x${"5e".repeat(32)}`;
export const GRANT_NONCE = `0x${"01".repeat(32)}`;
export const BAD_R = `0x${"ee".repeat(32)}`;
/** Scripted "forged" owner signature: the fake vault reverts BadSignature for it (no crypto is checked). */
export const BAD_SIG = `0x${"bad0".repeat(32)}`;
export const GOOD_SIG = `0x${"60".repeat(65)}`;
export const HEAD_HASH = `0x${"ab".repeat(32)}`;
const a = (n) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const code = (tag) => `0x60${tag.toString(16).padStart(4, "0")}60005260206000f3`;

export class Revert { constructor(data) { this.data = data; } }
export const revertWith = (errorName, args) => new Revert(encodeErrorResult({ abi: fundingSessionVaultAbi, errorName, args }));

const OWNER_FNS = ["topUp", "topUpWithAuthorization", "extend", "terminate", "revokeAll", "withdraw", "promote", "adopt",
  "setEnvironment", "release"];

export function makeWorld() {
  const A = {
    factory: a(0xf001), implementation: a(0xf002), fundingGasLib: a(0xf003), fundingSessionVaultLib: a(0xf004),
    adapter: a(0xf005), legacyFactory: a(0xf006), legacyImplementation: a(0xf007), usdc: a(0xf008), weth: a(0xf009),
    book: a(0xf00a), ledger: a(0xf00b), reserve: a(0xf00c), swapRouter: a(0xf00d), dexFactory: a(0xf00e), quoter: a(0xf00f),
  };
  const pool500 = a(0xf500);
  const owner = a(0xa11ce);
  const relayer = a(0xbeef);
  const oldVault = a(0x01d);
  const vault = predictVault(A.factory, A.implementation, owner);
  const sid = sessionIdOf(vault, SESSION_KEY, GRANT_NONCE);
  const deployment = `0x${"d0".repeat(32)}`;
  const codes = {};
  let tag = 1;
  for (const [k, v] of Object.entries(A)) {
    codes[v.toLowerCase()] = k === "implementation"
      ? `0x6000${A.fundingGasLib.slice(2).toLowerCase()}${A.fundingSessionVaultLib.slice(2).toLowerCase()}00`
      : code(tag++);
  }
  codes[pool500.toLowerCase()] = code(0x500);
  codes[vault.toLowerCase()] = cloneRuntime(A.implementation);
  codes[oldVault.toLowerCase()] = code(0x01d);

  const w = {
    chainId: 8453, block: BLOCK, timestamp: BigInt(T - 2), A, pool500, owner, relayer, oldVault, vault, sid, deployment, codes,
    holder: vault,
    amountIn: 3_000_000n,
    epoch: 0n,
    seq: 0n,
    session: {
      keyHash: SESSION_KEY, measurement: `0x${"00".repeat(32)}`, actions: 1n << 10n, expiresAt: BigInt(T + 86400),
      epoch: 0n, envs: 3, state: 1, anyApp: true, balance6: 10_000_000n, spent6: 0n, perPeriod6: 10_000_000n, maxFee6: 20_000n,
      maxAppFeeHour6: 0n, maxRateHour6: 0n, periodStart: BigInt(T - 100), period: 86400, opsPerPeriod: 0, periodSpent6: 0n, periodOps: 0,
    },
    live: true,
    gasPolicy: [5_000_000n, 5_000_000_000n, 10n ** 16n],
    executeResult: "0x",
    blocks: { [BLOCK.toString()]: HEAD_HASH },   // number -> canonical hash served by eth_getBlockByNumber
    receipts: {},                                   // txHash -> RPC-shaped receipt served by eth_getTransactionReceipt
    calls: [],
  };
  const C = {};
  const on = (addr, abi, fns) => { C[addr.toLowerCase()] = { abi, fns }; };
  on(A.factory, fundingSessionVaultFactoryAbi, {
    implementation: () => w.A.implementation,
    isVault: ([v]) => getAddress(v) === w.vault,
    vaultFor: ([o]) => predictVault(w.A.factory, w.A.implementation, o),
    openFor: ([, , sig]) => (sig === BAD_SIG ? revertWith("BadSignature") : [w.vault, w.sid]),
    openWithDepositFor: ([, , sig]) => (sig === BAD_SIG ? revertWith("BadSignature") : [w.vault, w.sid]),
  });
  on(A.implementation, fundingSessionVaultAbi, {
    factory: () => w.A.factory, usdc: () => w.A.usdc, book: () => w.A.book, gasAdapter: () => w.A.adapter,
    legacyFactory: () => w.A.legacyFactory,
  });
  on(A.book, bookAbi, { addr: () => w.A.ledger });
  on(A.adapter, leaseGasDexAdapterAbi, {
    usdc: () => w.A.usdc, weth: () => w.A.weth, swapRouter: () => w.A.swapRouter, factory: () => w.A.dexFactory,
    ledger: () => w.A.ledger, reserve: () => w.A.reserve, maxEthOut: () => 10n ** 17n,
    poolFor: ([t]) => (Number(t) === 500 ? w.pool500 : new Revert("0x")),
  });
  on(A.reserve, reserveAbi, { ledger: () => w.A.ledger });
  on(A.legacyFactory, legacyFactoryAbi, {
    implementation: () => w.A.legacyImplementation,
    isVault: ([v]) => getAddress(v) === w.oldVault,
    vaultFor: ([o]) => (getAddress(o) === w.owner ? w.oldVault : a(0)),
  });
  on(oldVault, legacyVaultAbi, { owner: () => w.owner });
  on(A.quoter, quoterV2Abi, {
    factory: () => w.A.dexFactory, WETH9: () => w.A.weth,
    quoteExactOutputSingle: () => (w.amountIn instanceof Revert ? w.amountIn : [w.amountIn, 0n, 1, 90_000n]),
  });
  on(A.ledger, fundingLedgerAbi, {
    get: ([id]) => ({ id, owner: w.holder, appRef: "app:x", ports: "", configCid: "", gpuMilli: 0, cpuMilli: 0, appPort: 0,
      isPublic: false, active: true, createdAt: 0n, rate: 0n, balance6: 0n, spent6: 0n, runner: `0x${"00".repeat(32)}`,
      runnerOperator: a(0), leaseUntil: 0n }),
  });
  const vaultFns = {
    owner: () => w.owner,
    epoch: () => w.epoch,
    sessionOf: () => [w.session, w.live, []],
    gasPolicyOf: () => w.gasPolicy,
    seqOf: () => w.seq,
    execute: (args) => (args[8] === BAD_R ? revertWith("BadSignature") : w.executeResult),
    terminateBySession: (args) => (args[4] === BAD_R ? revertWith("BadSignature") : []),
    close: () => [],
  };
  // every signed owner op: the LAST argument is the signature (or EIP-3009 authorization); BAD_SIG is "forged"
  for (const fn of OWNER_FNS) vaultFns[fn] = (args) => (args[args.length - 1] === BAD_SIG ? revertWith("BadSignature") : []);
  on(vault, fundingSessionVaultAbi, vaultFns);
  w.contracts = C;

  const request = async ({ method, params }) => {
    switch (method) {
      case "eth_chainId": return toHex(w.chainId);
      case "eth_blockNumber": return toHex(w.block);
      case "eth_getBlockByNumber": {
        const [tag] = params;
        const n = tag === "latest" ? w.block : BigInt(tag);
        const hash = w.blocks[n.toString()];
        if (!hash) return null;
        return { number: toHex(n), timestamp: toHex(n === w.block ? w.timestamp : w.timestamp + (n - w.block) * 2n), hash,
          parentHash: `0x${"cd".repeat(32)}`, transactions: [], uncles: [], gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x1" };
      }
      case "eth_getTransactionReceipt": {
        w.calls.push({ method, hash: params[0] });
        return w.receipts[String(params[0]).toLowerCase()] ?? null;
      }
      case "eth_getCode": {
        const [addr, tag] = params;
        w.calls.push({ method, to: getAddress(addr), block: tag });
        return w.codes[addr.toLowerCase()] ?? "0x";
      }
      case "eth_call": {
        const [{ to, data, from }, tag] = params;
        const c = w.contracts[to.toLowerCase()];
        if (!c) throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
        const { functionName, args } = decodeFunctionData({ abi: c.abi, data });
        w.calls.push({ method, to: getAddress(to), fn: functionName, args, from, block: tag });
        const h = c.fns[functionName];
        const out = h ? h(args ?? [], { from, block: tag }) : new Revert("0x");
        if (out instanceof Revert) throw Object.assign(new Error("execution reverted"), { code: 3, data: out.data });
        return encodeFunctionResult({ abi: c.abi, functionName, result: out });
      }
      default: throw new Error(`fake chain: ${method} is not served`);
    }
  };
  w.pc = createPublicClient({ transport: custom({ request }, { retryCount: 0 }) });
  return w;
}

export function manifestOf(w, over = {}) {
  const codehashes = {};
  for (const [k, v] of Object.entries(w.A)) codehashes[k] = keccak256(w.codes[v.toLowerCase()]);
  return {
    schema: "enclave-funding-activation-r1", chainId: 8453, notAfter: T + 3600, maxBlockAgeSec: 60,
    addresses: { ...w.A }, codehashes,
    pools: { 500: { address: w.pool500, codehash: keccak256(w.codes[w.pool500.toLowerCase()]) } },
    feeTiers: [500], maxSlippageBps: 50, deadlineSec: 120, ...over,
  };
}

export function eventLog(abi, address, eventName, args) {
  const ev = abi.find((x) => x.type === "event" && x.name === eventName);
  const topics = encodeEventTopics({ abi: [ev], eventName, args });
  const nonIdx = ev.inputs.filter((i) => !i.indexed);
  return { address, topics, data: encodeAbiParameters(nonIdx, nonIdx.map((i) => args[i.name])) };
}

let txCounter = 0;
/** A receipt as the host's simulateAndSend would hand back (viem-formatted), plus, unless `canonical: false`, the SAME
 *  receipt served by the node at a canonical block. Options script the preconfirmation / reorg cases. */
export function mined(w, logs, { blockHash = `0x${"c1".repeat(32)}`, canonical = true, nodeBlockHash, status = "success" } = {}) {
  const transactionHash = `0x${(++txCounter).toString(16).padStart(64, "0")}`;
  const blockNumber = w.block + 1n;
  const withMeta = logs.map((l, i) => ({ ...l, blockHash, blockNumber, transactionHash, logIndex: i, transactionIndex: 0 }));
  const rc = { status, transactionHash, blockHash, blockNumber, logs: withMeta };
  if (canonical) {
    const h = nodeBlockHash ?? blockHash;
    w.blocks[blockNumber.toString()] = h;
    w.receipts[transactionHash] = {
      transactionHash, blockHash: h, blockNumber: toHex(blockNumber), status: status === "success" ? "0x1" : "0x0",
      transactionIndex: "0x0", from: w.relayer, to: w.vault, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1",
      contractAddress: null, logsBloom: `0x${"00".repeat(256)}`, type: "0x2",
      logs: logs.map((l, i) => ({ ...l, blockHash: h, blockNumber: toHex(blockNumber), transactionHash, logIndex: toHex(i),
        transactionIndex: "0x0", removed: false })),
    };
  }
  return rc;
}

export function gasLogs(w, { intent, nonce, args, fee, used, amount6 = used, relayer = w.relayer, result }) {
  const back = used > intent.maxUsdcIn6 ? 0n : intent.maxUsdcIn6 - used;
  return [
    eventLog(leaseGasDexAdapterAbi, w.A.adapter, "GasFunded", { deployment: intent.deployment, payer: w.vault,
      owner: intent.expectedOwner, pool: w.pool500, fee: intent.fee, ethOut: intent.ethOut, usdcSpent6: used, maxUsdcIn6: intent.maxUsdcIn6 }),
    eventLog(fundingSessionVaultAbi, w.vault, "GasFunded", { sid: w.sid, deployment: intent.deployment, holder: intent.expectedOwner,
      ethOut: intent.ethOut, usdcSpent6: used, maxUsdcIn6: intent.maxUsdcIn6, relayer, fee6: fee }),
    eventLog(fundingSessionVaultAbi, w.vault, "SessionOp", { sid: w.sid, nonce, action: 10, argsHash: keccak256(args), amount6,
      fee6: fee, result: result ?? encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [used, back]) }),
  ];
}

/** Host-shaped store: the SHARED revoked / revokedVaults namespaces exist as sessions.mjs creates them. */
export function memStore() {
  return { data: { revoked: {}, revokedVaults: {}, vaults: {}, sessions: {} }, saves: 0, flushes: 0,
    saveSoon() { this.saves++; }, flush() { this.flushes++; } };
}

/** A scripted stand-in for sessions.mjs simulateAndSend: simulate (viem, latest), afterSimulate, "send" (recorded, no
 *  queue), return the scripted receipt. `trace` records the order so tests can prove mark-before-broadcast. */
export function hostSend(w, next, trace = []) {
  const sends = [];
  const fn = async ({ to, abi, functionName, args, label, afterSimulate }) => {
    try { await w.pc.simulateContract({ address: to, abi, functionName, args, account: w.relayer }); }
    catch (e) { trace.push(`refused:${functionName}`); throw Object.assign(new Error("the vault refused"), { status: 409, code: "revert" }); }
    trace.push(`simulated:${functionName}`);
    afterSimulate?.();
    trace.push(`broadcast:${functionName}`);
    sends.push({ to, functionName, args, label });
    const rc = typeof next === "function" ? next({ functionName, args }) : next;
    if (rc instanceof Error) throw rc;
    if (rc.status !== "success") throw Object.assign(new Error(`${label} reverted on-chain`), { status: 409, code: "revert" });
    return rc;
  };
  fn.sends = sends;
  fn.trace = trace;
  return fn;
}

/** A scripted stand-in for sessions.mjs rateOwner (same semantics: terminate/revokeAll exempt, count on commit). */
export function hostRate(limit = 60) {
  const counts = new Map();
  const calls = [];
  const fn = (owner, op, commit = false) => {
    calls.push({ owner, op, commit });
    if (op === "terminate" || op === "revokeAll") return;
    const n = counts.get(owner) ?? 0;
    if (n >= limit) throw Object.assign(new Error("too many owner operations today"), { status: 429, code: "rate" });
    if (commit) counts.set(owner, n + 1);
  };
  fn.calls = calls;
  fn.count = (o) => counts.get(o) ?? 0;
  return fn;
}
