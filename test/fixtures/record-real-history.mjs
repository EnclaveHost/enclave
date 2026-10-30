// BOUNDED, READ-ONLY public RPC recording of REAL state proofs at a REAL historical Base block whose canonical header is
// among the 52 authenticated gossip headers (default 52965080), for an offline replay of the shipped composition:
//   node test/fixtures/record-real-history.mjs <out dir>
//   env WITNESS_CHECK_BIN, HELIOS_BASE_BIN, BASE_HEADS_DIR, TEST_TMP
// Budget (root authorization): at most 2 public sources, 30 requests, 20 MiB and 120 s in total; no credentials. Only
// eth_getProof / eth_getCode / eth_call, only pinned to the target block hash, only public platform AddressBook reads
// (plus the system accounts Helios's execution touches). Everything else is refused locally and never forwarded.
// Every answer is UNTRUSTED: the gateway caches only what the witness-check helper verified against the root it
// recovered by authenticated ancestry; the provider's own eth_call result is recorded as a cross-check, not authority.
// Choreography = the composition under test: the REAL signed head 52965080 (real Base signer) is adopted by the real
// patched Helios, the head source then moves to the REAL signed head 52965106, and a cold gateway that never saw 80
// recovers 80's root by ancestry (headers answered locally from the authenticated fixture, never by the public sources).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWitnessGateway, dirWitnessCache, WITNESS_METHODS } from '../../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore, readBounded } from '../../network/witness-verify.mjs';
import { BASE_MAINNET } from '../../network/op-head-relay.mjs';

const [outDir] = process.argv.slice(2);
const { WITNESS_CHECK_BIN, HELIOS_BASE_BIN, BASE_HEADS_DIR } = process.env;
const TARGET = 52965080, HEAD = 52965106;
const SOURCES = ['https://base.gateway.tenderly.co', 'https://mainnet.base.org'];
const BUDGET = { requests: 30, bytes: 20 << 20, ms: 120000 };
const BOOK = '0xab214342d5a490150a4a977063a2f88e21f80907';
const ADDR = '0x3b3b57de';                                   // EnclaveAddressBook.addr(bytes32)
const word = (s) => Buffer.from(s).toString('hex').padEnd(64, '0');
const CALLS = [{ name: 'EnclaveAddressBook.addr("registry")', tx: { to: BOOK, data: ADDR + word('registry') } },
  { name: 'EnclaveAddressBook.addr("deployments")', tx: { to: BOOK, data: ADDR + word('deployments') } }];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIX = JSON.parse(fs.readFileSync(new URL('./base-headers-52965055-52965106.json', import.meta.url)));
const H = Object.fromEntries(FIX.headers.map((h) => [h.number, h]));
const HASH = H[TARGET].hash;

// ---- the budget: one counter for every byte that crosses to a public source, CUMULATIVE over attempts. A second
// (last) attempt continues from the first attempt's recorded usage, counting its whole run time.
const prior = fs.existsSync(path.join(outDir, 'attempt-1.json')) ? JSON.parse(fs.readFileSync(path.join(outDir, 'attempt-1.json'), 'utf8')) : null;
if (prior && fs.existsSync(path.join(outDir, 'recording.json'))) throw new Error('both attempts done: no further recording');
const carried = prior ? prior.used : { requests: 0, bytes: 0, ms: 0 };
let t0 = null;                                               // the clock starts at the first public request
const log = [];
let used = { requests: carried.requests, bytes: carried.bytes };
const elapsed = () => carried.ms + (t0 === null ? 0 : Date.now() - t0);
const pinned = (params) => { const at = params?.[params.length - 1]; return (typeof at === 'string' ? at : at?.blockHash)?.toLowerCase() === HASH; };
async function publicCall(source, method, params) {
  const entry = { seq: log.length + 1, source: new URL(source).host, method, params, at: new Date().toISOString() };
  log.push(entry);
  if (!['eth_getProof', 'eth_getCode', 'eth_call'].includes(method) || !pinned(params)) { entry.outcome = 'refused-locally'; throw new Error('refused by the recording policy'); }
  t0 ??= Date.now();
  if (used.requests >= BUDGET.requests || used.bytes >= BUDGET.bytes || elapsed() >= BUDGET.ms) { entry.outcome = 'budget-exhausted'; throw new Error('recording budget exhausted'); }
  used.requests++;
  const started = Date.now();
  try {
    const res = await fetch(source, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', credentials: 'omit',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(Math.max(1, Math.min(30000, BUDGET.ms - elapsed()))) });
    const text = await readBounded(res, Math.min(4 << 20, BUDGET.bytes - used.bytes));
    used.bytes += Buffer.byteLength(text);
    Object.assign(entry, { status: res.status, bytes: Buffer.byteLength(text), bodySha256: sha(text), ms: Date.now() - started });
    const j = JSON.parse(text);
    entry.outcome = j.error ? `rpc-error ${j.error.code}: ${String(j.error.message).slice(0, 120)}` : 'answered';
    return j;
  } catch (e) { entry.outcome ??= `failed: ${String(e.message).slice(0, 120)}`; throw e; }
}
function serve(handler) {
  const s = http.createServer((q, res) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', async () => {
    try { res.end(JSON.stringify(await handler(b ? JSON.parse(b) : null, q))); } catch (e) { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: String(e.message) } })); }
  }); });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ s, url: `http://127.0.0.1:${s.address().port}/` })));
}
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function rpc(url, method, params) {
  const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) })).json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const checker = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: BASE_MAINNET.unsafeSigner });
const closers = [() => checker.close()];
const out = { format: 'enclave-base-real-history-recording/v1', target: { number: TARGET, hash: HASH, stateRoot: H[TARGET].stateRoot }, head: { number: HEAD, hash: H[HEAD].hash },
  sources: SOURCES, budget: BUDGET, policy: 'read-only; eth_getProof/eth_getCode/eth_call pinned to the target block hash; AddressBook calls only; no credentials' };
try {
  // the real signed heads, verified by the helper (real signer) and checked canonical against the fixture
  const heads = {};
  for (const f of fs.readdirSync(path.join(BASE_HEADS_DIR, 'objects'))) {
    const r = await checker.check({ op: 'exportHeader', object: '0x' + fs.readFileSync(path.join(BASE_HEADS_DIR, 'objects', f)).toString('hex') });
    if (r.ok && (r.head.number === TARGET || r.head.number === HEAD)) heads[r.head.number] = { ...r, object: f };
  }
  for (const n of [TARGET, HEAD]) if (heads[n]?.header.hash !== H[n].hash) throw new Error(`head ${n} does not match the fixture`);
  out.realHeads = Object.fromEntries([TARGET, HEAD].map((n) => [n, { objectSha256: heads[n].object.slice(0, 64), blockHash: heads[n].head.blockHash, stateRoot: heads[n].head.stateRoot, canonicalHashEqualsSigned: true }]));

  // preflight: does each source still serve a proof at the target block? (verified locally against the signed root)
  const root = { blockHash: HASH, stateRoot: H[TARGET].stateRoot };
  out.preflight = [];
  const good = [];
  for (const s of SOURCES) {
    const params = [BOOK, [], HASH];
    let verdict;
    try {
      const j = await publicCall(s, 'eth_getProof', params);
      verdict = j.error ? 'unavailable' : (await checker.check({ op: 'getProof', ...root, params, result: j.result })).ok ? 'verified' : 'invalid';
    } catch (e) { verdict = `failed: ${e.message}`; }
    out.preflight.push({ source: new URL(s).host, verdict });
    if (verdict === 'verified') good.push(s);
  }
  if (!good.length) throw Object.assign(new Error('no source served a verifiable proof at the target block'), { unavailable: true });

  // the composition: real Helios + cold gateway (local authenticated headers first, then the budgeted public sources)
  let current = heads[TARGET].commitment;
  const consensus = await serve((_, q) => (q.url === '/chain_id' ? 8453 : current)); closers.push(() => consensus.s.close());
  const headers = await serve((j) => ({ jsonrpc: '2.0', id: j.id, ...(j.method === 'eth_getBlockByHash' && FIX.headers.find((h) => h.hash === j.params[0])
    ? { result: FIX.headers.find((h) => h.hash === j.params[0]).header } : { error: { code: -32601, message: 'local header source only' } }) }));
  closers.push(() => headers.s.close());
  const proxies = [];
  for (const s of good) {
    const p = await serve(async (j) => { const r = await publicCall(s, j.method, j.params); return { ...r, id: j.id }; });
    proxies.push(p); closers.push(() => p.s.close());
  }
  const roots = createRootStore({ checker, consensusUrl: consensus.url });
  const cacheDir = path.join(outDir, 'cache');
  const g = createWitnessGateway({ upstreams: [headers.url, ...proxies.map((p) => p.url)], cache: dirWitnessCache(cacheDir), proofs: { checker, roots },
    methods: WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList'), timeoutMs: 15000, deadlineMs: 60000 });
  const gUrl = await g.listen(0); closers.push(() => g.close());
  const home = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'rec-home-'));
  fs.mkdirSync(path.join(home, '.helios'));
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${BASE_MAINNET.unsafeSigner}"\n`);
  const port = await freePort();
  const helios = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', consensus.url, '--execution-rpc', gUrl, '--rpc-port', String(port)], { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  closers.push(() => { helios.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); });
  const hUrl = `http://127.0.0.1:${port}/`;
  let adopted = false;
  for (let i = 0; i < 120 && !adopted; i++) { try { adopted = (await rpc(hUrl, 'eth_getBlockByNumber', ['0x' + TARGET.toString(16), false]))?.hash === HASH; } catch {} if (!adopted) await sleep(250); }
  if (!adopted) throw new Error('helios did not adopt the real signed head');
  current = heads[HEAD].commitment;                         // the head moves on before the gateway ever looks
  out.calls = [];
  for (const c of CALLS) {
    if (BUDGET.requests - used.requests < 6) { out.calls.push({ name: c.name, skipped: 'budget reserve' }); continue; }
    const rec = { name: c.name, tx: c.tx };
    try { rec.helios = await rpc(hUrl, 'eth_call', [c.tx, { blockHash: HASH }]); } catch (e) { rec.heliosError = e.message; }
    try { const j = await publicCall(good[0], 'eth_call', [c.tx, { blockHash: HASH }]); rec.provider = j.result ?? null; rec.providerError = j.error?.message; } catch (e) { rec.providerError = e.message; }
    rec.agree = rec.helios !== undefined && rec.helios === rec.provider;
    out.calls.push(rec);
  }
  out.gateway = g.stats(); out.roots = roots.stats();
  out.rootOfTarget = await g.root(HASH);
} catch (e) {
  out.error = e.message; if (e.unavailable) out.unavailable = true;
} finally {
  for (const c of closers.reverse()) { try { await c(); } catch {} }
  out.used = { ...used, ms: elapsed() }; out.requests = log;
  if (prior) out.priorAttempt = 'attempt-1.json (its usage is included in used)';
  out.cacheEntries = fs.existsSync(path.join(outDir, 'cache')) ? fs.readdirSync(path.join(outDir, 'cache'), { recursive: true }).filter((n) => n.endsWith('.json')).length : 0;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'recording.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ used: out.used, preflight: out.preflight, calls: out.calls?.map((c) => [c.name, c.agree, c.heliosError || '']), error: out.error, cacheEntries: out.cacheEntries }));
  process.exit(0);
}
