// REAL-WASM reproduction of cron 1.0.3's startup (catalog CID bafybeihbh44…, source enclave-apps d4308cc = cron 0.1.3)
// under wasmtime with the version's 128 MiB cap. Every outbound connection goes to a DEAD local SOCKS port
// (ENCLAVE_EGRESS), so nothing reaches the real storage/targets; the listener binds a local port. Secrets are FAKE
// (random, never the deployment's). The deployment's public config override (bafkreigf7ewh…, CID-verified) is held in
// memory only. Each scenario prints cron's own stderr and wasmtime's exit text, to compare with the fleet reason
// ("WASM function 84 exited i32 status 1, stderr [cron]").
//   node repro.mjs <cron-1.0.3.wasm>
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
const { importFile, cidString } = await import('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/scripts/site-release/unixfs.mjs');
const WASM = process.argv[2];
const WASM_CID = 'bafybeihbh44co4nluuraqsnfylfybuw4ybjvzfs6hmtewzlr7dt36f5oty';
const CFG_CID = 'bafkreigf7ewh5mzjv6zmgzyhz7kvcrlonvhhmezprjmb3i5xd2vb4seyey';
const CFG_SHA = JSON.parse(fs.readFileSync('deploy-config-shape.json', 'utf8')).sha256;   // the CID-verified fetch (fetch.py)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const out = { at: new Date().toISOString(), wasm: {}, scenarios: {} };
const bytes = fs.readFileSync(WASM);
out.wasm = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, cid: cidString(importFile(bytes).cid) };
out.wasm.cidMatchesCatalog = out.wasm.cid === WASM_CID;
if (!out.wasm.cidMatchesCatalog) { console.log(JSON.stringify(out, null, 1)); process.exit(2); }
// the deployment's config override, fetched into memory and verified (a raw block: its CID is its sha256)
const r = await fetch(`https://ipfs.enclave.host/ipfs/${CFG_CID}?format=raw`, { signal: AbortSignal.timeout(60000) });
const cfgRaw = Buffer.from(await r.arrayBuffer());
const cfgSha = createHash('sha256').update(cfgRaw).digest('hex');
out.deployConfig = { status: r.status, bytes: cfgRaw.length, sha256: cfgSha, matchesCid: cfgSha === CFG_SHA };
if (cfgSha !== CFG_SHA) { console.log(JSON.stringify(out, null, 1)); process.exit(2); }
const dep = JSON.parse(cfgRaw.toString('utf8'));
const chain = JSON.parse(fs.readFileSync('chain.json', 'utf8'));
const ver = JSON.parse(chain.versions[3].config);            // the catalog 1.0.3 default config, verbatim from chain
const refs = (o, acc = new Set()) => { if (typeof o === 'string' && o.startsWith('$')) acc.add(o.slice(1).replace(/[{}]/g, '')); else if (o && typeof o === 'object') Object.values(o).forEach((v) => refs(v, acc)); return acc; };
const fake = (names) => Object.fromEntries([...names].map((n) => [n, randomBytes(24).toString('hex')]));
const DEP_SECRETS = [...refs(dep)], VER_SECRETS = [...refs(ver)];
out.secretNames = { deployment: DEP_SECRETS, versionDefault: VER_SECRETS };

async function run(name, { config, secrets, watchMs = 8000 }) {
  const port = await freePort(), dead = await freePort();
  const env = ['--env', `ENCLAVE_PORTS=http:8000=${port}`, '--env', `ENCLAVE_EGRESS=socks5://x:y@127.0.0.1:${dead}`];
  if (config !== undefined) env.push('--env', `ENCLAVE_CONFIG=${config}`);
  for (const [k, v] of Object.entries(secrets || {})) env.push('--env', `${k}=${v}`);
  const p = spawn('wasmtime', ['run', '-S', 'inherit-network', '-W', `max-memory-size=${128 * 1048576}`, ...env, WASM], { stdio: ['ignore', 'pipe', 'pipe'] });
  let so = '', se = '', exit = null; p.stdout.on('data', (d) => { so += d; }); p.stderr.on('data', (d) => { se += d; }); p.on('exit', (c) => { exit = c; });
  const t0 = Date.now(); while (exit === null && Date.now() - t0 < watchMs) await sleep(250);
  let http = null;
  if (exit === null) { try { http = (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) })).status; } catch (e) { http = 'error ' + e.message; } p.kill('SIGKILL'); }
  const lines = (se + '\n' + so).split('\n').filter(Boolean);
  out.scenarios[name] = { exitedWithin: exit === null ? null : `${Date.now() - t0} ms`, processExit: exit, aliveAfterMs: exit === null ? watchMs : null, httpOnListener: http,
    cronLines: lines.filter((l) => /^\[(cron|enclave-cron)\]/.test(l)).slice(0, 6),
    wasmtimeError: lines.filter((l) => /wasm function|Exited with|error while executing|Caused by|exit status/i.test(l)).slice(0, 8) };
}
const all = fake(DEP_SECRETS);
await run('S1 deployment config, every secret present (fake)', { config: cfgRaw.toString('utf8'), secrets: all, watchMs: 10000 });
for (const n of DEP_SECRETS) { const s = { ...all }; delete s[n]; await run(`S2 deployment config, ${n} absent`, { config: cfgRaw.toString('utf8'), secrets: s }); }
await run('S3 deployment config, NO secrets at all', { config: cfgRaw.toString('utf8'), secrets: {} });
await run('S4 deployment config, CRON_API_KEY shorter than 32', { config: cfgRaw.toString('utf8'), secrets: { ...all, CRON_API_KEY: 'short' } });
await run('S5 catalog 1.0.3 DEFAULT config (wasi/_media kept), its secrets present', { config: chain.versions[3].config, secrets: fake(VER_SECRETS) });
const strip = { ...ver }; delete strip.wasi; delete strip._media;
await run('S6 catalog default config without the routing keys, its secrets present', { config: JSON.stringify(strip), secrets: fake(VER_SECRETS) });
await run('S7 deployment config + an injected "wasi" key', { config: JSON.stringify({ ...dep, wasi: '0.2' }), secrets: all });
await run('S8 no ENCLAVE_CONFIG at all', { config: undefined, secrets: all });
console.log(JSON.stringify(out, null, 1));
