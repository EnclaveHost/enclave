// NONCE-BOUND SEV-SNP verification of metal0's CONTROL VM against the pinned restore image (ROOT EXECUTES after activation;
// prepared 2026-10-23; not run by its author). It is a thin, reviewed wrapper around the EXISTING trusted client verifier,
// verifier/consumer.mjs verifyMetalBox (rules in verifier/metal-box.mjs + verifier/snp.mjs; the CLI's `enclave attest`),
// imported from the restore repo at a6b1378c with every module hash pinned:
//   1. FRESHNESS: OUR random 32-byte nonce -> GET api.enclave.host/v1/enclaves/metal0/attestation?nonce=; the relay forwards it
//      over the box's tunnel; the box's agent answers with a NEW quote whose report_data[0:32] = sha256(transport SPKI || nonce)
//      and report_data[32:64] = 0 (metal format). The relay cannot forge it (it is AMD-signed), only withhold it.
//   2. GENUINENESS: VCEK (the box's own cert table, else AMD KDS directly) signs the report, chains to the PINNED AMD ARK, CRL,
//      VCEK chip/TCB match the report, guest policy (no DEBUG / MIGRATE_MA), VMPL 0, the published Turin TCB floor.
//   3. WHAT RUNS: the launch measurement must equal the PINNED full ee5df6b8... value (caller-pinned, so the verdict can be
//      "verified", never the operator-stated "limited"); the pin is re-tied to the reviewed staged image (MEASUREMENT and
//      manifest.json hashes) before any network call.
// Output: a PUBLIC verdict (no raw report, chip id or VCEK fingerprint; their sha256 only) to evidence/attestation-<UTC>.json,
// and the RAW relay answer to evidence/private/attestation-raw-<UTC>.json, mode 0600, gitignored. Exit 0 ONLY for status
// "verified" with every required check true. UNAVAILABLE checks are listed as such and are never counted as a PASS.
//   node work/custody-recipient-activation-20261023/attest-control.mjs [--target new|current]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../custody-recipient-restore-20261023/repo');
export const REPO_COMMIT = 'a6b1378cdf430217025987d90c040d0e25a9993d';
export const VERIFIER_PINS = {
  'verifier/consumer.mjs': '907e40bfd42529aa907c3267b7ec0cb9652d9c250b196e00c1508a7e460608e1',
  'verifier/metal-box.mjs': '6bcbb136b320ed01add947626d7a19d44a9e6db9606744cc8c0e667bc89abef2',
  'verifier/snp.mjs': 'beb7571c9b3004da4cd8bfd87377e2dd2fcaca72884b83676325d1e150df6721',
  'verifier/envelope.mjs': 'ba94f540c5e3574c5750dbf8a0d5cf24885dd0ae3ffcc8729f526700015e4b39',
  'verifier/collateral.mjs': 'c2be31edf2d6a2154f5e220c5cc1bcaa16a7f9e06065fd1290e06387e55a057f',
  'verifier/collateral-cache.mjs': 'eab07f86acc54f5411fb2e9148b155d0ccc7e12bc608453c8f73b9869181f7b6',
  'verifier/der.mjs': '3606e988e4d340973c105fdc7fc0ee39db13034419561fbbe2e0ee396ade9775',
  'verifier/tls-binding.mjs': 'f11b1ff36e43f90c20b2349a9880dc1f86821a7270b31273c612bd4a532dc8e7',
  'relay/snp-verify.mjs': '10520dd25d6a7a40225a7076521c383fc3eb296b1f290ac6b9e9fbbd1697de91',   // = the control image's /app/relay/snp-verify.mjs
};
export const TARGETS = {
  new: { measurement: 'ee5df6b83948f5bacebee414574adb87be9d58412b09ae9183fc4deed5aed3d96bc1cbead096372e7ee755febbbc22ec',
         image: '/home/steven/enclave-prod/dist-leasegas-a6b1378cd', source: 'restore build a6b1378c (reproducible; custody-recipient-restore-20261023 stage/INVENTORY.sha256)',
         files: { MEASUREMENT: 'd99cb42849311fb017b76b35bb200ff847ea2d548b369ddffabf5e6c954660c9', 'manifest.json': '3874066dff197d154f51f1fe791ab66e5000e81017670cb6c39cb861e79ec12b' } },
  current: { measurement: 'ed918e4b393699b3f6251853d2d34317869d7d9e3150b41ffa917df3d392012c682f376a799494d01e6a6dd5bedd2ac2',
             image: '/home/steven/enclave-prod/dist-leasegas-deabf8f90', source: 'production deabf8f90 (reproduced byte-identically by the restore control build)',
             files: { 'manifest.json': 'c7cb436db609f361a07d5f32a8a0d71f4fc399f329d244ff2512da8ca34dfca4' } },
};
// what the route and this tool cannot establish: listed in every verdict, never counted as a pass
export const UNAVAILABLE = [
  'operator identity: this route returns no attach operator signature, so the registry operator behind metal0 is not checked here (the relay checks it at attach; root reads it separately)',
  'attach-key equality: the snp route does not return the relay\'s attach-time transport key; the verdict binds the key the document names (transportKeySha256)',
  'custody vault in the supervisor env: not directly attestable; implied only by the measurement (the vault constants are measured gsup source in the initramfs)',
];
export const REQUIRED_CHECKS = ['report shape', 'product line', 'guest policy', 'chain', 'tcb policy', 'measurement', 'binding'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function checkPins(repo = REPO) {
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).toString().trim();
  if (head !== REPO_COMMIT) throw new Error(`restore repo HEAD ${head} is not ${REPO_COMMIT}`);
  for (const [f, h] of Object.entries(VERIFIER_PINS)) if (sha(fs.readFileSync(path.join(repo, f))) !== h) throw new Error(`${f} is not the pinned verifier`);
}
export function checkImage(target) {
  const t = TARGETS[target]; if (!t) throw new Error(`unknown target ${target}`);
  for (const [f, h] of Object.entries(t.files)) if (sha(fs.readFileSync(path.join(t.image, f))) !== h) throw new Error(`${t.image}/${f} is not the reviewed file`);
  if (t.files.MEASUREMENT && fs.readFileSync(path.join(t.image, 'MEASUREMENT'), 'utf8').trim() !== t.measurement) throw new Error('MEASUREMENT does not name the pin');
  return t;
}

// -> { verdict (public), raw (the relay answer, private) }; deps lets the tests pass offline fetch/collateral/clock
export async function probe({ target = 'new', expectedMeasurement = null, apiBase = 'https://api.enclave.host', deps = {} } = {}) {
  const C = await import(pathToFileURL(path.join(REPO, 'verifier/consumer.mjs')).href);
  const want = expectedMeasurement || TARGETS[target].measurement;
  let rawBody = null;
  const realFetch = deps.fetchImpl || globalThis.fetch;
  const fetchImpl = async (url, opts) => {   // records the relay's exact answer for the private raw file; changes nothing
    const r = await realFetch(url, opts); const text = await r.text(); rawBody = { url, status: r.status, text };
    return { status: r.status, text: async () => text };
  };
  const v = await C.verifyMetalBox({ apiBase, name: 'metal0', expected: { measurements: [want], source: TARGETS[target]?.source || 'test' },
                                     collateral: deps.collateral ?? null, fetchImpl, now: deps.now, timeoutMs: deps.timeoutMs ?? 20000 });
  const claims = v.claims || {};
  const chipId = claims.chipId ? String(claims.chipId) : null;
  const scrub = (s) => { let t = String(s); for (const x of [chipId, chipId && chipId.slice(0, 16), claims.vcekFingerprint].filter(Boolean)) t = t.split(x).join('<redacted>'); return t; };
  const checks = v.checks || {};
  const required = Object.fromEntries(REQUIRED_CHECKS.map((k) => [k, checks[k] === true ? 'PASS' : checks[k] === false ? 'FAIL' : 'UNAVAILABLE']));
  const pass = v.status === 'verified' && v.admissionSafe === true && Object.values(required).every((x) => x === 'PASS')
    && claims.measurement === want && claims.freshness === 'verifier nonce' && claims.vmpl === 0;
  const verdict = {
    probe: 'attest-control/1', at: v.at, target, pass, status: v.status, admissionSafe: v.admissionSafe === true,
    expectedMeasurement: want, observedMeasurement: claims.measurement ?? null, measurementMatches: claims.measurement === want,
    freshness: claims.freshness ?? null, nonce: v.nonce ?? null, transportKeySha256: v.transportKeySha256 ?? null,
    required, checks, crl: checks.crl === true ? 'PASS' : checks.crl === false ? 'FAIL' : 'UNAVAILABLE', failedChecks: v.failedChecks || [], omissions: v.omissions || [],
    product: claims.product ?? null, reportVersion: claims.reportVersion ?? null, vmpl: claims.vmpl ?? null, guestPolicy: claims.guestPolicy ?? null,
    tcb: claims.tcb ?? null, firmware: claims.firmware ?? null, hostData: claims.hostData ?? null, reportData: claims.reportData ?? null,
    arkFingerprint: claims.arkFingerprint ?? null, vcekSource: claims.vcekSource ?? null, collateral: claims.collateral ?? null,
    chipIdSha256: chipId ? sha(Buffer.from(chipId, 'hex')) : null, relayAdmittedAtAttach: v.expected?.admittedAtAttach ?? null,
    unavailable: UNAVAILABLE, reasons: (v.reasons || []).map(scrub),
    rawSha256: rawBody ? sha(Buffer.from(JSON.stringify(rawBody))) : null,
  };
  return { verdict, raw: rawBody };
}

export function persist(verdict, raw, dir = path.join(HERE, 'evidence')) {
  const stamp = String(verdict.at).replace(/[:.]/g, '');
  const priv = path.join(dir, 'private'); fs.mkdirSync(priv, { recursive: true, mode: 0o700 }); fs.chmodSync(priv, 0o700);
  const rawFile = path.join(priv, `attestation-raw-${stamp}.json`);
  if (raw) { fs.writeFileSync(rawFile, JSON.stringify(raw), { mode: 0o600, flag: 'wx' }); fs.chmodSync(rawFile, 0o600); }
  const pub = path.join(dir, `attestation-${stamp}.json`);
  fs.writeFileSync(pub, JSON.stringify(verdict, null, 2) + '\n', { flag: 'wx' });
  return { pub, rawFile: raw ? rawFile : null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const i = process.argv.indexOf('--target'); const target = i > 0 ? process.argv[i + 1] : 'new';
  checkPins(); checkImage(target);
  const { verdict, raw } = await probe({ target });
  const files = persist(verdict, raw);
  console.log(JSON.stringify({ pass: verdict.pass, status: verdict.status, target, required: verdict.required, crl: verdict.crl,
                               observed: verdict.observedMeasurement?.slice(0, 16), expected: verdict.expectedMeasurement.slice(0, 16),
                               failedChecks: verdict.failedChecks, unavailable: verdict.unavailable.length, verdict: files.pub, rawSha256: verdict.rawSha256 }));
  process.exit(verdict.pass ? 0 : 1);
}
