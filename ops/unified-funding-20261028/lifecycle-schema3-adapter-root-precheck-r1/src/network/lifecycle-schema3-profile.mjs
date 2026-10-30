// schema3 r1 (SOURCE ONLY, not production-qualified): the pure pieces of the explicit 'independent-schema3-r1' adapter profile.
// Imported by the generated network/deployment-chain-adapter.mjs; only ever exercised when pins.profile === SCHEMA3_PROFILE.
//
// Trust boundary (unchanged from network/lifecycle-linked-artifacts.mjs): the bundle is the reviewed local unlinked compiler
// output, accepted only at the SHA-256 embedded in the generated adapter; the concrete addresses, code hashes and immutable
// TARGETS are reviewed pins. Nothing here authenticates a chain read: verifySchema3AtBlock is called INSIDE the adapter's one
// authenticated snapshot (beside the whole recursive r6 closure) and the adapter applies the authority's evidence rules.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { getAddress, keccak256 } from 'viem';
import { resolveRuntime, dependencies, verifyLinkedLifecycleCode } from './lifecycle-linked-artifacts.mjs';

export const SCHEMA3_PROFILE = 'independent-schema3-r1';
export const SCHEMA3_COMPILER = '0.8.35+commit.47b9dedd.Linux.g++';
export const SCHEMA3_SOURCES = Object.freeze({
  'candidate/deploy/EnclaveDeployments.sol': 'c720f1bfe021abcc4f080a5646d756c60a14cd2be8b746d995e3d1ba8b21da15',
  'candidate/deploy/EnclaveProofOfTime.sol': '946f0b90db1597ee95316029f467b8c7588e962c72168e78da77d3886f72eec5',
  'contracts/EnclaveDeploymentLifecycleEmergency.sol': 'ac4023b9ccac9b6b48536f78f07282e8a08e6669bd983bb292bbe1ea8a8ea677',
  'contracts/EnclaveSelfHostingIdentity.sol': 'f8dae9aba6c6ada4e92f9327fbb8801ae4bd15c645b0cea9a448a7f1bb1682e2' });
// FIXED role -> bundle artifact mapping (pins cannot reassign roles); role names are the r6 pins.contracts names
export const SCHEMA3_ROLES = Object.freeze({
  ledger: 'candidate/deploy/EnclaveDeployments.sol:EnclaveDeployments',
  accountingLibrary: 'candidate/deploy/EnclaveDeployments.sol:EnclaveLifecycleAccounting',
  proofOfTime: 'candidate/deploy/EnclaveProofOfTime.sol:EnclaveProofOfTime',
  lifecycle: 'contracts/EnclaveDeploymentLifecycleEmergency.sol:EnclaveDeploymentLifecycleEmergency',
  identity: 'contracts/EnclaveSelfHostingIdentity.sol:EnclaveSelfHostingIdentity' });
// the exact multiset of concrete immutable targets per role (the compiler names immutables by AST id only; the resolved-runtime
// hash then binds each id to its target). 'uint64' = one reviewed literal 'uint64:<n>' (prover maxProofWindowSec).
export const SCHEMA3_IMMUTABLE_TARGETS = Object.freeze({ ledger: ['registry', 'usdc'], lifecycle: ['l1Oracle', 'ledger'],
  proofOfTime: ['ledger', 'lifecycle', 'registry', 'uint64'], identity: [], accountingLibrary: [] });
const REQUIRED_FUNCTIONS = Object.freeze({
  lifecycle: ['assignments', 'budgets', 'ledger', 'l1Oracle', 'digest', 'transition', 'spendable', 'witnessesOf', 'threshold', 'maxAnchorAgeSec',
    'ownerAuthority', 'offline', 'lastEmergency', 'emergencyOffline', 'emergencyDigest', 'reconcileOffline', 'settlementAck'],
  ledger: ['lifecycleSchema', 'lifecycleOwner', 'lifecycleOperator', 'lifecycleFunded', 'lifecycleController', 'selfHostingIdentity', 'registry',
    'deploymentsSchema', 'owner', 'pendingOwner', 'get', 'rateFor', 'retired', 'prover', 'lifecycleStart', 'lifecycleEndAt', 'lifecycleEnd'],
  proofOfTime: ['deployments', 'registry', 'lifecycle', 'owner', 'pendingOwner', 'proofSchema', 'lifecycleProofSchema', 'proofWindowSec', 'maxProofWindowSec'],
  identity: ['principal'] });
const HASH = /^0x[0-9a-f]{64}$/, ZERO_ADDR = `0x${'0'.repeat(40)}`, ZERO32 = `0x${'0'.repeat(64)}`;
const lower = a => String(a).toLowerCase();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Real contract dependencies that still prevent full independence on the QUALIFIED schema-3 code (bundle sources above).
// The r3 global-retirement veto blocker is NOT repeated: schema-3 EnclaveDeployments.retire() is one-way discovery metadata
// (no start/service/funding veto, no third-party cancel/refund). Every remaining power below is reported, not removed.
export const SCHEMA3_BLOCKERS = Object.freeze([
  'EnclaveDeployments owner retains future-economics/admin powers: setClaimBond + slashBond (collateral), setProofRequiredFrom (payment proof cutover), setEthUsdFeed, setPayout, setRunnerBps, setMaxGpuMilli/setMaxFee, the import window until sealImports, and setOwner/acceptOwnership. owner/pendingOwner outside the reviewed sets denies new starts on every host (adminChanged); reads, queue/stop and reconciliation continue.',
  'EnclaveProofOfTime owner may change proofWindowSec within the immutable maxProofWindowSec; proofOfTime owner/pendingOwner remain reviewed admin sets (a change denies new starts).',
  'every other reviewed closure admin set denies new starts on change, as in r6; secretVaultV2.enclaveOwner is an external platform custody address, verified as pinned, not reviewed for independence.',
  'emergencyOffline is PER DEPLOYMENT (witness quorum of that deployment). Host-wide registry offline is NOT implemented (separate peer contract under audit); this adapter neither submits emergencyOffline/reconcileOffline nor sponsors a reporter; the Base L1 reimbursement component is unpriced.',
  'host ownership comes only from EnclaveHostOwnership.authority; a registry payoutWallet is pricing/payout routing, never an accepted host owner. Registry writer authority and bootstrap are not qualified here.',
  'no recurring on-chain renew/heartbeat exists or is added; paid-service proof accounting (EnclaveProofOfTime checkpoints -> creditProven) is separate and not performed by this adapter.',
  'a start intent whose relay response was lost and which is revoked by emergencyOffline before resolution reads as inconsistent (never confirmed/finalized): it needs operator recovery; no proof is synthesized.',
]);
const HOST_OFFLINE = Object.freeze({ registryOffline: 'not-implemented', note: 'per-deployment emergencyOffline is not host-registry offline' });

export const isSchema3Profile = pins => pins?.profile === SCHEMA3_PROFILE;

/** Exact reviewed bundle bytes -> parsed bundle (sources/compiler/settings/artifacts/EIP-170 checked). Pure. */
export function validateSchema3Bundle(bytes, expectedSha256) {
  if (!/^[0-9a-f]{64}$/.test(String(expectedSha256))) throw Error('schema3 bundle sha256 pin required');
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== expectedSha256) throw Error(`schema3 bundle ${got} is not the pinned ${expectedSha256}`);
  const b = JSON.parse(Buffer.from(bytes).toString('utf8')), s = b.settings ?? {};
  if (b.schema !== 1 || b.compiler !== SCHEMA3_COMPILER || s.viaIR !== true || s.evmVersion !== 'prague' || s.optimizer?.enabled !== true || s.optimizer?.runs !== 1)
    throw Error('schema3 bundle compiler/settings differ from the reviewed build');
  if (!same(Object.keys(b.sourceSha256 ?? {}).sort(), Object.keys(SCHEMA3_SOURCES).sort()) || Object.entries(SCHEMA3_SOURCES).some(([k, v]) => b.sourceSha256[k] !== v))
    throw Error('schema3 bundle sources are not the qualified schema-3 sources');
  if (!same(Object.keys(b.contracts ?? {}).sort(), Object.values(SCHEMA3_ROLES).sort())) throw Error('schema3 bundle artifacts differ');
  for (const [role, key] of Object.entries(SCHEMA3_ROLES)) {
    const a = b.contracts[key], n = (String(a.runtimeTemplate).length - 2) / 2;
    if (a.kind !== (role === 'accountingLibrary' ? 'library' : 'contract')) throw Error(`schema3 bundle ${key} kind differs`);
    if (!n || n > 24576 || a.runtimeBytes !== n) throw Error(`schema3 bundle ${key} runtime is empty or exceeds EIP-170`);
    if (!same(dependencies(a), role === 'ledger' ? [SCHEMA3_ROLES.accountingLibrary] : [])) throw Error(`schema3 bundle ${key} library links differ`);
    for (const f of REQUIRED_FUNCTIONS[role] ?? []) if (!a.abi.some(x => x.type === 'function' && x.name === f)) throw Error(`schema3 ${role} ABI lacks ${f}`);
  }
  for (const e of ['Transitioned', 'TransitionPaid', 'OfflineRecorded', 'OfflineSettled'])
    if (!b.contracts[SCHEMA3_ROLES.lifecycle].abi.some(x => x.type === 'event' && x.name === e)) throw Error(`schema3 controller ABI lacks event ${e}`);
  return b;
}
const cache = new Map();
export function loadSchema3Bundle(expectedSha256, url = new URL('../deploy/lifecycle/schema3/bundle.json', import.meta.url)) {
  const k = `${expectedSha256}|${url}`;
  if (!cache.has(k)) cache.set(k, validateSchema3Bundle(fs.readFileSync(url), expectedSha256));
  return cache.get(k);
}

function word(target, C, role) {
  const m = /^uint64:(0|[1-9][0-9]{0,19})$/.exec(target);
  if (m) { const n = BigInt(m[1]); if (n <= 0n || n >= 2n ** 64n) throw Error(`pins.schema3.immutables.${role}: ${target} out of range`); return `0x${n.toString(16).padStart(64, '0')}`; }
  if (!C[target]) throw Error(`pins.schema3.immutables.${role}: ${target} is not a code-pinned contract`);
  return `0x${'0'.repeat(24)}${getAddress(C[target].address).slice(2).toLowerCase()}`;
}

/** Static profile validation at adapter construction. Throws on any missing/extra/wrong link, immutable or self binding. */
export function prepareSchema3(pins, bundleSha256, { bundle = loadSchema3Bundle(bundleSha256) } = {}) {
  const s3 = pins?.schema3, C = pins?.contracts ?? {};
  if (!s3 || typeof s3 !== 'object' || Array.isArray(s3)) throw Error(`pins.schema3 required by ${SCHEMA3_PROFILE}`);
  for (const k of Object.keys(s3)) if (k !== 'immutables') throw Error(`pins.schema3.${k} is not known`);
  for (const k of [...Object.keys(SCHEMA3_ROLES), 'registry', 'usdc', 'l1Oracle']) if (!C[k]) throw Error(`pins.contracts.${k} required by ${SCHEMA3_PROFILE}`);
  if (C.accountingLibrary.abi !== undefined || C.accountingLibrary.bindings !== undefined) throw Error('pins.contracts.accountingLibrary is a pure code pin (no ABI/bindings)');
  if (C.proofOfTime.abi !== 'proofOfTime') throw Error('pins.contracts.proofOfTime must keep the reviewed proofOfTime closure ABI');
  const imm = s3.immutables;
  if (!imm || typeof imm !== 'object' || !same(Object.keys(imm).sort(), Object.keys(SCHEMA3_ROLES).sort())) throw Error('pins.schema3.immutables must name exactly the five schema-3 roles');
  const bindings = {}, addresses = {}, seen = new Set();
  for (const [role, key] of Object.entries(SCHEMA3_ROLES)) {
    const art = bundle.contracts[key], want = imm[role];
    if (!want || typeof want !== 'object' || Array.isArray(want)) throw Error(`pins.schema3.immutables.${role} must be an object`);
    const ids = Object.keys(art.immutableReferences ?? {}).filter(id => !(art.kind === 'library' && id === 'library_deploy_address')).sort();
    if (!same(Object.keys(want).sort(), ids)) throw Error(`pins.schema3.immutables.${role} must name exactly the compiler immutable ids [${ids.join(',')}]`);
    if (Object.values(want).some(t => typeof t !== 'string')) throw Error(`pins.schema3.immutables.${role} target malformed`);
    const targets = Object.values(want).map(t => (t.startsWith('uint64:') ? 'uint64' : t)).sort();
    if (!same(targets, [...SCHEMA3_IMMUTABLE_TARGETS[role]].sort())) throw Error(`pins.schema3.immutables.${role} targets must be exactly [${SCHEMA3_IMMUTABLE_TARGETS[role].join(',')}]`);
    if (!HASH.test(C[role].codeHash || '')) throw Error(`pins.contracts.${role}.codeHash required`);
    addresses[role] = getAddress(C[role].address);
    if (addresses[role] === getAddress(ZERO_ADDR) || seen.has(addresses[role])) throw Error(`pins.contracts.${role} address is zero or duplicated`);
    seen.add(addresses[role]);
    bindings[key] = { address: addresses[role], codeHash: C[role].codeHash, immutables: Object.fromEntries(Object.entries(want).map(([id, t]) => [id, word(t, C, role)])) };
  }
  // every runtime resolved from the reviewed template with ITS pinned library address, concrete immutables and (library) its own
  // deployed address at the compiler's library_deploy_address range must be exactly the pinned code hash
  for (const [role, key] of Object.entries(SCHEMA3_ROLES)) {
    const art = bundle.contracts[key], libraries = Object.fromEntries(dependencies(art).map(k => [k, bindings[k].address]));
    const code = resolveRuntime(art, { address: bindings[key].address, libraries, immutables: bindings[key].immutables });
    if ((code.length - 2) / 2 > 24576) throw Error(`${role} resolved runtime exceeds EIP-170`);
    if (keccak256(code) !== bindings[key].codeHash) throw Error(`pins.contracts.${role}.codeHash is not the reviewed ${key} runtime resolved with its pinned library/immutable/self bindings`);
  }
  const linkedProfile = { chainId: 8453, lifecycleSchema: 3, lifecycleProofSchema: 2, bindings, registry: getAddress(C.registry.address),
    registryCodeHash: C.registry.codeHash, roles: { ledger: SCHEMA3_ROLES.ledger, controller: SCHEMA3_ROLES.lifecycle,
      identity: SCHEMA3_ROLES.identity, prover: SCHEMA3_ROLES.proofOfTime } };
  const abi = Object.freeze(Object.fromEntries(Object.entries(SCHEMA3_ROLES).map(([role, key]) => [role, bundle.contracts[key].abi])));
  return Object.freeze({ bundle, bundleSha256, linkedProfile, abi, addresses: Object.freeze(addresses) });
}

/** INSIDE the adapter's pinned snapshot callback, same client and block as the r6 closure. */
export async function verifySchema3AtBlock(p, client, blockNumber) {
  const r = await verifyLinkedLifecycleCode({ client, blockNumber, bundle: p.bundle, profile: p.linkedProfile });
  if (r?.codePinsVerified !== true || r.libraryCount !== 1 || r.blockNumber !== blockNumber) throw Error('schema3 linked code verification incomplete');
  const read = (role, functionName) => client.readContract({ address: p.addresses[role], abi: p.abi[role], functionName, args: [], blockNumber });
  if (await read('proofOfTime', 'proofSchema') !== 2n) throw Error('prover proofSchema is not 2');
  if (getAddress(await read('lifecycle', 'ledger')) !== p.addresses.ledger) throw Error('controller ledger differs from the schema-3 pair');
  return r;
}

/** The controller's offline(id) tuple at the snapshot block -> exposed state; fails closed on any inconsistency with the assignment. */
export function schema3Emergency(offline, lastEmergency, a) {
  if (!Array.isArray(offline) || offline.length !== 6) throw Error('controller offline tuple malformed: state unknown');
  const [runGeneration, cutoff, stopped, pending, host, operator] = offline;
  if (typeof runGeneration !== 'bigint' || typeof cutoff !== 'bigint' || typeof stopped !== 'boolean' || typeof pending !== 'boolean' || !HASH.test(lower(host)))
    throw Error('controller offline tuple malformed: state unknown');
  const e = { scope: 'deployment', pending, runGeneration: Number(runGeneration), cutoff: Number(cutoff), stopped, host: lower(host),
    operator: getAddress(operator), lastEmergency: lastEmergency == null ? null : lower(lastEmergency) };
  // the controller forbids every transition/configure/resume while pending, so a pending record must be the revoked run of
  // exactly the previous generation, with the recorded stop flag; anything else is unknown state, never a guess
  if (pending && (e.operator === getAddress(ZERO_ADDR) || e.host === ZERO32 || !['queued', 'stopped'].includes(a?.state) ||
      a.generation !== e.runGeneration + 1 || (a.state === 'stopped') !== stopped))
    throw Error('pending emergency offline record is inconsistent with the authenticated assignment: state unknown');
  return Object.freeze({ ...e,
    settlement: pending ? 'pending: permissionless reconcileOffline(id) must apply the exact recorded cutoff' : 'none pending',
    newAdmission: pending ? 'denied until settled (no fresh funding horizon, no transition)' : 'not affected' });
}

export function schema3Fields(v, s3) {
  return { profile: SCHEMA3_PROFILE, lifecycleSchema: 3, lifecycleProofSchema: 2, emergency: s3, hostOffline: HOST_OFFLINE,
    ledgerState: Object.freeze({ retired: v.retired === true,
      retirement: 'metadata-only (qualified schema-3 retire(): no start/service/funding veto, no third-party cancel/refund)' }),
    independence: Object.freeze({ complete: false, blockers: SCHEMA3_BLOCKERS }) };
}
export const schema3AdapterFields = p => ({ profile: SCHEMA3_PROFILE, lifecycleSchema: 3, lifecycleProofSchema: 2, bundleSha256: p.bundleSha256,
  independence: Object.freeze({ complete: false, blockers: SCHEMA3_BLOCKERS }) });
