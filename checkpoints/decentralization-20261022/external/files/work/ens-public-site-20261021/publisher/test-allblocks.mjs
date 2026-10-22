// LOCAL test of the EXACT deployed publisher wasm (catalog v5, 59a1cec5) with ipni.announceAllBlocks=true under the
// version's memory cap (128 MiB = wasmtime max-memory-size), against a local mock adapter serving the VERIFIED site
// CAR (../content/site.car, root bafybeieuxt6...otzaou, 487 blocks) for ?format=car&dag-scope=all. Throwaway key;
// every endpoint on 127.0.0.1; DHT bootstrap empty. Question: does the all-blocks advertisement build (487 blocks)
// within the cap, and with the same sequence recovery as before (seq 1026 kept)?
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const WASM = '/home/steven/Documents/Codex/2026-10-18/wo/work/adapter-retained/bafybeiesjakstv3lnkgkbcrj3itenwubnk6wuwpkcrgmjbh64wfkr4j6ii.bin';
const CAR = fs.readFileSync('/home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/content/site.car');
const ROOT = 'bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou', VALUE = '/ipfs/' + ROOT;
const KEY = randomBytes(32).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const NAME = execFileSync('wasmtime', ['run', WASM, 'id', KEY], { encoding: 'utf8' }).match(/ipns-name:\s+(\S+)/)[1];
const REC = execFileSync('wasmtime', ['run', WASM, 'mkrecord', KEY, VALUE, '+604800', '1026', '300000000000']);
async function mock(h) { const port = await freePort(); const log = []; const srv = http.createServer((q, r) => { let b = []; q.on('data', (d) => b.push(d)); q.on('end', () => { log.push(`${q.method} ${q.url}`); h(q, r, Buffer.concat(b)); }); });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r)); return { url: `http://127.0.0.1:${port}`, srv, log }; }

async function run(label, allBlocks, memBytes) {
  const value = await mock((q, r) => { r.writeHead(200); r.end(VALUE + '\n'); });
  const delegate = await mock((q, r) => { if (q.method === 'GET' && q.url.endsWith(NAME)) { r.writeHead(200, { 'content-type': 'application/vnd.ipfs.ipns-record' }); return r.end(REC); } r.writeHead(200); r.end(); });
  const adapter = await mock((q, r) => { if (q.url === `/ipfs/${ROOT}?format=car&dag-scope=all`) { r.writeHead(200, { 'content-type': 'application/vnd.ipld.car', 'content-length': CAR.length }); return r.end(CAR); } r.writeHead(404); r.end(); });
  const indexer = await mock((q, r) => { r.writeHead(204); r.end(); });
  const port = await freePort();
  const cfg = { ipnsKey: '$IPNS_ED25519_SK', value: value.url + '/site-root', lifetimeSecs: 604800, republishSecs: 14400, ttlSecs: 300, delegates: [delegate.url],
    ipni: { gatewayUrl: adapter.url, publisherUrl: indexer.url, indexers: [indexer.url], announceAllBlocks: allBlocks }, dht: true, bootstrap: [], api_key: '$API_KEY' };
  const p = spawn('wasmtime', ['run', '-S', 'inherit-network', '-W', `max-memory-size=${memBytes}`, '--env', `ENCLAVE_CONFIG=${JSON.stringify(cfg)}`,
    '--env', `IPNS_ED25519_SK=${KEY}`, '--env', 'API_KEY=test-only', '--env', `ENCLAVE_PORTS=http:8000=${port}`, WASM], { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; p.stdout.on('data', (d) => logs.push(String(d))); p.stderr.on('data', (d) => logs.push(String(d)));
  let exit = null; p.on('exit', (c, s) => { exit = c ?? s; });
  const status = async () => { try { return await (await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) })).json(); } catch (e) { return { fetchError: e.message }; } };
  let s = null; for (let i = 0; i < 60; i++) { await sleep(500); s = await status(); if (s?.ipni?.blocks > 0 || exit !== null) break; }
  await sleep(3000); s = await status();
  p.kill('SIGKILL'); for (const m of [value, delegate, adapter, indexer]) m.srv.close();
  return { label, announceAllBlocks: allBlocks, memMiB: memBytes / 1048576, processExited: exit,
    status: s && !s.fetchError ? { sequence: s.sequence, value: s.value, recovered: s.recovered, ipni: s.ipni } : s,
    adapterRequests: adapter.log, indexerRequests: indexer.log.length,
    appLog: logs.join('').split('\n').filter((l) => /IPNI|signed|sequence|enumerate|memory|panic|error/i.test(l)).map((l) => l.replace(KEY, '<k>')).slice(0, 15) };
}
const out = { wasm: WASM, car: { bytes: CAR.length }, runs: [] };
out.runs.push(await run('root-only (live config)', false, 128 * 1048576));
out.runs.push(await run('all blocks, 128 MiB cap', true, 128 * 1048576));
console.log(JSON.stringify(out, null, 1));
