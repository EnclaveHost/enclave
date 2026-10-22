#!/usr/bin/env node
// Deterministic build of the route replica release (dns.mjs + network-runtime.bundle.mjs) from the candidate tree, with
// the target of the deployed bundles (network/build.mjs `bundle`), minified like the deployed dns.mjs. Run AFTER
// relay/build-network.mjs (which embeds network/app-zone-challenge.mjs into relay/network-runtime.bundle.mjs).
//   node deploy/build-dns.mjs <outdir>   -> <outdir>/dns.mjs + network-runtime.bundle.mjs (beside it) + dns.mjs.manifest.json
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), tree = path.resolve(here, '../tree');
const {build} = await import(pathToFileURL(createRequire(path.join(tree, 'relay', 'package.json')).resolve('esbuild')).href);
const out = path.resolve(process.argv[2] || path.join(here, 'dist'));
fs.mkdirSync(out, {recursive: true});
// relay/dns-relay.js imports ./network-runtime.bundle.mjs, the runtime bundle relay/build-network.mjs builds from the
// reviewed sources. It stays a SEPARATE file beside dns.mjs (as relay/deploy.sh ships it): inlining its sources would put
// modules with command-line main guards (windows/node/host-identity.mjs) in the entry file, where they would run.
const runtimeExternal = {name: 'network-runtime-external', setup(b) {
  b.onResolve({filter: /^\.\/network-runtime\.bundle\.mjs$/}, () => ({path: './network-runtime.bundle.mjs', external: true}));
}};
const r = await build({entryPoints: [path.join(tree, 'relay', 'dns-relay.js')], outfile: path.join(out, 'dns.mjs'), bundle: true, platform: 'node', format: 'esm',
  target: 'node22', minify: true, metafile: true, plugins: [runtimeExternal],
  banner: {js: 'import {createRequire as dnsBundleRequire} from "node:module"; const require=dnsBundleRequire(import.meta.url);'}});
fs.copyFileSync(path.join(tree, 'relay', 'network-runtime.bundle.mjs'), path.join(out, 'network-runtime.bundle.mjs'));
const bytes = fs.readFileSync(path.join(out, 'dns.mjs')), sha = createHash('sha256').update(bytes).digest('hex');
const runtime = createHash('sha256').update(fs.readFileSync(path.join(out, 'network-runtime.bundle.mjs'))).digest('hex');
const inputs = Object.keys(r.metafile.inputs).sort().map((f) => ({path: f, sha256: createHash('sha256').update(fs.readFileSync(path.resolve(process.cwd(), f))).digest('hex')}));
fs.writeFileSync(path.join(out, 'dns.mjs.manifest.json'), JSON.stringify({sha256: sha, bytes: bytes.length, runtimeBundleSha256: runtime, inputs}, null, 2) + '\n');
console.log(JSON.stringify({dns: path.join(out, 'dns.mjs'), sha256: sha, bytes: bytes.length, runtimeBundleSha256: runtime, inputs: inputs.length}));
