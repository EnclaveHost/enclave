// LOCAL reproduction of the live ipns-publisher state with the EXACT deployed artifact (catalog v5,
// bafybeiesjakstv3lnkgkbcrj3itenwubnk6wuwpkcrgmjbh64wfkr4j6ii, sha256 59a1cec5..., from work/adapter-retained).
// Same config SHAPE as the deployment's public on-chain config, but:
//   - a THROWAWAY ed25519 key generated here (never the production identity), passed the way the host passes it:
//     ENCLAVE_CONFIG {"ipnsKey":"$IPNS_ED25519_SK",...} + the secret in the environment;
//   - every endpoint is a local mock on 127.0.0.1 (value source, delegate, IPNI indexer/gateway); DHT bootstrap is
//     empty, so nothing reaches the public network.
// Scenarios: S1 every outbound call fails (the live symptom?), S2 everything answers (normal), S3 the delegate fails
// but the value source answers (sequence hazard). Each: start, wait, read /api/status twice, stop.
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
const WASM = '/home/steven/Documents/Codex/2026-10-18/wo/work/adapter-retained/bafybeiesjakstv3lnkgkbcrj3itenwubnk6wuwpkcrgmjbh64wfkr4j6ii.bin';
const VALUE = '/ipfs/bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou';
const KEY = randomBytes(32).toString('hex');           // throwaway test identity
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const out = { wasm: WASM, at: new Date().toISOString(), scenarios: {} };

const id = execFileSync('wasmtime', ['run', WASM, 'id', KEY], { encoding: 'utf8' });
const NAME = id.match(/ipns-name:\s+(\S+)/)[1];
out.testIdentity = { peerId: id.match(/peer-id:\s+(\S+)/)[1], name: NAME, note: 'throwaway key generated for this test' };
// the record a delegate would hold: seq 1026, same value, valid 7 days (made by the artifact's own mkrecord)
const REC1026 = execFileSync('wasmtime', ['run', WASM, 'mkrecord', KEY, VALUE, '+604800', '1026', '300000000000']);

async function mock(handler) { const port = await freePort(); const log = []; const srv = http.createServer((req, res) => { let b = []; req.on('data', (d) => b.push(d)); req.on('end', () => { log.push(`${req.method} ${req.url}`); handler(req, res, Buffer.concat(b)); }); });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r)); return { url: `http://127.0.0.1:${port}`, srv, log }; }

async function scenario(name, { valueOk, delegateOk }) {
  const closed = `http://127.0.0.1:${await freePort()}`;              // nothing listens: connection refused
  const value = valueOk ? await mock((q, r) => { r.writeHead(200, { 'content-type': 'text/plain' }); r.end(VALUE + '\n'); }) : null;
  const puts = [];
  const delegate = delegateOk ? await mock((q, r, body) => {
    if (q.method === 'GET' && q.url === `/routing/v1/ipns/${NAME}`) { r.writeHead(200, { 'content-type': 'application/vnd.ipfs.ipns-record' }); return r.end(REC1026); }
    if (q.method === 'PUT') { puts.push(body.length); r.writeHead(200); return r.end(); }
    r.writeHead(404); r.end(); }) : null;
  const ipni = await mock((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{}'); });
  const port = await freePort();
  const cfg = { ipnsKey: '$IPNS_ED25519_SK', value: (value ? value.url : closed) + '/site-root', lifetimeSecs: 604800, republishSecs: 14400, ttlSecs: 300,
    delegates: [delegate ? delegate.url : closed], ipni: { gatewayUrl: ipni.url, publisherUrl: ipni.url, indexers: [ipni.url], announceAllBlocks: false },
    dht: true, bootstrap: [], api_key: '$API_KEY' };
  const p = spawn('wasmtime', ['run', '-S', 'inherit-network', '--env', `ENCLAVE_CONFIG=${JSON.stringify(cfg)}`, '--env', `IPNS_ED25519_SK=${KEY}`,
    '--env', 'API_KEY=test-only', '--env', `ENCLAVE_PORTS=http:8000=${port}`, WASM], { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; p.stdout.on('data', (d) => logs.push(String(d))); p.stderr.on('data', (d) => logs.push(String(d)));
  const status = async () => { try { const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) }); return await r.json(); } catch (e) { return { fetchError: e.message }; } };
  let first = null; for (let i = 0; i < 40 && (!first || first.fetchError); i++) { await sleep(500); first = await status(); }
  await sleep(8000); const s1 = await status();
  await sleep(20000); const s2 = await status();                     // 28 s after start: is a failed round retried?
  p.kill('SIGKILL'); for (const m of [value, delegate, ipni]) m?.srv.close();
  const strip = (s) => { if (!s || s.fetchError) return s; const { uptimeSecs, validUntil, publishedAt, ...rest } = s; return { ...rest, validUntilSet: validUntil > 0, publishedAtSet: publishedAt > 0 }; };
  out.scenarios[name] = { valueSource: valueOk ? 'answers' : 'connection refused', delegate: delegateOk ? 'answers (holds seq 1026)' : 'connection refused',
    statusAt8s: strip(s1), statusAt28s: strip(s2), unchangedBetween: JSON.stringify(strip(s1)) === JSON.stringify(strip(s2)),
    delegatePuts: puts.length, valueRequests: value?.log.length ?? 0, ipniRequests: ipni.log.length,
    appLog: logs.join('').split('\n').filter((l) => l.includes('[ipns-publisher]')).map((l) => l.replace(KEY, '<test key>')).slice(0, 25) };
}
await scenario('S1 all outbound fails', { valueOk: false, delegateOk: false });
await scenario('S2 all outbound answers', { valueOk: true, delegateOk: true });
await scenario('S3 delegate fails, value answers', { valueOk: true, delegateOk: false });
// the live /api/status (serving/probe2.json, 2026-10-21T11:20Z) for comparison, minus the time fields
const live = JSON.parse(JSON.parse(fs.readFileSync('/home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/serving/probe2.json', 'utf8')).checks[1].sample);
const shape = (s) => s && !s.fetchError ? { sequence: s.sequence, value: s.value, recovered: s.recovered, delegates: s.delegates, mode: s.mode, dht: s.dht, ipniRoot: s.ipni?.root ?? null, ipniNote: s.ipni?.note, durableState: s.durableState, queuedTasks: s.queuedTasks } : s;
out.liveShape = shape(live);
for (const [k, v] of Object.entries(out.scenarios)) v.matchesLiveShape = JSON.stringify(shape(v.statusAt28s)) === JSON.stringify(out.liveShape);
console.log(JSON.stringify(out, null, 1));
