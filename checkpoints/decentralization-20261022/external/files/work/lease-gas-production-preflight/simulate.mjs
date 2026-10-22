// Optional read-only multi-call simulation. Never broadcast these predicted addresses.
import fs from "node:fs";
import crypto from "node:crypto";
import { createPublicClient, http, getContractAddress, encodeDeployData, encodeFunctionData, toHex, keccak256, serializeTransaction, parseAbi, formatEther } from "../enclave/node_modules/viem/_esm/index.js";
const root = "/home/steven/Documents/Codex/2026-10-18/wo";
const pre = JSON.parse(fs.readFileSync(`${root}/outputs/app-lease-gas-review/production-funding-preflight.json`));
const draft = JSON.parse(fs.readFileSync(`${root}/work/lease-gas-production-preflight/reserve-creation-draft.json`));
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const artifact = name => {
  const bytes = fs.readFileSync(`${root}/work/app-lease-gas/forge/out/${name}.sol/${name}.json`);
  if (sha(bytes) !== pre.provenance[name].artifactSha256) throw Error(`${name}: artifact changed since preflight`);
  return JSON.parse(bytes);
};
if (sha(Buffer.from(draft.creationData.slice(2), "hex")) !== pre.reserveCreationCalldataSha256)
  throw Error("Reserve creation calldata differs from reviewed preflight");
const reserve = artifact("EnclaveLeaseGasReserve"), executor = artifact("EnclaveLeaseExecutor");
const nonce = BigInt(pre.reads[0].nonce);
const reserveAddress = getContractAddress({ from: pre.owner, nonce });
const executorAddress = getContractAddress({ from: pre.owner, nonce: nonce + 1n });
const calls = [
  { from: pre.owner, data: draft.creationData, gas: toHex(5000000), value: "0x0" },
  { from: pre.owner, data: encodeDeployData({ abi: executor.abi, bytecode: executor.bytecode.object, args: [reserveAddress] }), gas: toHex(2000000), value: "0x0" },
  { from: pre.owner, to: reserveAddress, data: encodeFunctionData({ abi: reserve.abi, functionName: "bindExecutor", args: [executorAddress] }), gas: toHex(300000), value: "0x0" },
  ...[
    ["owner", pre.owner], ["ledger", pre.originalLedger], ["registry", pre.originalRegistry], ["executor", executorAddress],
  ].map(([functionName]) => ({ from: pre.owner, to: reserveAddress,
    data: encodeFunctionData({ abi: reserve.abi, functionName }), gas: toHex(100000), value: "0x0" })),
];
const results = [];
for (const rpc of pre.reads.map(r => r.rpc)) {
  const c = createPublicClient({ transport: http(rpc, { timeout: 15000, retryCount: 0 }) });
  try {
    const result = await c.request({ method: "eth_simulateV1", params: [{
      blockStateCalls: [{ calls }], validation: false, traceTransfers: false,
    }, toHex(BigInt(pre.reads[0].blockNumber))] });
    const got = result?.[0]?.calls;
    if (!Array.isArray(got) || got.length !== 7 || got.some(x => x.status !== "0x1"))
      throw Error("Simulation did not succeed for all seven calls");
    const expected = [pre.owner, pre.originalLedger, pre.originalRegistry, executorAddress];
    for (let i = 0; i < expected.length; i++)
      if (got[i + 3].returnData.toLowerCase() !== "0x" + expected[i].slice(2).toLowerCase().padStart(64, "0"))
        throw Error(`Unexpected simulated binding ${i}`);
    const ownRead = pre.reads.find(r => r.rpc === rpc);
    const base = BigInt(ownRead.baseFeePerGas), tip = BigInt(ownRead.priorityFeePerGas);
    const maxFeePerGas = base * 2n + tip;
    const estimates = [];
    for (let i = 0; i < 3; i++) {
      const used = BigInt(got[i].gasUsed);
      const gasLimit = (BigInt(got[i].maxUsedGas || got[i].gasUsed) * 120n + 99n) / 100n;
      const raw = serializeTransaction({ type: "eip1559", chainId: 8453, nonce: Number(nonce) + i,
        ...(calls[i].to ? { to: calls[i].to } : {}), data: calls[i].data, value: 0n,
        gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas: tip });
      const l1 = await c.readContract({ address: pre.oracle, abi: parseAbi(["function getL1Fee(bytes) view returns(uint256)"]),
        functionName: "getL1Fee", args: [raw], blockNumber: BigInt(pre.reads[0].blockNumber) });
      estimates.push({ step: ["create reserve", "create executor", "bind executor"][i],
        simulatedGasUsed: String(used), illustrativeGasLimit: String(gasLimit),
        effectiveGasPriceAtSnapshot: String(base + tip), illustrativeMaxFeePerGas: String(maxFeePerGas),
        oracleL1EstimateWei: String(l1), currentFeeEstimateWei: String(used * (base + tip) + l1),
        transactionLimitCostAtSnapshotWei: String(gasLimit * maxFeePerGas + l1) });
    }
    results.push({ rpc, supported: true, allCallsPassed: true, bindingsChecked: true,
      simulatedRuntimeHashes: { reserve: keccak256(got[0].returnData), executor: keccak256(got[1].returnData) },
      estimates, result });
  } catch (e) {
    results.push({ rpc, supported: false, error: e.shortMessage || e.message,
      details: e.details, code: e.code });
  }
}
const out = {
  at: new Date().toISOString(), scope: "READ-ONLY SIMULATION; all addresses predicted, no contracts deployed",
  atBlock: pre.reads[0].blockNumber, predictedReserve: reserveAddress, predictedExecutor: executorAddress,
  nonce: String(nonce), validation: false, results,
  limitations: "Not a funding destination or wallet request. No actual receipts, Base L1 fee debits or live app recovery. Simulation success requires all calls and returned bindings checked.",
};
fs.writeFileSync(`${root}/work/lease-gas-production-preflight/multicall-simulation.json`, JSON.stringify(out, null, 2) + "\n");
if (results.length === 2 && results.every(r => r.allCallsPassed && r.bindingsChecked)) {
  if (JSON.stringify(results[0].simulatedRuntimeHashes) !== JSON.stringify(results[1].simulatedRuntimeHashes))
    throw Error("Providers disagree on simulated runtime");
  const totals = results.map(r => ({
    rpc: r.rpc,
    currentFeeEstimateETH: formatEther(r.estimates.reduce((s,e) => s + BigInt(e.currentFeeEstimateWei), 0n)),
    transactionLimitCostAtSnapshotETH: formatEther(r.estimates.reduce((s,e) => s + BigInt(e.transactionLimitCostAtSnapshotWei), 0n)),
    steps: r.estimates,
  }));
  fs.writeFileSync(`${root}/outputs/app-lease-gas-review/deployment-simulation-review.json`, JSON.stringify({
    at: out.at, block: out.atBlock, scope: "Two-provider read-only production-state simulation; no contracts deployed or funds moved",
    callsPassedPerProvider: 7, bindings: ["admin remains current owner", "existing ledger16d", "existing registry4", "executor bound to new reserve"],
    totals, currentAdminBalanceETH: pre.reads[0].ownerBalanceETH,
    limitations: [
      "Estimates cover the three contract setup transactions only; relay float, app deposits and enrollment are separate.",
      "Gas limits use a20percent simulation margin; fees must be re-estimated immediately before signing.",
      "Oracle L1 fees are estimates from unsigned transactions at the snapshot, not actual Base debits.",
      "Validation was disabled for the read-only simulation; no signed transaction, nonce reservation or live receipt.",
      "Runtime recovery failure and final activation review remain pending; no verified funding destination exists.",
    ],
  }, null, 2) + "\n");
}
console.log(JSON.stringify(results.map(r => ({ rpc: r.rpc, supported: r.supported, error: r.error, details: r.details }))));
