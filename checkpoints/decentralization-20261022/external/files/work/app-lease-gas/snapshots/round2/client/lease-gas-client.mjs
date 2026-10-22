// work/app-lease-gas/client/lease-gas-client.mjs - a host's claim/renew paid by the APP's gas budget
// (contracts/EnclaveLeaseGasPaymaster.sol). PROTOTYPE, not wired into supervisor.js.
//
// The operator key stays the ordinary key the ledger knows (claim requires msg.sender == the registry operator, renew
// == the current runner). It never needs ETH:
//   1. preflight: the paymaster's statusOf(id) - Disabled / Blocked / InsufficientBudget are explicit refusals;
//   2. build execute(ledger, 0, claim(id, enclaveId) | renew(id)) as an ERC-4337 v0.8 operation from the operator
//      address, with paymasterData = sponsor | epoch and an EntryPoint nonce key derived from the deployment id
//      (2D nonces: operations for different deployments never queue behind each other);
//   3. sign LOCALLY: the userOpHash (Simple7702Account checks ECDSA over the hash itself) and, only while the key is not
//      yet delegated, an EIP-7702 authorization to Simple7702Account (one tuple; ERC-7562 AUTH-010);
//   4. hand it to ANY submitter: an ERC-4337 bundler (eth_sendUserOperation, ERC-7769 JSON with eip7702Auth), or
//      EntryPoint.handleOps sent directly by any funded account (simulated first). Several independent submitters can
//      be tried; the same signed operation is offered to each (never re-signed), and the EntryPoint nonce makes at most
//      one of them land.
import { encodeFunctionData, decodeErrorResult, getAddress, numberToHex, pad, concat, hexToBigInt, sliceHex } from "viem";

export const ENTRYPOINT_08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
export const SIMPLE_7702 = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";
const DESIGNATOR = (impl) => concat(["0xef0100", impl]).toLowerCase();
const USEROP_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";

/** Gas per kind, from the measured costs (bare ledger.claim ~121k, renew ~36k; paymaster validation ~145k cold, postOp
 *  <= 55k): call limits tight to keep the EntryPoint's unused-gas penalty (and the app's charge for it) small. */
export const GAS = Object.freeze({
  claim: { verification: 100_000n, call: 170_000n },
  renew: { verification: 100_000n, call: 80_000n },
  preVerification: 60_000n, paymasterVerification: 200_000n, paymasterPostOp: 100_000n,
});

const PACKED = [{ name: "sender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "initCode", type: "bytes" },
  { name: "callData", type: "bytes" }, { name: "accountGasLimits", type: "bytes32" }, { name: "preVerificationGas", type: "uint256" },
  { name: "gasFees", type: "bytes32" }, { name: "paymasterAndData", type: "bytes" }, { name: "signature", type: "bytes" }];
export const EP_ABI = [
  { type: "function", name: "getNonce", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint192" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getUserOpHash", stateMutability: "view", inputs: [{ type: "tuple", components: PACKED }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "handleOps", stateMutability: "nonpayable", inputs: [{ type: "tuple[]", components: PACKED }, { type: "address" }], outputs: [] },
];
export const PM_ABI = [
  { type: "function", name: "statusOf", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "epochSec", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ledger", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const ACCOUNT_ABI = [{ type: "function", name: "execute", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }], outputs: [] }];
const LEDGER_ABI = [
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bytes32" }], outputs: [] },
  { type: "function", name: "renew", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
];
export const STATUS = ["Unknown", "Disabled", "Blocked", "InsufficientBudget", "EpochCapReached", "Ready", "PriceUnavailable", "Inactive"];

const word = (hi, lo) => pad(numberToHex((BigInt(hi) << 128n) | BigInt(lo)), { size: 32 });
const u128 = (v) => pad(numberToHex(BigInt(v)), { size: 16 });

const EP_ERRORS = [
  { type: "error", name: "FailedOp", inputs: [{ name: "opIndex", type: "uint256" }, { name: "reason", type: "string" }] },
  { type: "error", name: "FailedOpWithRevert", inputs: [{ name: "opIndex", type: "uint256" }, { name: "reason", type: "string" }, { name: "inner", type: "bytes" }] },
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
];
/** The EntryPoint's refusal in words: "AA32 paymaster expired or not due", "AA33 reverted: in flight", ... */
export function entryPointReason(e) {
  let data = null;
  for (let x = e; x && !data; x = x.cause) if (typeof x.data === "string" && /^0x[0-9a-f]{8}/i.test(x.data)) data = x.data;
  if (!data) { const m = /custom error (0x[0-9a-f]{8}):\s*([0-9a-f]*)/i.exec(String(e?.message || "")); if (m) data = m[1] + m[2]; }
  if (!data) return null;
  try {
    const d = decodeErrorResult({ abi: EP_ERRORS, data });
    if (d.errorName === "FailedOp") return d.args[1];
    if (d.errorName === "FailedOpWithRevert") {
      let inner = d.args[2];
      try { inner = decodeErrorResult({ abi: EP_ERRORS, data: d.args[2] }).args[0]; } catch {}
      return `${d.args[1]}: ${inner}`;
    }
  } catch {}
  return null;
}

export class LeaseGasRefusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** execute(ledger, 0, claim(id, enclaveId)) / execute(ledger, 0, renew(id)) - exactly what the paymaster accepts. */
export function leaseCallData({ ledger, kind, id, enclaveId }) {
  const inner = kind === "claim" ? encodeFunctionData({ abi: LEDGER_ABI, functionName: "claim", args: [id, enclaveId] })
    : kind === "renew" ? encodeFunctionData({ abi: LEDGER_ABI, functionName: "renew", args: [id] }) : null;
  if (!inner) throw new Error(`kind must be claim or renew, not ${kind}`);
  return encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "execute", args: [getAddress(ledger), 0n, inner] });
}

/** The EntryPoint nonce key for a deployment: the id's top 192 bits. */
export const nonceKeyOf = (id) => hexToBigInt(id) >> 64n;

/** What the EntryPoint will pass as maxCost for `op`: all its gas limits times its maxFeePerGas. */
export function maxCostOf(op) {
  const M = (1n << 128n) - 1n, agl = hexToBigInt(op.accountGasLimits), fees = hexToBigInt(op.gasFees);
  const pmv = hexToBigInt(sliceHex(op.paymasterAndData, 20, 36)), pmp = hexToBigInt(sliceHex(op.paymasterAndData, 36, 52));
  return ((agl >> 128n) + (agl & M) + BigInt(op.preVerificationGas) + pmv + pmp) * (fees & M);
}

/** The app's budget state for THIS operation (its maxCost), as the paymaster computes it; refuses explicitly unless
 *  Ready. `op` omitted: the worst case the paymaster's limits allow. */
export async function preflight({ client, paymaster, id, op = null }) {
  const [st, available6, need6] = await client.readContract({ address: paymaster, abi: PM_ABI, functionName: "statusOf",
                                                              args: [id, op ? maxCostOf(op) : 0n] });
  const status = STATUS[Number(st)] || "Unknown";
  if (status !== "Ready") {
    const why = { Unknown: "no such deployment on this paymaster's ledger",
      Disabled: "the app's owner has not authorized lease-gas sponsorship (configureBudget)",
      Blocked: "sponsorship is paused or this deployment is blocked by platform moderation",
      InsufficientBudget: `insufficient app gas budget: ${available6} available, ${need6} needed to reserve this operation, or above the owner's per-operation cap (USDC 6dp)`,
      EpochCapReached: `the app's gas spending cap for this epoch is reached (this operation would reserve ${need6}, USDC 6dp); retry next epoch`,
      PriceUnavailable: "the ETH/USD price is stale, future-dated or out of bounds: the paymaster cannot quote this operation",
      Inactive: "the deployment is stopped or the ledger retired" }[status];
    throw new LeaseGasRefusal(status, why);
  }
  return { status, available6, need6 };
}

/** Build (unsigned) the claim/renew operation for `sender` (the operator address). */
export async function buildLeaseOp({ client, sender, paymaster, sponsor, kind, id, enclaveId, gas = GAS, maxFeeCap = 200_000_000n, priorityFee = 1_000_000n }) {
  const ledger = await client.readContract({ address: paymaster, abi: PM_ABI, functionName: "ledger" });
  const [nonce, block, epochSec] = await Promise.all([
    client.readContract({ address: ENTRYPOINT_08, abi: EP_ABI, functionName: "getNonce", args: [getAddress(sender), nonceKeyOf(id)] }),
    client.getBlock(),
    client.readContract({ address: paymaster, abi: PM_ABI, functionName: "epochSec" })]);
  const k = gas[kind];
  if (!k) throw new Error(`kind must be claim or renew, not ${kind}`);
  let maxFee = (block.baseFeePerGas || 0n) * 2n + priorityFee;
  if (maxFee > maxFeeCap) maxFee = maxFeeCap;
  if (maxFee < priorityFee) throw new LeaseGasRefusal("FeeCap", `base fee ${block.baseFeePerGas} is above the sponsored fee cap ${maxFeeCap}`);
  const epoch = block.timestamp / epochSec;
  const paymasterAndData = concat([getAddress(paymaster), u128(gas.paymasterVerification), u128(gas.paymasterPostOp),
                                   getAddress(sponsor), pad(numberToHex(epoch), { size: 4 })]);
  return { sender: getAddress(sender), nonce, initCode: "0x", callData: leaseCallData({ ledger, kind, id, enclaveId }),
           accountGasLimits: word(k.verification, k.call), preVerificationGas: gas.preVerification,
           gasFees: word(priorityFee, maxFee), paymasterAndData, signature: "0x" };
}

/** Sign locally with the operator's viem LOCAL account; adds the 7702 authorization only while not yet delegated. */
export async function signLeaseOp({ client, op, account }) {
  if (getAddress(account.address) !== getAddress(op.sender)) throw new Error("the operator account must be the operation's sender");
  const userOpHash = await client.readContract({ address: ENTRYPOINT_08, abi: EP_ABI, functionName: "getUserOpHash", args: [{ ...op, signature: "0x" }] });
  const signature = await account.sign({ hash: userOpHash });
  const code = (await client.getCode({ address: op.sender })) || "0x";
  let authorization = null;
  if (code.toLowerCase() !== DESIGNATOR(SIMPLE_7702)) {
    if (code !== "0x") throw new LeaseGasRefusal("Delegated", `the operator key is delegated to something else (${code}); the paymaster only accepts Simple7702Account`);
    authorization = await account.signAuthorization({ contractAddress: SIMPLE_7702, chainId: client.chain.id,
                                                      nonce: await client.getTransactionCount({ address: op.sender }) });
  }
  return { op: { ...op, signature }, userOpHash, authorization };
}

/** ERC-7769 eth_sendUserOperation parameters (EntryPoint v0.8, with eip7702Auth). Not exercised against a production
 *  bundler in this prototype. */
export function toBundlerRpc(op, authorization) {
  const hx = (v) => numberToHex(BigInt(v));
  const agl = hexToBigInt(op.accountGasLimits), fees = hexToBigInt(op.gasFees), M = (1n << 128n) - 1n;
  const pnd = op.paymasterAndData;
  return {
    sender: op.sender, nonce: hx(op.nonce), callData: op.callData,
    callGasLimit: hx(agl & M), verificationGasLimit: hx(agl >> 128n), preVerificationGas: hx(op.preVerificationGas),
    maxFeePerGas: hx(fees & M), maxPriorityFeePerGas: hx(fees >> 128n),
    paymaster: sliceHex(pnd, 0, 20), paymasterVerificationGasLimit: hx(hexToBigInt(sliceHex(pnd, 20, 36))),
    paymasterPostOpGasLimit: hx(hexToBigInt(sliceHex(pnd, 36, 52))), paymasterData: sliceHex(pnd, 52),
    signature: op.signature,
    ...(authorization ? { eip7702Auth: { chainId: hx(authorization.chainId), address: authorization.address, nonce: hx(authorization.nonce),
                                         yParity: hx(authorization.yParity), r: authorization.r, s: authorization.s } } : {}),
  };
}

/** Offer the SAME signed operation to independent bundlers in turn; the first that accepts wins. */
export async function submitToBundlers({ urls, op, authorization, fetchImpl = fetch }) {
  const errors = [];
  for (const url of urls) {
    try {
      const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [toBundlerRpc(op, authorization), ENTRYPOINT_08] }) });
      const j = await r.json();
      if (j.result) return { bundler: url, userOpHash: j.result };
      errors.push(`${url}: ${j.error?.message || "no result"}`);
    } catch (e) { errors.push(`${url}: ${e.message}`); }
  }
  throw new Error(`no bundler accepted the operation: ${errors.join("; ")}`);
}

/** Submit directly: EntryPoint.handleOps from `wallet` (any funded account; the EntryPoint repays it from the paymaster
 *  deposit), with the operator's authorization in the same type-4 transaction. Simulated first: a refusal costs the
 *  submitter nothing. */
export async function submitDirect({ client, wallet, op, authorization, beneficiary = wallet.account.address }) {
  const data = encodeFunctionData({ abi: EP_ABI, functionName: "handleOps", args: [[op], beneficiary] });
  const authorizationList = authorization ? [authorization] : undefined;
  try { await client.call({ account: wallet.account, to: ENTRYPOINT_08, data, authorizationList }); }
  catch (e) {
    const why = entryPointReason(e);
    throw new LeaseGasRefusal("Simulation", `the EntryPoint refuses this operation: ${why || (e.shortMessage || e.message).slice(0, 400)}`);
  }
  const hash = await wallet.sendTransaction({ to: ENTRYPOINT_08, data, authorizationList, gas: 1_500_000n });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const ev = receipt.logs.find((l) => l.address.toLowerCase() === ENTRYPOINT_08.toLowerCase() && l.topics[0] === USEROP_EVENT
                                      && getAddress(sliceHex(l.topics[2], 12)) === getAddress(op.sender));
  if (!ev) throw new Error(`handleOps ${hash} emitted no UserOperationEvent for ${op.sender}`);
  return { hash, receipt, success: hexToBigInt(sliceHex(ev.data, 32, 64)) === 1n,
           actualGasCost: hexToBigInt(sliceHex(ev.data, 64, 96)), actualGasUsed: hexToBigInt(sliceHex(ev.data, 96, 128)) };
}

