// REAL-WASM startup tests: the FIXED publisher wasm vs the DEPLOYED one (catalog v5, 59a1cec5; the mutation control),
// both under wasmtime with a 128 MiB cap, a THROWAWAY key, every endpoint a local mock on 127.0.0.1, DHT bootstrap empty.
//   node test-startup.mjs <fixed.wasm>
// Scenarios (the live name's facts: seq 1026, value /ipfs/bafybeieuxt6...):
//   late-egress   delegate + value refuse at start (egress not admitted yet), come up after 5 s
//   S3            the delegate refuses all along, the value answers          -> must NEVER sign sequence 0
//   503           the delegate answers 503 (transient), the value answers    -> must not sign sequence 0
//   fresh-404     the delegate answers 404 (a fresh name), the value answers -> sequence 0 is right
//   S2            the delegate holds seq 1026 with the same value           -> seq 1026, unchanged (EOL extended)
//   new-value     the delegate holds seq 1026 with ANOTHER value            -> seq 1027
//   put-fails     GET answers 1026 but every PUT fails                       -> signed 1026, then retried, not 4 h later
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
const FIXED = process.argv[2];
const DEPLOYED = '/home/steven/Documents/Codex/2026-10-18/wo/work/adapter-retained/bafybeiesjakstv3lnkgkbcrj3itenwubnk6wuwpkcrgmjbh64wfkr4j6ii.bin';
const VALUE = '/ipfs/bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou', OTHER = '/ipfs/bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y';
const KEY = randomBytes(32).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const NAME = execFileSync('wasmtime', ['run', FIXED, 'id', KEY], { encoding: 'utf8' }).match(/ipns-name:\s+(\S+)/)[1];
const rec = (v) => execFileSync('wasmtime', ['run', FIXED, 'mkrecord', KEY, v, '+604800', '1026', '300000000000']);
const REC_SAME = rec(VALUE), REC_OTHER = rec(OTHER);

function server(port, handler) { const log = []; const srv = http.createServer((q, r) => { const b = []; q.on('data', (d) => b.push(d)); q.on('end', () => { log.push(`${q.method}`); handler(q, r); }); });
  return new Promise((ok) => srv.listen(port, '127.0.0.1', () => ok({ srv, log }))); }

async function scenario(wasm, name, { delegate, value = 'ok', lateMs = 0, watchMs }) {
  const [dp, vp, ip, port] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const delegateHandler = (q, r) => {
    if (q.method === 'GET') {
      if (delegate === '404') { r.writeHead(404); return r.end(); }
      if (delegate === '503') { r.writeHead(503); return r.end(); }
      r.writeHead(200, { 'content-type': 'application/vnd.ipfs.ipns-record' }); return r.end(delegate === 'other' ? REC_OTHER : REC_SAME);
    }
    if (delegate === 'put-fails') { r.writeHead(500); return r.end('down'); }
    r.writeHead(200); r.end();
  };
  const servers = [];
  const startEndpoints = async () => {
    if (delegate !== 'refused') servers.push(['delegate', await server(dp, delegateHandler)]);
    if (value === 'ok') servers.push(['value', await server(vp, (q, r) => { r.writeHead(200); r.end(VALUE + '\n'); })]);
  };
  servers.push(['ipni', await server(ip, (q, r) => { r.writeHead(204); r.end(); })]);
  if (!lateMs) await startEndpoints();
  const cfg = { ipnsKey: '$IPNS_ED25519_SK', value: `http://127.0.0.1:${vp}/site-root`, lifetimeSecs: 604800, republishSecs: 14400, ttlSecs: 300,
    delegates: [`http://127.0.0.1:${dp}`], ipni: { gatewayUrl: `http://127.0.0.1:${ip}`, publisherUrl: `http://127.0.0.1:${ip}`, indexers: [`http://127.0.0.1:${ip}`], announceAllBlocks: false },
    dht: true, bootstrap: [], api_key: '$API_KEY' };
  const p = spawn('wasmtime', ['run', '-S', 'inherit-network', '-W', `max-memory-size=${128 * 1048576}`, '--env', `ENCLAVE_CONFIG=${JSON.stringify(cfg)}`,
    '--env', `IPNS_ED25519_SK=${KEY}`, '--env', 'API_KEY=test-only', '--env', `ENCLAVE_PORTS=http:8000=${port}`, wasm], { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; p.stdout.on('data', (d) => logs.push(String(d))); p.stderr.on('data', (d) => logs.push(String(d)));
  const status = async () => { try { return await (await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) })).json(); } catch (e) { return { fetchError: e.message }; } };
  const t0 = Date.now(); const seqs = new Set(); let statusAnswered = 0, statusPolls = 0, endpointsUp = !lateMs, signedAt = null;
  while (Date.now() - t0 < watchMs) {
    if (!endpointsUp && Date.now() - t0 >= lateMs) { await startEndpoints(); endpointsUp = true; }
    await sleep(1000); const s = await status(); statusPolls++;
    if (!s.fetchError) { statusAnswered++; if (s.value) { seqs.add(s.sequence); if (signedAt === null) signedAt = Date.now() - t0; } }
  }
  const last = await status();
  p.kill('SIGKILL'); for (const [, s] of servers) s.srv.close();
  const log = logs.join('').split('\n').filter((l) => /ipns-publisher\]/.test(l) && !/IPNI provider ON|resolved \$|listening|publishing as|value: /.test(l));
  return { scenario: name, signedSequences: [...seqs], firstSignedAtMs: signedAt, statusAnsweredOf: `${statusAnswered}/${statusPolls}`,
    lastError: last.lastError ?? null, delegateGets: servers.find(([n]) => n === 'delegate')?.[1].log.filter((m) => m === 'GET').length ?? 0,
    log: log.slice(0, 14).map((l) => l.replace(KEY, '<k>').slice(0, 160)) };
}
const SC = {
  'late-egress': { delegate: 'same', lateMs: 5000, watchMs: 45000 },
  'S3': { delegate: 'refused', watchMs: 40000 },
  '503': { delegate: '503', watchMs: 12000 },
  'fresh-404': { delegate: '404', watchMs: 8000 },
  'S2': { delegate: 'same', watchMs: 8000 },
  'new-value': { delegate: 'other', watchMs: 8000 },
  'put-fails': { delegate: 'put-fails', watchMs: 40000 },
};
const out = { fixed: { path: FIXED, sha256: createHash('sha256').update(fs.readFileSync(FIXED)).digest('hex') }, deployed: { path: DEPLOYED, sha256: '59a1cec5130382260347f285f41475176c5923e0736565ffc2835b4a094ef637' }, memCapMiB: 128, results: {} };
for (const [n, c] of Object.entries(SC)) out.results[n] = { fixed: await scenario(FIXED, n, c), deployed: await scenario(DEPLOYED, n, c) };
const R = out.results, has = (r, s) => r.signedSequences.includes(s);
const checks = {
  'late-egress: FIXED signs seq 1026 within 45 s (retry, not 4 h)': has(R['late-egress'].fixed, 1026) && R['late-egress'].fixed.firstSignedAtMs < 45000,
  'late-egress: control (deployed) has signed nothing after 45 s': R['late-egress'].deployed.signedSequences.length === 0,
  'S3: FIXED never signs sequence 0 (nothing signed, lastError sequence unknown)': R.S3.fixed.signedSequences.length === 0 && /sequence unknown/.test(R.S3.fixed.lastError || ''),
  'S3: FIXED retries the lookup (>= 2 rounds in 40 s)': R.S3.fixed.log.filter((l) => /publish deferred/.test(l)).length >= 2,
  'S3: control (deployed) signs sequence 0': has(R.S3.deployed, 0),
  '503: FIXED does not sign sequence 0': !has(R['503'].fixed, 0),
  '503: control (deployed) signs sequence 0': has(R['503'].deployed, 0),
  'fresh-404: both sign sequence 0 (a verified fresh name)': has(R['fresh-404'].fixed, 0) && has(R['fresh-404'].deployed, 0),
  'S2: both keep seq 1026 (no change for the same value)': JSON.stringify(R.S2.fixed.signedSequences) === '[1026]' && JSON.stringify(R.S2.deployed.signedSequences) === '[1026]',
  'new-value: both sign seq 1027': has(R['new-value'].fixed, 1027) && has(R['new-value'].deployed, 1027),
  'put-fails: FIXED signs 1026 and retries the round within 40 s (>= 2 lookups), seq unchanged': JSON.stringify(R['put-fails'].fixed.signedSequences) === '[1026]' && R['put-fails'].fixed.delegateGets >= 2,
  'put-fails: control (deployed) does a single round': R['put-fails'].deployed.delegateGets === 1,
  'responsive: /api/status answered on every poll, both builds, every scenario': Object.values(R).every((x) => [x.fixed, x.deployed].every((y) => { const [a, b] = y.statusAnsweredOf.split('/'); return a === b; })),
};
out.checks = checks; out.pass = Object.values(checks).filter(Boolean).length; out.of = Object.keys(checks).length;
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass === out.of ? 0 : 1);
