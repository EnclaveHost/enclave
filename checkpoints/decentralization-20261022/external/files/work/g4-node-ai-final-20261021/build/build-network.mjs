// The minipc network runtime for the wallet hold: privacy-agent.mjs + windows-circuit-worker.mjs, JS only (no Go: the
// native enclave-wg.exe stays cbaf8313). Step 1 proves the options by rebuilding the reviewed rev4 stage bundles from the
// rev4 tree byte for byte; step 2 builds the same entries from src/ (= revision2/tree copied at the SAME directory depth,
// so esbuild's node_modules path labels are identical). Every input is listed with its sha256.
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto';
const W = '/home/steven/Documents/Codex/2026-10-18/wo/work', P = path.join(W, 'node-hold-package-20261021');
const OUT = path.join(P, 'build/out'); fs.rmSync(OUT, { recursive: true, force: true });
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const want = Object.fromEntries(fs.readFileSync(path.join(W, 'host-service-transport-20261021/stage/INVENTORY.sha256'), 'utf8').trim().split('\n').map((l) => { const [h, f] = l.split(/\s+/); return [f, h]; }));
const ENTRIES = [['privacy-agent.mjs', 'privacy-agent.mjs'], ['windows-circuit-worker.mjs', 'windows-circuit-worker.mjs']];
async function run(tree, dir) {
  const { build } = await import(path.join(tree, 'node_modules/esbuild/lib/main.js'));
  const out = path.join(OUT, dir); fs.mkdirSync(out, { recursive: true }); const res = {};
  for (const [e, f] of ENTRIES) {
    const r = await build({ entryPoints: [path.join(tree, 'network', e)], outfile: path.join(out, f), absWorkingDir: tree, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'error', metafile: true,
      banner: { js: 'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);' } });
    const inputs = Object.fromEntries(Object.keys(r.metafile.inputs).sort().map((i) => [i, sha(path.resolve(tree, i))]));
    fs.writeFileSync(path.join(out, f + '.inputs.json'), JSON.stringify(inputs, null, 1));
    res[f] = { sha256: sha(path.join(out, f)), bytes: fs.statSync(path.join(out, f)).size, inputs: Object.keys(inputs).length };
  }
  return res;
}
const prov = await run(path.join(W, 'host-service-transport-20261021/tree'), 'provenance-rev4');
let ok = true;
for (const [f, r] of Object.entries(prov)) { const same = r.sha256 === want[f]; ok &&= same; console.log(same ? 'PROVENANCE SAME' : 'PROVENANCE DIFF', f, r.sha256.slice(0, 8), 'stage', (want[f] || '').slice(0, 8)); }
if (!ok) { console.log('PROVENANCE MISMATCH: stop'); process.exit(1); }
const cand = await run(path.join(P, 'src'), 'candidate');
for (const [f, r] of Object.entries(cand)) console.log('CANDIDATE', f, r.sha256, r.bytes);
// which inputs differ between the reviewed rev4 bundle and the candidate (by path and sha)
const diff = {};
for (const [, f] of ENTRIES) {
  const a = JSON.parse(fs.readFileSync(path.join(OUT, 'provenance-rev4', f + '.inputs.json'))), b = JSON.parse(fs.readFileSync(path.join(OUT, 'candidate', f + '.inputs.json')));
  diff[f] = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((k) => a[k] !== b[k]).map((k) => ({ input: k, rev4: (a[k] || 'absent').slice(0, 8), candidate: (b[k] || 'absent').slice(0, 8) }));
  console.log('INPUTS CHANGED vs rev4', f, JSON.stringify(diff[f]));
}
fs.writeFileSync(path.join(OUT, 'build-manifest.json'), JSON.stringify({ provenance: prov, candidate: cand, inputsChangedVsRev4: diff, esbuild: JSON.parse(fs.readFileSync(path.join(P, 'src/node_modules/esbuild/package.json'))).version }, null, 1));
