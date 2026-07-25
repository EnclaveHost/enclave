#!/usr/bin/env node
// Unprivileged OCI image puller. Fetches an image (by @sha256 digest or by tag)
// from a registry and extracts its merged rootfs to a directory, whiteout-aware,
// with no docker/podman/root. Blobs are digest-verified and cached.
//
//   node oci-pull.mjs ghcr.io/enclavehost/enclave-supervisor@sha256:...  ./rootfs
//   node oci-pull.mjs ghcr.io/enclavehost/enclave-wasm-manager:11bb1370  ./rootfs
//
// Emits ./rootfs/.oci-config.json (the image config) and prints the resolved
// digest on the last stderr line so callers can pin it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';

const [ref, dest] = process.argv.slice(2);
if (!ref || !dest) { console.error('usage: oci-pull.mjs <registry/repo[@sha256:...|:tag]> <destdir>'); process.exit(2); }
const m = ref.match(/^([^/]+)\/(.+)@(sha256:[0-9a-f]{64})$/) || ref.match(/^([^/]+)\/(.+):([\w.-]+)$/);
if (!m) { console.error('bad ref'); process.exit(2); }
const [, registry, repo, reference] = m;

const cacheDir = process.env.OCI_CACHE || path.join(process.env.HOME, '.cache', 'enclave-oci');
fs.mkdirSync(cacheDir, { recursive: true });

async function token() {
  const r = await fetch(`https://${registry}/token?scope=repository:${repo}:pull`);
  if (!r.ok) throw new Error(`token: ${r.status}`);
  return (await r.json()).token;
}
const tok = await token();
const hdr = (accept) => ({ authorization: `Bearer ${tok}`, accept });
const MANIFEST_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

async function getManifest(refr) {
  const r = await fetch(`https://${registry}/v2/${repo}/manifests/${refr}`, { headers: hdr(MANIFEST_TYPES) });
  if (!r.ok) throw new Error(`manifest ${refr}: ${r.status}`);
  const digest = r.headers.get('docker-content-digest');
  return { json: await r.json(), digest };
}

async function getBlob(dgst) {
  const file = path.join(cacheDir, dgst.replace(':', '_'));
  if (fs.existsSync(file)) return file;
  const r = await fetch(`https://${registry}/v2/${repo}/blobs/${dgst}`, { headers: hdr('application/octet-stream') });
  if (!r.ok) throw new Error(`blob ${dgst}: ${r.status}`);
  const tmp = file + '.tmp';
  const h = createHash('sha256');
  await r.body.pipeTo(Writable.toWeb(fs.createWriteStream(tmp)));
  const hashed = await new Promise((res, rej) => {
    const s = fs.createReadStream(tmp);
    s.on('data', (c) => h.update(c)); s.on('end', () => res(h.digest('hex'))); s.on('error', rej);
  });
  if (`sha256:${hashed}` !== dgst) throw new Error(`digest mismatch ${dgst}: got sha256:${hashed}`);
  fs.renameSync(tmp, file);
  return file;
}

let { json: manifest, digest: resolvedDigest } = await getManifest(reference);
if (manifest.manifests) {                                   // multi-arch index → linux/amd64
  const e = manifest.manifests.find((x) => x.platform?.architecture === 'amd64' && x.platform?.os === 'linux');
  if (!e) throw new Error('no linux/amd64 in index');
  ({ json: manifest, digest: resolvedDigest } = await getManifest(e.digest));
}
console.error(`[oci-pull] ${repo}@${resolvedDigest} · ${manifest.layers.length} layers`);

const configFile = await getBlob(manifest.config.digest);
fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(configFile, path.join(dest, '.oci-config.json'));

for (const layer of manifest.layers) {
  const f = await getBlob(layer.digest);
  console.error(`[oci-pull]   layer ${layer.digest.slice(7, 19)} (${(layer.size / 1e6).toFixed(1)} MB)`);
  const listing = execFileSync('bsdtar', ['-tzf', f], { maxBuffer: 1 << 28 }).toString().split('\n').filter(Boolean);
  const excludes = [];
  for (const entry of listing) {
    const base = path.basename(entry);
    if (base === '.wh..wh..opq') {
      const dir = path.join(dest, path.dirname(entry));
      if (fs.existsSync(dir)) for (const c of fs.readdirSync(dir)) fs.rmSync(path.join(dir, c), { recursive: true, force: true });
      excludes.push(entry);
    } else if (base.startsWith('.wh.')) {
      fs.rmSync(path.join(dest, path.dirname(entry), base.slice(4)), { recursive: true, force: true });
      excludes.push(entry);
    }
  }
  const args = ['-xzf', f, '-C', dest, '--no-same-owner', '--no-same-permissions'];
  for (const e of excludes) args.push('--exclude', e);
  execFileSync('bsdtar', args, { stdio: ['ignore', 'inherit', 'inherit'] });
}
// last stderr line = the resolved digest, for pinning
console.error(resolvedDigest);
