// live-read.mjs <out.json>: READ-ONLY. Two public Base RPCs at ONE agreed block (same number and hash): the original vault's
// code hash, the live committee 0x4774 (epoch, t, W, machines, pending), codeActiveAt for the running and the corrected
// measurement, eth_call of proposeCode with no approvals and with a malformed approval (the reverts the vault answers
// today), and fee inputs (base fee, the GasPriceOracle's L1 upper bound and operator fee) for the gas measured on the
// original bytecode (evidence/original-code-path.json). eth_call/eth_getCode/eth_getBlockByNumber only: nothing is signed or sent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, keccak256, encodeFunctionData, decodeErrorResult, BaseError, ContractFunctionRevertedError } from "viem";
import { base } from "viem/chains";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const A = JSON.parse(fs.readFileSync(path.join(HERE, "build", "artifacts.json"), "utf8")), V = A.vault.abi;
const GAS = JSON.parse(fs.readFileSync(path.join(HERE, "evidence", "original-code-path.json"), "utf8")).gasUsed;
const RPCS = ["https://mainnet.base.org", "https://base.public.blockpi.network/v1/rpc/public"];
const VAULT = "0xe48699b8401564aace7a814ae4569b67a3f7eef5", CID = "0x47742ae8c544ff66a4ad91cfbf5cecdd389013da362813ba3b55c4e247b0f7a3";
const OLD = "0x2530eda0796a9d16eac8e2bb3b1f02abb58a816d4a54ebbbcbfb738a9cf966cf", NEW = "0xfbe2f581cd8da409856adcff75a149c3797111cb0c7030b824f015867b9cb8d7";
const MACHINE = "0xf0f8078459c051a89197fac73ff689c6df96506a";
const ORACLE = "0x420000000000000000000000000000000000000F";
const ORACLE_ABI = [
  { type: "function", name: "getL1FeeUpperBound", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOperatorFee", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] }];
const clients = RPCS.map((u) => createPublicClient({ chain: base, transport: http(u, { timeout: 20000, retryCount: 1 }) }));
const j = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
const out = { at: new Date().toISOString(), readOnly: true, rpcs: RPCS };
const head = await clients[0].getBlockNumber();
const blockNumber = head - 5n;
const blocks = await Promise.all(clients.map((c) => c.getBlock({ blockNumber })));
if (blocks[0].hash !== blocks[1].hash) throw new Error(`RPCs disagree at ${blockNumber}`);
out.block = { number: String(blockNumber), hash: blocks[0].hash, timestamp: String(blocks[0].timestamp), baseFeePerGas: String(blocks[0].baseFeePerGas) };
const both = async (fn) => { const r = await Promise.all(clients.map(fn)); const a = JSON.stringify(j(r[0])), b = JSON.stringify(j(r[1])); if (a !== b) throw new Error(`RPCs disagree: ${a} vs ${b}`); return r[0]; };
const read = (functionName, args) => both((c) => c.readContract({ address: VAULT, abi: V, functionName, args, blockNumber }));
const revert = (args) => both(async (c) => {
  try { await c.call({ to: VAULT, data: encodeFunctionData({ abi: V, functionName: "proposeCode", args }), blockNumber }); return "no revert"; }
  catch (e) { const d = e?.walk ? e.walk((x) => typeof x?.data === "string" && x.data.startsWith("0x"))?.data : null;
    if (!d) return "unparsed: " + String(e.shortMessage || e.message).slice(0, 120);
    const r = decodeErrorResult({ abi: V, data: d }); return `${r.errorName}(${(r.args || []).join(",")})`; } });

out.vaultCodeHash = keccak256(await both((c) => c.getCode({ address: VAULT, blockNumber })));
out.codeHashIsProduction = out.vaultCodeHash === "0x4b949b378382d7fa862e7bc1552b58547ce811527c9746f4d9a0d39a8b4f716b";
out.constants = { CODE_DELAY: String(await read("CODE_DELAY", [])), HANDOVER_TTL: String(await read("HANDOVER_TTL", [])) };
const [Y, epoch, t, W, activatedAt] = await read("committeeOf", [CID]);
const [machines, enclave] = await read("machinesOf", [CID, epoch]);
const pending = await read("pendingOf", [CID]);
out.committee = { id: CID, epoch, t, W, activatedAt: String(activatedAt), Y, machines: j(machines), enclave, pendingToEpoch: pending[0], pendingExpires: String(pending[6]) };
out.codeActiveAt = { running_2530eda0: String(await read("codeActiveAt", [CID, OLD])), corrected_fbe2f581: String(await read("codeActiveAt", [CID, NEW])) };
out.proposeCodeToday = {
  noApprovals: await revert([CID, NEW, [], []]),
  liveMachineWithZeroSignature: await revert([CID, NEW, [MACHINE], ["0x" + "00".repeat(65)]]),
};
// fees: the measured gas on the original bytecode; calldata sizes of representative calls (65-byte signatures, real
// machine record shapes); the oracle's upper bound for unsigned size + 68 bytes of signature allowance
const sig = "0x" + "11".repeat(65), m = (meas) => ({ identity: MACHINE, encKey: "0x" + "22".repeat(32), endpoint: "https://custodian-canary.enclave.host", chipId: "0x" + "33".repeat(32), registryId: "0x" + "44".repeat(32), measurement: meas });
const calls = {
  proposeCode: { gas: GAS.proposeCode, data: encodeFunctionData({ abi: V, functionName: "proposeCode", args: [CID, NEW, [MACHINE], [sig]] }) },
  removeCode: { gas: GAS.removeCode, data: encodeFunctionData({ abi: V, functionName: "removeCode", args: [CID, NEW, [MACHINE], [sig]] }) },
  proposeHandover_2machines: { gas: GAS.proposeHandover_2machines, data: encodeFunctionData({ abi: V, functionName: "proposeHandover", args: [CID, [m(OLD), m(NEW)], [sig, sig], [1], [MACHINE], [sig]] }) },
  postDeal_2recipients: { gas: GAS.postDeal_2recipients, data: encodeFunctionData({ abi: V, functionName: "postDeal", args: [CID, 2, 1, Y, ["0x" + "55".repeat(120), "0x" + "55".repeat(120)], MACHINE, sig] }) },
  ackHandover: { gas: GAS.ackHandover_first, data: encodeFunctionData({ abi: V, functionName: "ackHandover", args: [CID, 2, Y, MACHINE, sig] }) },
  createCommittee: { gas: GAS.createCommittee, data: encodeFunctionData({ abi: V, functionName: "createCommittee", args: ["0x" + "66".repeat(32), m(NEW), Y, [NEW], sig, sig] }) },
};
const baseFee = BigInt(out.block.baseFeePerGas), maxFee = 2n * baseFee + 1_000_000n;
out.fees = { maxFeePerGasAssumed: String(maxFee), rule: "L2 cap = gasUsed(original bytecode, stand-in registry) x 1.25 x (2 x baseFee + 0.001 gwei); L1 = GasPriceOracle.getL1FeeUpperBound(calldata + 110 envelope + 68 signature) at the agreed block; operator fee = getOperatorFee(gas limit) if present", perTx: {} };
for (const [k, c] of Object.entries(calls)) {
  const limit = BigInt(c.gas) * 125n / 100n, size = BigInt((c.data.length - 2) / 2 + 110 + 68);
  const l1 = await both((cl) => cl.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: "getL1FeeUpperBound", args: [size], blockNumber }));
  let op = null; try { op = await both((cl) => cl.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: "getOperatorFee", args: [limit], blockNumber })); } catch { op = null; }
  const l2 = limit * maxFee;
  out.fees.perTx[k] = { gasUsedMeasured: c.gas, gasLimit: String(limit), calldataBytes: (c.data.length - 2) / 2, l2CapWei: String(l2), l1UpperBoundWei: String(l1),
                        operatorFeeWei: op === null ? "unavailable" : String(op), totalUpperBoundWei: String(l2 + l1 + (op ?? 0n)) };
}
out.limits = ["Read-only eth_call/eth_getCode/eth_getBlockByNumber; nothing signed or sent.", "Fee figures are upper-bound estimates at this block only; --send paths must re-read them."];
fs.writeFileSync(process.argv[2], JSON.stringify(j(out), null, 1) + "\n");
console.log(JSON.stringify(j(out), null, 1));
