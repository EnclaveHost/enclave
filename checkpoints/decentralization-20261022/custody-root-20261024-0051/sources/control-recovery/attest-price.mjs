// EXACT ATTESTATION TARGET "priceRecovery" for the frozen helpers (ROOT EXECUTES after activating the boot GPU-price image;
// prepared 2026-10-23; not run by its author). The measurement is NEVER a constant here: it is read from THIS folder's build.json,
// accepted only with root's APPROVED-BUILD.txt naming exactly its sha256, and re-tied before any network call to every image file
// (each location that exists: ~/enclave-prod/<name> after stage.py, and the build folder's stage/<name>; at least one). The
// frozen helpers are imported UNCHANGED from work/custody-recipient-activation-20261023 (sha256-pinned) and get ONE extra target,
// in-process; their verifier modules stay the a6b1378c pins (attest-control.mjs checkPins).
//   node attest-price.mjs attest                                   -> evidence/attestation-<UTC>.json (+ private raw 0600); exit 0 only if accepted
//   node attest-price.mjs proofkey --expect-proof-key 0x<this boot> -> evidence/recipient-proofkey-<UTC>.json; 0 / 2 pending / 1
// Legacy limits are unchanged and carried in every proof-key verdict: the proof key is NOT SNP-bound (relay-routed origin, part B);
// only part A's fresh quote is hardware-bound.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HELPERS = path.resolve(HERE, '../custody-recipient-activation-20261023');
export const FROZEN = {   // attest-control.mjs at 2d407753, verify-recipient-proofkey.mjs at cb7fa858
  'attest-control.mjs': '79c59a821c7b375fc383391c4ded09ebc60d2df662dd1b277cfead0b32d7c8de',
  'verify-recipient-proofkey.mjs': '92097dd2518f578058033b888063e6bf23810fc6b1336800d6858f4b0c85aa70',
};
export const BUILD = path.resolve(HERE, '../custody-boot-fee-release-20261023');
export const PROD = '/home/steven/enclave-prod';
export const PRIORS = ['ed918e4b393699b3f6251853d2d34317869d7d9e3150b41ffa917df3d392012c682f376a799494d01e6a6dd5bedd2ac2',
  'ee5df6b83948f5bacebee414574adb87be9d58412b09ae9183fc4deed5aed3d96bc1cbead096372e7ee755febbbc22ec',
  '08d1f838d51274571fdf17b635606d20a6e7250f74d6676217eea40733a8d269aaf52edb85aac4a9ad1cc5c53318a000',
  'b007d47147d52ea01780abdee5f7b28d2eb02102a7915bf5f8dcafbf7d2a77b6a9ebb9d8b848acb8dd6377be5f1c09c6'];
const FILES = ['MEASUREMENT', 'cmdline', 'initramfs.cpio.gz', 'manifest.json', 'vmlinuz'];

function fileSha(f) {   // streamed (the initramfs is ~270 MiB)
  const h = crypto.createHash('sha256'), b = Buffer.alloc(1 << 20), fd = fs.openSync(f, 'r');
  try { for (let n; (n = fs.readSync(fd, b, 0, b.length, null)) > 0;) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
export function checkFrozen(dir = HELPERS) {
  for (const [f, h] of Object.entries(FROZEN)) if (fileSha(path.join(dir, f)) !== h) throw new Error(`${f} is not the frozen helper`);
}

/** root's approved build.json -> { measurement, name, files, images, buildSha256 }; refuses anything unapproved or malformed. */
export const FEEKIT = path.resolve(HERE, '../custody-boot-fee-activation-20261023');   // root's approved build.json lives there (reused)
export function approvedTarget(dir = FEEKIT, { build = BUILD, prod = PROD } = {}) {
  const raw = fs.readFileSync(path.join(dir, 'build.json'));
  const h = crypto.createHash('sha256').update(raw).digest('hex');
  if (fs.readFileSync(path.join(dir, 'APPROVED-BUILD.txt'), 'utf8') !== `build-sha256 ${h}\n`) throw new Error('APPROVED-BUILD.txt does not approve exactly this build.json');
  const rec = JSON.parse(raw);
  const m = String(rec.measurement || '');
  if (!/^[0-9a-f]{96}$/.test(m) || PRIORS.includes(m)) throw new Error('build.json carries no new measurement');
  if (!/^[0-9a-f]{40}$/.test(String(rec.commit)) || rec.name !== `dist-leasegas-${rec.commit.slice(0, 9)}`) throw new Error('build.json names no candidate image');
  if (JSON.stringify(Object.keys(rec.files || {}).sort()) !== JSON.stringify([...FILES].sort()) || !Object.values(rec.files).every((x) => /^[0-9a-f]{64}$/.test(x)))
    throw new Error('build.json files are not the five image files');
  return Object.freeze({ measurement: m, name: rec.name, files: Object.freeze({ ...rec.files }), buildSha256: h, commit: rec.commit,
    images: Object.freeze([path.join(prod, rec.name), path.join(build, 'stage', rec.name)]) });
}

/** -> the image path used; every listed location that exists must carry all approved files, and at least one must exist. */
export function checkImage(t) {
  const present = t.images.filter((p) => fs.existsSync(p));
  if (!present.length) throw new Error(`no approved image at ${t.images.join(' or ')}`);
  for (const p of present) {
    for (const [f, h] of Object.entries(t.files)) if (fileSha(path.join(p, f)) !== h) throw new Error(`${p}/${f} is not the approved file`);
    if (fs.readFileSync(path.join(p, 'MEASUREMENT'), 'utf8').trim() !== t.measurement) throw new Error(`${p}/MEASUREMENT does not name the approved measurement`);
  }
  return present[0];
}

let AC = null, PK = null;
async function helpers() {
  checkFrozen();
  AC ??= await import(path.join(HELPERS, 'attest-control.mjs')); PK ??= await import(path.join(HELPERS, 'verify-recipient-proofkey.mjs'));
  return { AC, PK };
}

/** Adds exactly TARGETS.priceRecovery to the frozen helpers' shared target table (in-process only). */
export async function installTarget(t, image) {
  const { AC } = await helpers();
  const entry = Object.freeze({ measurement: t.measurement, image, source: `root-approved build ${t.commit.slice(0, 9)} (build.json ${t.buildSha256.slice(0, 16)})`, files: t.files });
  const have = AC.TARGETS.priceRecovery;
  if (have && (have.measurement !== entry.measurement || have.image !== image)) throw new Error('a different priceRecovery target is already installed');
  if (!have) AC.TARGETS.priceRecovery = entry;
  return AC.TARGETS.priceRecovery;
}

/** The attest verdict this wrapper accepts: the frozen probe's own pass, for priceRecovery, at exactly the approved measurement. */
export function attestAccepted(v, t) {
  return v.pass === true && v.status === 'verified' && v.target === 'priceRecovery' && v.expectedMeasurement === t.measurement
    && v.observedMeasurement === t.measurement && Array.isArray(v.failedChecks) && v.failedChecks.length === 0;
}

export async function attest(t, { deps } = {}) {
  const { AC } = await helpers();
  const { verdict, raw } = await AC.probe({ target: 'priceRecovery', deps });
  verdict.wrapper = 'attest-price/1'; verdict.buildSha256 = t.buildSha256; verdict.accepted = attestAccepted(verdict, t);
  return { verdict, raw };
}

export async function proofkey(t, { expectProofKey, deps } = {}) {
  const { PK } = await helpers();
  const r = await PK.run({ target: 'priceRecovery', expectProofKey, deps });
  if (r.verdict.expectedMeasurement !== t.measurement) throw new Error('the proof-key helper did not pin the approved measurement');
  r.verdict.wrapper = 'attest-price/1'; r.verdict.buildSha256 = t.buildSha256;
  return r;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const mode = process.argv[2];
  if (mode !== 'attest' && mode !== 'proofkey') { console.error('usage: attest-price.mjs attest | proofkey --expect-proof-key 0x...'); process.exit(1); }
  const { AC, PK } = await helpers(); AC.checkPins();
  const t = approvedTarget(); const image = checkImage(t); await installTarget(t, image);
  const ev = path.join(HERE, 'evidence');
  if (mode === 'attest') {
    const { verdict, raw } = await attest(t);
    const files = AC.persist(verdict, raw, ev);
    console.log(JSON.stringify({ accepted: verdict.accepted, status: verdict.status, target: verdict.target, image, required: verdict.required, crl: verdict.crl,
      observed: verdict.observedMeasurement?.slice(0, 16), expected: verdict.expectedMeasurement.slice(0, 16), transportKeySha256: verdict.transportKeySha256,
      failedChecks: verdict.failedChecks, verdict: files.pub, raw: files.rawFile, rawSha256: verdict.rawSha256 }));
    process.exit(verdict.accepted ? 0 : 1);
  }
  const i = process.argv.indexOf('--expect-proof-key');
  const { verdict, raw } = await proofkey(t, { expectProofKey: i > 0 ? process.argv[i + 1] : undefined });
  const f = PK.persist(verdict, raw, ev);
  console.log(JSON.stringify({ status: verdict.status, image, parts: verdict.parts, proofKey: verdict.expectedProofKey, served: verdict.servedProofKey,
    registryProofKey: verdict.registry?.proofKey ?? null, transportKeySha256: verdict.transportKeySha256 ?? null, verdict: f.pub }));
  process.exit(verdict.exitCode);
}
