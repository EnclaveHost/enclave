// network/gossip-head-source.mjs: native listener child -> verified Helios SequencerCommitment -> op-head-relay.
// Offline only (the job runs inside `unshare -r -n`; asserted below). Uses the REAL pinned listener binary (f3159ea,
// commitment mode, sha256 ebd045b4...) for every native commitment call and for the lifecycle test, REAL captured Base mainnet objects, and a
// scripted stand-in only to replay records and simulate process behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createGossipHeadSource, signalOwned, procIdentity, TESTED_LISTENER_SHA256 } from '../network/gossip-head-source.mjs';
import { createHeadRelay, payloadHead, BASE_MAINNET } from '../network/op-head-relay.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const REAL = path.join(ROOT, 'artifacts', 'enclave-base-head-listener');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-listener.mjs');
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const head = (n) => JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', `base-mainnet-${n}.head.json`), 'utf8'));
const SIGNER = BASE_MAINNET.unsafeSigner;
const T76 = head(52965076).timestamp;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let currentStatus = null;   // set per test so a timeout reports the adapter's counters
async function waitFor(pred, ms = 20000) {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting; status=' + JSON.stringify(currentStatus?.()?.counters ?? null) + ' lastExit=' + JSON.stringify(currentStatus?.()?.lastExit ?? null));
    await sleep(50);
  }
}

function harness({ plan = {}, nowMs = T76 * 1000 + 1000, listener = FAKE, signer = SIGNER, opts = {}, onCommitment, afterDeliver } = {}) {
  const clock = { t: nowMs };
  const now = () => clock.t;
  const relay = createHeadRelay({ chainId: 8453, signer: SIGNER, maxAgeMs: 60000, now });
  const delivered = [];
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'ghs-test-'));
  const src = createGossipHeadSource({
    listenerPath: listener, listenerSha256: sha(listener), chainId: 8453, signer, workDir, now, sessionSecs: 60, discovery: 'off',
    onCommitment: onCommitment || (async (c, meta) => { delivered.push(meta); await relay.offer(c, 'native-gossip'); afterDeliver?.(clock); }),
    extraEnv: { REAL_LISTENER: REAL, FAKE_PLAN: JSON.stringify(plan) }, ...opts });
  currentStatus = () => src.status();
  return { src, relay, delivered, clock, workDir, cleanup: async () => { await src.stop(); rmSync(workDir, { recursive: true, force: true }); } };
}
const all = (fixture, extra = {}) => ({ fixture, ...extra });
/** The real binary's commitment for an unmodified captured object (reference output, maintained decoding). */
function nativeCommitment(n) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ghs-ref-'));
  try {
    const file = path.join(dir, 'o.v4.snappy');
    writeFileSync(file, Buffer.from(readFileSync(path.join(ROOT, 'test', 'fixtures', `base-mainnet-${n}.v4.snappy.hex`), 'utf8').trim(), 'hex'));
    return JSON.parse(execFileSync(REAL, ['commitment', '--signer', SIGNER, '--file', file], { encoding: 'utf8' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const objectsDir = (h) => { const s = readdirSync(path.join(h.workDir, 'sessions'))[0]; return s ? path.join(h.workDir, 'sessions', s, 'out', 'objects') : null; };

test('offline guard: no network route exists in this test namespace', () => {
  const routes = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
  assert.equal(routes.length, 0, 'run these tests inside `unshare -r -n`; they must never reach live peers');
});

test('the real listener binary is the tested pinned build', () => {
  assert.equal(sha(REAL), TESTED_LISTENER_SHA256);
});

test('real Base heads: native commitment mode + reviewed verifyCommitment -> relay serves the newest, labelled unsafe', async () => {
  const h = harness({ plan: { heads: [all(52965074), all(52965075), all(52965076)] } });
  try {
    await h.src.start();
    await waitFor(() => h.delivered.length === 3);
    assert.deepEqual(h.delivered.map((m) => m.number), [52965074, 52965075, 52965076]);
    for (const m of h.delivered) assert.deepEqual([m.tier, m.finality, m.source, m.chainId, m.signer], ['unsafe', 'none', 'native-gossip', 8453, SIGNER]);
    const served = h.relay.latest();
    assert.ok(served, 'relay serves a commitment');
    const ph = payloadHead(served.data);
    assert.equal(ph.number, 52965076n);
    assert.equal(ph.hash, head(52965076).hash);
    assert.equal(ph.stateRoot, head(52965076).stateRoot);
    const st = h.src.status();
    assert.equal(st.fresh, true);
    assert.equal(st.head.number, 52965076);
    assert.deepEqual([st.tier, st.finality, st.trust], ['unsafe', 'none', 'op-sequencer-signed-unsafe-head']);
    assert.deepEqual(st.counters.rejected, {});
    const fs = await import('node:fs');
    const sdir = fs.readdirSync(path.join(h.workDir, 'sessions'))[0];
    await waitFor(() => fs.readdirSync(path.join(h.workDir, 'sessions', sdir, 'out', 'objects')).length === 0, 5000);
  } finally { await h.cleanup(); }
});

test('stale heads are refused and the relay serves nothing', async () => {
  const h = harness({ plan: { heads: [all(52965076)] }, nowMs: (T76 + 120) * 1000 });
  try {
    await h.src.start();
    await waitFor(() => (h.src.status().counters.rejected.stale || 0) === 1);
    assert.equal(h.delivered.length, 0);
    assert.equal(h.relay.latest(), null);
    assert.equal(h.src.status().fresh, false);
  } finally { await h.cleanup(); }
});

test('a head delivered fresh goes stale with the clock; status and relay fail closed', async () => {
  const h = harness({ plan: { heads: [all(52965076)] } });
  try {
    await h.src.start();
    await waitFor(() => h.delivered.length === 1);
    assert.equal(h.src.status().fresh, true);
    h.clock.t += 61_000;
    assert.equal(h.src.status().fresh, false);
    assert.equal(h.src.status().head, null);
    assert.equal(h.relay.latest(), null);
  } finally { await h.cleanup(); }
});

for (const [name, start] of [
  ['wrong signer', { signer: '0x' + '42'.repeat(20) }],
  ['wrong chain', { chainId: 84532 }],
  ['not an admin pin', { signerSource: 'chain-default' }],
  ['other base/base source', { baseSourceCommit: '0'.repeat(40) }],
  ['other schema', { schema: 'enclave-base-unsafe-head/v2' }],
]) {
  test(`start record with ${name} ends the session before any head is used`, async () => {
    const h = harness({ plan: { start, heads: [all(52965076)] } });
    try {
      await h.src.start();
      await waitFor(() => h.src.status().lastExit?.reason === 'start-mismatch');
      assert.equal(h.delivered.length, 0);
      assert.equal(h.relay.latest(), null);
    } finally { await h.cleanup(); }
  });
}

test('head records that disagree with the pins or this session are rejected individually', async () => {
  const bad = [
    all(52965076, { record: { signer: '0x' + '42'.repeat(20) } }),
    all(52965076, { record: { chainId: 84532 } }),
    all(52965076, { record: { tier: 'safe' } }),
    all(52965076, { record: { finality: 'finalized' } }),
    all(52965076, { record: { payloadVersion: 'v3' } }),
    all(52965076, { record: { receivedUnixMs: 1 } }),            // stamped before this session: replay from an old run
    all(52965076, { record: { objectBytes: 64 * 1024 * 1024 } }), // over the object cap: never read
    all(52965076, { record: { stateRoot: '0x' + '00'.repeat(32) } }),
  ];
  const h = harness({ plan: { heads: bad } });
  try {
    await h.src.start();
    await waitFor(() => Object.values(h.src.status().counters.rejected).reduce((a, b) => a + b, 0) === bad.length);
    assert.deepEqual(h.src.status().counters.rejected,
      { signer: 1, chain: 1, tier: 2, version: 1, 'not-this-session': 1, 'object-too-large': 1, 'native-mismatch': 1 });
    assert.equal(h.delivered.length, 0);
  } finally { await h.cleanup(); }
});

test('corrupt, truncated, missing and mis-sized objects are refused (the real native mode refuses tampered bytes)', async () => {
  const plan = { heads: [
    all(52965076, { mutate: 'flip', flipAt: 10 }),   // inside the literal holding the signature's r value
    all(52965076, { mutate: 'truncate' }),
    all(52965076, { mutate: 'missing' }),
    all(52965075, { record: { objectBytes: 12345 } }),
    all(52965075, { record: { objectSha256: 'ab'.repeat(32) } }),
  ] };
  const h = harness({ plan });
  try {
    await h.src.start();
    await waitFor(() => Object.values(h.src.status().counters.rejected).reduce((a, b) => a + b, 0) === 5);
    const r = h.src.status().counters.rejected;
    assert.equal(r['native-refused'], 2, JSON.stringify(r));
    assert.equal(r['object-missing'], 2, JSON.stringify(r));   // missing file; wrong digest names a file that does not exist
    assert.equal(r['object-size'], 1, JSON.stringify(r));
    assert.equal(h.delivered.length, 0);
  } finally { await h.cleanup(); }
});

test('a different compression of the identical signed block is accepted as that same block (content, not encoding, is authenticated)', async () => {
  // Found by run r3: flipping the middle byte of the 52965076 object changes the snappy encoding but not the decoded
  // envelope. The native verifier and signature recovery both bind to decoded bytes, so this is the genuine block;
  // the compressed object's sha256 is therefore NOT a unique block identifier (archive by block hash instead).
  const h = harness({ plan: { heads: [all(52965076, { mutate: 'flip' })] } });
  try {
    await h.src.start();
    await waitFor(() => h.delivered.length + Object.keys(h.src.status().counters.rejected).length >= 1);
    const original = nativeCommitment(52965076);
    // deterministic for this fixed fixture: the middle flip decodes to the identical envelope
    assert.equal(h.delivered.length, 1);
    assert.deepEqual(h.src.status().counters.rejected, {});
    assert.equal(h.delivered[0].hash, head(52965076).hash);
    assert.equal(h.relay.latest().data, original.commitment.data);
    assert.notEqual(h.delivered[0].objectSha256, head(52965076).objectSha256);
  } finally { await h.cleanup(); }
});

test('a genuine Base object is refused when the adapter is pinned to a different signer', async () => {
  const other = '0x' + '42'.repeat(20);
  // start record and head record both name the pin, so the refusal can only come from the native signature check
  const h = harness({ signer: other, plan: { heads: [all(52965076, { record: { signer: other } })] } });
  try {
    await h.src.start();
    await waitFor(() => (h.src.status().counters.rejected['native-refused'] || 0) === 1);
    assert.equal(h.delivered.length, 0);
  } finally { await h.cleanup(); }
});

test('restart: later sessions replaying the same signed block cannot make it fresh again', async () => {
  // Session 1 delivers block 52965076, then the clock moves past maxHeadAgeMs. Every later session (listener exits after
  // each replay) offers the identical genuine block; freshness is judged from its signed timestamp, so all are refused.
  const h = harness({ plan: { heads: [all(52965076)], after: 'exit0' }, afterDeliver: (clock) => { clock.t += 61_000; } });
  try {
    await h.src.start();
    await waitFor(() => h.src.status().counters.sessions >= 3, 20000);
    assert.equal(h.delivered.length, 1);
    assert.ok((h.src.status().counters.rejected.stale || 0) >= 1);
    assert.equal(h.src.status().fresh, false);
    assert.equal(h.relay.latest(), null);
    assert.equal(h.src.status().lastExit.reason, 'listener-exit');
  } finally { await h.cleanup(); }
});

test('process death (SIGKILL) is recorded and the listener is restarted with backoff', async () => {
  const h = harness({ plan: { heads: [all(52965076)], after: 'kill9' } });
  try {
    await h.src.start();
    await waitFor(() => h.src.status().lastExit?.exit?.signal === 'SIGKILL');
    await waitFor(() => h.src.status().counters.sessions >= 2);
    assert.ok(h.delivered.length >= 1, 'the head printed before the kill was still processed');
  } finally { await h.cleanup(); }
});

test('stop() terminates the owned process group, including a grandchild, and nothing else', async () => {
  const h = harness({ plan: { heads: [all(52965076)], after: 'grandchild' } });
  try {
    await h.src.start();
    const leader = h.src.status().session.pid;
    const sessionDir = (await import('node:fs')).readdirSync(path.join(h.workDir, 'sessions'))[0];
    const pidFile = path.join(h.workDir, 'sessions', sessionDir, 'grandchild.pid');
    await waitFor(() => existsSync(pidFile));
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(procIdentity(leader) && procIdentity(grandchild));
    assert.equal(procIdentity(grandchild).pgid, leader);
    await h.src.stop();
    await waitFor(() => !procIdentity(leader) && !procIdentity(grandchild), 10000);
    assert.equal(procIdentity(process.pid).pgid !== leader, true);
    assert.equal(existsSync(path.join(h.workDir, 'sessions', sessionDir)), false, 'session dir removed');
  } finally { await h.cleanup(); }
});

test('signalOwned never signals a process whose identity does not match', async () => {
  const me = procIdentity(process.pid);
  // right pid, wrong start time and a process group nobody has: nothing may be signalled
  assert.deepEqual(await signalOwned({ pid: process.pid, pgid: 2 ** 22 + 9, startTime: String(BigInt(me.startTime) + 1n) }, 0), []);
  assert.deepEqual(await signalOwned({ pid: 2 ** 22 + 7, pgid: 2 ** 22 + 7, startTime: '1' }, 'SIGTERM'), []);
});

test('an over-long stdout line ends the session (bounded buffers)', async () => {
  const h = harness({ plan: { after: 'longline' } });
  try {
    await h.src.start();
    await waitFor(() => h.src.status().lastExit?.reason === 'line-too-long');
  } finally { await h.cleanup(); }
});

test('a silent listener is restarted after restartIfNoHeadMs (stale stream)', async () => {
  const h = harness({ plan: {}, opts: { restartIfNoHeadMs: 5000 } });
  try {
    await h.src.start();
    await waitFor(() => h.src.status().session?.started === true);
    h.clock.t += 6000;
    await waitFor(() => h.src.status().lastExit?.reason === 'no-head-timeout', 5000);
    await waitFor(() => h.src.status().counters.sessions >= 2, 10000);
  } finally { await h.cleanup(); }
});

test('a binary that does not match the pinned digest is never started', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'ghs-test-'));
  const src = createGossipHeadSource({ listenerPath: REAL, listenerSha256: '00'.repeat(32), chainId: 8453, signer: SIGNER, workDir,
    onCommitment: () => {}, discovery: 'off' });
  try {
    await assert.rejects(src.start(), /does not match the pin/);
    assert.equal(src.status().running, false);
    assert.equal(src.status().counters.sessions, 0);
  } finally { await src.stop(); rmSync(workDir, { recursive: true, force: true }); }
});

test('a stuck downstream archive never delays serving fresh heads', async () => {
  let archiveCalls = 0;
  const h = harness({ plan: { heads: [all(52965074), all(52965075), all(52965076)] },
    opts: { onArchive: () => { archiveCalls++; return new Promise(() => {}); } } });
  try {
    await h.src.start();
    await waitFor(() => h.delivered.length === 3);
    assert.equal(archiveCalls, 1, 'archive is serial and the first call never resolves');
    assert.equal(payloadHead(h.relay.latest().data).number, 52965076n);
  } finally { await h.cleanup(); }
});

test('a forged native result is caught by the relay verifier recovering the exact signed bytes', async () => {
  const h = harness({ plan: { forge: true, heads: [all(52965076)] } });
  try {
    await h.src.start();
    await waitFor(() => (h.src.status().counters.rejected['commitment-signature'] || 0) === 1);
    assert.equal(h.delivered.length, 0);
    assert.equal(h.relay.latest(), null);
  } finally { await h.cleanup(); }
});

test('a commitment larger than maxDataBytes is refused natively (bounded output)', async () => {
  const h = harness({ plan: { heads: [all(52965074)] }, opts: { maxDataBytes: 1024 } });
  try {
    await h.src.start();
    await waitFor(() => (h.src.status().counters.rejected['native-refused'] || 0) === 1);
    assert.equal(h.delivered.length, 0);
  } finally { await h.cleanup(); }
});

test('objects of records dropped before processing are deleted (pre-start head, queue overflow)', async () => {
  const pre = harness({ plan: { noStart: true, heads: [all(52965076)] } });
  try {
    await pre.src.start();
    await waitFor(() => (pre.src.status().counters.rejected['head-before-start'] || 0) === 1);
    await waitFor(() => readdirSync(objectsDir(pre)).length === 0, 5000);
  } finally { await pre.cleanup(); }
  const heads = Array.from({ length: 40 }, () => all(52965074));
  const flood = harness({ plan: { heads } });
  try {
    await flood.src.start();
    const st = () => flood.src.status().counters;
    await waitFor(() => { const c = st(); return c.queueDropped + c.delivered + Object.values(c.rejected).reduce((a, b) => a + b, 0) >= 40; }, 30000);
    assert.ok(st().queueDropped >= 1, JSON.stringify(st()));
    await waitFor(() => readdirSync(objectsDir(flood)).length === 0, 5000);
  } finally { await flood.cleanup(); }
});

test('session dirs left by a crashed earlier run are removed at start; foreign dirs are left alone', async () => {
  const h = harness({ plan: {} });
  const sessions = path.join(h.workDir, 'sessions');
  mkdirSync(path.join(sessions, 's7-aaaaaaaaaaaa', 'out', 'objects'), { recursive: true });
  writeFileSync(path.join(sessions, 's7-aaaaaaaaaaaa', 'OWNER'), 'gossip-head-source pid=1\n');
  writeFileSync(path.join(sessions, 's7-aaaaaaaaaaaa', 'out', 'objects', 'x.v4.snappy'), Buffer.alloc(4096));
  mkdirSync(path.join(sessions, 'foreign'), { recursive: true });
  try {
    await h.src.start();
    assert.equal(existsSync(path.join(sessions, 's7-aaaaaaaaaaaa')), false);
    assert.equal(existsSync(path.join(sessions, 'foreign')), true);
    assert.equal(h.src.status().counters.staleSessionDirsRemoved, 1);
  } finally { await h.cleanup(); }
});

test('a hung archive sink is bounded: calls time out, at most 2 stay outstanding, the rest are dropped', async () => {
  let calls = 0;
  const h = harness({ plan: { heads: [all(52965074), all(52965075), all(52965076)] },
    opts: { archiveTimeoutMs: 50, onArchive: () => { calls++; return new Promise(() => {}); } } });
  try {
    await h.src.start();
    await waitFor(() => h.delivered.length === 3);
    await waitFor(() => { const c = h.src.status().counters; return c.archiveTimedOut + c.archiveDropped >= 3 || (c.archiveTimedOut === 2 && c.archiveDropped === 1); });
    const c = h.src.status().counters;
    assert.ok(calls <= 2, `calls ${calls}`);
    assert.equal(calls + c.archiveDropped, 3);
    assert.equal(payloadHead(h.relay.latest().data).number, 52965076n);
  } finally { await h.cleanup(); }
});

test('real listener lifecycle offline: start record accepted, no heads, exit 3 recorded, restart scheduled', async () => {
  const h = harness({ listener: REAL, nowMs: undefined, opts: { sessionSecs: 2, now: Date.now } });
  try {
    await h.src.start();
    await waitFor(() => h.src.status().session?.started === true, 10000);
    await waitFor(() => h.src.status().lastExit?.exit?.code === 3, 15000);
    const st = h.src.status();
    assert.equal(st.lastExit.reason, 'listener-exit');
    assert.equal(st.counters.delivered, 0);
    assert.equal(st.fresh, false);
    assert.ok(st.counters.restarts >= 1);
  } finally { await h.cleanup(); }
});
