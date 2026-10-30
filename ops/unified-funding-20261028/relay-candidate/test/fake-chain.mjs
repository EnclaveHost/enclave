// OFFLINE TEST HARNESS (relay-r1). A real viem public client over a MOCKED JSON-RPC transport: eth_call answers come
// from per-address handler tables, ABI-encoded with the same ABIs the route uses. No contract code runs, no P-256
// signature is verified, no EVM exists here. A passing test proves the relay module's control flow against these
// scripted answers - never that the contracts behave this way.
import {
  createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics,
  encodeFunctionResult, getAddress, keccak256, toHex,
} from "viem";
import {
  bookAbi, cloneRuntime, legacyFactoryAbi, legacyVaultAbi, predictVault, quoterV2Abi, reserveAbi, sessionIdOf,
} from "../funding-route.mjs";
import {
  fundingLedgerAbi, fundingSessionVaultAbi, fundingSessionVaultFactoryAbi, leaseGasDexAdapterAbi,
} from "../generated/funding-abi.mjs";

export const T = 1_800_000_000;           // the test clock (unix seconds)
export const BLOCK = 1000n;
export const SESSION_KEY = `0x${"5e".repeat(32)}`;
export const GRANT_NONCE = `0x${"01".repeat(32)}`;
export const BAD_R = `0x${"ee".repeat(32)}`;
const a = (n) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const code = (tag) => `0x60${tag.toString(16).padStart(4, "0")}60005260206000f3`;

export class Revert { constructor(data) { this.data = data; } }
export const revertWith = (errorName, args) => new Revert(encodeErrorResult({ abi: fundingSessionVaultAbi, errorName, args }));

/** A consistent world: every pin the manifest names is served at BLOCK with matching code and identities. */
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
    session: {
      keyHash: SESSION_KEY, measurement: `0x${"00".repeat(32)}`, actions: 1n << 10n, expiresAt: BigInt(T + 86400),
      epoch: 0n, envs: 3, state: 1, anyApp: true, balance6: 10_000_000n, spent6: 0n, perPeriod6: 10_000_000n, maxFee6: 20_000n,
      maxAppFeeHour6: 0n, maxRateHour6: 0n, periodStart: BigInt(T - 100), period: 86400, opsPerPeriod: 0, periodSpent6: 0n, periodOps: 0,
    },
    live: true,
    gasPolicy: [5_000_000n, 5_000_000_000n, 10n ** 16n],
    executeResult: "0x",
    calls: [],
  };
  const C = {};
  const on = (addr, abi, fns) => { C[addr.toLowerCase()] = { abi, fns }; };
  on(A.factory, fundingSessionVaultFactoryAbi, {
    implementation: () => w.A.implementation,
    isVault: ([v]) => getAddress(v) === w.vault,
    vaultFor: ([o]) => predictVault(w.A.factory, w.A.implementation, o),
    openFor: () => [w.vault, w.sid],
    openWithDepositFor: () => [w.vault, w.sid],
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
  on(vault, fundingSessionVaultAbi, {
    owner: () => w.owner,
    sessionOf: () => [w.session, w.live, []],
    gasPolicyOf: () => w.gasPolicy,
    seqOf: () => 0n,
    execute: (args) => (args[8] === BAD_R ? revertWith("BadSignature") : w.executeResult),
  });
  w.contracts = C;

  const request = async ({ method, params }) => {
    switch (method) {
      case "eth_chainId": return toHex(w.chainId);
      case "eth_blockNumber": return toHex(w.block);
      case "eth_getBlockByNumber":
        return { number: toHex(w.block), timestamp: toHex(w.timestamp), hash: `0x${"ab".repeat(32)}`,
          parentHash: `0x${"cd".repeat(32)}`, transactions: [], uncles: [], gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x1" };
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

/** The receipt a gas.fund would carry per the session-r1 SOURCE (SessionOp.amount6 = actual after the root fix).
 *  Overrides let a test script a WRONG receipt (maximum-as-amount, foreign relayer, actual > maximum, failure). */
export function gasReceipt(w, { intent, nonce, args, fee, used, amount6 = used, relayer = w.relayer, status = "success" }) {
  const back = used > intent.maxUsdcIn6 ? 0n : intent.maxUsdcIn6 - used;
  return {
    status, transactionHash: `0x${"11".repeat(32)}`, blockNumber: w.block + 1n,
    logs: [
      eventLog(leaseGasDexAdapterAbi, w.A.adapter, "GasFunded", { deployment: intent.deployment, payer: w.vault,
        owner: intent.expectedOwner, pool: w.pool500, fee: intent.fee, ethOut: intent.ethOut, usdcSpent6: used, maxUsdcIn6: intent.maxUsdcIn6 }),
      eventLog(fundingSessionVaultAbi, w.vault, "GasFunded", { sid: w.sid, deployment: intent.deployment, holder: intent.expectedOwner,
        ethOut: intent.ethOut, usdcSpent6: used, maxUsdcIn6: intent.maxUsdcIn6, relayer, fee6: fee }),
      eventLog(fundingSessionVaultAbi, w.vault, "SessionOp", { sid: w.sid, nonce, action: 10, argsHash: keccak256(args), amount6,
        fee6: fee, result: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [used, back]) }),
    ],
  };
}

export function memStore() {
  return { data: { revoked: {}, vaults: {}, sessions: {} }, saves: 0, saveSoon() { this.saves++; }, flush() {} };
}
