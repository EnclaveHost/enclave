// END-TO-END: the app-funded lease RELAY on the operator's local verifier authority (ENCLAVE_CHAIN_AUTHORITY=verifier):
// the real EnclaveLeaseGasReserve + EnclaveLeaseExecutor on a reth --dev chain (test/helpers/lease-gas-world.mjs, built from
// source), the REAL verifier runtime (the pinned Helios behind the witness gateway, test/helpers/verifier-runtime.mjs), the
// REAL relay service (network/lease-relay-service.mjs) given NO provider at all - only the verifier and an own-backend URL -
// and the REAL host lease client reading through its own verifier client. The own backend is reth behind a recording proxy
// that can fork, lag, fail to forward, or refuse definitively. Shown:
//   * the relay's reads, float, simulation, nonce and receipt come from the verifier; the backend is asked only to bind
//     (chain id, the verifier's head block) and to take the signed bytes, exactly once per lease;
//   * an unbound or behind backend refuses BEFORE anything is signed: no bytes, no durable record, nothing on chain;
//   * a failed forward is never reported as sent or landed: the relay keeps the exact bytes, the host gets no success, and
//     after a restart the relay re-broadcasts THOSE bytes (never re-signed); the host's journaled intent resolves as landed;
//   * a definite refusal clears the record (nothing can be pending), and the relay serves normally afterwards.
// SYNTHETIC head authority (a TEST sequencer key); fixture keys only; nothing leaves loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseEventLogs, keccak256, encodeFunctionData } from 'viem';
import * as B from '../client/lease-executor-client.mjs';
import { startRelayService } from '../network/lease-relay-service.mjs';
import { createChainAuthority } from '../network/chain-authority.mjs';
import { startWorldOn, haveAnvil } from './helpers/lease-gas-world.mjs';
import { launchVerifierRuntime, startProofSource } from './helpers/verifier-runtime.mjs';
import { procIdentity } from '../network/gossip-head-source.mjs';

const { RUNTIME_BIN_DIR, RIG_RETH_BIN, RIG_RETH_GENESIS } = process.env;
const missing = (!haveAnvil && 'needs forge (the lease-gas contracts are built from source)') || (!RUNTIME_BIN_DIR && 'RUNTIME_BIN_DIR not set')
  || ((!RIG_RETH_BIN || !RIG_RETH_GENESIS) && 'needs RIG_RETH_BIN and RIG_RETH_GENESIS (a canonical-trie chain for proofs)');
// REQUIRE_VERIFIER_E2E=1 (the job scripts): a missing artifact FAILS instead of skipping, so a skip is never read as a pass
if (missing && process.env.REQUIRE_VERIFIER_E2E === '1') throw new Error(`verifier E2E required but ${missing}`);
const skip = missing;
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'lease-relay-verifier-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const dataOf = (e) => { for (let x = e; x; x = x.cause) { const d = typeof x.data === 'string' ? x.data : x.data?.data; if (typeof d === 'string' && /^0x[0-9a-f]+$/i.test(d)) return d.toLowerCase(); } return null; };
// the pinned Helios reports a revert's data in its message text only ("execution reverted: <hex>")
const textData = (e) => { const m = /execution reverted: (?:0x)?([0-9a-f]{8,})/i.exec(B.rpcDetails(e)); return m ? ('0x' + m[1]).toLowerCase() : null; };
const big = (o) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
let reth, rpcUrl, W, svc, backend, backendUrl, proof, rt, A, relayArgs, stateFile, relayKey;
const sockets = new Set();
// the own backend: reth behind a recorder. mode: ok | fork (another block at the verifier's head) | behind (no such block)
// | forward-fail (the backend's sequencer forward fails: an error, the bytes are NOT passed on) | refuse-funds (definite)
const be = { mode: 'ok', calls: [], raws: [] };

async function fwd(body) {
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

test.before(async () => {
  if (skip) return;
  const port = await freePort(), data = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'lrv-reth-'));
  reth = spawn(RIG_RETH_BIN, ['node', '--dev', '--dev.block-time', '2s', '--chain', RIG_RETH_GENESIS, '--datadir', data, '--http', '--http.addr', '127.0.0.1',
    '--http.port', String(port), '--http.api', 'eth,net,web3', '--disable-discovery', '--ipcdisable', '--port', '0', '--authrpc.port', String(await freePort()),
    '--rpc.eth-proof-window', '1024'], { stdio: 'ignore' });
  reth.dataDir = data;
  rpcUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 600; i++) { try { const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) break; } catch {} await sleep(100); }
  W = await startWorldOn({ rpcUrl });
  backend = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    be.calls.push(body.method);
    const reply = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...o })); };
    if (body.method === 'eth_sendRawTransaction') {
      be.raws.push(body.params[0]);
      if (be.mode === 'forward-fail') return reply({ error: { code: -32000, message: 'failed to forward the transaction to the sequencer: connection refused' } });
      if (be.mode === 'refuse-funds') return reply({ error: { code: -32000, message: 'insufficient funds for gas * price + value' } });
    }
    if (body.method === 'eth_getBlockByNumber' && be.mode === 'behind') return reply({ result: null });
    const r = await fwd(body);
    if (body.method === 'eth_getBlockByNumber' && be.mode === 'fork' && r.result) r.result.hash = '0x' + 'ab'.repeat(32);
    reply(r.error ? { error: r.error } : { result: r.result });
  });
  backend.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  backendUrl = `http://127.0.0.1:${backend.address().port}/`;
  proof = await startProofSource(rpcUrl);
  rt = launchVerifierRuntime({ chainRpc: rpcUrl, proofSources: [proof.url], port: await freePort(), dir: path.join(TMP, 'runtime') });
  await rt.ready();
  A = createChainAuthority({ verifier: rt.url, chain: W.chain });            // the HOST's verifier client (reads only)
  const bytes = Buffer.from(JSON.stringify({ format: 'enclave-lease-gas-deployment/v1', chainId: 8453,
    ...Object.fromEntries(['reserve', 'executor', 'ledger', 'registry', 'reserveCodeHash', 'executorCodeHash'].map((k) => [k, W.addr[k]])) }));
  const rec = path.join(TMP, 'record.json'); fs.writeFileSync(rec, bytes);
  relayKey = generatePrivateKey();
  const kf = path.join(TMP, 'relay.key'); fs.writeFileSync(kf, relayKey + '\n', { mode: 0o600 });
  await W.fund(privateKeyToAccount(relayKey).address, 10n ** 16n);
  stateFile = path.join(TMP, 'relay-send.json');
  // the relay operator's service on the LOCAL VERIFIER: no RPC list, no quorum; the own backend is the recorder above
  relayArgs = { recordFile: rec, digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'), keyFile: kf, listen: `127.0.0.1:${await freePort()}`,
    maxFloatEth: '0.02', log: () => {}, stateFile,
    chainEnv: { ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: rt.url, ENCLAVE_CHAIN_TX_BACKEND: backendUrl },
    authorityOptions: { bindTtlMs: 1 },                                      // re-bind at every submission (the fault modes take effect at once)
    relayOptions: { receiptTimeoutMs: 30_000 } };
  svc = await startRelayService(relayArgs);
});
// every process of this file: the runtime (and its detached Helios/listener, by recorded identity) and reth, awaited
async function stopFixtures() {
  const report = rt ? await rt.stop() : null;
  if (reth && reth.exitCode === null && reth.signalCode === null) {
    const gone = new Promise((r) => reth.once('exit', r));
    try { reth.kill('SIGTERM'); } catch {}
    if (!(await Promise.race([gone.then(() => true), sleep(15_000).then(() => false)]))) { try { reth.kill('SIGKILL'); } catch {} await Promise.race([gone, sleep(5_000)]); }
  }
  return report;
}
/** live processes (other than this one) whose command line or executable names one of this file's scratch paths */
function processesUnder(...roots) {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let cmd = '', exe = '';
    try { cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
    try { exe = fs.readlinkSync(`/proc/${name}/exe`); } catch {}
    if (!procIdentity(Number(name))) continue;                               // zombie/exited
    if (roots.some((r) => r && (cmd.includes(r) || exe.startsWith(r)))) out.push({ pid: Number(name), cmd: cmd.slice(0, 160) });
  }
  return out;
}
test.after(async () => {
  proof?.srv.close(); await svc?.close();
  await stopFixtures();
  for (const s of sockets) s.destroy();
  backend?.close();
  if (reth?.dataDir) fs.rmSync(reth.dataDir, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});
const T = { skip, timeout: 600000 };
const journal = [];
const clientFor = (op, { requestTimeoutMs = 45_000 } = {}) => B.createLeaseClient({ client: A.client, clients: [A.client], account: op.account, reserve: W.addr.reserve,
  deployment: { chainId: 8453, ...W.addr }, relays: [svc.url], allowLoopbackHttp: true, requestTimeoutMs, consumedRecheckMs: [2000, 4000],
  onSigned: (s) => { journal.push(JSON.parse(big(s))); } });
const claimedEvents = async (id) => parseEventLogs({ abi: W.A.ledger.abi, logs: await W.pc.getLogs({ address: W.addr.ledger, fromBlock: 0n, toBlock: 'latest' }) })
  .filter((e) => e.eventName === 'Claimed' && e.args.id.toLowerCase() === id.toLowerCase());
async function fresh() {
  const owner = await W.owner(), id = await W.create(owner); await W.enable(owner, id);
  const op = await W.operator(`https://lease-relay-verifier-${crypto.randomBytes(4).toString('hex')}.test`);
  return { id, op };
}
const settleFrom = (s) => [{ id: s.lease.id, kind: Number(s.lease.kind), enclaveId: s.lease.enclaveId, nonce: BigInt(s.nonce), deadline: BigInt(s.deadline),
  maxChargeWei: BigInt(s.lease.maxChargeWei) }, BigInt(s.fromBlock), [s.payee], { operator: s.operator, chainId: s.chainId, reserve: s.reserve, executor: s.executor, ledger: s.ledger }];
const persisted = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {});
const relayNonce = () => W.pc.getTransactionCount({ address: privateKeyToAccount(relayKey).address });
const STATE_METHODS = ['eth_call', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount', 'eth_getTransactionReceipt',
  'eth_getTransactionByHash', 'eth_getLogs', 'eth_estimateGas', 'eth_getProof', 'eth_blockNumber'];

test('the relay runs on ONE local-verifier authority: no provider configured, its own backend bound at the verifier\'s head', T, () => {
  assert.equal(svc.mode, 'verifier');
  assert.equal(svc.chainAuthority.authority, 'local-verifier');
  assert.equal(svc.chainAuthority.backend.scope, 'loopback');
  assert.equal(svc.authorityStatus().ok, true, big(svc.authorityStatus()));
});

test('the verifier executes the authorization\'s state override exactly as the chain node does (never vacuously)', T, async (t) => {
  const { id, op } = await fresh();
  const relay = privateKeyToAccount(relayKey).address;
  const head = await A.client.getBlock();
  const at = { blockHash: head.hash, requireCanonical: true };
  const n = await A.client.getTransactionCount({ address: op.address, blockNumber: head.number });
  const override = { [op.address]: { code: B.designator(W.addr.executor), nonce: '0x' + (n + 1).toString(16) } };
  // the oracle: the same request on the chain node itself (reth applies state overrides natively)
  const both = async (params) => {
    const ask = async (c) => { try { return { ok: await c.request({ method: 'eth_call', params }) }; } catch (e) { return { err: B.rpcDetails(e) || B.reasonOf(e), data: dataOf(e) ?? textData(e) }; } };
    const [v, r] = [await ask(A.client), await ask(W.pc)];
    t.diagnostic(`verifier ${big(v)} | node ${big(r)}`);
    return { v, r };
  };
  // 1. a plain account runs no code: the probe the relay uses answers "0x" without the override (vacuous) ...
  const nonceOf = { from: relay, to: op.address, data: encodeFunctionData({ abi: B.EXECUTOR_ABI, functionName: 'nonceOf', args: [id] }) };
  const plain = await both([nonceOf, at]);
  assert.equal(plain.v.ok, '0x'); assert.equal(plain.r.ok, '0x');
  // ... and one 32-byte word (this deployment's next lease nonce, 0) with it: the executor's code ran at the operator
  const delegated = await both([nonceOf, at, override]);
  assert.equal(delegated.r.ok, '0x' + '00'.repeat(32), 'the chain node runs the delegated code');
  assert.equal(delegated.v.ok, delegated.r.ok, 'the verifier runs the delegated code under the override as the node does');
  // 2. the lease itself with a signature the executor must refuse: both revert with the SAME revert data
  const lease = { id, kind: 1, enclaveId: op.enclaveId, nonce: 0n, deadline: head.timestamp + 300n, payee: relay, maxChargeWei: 10n ** 15n };
  const call = { from: relay, to: op.address, data: B.leaseCalldata(lease, '0x' + '11'.repeat(65)), gas: '0x' + (575_000).toString(16) };
  const bad = await both([call, at, override]);
  assert.ok(bad.r.err && bad.r.data, 'the node reverts it with data');
  assert.ok(bad.v.err, 'the verifier refuses it');
  assert.equal(bad.v.data, bad.r.data, 'with the same revert data');
  // 3. the pinned verifier cannot run a type-4 call itself (it drops the authorization list): why the relay uses the override
  const auth = await op.account.signAuthorization({ contractAddress: W.addr.executor, chainId: 8453, nonce: n });
  const t4 = await both([{ ...call, gas: '0x' + (600_000).toString(16), authorizationList: [{ address: auth.address,
    chainId: '0x' + auth.chainId.toString(16), nonce: '0x' + auth.nonce.toString(16), r: auth.r, s: auth.s, yParity: '0x' + auth.yParity.toString(16) }] }, at]);
  assert.ok(t4.v.err, 'type-4 eth_call refused by the pinned verifier');
  // 4. the pinned verifier drops an EIP-1559 call's maxFeePerGas (why the relay prices its simulation as gasPrice = base + priority)
  const fees = { maxFeePerGas: '0x' + (head.baseFeePerGas * 2n + 1_000_000n).toString(16), maxPriorityFeePerGas: '0x' + (1_000_000).toString(16) };
  const p1559 = await both([{ ...nonceOf, ...fees }, at, override]);
  assert.equal(p1559.r.ok, '0x' + '00'.repeat(32));
  assert.match(String(p1559.v.err), /priority fee is greater than max fee/);
  // (with an explicit gas limit, as the relay's simulation always has: the pinned verifier defaults it to 2^64-1 and then
  // checks the caller's balance against that)
  const exact = await both([{ ...nonceOf, gas: '0x' + (100_000).toString(16), gasPrice: '0x' + (head.baseFeePerGas + 1_000_000n).toString(16) }, at, override]);
  assert.equal(exact.r.ok, '0x' + '00'.repeat(32));
  assert.equal(exact.v.ok, exact.r.ok);
});
test('an app-funded claim through the verifier-authority relay: landed once, its bytes sent ONCE to the own backend, which is never asked for state', T, async () => {
  const { id, op } = await fresh();
  const calls = be.calls.length, raws = be.raws.length, n0 = await relayNonce();
  const r = await clientFor(op).claim(id, op.enclaveId);
  assert.equal(r.receipt.status, 'success');
  assert.equal((await W.row(id)).runnerOperator, op.address, 'claimed on chain by this operator');
  assert.equal((await claimedEvents(id)).length, 1);
  assert.equal(be.raws.length - raws, 1, 'the signed bytes went to the own backend exactly once');
  assert.equal(keccak256(be.raws[be.raws.length - 1]), r.hash, 'those bytes are the landed transaction');
  assert.equal(await relayNonce(), n0 + 1);
  const asked = be.calls.slice(calls);
  assert.deepEqual([...new Set(asked)].sort(), ['eth_chainId', 'eth_getBlockByNumber', 'eth_sendRawTransaction'], `backend methods: ${asked.join(',')}`);
  assert.ok(!asked.some((m) => STATE_METHODS.includes(m)), 'no state, nonce, receipt or simulation from the backend');
  assert.deepEqual(persisted(), {}, 'resolved: nothing left unresolved');
});

for (const mode of ['fork', 'behind']) {
  test(`an own backend ${mode === 'fork' ? 'on another chain (unbound)' : 'behind the verifier'} is refused BEFORE anything is signed: no bytes, no record, no landing`, T, async () => {
    const { id, op } = await fresh();
    const raws = be.raws.length, n0 = await relayNonce();
    be.mode = mode;
    let err;
    try { await clientFor(op).claim(id, op.enclaveId); } catch (e) { err = e; } finally { be.mode = 'ok'; }
    assert.ok(err, 'the claim does not succeed');
    assert.equal(err.code, 'NotRelayed', `${err.code}: ${err.message}`);
    assert.match(err.message, mode === 'fork' ? /chain_backend_unbound/ : /chain_backend_behind/);
    assert.match(err.message, /nothing was signed or sent/);
    assert.equal(be.raws.length, raws, 'no bytes reached the backend');
    assert.deepEqual(persisted(), {}, 'no durable send record');
    assert.equal(await relayNonce(), n0, 'the relay key sent nothing');
    assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/i, 'not claimed');
    assert.equal(svc.authorityStatus().ok, false);
  });
}

test('a definite refusal by the backend: "Rejected", the record is cleared (nothing can be pending), the host gets no success', T, async () => {
  const { id, op } = await fresh();
  const raws = be.raws.length, n0 = await relayNonce();
  be.mode = 'refuse-funds';
  let err;
  try { await clientFor(op).claim(id, op.enclaveId); } catch (e) { err = e; } finally { be.mode = 'ok'; }
  assert.equal(err?.code, 'NotRelayed', `${err?.code}: ${err?.message}`);
  assert.match(err.message, /Rejected/);
  assert.equal(be.raws.length - raws, 1, 'offered once');
  assert.deepEqual(persisted(), {});
  assert.equal(await relayNonce(), n0);
  assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/i);
});

// A forward that fails, end to end; `relayOptions` choose the relay's waits (both cases are longer than the 10 s request
// RECEIPT bound, which once also cut the idle connection of a relay job still waiting: r4 saw "fetch failed")
async function forwardFailFlow(t, { relayOptions, hostTimeoutMs, expect }) {
  const { id, op } = await fresh();
  const raws = be.raws.length, j0 = journal.length, n0 = await relayNonce();
  await svc.close();
  svc = await startRelayService({ ...relayArgs, relayOptions });
  be.mode = 'forward-fail';
  let err; const t0 = Date.now();
  try { await clientFor(op, { requestTimeoutMs: hostTimeoutMs }).claim(id, op.enclaveId); } catch (e) { err = e; } finally { be.mode = 'ok'; }
  const waited = Date.now() - t0;
  t.diagnostic(`host answer after ${waited} ms: ${err?.code}: ${err?.message}`);
  assert.equal(err?.code, 'NotRelayed', `${err?.code}: ${err?.message}`);
  assert.match(err.message, expect, 'the relay\'s own answer reached the host');
  assert.doesNotMatch(err.message, /fetch failed|aborted/i, 'not a cut connection');
  assert.doesNotMatch(err.message, /success|accepted/i);
  assert.ok(waited > 10_000, `the relay held the connection past the 10 s receipt bound (${waited} ms)`);
  assert.equal(be.raws.length - raws, 1);
  const rec = persisted();
  assert.deepEqual(Object.keys(rec).sort(), ['hash', 'nonce', 'raw'], 'the unresolved bytes are durable');
  assert.equal(rec.raw, be.raws[be.raws.length - 1], 'exactly the bytes offered');
  assert.equal(rec.nonce, n0);
  assert.equal(await W.pc.request({ method: 'eth_getTransactionByHash', params: [rec.hash] }), null, 'the chain never saw them');
  assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/i, 'not claimed');
  assert.equal(journal.length - j0, 1);
  // restart (close waits for the relay job still holding the key): the new process re-broadcasts THOSE bytes first
  await svc.close();
  assert.deepEqual(persisted(), rec, 'the record survives the job\'s end and the stop unchanged');
  svc = await startRelayService(relayArgs);
  const after = be.raws.length;
  await clientFor(op).claim(id, op.enclaveId).catch(() => {});                // the relay answers RelayBusy after re-broadcasting
  assert.ok(be.raws.length > after, 'the restarted relay offered bytes again');
  for (const raw of be.raws.slice(after)) assert.equal(raw, rec.raw, 're-broadcast only, never a new signature');
  let settled = null;
  for (let i = 0; i < 30 && settled?.state !== 'landed'; i++) { settled = await clientFor(op).resolveSigned(...settleFrom(journal[j0])); if (settled.state !== 'landed') await sleep(2000); }
  assert.equal(settled.state, 'landed', big(settled));
  assert.equal(settled.verified.hash, rec.hash, 'the landed transaction is the persisted one');
  assert.equal((await claimedEvents(id)).length, 1, 'claimed exactly once');
  assert.equal(await relayNonce(), n0 + 1, 'one transaction from the relay key');
  // the next lease resolves the record (its nonce is consumed) and is relayed normally
  const next = await fresh();
  const r = await clientFor(next.op).claim(next.id, next.op.enclaveId);
  assert.equal(r.receipt.status, 'success');
  assert.deepEqual(persisted(), {});
}

test('the backend fails to forward (relay receipt wait 30 s): its 502 "not confirmed" reaches the host; never sent or landed; same bytes after a restart; the journaled intent lands once', T,
  (t) => forwardFailFlow(t, { relayOptions: { receiptTimeoutMs: 30_000 }, hostTimeoutMs: 45_000,
    expect: /502 relay_failed lease 0x[0-9a-f]{64} is not confirmed by a verifier-checked receipt \(broadcast unknown/ }));

test('the backend fails to forward under the PRODUCTION waits (request 60 s, receipt 120 s): the host gets the relay\'s 60 s answer, the job keeps the key, the same bytes land after a restart', T,
  (t) => forwardFailFlow(t, { relayOptions: {}, hostTimeoutMs: 75_000, expect: /502 relay_failed relay: no answer within 60000 ms/ }));

test('a stalled upload is cut at the 10 s receipt bound with 408 (the bound that stays for slow clients)', T, async () => {
  const u = new URL(svc.url);
  const t0 = Date.now();
  const answer = await new Promise((ok) => {
    const sock = net.connect(Number(u.port), u.hostname, () => sock.write('POST /v1/lease HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"op'));
    let data = ''; sock.on('data', (d) => { data += d; }); sock.on('close', () => ok(data)); sock.on('error', () => {});
    setTimeout(() => sock.destroy(), 30_000);
  });
  const took = Date.now() - t0;
  assert.match(answer, /^HTTP\/1\.1 408/, answer.slice(0, 80));
  assert.ok(took >= 9_500 && took < 20_000, `cut at the receipt bound (${took} ms)`);
});

test('a float above the cap is refused at start through the verifier (the balance is a proven account read)', T, async () => {
  const key = generatePrivateKey(), kf = path.join(TMP, 'rich.key');
  fs.writeFileSync(kf, key + '\n', { mode: 0o600 });
  await W.fund(privateKeyToAccount(key).address, 10n ** 17n);
  await assert.rejects(startRelayService({ ...relayArgs, keyFile: kf, listen: '127.0.0.1:0', stateFile: path.join(TMP, 'rich-send.json') }), /above its 0\.02 ETH float cap/);
});

// LAST: the teardown itself is evidence (root 13:18Z found orphaned Helios/listener children of earlier runs)
test('teardown: the runtime stops its detached Helios and listener on SIGTERM, reth exits, and no process of this test remains', T, async (t) => {
  const owned = rt.owned();
  assert.ok(owned.some((id) => id.role === 'helios'), `the runtime recorded its Helios child: ${big(owned)}`);
  assert.ok(owned.some((id) => id.role === 'listener'), `the runtime recorded its listener child: ${big(owned)}`);
  const report = await stopFixtures();
  t.diagnostic(`teardown ${big({ owned, report })}`);
  assert.equal(report.escalated, false, 'the runtime exited on SIGTERM within the grace period (no SIGKILL of its group)');
  assert.deepEqual(report.killedChildren, [], 'it stopped its own children: none had to be killed by the test');
  assert.deepEqual(report.leftover, []);
  for (const id of owned) assert.ok(procIdentity(id.pid)?.startTime !== id.startTime, `recorded ${id.role} ${id.pid} is gone`);
  assert.ok(reth.exitCode !== null || reth.signalCode !== null, 'reth exited');
  const left = processesUnder(TMP, reth.dataDir);
  assert.deepEqual(left, [], 'no process names this test\'s scratch paths');
});
