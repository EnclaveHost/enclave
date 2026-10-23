// w1: the exact input manifests of F 4106c311's three network bundles, rebuilt with network/build.mjs's options in a throwaway
// clone (F's installed node_modules, read-only), each REQUIRED to reproduce F's recorded artifact hash; then the per-input delta
// against the INSTALLED builds' own input manifests (cfb69370: g4-challenge-retry-package candidate; 13ce44/c952: g4 composition).
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto';
const [tree, outDir] = process.argv.slice(2);
const W = '/home/steven/Documents/Codex/2026-10-18/wo/work';
const { build } = await import(path.join(tree, 'node_modules/esbuild/lib/main.js'));
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const F = Object.fromEntries(fs.readFileSync(`${W}/resume-after-checkpoint-20261022/host-services-final-compose/artifacts-final.sha256`, 'utf8').trim().split('\n').map((l) => { const [h, p] = l.split(/\s+/); return [p.replace(/^\.\//, ''), h]; }));
const BASE = { 'privacy-agent.mjs': `${W}/g4-challenge-retry-package-20261022/candidate/privacy-agent.mjs.inputs.json`,
  'windows-circuit-worker.mjs': `${W}/g4-network-composition-20261021/out/g4/windows-circuit-worker.mjs.inputs.json`,
  'host-service-ingress.mjs': `${W}/g4-network-composition-20261021/out/g4/host-service-ingress.mjs.inputs.json` };
const INSTALLED = { 'privacy-agent.mjs': 'cfb69370a00dea147340c64bbd712f118eb8cb825237ac79b3b053b586350801',
  'windows-circuit-worker.mjs': '13ce44f1b39d4521e32266f2dad234958af70b1b05e2a3f6638535571e8cf320', 'host-service-ingress.mjs': 'c952dce4fe007c48c81e1726a743d850dc2f5231204d01466349bfa5ffcc62d3' };
const ENTRY = { 'privacy-agent.mjs': 'network/entries/privacy-agent.mjs', 'windows-circuit-worker.mjs': 'network/windows-circuit-worker.mjs', 'host-service-ingress.mjs': 'network/host-service-ingress.mjs' };
const res = {};
for (const name of Object.keys(ENTRY)) {
  const out = path.join(outDir, name);
  const r = await build({ entryPoints: [path.join(tree, ENTRY[name])], outfile: out, absWorkingDir: tree, bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true, logLevel: 'error',
    banner: { js: 'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);' } });
  const got = sha(out), want = F[`dist/${name}`];
  if (got !== want) throw new Error(`${name}: rebuilt ${got} != F artifact ${want} (recipe mismatch)`);
  const inputs = Object.fromEntries(Object.keys(r.metafile.inputs).sort().map((i) => [i, sha(path.resolve(tree, i))]));
  const base = JSON.parse(fs.readFileSync(BASE[name], 'utf8'));
  const keys = [...new Set([...Object.keys(inputs), ...Object.keys(base)])].sort();
  const changed = keys.filter((k) => inputs[k] && base[k] && inputs[k] !== base[k]), added = keys.filter((k) => inputs[k] && !base[k]), removed = keys.filter((k) => !inputs[k] && base[k]);
  const pkg = (k) => { const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(k); return m ? m[1] : null; };
  const split = (arr) => ({ source: arr.filter((k) => !pkg(k)), nodeModulesPackages: [...new Set(arr.filter(pkg).map(pkg))].sort(), nodeModulesFiles: arr.filter(pkg).length });
  res[name] = { installed: INSTALLED[name], f: got, reproducedFArtifact: true, inputs: { f: Object.keys(inputs).length, installedBuild: Object.keys(base).length },
    changed: split(changed), added: split(added), removed: split(removed), fInputs: inputs };
  fs.writeFileSync(path.join(outDir, name + '.inputs.json'), JSON.stringify(inputs, null, 1) + '\n');
  console.log(JSON.stringify({ name, f: got.slice(0, 8), installed: INSTALLED[name].slice(0, 8), inputs: res[name].inputs, changed: res[name].changed, added: res[name].added, removed: res[name].removed }));
}
fs.writeFileSync(path.join(outDir, 'w1-delta.json'), JSON.stringify(res, (k, v) => (k === 'fInputs' ? undefined : v), 1) + '\n');
