// EXACT PINNED RECOVERY TARGET for the two frozen helpers (ROOT EXECUTES after activating the recovery image; prepared
// 2026-10-23; not run by its author). The helpers are imported UNCHANGED (sha256-pinned below) and get ONE extra target,
// "recovery", added in-process: the root-approved boot-registration build H 9f6d37bd on a6b1378c, root's PASS at 21:54:50Z
// (../custody-recipient-restore-20261023/BUILD-APPROVED-RESULT.md). There is no measurement flag: the pin is this file's
// constant, re-tied before any network call to the image files' hashes, at the production path after root copies it, else
// the approved stage path (every location that exists must match all five). The verifier modules stay the a6b1378c pins
// (attest-control.mjs checkPins).
//   node recovery-target.mjs attest                                   -> attest-control probe, target recovery; exit 0 only if verified
//   node recovery-target.mjs proofkey --expect-proof-key 0x<this boot>  -> verify-recipient-proofkey, target recovery; 0 / 2 pending / 1
// The legacy limits are unchanged and carried in every proof-key verdict: the proof key is NOT hardware-bound (relay-routed
// origin, part B); only part A's fresh quote is.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as AC from './attest-control.mjs';
import * as PK from './verify-recipient-proofkey.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FROZEN = {   // attest-control.mjs at 2d407753, verify-recipient-proofkey.mjs at cb7fa858
  'attest-control.mjs': '79c59a821c7b375fc383391c4ded09ebc60d2df662dd1b277cfead0b32d7c8de',
  'verify-recipient-proofkey.mjs': '92097dd2518f578058033b888063e6bf23810fc6b1336800d6858f4b0c85aa70',
};
export const RECOVERY = Object.freeze({
  measurement: '08d1f838d51274571fdf17b635606d20a6e7250f74d6676217eea40733a8d269aaf52edb85aac4a9ad1cc5c53318a000',
  source: 'root-approved build of H 9f6d37bd on a6b1378c (custody-recipient-restore-20261023 BUILD-APPROVED-RESULT.md; 2 identical builds)',
  images: Object.freeze(['/home/steven/enclave-prod/dist-leasegas-9f6d37bd8',
                         path.resolve(HERE, '../custody-recipient-restore-20261023/stage-approved/dist-leasegas-9f6d37bd8')]),
  files: Object.freeze({
    MEASUREMENT: '6d55c0e2839e5a1aad1258ce80ec112181f155c50be9f5ad1f66f1bb44064537',
    'manifest.json': '64bd025db3ed62b82f016ed25f1bd24ab300dbe7520ca81498d3ccd293e43b16',
    'initramfs.cpio.gz': '02c7280a7020f29395d9e38e361d72aad8b39311218a1dd272dc2893e562dfaf',
    vmlinuz: '1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7',
    cmdline: 'd9e04c2c4769a4aadeaf4591e8e825ac513bf89f2677918d7e74638d8c9c90b8',
  }),
});

function fileSha(f) {   // streamed (the initramfs is ~270 MiB)
  const h = crypto.createHash('sha256'), b = Buffer.alloc(1 << 20), fd = fs.openSync(f, 'r');
  try { for (let n; (n = fs.readSync(fd, b, 0, b.length, null)) > 0;) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

export function checkFrozen(dir = HERE) {
  for (const [f, h] of Object.entries(FROZEN)) if (fileSha(path.join(dir, f)) !== h) throw new Error(`${f} is not the frozen helper`);
}

/** -> the image path used; every listed location that exists must carry all pinned files, and at least one must exist. */
export function checkRecoveryImage(t = RECOVERY) {
  const present = t.images.filter((p) => fs.existsSync(p));
  if (!present.length) throw new Error(`no recovery image at ${t.images.join(' or ')}`);
  for (const p of present) {
    for (const [f, h] of Object.entries(t.files)) if (fileSha(path.join(p, f)) !== h) throw new Error(`${p}/${f} is not the approved file`);
    if (fs.readFileSync(path.join(p, 'MEASUREMENT'), 'utf8').trim() !== t.measurement) throw new Error(`${p}/MEASUREMENT does not name the pin`);
  }
  return present[0];
}

/** Adds exactly TARGETS.recovery to the frozen helpers' shared target table (in-process only). */
export function installTarget(image, t = RECOVERY) {
  const entry = Object.freeze({ measurement: t.measurement, image, source: t.source, files: t.files });
  const have = AC.TARGETS.recovery;
  if (have && (have.measurement !== entry.measurement || have.image !== image)) throw new Error('a different recovery target is already installed');
  if (!have) AC.TARGETS.recovery = entry;
  return AC.TARGETS.recovery;
}

/** The attest verdict this wrapper accepts: the frozen probe's own pass, for the recovery target, at exactly the pin. */
export function attestAccepted(v, t = RECOVERY) {
  return v.pass === true && v.target === 'recovery' && v.expectedMeasurement === t.measurement && v.observedMeasurement === t.measurement;
}

export async function attest({ deps } = {}) {
  const { verdict, raw } = await AC.probe({ target: 'recovery', deps });
  verdict.wrapper = 'recovery-target/1'; verdict.accepted = attestAccepted(verdict);
  return { verdict, raw };
}

export async function proofkey({ expectProofKey, deps } = {}) {
  const r = await PK.run({ target: 'recovery', expectProofKey, deps });
  if (r.verdict.expectedMeasurement !== RECOVERY.measurement) throw new Error('the proof-key helper did not pin the recovery measurement');
  r.verdict.wrapper = 'recovery-target/1';
  return r;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const mode = process.argv[2];
  if (mode !== 'attest' && mode !== 'proofkey') { console.error('usage: recovery-target.mjs attest | proofkey --expect-proof-key 0x...'); process.exit(1); }
  checkFrozen(); AC.checkPins();
  const image = checkRecoveryImage(); installTarget(image);
  if (mode === 'attest') {
    const { verdict, raw } = await attest();
    const files = AC.persist(verdict, raw);
    console.log(JSON.stringify({ accepted: verdict.accepted, status: verdict.status, target: verdict.target, image, required: verdict.required, crl: verdict.crl,
                                 observed: verdict.observedMeasurement?.slice(0, 16), expected: verdict.expectedMeasurement.slice(0, 16),
                                 transportKeySha256: verdict.transportKeySha256, failedChecks: verdict.failedChecks, verdict: files.pub, rawSha256: verdict.rawSha256 }));
    process.exit(verdict.accepted ? 0 : 1);
  }
  const i = process.argv.indexOf('--expect-proof-key');
  const { verdict, raw } = await proofkey({ expectProofKey: i > 0 ? process.argv[i + 1] : undefined });
  const f = PK.persist(verdict, raw);
  console.log(JSON.stringify({ status: verdict.status, image, parts: verdict.parts, proofKey: verdict.expectedProofKey, served: verdict.servedProofKey,
                               registryProofKey: verdict.registry?.proofKey ?? null, transportKeySha256: verdict.transportKeySha256 ?? null, verdict: f.pub }));
  process.exit(verdict.exitCode);
}
