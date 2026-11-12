// How ETH reaches a host's operator key, shared by topup-plan.mjs (writes the step) and server.mjs (checks it again
// before offering it).
//
// An operator key that pays its apps' leases from their gas reserves is EIP-7702-delegated to EnclaveLeaseExecutor,
// which has no payable entry: a plain transfer to it runs that code and reverts. ETH still reaches it without running
// its code as the balance of a contract that destroys itself in favour of the key. So the step is a contract creation
// whose whole init code is PUSH20 <operator> SELFDESTRUCT, carrying the amount: nothing is deployed (the contract is
// gone in the same transaction) and the delegation, nonce and storage of the key are untouched.
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const balanceCall = (a) => ({ to: MULTICALL3, data: '0x4d2301cc' + a.slice(2).toLowerCase().padStart(64, '0') }); // getEthBalance(address)
export const forcedTransferData = (operator) => '0x73' + operator.slice(2).toLowerCase() + 'ff';
export const DELEGATION = /^0xef0100[0-9a-f]{40}$/;

// The transaction as the wallet will send it: { to?, data, value }.
// Simulates it from `owner` on every RPC (eth_simulateV1: balance before, the transaction, balance after) and returns
// the gas it used; throws unless each RPC shows the operator's balance rising by exactly the value.
export async function simulateTopup(rpcs, owner, operator, tx) {
  let gas = 0n;
  for (const url of rpcs) {
    const pub = createPublicClient({ chain: base, transport: http(url, { timeout: 15000 }) });
    const [{ calls }] = await pub.request({ method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [
      { from: owner, ...balanceCall(operator) }, { from: owner, ...tx }, { from: owner, ...balanceCall(operator) }] }] }, 'latest'] });
    if (calls.length !== 3 || calls.some((c) => c.status !== '0x1')) throw new Error(`${new URL(url).host}: the transfer would revert`);
    if (BigInt(calls[2].returnData) - BigInt(calls[0].returnData) !== BigInt(tx.value)) throw new Error(`${new URL(url).host}: the operator's balance would not rise by the amount`);
    if (BigInt(calls[1].gasUsed) > gas) gas = BigInt(calls[1].gasUsed);
  }
  return gas;
}
