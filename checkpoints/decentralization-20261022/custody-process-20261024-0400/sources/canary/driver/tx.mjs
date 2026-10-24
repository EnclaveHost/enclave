// The pin checks every custody update must pass before the sender (sender.mjs, the reviewed operator-helper pattern)
// prices, signs or broadcasts it: target contract, function selector, the deployment id inside the calldata, the
// exact calldata hash, chain id, zero value, sender = the pinned canary owner, and the step's gas and fee caps.
// Plus the eth_call-only refusal check. Sending lives in sender.mjs; budgets in budget.mjs.
import { createHash } from "node:crypto";

export const BASE_CHAIN_ID = 8453;
export const GLOBAL_GAS_CAP = 3_000_000n;
export const GLOBAL_FEE_CAP = 100_000_000n;              // 0.1 gwei per gas

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
  const gasCap = BigInt(m.gasCap), fee = BigInt(m.maxFeePerGasWei);
  if (gasCap <= 0n || gasCap > GLOBAL_GAS_CAP) throw new Error("tx: gas cap out of bounds");
  if (fee <= 0n || fee > GLOBAL_FEE_CAP) throw new Error("tx: fee ceiling out of bounds");
  return { gasCap, fee };
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
