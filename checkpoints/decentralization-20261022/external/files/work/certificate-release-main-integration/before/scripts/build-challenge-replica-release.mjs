#!/usr/bin/env node
// The Enclave host challenge service release (network/challenge-replica-host.mjs): relay/dns-relay.js bundled into one
// dns.mjs (esbuild, the deployed bundles' settings), the reviewed relay/network-runtime.bundle.mjs beside it (built by
// relay/build-network.mjs from source; never inlined, see below), and a manifest of both hashes and every bundled input.
// The same repository inputs give the same bytes; paths in the manifest are repository-relative.
//   node scripts/build-challenge-replica-release.mjs OUTDIR [--expect-sha256 <reviewed dns.mjs sha256>]
// With --expect-sha256 nothing is written unless dns.mjs is the reviewed one. A host pins release.dnsSha256 and
// release.runtimeBundleSha256 from the manifest; challenge-replica-host.mjs refuses any other bytes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.find((a) => !a.startsWith('--'));
const ei = args.indexOf('--expect-sha256'), expect = ei >= 0 ? String(args[ei + 1] || '') : null;
if (!outArg || (expect !== null && !/^[0-9a-f]{64}$/.test(expect))) {
  console.error('usage: build-challenge-replica-release.mjs OUTDIR [--expect-sha256 <64 hex>]'); process.exit(2);
}
const esbuild = await import(pathToFileURL(createRequire(path.join(tree, 'relay', 'package.json')).resolve('esbuild')).href);
const sha = (b) => createHash('sha256').update(b).digest('hex');
// relay/dns-relay.js imports ./network-runtime.bundle.mjs; it stays a SEPARATE file beside dns.mjs (as relay/deploy.sh
// ships it): inlining its sources would put modules with command-line main guards (windows/node/host-identity.mjs) in
// the entry file, where they would run.
const runtimeExternal = {name: 'network-runtime-external', setup(b) {
  b.onResolve({filter: /^\.\/network-runtime\.bundle\.mjs$/}, () => ({path: './network-runtime.bundle.mjs', external: true}));
}};
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'challenge-replica-release-'));
try {
  const r = await esbuild.build({absWorkingDir: tree, entryPoints: ['relay/dns-relay.js'], outfile: path.join(stage, 'dns.mjs'), bundle: true, platform: 'node',
    format: 'esm', target: 'node22', minify: true, metafile: true, plugins: [runtimeExternal], logLevel: 'error',
    banner: {js: 'import {createRequire as dnsBundleRequire} from "node:module"; const require=dnsBundleRequire(import.meta.url);'}});
  await esbuild.stop?.();
  const dns = fs.readFileSync(path.join(stage, 'dns.mjs'));
  const runtime = fs.readFileSync(path.join(tree, 'relay', 'network-runtime.bundle.mjs'));
  const inputs = Object.keys(r.metafile.inputs).sort().map((f) => ({path: f, sha256: sha(fs.readFileSync(path.join(tree, f)))}));
  const manifest = {schema: 'enclave-challenge-replica-release/1', sha256: sha(dns), bytes: dns.length, runtimeBundleSha256: sha(runtime), runtimeBundleBytes: runtime.length,
    entry: 'relay/dns-relay.js', inputs};
  if (expect !== null && manifest.sha256 !== expect) { console.error(`refused: dns.mjs is ${manifest.sha256}, not the reviewed ${expect}; nothing written`); process.exitCode = 1; }
  else {
    const out = path.resolve(outArg);
    fs.mkdirSync(out, {recursive: true});
    fs.writeFileSync(path.join(out, 'dns.mjs'), dns, {mode: 0o444});
    fs.writeFileSync(path.join(out, 'network-runtime.bundle.mjs'), runtime, {mode: 0o444});
    fs.writeFileSync(path.join(out, 'dns.mjs.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {mode: 0o444});
    console.log(JSON.stringify({out, dnsSha256: manifest.sha256, bytes: manifest.bytes, runtimeBundleSha256: manifest.runtimeBundleSha256, inputs: inputs.length}));
  }
} finally { fs.rmSync(stage, {recursive: true, force: true}); }
