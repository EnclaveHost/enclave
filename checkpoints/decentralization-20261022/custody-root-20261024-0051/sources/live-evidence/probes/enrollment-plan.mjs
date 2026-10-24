// READ-ONLY. The pre-handover requirement for the live custody seat: host metal0 (registry id 0x4dde…, the host of
// https://api.enclave.host/t/custody-metal0) enrolls accepted ownership by the Enclave wallet on the EXISTING
// EnclaveHostOwnership 0xbbd885d3…. Prepares the two UNSIGNED transactions and simulates each with eth_call at one
// agreed block (the second with a state override standing in for the first). No signature, no send.
import fs from 'node:fs';
import { encodeFunctionData, decodeFunctionResult, keccak256, encodeAbiParameters, pad } from 'viem';
import { pinBlock, codeAt, agree, rpc, LIVE } from '../lib/live.mjs';

const OWNERSHIP = '0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7';
const REGISTRY = '0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac';
const HOST_ID = '0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be';
const ENCLAVE = '0x0b2d009c0c9af05b12100d77f3c815fea822ee61';
const VAULT = '0xe48699b8401564aace7a814ae4569b67a3f7eef5', CID = '0x47742ae8c544ff66a4ad91cfbf5cecdd389013da362813ba3b55c4e247b0f7a3';
const OWN_ABI = [
  { type: 'function', name: 'proposeOwner', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [] },
  { type: 'function', name: 'acceptOwner', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'authority', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint64' }, { type: 'bytes32' }] },
  { type: 'function', name: 'registry', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];
const REG_ABI = [{ type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
  { name: 'endpoint', type: 'string' }, { name: 'repo', type: 'string' }, { name: 'measurement', type: 'bytes32' }, { name: 'operator', type: 'address' },
  { name: 'registeredAt', type: 'uint64' }, { name: 'lastSeen', type: 'uint64' }, { name: 'active', type: 'bool' },
  { name: 'cpuPricePerSec6', type: 'uint64' }, { name: 'gpuPricePerSec6', type: 'uint64' }, { name: 'proofKey', type: 'address' }, { name: 'payoutWallet', type: 'address' }] }] }];
const VAULT_ABI = [{ type: 'function', name: 'committeeOf', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bytes' }, { type: 'uint32' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'uint64' }] }];

const block = await pinBlock();
const tag = '0x' + block.number.toString(16);
const call = (to, abi, fn, args = [], from) => agree('eth_call', [{ to, data: encodeFunctionData({ abi, functionName: fn, args }), ...(from ? { from } : {}) }, tag])
  .then((r) => decodeFunctionResult({ abi, functionName: fn, data: r }));
// a simulation: success or the revert reason, from EVERY live endpoint (they must agree)
async function simulate(tx, override = null) {
  const out = await Promise.all(LIVE.state.map(async (u) => {
    try { await rpc(u, 'eth_call', override ? [tx, tag, override] : [tx, tag], { tries: 2 }); return 'success'; }
    catch (e) { const m = String(e.message); return /not proposed owner|not active operator|not owner|owner required|revert/i.test(m) ? 'revert: ' + (m.match(/(not proposed owner|not active operator|not owner|owner required)/)?.[1] || 'reverted') : 'error: ' + m.slice(0, 160); }
  }));
  return { endpoints: LIVE.state.map((u) => new URL(u).host), results: out, agree: out.every((x) => x === out[0]) ? out[0] : null };
}

const ownCode = await codeAt(block, OWNERSHIP);
if (keccak256(ownCode)!=='0xe38a0e160dd929c366bccd30636285458c288ada475f1b74ffc3289febf1d5dd') throw Error('Ownership runtime changed');
const [ownRegistry] = [await call(OWNERSHIP, OWN_ABI, 'registry')];
const authority = await call(OWNERSHIP, OWN_ABI, 'authority', [HOST_ID]);
const [entry] = [await call(REGISTRY, REG_ABI, 'get', [HOST_ID])];
const committee = await call(VAULT, VAULT_ABI, 'committeeOf', [CID]);
const operator = entry.operator.toLowerCase();

if(ownRegistry.toLowerCase()!==REGISTRY || !entry.active || operator!=='0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab' || entry.payoutWallet.toLowerCase()!==ENCLAVE || authority[0]!== '0x0000000000000000000000000000000000000000' || authority[1]!== '0x0000000000000000000000000000000000000000') throw Error('Enrollment preconditions changed');
const tx1 = { chainId: 8453, to: OWNERSHIP, value: '0x0', data: encodeFunctionData({ abi: OWN_ABI, functionName: 'proposeOwner', args: [HOST_ID, ENCLAVE] }), from: operator,
  signer: 'the metal0 registry operator (the host operator key; it is not the Enclave admin wallet)', function: `proposeOwner(${HOST_ID}, ${ENCLAVE})` };
const tx2 = { chainId: 8453, to: OWNERSHIP, value: '0x0', data: encodeFunctionData({ abi: OWN_ABI, functionName: 'acceptOwner', args: [HOST_ID] }), from: ENCLAVE,
  signer: 'the Enclave admin wallet 0x0b2d… (the vault enclaveOwner and address-book owner)', function: `acceptOwner(${HOST_ID})`, after: 'tx1 is mined' };
// authority mapping is slot 0; Authority{owner; pendingOwner, revision (packed); policyHash}: pendingOwner is the low 20 bytes of base+1
const base = BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [HOST_ID, 0n])));
const slot1 = '0x' + (base + 1n).toString(16).padStart(64, '0');
const current1 = await agree('eth_getStorageAt', [OWNERSHIP, slot1, tag]);
const override = { [OWNERSHIP]: { stateDiff: { [slot1]: pad(ENCLAVE, { size: 32 }) } } };

const result = {
  purpose: 'pre-handover requirement: enroll accepted host-wallet ownership of the live custody seat\'s host (metal0) by the Enclave wallet; UNSIGNED, simulated only',
  block: String(block.number), blockHash: block.hash,
  preconditions: {
    ownershipContract: OWNERSHIP, ownershipCodeHash: keccak256(ownCode), ownershipRegistry: ownRegistry.toLowerCase(),
    hostId: HOST_ID, hostEndpoint: entry.endpoint, hostActive: entry.active, hostOperator: operator, payoutWallet: entry.payoutWallet.toLowerCase(),
    payoutIsEnclave: entry.payoutWallet.toLowerCase() === ENCLAVE,
    authorityNow: { owner: authority[0].toLowerCase(), pendingOwner: authority[1].toLowerCase(), revision: String(authority[2]), policyHash: authority[3] },
    pendingSlot: { slot: slot1, value: current1 },
    liveCommittee: { committeeId: CID, epoch: Number(committee[1]), t: Number(committee[2]), W: Number(committee[3]) },
  },
  unsigned: [tx1, tx2],
  simulations: {
    tx1_from_operator: await simulate({ from: operator, to: OWNERSHIP, data: tx1.data }),
    tx1_from_enclave_wallet_must_revert: await simulate({ from: ENCLAVE, to: OWNERSHIP, data: tx1.data }),
    tx2_before_tx1_must_revert: await simulate({ from: ENCLAVE, to: OWNERSHIP, data: tx2.data }),
    tx2_after_tx1_state_override: await simulate({ from: ENCLAVE, to: OWNERSHIP, data: tx2.data }, override),
  },
  effect: 'after both: authority(hostId).owner = Enclave wallet, revision 1, policyHash 0 (no local host policy). The vault is untouched: its seat flag stays payout-based (payout == Enclave wallet), so owner and seat flag AGREE and the candidate runtime admits the seat into a future epoch. The live epoch, its share, bundle and policy are unaffected by these two transactions.',
  notSent: true,
};
if(result.simulations.tx1_from_operator.agree!=='success'||result.simulations.tx2_after_tx1_state_override.agree!=='success'||!result.simulations.tx1_from_enclave_wallet_must_revert.agree?.startsWith('revert:')||!result.simulations.tx2_before_tx1_must_revert.agree?.startsWith('revert:'))throw Error('Enrollment simulations did not agree');
fs.writeFileSync(new URL('../evidence/metal0-enrollment-unsigned-20261023.json', import.meta.url), JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n');
console.log(JSON.stringify({ block: result.block, preconditions: { ...result.preconditions, ownershipCodeHash: result.preconditions.ownershipCodeHash.slice(0, 18) }, simulations: Object.fromEntries(Object.entries(result.simulations).map(([k, v]) => [k, v.agree ?? v.results])) }, null, 1));
