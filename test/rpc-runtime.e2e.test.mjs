// END-TO-END: the COMPOSED verifier runtime (network/rpc-runtime.mjs through its process entry) on A's canonical local
// chain (pinned reth v2.8.0 --dev, chain id 8453, the cli-independent rig's REAL platform contracts), consumed by the
// real LeaseReader (authority 'verifier') and host admission:
//   listener stand-in (listen emulated over the reth chain; `commitment` = the REAL pinned listener binary)
//   -> native commitment + op-head-relay verifyCommitment -> roots.offer (REAL witness-check helper) -> relay
//   -> proof-aware witness gateway (two scriptable UNTRUSTED proxies in front of reth) -> REAL Helios (enclave-base-evm)
// SYNTHETIC HEAD AUTHORITY: the blocks are signed by a TEST sequencer key (pinned in the runtime config the same way the
// Base key is). Real Base gossip and recorded Base execution are separate evidence (rpc-runtime-base-heads.test.mjs,
// helios-base-replay.e2e, helios-witness-failover.e2e). Nothing here proves Base availability, finality or independence.
// The chain's genesis is A's pinned reth dev genesis plus the EIP-2935 history contract Base has (derived:
// test/fixtures/derive-reth-genesis-2935.py -> reth-dev-8453-genesis-2935.json); asserted at setup.
//   env: RIG_CHAIN_NODE=reth, RIG_RETH_BIN, RIG_RETH_GENESIS (the -2935 genesis), RUNTIME_BIN_DIR (helios-eeffcc9, witness-check,
//        enclave-base-head-listener), TEST_TMP. Needs contracts/foundry/out. Run inside `unshare -r -n` (lo up).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { stringToHex, pad, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRig, haveTools, KEYS, freePort } from './helpers/cli-independent-rig.mjs';
import { LeaseReader } from '../network/lease-reader.mjs';
import { createHostAdmission } from '../network/host-admission-runtime.mjs';
import { hostAdmissionPolicyHash } from '../network/host-admission-policy.mjs';
import { CONFIG_FORMAT } from '../network/rpc-runtime.mjs';

const { RUNTIME_BIN_DIR } = process.env;
const canonical = process.env.RIG_CHAIN_NODE === 'reth';
const skip = haveTools() || (!RUNTIME_BIN_DIR && 'RUNTIME_BIN_DIR not set') || (!canonical && 'needs a canonical-trie chain (RIG_CHAIN_NODE=reth)');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const STANDIN = path.join(HERE, 'fixtures', 'reth-gossip-listener.mjs'), LAUNCHER = path.join(HERE, 'fixtures', 'rpc-runtime-launcher.mjs');
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'rpc-runtime-e2e-'));
const SEQ_KEY = '0x' + '5e'.repeat(32), seqSigner = privateKeyToAccount(SEQ_KEY).address;
const OUT = path.join(HERE, '..', 'contracts/foundry/out');
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, `${name}.json`), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bin = (n) => path.join(RUNTIME_BIN_DIR || '/nonexistent', n);
let rig, book, bookAbi, leaseId, proxies, rt, reader;

async function rpc(url, method, params = [], ms = 30000) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await pred()) return; } catch {} await sleep(250); }
  throw new Error(`timed out: ${what}`);
}
/** a scriptable UNTRUSTED witness source in front of the chain: ok | down | tamper (every proof answer altered: the
 *  account balance and every proven storage value) */
function startProxy() {
  const st = { mode: 'ok', hits: 0, methods: {} };
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    st.hits++;
    try { for (const r of [JSON.parse(b)].flat()) { const k = `${st.mode}:${r.method}`; st.methods[k] = (st.methods[k] || 0) + 1; } } catch {}
    if (st.mode === 'down') { res.writeHead(503); return res.end(); }
    try {
      const up = await fetch(rig.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
      const j = await up.json();
      if (st.mode === 'tamper') for (const x of [j].flat()) if (x?.result?.accountProof) {
        x.result.balance = '0x' + (BigInt(x.result.balance) + 1n).toString(16); st.tampered = (st.tampered || 0) + 1;
        for (const s of x.result.storageProof || []) s.value = '0x' + 'beef'.padStart(40, '1');
      }
      res.end(JSON.stringify(j));
    } catch { res.writeHead(502); res.end(); }
  }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, st, url: `http://127.0.0.1:${srv.address().port}/` })));
}
/** processes executing a binary staged under <stateDir>/runs (the runtime's own children by construction) */
function stagedPids(stateDir) {
  const runs = path.join(stateDir, 'runs') + path.sep, out = [];
  for (const p of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try { const exe = fs.readlinkSync(`/proc/${p}/exe`); if (exe.startsWith(runs)) { const st = fs.readFileSync(`/proc/${p}/stat`, 'utf8'); if (!/\) [ZX] /.test(st)) out.push(Number(p)); } } catch {}
  }
  return out;
}
const alive = (pid) => { try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return !/\) [ZX] /.test(st); } catch { return false; } };
function listening(port) {
  const want = ':' + port.toString(16).toUpperCase().padStart(4, '0');
  return ['/proc/net/tcp', '/proc/net/tcp6'].some((f) => { try { return fs.readFileSync(f, 'utf8').split('\n').slice(1).some((l) => { const x = l.trim().split(/\s+/); return x[3] === '0A' && x[1]?.endsWith(want); }); } catch { return false; } });
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** one runtime process through the test launcher (= the main entry + the stand-in's accepted digest/env) */
function launch(name, { port, untrusted, control = {}, limits, verifierPort } = {}) {
  const dir = path.join(TMP, name), stateDir = path.join(dir, 'state'), controlFile = path.join(dir, 'control.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(controlFile, JSON.stringify(control));
  const config = { format: CONFIG_FORMAT, chain: { chainId: 8453, unsafeSigner: seqSigner },
    binaries: { listener: { path: STANDIN, sha256: sha(STANDIN) }, helios: { path: bin('helios-eeffcc9'), sha256: sha(bin('helios-eeffcc9')) },
      witnessCheck: { path: bin('witness-check'), sha256: sha(bin('witness-check')) } },
    proofSources: { untrusted: untrusted ?? proxies.map((p) => p.url) }, verifier: { port: verifierPort ?? port }, stateDir,
    gossip: { discovery: 'off', sessionSecs: 3600 }, ...(limits ? { limits } : {}) };
  const cfgFile = path.join(dir, 'rpc-runtime.json');
  fs.writeFileSync(cfgFile, JSON.stringify(config, null, 1));
  const child = spawn(process.execPath, [LAUNCHER, cfgFile], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LAUNCH_LISTENER_SHA256: sha(STANDIN),
      LAUNCH_LISTENER_ENV: JSON.stringify({ REAL_LISTENER: bin('enclave-base-head-listener'), FIXTURES_DIR: path.join(HERE, 'fixtures'), RIG_RPC: rig.rpc, FEED_CONTROL: controlFile }) } });
  const events = []; let buf = '', err = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0;) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { events.push(JSON.parse(l)); } catch {} } });
  child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  const exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
  const why = () => { const st = readJson(path.join(stateDir, 'status.json')); return JSON.stringify({ events: events.map((x) => x.event), gossip: st?.gossip?.counters, lastExit: st?.gossip?.lastExit, fanout: st?.fanout, stderr: err.slice(-500) }); };
  const event = (e, ms) => until(() => events.some((x) => x.event === e), ms, `${name}: event ${e} ${why()}`);
  const setControl = (c) => fs.writeFileSync(controlFile, JSON.stringify(c));
  return { child, events, event, exited, stateDir, port: verifierPort ?? port, url: `http://127.0.0.1:${verifierPort ?? port}/`, setControl, stderr: () => err,
    status: () => readJson(path.join(stateDir, 'status.json')), children: () => readJson(path.join(stateDir, 'children.json')) || [] };
}
/** an admin write to the AddressBook (a key no consumer reads): the book's storage, so the state the reads below
 *  prove, changes; a verifier that already holds proofs for an unchanged root would otherwise need no new witness */
let bump = 0;
async function changeState() {
  const rc = await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex(`test-bump-${++bump}`, { size: 32 }), rig.addresses.registry5]);
  await untilHelios(rt, rc.blockNumber + 2n);
}
const heliosHead = async (h) => BigInt(await rpc(h.url, 'eth_blockNumber', [], 5000));
const untilHelios = (h, n, ms = 90000) => until(async () => (await heliosHead(h)) >= BigInt(n), ms, `verifier at block ${n}`);
const waitTx = async (rc) => untilHelios(rt, rc.blockNumber + 2n);

test.before(async () => {
  if (skip) return;
  rig = await startRig();
  assert.notEqual(await rig.rpcCall('eth_getCode', ['0x0000F90827F1C53a10cb7A02335B175320002935', 'latest']), '0x',
    'RIG_RETH_GENESIS must carry the EIP-2935 history contract (test/fixtures/reth-dev-8453-genesis-2935.json)');
  const B = art('EnclaveAddressBook.sol', 'EnclaveAddressBook'); bookAbi = B.abi;
  book = await rig.deploy(B);
  const dep = rig.wc(KEYS.deployer);
  await rig.write(dep, book, bookAbi, 'set', [stringToHex('deployments', { size: 32 }), rig.addresses.ledger]);
  await rig.write(dep, book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry]);
  leaseId = rig.createdId(await rig.create(KEYS.owner));
  proxies = [await startProxy(), await startProxy()];
});
test.after(async () => {
  for (const p of proxies || []) p.srv.close();
  if (rt && rt.child.exitCode === null) { try { process.kill(-rt.child.pid, 'SIGKILL'); } catch {} }
  await rig?.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});
const T = { skip, timeout: 300000 };

test('startup order: no verifier before the first verified head, and none of it needs a witness source', T, async () => {
  for (const p of proxies) p.st.mode = 'down';        // every proof source is down for the whole startup
  rt = launch('main', { port: await freePort(), control: { frozen: true } });
  await rt.event('head-source-started', 60000);
  await sleep(6000);
  assert.ok(!rt.events.some((e) => ['first-head', 'ready'].includes(e.event)), 'no head yet: not ready');
  assert.ok(!rt.children().some((c) => c.role === 'helios'), 'Helios is not started before a verified head');
  assert.equal(listening(rt.port), false, 'nothing listens on the verifier port yet');
  assert.equal(fs.existsSync(path.join(rt.stateDir, 'ready.json')), false);
  rt.setControl({});                                   // heads flow
  await rt.event('ready', 180000);
  const order = rt.events.map((e) => e.event).filter((e) => ['staged', 'head-source-started', 'first-head', 'ready'].includes(e));
  assert.deepEqual(order, ['staged', 'head-source-started', 'first-head', 'ready']);
  const h = rt.children().find((c) => c.role === 'helios');
  assert.ok(h && alive(h.pid), 'Helios is an owned, recorded child');
  assert.ok(fs.readlinkSync(`/proc/${h.pid}/exe`).startsWith(path.join(rt.stateDir, 'runs') + path.sep), 'Helios runs the staged, hashed copy');
  assert.equal(listening(rt.port), true);
  assert.equal(Number(await rpc(rt.url, 'eth_chainId')), 8453);
  const s = rt.status();
  assert.equal(s.phase, 'ready');
  assert.match(s.labels.independence, /NOT provider-independent/);
  assert.equal(s.head.fresh, true);
  assert.ok(s.roots.signedHead >= 1, 'every delivered head is bound in the root store');
  for (const p of proxies) p.st.mode = 'ok';
  reader = new LeaseReader({ authority: 'verifier', verifier: rt.url, addressBook: book, confirmations: 1, maxBlockAgeMs: 60000, deadlineMs: 30000 });
});

test('block-pinned lease snapshot, host admission, catalog moderation and admin AddressBook migration through the composed runtime', T, async () => {
  const [lease] = await reader.refresh([leaseId]);
  assert.ok(lease, 'the deployment was read');
  assert.equal(lease.deployments, rig.addresses.ledger.toLowerCase(), 'resolved through the AddressBook');
  const direct = await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.A.ledger.abi, functionName: 'get', args: [leaseId], blockNumber: BigInt(lease.blockNumber) });
  assert.equal(lease.owner.toLowerCase(), direct.owner.toLowerCase());
  assert.equal(lease.appRef, direct.appRef);
  const block = await rig.rpcCall('eth_getBlockByNumber', [toHex(BigInt(lease.blockNumber)), false]);
  assert.equal(lease.blockHash, block.hash, 'pinned to the exact block hash');
  assert.equal(reader.lastEvidence.stateRoot, block.stateRoot.toLowerCase());
  assert.equal(reader.authorityInfo().providerQuorum, false);

  const own = await rig.deploy(art('EnclaveHostOwnership.sol', 'EnclaveHostOwnership'), [rig.addresses.registry]);
  const ownAbi = art('EnclaveHostOwnership.sol', 'EnclaveHostOwnership').abi;
  await rig.write(rig.wc(KEYS.operator), own, ownAbi, 'proposeOwner', [rig.runner, rig.owner]);
  await waitTx(await rig.write(rig.wc(KEYS.owner), own, ownAbi, 'acceptOwner', [rig.runner]));
  const doc = { version: 1, chainId: 8453, ownershipContract: own.toLowerCase(), hostId: rig.runner, requireCatalogApproval: false, denyDeployments: [leaseId.toLowerCase()], denyAppRefs: [] };
  const admission = createHostAdmission({ hostId: rig.runner, ownershipContract: own.toLowerCase(), registry: rig.addresses.registry.toLowerCase(), catalog: rig.addresses.catalog.toLowerCase(),
    reader, loadPolicy: async () => doc, cacheMs: 0 });
  const request = { deploymentId: leaseId, appRef: `catalog://${rig.appId}/1` };
  assert.equal(await admission.refusal(request), null, 'approved app, default owner policy');
  await waitTx(await rig.write(rig.wc(KEYS.owner), own, ownAbi, 'setPolicy', [rig.runner, hostAdmissionPolicyHash(doc)]));
  assert.equal(await admission.refusal(request), 'this host owner declines this deployment');
  await waitTx(await rig.write(rig.wc(KEYS.owner), own, ownAbi, 'setPolicy', [rig.runner, pad('0x', { size: 32 })]));
  assert.equal(await admission.refusal(request), null);
  await waitTx(await rig.write(rig.wc(KEYS.deployer), rig.addresses.catalog, rig.A.catalog.abi, 'yankVersion', ['hello', 1n]));
  assert.match(await admission.refusal(request), /yanked/);
  await waitTx(await rig.write(rig.wc(KEYS.deployer), rig.addresses.catalog, rig.A.catalog.abi, 'setActive', ['hello', false]));
  assert.match(await admission.refusal(request), /delisted/);

  assert.equal(await reader.bookAddress('registry'), rig.addresses.registry.toLowerCase());
  await assert.rejects(rig.write(rig.wc(KEYS.other), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry5]));
  assert.equal(await reader.bookAddress('registry'), rig.addresses.registry.toLowerCase(), 'an outsider cannot repoint the book');
  await waitTx(await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry5]));
  assert.equal(await reader.bookAddress('registry'), rig.addresses.registry5.toLowerCase(), 'the admin migration is followed');
  await waitTx(await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry]));
});

test('a failing or lying first proof source: the second, correct source serves; the first is charged, never trusted', T, async () => {
  assert.equal(await reader.bookAddress('deployments'), rig.addresses.ledger.toLowerCase());
  await sleep(2500);                                                         // status.json refresh
  const before = rt.status().witnesses.gateway.upstream;
  const label = (p) => Object.keys(before).find((k) => p.url.startsWith(k));
  for (const mode of ['down', 'tamper']) {
    await changeState();                                                     // new state: its witnesses come from the sources
    proxies[0].st.mode = mode;
    try {
      assert.equal(await reader.bookAddress('deployments'), rig.addresses.ledger.toLowerCase(), `first source ${mode}`);
    } finally { proxies[0].st.mode = 'ok'; }
  }
  await sleep(2500);                                                         // status.json refresh
  const after = rt.status().witnesses.gateway.upstream;
  const a = after[label(proxies[0])], b = before[label(proxies[0])];
  const diag = JSON.stringify({ before, after, p0: proxies[0].st.methods, p1: proxies[1].st.methods });
  assert.ok(a.failed > b.failed, 'the down source was charged ' + diag);
  assert.ok(a.invalid > b.invalid, 'the lying source was caught by proof verification ' + diag);
  assert.ok(after[label(proxies[1])].ok > before[label(proxies[1])].ok, 'the correct source answered');
});

test('bad or missing proofs from every source refuse fresh reads; the last verified lease stands; no provider agreement replaces a proof', T, async () => {
  const [lease] = await reader.refresh([leaseId]);
  const before = reader.cache.get(leaseId);
  for (const mode of ['tamper', 'down']) {
    await changeState();
    for (const p of proxies) p.st.mode = mode;
    try {
      let got = null;
      try { got = await reader.refresh([leaseId]); } catch (e) { got = e; }
      assert.ok(got instanceof Error && /no fresh verified chain state/.test(got.message),
        `${mode}: ${JSON.stringify({ got: got instanceof Error ? got.message : 'answered', evidence: reader.lastEvidence, methods: proxies.map((p) => p.st.methods), tampered: proxies.map((p) => p.st.tampered) })}`);
      assert.equal(reader.cache.get(leaseId)?.blockHash, before.blockHash, 'the last verified record stands, unchanged');
      assert.equal(reader.get('0x' + '77'.repeat(32)), null, 'never verified, never admitted');
    } finally { for (const p of proxies) p.st.mode = 'ok'; }
  }
  assert.ok((await reader.refresh([leaseId]))[0], 'recovers once a source is honest again');
});

test('missed heads: a block the gossip source never delivered is bound by authenticated ancestry, never trusted from a source', T, async () => {
  const s0 = rt.status();
  rt.setControl({ deliverEvery: 3 });                    // two of every three heads never reach the runtime
  try {
    const start = await heliosHead(rt);
    await untilHelios(rt, start + 7n, 120000);
    await until(async () => (await heliosHead(rt)) % 3n === 0n, 30000, 'a delivered head');
    const n = (await heliosHead(rt)) - 1n;               // never delivered (n % 3 == 2)
    const blk = await rig.rpcCall('eth_getBlockByNumber', [toHex(n), false]);
    // the runtime's own gateway (what Helios reads): a pinned witness at a never-delivered block
    proxies[0].st.mode = 'tamper';                       // the first source lies about the proof; the second is honest
    const proof = await rpc(s0.internal.gatewayUrl, 'eth_getProof', [book, [], { blockHash: blk.hash }]);
    const real = await rig.rpcCall('eth_getProof', [book, [], toHex(n)]);
    assert.equal(proof.codeHash, real.codeHash);
    assert.deepEqual(proof.accountProof, real.accountProof, 'the verified witness, exactly');
    proxies[0].st.mode = 'ok';
    await sleep(2500);
    const s1 = rt.status();
    assert.ok(s1.roots.ancestor > s0.roots.ancestor, 'its state root came from authenticated ancestry (recomputed header hash = a bound child\'s parent)');
    assert.ok(s1.fanout.offered > s0.fanout.offered && s1.fanout.rootsBound === s1.fanout.offered, 'every delivered head was bound before the relay saw it');
    // the verifier itself, asked for a never-delivered block: Helios proves that block's hash through the EIP-2935
    // history contract at its latest verified head (on Base since Isthmus; on this test chain via the derived genesis
    // test/fixtures/reth-dev-8453-genesis-2935.json - without it this path can only refuse)
    const r = new LeaseReader({ authority: 'verifier', verifier: rt.url, addressBook: book, confirmations: 1, maxBlockAgeMs: 60000, deadlineMs: 30000 });
    assert.equal(await r.bookAddress('deployments'), rig.addresses.ledger.toLowerCase());
    console.log('GAP-READ', JSON.stringify({ block: r.lastEvidence.blockNumber, delivered: BigInt(r.lastEvidence.blockNumber) % 3n === 0n }));
  } finally { proxies[0].st.mode = 'ok'; rt.setControl({}); }
});

test('a stale head refuses fresh authority, the runtime reports degraded, and it recovers when heads return', T, async () => {
  const strict = new LeaseReader({ authority: 'verifier', verifier: rt.url, addressBook: book, confirmations: 1, maxBlockAgeMs: 15000, deadlineMs: 20000 });
  assert.equal(await strict.bookAddress('deployments'), rig.addresses.ledger.toLowerCase());
  rt.setControl({ frozen: true });
  try {
    await sleep(20000);                                   // reth keeps mining; the runtime sees no head
    await assert.rejects(strict.bookAddress('deployments'), /stale chain block/);
    await until(() => rt.status()?.phase === 'degraded' || rt.status()?.head.fresh === false, 70000, 'degraded status');
  } finally { rt.setControl({}); }
  await until(() => rt.status()?.phase === 'ready', 60000, 'ready again');
  const again = new LeaseReader({ authority: 'verifier', verifier: rt.url, addressBook: book, confirmations: 1, maxBlockAgeMs: 15000, deadlineMs: 20000 });
  assert.equal(await again.bookAddress('deployments'), rig.addresses.ledger.toLowerCase());
});

test('whole-operation deadline through the composed runtime: a never-settling callback and a stopped verifier are both bounded', T, async () => {
  const quick = new LeaseReader({ authority: 'verifier', verifier: rt.url, addressBook: book, confirmations: 1, maxBlockAgeMs: 60000, deadlineMs: 1500 });
  let t0 = Date.now();
  await assert.rejects(quick.agreed(() => new Promise(() => {})), /deadline/);
  assert.ok(Date.now() - t0 < 4000, `bounded (${Date.now() - t0} ms)`);
  const h = rt.children().find((c) => c.role === 'helios');
  process.kill(h.pid, 'SIGSTOP');
  try {
    t0 = Date.now();
    await assert.rejects(quick.bookAddress('deployments'), /no fresh verified chain state/);
    assert.ok(Date.now() - t0 < 4000, `a hung verifier is bounded (${Date.now() - t0} ms)`);
  } finally { process.kill(h.pid, 'SIGCONT'); }
  assert.equal(await reader.bookAddress('deployments'), rig.addresses.ledger.toLowerCase(), 'serves again once the verifier answers');
});

test('crash: a SIGKILLed runtime leaves Helios orphaned; the next start reaps it and is ready on the same port', T, async () => {
  const old = rt.children();
  const h = old.find((c) => c.role === 'helios'), l = old.find((c) => c.role === 'listener');
  process.kill(rt.child.pid, 'SIGKILL');
  await rt.exited;
  assert.ok(alive(h.pid), 'Helios survived its parent (own process group): an orphan the next start must reap');
  assert.ok(fs.existsSync(path.join(rt.stateDir, 'runtime.lock')), 'the crashed run left its lock (taken over: its owner is gone)');
  rt = relaunchSame(rt);                                 // the same config and stateDir, a new process
  await rt.event('ready', 180000);
  assert.equal(alive(h.pid), false, 'the orphaned Helios was reaped');
  if (l) assert.equal(alive(l.pid), false, 'the orphaned listener is gone');
  assert.ok(rt.status().reaped.recorded + rt.status().reaped.staged >= 1);
  assert.equal(stagedPids(rt.stateDir).filter((p) => p === h.pid).length, 0);
  assert.equal(Number(await rpc(rt.url, 'eth_chainId')), 8453);
});

function relaunchSame(prev) {
  const dir = path.dirname(prev.stateDir), cfgFile = path.join(dir, 'rpc-runtime.json'), controlFile = path.join(dir, 'control.json');
  fs.writeFileSync(controlFile, '{}');
  const child = spawn(process.execPath, [LAUNCHER, cfgFile], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LAUNCH_LISTENER_SHA256: sha(STANDIN),
      LAUNCH_LISTENER_ENV: JSON.stringify({ REAL_LISTENER: bin('enclave-base-head-listener'), FIXTURES_DIR: path.join(HERE, 'fixtures'), RIG_RPC: rig.rpc, FEED_CONTROL: controlFile }) } });
  const events = []; let buf = '', err = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0;) { const x = buf.slice(0, i); buf = buf.slice(i + 1); try { events.push(JSON.parse(x)); } catch {} } });
  child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  const exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
  return { ...prev, child, events, exited, stderr: () => err,
    event: (e, ms) => until(() => events.some((x) => x.event === e), ms, `relaunch: event ${e} (events ${JSON.stringify(events.map((x) => x.event))}, stderr ${err.slice(-500)})`) };
}

test('shutdown: SIGTERM stops everything in order; no child, port, lock or state file is left', T, async () => {
  const kids = rt.children();
  assert.ok(kids.length >= 2);
  process.kill(rt.child.pid, 'SIGTERM');
  const { code } = await rt.exited;
  assert.equal(code, 0);
  assert.ok(rt.events.some((e) => e.event === 'stopped'));
  for (const k of kids) assert.equal(alive(k.pid), false, `${k.role} reaped`);
  assert.deepEqual(stagedPids(rt.stateDir), []);
  assert.equal(listening(rt.port), false, 'the verifier port is released');
  for (const f of ['runtime.lock', 'ready.json', 'status.json', 'children.json']) assert.equal(fs.existsSync(path.join(rt.stateDir, f)), false, f);
  assert.deepEqual(fs.readdirSync(path.join(rt.stateDir, 'runs')), [], 'the run directory is removed');
  assert.deepEqual(fs.readdirSync(path.join(rt.stateDir, 'gossip', 'sessions')), [], 'listener sessions are removed');
});

test('a failed startup cleans up: no fresh head in time, and a verifier port taken by another process', T, async () => {
  const a = launch('no-head', { port: await freePort(), control: { frozen: true }, limits: { firstHeadTimeoutMs: 5000, heliosReadyTimeoutMs: 60000 } });
  assert.equal((await a.exited).code, 1);
  assert.ok(a.events.some((e) => e.event === 'startup-failed' && /no fresh verified head/.test(e.reason)), JSON.stringify(a.events));
  await sleep(500);
  assert.deepEqual(stagedPids(a.stateDir), []);
  assert.equal(fs.existsSync(path.join(a.stateDir, 'runtime.lock')), false);
  assert.deepEqual(fs.readdirSync(path.join(a.stateDir, 'runs')), []);
  assert.equal(listening(a.port), false);

  const squat = net.createServer(); const port = await freePort();
  await new Promise((r) => squat.listen(port, '127.0.0.1', r));
  try {
    const b = launch('port-taken', { port });
    assert.equal((await b.exited).code, 1);
    assert.ok(b.events.some((e) => e.event === 'startup-failed' && /already in use|held by another process/.test(e.reason)), JSON.stringify(b.events));
    await sleep(500);
    assert.deepEqual(stagedPids(b.stateDir), [], 'no Helios or listener left behind');
    assert.equal(fs.existsSync(path.join(b.stateDir, 'runtime.lock')), false);
  } finally { squat.close(); }
});
