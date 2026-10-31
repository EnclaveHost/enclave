// Maintained equivalent of the installed, owner-pinned native sidecar gate.
// This selects a deployment and sizing policy, not host capacity or attestation.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DESKTOP_DERIVATION } from './desktop-derive.mjs';
import { NATIVE_24G_MEMORY_PROFILE } from './desktop-memory.mjs';

const hash = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const id = s => typeof s === 'string' && /^0x[0-9a-f]{64}$/.test(s);
export function nativeInstanceFromBytes(bytes, expectedHash, { port, dataPort, prefix } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 65536 || !hash(expectedHash)
      || createHash('sha256').update(bytes).digest('hex') !== expectedHash)
    throw new Error('native instance configuration hash or size differs');
  if (port !== 8095 || dataPort !== 8096 || prefix !== 'enclave-native-')
    throw new Error('native instance requires its dedicated ports and VM scope');
  const p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).nativePins;
  if (!p || !id(p.deployment) || !id(p.catalogApp) || !Number.isSafeInteger(p.catalogVersion) || p.catalogVersion < 0
      || typeof p.cid !== 'string' || !p.cid.length || p.cid.length > 256 || !hash(p.runtimeId) || !hash(p.profileSha256))
    throw new Error('native instance deployment pins are incomplete');
  const pins = Object.freeze({ deployment: p.deployment, catalogApp: p.catalogApp, catalogVersion: p.catalogVersion,
    cid: p.cid, runtimeId: p.runtimeId, profileSha256: p.profileSha256 });
  return Object.freeze({ pins, prefix, marker: 'enclave-native-vbslike-domain',
    memoryProfile: NATIVE_24G_MEMORY_PROFILE,
    check(body) {
      const d = body?.derive;
      if (body?.name !== pins.deployment || !/^nd[0-9a-f]{32}$/.test(body?.id || '')
          || d?.derivation !== DESKTOP_DERIVATION || d?.catalog?.app !== pins.catalogApp
          || d?.catalog?.version !== pins.catalogVersion || d?.cid !== pins.cid || d?.runtimeId !== pins.runtimeId
          || d?.desktop?.profileSha256 !== pins.profileSha256 || d?.secretDeployment !== pins.deployment
          || body?.cpuShare !== .25 || body?.gpuShare !== .5 || d?.desktop?.gpuMilli !== 500)
        throw Object.assign(new Error('request differs from pinned native deployment'), { status: 400 });
    } });
}

export function loadNativeInstance(env, options) {
  const file = env.ENCLAVE_NATIVE_ROUTER_CONFIG, digest = env.ENCLAVE_NATIVE_ROUTER_CONFIG_SHA256;
  if (file === undefined && digest === undefined) return null;
  if (typeof file !== 'string' || !path.win32.isAbsolute(file) || !hash(digest))
    throw new Error('pinned native router configuration required');
  // Bound allocation before reading. The actual installation/config namespace
  // must be owner-protected before activation; a digest is not that authority.
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 65536) throw new Error('native config size');
    const bytes = Buffer.alloc(stat.size + 1); let n = 0;
    while (n < bytes.length) { const got = fs.readSync(fd, bytes, n, bytes.length - n, n); if (!got) break; n += got; }
    if (n !== stat.size) throw new Error('native config changed');
    return nativeInstanceFromBytes(bytes.subarray(0, n), digest, options);
  } finally { fs.closeSync(fd); }
}

export function bindNativeInstance(manager, instance) {
  if (!instance) return;
  const health = manager.health.bind(manager), spawn = manager.spawn.bind(manager);
  manager.health = () => ({ ...health(), vmScope: { prefix: instance.prefix, marker: instance.marker } });
  manager.spawn = body => { instance.check(body); return spawn(body); };
}
