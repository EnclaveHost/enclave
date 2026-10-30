// Operator-selected desktop identity. Neither manager health nor app config is
// an authority for these pins. Loading this file does not admit a launch.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';
import { validateDesktopRelease } from '../../relay/shield-desktop-release.mjs';
import { canonical, sha256Hex } from '../../relay/shield-derive.mjs';
import { DESKTOP_DERIVATION, validateDesktopRecord } from '../../relay/shield-desktop-derive.mjs';

export const MAX_DESKTOP_RELEASE_BYTES = 64 * 1024;

export function desktopReleaseFromEnv(env = process.env) {
  const file = env.ENCLAVE_DESKTOP_RELEASE_FILE;
  const expected = env.ENCLAVE_DESKTOP_RELEASE_SHA256;
  if ((file === undefined || file === '') && (expected === undefined || expected === '')) return null;
  if (typeof file !== 'string' || !file || file.includes('\0'))
    throw new Error('ENCLAVE_DESKTOP_RELEASE_FILE must name the approved local release file');
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected) || expected === '0'.repeat(64))
    throw new Error('ENCLAVE_DESKTOP_RELEASE_SHA256 must pin the exact file bytes');
  // A bounded read from one regular-file descriptor avoids unbounded reads and
  // stat/reopen races. O_NONBLOCK prevents a substituted FIFO blocking startup.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_DESKTOP_RELEASE_BYTES)
      throw new Error('desktop release must be a regular file of 1..65536 bytes');
    const buffer = Buffer.alloc(MAX_DESKTOP_RELEASE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const got = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!got) break;
      length += got;
    }
    if (length !== stat.size || length > MAX_DESKTOP_RELEASE_BYTES)
      throw new Error('desktop release changed size or exceeds its limit');
    bytes = buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('desktop release SHA-256 mismatch');
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return validateDesktopRelease(raw);
}


/** Manager consistency check, not attestation or authorization for secrets. */
export function desktopAdoptionRefusal(view, plan, approvedRelease) {
  if (plan?.derivation !== DESKTOP_DERIVATION) return null;
  let release, record;
  try {
    release = validateDesktopRelease(approvedRelease);
    record = plan.spawn.derive;
    validateDesktopRecord(record);
    if (record.cid !== release.controllerCid || record.runtimeId !== release.runtimeId ||
        record.desktop.profileSha256 !== release.profileSha256 ||
        record.policy.cpuPercent !== release.policy.cpuPercent || record.policy.vcpus !== release.policy.vcpus)
      return 'native desktop plan differs from the independently pinned release';
  } catch { return 'native desktop plan has no valid independently pinned release'; }
  if (!view || typeof view !== 'object') return 'no manager view of the native desktop';
  const expected = { name: record.secretDeployment, derivation: DESKTOP_DERIVATION,
    recordSha256: sha256Hex(canonical(record)), componentSha256: release.controllerSha256,
    runtimeId: release.runtimeId, imageRole: 'desktop', igvmSha256: release.igvmSha256,
    image: release.igvmSha256 };
  for (const [key,value] of Object.entries(expected))
    if (view[key] !== value) return `native desktop ${key} does not match the planned identity`;
  for (const key of ['profile','profileSha256','gpuMilli'])
    if (view.desktop?.[key] !== record.desktop[key])
      return `native desktop ${key} does not match the planned identity`;
  return null;
}
