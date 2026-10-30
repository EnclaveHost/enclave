// schema3 r1 strict hash-pinned ADDITIVE generator: the REVIEWED r3 adapter candidate (SHA 8e666ed6..., itself generated from
// the frozen r6 adapter SHA 330a9082... by the r3 generator) -> a candidate with ONE additional explicit pin profile,
// 'independent-schema3-r1'. Insertions only (insertion-patch.mjs self-proof): every r3 byte is retained in order, so with
// pins.profile absent (legacy default) or 'independent-r1' every insertion is inert (each is guarded by S3, which is true
// ONLY for pins.profile === 'independent-schema3-r1').
//
// The output must sit at network/deployment-chain-adapter.mjs of the composed tree, beside
//   network/lifecycle-independent-admission.mjs   (r3, unchanged)
//   network/lifecycle-linked-artifacts.mjs        (ledger-v3-r1 candidate, unchanged, SHA d9ad5264...)
//   network/lifecycle-schema3-profile.mjs         (this task's src/network)
//   deploy/lifecycle/schema3/bundle.json          (the reviewed unlinked compiler bundle; its SHA is embedded below)
//
//   node generate-lifecycle-schema3-adapter-candidate.mjs <abs r6 or r3 adapter> <abs bundle.json> <abs output file> [expected bundle sha256]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyInsertions, sha256 } from './insertion-patch.mjs';
import { generateAdapterCandidate as generateR3, R6_ADAPTER_SHA256 } from
  '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/lifecycle-independent-composition-review-r3/src/tools/generate-lifecycle-adapter-candidate.mjs';

export { R6_ADAPTER_SHA256 };
export const R3_ADAPTER_SHA256 = '8e666ed6970b8bfed283acfdd08bde917f7004bbdd4c9ebd51de038892406fb1';
export const R6_ADAPTER_PATH = '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/lifecycle-chain-adapter-stage/r6/network/deployment-chain-adapter.mjs';
export const BUNDLE_PATH = '/home/steven/Documents/Codex/2026-10-23/it/work/lifecycle-ledger-v3-r1/library-import-size-feedback/compiler/bundle.json';
export const SOURCE_SHA256 = Object.freeze({
  'candidate/deploy/EnclaveDeployments.sol': 'c720f1bfe021abcc4f080a5646d756c60a14cd2be8b746d995e3d1ba8b21da15',
  'candidate/deploy/EnclaveProofOfTime.sol': '946f0b90db1597ee95316029f467b8c7588e962c72168e78da77d3886f72eec5',
  'contracts/EnclaveDeploymentLifecycleEmergency.sol': 'ac4023b9ccac9b6b48536f78f07282e8a08e6669bd983bb292bbe1ea8a8ea677',
  'contracts/EnclaveSelfHostingIdentity.sol': 'f8dae9aba6c6ada4e92f9327fbb8801ae4bd15c645b0cea9a448a7f1bb1682e2' });
export const BUNDLE_KEYS = Object.freeze(['candidate/deploy/EnclaveDeployments.sol:EnclaveDeployments',
  'candidate/deploy/EnclaveDeployments.sol:EnclaveLifecycleAccounting', 'candidate/deploy/EnclaveProofOfTime.sol:EnclaveProofOfTime',
  'contracts/EnclaveDeploymentLifecycleEmergency.sol:EnclaveDeploymentLifecycleEmergency',
  'contracts/EnclaveSelfHostingIdentity.sol:EnclaveSelfHostingIdentity']);
const MARKER = 'SCHEMA3_PROFILE';

/** The reviewed bundle: exact source hashes, compiler, settings, five artifacts, EIP-170 runtimes (no override). -> sha256 */
export function checkBundle(bytes) {
  if (!Buffer.isBuffer(bytes)) throw Error('bundle bytes required');
  const b = JSON.parse(bytes.toString('utf8'));
  if (b.schema !== 1 || b.compiler !== '0.8.35+commit.47b9dedd.Linux.g++') throw Error('bundle is not the reviewed schema-1 solc 0.8.35 bundle');
  const s = b.settings ?? {};
  if (s.viaIR !== true || s.evmVersion !== 'prague' || s.optimizer?.enabled !== true || s.optimizer?.runs !== 1) throw Error('bundle compiler settings differ');
  const src = b.sourceSha256 ?? {};
  if (JSON.stringify(Object.keys(src).sort()) !== JSON.stringify(Object.keys(SOURCE_SHA256).sort()) ||
      Object.entries(SOURCE_SHA256).some(([k, v]) => src[k] !== v)) throw Error('bundle source hashes are not the qualified schema-3 sources');
  if (JSON.stringify(Object.keys(b.contracts ?? {}).sort()) !== JSON.stringify([...BUNDLE_KEYS].sort())) throw Error('bundle contracts differ');
  for (const k of BUNDLE_KEYS) {
    const a = b.contracts[k], n = (String(a.runtimeTemplate).length - 2) / 2;
    if (a.kind !== (k.endsWith(':EnclaveLifecycleAccounting') ? 'library' : 'contract') || !n || n > 24576 || a.runtimeBytes !== n)
      throw Error(`bundle artifact ${k} is malformed or exceeds EIP-170`);
  }
  return sha256(bytes);
}

export const schema3Edits = bundleSha256 => Object.freeze([
  { name: 'import',
    before: "import { independentAdmissionRefusal } from './lifecycle-independent-admission.mjs';\n",
    after: '\nconst ART = name => JSON.parse(',
    text: "// schema3 r1 (generated): explicit 'independent-schema3-r1' profile -> ACTUAL schema-3 controller/ledger/prover/identity + linked library\n" +
      "import { SCHEMA3_PROFILE, isSchema3Profile, prepareSchema3, verifySchema3AtBlock, schema3Emergency, schema3Fields, schema3AdapterFields } from './lifecycle-schema3-profile.mjs';\n" +
      "const SCHEMA3_BUNDLE_SHA256 = '" + bundleSha256 + "';   // the ONLY bundle this generated adapter accepts (pins cannot select another)\n" },
  { name: 'r6-abis',
    before: "const IDENTITY_ABI = ART('EnclaveSelfHostingIdentity').abi;\n",
    after: '// platform views (address book, catalog, registry)',
    text: 'const R6_ABIS = Object.freeze({ LIFECYCLE_ABI, LEDGER_ABI, IDENTITY_ABI });   // schema3 r1: the unchanged r6 schema-2 ABIs, by another name\n' },
  { name: 'profile-accept',
    before: '  if (pins?.profile === undefined) return false;\n',
    after: '  if (pins.profile !== INDEPENDENT_PROFILE) throw',
    text: '  if (pins.profile === SCHEMA3_PROFILE) return true;   // schema3 r1: also independent (address book = discovery) + schema3 checks/fields\n' },
  { name: 'adapter-s3',
    before: '  const INDEPENDENT = independentProfile(pins);         // r3: fixed for this adapter instance by its reviewed pins\n',
    after: '  getAddress(pins.payee);',
    text: "  // schema3 r1: S3 is true ONLY for pins.profile === 'independent-schema3-r1' (never inferred from a schema read or label). It uses the\n" +
      '  // ACTUAL schema-3 ABIs of the hash-pinned bundle and statically proves every link/immutable/self-address pin (prepareSchema3).\n' +
      '  const S3 = isSchema3Profile(pins);\n' +
      '  const S3P = S3 ? prepareSchema3(pins, SCHEMA3_BUNDLE_SHA256) : null;\n' +
      '  const LIFECYCLE_ABI = S3 ? S3P.abi.lifecycle : R6_ABIS.LIFECYCLE_ABI, LEDGER_ABI = S3 ? S3P.abi.ledger : R6_ABIS.LEDGER_ABI;\n' },
  { name: 'schema-open', before: "      if (await call(ledger, LEDGER_ABI, 'lifecycleSchema') !== ", after: "2n || await call(ledger, LEDGER_ABI, 'deploymentsSchema')", text: '(S3 ? 3n : ' },
  { name: 'schema-close', before: "      if (await call(ledger, LEDGER_ABI, 'lifecycleSchema') !== 2n", after: " || await call(ledger, LEDGER_ABI, 'deploymentsSchema')", text: ')' },
  { name: 'linked',
    before: "      if (await call(C('registry'), DEP_ABI.registry, 'registrySchema') < 4n) throw Error('registry below schema 4');\n",
    after: "      // the identity's FactoryPin[]",
    text: '      // schema3 r1: deployed library runtime + self address, every link and concrete immutable, and the controller/ledger/identity/\n' +
      '      // prover/registry pair with lifecycleSchema 3 / lifecycleProofSchema 2 / proofSchema 2 -- at THIS block, inside the SAME pinned\n' +
      '      // read as the whole recursive closure above (never a separate snapshot, never a replacement for it)\n' +
      '      if (S3) await verifySchema3AtBlock(S3P, client, number);\n' },
  { name: 'read-offline',
    before: "        const retired = INDEPENDENT ? await call(ledger, LEDGER_ABI, 'retired') : null;   // r3: reported at this block, never ignored\n",
    after: '        return { a, budget:',
    text: "        // schema3 r1: the controller's exact per-deployment emergency offline tuple and last emergency digest, at this same block\n" +
      "        const offline = S3 ? await call(lifecycle, LIFECYCLE_ABI, 'offline', [id]) : null;\n" +
      "        const lastEmergency = S3 ? await call(lifecycle, LIFECYCLE_ABI, 'lastEmergency', [id]) : null;\n" },
  { name: 'read-offline-return', before: 'blockSec: Number(header.timestamp), retired', after: ' };\n      });', text: ', offline, lastEmergency' },
  { name: 'pending-decl',
    before: '      const v = r.value, ok = qualified(r.evidence), adminChanged = r.adminChanges.length > 0;\n',
    after: '      const horizon = x =>',
    text: '      const s3 = S3 ? schema3Emergency(v.offline, v.lastEmergency, v.a) : null, s3Pending = s3 !== null && s3.pending === true;   // schema3 r1\n' },
  { name: 'pending-horizon', before: '      const fundedUntil = ', after: "v.a.state === 'running'\n        ? (v.ledgerFunded", text: 's3Pending ? v.blockSec : ' },
  { name: 'pending-funded', before: 'fundedUntil > v.blockSec : true)', after: ';\n      // this host only', text: ' && !s3Pending' },
  { name: 'pending-admitted', before: '      const admitted = hostOk && hostDenial === null && !adminChanged', after: ';\n      const snapshot = {', text: ' && !s3Pending' },
  { name: 'snapshot-fields',
    before: '        ...(INDEPENDENT ? independentFields(v, forPrivate, hostPolicyUnknown) : {}),   // r3 independent profile only\n',
    after: '        policy: v.policy, budget:',
    text: '        ...(S3 ? schema3Fields(v, s3) : {}),   // schema3 r1 only: schemas + emergency tuple; overrides profile/ledgerState/independence\n' },
  { name: 'adapter-object',
    before: '    ...(INDEPENDENT ? { profile: INDEPENDENT_PROFILE, independence: Object.freeze({ complete: false, blockers: INDEPENDENCE_BLOCKERS }) } : {}),   // r3\n',
    after: '    async read(id) {',
    text: '    ...(S3 ? schema3AdapterFields(S3P) : {}),   // schema3 r1\n' },
  { name: 'prepare-pending',
    before: "      if (snapshot?.id !== id || snapshot.verified !== true) throw Error('prepare needs a verified snapshot of this deployment');\n",
    after: '      if (!TARGET[target])',
    text: '      if (S3 && snapshot.emergency?.pending !== false)       // schema3 r1: the controller refuses EVERY transition while pending\n' +
      "        throw Error('emergency offline settlement pending (or unknown): reconcileOffline must settle the exact cutoff first; no transition prepared');\n" },
  { name: 'submit-offline-read',
    before: "maxGas: (await call(lifecycle, LIFECYCLE_ABI, 'budgets', [id]))[3]",
    after: ' }));\n      if (!qualified(f.evidence))',
    text: ", offline: S3 ? await call(lifecycle, LIFECYCLE_ABI, 'offline', [id]) : null" },
  { name: 'submit-pending',
    before: "      if (f.value.a.lastIntent === intent.digest) throw Error('intent already executed at the authenticated block: not resubmitted');\n",
    after: '      if (x.target === TARGET.running && f.adminChanges.length)',
    text: "      if (S3 && schema3Emergency(f.value.offline, null, f.value.a).pending) throw Error('emergency offline settlement pending at the authenticated block: not submitted');\n" },
  { name: 'proofstate-offline',
    before: "    threshold: Number(await call(lifecycle, LIFECYCLE_ABI, 'threshold', [id]))",
    after: ' });\n\n  function parse(',
    text: ", offline: S3 ? await call(lifecycle, LIFECYCLE_ABI, 'offline', [id]) : null, lastEmergency: S3 ? await call(lifecycle, LIFECYCLE_ABI, 'lastEmergency', [id]) : null" },
  { name: 'resolve-emergency',
    before: '        authority: authority.kind, digest: pending.digest, outcome: res.outcome, proof: res.proof,\n',
    after: '        ...(res.reason',
    text: '        ...(S3 ? { emergency: schema3Emergency(r.value.offline, r.value.lastEmergency, r.value.a) } : {}),   // schema3 r1: exposed, never a proof\n' },
  { name: 'finalize-emergency',
    before: '        authority: authority.kind, digest: intent.digest, outcome: res.outcome, proof: res.proof,\n',
    after: '        ...(res.reason',
    text: '        ...(S3 ? { emergency: schema3Emergency(r.value.offline, r.value.lastEmergency, r.value.a) } : {}),   // schema3 r1: exposed, never a proof\n' },
]);

/** (r6 or r3 adapter text, bundle bytes) -> { source, sha256, manifest, r3Sha256, bundleSha256 }. Pure. */
export function generateSchema3Candidate(input, bundleBytes, { expectedBundleSha256 = null } = {}) {
  const got = sha256(input);
  let r3;
  if (got === R6_ADAPTER_SHA256) r3 = generateR3(input).source;
  else if (got === R3_ADAPTER_SHA256) r3 = input;
  else throw Error(`input ${got} is neither the frozen r6 adapter nor the reviewed r3 candidate`);
  if (sha256(r3) !== R3_ADAPTER_SHA256) throw Error('the r3 generator did not reproduce the reviewed r3 candidate');
  const bundleSha256 = checkBundle(bundleBytes);
  if (expectedBundleSha256 !== null && bundleSha256 !== expectedBundleSha256) throw Error(`bundle ${bundleSha256} is not the expected ${expectedBundleSha256}`);
  const r = applyInsertions(r3, { expectedSha256: R3_ADAPTER_SHA256, edits: schema3Edits(bundleSha256), marker: MARKER,
    what: 'reviewed r3 deployment-chain-adapter candidate' });
  return { ...r, r3Sha256: R3_ADAPTER_SHA256, bundleSha256 };
}

export function writeSchema3Candidate(inputFile, bundleFile, outputFile, expectedBundleSha256 = null) {
  if (![inputFile, bundleFile, outputFile].every(f => path.isAbsolute(f))) throw Error('absolute input, bundle and output paths required');
  const real = fs.realpathSync(inputFile), outDir = fs.realpathSync(path.dirname(outputFile)), outReal = path.join(outDir, path.basename(outputFile));
  if (outReal === real || outDir === path.dirname(real)) throw Error('the candidate must be written outside the input directory');
  const before = sha256(fs.readFileSync(real, 'utf8'));
  const r = generateSchema3Candidate(fs.readFileSync(real, 'utf8'), fs.readFileSync(fs.realpathSync(bundleFile)), { expectedBundleSha256 });
  fs.writeFileSync(outReal, r.source, { flag: 'wx', mode: 0o644 });
  if (sha256(fs.readFileSync(real, 'utf8')) !== before) throw Error('input changed during generation');
  return { output: outReal, sha256: r.sha256, baselineSha256: r.baselineSha256, r3Sha256: r.r3Sha256, bundleSha256: r.bundleSha256, manifest: r.manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [input, bundle, output, expect] = process.argv.slice(2);
  if (!input || !bundle || !output) { console.error('usage: generate-lifecycle-schema3-adapter-candidate.mjs <r6|r3 adapter> <bundle.json> <output> [bundle sha256]'); process.exit(2); }
  console.log(JSON.stringify(writeSchema3Candidate(input, bundle, output, expect ?? null), null, 1));
}
