// A host's order to have its proofs carried (contracts/EnclaveHostExecutor.sol `carry`): the operator key signs, with
// no ETH, the exact calls to its prover, the fee in the ledger's USDC and where the rest of its earnings go; anyone
// sends it, and is paid only if those calls unlocked at least the fee.
//
// No package import (the Windows node ships this outside its own folder): the three chain primitives are handed in as
// `eth` = {encodeFunctionData, encodeAbiParameters, keccak256} (viem's).
const ADDR = /^0x[0-9a-fA-F]{40}$/, HEX32 = /^0x[0-9a-f]{64}$/, ZERO = '0x0000000000000000000000000000000000000000';
const need = (ok, what) => { if (!ok) throw new Error(what); };

export const CARRY_ABI = Object.freeze([
  {type: 'function', name: 'carryNonce', stateMutability: 'view', inputs: [], outputs: [{name: '', type: 'uint64'}]},
  {type: 'function', name: 'carry', stateMutability: 'nonpayable', outputs: [], inputs: [
    {name: 'c', type: 'tuple', components: [{name: 'target', type: 'address'}, {name: 'callsHash', type: 'bytes32'}, {name: 'nonce', type: 'uint64'},
      {name: 'deadline', type: 'uint64'}, {name: 'payee', type: 'address'}, {name: 'fee6', type: 'uint256'}, {name: 'payout', type: 'address'}]},
    {name: 'calls', type: 'bytes[]'}, {name: 'signature', type: 'bytes'}]},
]);
const CARRY = [{name: 'ledger', type: 'address'}, {name: 'target', type: 'address'}, {name: 'callsHash', type: 'bytes32'}, {name: 'nonce', type: 'uint64'},
  {name: 'deadline', type: 'uint64'}, {name: 'payee', type: 'address'}, {name: 'fee6', type: 'uint256'}, {name: 'payout', type: 'address'}];

/** keccak256(abi.encode(bytes[] calls)): what the order commits to. */
export const callsHash = (eth, calls) => eth.keccak256(eth.encodeAbiParameters([{type: 'bytes[]'}], [calls]));

/** The typed data the operator key signs. The domain's contract is the OPERATOR's own address: the executor runs as it. */
export function carryMessage({chainId, operator, ledger}, c) {
  need(Number.isSafeInteger(chainId) && chainId > 0 && ADDR.test(String(operator)) && ADDR.test(String(ledger)), 'chain id, operator and ledger');
  need(ADDR.test(String(c.target)) && c.target !== ZERO && HEX32.test(String(c.callsHash)), 'target and calls');
  need(ADDR.test(String(c.payee)) && ADDR.test(String(c.payout)), 'payee and payout (the zero address for none)');
  const fee6 = BigInt(c.fee6), nonce = BigInt(c.nonce), deadline = BigInt(c.deadline);
  need(fee6 >= 0n && nonce >= 0n && deadline > 0n, 'fee, nonce and deadline');
  const low = a => String(a).toLowerCase();
  return {domain: {name: 'EnclaveHostExecutor', version: '1', chainId, verifyingContract: low(operator)}, types: {Carry: CARRY}, primaryType: 'Carry',
    message: {ledger: low(ledger), target: low(c.target), callsHash: c.callsHash, nonce, deadline, payee: low(c.payee), fee6, payout: low(c.payout)}};
}

/**
 * One signed order for `calls` ([{abi, functionName, args}], in order) to `target`.
 *   nonce: the key's carryNonce now; fee6: what the host offers, in USDC units; payee: the carrier, or none for whoever
 *   sends it; payout: where the rest of the key's earnings go, or none to leave them; ttlSec: how long the order stands
 *   authorization: the operator key's signed EIP-7702 authorization for the executor, when the key does not run it yet
 *   (its first order); the carrier attaches it to the transaction
 * -> {operator, carry: {...}, calls: [bytes], signature[, authorization]}: `carry`'s arguments
 */
export async function signCarry({eth, chainId, operator, ledger, target, calls, nonce, fee6, payee = ZERO, payout = ZERO, ttlSec = 300, sign, authorization = null, now = Date.now}) {
  need(Array.isArray(calls) && calls.length > 0 && calls.length <= 64, 'calls: 1 to 64');
  need(Number.isInteger(ttlSec) && ttlSec >= 30 && ttlSec <= 3600, 'ttlSec: 30 s to an hour');
  const data = calls.map(c => eth.encodeFunctionData(c));
  const carry = {target, callsHash: callsHash(eth, data), nonce: BigInt(nonce), deadline: BigInt(Math.floor(now() / 1000) + ttlSec),
    payee, fee6: BigInt(fee6), payout};
  return {operator, carry, calls: data, signature: await sign(carryMessage({chainId, operator, ledger}, carry)), ...(authorization ? {authorization} : {})};
}

/**
 * A carrier's side: would this order pay, and if so send it. The carrier loses its gas on an order that reverts, so it
 * asks the chain first, from its own address, and sends only what that says will succeed.
 *   client.simulateContract / wallet.writeContract (viem's); minFee6: the least the carrier takes for its gas
 *   An order's EIP-7702 authorization goes into the transaction (and the simulation) as it came.
 * -> {sent: hash} | {refused: why}
 */
export async function carryOrder({order, client, wallet, account, minFee6 = 0n, now = Date.now}) {
  const c = order?.carry;
  if (!c || !ADDR.test(String(order.operator)) || !Array.isArray(order.calls)) return {refused: 'not an order'};
  if (BigInt(c.fee6) < BigInt(minFee6)) return {refused: `the fee ${c.fee6} is under this carrier's ${minFee6}`};
  if (BigInt(c.deadline) <= BigInt(Math.floor(now() / 1000) + 15)) return {refused: 'the order is about to expire'};
  const mine = String(account.address ?? account).toLowerCase();
  if (String(c.payee).toLowerCase() !== ZERO && String(c.payee).toLowerCase() !== mine) return {refused: 'the order pays another carrier'};
  const call = {address: order.operator, abi: CARRY_ABI, functionName: 'carry', args: [c, order.calls, order.signature], account,
    ...(order.authorization ? {authorizationList: [order.authorization]} : {})};
  try { await client.simulateContract(call); }
  catch (e) { return {refused: `it would revert: ${String(e?.shortMessage || e?.message || e).slice(0, 160)}`}; }
  return {sent: await wallet.writeContract(call)};
}
