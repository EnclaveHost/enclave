#!/usr/bin/env node
// Unprivileged OCI image puller. Fetches an image (by @sha256 digest or by tag)
// from a registry and extracts its merged rootfs to a directory, whiteout-aware,
// with no docker/podman/root. The manifest AND every blob are digest-verified
// against bytes we hash ourselves — a @sha256: reference is binding, not advisory.
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

const rawArgs = process.argv.slice(2);
// --resolve: print the pinnable ref this reference names RIGHT NOW and stop,
// without downloading a blob. Exists so callers can turn a TAG into a digest
// BEFORE building, which is what makes a build reproducible — and it resolves
// it through getManifest below, which hashes the body itself, so what you pin
// is bytes this tool verified rather than the registry's word for them.
const RESOLVE = rawArgs.includes('--resolve');
const [ref, dest] = rawArgs.filter((a) => a !== '--resolve');
if (!ref || (!dest && !RESOLVE)) { console.error('usage: oci-pull.mjs <registry/repo[@sha256:...|:tag]> <destdir>\n       oci-pull.mjs <ref> --resolve'); process.exit(2); }
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

// Fetch a manifest and VERIFY IT OURSELVES. Blobs were always digest-checked,
// but the manifest that names them was taken on the registry's word
// (docker-content-digest is a header the registry writes). That made a
// `@sha256:` reference advisory rather than binding: serve a different manifest
// body at that path and every layer digest inside it still self-verifies, so
// you get a coherent image that is not the one you pinned — and this is the
// tool that assembles the MEASURED enclave image. The multi-arch path took two
// such unverified hops, since the sub-manifest digest comes out of the index.
// The digest returned is the one we COMPUTED, so what callers pin is what was
// checked.
async function getManifest(refr) {
  const r = await fetch(`https://${registry}/v2/${repo}/manifests/${refr}`, { headers: hdr(MANIFEST_TYPES) });
  if (!r.ok) throw new Error(`manifest ${refr}: ${r.status}`);
  const body = Buffer.from(await r.arrayBuffer());
  const digest = 'sha256:' + createHash('sha256').update(body).digest('hex');
  if (/^sha256:[0-9a-f]{64}$/.test(refr) && digest !== refr)
    throw new Error(`manifest digest mismatch: asked for ${refr}, got ${digest}`);
  const claimed = r.headers.get('docker-content-digest');
  if (claimed && claimed !== digest)
    console.error(`[oci-pull] WARNING: registry claims ${claimed}, bytes hash to ${digest} — trusting the bytes`);
  let json;
  try { json = JSON.parse(body.toString('utf8')); }
  catch (e) { throw new Error(`manifest ${refr} is not JSON: ${e.message}`); }
  return { json, digest };
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
// Resolve to the digest of THIS reference (the index, for a multi-arch tag) —
// the same thing the flavor configs pin — before descending into a platform
// sub-manifest below. Last stderr line stays the machine-readable one.
if (RESOLVE) { console.error(`${registry}/${repo}@${resolvedDigest}`); process.exit(0); }
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
