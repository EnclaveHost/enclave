// deployment-chain-adapter.mjs (lifecycle-chain-adapter-stage r5; PREPARED, not production-qualified): the DeploymentLifecycleRunner's
// chain adapter { read, prepare, submit, resolve, finalize } for the candidate controller EnclaveDeploymentLifecycle (schema-2 ledger).
//
// AUTHORITY (unchanged from r2/r3). Every chain fact comes from ONE injected capability, `authority.snapshot(read)` (the contract of
// network/lifecycle-finality-bridge.mjs). `verified`/`proofVerified` ONLY for authority.kind 'derived' with evidence tier
// 'l1-finalized-derived' and proofVerified === true; 'rpc-quorum' is always labelled and unverified. blockAt is block time (20 s gate).
// RECEIPT PROOF + FEE BOUND (unchanged from r3): 'confirmed'/'finalized' need authenticated state AND the exact transaction/receipt
// proven at ancestry of the authority's block; the payload fee is canonical and re-bounded by pins.maxGasPriceWei and a fresh
// proof-qualified budget read before broadcast.
//
// r4 (review logs/claude-lifecycle-policy-review.md):
//  F1 horizon: idle -> THIS host's purchasable horizon from ledger.rateFor(id, host) (what lifecycleStart would charge here), never the
//     stored d.rate / secondsFundable; running -> the real lease only while ledger.lifecycleFunded, else blockSec. `funded` is global:
//     running -> ledger truth; idle -> the controller transition budget (host affordability lives in `admitted` via lifecycleOperator).
//  F2 anchor (KVM host-admission-r1, commit b7dcf5af9, composed in r5): anchor.enabled = authenticated GLOBAL enablement (owner/active
//     AND the production catalog gate: the composed runner maps it to `enabled`, so a global ban still stops); anchor.admitted = the same
//     global admission (retained legacy certificate field); anchor.hostAdmission = { host, admitted:boolean } for THIS host only (the runner,
//     permit resolver and successor witness require host === the candidate host). A host refusal never reaches a global field.
// r5: closure getters returning an address TUPLE (dependencies-r1 sessionVaultFactory.authorityPins() -> (ledger, catalog, authority))
//     are reviewed per named output ('authorityPins.ledger', ...). r4 modelled it as an indexed array, which the actual ABI is not.
//  F3 the PRODUCTION catalog policy (34a3 site/js/core/catalog-policy.js, private pending allowed, rejected refused) decides the global
//     catalog gate; the host owner's committed policy (34a3 network/host-admission-policy.mjs, read at the SAME authenticated block from
//     the pinned EnclaveHostOwnership, document hash-checked) can only deny THIS host.
//  F4 appRef: exactly production's pattern and canonicalisation (catalog://<hex>/<1..9 digits> -> lower hex, Number(version)).
//  F5 administrators: pinned allowed SETS; a value outside them is `adminChanged` -> new starts are denied (admitted=false, running
//     intents refused) while reads, queue, stop and proof-backed resolution continue. Code, schema and binding checks stay fail-closed.
//  F6 recursive closure: every pinned contract with a reviewed ABI (dependencies-r1, KVM inventory deb51211) must have EVERY address
//     getter of that ABI reviewed (indexed getters: exact length, index n must revert); each target is a code-pinned contract, a reviewed
//     external address, `zero`, or an admin set. The five primary dependencies must name THIS ledger; nested legacy pins (e.g. the
//     existing SessionVault factory's authorityPins[0] = the old ledger) are verified as reviewed, never rewritten. Identity factories must
//     be closure members with the sessionVaultFactory ABI, and `preservedFactories` (existing vaults) must stay in the identity.
//  F7 the reviewed address book and the contract pins are one source: pins.bookKeys maps every book entry to its contract/external.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { bytesToHex, decodeEventLog, decodeFunctionData, encodeFunctionData, getAddress, hashTypedData, hexToBytes, keccak256, parseAbi,
  parseTransaction, recoverTransactionAddress, recoverTypedDataAddress } from 'viem';
import { transitionTypedData } from './deployment-transition-intent.mjs';
import { certificateWitnessesHash } from './deployment-generation-certificate.mjs';
// pinned, unmodified r4-final-consumer helpers (blobs 4f6d7b65 / 5473933d) and 34a3c0d6 production policy (closure-34a3, see CLOSURE.json)
import { verifyBlockReceipts, orderedTrieRoot, BASE_MAINNET } from './op-receipts-root.mjs';
import { headerHash, authenticateAncestors } from './derived-reader/vendor/anchor-bootstrap.mjs';
import { catalogAdmissionRefusal } from '../site/js/core/catalog-policy.js';
import { readHostAdmissionPolicy, hostAdmissionRefusal } from './host-admission-policy.mjs';
// r3 INDEPENDENT PROFILE: content integrity + the host owner's elected moderation (one rule with the host dispatch)
import { independentAdmissionRefusal } from './lifecycle-independent-admission.mjs';
// schema3 r1 (generated): explicit 'independent-schema3-r1' profile -> ACTUAL schema-3 controller/ledger/prover/identity + linked library
import { SCHEMA3_PROFILE, isSchema3Profile, prepareSchema3, verifySchema3AtBlock, schema3Emergency, schema3Fields, schema3AdapterFields } from './lifecycle-schema3-profile.mjs';
// host-registry r2 (generated): explicit 'independent-host-registry-r1' = schema3 + ONE canonical EnclaveHostLifecycleRegistry as registry AND hostOwnership
import { HOST_REGISTRY_PROFILE, isHostRegistryProfile, prepareHostRegistry, verifyHostRegistryAtBlock, readHostLifecycle, hostLifecycleState, hostRegistryFields,
  hostRegistryAdapterFields } from './lifecycle-host-registry-profile.mjs';
const SCHEMA3_BUNDLE_SHA256 = 'bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e';   // the ONLY bundle this generated adapter accepts (pins cannot select another)

const ART = name => JSON.parse(fs.readFileSync(new URL(`../deploy/lifecycle/artifacts/${name}.json`, import.meta.url), 'utf8'));
const LIFECYCLE_ABI = ART('EnclaveDeploymentLifecycle').abi;
const LEDGER_ABI = ART('EnclaveDeployments').abi;
const IDENTITY_ABI = ART('EnclaveSelfHostingIdentity').abi;
const R6_ABIS = Object.freeze({ LIFECYCLE_ABI, LEDGER_ABI, IDENTITY_ABI });   // schema3 r1: the unchanged r6 schema-2 ABIs, by another name
// platform views (address book, catalog, registry): the reviewed 34a3c0d6 subset (r2)
const DEPS = JSON.parse(fs.readFileSync(new URL('../abi/dependencies-34a3c0d6.json', import.meta.url), 'utf8'));
if (DEPS.commit !== '34a3c0d6d4c5aebffffb2492437487c9de74fb66') throw Error('dependency ABIs are not from the reviewed commit');
const DEP_ABI = Object.fromEntries(Object.entries(DEPS.contracts).map(([k, v]) => [k, v.abi]));
// the recursive closure ABIs: EXACTLY KVM's frozen dependencies-r1/abi.json (inventory SHA256SUMS deb51211)
const CLOSURE_BYTES = fs.readFileSync(new URL('../abi/dependencies-r1.json', import.meta.url));
if (crypto.createHash('sha256').update(CLOSURE_BYTES).digest('hex') !== '9f8f9426cd934c28bf1b893d9958a6927eba6d17679b31ae3caff0f572e96f57')
  throw Error('closure ABIs are not KVM dependencies-r1 abi.json');
const CLOSURE_ABI = Object.fromEntries(Object.entries(JSON.parse(CLOSURE_BYTES).contracts).map(([k, v]) => [k, v.abi]));
const HOST_OWNERSHIP_ABI = parseAbi(['function authority(bytes32) view returns (address owner,address pendingOwner,uint64 revision,bytes32 policyHash)']);
// every view returning one address with no input (scalar) or one uint256 input (indexed array) is a binding that must be reviewed
const INVENTORY = Object.fromEntries(Object.entries(CLOSURE_ABI).map(([k, abi]) => {
  const g = abi.filter(f => f.type === 'function' && ['view', 'pure'].includes(f.stateMutability) && f.outputs.length === 1 && f.outputs[0].type === 'address');
  const tuple = abi.filter(f => f.type === 'function' && ['view', 'pure'].includes(f.stateMutability) && f.inputs.length === 0 && f.outputs.length > 1 &&
    f.outputs.every(o => o.type === 'address')).flatMap(f => f.outputs.map((o, i) => `${f.name}.${o.name || i}`));
  return [k, { scalar: [...g.filter(f => f.inputs.length === 0).map(f => f.name), ...tuple],
    indexed: g.filter(f => f.inputs.length === 1 && f.inputs[0].type === 'uint256').map(f => f.name) }];
}));
export const CLOSURE = Object.freeze(['connectivity', 'pinnedSessionAuthority', 'proofOfTime', 'secretVaultV2', 'sessionVaultFactory',
  'sessionVaultImplementation', 'verificationFees']);
for (const k of CLOSURE) if (!INVENTORY[k]) throw Error(`closure ABI lacks ${k}`);
// the five primary immutable dependencies that must name THIS ledger
export const LEDGER_DEPENDENCIES = Object.freeze({ connectivity: 'ledger', pinnedSessionAuthority: 'deployments', proofOfTime: 'deployments',
  secretVaultV2: 'deploymentLedger', verificationFees: 'ledger' });
export const REQUIRED = Object.freeze(['lifecycle', 'ledger', 'identity', 'registry', 'l1Oracle', 'catalog', 'addressBook', 'hostOwnership', ...CLOSURE]);
const UINT64_MAX = 2n ** 64n - 1n;
for (const [abi, fns] of [[LIFECYCLE_ABI, ['assignments', 'budgets', 'ledger', 'l1Oracle', 'digest', 'transition', 'spendable', 'witnessesOf',
    'threshold', 'maxAnchorAgeSec', 'ownerAuthority']],
  [LEDGER_ABI, ['lifecycleSchema', 'lifecycleOwner', 'lifecycleOperator', 'lifecycleFunded', 'lifecycleController', 'selfHostingIdentity',
    'registry', 'deploymentsSchema', 'owner', 'pendingOwner', 'get', 'rateFor']], [IDENTITY_ABI, ['principal']]])
  for (const f of fns) if (!abi.some(x => x.type === 'function' && x.name === f)) throw Error(`candidate ABI lacks ${f}`);
for (const e of ['Transitioned', 'TransitionPaid']) if (!LIFECYCLE_ABI.some(x => x.type === 'event' && x.name === e)) throw Error(`candidate ABI lacks event ${e}`);
const FORMAT = 'enclave-lifecycle-transition-intent/v1';
const HASH = /^0x[0-9a-f]{64}$/, WEI = /^[1-9][0-9]{0,77}$/, ZERO32 = `0x${'0'.repeat(64)}`, ZERO_ADDR = `0x${'0'.repeat(40)}`;
const TARGET = { queued: 1, running: 2, stopped: 3 }, STATE = ['unknown', 'queued', 'running', 'stopped'];
const ADMINS = ['ledgerOwner', 'ledgerPendingOwner', 'addressBookOwner', 'addressBookPendingOwner'];
// ---- r3 INDEPENDENT PROFILE ('independent-r1'): an explicit, immutable, reviewed per-route post-handoff pin profile ----
// Selected ONLY by pins.profile (never an environment flag). Absent -> the legacy profile, r6 behavior unchanged.
// Differences, and nothing else:
//  - the EnclaveAddressBook is DISCOVERY metadata: not pinned, not read (no all(), no owner/pendingOwner). pins.addressBook,
//    pins.bookKeys, contracts.addressBook, address-book admin sets and any closure binding to it are refused; the optional
//    pins.discovery.addressBook records where routes were discovered and is never read.
//  - global `enabled` (snapshot AND operational anchor) = the deployment owner's d.active + ownership only. Catalog
//    moderation and the publisher's listing preferences never reach a global field; content integrity and the host
//    owner's elected moderation (independentAdmissionRefusal) decide THIS host's admission only.
//  - the snapshot carries resources (ledger cpuMilli/gpuMilli + catalog version minima) and forPrivate from the SAME
//    authenticated block, the content commitment, this host's owner authority and the ledger's retired flag.
// Kept exactly: every pinned code hash, the recursive closure (every reviewed getter, exact indexed lengths), schema,
// identity factory pins, controller/ledger/registry/oracle bindings, ledger owner/pendingOwner (custody-critical: a
// change still denies new starts) and every other reviewed admin set, receipt proof, fee bound and intent parsing.
export const INDEPENDENT_PROFILE = 'independent-r1';
export const INDEPENDENT_REQUIRED = Object.freeze(REQUIRED.filter(k => k !== 'addressBook'));
const INDEPENDENT_ADMINS = Object.freeze(['ledgerOwner', 'ledgerPendingOwner']);
if (!LEDGER_ABI.some(x => x.type === 'function' && x.name === 'retired')) throw Error('candidate ABI lacks retired');
// Real contract dependencies that still prevent full independence on the reviewed schema-17 ledger / schema-2 controller.
// Reported on the adapter and every independent snapshot; NOT fixed by this off-chain profile.
export const INDEPENDENCE_BLOCKERS = Object.freeze([
  'EnclaveDeployments.retire() (owner-only, one-way): lifecycleOperator() returns 0 and lifecycleFunded() false for every record and refund() opens to any caller; a ledger-owner retirement stops independent deployments on every host. The adapter reports ledgerState.retired; it neither ignores nor emulates it. Removal belongs to the peer ledger-v3 contract.',
  'EnclaveDeployments owner/pendingOwner outside the reviewed sets denies new starts on every host (adminChanged), retained because that owner holds retire() and custody-relevant governance.',
  'every other reviewed closure admin set (e.g. proofOfTime owner/pendingOwner) denies new starts on change, as in r6.',
  'secretVaultV2.enclaveOwner is an external platform address in the reviewed closure: verified as pinned, its secret-custody authority not reviewed for independence here.',
  'non-running transitions are signed by the owner authority or this host operator with approvals []: a crashed host cannot be reported offline (schema-3 emergencyOffline not integrated).',
]);
function independentProfile(pins) {
  if (pins?.profile === undefined) return false;
  if (pins.profile === SCHEMA3_PROFILE) return true;   // schema3 r1: also independent (address book = discovery) + schema3 checks/fields
  if (pins.profile === HOST_REGISTRY_PROFILE) return true;   // host-registry r2: also independent + schema3 + canonical host registry
  if (pins.profile !== INDEPENDENT_PROFILE) throw Error(`pins.profile ${String(pins.profile)} is not a reviewed profile`);
  return true;
}
function validateIndependentShape(pins) {
  for (const k of ['addressBook', 'bookKeys']) if (pins[k] !== undefined)
    throw Error(`pins.${k} is not authority in the independent profile (discovery metadata belongs in pins.discovery)`);
  if (pins.contracts?.addressBook !== undefined) throw Error('pins.contracts.addressBook: the address book is discovery metadata in the independent profile, not a pinned dependency');
  for (const [k, c] of Object.entries(pins.contracts ?? {}))
    for (const [g, t] of Object.entries(c?.bindings ?? {}))
      if (t === 'addressBook') throw Error(`recursive dependency ${k}.${g} -> addressBook prevents the independent profile`);
  for (const k of ['addressBookOwner', 'addressBookPendingOwner']) if (pins.admins?.[k] !== undefined) throw Error(`pins.admins.${k} is not authority in the independent profile`);
  if (pins.discovery !== undefined) {
    if (!pins.discovery || typeof pins.discovery !== 'object' || Array.isArray(pins.discovery)) throw Error('pins.discovery must be an object');
    for (const [k, a] of Object.entries(pins.discovery)) { if (k !== 'addressBook') throw Error(`pins.discovery.${k} is not known`); getAddress(a); }
  }
}
// The independent snapshot fields, all from the one authenticated block of read(). Out-of-range shares -> resources null
// (capacity unknown: no start), never a guessed quantity.
function independentFields(v, forPrivate, hostPolicyUnknown) {
  const milli = x => { const n = Number(x); return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : null; };
  const cpuMilli = milli(v.d.cpuMilli), gpuMilli = milli(v.d.gpuMilli), ha = v.hostAuthority;
  const resources = cpuMilli === null || gpuMilli === null ? null : Object.freeze({ cpuMilli, gpuMilli, cpuShare: cpuMilli / 1000, gpuShare: gpuMilli / 1000,
    version: Object.freeze({ memMb: Number(v.ver.memMb), cpuGflops: Number(v.ver.cpuGflops), vramMb: Number(v.ver.vramMb),
      gpuGflops: Number(v.ver.gpuGflops), config: String(v.ver.config ?? '') }) });
  return { profile: INDEPENDENT_PROFILE, forPrivate, resources,
    content: Object.freeze({ appRef: v.appRef, cid: String(v.ver.cid), createdAt: String(v.ver.createdAt) }),
    listing: Object.freeze({ delisted: v.app.active !== true, yanked: v.ver.yanked !== false, approval: Number(v.ver.approval), moderation: 'host-owner-elected' }),
    hostAuthority: Object.freeze({ owner: lower(ha[0]), revision: ha[2].toString(), policyHash: lower(ha[3]), policyKnown: hostPolicyUnknown !== true }),
    ledgerState: Object.freeze({ retired: v.retired === true }),
    independence: Object.freeze({ complete: false, blockers: INDEPENDENCE_BLOCKERS }) };
}
const lower = a => String(a).toLowerCase();
const kc = b => hexToBytes(keccak256(b));
class ProofRefused extends Error {}
const refuse = why => { throw new ProofRefused(why); };

// static closure/pin validation: everything the chain is later compared against must be complete and self-consistent
function validatePins(pins) {
  const C = pins.contracts, X = pins.externals ?? {};
  const IND = independentProfile(pins);                 // r3: throws on an unknown profile
  if (IND) validateIndependentShape(pins);
  for (const k of (IND ? INDEPENDENT_REQUIRED : REQUIRED)) if (!C?.[k]) throw Error(`pins.contracts.${k} required`);
  for (const [k, c] of Object.entries(C)) {
    getAddress(c?.address ?? ''); if (!HASH.test(c.codeHash || '')) throw Error(`pins.contracts.${k}.codeHash required`);
    if (CLOSURE.includes(k) && c.abi !== k) throw Error(`pins.contracts.${k} must use the reviewed ${k} ABI`);
    if (c.abi === undefined) { if (c.bindings !== undefined) throw Error(`pins.contracts.${k}: bindings without a reviewed ABI`); continue; }
    const inv = INVENTORY[c.abi]; if (!inv) throw Error(`pins.contracts.${k}.abi ${c.abi} is not a reviewed closure ABI`);
    const keys = Object.keys(c.bindings ?? {});
    for (const g of inv.scalar) if (!keys.includes(g)) throw Error(`closure binding ${k}.${g} is not reviewed`);
    for (const g of inv.indexed) {
      const n = keys.filter(x => x.startsWith(`${g}[`)).length;
      for (let i = 0; i < n; i++) if (!keys.includes(`${g}[${i}]`)) throw Error(`closure binding ${k}.${g}[${i}] is not reviewed (indices must be contiguous)`);
      if (n === 0) throw Error(`closure binding ${k}.${g}[] is not reviewed`);
    }
    for (const key of keys) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)?)(?:\[(0|[1-9][0-9]{0,2})\])?$/.exec(key);
      if (!m || !(m[2] === undefined ? inv.scalar : inv.indexed).includes(m[1])) throw Error(`closure binding ${k}.${key} is not an address getter of ${c.abi}`);
      const t = c.bindings[key];
      if (t === 'zero') continue;
      if (typeof t !== 'string') throw Error(`closure binding ${k}.${key} target malformed`);
      if (t.startsWith('external:')) { getAddress(X[t.slice(9)] ?? ''); continue; }
      if (t.startsWith('admin:')) { if (!Array.isArray(pins.admins?.[t.slice(6)])) throw Error(`closure binding ${k}.${key}: admin set ${t.slice(6)} missing`); continue; }
      if (!C[t]) throw Error(`closure binding ${k}.${key} names ${t}, which is not a code-pinned contract`);
    }
  }
  for (const [k, g] of Object.entries(LEDGER_DEPENDENCIES)) if (C[k].bindings[g] !== 'ledger') throw Error(`binding ${k}.${g} must be THIS ledger`);
  // identity factories: closure members (their nested pins reviewed); existing vaults' factories preserved
  if (!Array.isArray(pins.identityFactories) || !pins.identityFactories.length) throw Error('pins.identityFactories required');
  for (const f of pins.identityFactories) {
    const e = Object.entries(C).find(([, c]) => getAddress(c.address) === getAddress(f.factory ?? ''));
    if (!e || e[1].abi !== 'sessionVaultFactory' || e[1].codeHash !== f.codeHash) throw Error(`identity factory ${f.factory} is not a reviewed sessionVaultFactory closure member`);
  }
  if (!Array.isArray(pins.preservedFactories) || !pins.preservedFactories.length) throw Error('pins.preservedFactories (factories of existing vaults) required');
  for (const n of pins.preservedFactories)
    if (!C[n] || !pins.identityFactories.some(f => getAddress(f.factory) === getAddress(C[n].address))) throw Error(`preserved factory ${n} is missing from the identity pins`);
  // admins: explicit allowed sets (no wildcard)
  for (const [k, set] of Object.entries(pins.admins ?? {})) if (!Array.isArray(set) || !set.length) throw Error(`pins.admins.${k} must be a non-empty address set`); else set.forEach(a => getAddress(a));
  for (const k of (IND ? INDEPENDENT_ADMINS : ADMINS)) if (!pins.admins?.[k]) throw Error(`pins.admins.${k} required`);
  if (!IND) {                                            // r3: the independent profile takes no address book (validateIndependentShape)
  // F7 one reviewed source: every address-book entry is mapped to the contract/external of that name, and agrees with it
  const book = pins.addressBook ?? {}, keysOf = pins.bookKeys ?? {};
  if (!Object.keys(book).length || !Object.keys(book).every(k => HASH.test(k))) throw Error('pins.addressBook (exact reviewed entries) required');
  const mapped = new Set();
  for (const [name, key] of Object.entries(keysOf)) {
    const want = C[name]?.address ?? X[name];
    if (!want || !HASH.test(key) || !book[key] || getAddress(book[key]) !== getAddress(want)) throw Error(`address book entry for ${name} differs from its pin`);
    mapped.add(key);
  }
  for (const key of Object.keys(book)) if (!mapped.has(key)) throw Error(`address book entry ${key} is not mapped to a reviewed pin`);
  }
}

// pins (root-reviewed POST-MIGRATION deployment bindings; never invented here):
//   { chainId: 8453, host, payee, maxChargeWei, maxGasPriceWei, allowedMeasurements: [bytes32],
//     contracts: { <name>: { address, codeHash, abi?: <closure ABI>, bindings?: { <getter | getter[i]>: <name | external:x | admin:x | zero> } } },
//     externals: { <name>: address },  addressBook: { <bytes32>: address },  bookKeys: { <name>: <bytes32> },
//     identityFactories: [{ factory, codeHash }],  preservedFactories: [<name>],
//     admins: { ledgerOwner: [..], ledgerPendingOwner: [..], addressBookOwner: [..], addressBookPendingOwner: [..], <other>: [..] } }
// receipts: UNTRUSTED { locate, header, block } (r3).  hostPolicy: UNTRUSTED { load(policyHash) -> document } (hash-checked by production code).
export function createLifecycleChainAdapter({ pins, authority, receipts, hostPolicy, actorSigner, approvals, relay, generation = null, now = Date.now,
  deadlineSec = 90, maxAncestry = 1024 } = {}) {
  if (pins?.chainId !== 8453) throw Error('Base chain 8453 required');
  validatePins(pins);
  const INDEPENDENT = independentProfile(pins);         // r3: fixed for this adapter instance by its reviewed pins
  // schema3 r1: S3 is true ONLY for pins.profile === 'independent-schema3-r1' (never inferred from a schema read or label). It uses the
  // ACTUAL schema-3 ABIs of the hash-pinned bundle and statically proves every link/immutable/self-address pin (prepareSchema3).
  const HR = isHostRegistryProfile(pins);   // host-registry r2: true ONLY for pins.profile === 'independent-host-registry-r1'; implies S3
  const S3 = isSchema3Profile(pins) || HR;
  const S3P = S3 ? prepareSchema3(pins, SCHEMA3_BUNDLE_SHA256) : null;
  const LIFECYCLE_ABI = S3 ? S3P.abi.lifecycle : R6_ABIS.LIFECYCLE_ABI, LEDGER_ABI = S3 ? S3P.abi.ledger : R6_ABIS.LEDGER_ABI;
  const HRP = HR ? prepareHostRegistry(pins) : null;   // host-registry r2: exact artifact runtime/ABI; registry === hostOwnership (static)
  getAddress(pins.payee);
  if (!HASH.test(pins.host || '')) throw Error('pins.host must be a lowercase 32-byte hash');
  if (!Array.isArray(pins.allowedMeasurements) || !pins.allowedMeasurements.length || pins.allowedMeasurements.some(m => !HASH.test(m))) throw Error('pins.allowedMeasurements required');
  if (generation && (typeof generation.head?.read !== 'function' || typeof generation.certificates?.read !== 'function'))
    throw Error('generation authority needs head.read and certificates.read capabilities');
  if (!WEI.test(String(pins.maxChargeWei))) throw Error('pins.maxChargeWei required');
  if (!WEI.test(String(pins.maxGasPriceWei))) throw Error('pins.maxGasPriceWei (reviewed fee cap) required');
  if (!['derived', 'rpc-quorum'].includes(authority?.kind) || typeof authority.snapshot !== 'function')
    throw Error('authority {kind: derived|rpc-quorum, snapshot} capability required');
  if (['locate', 'header', 'block'].some(f => typeof receipts?.[f] !== 'function')) throw Error('receipts {locate, header, block} source required');
  if (typeof hostPolicy?.load !== 'function') throw Error('hostPolicy {load(policyHash)} document source required');
  if (!Number.isInteger(maxAncestry) || maxAncestry < 1 || maxAncestry > 8191) throw Error('maxAncestry must be 1..8191 headers');
  if (!Number.isInteger(deadlineSec) || deadlineSec < 30 || deadlineSec > 110) throw Error('deadlineSec must leave the controller 120 s window');
  const C = k => getAddress(pins.contracts[k].address);
  const lifecycle = C('lifecycle'), ledger = C('ledger'), payee = getAddress(pins.payee);
  const domainPins = { chainId: pins.chainId, lifecycle }, feeCap = BigInt(pins.maxGasPriceWei);
  const admins = Object.fromEntries(Object.entries(pins.admins).map(([k, s]) => [k, s.map(a => getAddress(a))]));

  const qualified = ev => authority.kind === 'derived' && ev?.tier === 'l1-finalized-derived' && ev?.proofVerified === true;
  const tierOf = ev => authority.kind === 'derived' ? String(ev?.tier) : 'rpc-quorum';
  async function pinned(fn) {             // one authenticated block; the whole reviewed closure is checked inside the same pinned read
    const r = await authority.snapshot(async (client, number, header) => {
      const at = { blockNumber: number };
      const adminChanges = [];
      const codeIs = async (address, want, what) => {
        const code = await client.getCode({ address, ...at });
        if (!code || code === '0x' || keccak256(code) !== want) throw Error(`deployed code of ${what} at ${address} is not the pinned code hash`);
      };
      for (const [k, c] of Object.entries(pins.contracts)) await codeIs(getAddress(c.address), c.codeHash, k);
      const call = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, ...at });
      const same = async (what, got, want) => { if (getAddress(await got) !== getAddress(want)) throw Error(`binding ${what} differs from the reviewed address`); };
      const admin = async (what, got, set) => { if (!admins[set].includes(getAddress(await got))) adminChanges.push(what); };
      // exact reviewed address book (F7: statically mapped onto the pins)
      if (!INDEPENDENT) {                                 // r3: legacy profile only; independent: discovery metadata, never read
      const [names, addrs] = await call(C('addressBook'), DEP_ABI.addressBook, 'all');
      const book = Object.fromEntries(names.map((n, i) => [lower(n), getAddress(addrs[i])]));
      const want = Object.fromEntries(Object.entries(pins.addressBook).map(([n, a]) => [lower(n), getAddress(a)]));
      if (names.length !== Object.keys(want).length || Object.keys(want).some(n => book[n] !== want[n])) throw Error('address book differs from the reviewed entries');
      }
      // controller <-> ledger <-> identity/registry/oracle
      await same('lifecycle.ledger', call(lifecycle, LIFECYCLE_ABI, 'ledger'), ledger);
      await same('lifecycle.l1Oracle', call(lifecycle, LIFECYCLE_ABI, 'l1Oracle'), C('l1Oracle'));
      await same('ledger.lifecycleController', call(ledger, LEDGER_ABI, 'lifecycleController'), lifecycle);
      await same('ledger.selfHostingIdentity', call(ledger, LEDGER_ABI, 'selfHostingIdentity'), C('identity'));
      await same('ledger.registry', call(ledger, LEDGER_ABI, 'registry'), C('registry'));
      // F6: the recursive closure, every reviewed address getter of every closure member
      for (const [k, c] of Object.entries(pins.contracts)) {
        if (c.abi === undefined) continue;
        const abi = CLOSURE_ABI[c.abi], counts = {};
        for (const [key, t] of Object.entries(c.bindings)) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z0-9_]+))?(?:\[([0-9]+)\])?$/.exec(key);
          if (m[3] !== undefined) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
          let got = await call(getAddress(c.address), abi, m[1], m[3] === undefined ? [] : [BigInt(m[3])]);
          if (m[2] !== undefined) {                                                // tuple output: by name, else by position
            const outs = abi.find(f => f.type === 'function' && f.name === m[1] && f.inputs.length === 0).outputs;
            const i = outs.findIndex((o, j) => (o.name || String(j)) === m[2]);
            got = Array.isArray(got) ? got[i] : got?.[m[2]];
          }
          got = getAddress(got);
          const what = `${k}.${key}`;
          if (t.startsWith('admin:')) { if (!admins[t.slice(6)].includes(got)) adminChanges.push(what); continue; }
          const exp = t === 'zero' ? ZERO_ADDR : t.startsWith('external:') ? getAddress(pins.externals[t.slice(9)]) : C(t);
          if (got !== exp) throw Error(`binding ${what} differs from the reviewed closure`);
        }
        for (const [g, n] of Object.entries(counts)) {                              // exact length: one past the reviewed indices must not exist
          let extra = true;
          try { await call(getAddress(c.address), abi, g, [BigInt(n)]); } catch { extra = false; }
          if (extra) throw Error(`binding ${k}.${g}[${n}] exists but is not reviewed`);
        }
      }
      if (await call(ledger, LEDGER_ABI, 'lifecycleSchema') !== (S3 ? 3n : 2n) || await call(ledger, LEDGER_ABI, 'deploymentsSchema') !== 17n)
        throw Error('ledger is not lifecycle schema 2 / deployments schema 17');
      if (await call(C('registry'), DEP_ABI.registry, 'registrySchema') < 4n) throw Error('registry below schema 4');
      // schema3 r1: deployed library runtime + self address, every link and concrete immutable, and the controller/ledger/identity/
      // prover/registry pair with lifecycleSchema 3 / lifecycleProofSchema 2 / proofSchema 2 -- at THIS block, inside the SAME pinned
      // read as the whole recursive closure above (never a separate snapshot, never a replacement for it)
      if (S3) await verifySchema3AtBlock(S3P, client, number);
      if (HR) await verifyHostRegistryAtBlock(HRP, client, number);   // host-registry r2: exact runtime/schema 5/lifecycle 1 at THIS block
      // the identity's FactoryPin[] (private storage, slot 0): exactly the reviewed SessionVault factories, each with its code hash
      const id0 = BigInt(keccak256(ZERO32));
      const slot = n => `0x${n.toString(16).padStart(64, '0')}`;
      const len = BigInt(await client.getStorageAt({ address: C('identity'), slot: slot(0n), ...at }));
      if (len !== BigInt(pins.identityFactories.length)) throw Error('identity factory pins differ from the reviewed set');
      for (const [i, f] of pins.identityFactories.entries()) {
        const fa = getAddress(`0x${(await client.getStorageAt({ address: C('identity'), slot: slot(id0 + 2n * BigInt(i)), ...at })).slice(-40)}`);
        const fh = lower(await client.getStorageAt({ address: C('identity'), slot: slot(id0 + 2n * BigInt(i) + 1n), ...at }));
        if (fa !== getAddress(f.factory) || fh !== f.codeHash) throw Error('identity factory pins differ from the reviewed set');
      }
      // F5: administrators are read and compared with reviewed SETS; a change denies new starts, it does not stop reads or stops
      await admin('ledger.owner', call(ledger, LEDGER_ABI, 'owner'), 'ledgerOwner');
      await admin('ledger.pendingOwner', call(ledger, LEDGER_ABI, 'pendingOwner'), 'ledgerPendingOwner');
      if (!INDEPENDENT) {                                 // r3: the address book's administrators are not authority in the independent profile
      await admin('addressBook.owner', call(C('addressBook'), DEP_ABI.addressBook, 'owner'), 'addressBookOwner');
      await admin('addressBook.pendingOwner', call(C('addressBook'), DEP_ABI.addressBook, 'pendingOwner'), 'addressBookPendingOwner');
      }
      return { inner: await fn(call, header), adminChanges };
    });
    if (typeof r?.blockNumber !== 'bigint' && !Number.isSafeInteger(r?.blockNumber) || !HASH.test(r?.blockHash || '') || !Number.isSafeInteger(r?.timestamp) ||
        !Array.isArray(r?.value?.adminChanges))
      throw Error('authority snapshot result malformed');
    return { ...r, value: r.value.inner, adminChanges: r.value.adminChanges };
  }
  const assignment = (call, id) => call(lifecycle, LIFECYCLE_ABI, 'assignments', [id]).then(a => ({
    owner: getAddress(a[0]), state: STATE[a[1]] ?? 'unknown', generation: Number(a[2]), revision: Number(a[3]), host: lower(a[4]),
    operator: getAddress(a[5]), changedAt: Number(a[6]), startAfter: Number(a[7]), failures: Number(a[8]), crashHeld: a[9], lastIntent: lower(a[10]) }));
  const proofState = async (call, id) => ({ a: await assignment(call, id),
    ownerAuthority: getAddress(await call(lifecycle, LIFECYCLE_ABI, 'ownerAuthority', [id])),
    hostOperator: getAddress(await call(ledger, LEDGER_ABI, 'lifecycleOperator', [id, pins.host])),
    witnesses: (await call(lifecycle, LIFECYCLE_ABI, 'witnessesOf', [id])).map(x => getAddress(x)),
    threshold: Number(await call(lifecycle, LIFECYCLE_ABI, 'threshold', [id])), offline: S3 ? await call(lifecycle, LIFECYCLE_ABI, 'offline', [id]) : null, lastEmergency: S3 ? await call(lifecycle, LIFECYCLE_ABI, 'lastEmergency', [id]) : null });

  function parse(id, intent) {            // exact persisted payload -> intent; any rewrite or foreign domain refuses
    if (!HASH.test(intent?.digest || '') || typeof intent?.payload !== 'string') throw Error('intent {digest, payload} required');
    const p = JSON.parse(intent.payload);
    if (p.format !== FORMAT || p.chainId !== pins.chainId || getAddress(p.controller) !== lifecycle) throw Error('intent is for another domain or controller');
    const x = p.intent;
    if (x?.id !== id || getAddress(x.payee) !== payee) throw Error('intent is for another deployment or payee');
    const typedData = transitionTypedData(domainPins, x);
    if (hashTypedData(typedData) !== intent.digest) throw Error('intent digest mismatch (payload rewritten or wrong domain)');
    if (!WEI.test(String(p.maxGasPriceWei)) || typeof p.maxGasPriceWei !== 'string' || typeof p.reason !== 'string' || p.reason.length > 200)
      throw Error('intent payload fee/reason malformed');
    if (canonical(x, p.maxGasPriceWei, p.reason) !== intent.payload) throw Error('intent payload is not the canonical prepared form (rewritten)');
    return { p, x, typedData };
  }
  const canonical = (x, maxGasPriceWei, reason) => JSON.stringify({ format: FORMAT, chainId: pins.chainId, controller: lifecycle,
    intent: { id: x.id, generation: x.generation, revision: x.revision, target: x.target, host: x.host, deadline: x.deadline,
      healthySince: x.healthySince, payee: x.payee, maxChargeWei: x.maxChargeWei }, maxGasPriceWei, reason });
  function outcomeOf(a, x, digest, blockSec) {
    if (a.lastIntent === digest)
      return a.generation === x.generation + 1 && a.state === STATE[x.target] &&
        (x.target !== TARGET.running || (a.host === x.host && a.operator !== ZERO_ADDR)) ? 'confirmed' : 'inconsistent';
    if (a.generation > x.generation) return 'finalized-fence';
    if (a.generation === x.generation && blockSec > x.deadline) return 'finalized-fence';
    return 'unknown';
  }

  // ---- the exact transaction + receipt of THIS intent, proven at ancestry of the authority's block B (r3, unchanged) --------------
  async function prove(x, typedData, digest, r, st) {
    const B = Number(r.blockNumber), Bhash = lower(r.blockHash);
    const hint = await receipts.locate({ id: x.id, digest, controller: lifecycle });
    if (hint == null) return { reason: 'no location hint for the intent' };
    const m = Number(hint.blockNumber), txh = lower(hint.transactionHash);
    if (!Number.isSafeInteger(m) || m < 0 || !HASH.test(txh)) refuse('malformed location hint');
    if (m > B) return { reason: `hinted block ${m} is above the authenticated block ${B} (not covered yet)` };
    if (B - m >= maxAncestry) return { reason: `hinted block ${m} is more than ${maxAncestry} headers below the authenticated block ${B}` };
    const headers = [];
    for (let n = m; n <= B; n++) headers.push(await receipts.header(n));
    const chain = authenticateAncestors(headers, { number: B, blockHash: Bhash }, kc);    // m..B linked to the AUTHORITY's hash of B
    const hashM = chain.get(m).hash;
    const blk = await receipts.block(m);
    if (!blk || typeof blk !== 'object' || !Array.isArray(blk.transactions) || !Array.isArray(blk.receipts)) refuse('block data malformed');
    if (headerHash(blk.header, kc) !== hashM) refuse(`block ${m} header is not the authenticated ancestor ${hashM}`);
    const txs = blk.transactions.map((t, i) => { if (!/^0x([0-9a-fA-F]{2})+$/.test(String(t))) refuse(`transaction ${i} is not raw bytes`); return hexToBytes(t); });
    if (orderedTrieRoot(txs, kc) !== lower(blk.header.transactionsRoot)) refuse('the transactions do not reproduce transactionsRoot');
    const txHashes = txs.map(t => keccak256(t));
    const v = verifyBlockReceipts({ header: blk.header, expectedBlockHash: hashM, receipts: blk.receipts, txHashes, chain: BASE_MAINNET },
      { keccak: kc, headerHash });
    const i = txHashes.indexOf(txh);
    if (i < 0) return { reason: `the authenticated block ${m} does not contain the hinted transaction` };
    const raw = bytesToHex(txs[i]);
    let tx; try { tx = parseTransaction(raw); } catch { refuse('the hinted transaction does not parse'); }
    const from = getAddress(await recoverTransactionAddress({ serializedTransaction: raw }));
    if (BigInt(blk.receipts[i].status) !== 1n) refuse('the transaction reverted');
    if (tx.chainId !== pins.chainId) refuse('the transaction is not for chain 8453');
    if (!tx.to || getAddress(tx.to) !== lifecycle) refuse('the transaction is not a call to the controller');
    if (from !== payee) refuse('the transaction is not sent by the signed payee');
    let fn; try { fn = decodeFunctionData({ abi: LIFECYCLE_ABI, data: tx.data }); } catch { refuse('calldata is not a controller call'); }
    if (fn.functionName !== 'transition') refuse('calldata is not transition()');
    const [ix, actorSig, sigs] = fn.args;
    const sameIntent = lower(ix.id) === x.id && ix.generation === BigInt(x.generation) && ix.revision === BigInt(x.revision) &&
      BigInt(ix.target) === BigInt(x.target) && lower(ix.host) === x.host && ix.deadline === BigInt(x.deadline) &&
      ix.healthySince === BigInt(x.healthySince) && getAddress(ix.payee) === payee && ix.maxChargeWei === BigInt(x.maxChargeWei);
    if (!sameIntent) refuse('calldata carries another intent');
    const signer = async s => { try { return getAddress(await recoverTypedDataAddress({ ...typedData, signature: s })); } catch { return null; } };
    const actor = await signer(actorSig);
    const own = v.logs.filter(l => l.transactionIndex === i && getAddress(l.address) === lifecycle);
    if (own.length !== 2) refuse(`the receipt carries ${own.length} controller logs, not exactly Transitioned + TransitionPaid`);
    let t, paid;
    try { [t, paid] = own.map(l => decodeEventLog({ abi: LIFECYCLE_ABI, topics: l.topics, data: l.data, strict: true })); } catch { refuse('controller log does not decode'); }
    if (t.eventName !== 'Transitioned' || paid.eventName !== 'TransitionPaid') refuse('controller logs are not Transitioned then TransitionPaid');
    if (lower(t.args.id) !== x.id || t.args.generation !== BigInt(x.generation + 1) || Number(t.args.state) !== x.target ||
        lower(t.args.host) !== st.a.host || getAddress(t.args.operator) !== st.a.operator) refuse('Transitioned differs from the intent or the authenticated state');
    if (lower(paid.args.id) !== x.id || lower(paid.args.intent) !== digest || getAddress(paid.args.payee) !== payee ||
        paid.args.chargedWei > BigInt(x.maxChargeWei)) refuse('TransitionPaid differs from the intent (id, digest, payee or charge)');
    if (x.target === TARGET.running) { if (actor !== st.a.operator) refuse('actor is not the admitted host operator'); }
    else if (actor !== st.ownerAuthority && actor !== st.hostOperator) {
      let prev = 0n, n = 0;
      for (const s of sigs) { const w = await signer(s); if (!w || BigInt(w) <= prev || !st.witnesses.includes(w)) refuse('actor is neither owner, operator nor a witness quorum'); prev = BigInt(w); n++; }
      if (n < st.threshold || st.threshold < 1) refuse('actor is neither owner, operator nor a witness quorum');
    }
    return { proof: Object.freeze({ transactionHash: txh, blockNumber: m, blockHash: hashM, transactionIndex: i,
      transactionsRoot: lower(blk.header.transactionsRoot), receiptsRoot: v.receiptsRoot, chargedWei: paid.args.chargedWei.toString(), actor,
      maxFeePerGasWei: String(tx.maxFeePerGas ?? tx.gasPrice), anchor: Object.freeze({ number: B, hash: Bhash }) }) };
  }
  async function proven(x, typedData, digest, r) {
    try {
      const res = await prove(x, typedData, digest, r, r.value);
      return res.proof ? { outcome: 'confirmed', proof: res.proof } : { outcome: 'unknown', proof: null, reason: res.reason };
    } catch (e) {
      return { outcome: 'unknown', proof: null, proofError: String(e?.code ? `${e.code}: ${e.message}` : e?.message || e).slice(0, 300) };
    }
  }

  return {
    authorityKind: authority.kind,
    ...(INDEPENDENT ? { profile: INDEPENDENT_PROFILE, independence: Object.freeze({ complete: false, blockers: INDEPENDENCE_BLOCKERS }) } : {}),   // r3
    ...(S3 ? schema3AdapterFields(S3P) : {}),   // schema3 r1
    ...(HR ? hostRegistryAdapterFields(HRP) : {}),   // host-registry r2
    async read(id) {
      if (!HASH.test(id)) throw Error('deployment id must be a lowercase bytes32');
      const r = await pinned(async (call, header) => {             // EVERY field below is read at this one authenticated block
        const a = await assignment(call, id);
        const [bal, maxT, reserve, maxGas] = await call(lifecycle, LIFECYCLE_ABI, 'budgets', [id]);
        const d = await call(ledger, LEDGER_ABI, 'get', [id]);
        const policy = { witnesses: (await call(lifecycle, LIFECYCLE_ABI, 'witnessesOf', [id])).map(x => getAddress(x)),
          threshold: Number(await call(lifecycle, LIFECYCLE_ABI, 'threshold', [id])),
          maxAnchorAgeSec: Number(await call(lifecycle, LIFECYCLE_ABI, 'maxAnchorAgeSec', [id])),
          revision: a.revision, maxTransitionWei: maxT.toString(), stopReserveWei: reserve.toString() };
        const ownerAuthority = getAddress(await call(lifecycle, LIFECYCLE_ABI, 'ownerAuthority', [id]));   // SessionVault-resolved
        const operator = getAddress(await call(ledger, LEDGER_ABI, 'lifecycleOperator', [id, pins.host])); // host admission + affordability
        const ledgerFunded = await call(ledger, LEDGER_ABI, 'lifecycleFunded', [id]);
        const hostRate = await call(ledger, LEDGER_ABI, 'rateFor', [id, pins.host]);                    // F1: what a start HERE is priced at
        const spendable = await call(lifecycle, LIFECYCLE_ABI, 'spendable', [id]);
        const hostRec = await call(C('registry'), DEP_ABI.registry, 'get', [pins.host]);
        const hostAuthority = await call(C('hostOwnership'), HOST_OWNERSHIP_ABI, 'authority', [pins.host]);
        const lifecycleHost = HR ? await readHostLifecycle(HRP, call, pins.host) : null;   // host-registry r2: canonical lifecycle, same block
        // F4: production's exact appRef pattern and canonicalisation
        const ref = typeof d.appRef === 'string' && d.appRef.match(/^catalog:\/\/(0x[0-9a-fA-F]{64})\/([0-9]{1,9})$/);
        if (!ref) throw Error('deployment appRef is not a catalog reference: state unknown');
        const appId = lower(ref[1]), versionIndex = Number(ref[2]);
        const app = await call(C('catalog'), DEP_ABI.catalog, 'getApp', [appId]);
        const ver = await call(C('catalog'), DEP_ABI.catalog, 'getVersion', [appId, BigInt(versionIndex)]);
        const retired = INDEPENDENT ? await call(ledger, LEDGER_ABI, 'retired') : null;   // r3: reported at this block, never ignored
        // schema3 r1: the controller's exact per-deployment emergency offline tuple and last emergency digest, at this same block
        const offline = S3 ? await call(lifecycle, LIFECYCLE_ABI, 'offline', [id]) : null;
        const lastEmergency = S3 ? await call(lifecycle, LIFECYCLE_ABI, 'lastEmergency', [id]) : null;
        return { a, budget: { balanceWei: bal, maxTransitionWei: maxT, stopReserveWei: reserve, maxGasPrice: maxGas }, d, policy, ownerAuthority,
          operator, ledgerFunded, hostRate, spendable, hostRec, hostAuthority, app, ver, appRef: `catalog://${appId}/${versionIndex}`, blockSec: Number(header.timestamp), retired, offline, lastEmergency, lifecycleHost };
      });
      const v = r.value, ok = qualified(r.evidence), adminChanged = r.adminChanges.length > 0;
      const s3 = S3 ? schema3Emergency(v.offline, v.lastEmergency, v.a) : null, s3Pending = s3 !== null && s3.pending === true;   // schema3 r1
      const horizon = x => { if (x === UINT64_MAX) return Number.MAX_SAFE_INTEGER;
        if (x > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('finite paid horizon beyond safe range'); return Number(x); };
      // F1: running -> the real lease while the ledger says funded; idle -> this host's purchasable horizon at rateFor(id, host)
      const fundedUntil = s3Pending ? v.blockSec : v.a.state === 'running'
        ? (v.ledgerFunded === true ? horizon(BigInt(v.d.leaseUntil)) : v.blockSec)
        : v.hostRate === 0n ? Number.MAX_SAFE_INTEGER
          : v.blockSec + Number((BigInt(v.d.balance6) / v.hostRate) < 2n ** 52n ? BigInt(v.d.balance6) / v.hostRate : 2n ** 52n);
      // global gates (may stop the deployment everywhere): owner/active + the PRODUCTION catalog policy; ledger/controller funding
      const owned = v.a.owner !== ZERO_ADDR && getAddress(v.d.owner) === v.a.owner;
      const forPrivate = v.d.isPublic === false;
      const catalogRefusal = catalogAdmissionRefusal(v.app, v.ver, { forPrivate });
      const ownerEnabled = v.d.active === true && owned;
      // r3: independent profile -> global enablement is the deployment owner's own d.active/ownership ONLY; catalog
      // moderation and publisher listing are host-scoped there (independentAdmissionRefusal below)
      const enabled = ownerEnabled && (INDEPENDENT || catalogRefusal === null);
      // idle: budget only (this host's purchasable horizon is host admission, never a reason to stop the deployment everywhere)
      const funded = v.spendable > v.budget.maxTransitionWei && (v.a.state === 'running' ? v.ledgerFunded === true && fundedUntil > v.blockSec : true) && !s3Pending;
      // this host only: registry/measurement/lifecycleOperator (cap + balance at rateFor), the host owner's committed policy, admin freeze
      let hostDenial = null;
      let hostPolicyUnknown = false;                      // r3: an unavailable/mismatched owner policy is UNKNOWN, not a decision
      try {
        const ha = v.hostAuthority;
        const hp = await readHostAdmissionPolicy({ hostId: pins.host, ownershipContract: lower(C('hostOwnership')),
          readAuthority: async () => ({ owner: lower(ha[0]), revision: ha[2].toString(), policyHash: lower(ha[3]) }), loadPolicy: hostPolicy.load });
        // production hostAdmissionRefusal evaluates catalogAdmissionRefusal(version, version): the version is given the app's own
        // `active` so that internal check reads the real app status (review F3 observation; production code unmodified)
        if (INDEPENDENT) hostDenial = independentAdmissionRefusal(hp.policy, { hostId: pins.host, deploymentId: id, appRef: v.d.appRef,
          app: { appId: lower(v.app.appId), versionCount: String(v.app.versionCount), active: v.app.active === true },
          version: { cid: String(v.ver.cid), createdAt: String(v.ver.createdAt), yanked: v.ver.yanked, approval: Number(v.ver.approval) }, forPrivate });
        else
        hostDenial = hostAdmissionRefusal(hp.policy, { hostId: pins.host, deploymentId: id, appRef: v.d.appRef, version: { ...v.ver, active: v.app.active }, forPrivate });
      } catch (e) { hostPolicyUnknown = true; hostDenial = `host owner policy unavailable: ${String(e?.message || e).slice(0, 200)}`; }
      const hostOk = v.hostRec.active === true && v.operator !== ZERO_ADDR && getAddress(v.hostRec.operator) === v.operator &&
        pins.allowedMeasurements.includes(lower(v.hostRec.measurement));
      const hr = HR ? hostLifecycleState(HRP, v) : null;   // host-registry r2: throws (state unknown) on any registry/authority inconsistency
      const admitted = hostOk && hostDenial === null && !adminChanged && !s3Pending && (!HR || hr.online === true);
      const snapshot = { schema: 2, id, verified: ok, proofVerified: ok, authorityTier: tierOf(r.evidence), authority: authority.kind,
        blockAt: r.timestamp, blockNumber: Number(r.blockNumber), blockHash: r.blockHash, thisHost: pins.host,
        enabled, admitted, funded, fundedUntil, ownerAuthority: v.ownerAuthority, appRef: v.appRef,
        catalog: { active: v.app.active, yanked: v.ver.yanked, approval: Number(v.ver.approval), refusal: catalogRefusal },
        host: { active: v.hostRec.active, operator: v.operator, measurement: lower(v.hostRec.measurement), rateWei: v.hostRate.toString(), ownerDenial: hostDenial },
        adminChanged, adminChanges: r.adminChanges,
        ...(INDEPENDENT ? independentFields(v, forPrivate, hostPolicyUnknown) : {}),   // r3 independent profile only
        ...(S3 ? schema3Fields(v, s3) : {}),   // schema3 r1 only: schemas + emergency tuple; overrides profile/ledgerState/independence
        ...(HR ? hostRegistryFields(HRP, hr) : {}),   // host-registry r2 only: overrides profile/hostOffline/independence
        policy: v.policy, budget: Object.fromEntries(Object.entries(v.budget).map(([k, x]) => [k, x.toString()])),
        assignment: { state: v.a.state, host: v.a.host, operator: v.a.operator, generation: v.a.generation, revision: v.a.revision,
          changedAt: v.a.changedAt, startAfter: v.a.startAfter * 1000, failures: v.a.failures, crashHeld: v.a.crashHeld, lastIntent: v.a.lastIntent } };
      // Operational authority: ONLY on the owner's on-chain opt-in (maxAnchorAgeSec >= 20) AND injected recent-head + certificate sources.
      if (generation && v.policy.maxAnchorAgeSec >= 20 && v.a.state !== 'unknown') {
        if (!Number.isSafeInteger(r.observedAt)) throw Error('authority snapshot lacks observedAt');
        // F2 (KVM host-admission-r1 schema): global enablement/admission and per-host admission are separate fields
        const anchor = { proofVerified: ok, tier: tierOf(r.evidence), number: Number(r.blockNumber), hash: r.blockHash, timestamp: v.blockSec,
          observedAt: Math.floor(r.observedAt / 1000), enabled, admitted: enabled, hostAdmission: { host: pins.host, admitted },
          funded, fundedUntil, balanceWei: v.budget.balanceWei.toString(), ownerAuthority: v.ownerAuthority, policyHash: certificateWitnessesHash(v.policy),
          assignment: { deployment: id, generation: v.a.generation, state: v.a.state, host: v.a.host, operator: v.a.operator,
            changedAt: v.a.changedAt, startAfter: v.a.startAfter, failures: v.a.failures, crashHeld: v.a.crashHeld } };
        const head = await generation.head.read({ deployment: id, anchor: { number: anchor.number, hash: anchor.hash } });
        const certificates = await generation.certificates.read(id);
        if (!head || typeof head !== 'object' || !Array.isArray(certificates)) throw Error('generation sources returned malformed data');
        snapshot.generationAuthority = { anchor, head, policy: v.policy, certificates };
      }
      return snapshot;
    },
    async prepare(id, snapshot, target, reason) {
      if (snapshot?.id !== id || snapshot.verified !== true) throw Error('prepare needs a verified snapshot of this deployment');
      if (S3 && snapshot.emergency?.pending !== false)       // schema3 r1: the controller refuses EVERY transition while pending
        throw Error('emergency offline settlement pending (or unknown): reconcileOffline must settle the exact cutoff first; no transition prepared');
      if (!TARGET[target]) throw Error(`unknown target ${target}`);
      if (target === 'running' && snapshot.adminChanged !== false) throw Error('administrator changed outside the reviewed sets: new starts denied');
      const s = snapshot.assignment, cap = BigInt(pins.maxChargeWei), budgetMax = BigInt(snapshot.budget.maxTransitionWei);
      const maxChargeWei = budgetMax < cap ? budgetMax : cap;
      if (maxChargeWei <= 0n) throw Error('no positive transition charge bound');
      const budgetGas = BigInt(snapshot.budget.maxGasPrice), maxGasPriceWei = budgetGas < feeCap ? budgetGas : feeCap;
      if (maxGasPriceWei <= 0n) throw Error('no positive gas price bound');
      const x = { id, generation: s.generation, revision: s.revision, target: TARGET[target], host: target === 'running' ? pins.host : ZERO32,
        deadline: Math.floor(now() / 1000) + deadlineSec, healthySince: 0, payee, maxChargeWei: maxChargeWei.toString() };
      const typedData = transitionTypedData(domainPins, x), digest = hashTypedData(typedData);
      const tuple = { ...x, maxChargeWei, deadline: BigInt(x.deadline), generation: BigInt(x.generation), revision: BigInt(x.revision), healthySince: 0n };
      const r = await pinned(call => call(lifecycle, LIFECYCLE_ABI, 'digest', [tuple]));
      if (lower(r.value) !== digest) throw Error('controller digest mismatch: wrong chain, controller or domain');
      return { payload: canonical(x, maxGasPriceWei.toString(), String(reason ?? '').slice(0, 200)), digest };
    },
    async submit(id, intent) {
      const { p, x, typedData } = parse(id, intent);
      if (Math.floor(now() / 1000) >= x.deadline) throw Error('intent deadline passed: not submitted (the journal keeps the exact intent)');
      if (getAddress(relay?.address ?? ZERO_ADDR) !== payee) throw Error('relay sender is not the signed payee');
      const fee = BigInt(p.maxGasPriceWei);
      if (fee > feeCap) throw Error('fee bound: payload maxGasPriceWei exceeds pins.maxGasPriceWei: not submitted');
      const f = await pinned(async call => ({ a: await assignment(call, id), maxGas: (await call(lifecycle, LIFECYCLE_ABI, 'budgets', [id]))[3], offline: S3 ? await call(lifecycle, LIFECYCLE_ABI, 'offline', [id]) : null }));
      if (!qualified(f.evidence)) throw Error('fee bound: no proof-qualified budget read: not submitted');
      if (fee > f.value.maxGas) throw Error('fee bound: payload maxGasPriceWei exceeds the authenticated budget maxGasPrice: not submitted');
      if (f.value.a.lastIntent === intent.digest) throw Error('intent already executed at the authenticated block: not resubmitted');
      if (S3 && schema3Emergency(f.value.offline, null, f.value.a).pending) throw Error('emergency offline settlement pending at the authenticated block: not submitted');
      if (x.target === TARGET.running && f.adminChanges.length) throw Error('administrator changed outside the reviewed sets: new starts denied');
      const actor = await actorSigner({ id, target: STATE[x.target], typedData, digest: intent.digest });
      if (await recoverTypedDataAddress({ ...typedData, signature: actor.signature }) !== getAddress(actor.address)) throw Error('actor signature does not recover');
      const sigs = x.target === TARGET.running ? await approvals({ id, digest: intent.digest, typedData }) : [];
      let prev = 0n;
      for (const s of sigs) {
        const a = BigInt(await recoverTypedDataAddress({ ...typedData, signature: s }));
        if (a <= prev) throw Error('witness approvals are not signer-ordered'); prev = a;
      }
      const tuple = { ...x, maxChargeWei: BigInt(x.maxChargeWei), deadline: BigInt(x.deadline), generation: BigInt(x.generation),
        revision: BigInt(x.revision), healthySince: 0n };
      const data = encodeFunctionData({ abi: LIFECYCLE_ABI, functionName: 'transition', args: [tuple, actor.signature, sigs] });
      await relay.send({ to: lifecycle, data, maxFeePerGasWei: fee });
    },
    async resolve(id, pending) {
      const { x, typedData } = parse(id, pending);
      const r = await pinned(call => proofState(call, id));
      const ok = qualified(r.evidence);
      let res = { outcome: outcomeOf(r.value.a, x, pending.digest, Math.floor(r.timestamp / 1000)), proof: null };
      if (res.outcome === 'confirmed') res = await proven(x, typedData, pending.digest, r);      // state alone never confirms
      return { verified: ok && res.outcome !== 'inconsistent' && !res.proofError, proofVerified: ok, authorityTier: tierOf(r.evidence),
        authority: authority.kind, digest: pending.digest, outcome: res.outcome, proof: res.proof,
        ...(S3 ? { emergency: schema3Emergency(r.value.offline, r.value.lastEmergency, r.value.a) } : {}),   // schema3 r1: exposed, never a proof
        ...(res.reason ? { reason: res.reason } : {}), ...(res.proofError ? { proofError: res.proofError } : {}),
        blockNumber: Number(r.blockNumber), blockHash: r.blockHash };
    },
    async finalize(id, intent) {
      const { x, typedData } = parse(id, intent);
      const r = await pinned(call => proofState(call, id));
      const a = r.value.a, ok = qualified(r.evidence), state = outcomeOf(a, x, intent.digest, Math.floor(r.timestamp / 1000));
      let res = { outcome: 'unknown', proof: null };
      if (state === 'confirmed') { res = await proven(x, typedData, intent.digest, r); if (res.outcome === 'confirmed') res.outcome = 'finalized'; }
      else if (a.lastIntent !== intent.digest && a.generation === x.generation && Math.floor(r.timestamp / 1000) > x.deadline) res.outcome = 'reorged';
      return { verified: ok && state !== 'inconsistent' && !res.proofError, proofVerified: ok, authorityTier: tierOf(r.evidence),
        authority: authority.kind, digest: intent.digest, outcome: res.outcome, proof: res.proof,
        ...(S3 ? { emergency: schema3Emergency(r.value.offline, r.value.lastEmergency, r.value.a) } : {}),   // schema3 r1: exposed, never a proof
        ...(res.reason ? { reason: res.reason } : {}), ...(res.proofError ? { proofError: res.proofError } : {}),
        blockNumber: Number(r.blockNumber), blockHash: r.blockHash };
    },
  };
}
