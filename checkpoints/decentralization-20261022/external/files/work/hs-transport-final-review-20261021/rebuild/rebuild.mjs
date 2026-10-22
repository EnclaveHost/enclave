// Reviewer: rebuild the staged JS bundles from the FROZEN writer tree (read-only) with stage-inventory.mjs's exact esbuild
// options, into this directory, and compare to stage/INVENTORY.sha256. No Go.
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto';
const H = '/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-transport-20261021', N = path.join(H, 'tree/network'), OUT = path.resolve('rebuild/out');
const { build } = await import(path.join(H, 'tree/node_modules/esbuild/lib/main.js'));
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const bundle = (entry, file) => build({ entryPoints: [path.join(N, entry)], outfile: path.join(OUT, file), absWorkingDir: path.join(H, 'tree'), bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'error',
  banner: { js: 'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);' } });
for (const [e, f] of [['privacy-agent.mjs', 'privacy-agent.mjs'], ['windows-circuit-worker.mjs', 'windows-circuit-worker.mjs'], ['host-service-ingress.mjs', 'host-service-ingress.mjs'], ['wg-provider/main.mjs', 'wg-provider.mjs']]) await bundle(e, f);
const want = Object.fromEntries(fs.readFileSync(path.join(H, 'stage/INVENTORY.sha256'), 'utf8').trim().split('\n').map((l) => { const [h, f] = l.split(/\s+/); return [f, h]; }));
for (const f of fs.readdirSync(OUT).sort()) { const h = createHash('sha256').update(fs.readFileSync(path.join(OUT, f))).digest('hex'); console.log(h === want[f] ? 'SAME' : 'DIFF', f, h.slice(0, 12), (want[f] || '').slice(0, 12)); }
