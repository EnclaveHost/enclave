// REAL-WASM check: does cron 1.0.3 answer HTTP while its storage is SLOW? A local SOCKS5 stub completes the egress
// handshake and then never answers (a stalled storage origin, like a slow sia-s3 PUT/GET). Fake secrets, the real public
// deployment config (CID-verified, memory only), 128 MiB cap, nothing leaves 127.0.0.1. Polls GET / every 2 s for 50 s.
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
const WASM = process.argv[2];
const CFG_CID = 'bafkreigf7ewh5mzjv6zmgzyhz7kvcrlonvhhmezprjmb3i5xd2vb4seyey';
const CFG_SHA = JSON.parse(fs.readFileSync('deploy-config-shape.json', 'utf8')).sha256;
const raw = Buffer.from(await (await fetch(`https://ipfs.enclave.host/ipfs/${CFG_CID}?format=raw`, { signal: AbortSignal.timeout(60000) })).arrayBuffer());
if (createHash('sha256').update(raw).digest('hex') !== CFG_SHA) throw Error('config CID mismatch');
const dep = JSON.parse(raw);
const names = []; const walk = (o) => { if (typeof o === 'string' && o.startsWith('$')) names.push(o.slice(1)); else if (o && typeof o === 'object') Object.values(o).forEach(walk); }; walk(dep);
const held = [];
const socks = net.createServer((s) => { held.push(s); let stage = 0; s.on('data', (b) => {
  if (stage === 0) { s.write(Buffer.from([5, 2])); stage = 1; }                 // choose user/pass
  else if (stage === 1) { s.write(Buffer.from([1, 0])); stage = 2; }            // auth ok
  else if (stage === 2) { s.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])); stage = 3; }   // CONNECT ok ... then silence
}); s.on('error', () => {}); });
await new Promise((r) => socks.listen(0, '127.0.0.1', r));
const free = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const port = await free();
const env = ['--env', `ENCLAVE_PORTS=http:8000=${port}`, '--env', `ENCLAVE_EGRESS=socks5://x:y@127.0.0.1:${socks.address().port}`, '--env', `ENCLAVE_CONFIG=${raw}`];
for (const n of names) env.push('--env', `${n}=${randomBytes(24).toString('hex')}`);
const p = spawn('wasmtime', ['run', '-S', 'inherit-network', '-W', `max-memory-size=${128 * 1048576}`, ...env, WASM], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
const t0 = Date.now(), polls = [];
while (Date.now() - t0 < 50000) {
  const s = Date.now(); let r;
  try { r = (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(8000) })).status; } catch (e) { r = e.name === 'TimeoutError' ? 'no answer in 8 s' : 'refused'; }
  polls.push({ at_s: Math.round((s - t0) / 1000), answer: r, ms: Date.now() - s });
  await new Promise((x) => setTimeout(x, 2000));
}
p.kill('SIGKILL'); socks.close(); held.forEach((s) => s.destroy());
console.log(JSON.stringify({ storageConnectionsHeld: held.length, polls, cronLines: log.split('\n').filter((l) => l.startsWith('[')).slice(0, 6) }, null, 1));
