// END-TO-END: app-funded lease gas (design B) with the HOST reading ONLY through its local verifier (network/chain-authority.mjs):
// the real EnclaveLeaseGasReserve + EnclaveLeaseExecutor (test/helpers/lease-gas-world.mjs on a reth --dev chain, built from
// source), the REAL relay service (network/lease-relay-service.mjs: a separate relay operator with its own key and its own
// chain access, as in production), and the REAL lease client (client/lease-executor-client.mjs) given exactly ONE client,
// the verifier's. Every authority read, receipt check, nonce fence and landing search of the host is proven by the verifier
// runtime (the pinned Helios behind the witness gateway). A proxy in front of the relay can lose the relay's answer after
// the lease landed: the app's reserve is charged once, the host never posts it twice, before or after a restart.
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
import { parseEventLogs } from 'viem';
import * as B from '../client/lease-executor-client.mjs';
import { leaseRpcSet } from '../client/lease-executor-authority.mjs';
import { startRelayService } from '../network/lease-relay-service.mjs';
import { createChainAuthority } from '../network/chain-authority.mjs';
import { startWorldOn, haveAnvil } from './helpers/lease-gas-world.mjs';
import { launchVerifierRuntime, startProofSource } from './helpers/verifier-runtime.mjs';

const { RUNTIME_BIN_DIR, RIG_RETH_BIN, RIG_RETH_GENESIS } = process.env;
const skip = (!haveAnvil && 'needs forge (the lease-gas contracts are built from source)') || (!RUNTIME_BIN_DIR && 'RUNTIME_BIN_DIR not set')
  || ((!RIG_RETH_BIN || !RIG_RETH_GENESIS) && 'needs RIG_RETH_BIN and RIG_RETH_GENESIS (a canonical-trie chain for proofs)');
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'lease-gas-verifier-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
let reth, rpcUrl, W, svc, proxy, proxyUrl, proof, rt, A;
const seen = { posts: 0, mode: 'ok', lost: 0 };

test.before(async () => {
  if (skip) return;
  const port = await freePort(), data = fs.mkdtempSync(path.join('/tmp', 'lgv-reth-'));
  reth = spawn(RIG_RETH_BIN, ['node', '--dev', '--dev.block-time', '2s', '--chain', RIG_RETH_GENESIS, '--datadir', data, '--http', '--http.addr', '127.0.0.1',
    '--http.port', String(port), '--http.api', 'eth,net,web3', '--disable-discovery', '--ipcdisable', '--port', '0', '--authrpc.port', String(await freePort()),
    '--rpc.eth-proof-window', '1024'], { stdio: 'ignore' });
  reth.dataDir = data;
  rpcUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 600; i++) { try { const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) break; } catch {} await sleep(100); }
  W = await startWorldOn({ rpcUrl });
  const bytes = Buffer.from(JSON.stringify({ format: 'enclave-lease-gas-deployment/v1', chainId: 8453,
    ...Object.fromEntries(['reserve', 'executor', 'ledger', 'registry', 'reserveCodeHash', 'executorCodeHash'].map((k) => [k, W.addr[k]])) }));
  const rec = path.join(TMP, 'record.json'); fs.writeFileSync(rec, bytes);
  const key = generatePrivateKey(), kf = path.join(TMP, 'relay.key'); fs.writeFileSync(kf, key + '\n', { mode: 0o600 });
  await W.fund(privateKeyToAccount(key).address, 10n ** 16n);
  // the RELAY operator's own service and chain access (not the host's): it submits, the reserve pays it back
  svc = await startRelayService({ recordFile: rec, digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'), keyFile: kf,
    rpcs: [rpcUrl], allowLoopbackHttp: true, maxFloatEth: '0.02', log: () => {} });
  proxy = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.method === 'POST') seen.posts++;
    const r = await fetch(svc.url + req.url, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' },
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
    const body = Buffer.from(await r.arrayBuffer());
    if (req.method === 'POST' && seen.mode === 'lose-answer') { seen.mode = 'ok'; seen.lost++; return res.destroy(); }   // it landed; the answer is lost
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' }); res.end(body);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  proof = await startProofSource(rpcUrl);
  rt = launchVerifierRuntime({ chainRpc: rpcUrl, proofSources: [proof.url], port: await freePort(), dir: path.join(TMP, 'runtime') });
  await rt.ready();
  A = createChainAuthority({ verifier: rt.url, chain: W.chain });
});
test.after(async () => {
  await rt?.stop(); proxy?.close(); proof?.srv.close(); await svc?.close();   // awaited: its detached Helios/listener are stopped by identity
  try { reth?.kill('SIGKILL'); } catch {}
  if (reth?.dataDir) fs.rmSync(reth.dataDir, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});
const T = { skip, timeout: 600000 };
const journal = [];
const clientFor = (op) => B.createLeaseClient({ client: A.client, clients: [A.client], account: op.account, reserve: W.addr.reserve,
  deployment: { chainId: 8453, ...W.addr }, relays: [proxyUrl], allowLoopbackHttp: true, consumedRecheckMs: [4000, 8000, 16000],
  onSigned: (s) => { journal.push(JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))); } });
const claimedEvents = async (id) => parseEventLogs({ abi: W.A.ledger.abi, logs: await W.pc.getLogs({ address: W.addr.ledger, fromBlock: 0n, toBlock: 'latest' }) })
  .filter((e) => e.eventName === 'Claimed' && e.args.id.toLowerCase() === id.toLowerCase());
async function fresh() {
  const owner = await W.owner(), id = await W.create(owner); await W.enable(owner, id);
  const op = await W.operator(`https://lease-gas-verifier-${crypto.randomBytes(4).toString('hex')}.test`);
  return { id, op };
}
const settleFrom = (s) => [{ id: s.lease.id, kind: Number(s.lease.kind), enclaveId: s.lease.enclaveId, nonce: BigInt(s.nonce), deadline: BigInt(s.deadline),
  maxChargeWei: BigInt(s.lease.maxChargeWei) }, BigInt(s.fromBlock), [s.payee], { operator: s.operator, chainId: s.chainId, reserve: s.reserve, executor: s.executor, ledger: s.ledger }];

test('the host\'s lease reads are ONE local-verifier authority (no provider anywhere in its configuration)', T, () => {
  const set = leaseRpcSet([A.client], { quorum: 2 });
  assert.equal(set.authority, 'local-verifier'); assert.equal(set.required, 1);
});

test('an app-funded claim through the real relay, verified by the verifier: landed, charged to the app\'s reserve once', T, async () => {
  const { id, op } = await fresh();
  const posts = seen.posts, c = clientFor(op);
  const r = await c.claim(id, op.enclaveId);
  assert.match(r.hash, /^0x[0-9a-f]{64}$/); assert.equal(r.receipt.status, 'success');
  assert.equal(seen.posts - posts, 1, 'one lease handed to the relay');
  assert.equal((await W.row(id)).runnerOperator, op.address, 'claimed on chain by this operator');
  assert.equal((await claimedEvents(id)).length, 1);
});

test('the relay\'s answer is lost after the lease landed: decided from the chain through the verifier; nothing is posted twice; a restarted client resolves the journal as landed', T, async () => {
  const { id, op } = await fresh();
  const posts = seen.posts, j0 = journal.length;
  seen.mode = 'lose-answer';
  let out = null, err = null;
  try { out = await clientFor(op).claim(id, op.enclaveId); } catch (e) { err = e; }
  assert.equal(seen.lost, 1, 'the answer was lost');
  assert.equal(seen.posts - posts, 1, 'the signed lease was posted exactly once');
  assert.equal(journal.length - j0, 1, 'one signed lease, journaled before the relay saw it');
  // the landing is found on chain (verified), or - when the verifier was still behind - the intent stays for resolution
  if (out) assert.equal(out.receipt.status, 'success'); else assert.ok(err, 'a lost answer is never silent');
  // "restart": a NEW client (no memory of the operation) settles the journaled intent from the chain alone
  const s = journal[journal.length - 1];
  let settled = null;
  for (let i = 0; i < 30 && settled?.state !== 'landed'; i++) { settled = await clientFor(op).resolveSigned(...settleFrom(s)); if (settled.state !== 'landed') await sleep(2000); }
  assert.equal(settled.state, 'landed', JSON.stringify(settled, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  assert.equal(settled.verified.receipt?.status ?? (await settled.verified.receiptP).status, 'success');
  await sleep(6000);
  assert.equal(seen.posts - posts, 1, 'still exactly one post');
  assert.equal((await claimedEvents(id)).length, 1, 'claimed exactly once');
});

test('no proof source answers: the claim refuses before anything is signed or posted', T, async () => {
  const { id, op } = await fresh();
  const posts = seen.posts, j0 = journal.length;
  proof.st.mode = 'down';
  try {
    await sleep(3000);
    await assert.rejects(clientFor(op).claim(id, op.enclaveId));
    assert.equal(seen.posts, posts, 'nothing posted');
    assert.equal(journal.length, j0, 'nothing signed');
    assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/i);
  } finally { proof.st.mode = 'ok'; }
  const r = await clientFor(op).claim(id, op.enclaveId);
  assert.equal(r.receipt.status, 'success', 'claims resume once a proof source answers');
});
