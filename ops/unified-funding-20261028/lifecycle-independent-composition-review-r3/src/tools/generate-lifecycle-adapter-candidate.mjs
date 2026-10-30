// Strict hash-pinned generator: the ACTUAL reviewed r6 chain adapter (lifecycle-chain-adapter-stage/r6
// network/deployment-chain-adapter.mjs, SHA-256 below, the file r6 SHA256SUMS pins) -> a candidate adapter with an
// explicit, immutable INDEPENDENT pin profile ('independent-r1'). Insertions only (insertion-patch.mjs self-proof): every
// r6 byte is retained in order. With pins.profile absent every insertion is inert and the r6 behavior is unchanged
// (the r6 abi/policy/proof suites run against the candidate prove it; jobs/root-r3-adapter-tests.sh).
//
// The candidate must sit where the r6 adapter sits in the composed tree (network/), beside
// network/lifecycle-independent-admission.mjs (copied from this task's src/network/). It reads the same
// ../deploy/lifecycle/artifacts and ../abi files as r6.
//
//   node generate-lifecycle-adapter-candidate.mjs /abs/r6/network/deployment-chain-adapter.mjs /abs/tree/network/deployment-chain-adapter.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyInsertions, writeInsertions } from './insertion-patch.mjs';

export const R6_ADAPTER_SHA256 = '330a908222d3a0108f83ba9d9ec0d3947b6d19a5f268360fc4b48227a4da1d30';
export const R6_SHA256SUMS = '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/lifecycle-chain-adapter-stage/r6/SHA256SUMS';
const MARKER = 'INDEPENDENT_PROFILE';

export const ADAPTER_EDITS = Object.freeze([
  { name: 'import',
    before: "import { readHostAdmissionPolicy, hostAdmissionRefusal } from './host-admission-policy.mjs';\n",
    after: '\nconst ART = name => JSON.parse(',
    text: `// r3 INDEPENDENT PROFILE: content integrity + the host owner's elected moderation (one rule with the host dispatch)
import { independentAdmissionRefusal } from './lifecycle-independent-admission.mjs';
` },
  { name: 'profile',
    before: "const ADMINS = ['ledgerOwner', 'ledgerPendingOwner', 'addressBookOwner', 'addressBookPendingOwner'];\n",
    after: 'const lower = a => String(a).toLowerCase();',
    text: `// ---- r3 INDEPENDENT PROFILE ('independent-r1'): an explicit, immutable, reviewed per-route post-handoff pin profile ----
// Selected ONLY by pins.profile (never an environment flag). Absent -> the legacy profile, r6 behavior unchanged.
// Differences, and nothing else:
//  - the EnclaveAddressBook is DISCOVERY metadata: not pinned, not read (no all(), no owner/pendingOwner). pins.addressBook,
//    pins.bookKeys, contracts.addressBook, address-book admin sets and any closure binding to it are refused; the optional
//    pins.discovery.addressBook records where routes were discovered and is never read.
//  - global \`enabled\` (snapshot AND operational anchor) = the deployment owner's d.active + ownership only. Catalog
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
  if (pins.profile !== INDEPENDENT_PROFILE) throw Error(\`pins.profile \${String(pins.profile)} is not a reviewed profile\`);
  return true;
}
function validateIndependentShape(pins) {
  for (const k of ['addressBook', 'bookKeys']) if (pins[k] !== undefined)
    throw Error(\`pins.\${k} is not authority in the independent profile (discovery metadata belongs in pins.discovery)\`);
  if (pins.contracts?.addressBook !== undefined) throw Error('pins.contracts.addressBook: the address book is discovery metadata in the independent profile, not a pinned dependency');
  for (const [k, c] of Object.entries(pins.contracts ?? {}))
    for (const [g, t] of Object.entries(c?.bindings ?? {}))
      if (t === 'addressBook') throw Error(\`recursive dependency \${k}.\${g} -> addressBook prevents the independent profile\`);
  for (const k of ['addressBookOwner', 'addressBookPendingOwner']) if (pins.admins?.[k] !== undefined) throw Error(\`pins.admins.\${k} is not authority in the independent profile\`);
  if (pins.discovery !== undefined) {
    if (!pins.discovery || typeof pins.discovery !== 'object' || Array.isArray(pins.discovery)) throw Error('pins.discovery must be an object');
    for (const [k, a] of Object.entries(pins.discovery)) { if (k !== 'addressBook') throw Error(\`pins.discovery.\${k} is not known\`); getAddress(a); }
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
` },
  { name: 'validate-profile',
    before: '  const C = pins.contracts, X = pins.externals ?? {};\n',
    after: '  for (const k of REQUIRED) if (!C?.[k])',
    text: '  const IND = independentProfile(pins);                 // r3: throws on an unknown profile\n  if (IND) validateIndependentShape(pins);\n' },
  { name: 'required-open', before: '  for (const k of ', after: 'REQUIRED) if (!C?.[k]) throw Error(', text: '(IND ? INDEPENDENT_REQUIRED : ' },
  { name: 'required-close', before: '  for (const k of REQUIRED', after: ') if (!C?.[k]) throw Error(', text: ')' },
  { name: 'admins-open', before: '  for (const k of ', after: 'ADMINS) if (!pins.admins?.[k])', text: '(IND ? INDEPENDENT_ADMINS : ' },
  { name: 'admins-close', before: '  for (const k of ADMINS', after: ') if (!pins.admins?.[k])', text: ')' },
  { name: 'book-validate-open',
    before: '  for (const k of ADMINS) if (!pins.admins?.[k]) throw Error(`pins.admins.${k} required`);\n',
    after: '  // F7 one reviewed source:',
    text: '  if (!IND) {                                            // r3: the independent profile takes no address book (validateIndependentShape)\n' },
  { name: 'book-validate-close',
    before: '  for (const key of Object.keys(book)) if (!mapped.has(key)) throw Error(`address book entry ${key} is not mapped to a reviewed pin`);\n',
    after: '}\n\n// pins (root-reviewed',
    text: '  }\n' },
  { name: 'adapter-profile',
    before: '  validatePins(pins);\n',
    after: '  getAddress(pins.payee);',
    text: '  const INDEPENDENT = independentProfile(pins);         // r3: fixed for this adapter instance by its reviewed pins\n' },
  { name: 'book-read-open',
    before: '      // exact reviewed address book (F7: statically mapped onto the pins)\n',
    after: "      const [names, addrs] = await call(C('addressBook'), DEP_ABI.addressBook, 'all');",
    text: '      if (!INDEPENDENT) {                                 // r3: legacy profile only; independent: discovery metadata, never read\n' },
  { name: 'book-read-close',
    before: "      if (names.length !== Object.keys(want).length || Object.keys(want).some(n => book[n] !== want[n])) throw Error('address book differs from the reviewed entries');\n",
    after: '      // controller <-> ledger <-> identity/registry/oracle',
    text: '      }\n' },
  { name: 'book-admin-open',
    before: "      await admin('ledger.pendingOwner', call(ledger, LEDGER_ABI, 'pendingOwner'), 'ledgerPendingOwner');\n",
    after: "      await admin('addressBook.owner',",
    text: '      if (!INDEPENDENT) {                                 // r3: the address book\'s administrators are not authority in the independent profile\n' },
  { name: 'book-admin-close',
    before: "      await admin('addressBook.pendingOwner', call(C('addressBook'), DEP_ABI.addressBook, 'pendingOwner'), 'addressBookPendingOwner');\n",
    after: '      return { inner: await fn(call, header), adminChanges };',
    text: '      }\n' },
  { name: 'read-retired',
    before: "        const ver = await call(C('catalog'), DEP_ABI.catalog, 'getVersion', [appId, BigInt(versionIndex)]);\n",
    after: '        return { a, budget:',
    text: "        const retired = INDEPENDENT ? await call(ledger, LEDGER_ABI, 'retired') : null;   // r3: reported at this block, never ignored\n" },
  { name: 'read-retired-return', before: 'blockSec: Number(header.timestamp)', after: ' };\n      });', text: ', retired' },
  { name: 'enabled-comment',
    before: '      const ownerEnabled = v.d.active === true && owned;\n',
    after: '      const enabled = ownerEnabled',
    text: '      // r3: independent profile -> global enablement is the deployment owner\'s own d.active/ownership ONLY; catalog\n      // moderation and publisher listing are host-scoped there (independentAdmissionRefusal below)\n' },
  { name: 'enabled-open', before: '      const enabled = ownerEnabled && ', after: 'catalogRefusal === null;', text: '(INDEPENDENT || ' },
  { name: 'enabled-close', before: '      const enabled = ownerEnabled && catalogRefusal === null', after: ';\n', text: ')' },
  { name: 'policy-unknown-decl',
    before: '      let hostDenial = null;\n',
    after: '      try {\n        const ha = v.hostAuthority;',
    text: '      let hostPolicyUnknown = false;                      // r3: an unavailable/mismatched owner policy is UNKNOWN, not a decision\n' },
  { name: 'host-denial',
    before: '        // `active` so that internal check reads the real app status (review F3 observation; production code unmodified)\n',
    after: '        hostDenial = hostAdmissionRefusal(',
    text: `        if (INDEPENDENT) hostDenial = independentAdmissionRefusal(hp.policy, { hostId: pins.host, deploymentId: id, appRef: v.d.appRef,
          app: { appId: lower(v.app.appId), versionCount: String(v.app.versionCount), active: v.app.active === true },
          version: { cid: String(v.ver.cid), createdAt: String(v.ver.createdAt), yanked: v.ver.yanked, approval: Number(v.ver.approval) }, forPrivate });
        else
` },
  { name: 'policy-unknown-set', before: '      } catch (e) { ', after: 'hostDenial = `host owner policy unavailable:', text: 'hostPolicyUnknown = true; ' },
  { name: 'snapshot-fields',
    before: '        adminChanged, adminChanges: r.adminChanges,\n',
    after: '        policy: v.policy, budget:',
    text: '        ...(INDEPENDENT ? independentFields(v, forPrivate, hostPolicyUnknown) : {}),   // r3 independent profile only\n' },
  { name: 'adapter-object',
    before: '  return {\n    authorityKind: authority.kind,\n',
    after: '    async read(id) {',
    text: '    ...(INDEPENDENT ? { profile: INDEPENDENT_PROFILE, independence: Object.freeze({ complete: false, blockers: INDEPENDENCE_BLOCKERS }) } : {}),   // r3\n' },
]);

export function generateAdapterCandidate(r6, { expectedSha256 = R6_ADAPTER_SHA256, edits = ADAPTER_EDITS } = {}) {
  return applyInsertions(r6, { expectedSha256, edits, marker: MARKER, what: 'r6 deployment-chain-adapter.mjs' });
}
export const writeAdapterCandidate = (input, output) => writeInsertions(input, output, generateAdapterCandidate, R6_ADAPTER_SHA256);

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) { console.error('usage: generate-lifecycle-adapter-candidate.mjs <r6 adapter> <output file>'); process.exit(2); }
  console.log(JSON.stringify(writeAdapterCandidate(input, output), null, 1));
}
