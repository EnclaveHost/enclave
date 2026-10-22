// READ-ONLY custody evidence at one agreed Base block (allowlisted public RPCs; both must return identical bytes).
// Prints/stores only public chain data: no bundle bytes (lengths only), no keys, no credentials.
import fs from 'node:fs';
import { keccak256, parseAbi, stringToHex, decodeEventLog } from 'viem';
import { pinBlock, readMany, codeAt, logs, agree } from '../../ledger17-migration/lib/live.mjs';
const ORIG = '0xE48699B8401564aaCe7A814AE4569b67a3F7eEF5', MOD = '0x56b81b3970a8ac2c52f9874Bd2758eDE30758228', V1 = '0x08074300F75e78212Ae10eBd14984f78e17811A6';
const BOOK = '0xab214342d5A490150A4A977063A2f88E21F80907', HO_ACTIVE = '0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7', HO_ALT = '0xF5E9E6C02449001f6E8e95E5d87413f2cb6790ea';
const V = parseAbi(['function book() view returns (address)', 'function enclaveOwner() view returns (address)', 'function hostOwnership() view returns (address)',
  'function hostRegistry() view returns (address)', 'function deploymentLedger() view returns (address)', 'function sessionVaultFactory() view returns (address)',
  'function committeeOf(bytes32) view returns (bytes Y, uint32 epoch, uint8 t, uint8 W, uint64 activatedAt)',
  'function machinesOf(bytes32,uint32) view returns ((address identity,bytes32 encKey,string endpoint,bytes32 chipId,bytes32 registryId,bytes32 measurement)[] machines, bool[] enclave)',
  'function pendingOf(bytes32) view returns (uint32 toEpoch, (address,bytes32,string,bytes32,bytes32,bytes32)[] next, bool[] enclave, uint8 t, uint8 W, uint32[] dealers, uint64 expires)',
  'function policyOf(bytes32) view returns (address owner, uint64 policyRev, uint64 secretRev, bytes32 committeeId, bool paused, bytes rules)',
  'function bundleOf(bytes32) view returns (bytes32 committeeId, uint64 secretRev, bytes bundle)', 'function beneficialOwnerOf(bytes32) view returns (address)',
  'event CommitteeCreated(bytes32 indexed committeeId, address indexed identity, bytes Y)', 'event HandoverProposed(bytes32 indexed committeeId, uint32 toEpoch, uint8 t, uint8 W, uint256 machines, uint64 expires)',
  'event EpochActivated(bytes32 indexed committeeId, uint32 epoch)', 'event CodeProposed(bytes32 indexed committeeId, bytes32 indexed measurement, uint64 activeAt)',
  'event CodeRemoved(bytes32 indexed committeeId, bytes32 indexed measurement)', 'event PolicyUpdated(bytes32 indexed id, address indexed owner, uint64 policyRev, bytes32 committeeId, bool paused)',
  'event BundlePut(bytes32 indexed id, uint64 secretRev, bytes32 committeeId, uint256 bundleBytes)', 'event BundleCleared(bytes32 indexed id, uint64 secretRev)',
  'event PolicyClaimed(bytes32 indexed id, address indexed previousOwner, address indexed newOwner, uint64 policyRev)',
  'event DealPosted(bytes32 indexed committeeId, uint32 toEpoch, uint32 dealerIndex, address dealer)', 'event HandoverAcked(bytes32 indexed committeeId, uint32 toEpoch, address machine, uint256 acks)']);
const BK = parseAbi(['function addr(bytes32) view returns (address)', 'function owner() view returns (address)']);
const REG = parseAbi(['function get(bytes32) view returns ((string endpoint,string repo,bytes32 measurement,address operator,uint64 registeredAt,uint64 lastSeen,bool active,uint64 cpuPricePerSec6,uint64 gpuPricePerSec6,address proofKey,address payoutWallet))']);
const HO = parseAbi(['function authority(bytes32) view returns (address owner, address pendingOwner, uint64 revision, bytes32 policyHash)', 'function registry() view returns (address)']);
const lc = (a) => String(a).toLowerCase();
const J = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const block = await pinBlock();
const out = { block: { number: block.number, hash: block.hash }, contracts: {} };
for (const [k, a] of Object.entries({ originalVaultV2: ORIG, modifiedVaultV2: MOD, vaultV1: V1, hostOwnershipActive: HO_ACTIVE, hostOwnershipAlt: HO_ALT, book: BOOK })) {
  const c = await codeAt(block, a); out.contracts[k] = { address: a, bytes: (c.length - 2) / 2, codeHash: c.length > 2 ? keccak256(c) : null };
}
const getters = ['book', 'enclaveOwner', 'hostOwnership', 'hostRegistry', 'deploymentLedger', 'sessionVaultFactory'];
for (const [k, a] of [['originalVaultV2', ORIG], ['modifiedVaultV2', MOD]]) {
  const r = await readMany(block, getters.map((n) => ({ address: a, abi: V, functionName: n, allowFailure: true })));
  out.contracts[k].getters = Object.fromEntries(getters.map((n, i) => [n, r[i].ok ? r[i].value : 'ABSENT (call reverts)']));
}
const keys = ['secretVaultV2', 'secretVault', 'sessionVaultFactory', 'registry', 'deployments', 'hostOwnership'];
const bk = await readMany(block, [...keys.map((k) => ({ address: BOOK, abi: BK, functionName: 'addr', args: [stringToHex(k, { size: 32 })] })), { address: BOOK, abi: BK, functionName: 'owner' }]);
out.book = { owner: bk[keys.length].value, entries: Object.fromEntries(keys.map((k, i) => [k, bk[i].value])) };
out.hostOwnershipRegistry = Object.fromEntries((await readMany(block, [HO_ACTIVE, HO_ALT].map((a) => ({ address: a, abi: HO, functionName: 'registry', allowFailure: true })))).map((r, i) => [[ 'active', 'alt'][i], r.ok ? r.value : null]));
// events of both vaults since the original's deployment (52613511)
const raw = await logs({ addresses: [ORIG, MOD], fromBlock: 52613511n, toBlock: block.number });
const ev = raw.map((l) => { try { const d = decodeEventLog({ abi: V, data: l.data, topics: l.topics }); return { vault: lc(l.address), name: d.eventName, args: d.args, block: l.blockNumber }; } catch { return { vault: lc(l.address), name: 'unknown', block: l.blockNumber }; } });
out.events = {}; for (const e of ev) { const k = e.vault === lc(ORIG) ? 'original' : 'modified'; (out.events[k] ||= {})[e.name] = ((out.events[k] || {})[e.name] || 0) + 1; }
const enclaveOwner = out.contracts.originalVaultV2.getters.enclaveOwner;
const registry = out.book.entries.registry;
// committees of the original vault
out.committees = [];
for (const cid of [...new Set(ev.filter((e) => e.vault === lc(ORIG) && e.name === 'CommitteeCreated').map((e) => e.args.committeeId))]) {
  const c = await readMany(block, [{ address: ORIG, abi: V, functionName: 'committeeOf', args: [cid] }, { address: ORIG, abi: V, functionName: 'pendingOf', args: [cid] }]);
  const [Y, epoch, t, W, activatedAt] = c[0].value;
  const [ms, enc] = await readMany(block, [{ address: ORIG, abi: V, functionName: 'machinesOf', args: [cid, epoch] }]).then((r) => r[0].value);
  const machines = [];
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    const r = await readMany(block, [{ address: registry, abi: REG, functionName: 'get', args: [m.registryId] }, { address: HO_ACTIVE, abi: HO, functionName: 'authority', args: [m.registryId], allowFailure: true },
      { address: HO_ALT, abi: HO, functionName: 'authority', args: [m.registryId], allowFailure: true }]);
    const e = r[0].value;
    machines.push({ identity: m.identity, endpoint: m.endpoint, registryId: m.registryId, measurement: m.measurement, enclaveFlagOnChain: enc[i],
      host: { endpoint: e.endpoint, active: e.active, operator: e.operator, payoutIsEnclaveOwner: lc(e.payoutWallet) === lc(enclaveOwner) },
      acceptedOwner: { activeInstance: r[1].ok ? r[1].value[0] : null, altInstance: r[2].ok ? r[2].value[0] : null } });
  }
  out.committees.push({ committeeId: cid, YBytes: (Y.length - 2) / 2, epoch, t, W, activatedAt, pendingToEpoch: c[1].value[0], machines });
}
// policies and bundles (lengths only)
out.policies = [];
for (const id of [...new Set(ev.filter((e) => e.vault === lc(ORIG) && ['PolicyUpdated', 'BundlePut', 'PolicyClaimed'].includes(e.name)).map((e) => e.args.id))]) {
  const r = await readMany(block, [{ address: ORIG, abi: V, functionName: 'policyOf', args: [id] }, { address: ORIG, abi: V, functionName: 'bundleOf', args: [id] }, { address: ORIG, abi: V, functionName: 'beneficialOwnerOf', args: [id], allowFailure: true }]);
  const [owner, policyRev, secretRev, committeeId, paused, rules] = r[0].value; const [bcid, bsr, bundle] = r[1].value;
  out.policies.push({ id, owner, policyRev, secretRev, committeeId, paused, rulesBytes: (rules.length - 2) / 2, bundle: { committeeId: bcid, secretRev: bsr, bytes: (bundle.length - 2) / 2 },
    beneficialOwnerNow: r[2].ok ? r[2].value : 'reverts', ownerMatchesLedger: r[2].ok ? lc(r[2].value) === lc(owner) : null });
}
fs.writeFileSync(new URL('../evidence/live-custody.json', import.meta.url), JSON.stringify(J(out), null, 1) + '\n');
console.log(JSON.stringify(J({ block: out.block, contracts: out.contracts, book: out.book, events: out.events, committees: out.committees.length, policies: out.policies.length })));
