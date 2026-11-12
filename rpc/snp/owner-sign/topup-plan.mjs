// Write PLAN.json for owner-sign/server.mjs: one transaction from the owner's wallet that gives ETH on Base to a
// fleet host's operator key.
//
//   node rpc/snp/owner-sign/topup-plan.mjs OWNER ENCLAVE_ID AMOUNT_ETH JOURNAL OUT_PLAN.json
//
// The recipient is not an argument: it is the operator the registry records for ENCLAVE_ID. That key pays the host's
// own transactions: the registry transaction every start of its supervisor needs (register or setProofKey; until it
// lands the host neither claims nor renews) and the proof-of-time checkpoints. Lease claims and renewals are paid
// from the apps' gas, not from this key.
// A key with no code gets a plain transfer. A key delegated (EIP-7702) to code that refuses a plain transfer gets the
// forced transfer of topup.mjs. Either way the plan is written only if both RPCs simulate the operator's balance
// rising by exactly the amount.
import fs from 'node:fs';
import { createPublicClient, fallback, formatEther, getAddress, http, parseEther } from 'viem';
import { base } from 'viem/chains';
import { DELEGATION, forcedTransferData, simulateTopup } from './topup.mjs';

const REGISTRY = '0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac';
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const REG_GET = [{ type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
  { name: 'endpoint', type: 'string' }, { name: 'repo', type: 'string' }, { name: 'measurement', type: 'bytes32' },
  { name: 'operator', type: 'address' }, { name: 'registeredAt', type: 'uint64' }, { name: 'lastSeen', type: 'uint64' },
  { name: 'active', type: 'bool' }, { name: 'cpuPricePerSec6', type: 'uint64' }, { name: 'gpuPricePerSec6', type: 'uint64' },
  { name: 'proofKey', type: 'address' }, { name: 'payoutWallet', type: 'address' }] }] }];

const [ownerArg, enclaveId, amountEth, journal, outPath] = process.argv.slice(2);
if (!/^0x[0-9a-f]{64}$/.test(enclaveId || '') || !outPath) throw new Error('usage: topup-plan.mjs OWNER ENCLAVE_ID AMOUNT_ETH JOURNAL OUT_PLAN.json');
const owner = getAddress(ownerArg), value = parseEther(amountEth);
if (value <= 0n || value > parseEther('0.05')) throw new Error('amount out of range (0 < amount <= 0.05 ETH)');
const pub = createPublicClient({ chain: base, transport: fallback(RPCS.map((u) => http(u, { timeout: 15000 }))) });

const entry = await pub.readContract({ address: REGISTRY, abi: REG_GET, functionName: 'get', args: [enclaveId] });
if (/^0x0+$/.test(entry.operator) || !entry.active) throw new Error('the registry has no active host under this id');
const operator = getAddress(entry.operator);
const [code, ownerBal, operatorBal] = await Promise.all([pub.getCode({ address: operator }), pub.getBalance({ address: owner }), pub.getBalance({ address: operator })]);
if (code && !DELEGATION.test(code)) throw new Error('the operator is a contract, not a key');
if (ownerBal <= value) throw new Error(`the owner holds ${formatEther(ownerBal)} ETH on Base, not enough to send ${amountEth}`);

const hexValue = '0x' + value.toString(16), plain = { to: operator, data: '0x', value: hexValue };
const plainWorks = await pub.call({ account: owner, to: operator, value }).then(() => true, () => false);
const tx = plainWorks ? plain : { data: forcedTransferData(operator), value: hexValue };
const gas = await simulateTopup(RPCS, owner, operator, tx);

const WHY = 'The host’s operator key pays the registry transaction that every start of its supervisor needs (until it lands the host neither claims nor renews its apps) and the proof-of-time checkpoints. It only ever pays gas. Lease claims and renewals are paid from the apps’ gas, not from this key.';
const FORCED = ' The key is delegated (EIP-7702) to the lease executor, which refuses a plain transfer, so the wallet will show a contract creation instead: its data is 73, then the recipient’s address, then ff, which hands the amount to that address and leaves nothing deployed.';
const plan = {
  kind: 'topup', title: `Top up the operator key of ${entry.endpoint.replace(/^.*\//, '')}`,
  lead: 'One transaction from your wallet on Base. Check the amount and the data on the Trezor screen before confirming. This page never signs or sends anything by itself.',
  chainId: 8453, owner, rpcs: RPCS, journal,
  status: { operator },
  steps: [{
    id: 'topup', title: `Send ${formatEther(value)} ETH to the operator key`, why: WHY + (plainWorks ? '' : FORCED),
    to: tx.to || null, data: tx.data, value: hexValue, valueEth: formatEther(value), gas: '0x' + (gas * 3n / 2n).toString(16),
    show: { Host: entry.endpoint, 'Host id': enclaveId, Recipient: operator + ' (the operator the registry records for this host)',
      Amount: formatEther(value) + ' ETH', Network: 'Base (chain 8453)',
      ...(plainWorks ? { Call: 'none: a plain transfer, no data' } : { Delegate: '0x' + code.slice(8) + ' (no payable entry: a plain transfer reverts)', Data: tx.data,
        Simulated: `on ${RPCS.length} RPCs the recipient’s balance rises by exactly the amount; ${gas} gas` }) },
  }],
};
fs.writeFileSync(outPath, JSON.stringify(plan, null, 1) + '\n');
console.log(JSON.stringify({ wrote: outPath, operator, delegatedTo: code ? '0x' + code.slice(8) : null, transfer: plainWorks ? 'plain' : 'forced', gas: String(gas),
  valueEth: formatEther(value), operatorBalanceEth: formatEther(operatorBal), ownerBalanceEth: formatEther(ownerBal) }));
