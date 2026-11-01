// Actual reviewed schema3/registry contracts on isolated Anvil. The injected
// verifier/finality are TEST capabilities; Anvil is NOT a Base proof verifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useAnvil, S, rpc, warp, mine, step, tx, HOST, ZERO32, chainNow } from './fixtures/lifecycle-evm-base.mjs';
import { worldHR, RA, ownerOffline } from './fixtures/lifecycle-registry-evm.mjs';
import { L3 } from './fixtures/lifecycle-schema3-evm.mjs';
import { ownLifecycleJournal } from '../network/deployment-journal-owner.mjs';
import { createLifecycleCurrentDenialReader } from '../network/lifecycle-current-denial.mjs';
import { validateLifecycleAuthorityWindow } from '../network/deployment-authority-window.mjs';
import { createSnapshotHostAdmission } from '../network/lifecycle-host-authority.mjs';
useAnvil();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t) {
  const w = await worldHR(); await step(w, 'queued', 'TEST queue');
  await tx(w.human, w.contracts.lifecycle, L3.LIFECYCLE, 'setAuthorityPolicy', [w.id, 1800]); await mine();
  w.auth.pin = await S.pub.getBlockNumber();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-denial-')), file = path.join(dir, 'journal.json');
  const owner = await ownLifecycleJournal(file, { initialize: true });
  t.after(async () => { await owner.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const options = { pins: w.pins, verifier: { request: (m, p) => rpc(m, p) }, headers: w.receipts,
    hostPolicy: { load: async () => { throw Error('TEST: zero policy hash has no external document'); } }, journalOwner: owner, now: chainNow };
  let input;
  const capture = w.adapter({ generation: { head: { read: async x => { input = x; return {}; } }, certificates: { read: async () => [] } } });
  await capture.read(w.id);
  return { w, owner, options, input, file };
}

test('current reader authenticates ancestry to a fresh head while preserving an older owner-opted finalized baseline', async t => {
  const r = await setup(t); await warp(60);
  const reader = createLifecycleCurrentDenialReader(r.options);
  const a = r.w.adapter({ generation: { head: reader, certificates: { read: async () => [] } } });
  const s = await a.read(r.w.id), g = s.generationAuthority;
  assert.equal(g.head.denied, false); assert.equal(g.head.tier, 'unsafe');
  assert.equal(g.head.currentHostAuthority.status, 'online'); assert.equal(g.head.currentHostAuthority.proofVerified, true);
  assert.equal(g.head.currentHostAuthority.blockHash, g.head.hash);
  assert.equal(g.head.currentHostAuthority.context.digest, s.hostAuthorityEvidence.context.digest);
  assert(g.head.timestamp - g.anchor.timestamp >= 60); assert.equal(s.blockAt, g.anchor.timestamp * 1000);
  assert(validateLifecycleAuthorityWindow({ ...g, nowSec: Math.floor(chainNow() / 1000) }).validUntil > chainNow() / 1000);
  // This delivery deliberately does not silently enable host admission. The
  // final-send/admission/permit integration is a separate required boundary.
  const admission = createSnapshotHostAdmission({ hostId: HOST, profile: r.w.pins.profile, now: chainNow });
  await assert.rejects(admission.decision(r.w.id, s), /snapshot expired/);
  assert.equal(typeof reader.submit, 'undefined');
});

test('actual owner Offline at current head denies a previously Online finalized host', async t => {
  const r = await setup(t), reader = createLifecycleCurrentDenialReader(r.options);
  await ownerOffline(r.w); await mine();
  const head = await reader.read(r.input);
  assert.equal(head.denied, true); assert.equal(head.currentHostAuthority.status, 'offline');
  assert.throws(() => validateLifecycleAuthorityWindow({ anchor: r.input.anchor, policy: r.input.baseline.policy,
    head, nowSec: Math.floor(chainNow() / 1000) }), { code: 'LIFECYCLE_DENIED' });
  assert.equal(r.input.baseline.hostAuthorityEvidence.status, 'online');
});

test('actual current reporter-policy change and uncertified app generation cannot grant authority', async t => {
  const r = await setup(t), reader = createLifecycleCurrentDenialReader(r.options);
  await tx(r.w.hostOwner, r.w.contracts.registry, RA, 'setHostPolicy', [HOST, r.w.policy(r.w.reporters2), ZERO32]); await mine();
  const head = await reader.read(r.input);
  assert.equal(head.denied, true); assert.notEqual(head.currentHostAuthority.context.digest, r.input.baseline.hostAuthorityEvidence.context.digest);
  // A separate up-to-date fixture adapter can submit, but that TEST transaction
  // does not make an older baseline authorize its new generation.
  r.w.auth.pin = null; await step(r.w, 'running', 'TEST uncertified start'); await mine();
  const moved = await reader.read(r.input);
  assert(moved.reasons.includes('uncertified current generation'));
});

test('malformed ancestry, over-bound range and substituted baseline all refuse before publication', async t => {
  const r = await setup(t); await warp(4); await mine();
  const corrupt = createLifecycleCurrentDenialReader({ ...r.options, headers: { header: async n => ({ ...await r.w.receipts.header(n), parentHash: ZERO32 }) } });
  await assert.rejects(corrupt.read(r.input), /claimed hash|parent|anchor/);
  const bounded = createLifecycleCurrentDenialReader({ ...r.options, maxHeaders: 1 });
  await assert.rejects(bounded.read(r.input), /ancestry outside/);
  const clean = createLifecycleCurrentDenialReader(r.options);
  const changed = structuredClone(r.input); changed.anchor.hash = ZERO32;
  await assert.rejects(clean.read(changed), /exact finalized/);
  const head = await clean.read(r.input); assert.equal(head.denied, false);
});

test('current-head-only adapter never qualifies positive authority even with a forged finalized tier', async t => {
  const r = await setup(t), a = r.w.adapter({ kind: 'verified-head' });
  const s = await a.read(r.w.id);
  assert.equal(s.verified, false); assert.equal(s.proofVerified, false); assert.equal(s.authorityTier, 'unsafe');
  assert.equal(s.hostAuthorityEvidence.proofVerified, false);
  await assert.rejects(a.prepare(r.w.id, s, 'running', 'TEST forbidden'), /verified snapshot/);
});

test('unavailable current policy document is unknown, not a durable authenticated denial', async t => {
  const r = await setup(t), reader = createLifecycleCurrentDenialReader(r.options);
  await tx(r.w.hostOwner, r.w.contracts.registry, RA, 'setHostPolicy', [HOST, r.w.policy(r.w.reporters), '0x' + 'ab'.repeat(32)]);
  await mine();
  await assert.rejects(reader.read(r.input), /current host policy unknown; no denial decision/);
});

test('timeout retains the one-operation slot and real journal lock until cancellation-ignoring transport drains', async t => {
  const r = await setup(t);
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const reader = createLifecycleCurrentDenialReader({ ...r.options, deadlineMs: 25,
    verifier: { request: async () => { entered(); await held; return '0x2105'; } } });
  const call = reader.read(r.input); const rejected = assert.rejects(call, /deadline/); await enteredPromise; await rejected;
  await assert.rejects(reader.read(r.input), /busy/);
  let closed = false; const close = r.owner.close().then(() => { closed = true; });
  try {
    await sleep(20); assert.equal(closed, false);
    await assert.rejects(ownLifecycleJournal(r.file), /stateDir is in use by a running runtime/);
  } finally { release(); await close; }
  assert.equal(closed, true);
  await assert.rejects(reader.read(r.input), /closed/);
  const next = await ownLifecycleJournal(r.file); await next.close();
});
