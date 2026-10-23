// ONE bounded owner transaction per execute call. Everything is pinned by the plan step and the prepared record and is
// re-checked here: target contract, function selector, the deployment id inside the calldata, the exact calldata hash,
// chain id, zero value, sender = the pinned canary owner, gas cap, fee ceiling and total-cost cap, the owner's
// balance, and the operator's typed confirmation of the PREPARED hash.
// It simulates first (eth_call from the owner), refuses when the estimate exceeds the cap, sends with gas = cap, and
// waits a bounded time for the receipt. It never retries a send: a missing receipt is recorded as UNKNOWN and the
// step is closed; the next read decides what happened.
import { createHash } from "node:crypto";

export const BASE_CHAIN_ID = 8453;
export const GLOBAL_GAS_CAP = 3_000_000n;
export const GLOBAL_FEE_CAP = 100_000_000n;              // 0.1 gwei per gas
export const GLOBAL_COST_CAP_WEI = 300_000_000_000_000n; // 0.0003 ETH per transaction, whatever the step says

const sha = (hex) => createHash("sha256").update(Buffer.from(hex.replace(/^0x/, ""), "hex")).digest("hex");
const lc = (a) => String(a).toLowerCase();

// prepared: { stepId, stepHash, calldataSha256, preparedHash, ... } from prepare.mjs; selector: the pinned ABI's
// selector of step.mutation.fn.
export function checkTxAgainstStep(tx, step, prepared, selector) {
  const m = step.mutation;
  if (!m) throw new Error(`${step.id}: not a mutation step`);
  if (!prepared || prepared.stepId !== step.id || prepared.stepHash !== step.stepHash) throw new Error("tx: the prepared record is not for this step of this plan");
  if (tx.chainId !== BASE_CHAIN_ID || m.chainId !== BASE_CHAIN_ID) throw new Error("tx: Base mainnet (8453) only");
  if (lc(tx.to) !== lc(m.target)) throw new Error(`tx: target ${tx.to} is not the pinned ${m.target}`);
  if (lc(tx.from) !== lc(m.from)) throw new Error("tx: sender is not the pinned canary owner");
  if (BigInt(tx.value || 0) !== 0n) throw new Error("tx: value must be zero");
  const data = lc(tx.data);
  if (!/^0x[0-9a-f]{8}([0-9a-f]{64})+$/.test(data)) throw new Error("tx: calldata is not a selector plus ABI words");
  if (data.slice(0, 10) !== lc(selector)) throw new Error(`tx: selector ${data.slice(0, 10)} is not ${m.fn}`);
  const id = "0x" + data.slice(10, 74);
  if (!m.ids.map(lc).includes(id)) throw new Error(`tx: calldata names deployment ${id}, not this step's canary`);
  if (sha(data) !== prepared.calldataSha256) throw new Error("tx: calldata differs from the prepared calldata");
  const gasCap = BigInt(m.gasCap), fee = BigInt(m.maxFeePerGasWei), costCap = BigInt(m.maxCostWei);
  if (gasCap <= 0n || gasCap > GLOBAL_GAS_CAP) throw new Error("tx: gas cap out of bounds");
  if (fee <= 0n || fee > GLOBAL_FEE_CAP) throw new Error("tx: fee ceiling out of bounds");
  if (costCap !== gasCap * fee || costCap > GLOBAL_COST_CAP_WEI) throw new Error("tx: cost cap must be gasCap x fee ceiling and within the global cap");
  return { gasCap, fee, costCap };
}

// client: { getBalance, call, estimateGas, getGasPrice, getTransactionCount, sendTransaction, waitForReceipt } — a thin
// adapter over viem (cli.mjs), injected so tests never touch a chain.
export async function executeTx({ step, prepared, selector, tx, confirm, client, timeoutMs = 120_000 }) {
  if (confirm !== prepared?.preparedHash) throw new Error(`${step.id}: --confirm must equal the prepared hash`);
  const { gasCap, fee, costCap } = checkTxAgainstStep(tx, step, prepared, selector);
  const ev = { simulated: false, estimate: null, gasCap: String(gasCap), maxFeePerGas: String(fee), nonce: null };
  const balance = await client.getBalance({ address: tx.from });
  if (balance < costCap) return { outcome: "fail", evidence: { ...ev, refusedBy: "balance below this step's cost cap", balance: String(balance) } };
  try { await client.call({ from: tx.from, to: tx.to, data: tx.data }); }
  catch (e) { return { outcome: "fail", evidence: { ...ev, refusedBy: "simulation", reason: String(e.shortMessage || e.message).slice(0, 200) } }; }
  ev.simulated = true;
  const estimate = await client.estimateGas({ from: tx.from, to: tx.to, data: tx.data });
  ev.estimate = String(estimate);
  if (estimate > gasCap) return { outcome: "fail", evidence: { ...ev, refusedBy: "gas cap" } };
  const price = await client.getGasPrice();
  ev.gasPrice = String(price);
  if (price * 2n > fee) return { outcome: "fail", evidence: { ...ev, refusedBy: "fee ceiling (gas price above half the pinned ceiling)" } };
  const nonce = await client.getTransactionCount({ address: tx.from, blockTag: "pending" });
  if (prepared.expectNonce !== undefined && nonce !== prepared.expectNonce) return { outcome: "fail", evidence: { ...ev, refusedBy: "nonce moved since prepare", nonce } };
  ev.nonce = nonce;
  const hash = await client.sendTransaction({ from: tx.from, to: tx.to, data: tx.data, value: 0n, gas: gasCap,
    maxFeePerGas: fee, maxPriorityFeePerGas: price < fee ? price : fee, nonce, chainId: tx.chainId });
  ev.txHash = hash;
  let receipt;
  try { receipt = await client.waitForReceipt(hash, timeoutMs); }
  catch { return { outcome: "aborted", evidence: { ...ev, receipt: "UNKNOWN: not seen within the bound; read the chain before any next step" } }; }
  Object.assign(ev, { blockNumber: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed), status: receipt.status,
    effectiveGasPrice: String(receipt.effectiveGasPrice ?? "") });
  return { outcome: receipt.status === "success" ? "pass" : "fail", evidence: ev };
}

// A chain-side refusal check: eth_call ONLY. Passes when the call reverts with the expected custom error name.
export async function simulateRefusal({ client, from, to, data, expectRevert }) {
  try { await client.call({ from, to, data }); }
  catch (e) {
    const name = e.errorName || e.cause?.data?.errorName || (/reverted[^:]*: (\w+)/.exec(String(e.shortMessage || e.message)) || [])[1] || null;
    return { outcome: name === expectRevert ? "pass" : "fail", evidence: { reverted: true, errorName: name, expected: expectRevert } };
  }
  return { outcome: "fail", evidence: { reverted: false, expected: expectRevert, note: "the call SUCCEEDED; nothing was sent" } };
}
