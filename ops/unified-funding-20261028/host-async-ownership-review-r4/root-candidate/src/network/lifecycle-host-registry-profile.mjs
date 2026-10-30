// host-registry r2 (SOURCE ONLY, not production-qualified): the pure pieces of the explicit 'independent-host-registry-r1' adapter
// profile. Imported by the generated network/deployment-chain-adapter.mjs; only exercised when pins.profile === HOST_REGISTRY_PROFILE.
//
// The profile is independent-schema3-r1 (every schema-3 bundle/link/immutable/closure/admin check retained) PLUS ONE canonical
// EnclaveHostLifecycleRegistry that is BOTH the `registry` and the `hostOwnership` role: one address, one runtime, so the row,
// derived `active`, lifecycle status/generation/qualification, accepted owner/revision/policy and reporter policy all come from one
// contract at the adapter's ONE authenticated block. A separate or legacy ownership contract is refused even when its supplied
// code hash is internally consistent. The canonical registry has no ownership `registry()` getter and none is read.
//
// Trust boundary: the artifact is the reviewed local Forge output, accepted only at the SHA-256 below and only together with the
// exact source whose SHA-256 and metadata keccak256 it names. The runtime pin is code identity, NOT independent Base authority:
// the injected finality authority still decides whether a block is qualified (the snapshot's top-level `verified`). The nested
// hostLifecycle therefore carries `codeConsistent` (runtime/schema/feature/authority-tuple consistency at that block) and NEVER a
// nested `verified` (repair r1: an unqualified rpc-quorum snapshot must not look verified through a nested field).
// uint64 values (generation, timestamps, revisions) are exact decimal strings (repair r1: no Number() rounding).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { getAddress, keccak256, toBytes } from 'viem';

export const HOST_REGISTRY_PROFILE = 'independent-host-registry-r1';
export const HOST_REGISTRY_ARTIFACT_SHA256 = 'e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a';
export const HOST_REGISTRY_SOURCE_SHA256 = '68310acc3bda76be0c7bf06ad5149ac1b354e3687f8268223bc8589457c071a8';
// compilationTarget/metadata source key of the qualified r2 build (absolute path as Forge recorded it; provenance, not a file read)
export const HOST_REGISTRY_SOURCE_KEY = '/home/steven/Documents/Codex/2026-10-23/it/work/lifecycle-host-registry-r1-20261029/candidate/contracts/EnclaveHostLifecycleRegistry.sol';
export const HOST_REGISTRY_CONTRACT = 'EnclaveHostLifecycleRegistry';
export const HOST_REGISTRY_COMPILER = '0.8.35+commit.47b9dedd';
export const HOST_REGISTRY_RUNTIME_BYTES = 23968, HOST_REGISTRY_INIT_BYTES = 23994;
export const HOST_REGISTRY_FEATURE = keccak256(toBytes('EnclaveHostLifecycleRegistry/feature/1'));
export const REGISTRY_SCHEMA = 5n, HOST_LIFECYCLE_SCHEMA = 1n;   // exact; never >=
const STATUS = Object.freeze(['none', 'online', 'offline']);
const HASH = /^0x[0-9a-f]{64}$/, ZERO_ADDR = `0x${'0'.repeat(40)}`;
const lower = a => String(a).toLowerCase();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = b => createHash('sha256').update(b).digest('hex');
const u64 = (v, what) => { if (typeof v !== 'bigint' || v < 0n || v >= 2n ** 64n) throw Error(`${what} is not a uint64: state unknown`); return v.toString(); };

// exact ABI shapes consumed (names AND types AND order): the schema-5 row, the authority() tuple of the old ownership contract,
// the lifecycle state and the reporter policy. A drift in any of them refuses the artifact.
const ROW = [['endpoint', 'string'], ['repo', 'string'], ['measurement', 'bytes32'], ['operator', 'address'], ['registeredAt', 'uint64'],
  ['lastSeen', 'uint64'], ['active', 'bool'], ['cpuPricePerSec6', 'uint64'], ['gpuPricePerSec6', 'uint64'], ['proofKey', 'address'],
  ['payoutWallet', 'address'], ['caps', 'uint64'], ['region', 'string']];
const OUTPUTS = Object.freeze({
  authority: [['owner', 'address'], ['pendingOwner', 'address'], ['revision', 'uint64'], ['policyHash', 'bytes32']],
  hostState: [['generation', 'uint64'], ['status', 'uint8'], ['changedAt', 'uint64'], ['qualificationExpiry', 'uint64'], ['hardwareId', 'bytes32'],
    ['descriptorDigest', 'bytes32'], ['qualificationDigest', 'bytes32'], ['resourceDigest', 'bytes32'], ['trustAnchorId', 'bytes32'],
    ['lastOfflineDigest', 'bytes32']],
  reporterPolicy: [['keys', 'address[]'], ['threshold', 'uint8'], ['revision', 'uint64']],
  registrySchema: [['', 'uint256']], hostLifecycleSchema: [['', 'uint256']], registryFeature: [['', 'bytes32']],
  STATUS_ONLINE: [['', 'uint8']], STATUS_OFFLINE: [['', 'uint8']] });
// legacy writer selectors that must be ABSENT: nothing can heartbeat, re-activate or self-register a row outside qualified enrollment
export const ABSENT_LEGACY = Object.freeze(['register', 'registerRelay', 'heartbeat', 'deregister', 'setMeasurement', 'setActive', 'reactivate', 'renew']);

const shape = outs => outs.map(o => [o.name, o.type]);
function fn(abi, name, inputs) {
  const f = abi.filter(x => x.type === 'function' && x.name === name);
  if (f.length !== 1 || !same(f[0].inputs.map(i => i.type), inputs) || f[0].stateMutability !== 'view' && f[0].stateMutability !== 'pure')
    throw Error(`host registry ABI: ${name}(${inputs.join(',')}) must be exactly one view`);
  return f[0];
}

/** Exact reviewed artifact bytes (+ optional exact source bytes) -> parsed artifact. Pure; throws on any provenance drift. */
export function validateHostRegistryArtifact(bytes, { sourceBytes = null } = {}) {
  const got = sha(bytes);
  if (got !== HOST_REGISTRY_ARTIFACT_SHA256) throw Error(`host registry artifact ${got} is not the pinned ${HOST_REGISTRY_ARTIFACT_SHA256}`);
  const a = JSON.parse(Buffer.from(bytes).toString('utf8')), m = a.metadata ?? {}, s = m.settings ?? {};
  if (m.compiler?.version !== HOST_REGISTRY_COMPILER) throw Error('host registry artifact compiler is not solc 0.8.35+commit.47b9dedd');
  if (s.viaIR !== true || s.evmVersion !== 'prague' || s.optimizer?.enabled !== true || s.optimizer?.runs !== 1 || s.metadata?.bytecodeHash !== 'ipfs')
    throw Error('host registry artifact settings differ from the qualified build (viaIR, prague, optimizer runs 1, ipfs metadata)');
  if (!same(s.compilationTarget, { [HOST_REGISTRY_SOURCE_KEY]: HOST_REGISTRY_CONTRACT })) throw Error('host registry artifact compilation target differs');
  if (s.libraries !== undefined && !same(s.libraries, {})) throw Error('host registry artifact names libraries');
  if (!same(Object.keys(m.sources ?? {}), [HOST_REGISTRY_SOURCE_KEY])) throw Error('host registry artifact must have exactly the one qualified source');
  const srcKeccak = lower(m.sources[HOST_REGISTRY_SOURCE_KEY].keccak256);
  if (!HASH.test(srcKeccak)) throw Error('host registry artifact source keccak256 missing');
  if (sourceBytes !== null) {
    if (sha(sourceBytes) !== HOST_REGISTRY_SOURCE_SHA256) throw Error('host registry source is not the qualified 68310acc source');
    if (keccak256(new Uint8Array(sourceBytes)) !== srcKeccak) throw Error('host registry source keccak256 differs from the artifact metadata');
  }
  const creation = String(a.bytecode?.object ?? ''), runtime = String(a.deployedBytecode?.object ?? '');
  if (!/^0x([0-9a-f]{2})+$/.test(creation) || !/^0x([0-9a-f]{2})+$/.test(runtime)) throw Error('host registry artifact bytecode malformed');
  if (!same(a.bytecode.linkReferences ?? {}, {}) || !same(a.deployedBytecode.linkReferences ?? {}, {})) throw Error('host registry artifact has library links');
  if (!same(a.deployedBytecode.immutableReferences ?? {}, {})) throw Error('host registry artifact has immutables (runtime would be address/arg dependent)');
  if ((runtime.length - 2) / 2 !== HOST_REGISTRY_RUNTIME_BYTES || (creation.length - 2) / 2 !== HOST_REGISTRY_INIT_BYTES)
    throw Error('host registry artifact sizes are not the qualified runtime 23968 / init 23994');
  if (!creation.endsWith(runtime.slice(2))) throw Error('host registry creation code does not end with the exact runtime');
  const abi = a.abi;
  if (!Array.isArray(abi) || abi.some(x => x.type === 'constructor' || x.type === 'fallback' || x.type === 'receive'))
    throw Error('host registry ABI must have no constructor, fallback or receive');
  for (const n of ABSENT_LEGACY) if (abi.some(x => x.type === 'function' && x.name === n)) throw Error(`host registry ABI exposes legacy writer ${n}`);
  if (abi.some(x => x.type === 'function' && x.name === 'registry')) throw Error('host registry ABI unexpectedly exposes an ownership registry() getter');
  const row = c => same(c.map(x => [x.name, x.type]), ROW);
  const get = fn(abi, 'get', ['bytes32']), page = fn(abi, 'getPage', ['uint256', 'uint256']);
  if (get.outputs.length !== 1 || get.outputs[0].type !== 'tuple' || !row(get.outputs[0].components)) throw Error('host registry get() is not the exact 13-field schema-5 row');
  if (page.outputs.length !== 1 || page.outputs[0].type !== 'tuple[]' || !row(page.outputs[0].components)) throw Error('host registry getPage() is not the exact 13-field schema-5 row');
  for (const [name, want] of Object.entries(OUTPUTS)) {
    const f = fn(abi, name, ['authority', 'hostState', 'reporterPolicy'].includes(name) ? ['bytes32'] : []);
    if (!same(shape(f.outputs), want)) throw Error(`host registry ${name}() outputs differ from the reviewed names/types/offsets`);
  }
  for (const n of ['recordHostOffline', 'deactivateHost', 'registerQualifiedHost', 'recoverQualifiedHost', 'setHostPolicy', 'acceptHostOwner'])
    if (!abi.some(x => x.type === 'function' && x.name === n && x.stateMutability === 'nonpayable')) throw Error(`host registry ABI lacks ${n}`);
  return Object.freeze({ abi, creation, runtime, runtimeCodeHash: keccak256(runtime), sourceKeccak256: srcKeccak, artifactSha256: got });
}

const cache = new Map();
export function loadHostRegistryArtifact(url = new URL('../deploy/lifecycle/host-registry/EnclaveHostLifecycleRegistry.json', import.meta.url),
  sourceUrl = new URL('../deploy/lifecycle/host-registry/EnclaveHostLifecycleRegistry.sol', import.meta.url)) {
  const k = `${url}|${sourceUrl}`;
  if (!cache.has(k)) cache.set(k, validateHostRegistryArtifact(fs.readFileSync(url), { sourceBytes: fs.readFileSync(sourceUrl) }));
  return cache.get(k);
}

export const isHostRegistryProfile = pins => pins?.profile === HOST_REGISTRY_PROFILE;

/** Static profile validation at adapter construction. -> frozen prepared registry binding. */
export function prepareHostRegistry(pins, { artifact = loadHostRegistryArtifact() } = {}) {
  const C = pins?.contracts ?? {}, h = pins?.hostRegistry;
  if (!h || typeof h !== 'object' || Array.isArray(h) || !same(Object.keys(h), ['artifactSha256']) || h.artifactSha256 !== HOST_REGISTRY_ARTIFACT_SHA256)
    throw Error(`pins.hostRegistry must be exactly { artifactSha256: '${HOST_REGISTRY_ARTIFACT_SHA256}' } in ${HOST_REGISTRY_PROFILE}`);
  if (pins.chainId !== 8453) throw Error('Base chain 8453 required');
  const r = C.registry, o = C.hostOwnership;
  if (!r || !o) throw Error(`pins.contracts.registry and .hostOwnership required by ${HOST_REGISTRY_PROFILE}`);
  const address = getAddress(r.address);
  if (getAddress(o.address) !== address) throw Error('hostOwnership must be the SAME canonical host registry address (a separate ownership contract is refused)');
  if (r.codeHash !== o.codeHash) throw Error('hostOwnership and registry code hashes differ');
  for (const c of [r, o]) if (c.abi !== undefined || c.bindings !== undefined) throw Error('registry/hostOwnership are pure code pins (no closure ABI/bindings)');
  if (r.codeHash !== artifact.runtimeCodeHash) throw Error('pins.contracts.registry.codeHash is not the reviewed EnclaveHostLifecycleRegistry runtime');
  for (const [k, c] of Object.entries(C))
    if (!['registry', 'hostOwnership'].includes(k) && getAddress(c.address) === address) throw Error(`pins.contracts.${k} reuses the host registry address`);
  return Object.freeze({ address, codeHash: r.codeHash, abi: artifact.abi, artifactSha256: artifact.artifactSha256,
    sourceKeccak256: artifact.sourceKeccak256 });
}

/** INSIDE the adapter's pinned snapshot callback, same client and block as the recursive closure and the schema-3 checks. */
export async function verifyHostRegistryAtBlock(p, client, blockNumber) {
  const code = await client.getCode({ address: p.address, blockNumber });
  if (!code || code === '0x' || keccak256(code) !== p.codeHash) throw Error('host registry runtime differs from the reviewed artifact at the authenticated block');
  const read = functionName => client.readContract({ address: p.address, abi: p.abi, functionName, args: [], blockNumber });
  if (await read('registrySchema') !== REGISTRY_SCHEMA) throw Error('host registry registrySchema is not exactly 5');
  if (await read('hostLifecycleSchema') !== HOST_LIFECYCLE_SCHEMA) throw Error('host registry hostLifecycleSchema is not exactly 1');
  if (lower(await read('registryFeature')) !== HOST_REGISTRY_FEATURE) throw Error('host registry feature id differs');
  if (await read('STATUS_ONLINE') !== 1 || await read('STATUS_OFFLINE') !== 2) throw Error('host registry status constants differ');
  return true;
}

/** The canonical lifecycle of THIS host, through the adapter's same-block `call` (sequential awaits, one block). */
export async function readHostLifecycle(p, call, host) {
  const state = await call(p.address, p.abi, 'hostState', [host]);
  const authority = await call(p.address, p.abi, 'authority', [host]);
  const reporters = await call(p.address, p.abi, 'reporterPolicy', [host]);
  return { state, authority, reporters };
}

/** Same-block read values -> exposed lifecycle. Throws (state unknown: no start, serving fenced) on any inconsistency. */
export function hostLifecycleState(p, v) {
  const L = v?.lifecycleHost, ha = v?.hostAuthority, row = v?.hostRec;
  if (!L || !Array.isArray(L.state) || L.state.length !== 10 || !Array.isArray(L.authority) || L.authority.length !== 4 || !Array.isArray(L.reporters))
    throw Error('host registry lifecycle tuple malformed: state unknown');
  const [generation, status, changedAt, qualificationExpiry, hardwareId, descriptorDigest, qualificationDigest, resourceDigest, trustAnchorId,
    lastOfflineDigest] = L.state;
  const [owner, pendingOwner, revision, policyHash] = L.authority, [keys, threshold, reporterRevision] = L.reporters;
  const st = STATUS[Number(status)];
  if (!st || typeof generation !== 'bigint' || (st === 'none') !== (generation === 0n)) throw Error('host registry status/generation inconsistent: state unknown');
  // the r6 hostOwnership read is the SAME contract at the SAME block: it must be the identical tuple (no role confusion)
  if (!Array.isArray(ha) || ha.length !== 4 || ha.some((x, i) => lower(x) !== lower(L.authority[i]))) throw Error('hostOwnership authority differs from the canonical registry authority: state unknown');
  if (row?.active !== (st === 'online')) throw Error('registry row active differs from the canonical lifecycle status: state unknown');
  if (st === 'online' && (getAddress(owner) === getAddress(ZERO_ADDR) || !keys.length || Number(threshold) < 1 || reporterRevision !== revision))
    throw Error('Online host without an accepted owner and current reporter quorum: state unknown');
  const blockSec = BigInt(v.blockSec);
  return Object.freeze({ scope: 'host', registry: lower(p.address), codeConsistent: true, status: st, online: st === 'online',
    generation: u64(generation, 'host generation'), changedAt: u64(changedAt, 'changedAt'), hardwareId: lower(hardwareId), descriptorDigest: lower(descriptorDigest),
    qualificationDigest: lower(qualificationDigest), resourceDigest: lower(resourceDigest), trustAnchorId: lower(trustAnchorId),
    lastOfflineDigest: lower(lastOfflineDigest), qualificationExpiry: u64(qualificationExpiry, 'qualificationExpiry'),
    // historical evidence only: NOT an on-chain lease and NOT a gate here (capacity/attestation freshness is a separate gap)
    qualificationExpired: qualificationExpiry <= blockSec,
    owner: lower(owner), pendingOwner: lower(pendingOwner), revision: u64(revision, 'authority revision'), policyHash: lower(policyHash),
    reporters: Object.freeze({ keys: Object.freeze(keys.map(k => lower(k))), threshold: Number(threshold), revision: u64(reporterRevision, 'reporter revision') }) });
}

export const HOST_REGISTRY_BLOCKERS = Object.freeze([
  'qualification verifiers are a payer-chosen trust anchor; no real prelisting test/capacity job or verifier service is qualified here (fixture verifiers are TEST keys).',
  'sponsor selection, paid-work/Stripe-fallback liability evidence and payer funding are not checked off chain; sourceEvidence is an opaque digest.',
  'no independent durable Offline submitter/reporter service exists; Offline happens only when the operator, accepted owner or reporter quorum submits it.',
  'Base L1 data fees are not reimbursed (l1FeeAllowance is inert); a protected reserve does not by itself prove an Offline transaction is affordable or has a funded sender.',
  'qualificationExpiry is historical evidence, not a lease: an expired qualification stays Online until recorded Offline; no heartbeat/renew exists or is added.',
  'verified capacity display and scheduler use of resourceDigest are not implemented; the frozen serving-permit module receives the host incarnation in the serve snapshot but does not itself sign it (the dispatch re-checks it at every serve).',
  'registry reporter permission never confers app-ledger permission: app stop/emergency paths remain the per-deployment owner/operator/witness paths.',
  'every schema-3 blocker of independent-schema3-r1 that is not about host ownership remains (ledger/prover owner powers, closure admin sets, per-deployment emergencyOffline, no positive Base authority).',
]);
export const hostRegistryFields = (p, hr) => ({ profile: HOST_REGISTRY_PROFILE, hostLifecycle: hr,
  hostOffline: Object.freeze({ registryOffline: hr.status, source: 'EnclaveHostLifecycleRegistry.hostState at the authenticated block',
    newAdmission: hr.online ? 'not affected' : 'denied (canonical host registry is not Online)' }),
  independence: Object.freeze({ complete: false, blockers: HOST_REGISTRY_BLOCKERS }) });
export const hostRegistryAdapterFields = p => ({ profile: HOST_REGISTRY_PROFILE,
  hostRegistry: Object.freeze({ address: lower(p.address), runtimeCodeHash: p.codeHash, artifactSha256: p.artifactSha256 }),
  independence: Object.freeze({ complete: false, blockers: HOST_REGISTRY_BLOCKERS }) });
