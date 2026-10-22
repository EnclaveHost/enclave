// G4 network composition build (work/g4-network-composition-20261021): 605's build recipe (node-hold-package-20261021/
// build/build-network.mjs: same esbuild options, same directory depth) for the entries G4 needs.
//   1. CONTROL: base-src (= 605's frozen src, byte copy) must rebuild 605's candidate bundles exactly
//      (privacy-agent 5c03987d, windows-circuit-worker 13ce44f1); host-service-ingress is recorded as the base.
//   2. G4: src (= base-src + challenge-host-tls privacy-network.patch a3f4dec8) -> the composed bundles.
// Every input is listed with its sha256; the input delta vs the control is printed. No artifact goes anywhere else.
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto';
const P = '/home/steven/Documents/Codex/2026-10-18/wo/work/g4-network-composition-20261021', OUT = path.join(P, 'out');
fs.rmSync(OUT, { recursive: true, force: true });
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const ENTRIES = ['privacy-agent.mjs', 'windows-circuit-worker.mjs', 'host-service-ingress.mjs'];
const WANT = { 'privacy-agent.mjs': '5c03987df990c9819947d10a3d4468cf227a91f36da11fdad6a8c8a91f3c9fe2', 'windows-circuit-worker.mjs': '13ce44f1b39d4521e32266f2dad234958af70b1b05e2a3f6638535571e8cf320' };
async function run(tree, dir) {
  const { build } = await import(path.join(tree, 'node_modules/esbuild/lib/main.js'));
  const out = path.join(OUT, dir); fs.mkdirSync(out, { recursive: true }); const res = {};
  for (const f of ENTRIES) {
    const r = await build({ entryPoints: [path.join(tree, 'network', f)], outfile: path.join(out, f), absWorkingDir: tree, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'error', metafile: true,
      banner: { js: 'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);' } });
    const inputs = Object.fromEntries(Object.keys(r.metafile.inputs).sort().map((i) => [i, sha(path.resolve(tree, i))]));
    fs.writeFileSync(path.join(out, f + '.inputs.json'), JSON.stringify(inputs, null, 1));
    res[f] = { sha256: sha(path.join(out, f)), bytes: fs.statSync(path.join(out, f)).size, inputs: Object.keys(inputs).length };
  }
  return res;
}
const control = await run(path.join(P, 'base-src'), 'control');
let ok = true;
for (const [f, w] of Object.entries(WANT)) { const same = control[f].sha256 === w; ok &&= same; console.log(same ? 'CONTROL SAME as 605' : 'CONTROL DIFF', f, control[f].sha256.slice(0, 8), '605', w.slice(0, 8)); }
console.log('CONTROL host-service-ingress.mjs (base, not shipped by 605)', control['host-service-ingress.mjs'].sha256);
if (!ok) { console.log('CONTROL MISMATCH: stop'); process.exit(1); }
const g4 = await run(path.join(P, 'src'), 'g4');
const diff = {};
for (const f of ENTRIES) {
  const a = JSON.parse(fs.readFileSync(path.join(OUT, 'control', f + '.inputs.json'))), b = JSON.parse(fs.readFileSync(path.join(OUT, 'g4', f + '.inputs.json')));
  diff[f] = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((k) => a[k] !== b[k]).map((k) => ({ input: k, control: (a[k] || 'absent').slice(0, 8), g4: (b[k] || 'absent').slice(0, 8) }));
  console.log('G4', f, g4[f].sha256, g4[f].bytes, 'inputs changed:', JSON.stringify(diff[f]));
}
fs.writeFileSync(path.join(OUT, 'build-manifest.json'), JSON.stringify({ control, g4, inputsChangedVsControl: diff, esbuild: JSON.parse(fs.readFileSync(path.join(P, 'src/node_modules/esbuild/package.json'))).version }, null, 1) + '\n');
