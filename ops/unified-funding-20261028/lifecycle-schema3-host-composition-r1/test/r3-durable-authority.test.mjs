// r3 durable host authority: the GENERATED owned lifecycle journal (baseline journal + insertions, on disk, reopened),
// the real dispatch/runner, and the generated host's real setHostingCaps/enforceOff/consider. Chain/runtime/admission
// are MOCKS. Not evidence of production key custody, session authority or chain state.
import { JOURNAL_CANDIDATE_URL, BASE_NETWORK, DISPATCH_URL, CANDIDATE_HOST_URL } from './helpers/baseline.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, route, H, INDEP } from './helpers/lifecycle-fixture.mjs';
const { openLifecycleJournal } = await import(JOURNAL_CANDIDATE_URL);
// the UNPATCHED baseline journal (the query only bypasses this suite's redirect; same file, same relative imports)
const baseline = await import(new URL('deployment-lifecycle-journal.mjs?baseline', BASE_NETWORK).href);
const D = await import(DISPATCH_URL);

const HOST = H('99'), A = H('aa');
const settle = () => new Promise((r) => setImmediate(r));
function tmpFile(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-journal-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'journal.json'); }

test('owned journal: an older journal opens unchanged; floors are monotonic; holds release only after a later owner change', (t) => {
  const file = tmpFile(t);
  const old = { version: 1, deployments: [], authorityAnchors: {} };
  fs.writeFileSync(file, JSON.stringify(old));
  let j = openLifecycleJournal(file);
  assert.equal(j.readHostAuthority(HOST), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), old, 'opening never rewrites or clears an older journal');
  j.acceptHostAuthority(HOST, { revision: '2', owner: INDEP, policyHash: H('55') });
  j = openLifecycleJournal(file);
  assert.equal(j.readHostAuthority(HOST).floor.revision, '2');
  assert.throws(() => j.acceptHostAuthority(HOST, { revision: '1', owner: INDEP, policyHash: H('55') }), /rollback/);
  assert.throws(() => j.acceptHostAuthority(HOST, { revision: '2', owner: '0x' + '2d'.repeat(20), policyHash: H('55') }), /equivocation/);
  assert.throws(() => j.acceptHostAuthority(HOST, { revision: 3, owner: INDEP, policyHash: H('55') }), /invalid host authority/);
  assert.equal(j.acceptHostAuthority(HOST, { revision: '3', owner: INDEP, policyHash: H('56') }).revision, '3');
  j.holdHostLocal(HOST, A, { why: 'the owner of this box turned hosting off', at: 1 });
  assert.throws(() => j.releaseHostLocal(HOST, A), /later owner control change/);
  assert.equal(j.advanceOwnerControls(HOST), 1);
  j = openLifecycleJournal(file);
  assert.equal(j.readHostAuthority(HOST).holds[A].ownerEpoch, 0, 'the hold survives a reopen');
  j.releaseHostLocal(HOST, A);
  assert.deepEqual(openLifecycleJournal(file).readHostAuthority(HOST).holds, {});
  // the baseline journal ignores and PRESERVES the section across its own writes
  const b = baseline.openLifecycleJournal(file);
  b.observeAssignment(A, 1, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hostAuthority[HOST].floor.revision, '3');
  // a malformed section closes the journal (never replaced by an empty state)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.hostAuthority[HOST].floor.revision = '-1'; fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => openLifecycleJournal(file).read(A), /unreadable/);
});

test('restart: the persisted floor refuses a lower still-fresh host revision', async (t) => {
  const file = tmpFile(t), f = fixture({ hostId: HOST });
  const boot = async () => { const d = D.createLifecycleDispatch(f.parts([route(A)], { journal: openLifecycleJournal(file) }));
    d.attach(f.hostView(HOST)); await d.activate(); return d; };
  f.S.revision = 5;
  assert.equal((await (await boot()).reconcile(A)).status, 'running');
  f.S.revision = 4;   // fresh validUntil, lower revision: a replay after restart
  const d2 = await boot();
  assert.equal((await d2.reconcile(A)).status, 'held'); assert.match(d2.state()[0].last.reason, /replay or equivocation/);
  f.S.revision = 5;
  assert.equal((await d2.reconcile(A)).status, 'running');
  assert.equal(f.calls.stop.length, 0);
});

test('restart: a local hold survives; a forced claim hint clears nothing; only a saved owner caps change releases it', async (t) => {
  const file = tmpFile(t), f = fixture({ hostId: HOST });
  const boot = async () => { const d = D.createLifecycleDispatch(f.parts([route(A)], { journal: openLifecycleJournal(file) }));
    d.attach(f.hostView(HOST)); await d.activate(); return d; };
  const d1 = await boot();
  assert.equal((await d1.reconcile(A)).status, 'running');
  await d1.restrict(A, 'the owner of this box lowered its hosting caps'); await settle(); await settle();
  assert.equal(f.calls.prepare.at(-1).target, 'queued');
  const d2 = await boot();
  assert.match(d2.state()[0].restricted, /lowered its hosting caps/, 'the hold is re-read from the owned journal');
  d2.considerHint(A, { force: true });
  assert.match(d2.state()[0].restricted, /lowered/, 'the relay hint\'s force flag is not owner-authenticated');
  assert.equal(d2.ownerControlsChanged({ paused: true }).released.length, 0, 'hosting still off: kept');
  assert.deepEqual(d2.ownerControlsChanged({ paused: false }).released, [A]);
  assert.equal(d2.state()[0].restricted, null);
  assert.equal(openLifecycleJournal(file).readHostAuthority(HOST).holds[A], undefined);
  await d2.reconcile(A);
  assert.equal(f.calls.submit.length, 1, 'the journaled revocation is reconciled, never resent');
});

test('generated host: enforceOff persists the hold; consider(force) keeps it; setHostingCaps (owner API) releases it', async (t) => {
  const { Host, HOSTID, box, serve } = await import(CANDIDATE_HOST_URL);
  const file = tmpFile(t), f = fixture({ hostId: HOSTID });
  const d = D.createLifecycleDispatch(f.parts([route(A)], { journal: openLifecycleJournal(file) }));
  const { h } = await box(Host, d); serve(h); await d.activate();
  assert.equal((await d.reconcile(A)).status, 'running');
  h.caps.paused = true;
  assert.deepEqual(await h.enforceOff(), [A]); await settle();
  assert.match(openLifecycleJournal(file).readHostAuthority(HOSTID).holds[A].why, /turned hosting off/);
  for (const force of [false, true]) assert.equal((await h.consider(A, { force })).standing, 'lifecycle');
  assert.ok(d.state()[0].restricted);
  h.setHostingCaps({ cpuShare: 1, gpuShare: 1, paused: true });
  assert.ok(d.state()[0].restricted, 'turning hosting off again re-arms nothing new and releases nothing');
  h.setHostingCaps({ cpuShare: 1, gpuShare: 1, paused: false });
  assert.equal(d.state()[0].restricted, null);
  assert.equal(openLifecycleJournal(file).readHostAuthority(HOSTID).ownerEpoch, 2);
});
