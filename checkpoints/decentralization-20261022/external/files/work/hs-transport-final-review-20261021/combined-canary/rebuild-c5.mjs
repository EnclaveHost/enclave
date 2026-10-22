// Rebuild the 4 staged JS bundles from compose5 (read-only) with the rev4 stage-inventory esbuild options; compare to
// stage/INVENTORY.sha256 (0839e2cd). Output in combined-canary/rebuild-c5/out only.
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto';
const W = '/home/steven/Documents/Codex/2026-10-18/wo/work', T = path.join(W, 'host-service-tls-20261021/compose5'), N = path.join(T, 'network');
const OUT = path.join(W, 'hs-transport-final-review-20261021/combined-canary/rebuild-c5/out');
const { build } = await import(path.join(T, 'node_modules/esbuild/lib/main.js'));
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const bundle = (entry, file) => build({ entryPoints: [path.join(N, entry)], outfile: path.join(OUT, file), absWorkingDir: T, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'error', metafile: true,
  banner: { js: 'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);' } });
const want = Object.fromEntries(fs.readFileSync(path.join(W, 'host-service-transport-20261021/stage/INVENTORY.sha256'), 'utf8').trim().split('\n').map((l) => { const [h, f] = l.split(/\s+/); return [f, h]; }));
for (const [e, f] of [['privacy-agent.mjs', 'privacy-agent.mjs'], ['windows-circuit-worker.mjs', 'windows-circuit-worker.mjs'], ['host-service-ingress.mjs', 'host-service-ingress.mjs'], ['wg-provider/main.mjs', 'wg-provider.mjs']]) {
  const r = await bundle(e, f); fs.writeFileSync(path.join(OUT, f + '.inputs.json'), JSON.stringify(Object.keys(r.metafile.inputs).sort(), null, 1));
  const h = createHash('sha256').update(fs.readFileSync(path.join(OUT, f))).digest('hex'); console.log(h === want[f] ? 'SAME' : 'DIFF', f, h, (want[f] || ''));
}
