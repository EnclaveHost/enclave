// BUILT-bundle test of the same-route re-sign fix. The LIVE runtime (30cee0a9..., runtime-30cee0a on all four fronts since
// 17:15Z) and the candidate (37366abb..., the same source + the reviewed same-route change, public-directory 600cff79) run
// runDirectory with the production config schema and their real HTTP API on ONE state directory, in turn:
// live -> candidate (upgrade) -> live (rollback). Chain reads use the local HTTPS JSON-RPC fixture and each bundle's own
// reader (lease rows cached 15 s by the bundle, as in production).
// "Same-route re-signs" = the host re-signing the app's UNCHANGED route (same delegation, routes and policy; sequence +1,
// fresh issuedAt/expiresAt), posted continuously while /v1/network/routes verifies. Live hosts do this every ~4 s per app.
// Production has NO hostAdmission in this source (abe86262 base); admin bans are covered for canonical by
// integration/route-same-route-admission.test.mjs. Here: the lease end mid-stream, withdrawal, route and policy changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as rig from './rig.mjs';
import {startRpcFixture} from './rpc-fixture.mjs';

const {call, sha} = rig;
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-runtime-same-'));
const stateDir = path.join(T, 'state');
const A = rig.providerAddress, B = '8.8.8.8', label = rig.id.slice(2, 10);
const UNRELATED = 24, READS = 4, POSTERS = 3, sleep = ms => new Promise(r => setTimeout(r, ms));
const evidence = {bundles: {new: rig.BUNDLES.new.sha256, old: rig.BUNDLES.old.sha256}, checks: [], summaries: []};
const note = (name, d = {}) => evidence.checks.push({name, ...d});
const running = new Set();
let rpc, epoch, seq = 0, last = null, policyNonce = 1, oldRecords, newRecords;
test.before(async () => { rpc = await startRpcFixture(rig); });
async function start(kind, port) {
  const b = await rig.loadBundle(kind);
  const config = rig.config({stateDir, port});
  config.rpc = rpc.urls; config.authorityPins.deployments = rig.deployments; config.authorityPins.registry = rig.registry;
  const r = await b.runDirectory(config);
  const inst = {kind, port, r, stop: async () => { r.close(); r.server.closeAllConnections?.(); await new Promise(ok => r.server.listening ? r.server.once('close', ok) : ok()); running.delete(inst); }};
  running.add(inst); return inst;
}
const records = async port => (await call(port, 'GET', '/v1/network/records')).body;
const strip = s => ({providers: s.providers, policies: s.policies, publications: s.publications});
const routes = async port => (await call(port, 'GET', '/v1/network/routes')).body;
const served = r => r.labels[label]?.addresses || null;
// the host's re-sign: next sequence, same epoch (same delegation bytes), the given routes (default the unchanged [A,B])
async function publish(port, {addresses = [A, B], sequence = ++seq} = {}) {
  const p = await rig.routePublication(rig.policy(policyNonce), sequence, epoch, addresses);
  const r = await call(port, 'POST', '/v1/network/routes', {publication: p});
  if (r.status === 200) last = p.bundle.record;
  return r;
}
// one route read while POSTERS loops keep re-signing the same route until it completes
async function readDuringResigns(port, extra = null) {
  let done = false, posted = 0, refused = 0, n = 0;
  const read = routes(port).finally(() => { done = true; });
  const loops = Array.from({length: POSTERS}, async () => { while (!done) { if (extra) await extra(n++); const r = await publish(port); r.status === 200 ? posted++ : refused++; } });
  const r = await read; await Promise.all(loops); return {r, posted, refused};
}
const floorsOf = () => rig.stateSummary(stateDir);
function assertForward(prev, next, why) {
  for (const [f, v] of Object.entries(prev.floors)) for (const [k, x] of Object.entries(v)) if (typeof x === 'number')
    assert.ok(typeof next.floors[f]?.[k] === 'number' && next.floors[f][k] >= x, `${why}: floor ${f}.${k} went back (${x} -> ${next.floors[f]?.[k]})`);
  for (const [id, n] of Object.entries(prev.policies)) assert.ok(next.policies[id] >= n, `${why}: policy nonce went back`);
}

test.after(async () => {
  for (const i of [...running]) await i.stop();
  if (rpc) { await rpc.close(); evidence.rpc = {counts: rpc.counts, unexpected: rpc.unexpected}; }
  fs.mkdirSync(path.join(rig.CAND, 'logs'), {recursive: true});
  fs.writeFileSync(path.join(rig.CAND, 'logs', 'same-route-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  fs.rmSync(T, {recursive: true, force: true});
  if (rpc) assert.deepEqual(rpc.unexpected, []);
});
if (process.env.INJECT_FAILURE) test('INJECTED FAILURE (negative control)', () => assert.fail('injected'));

test('LIVE runtime 30cee0a: the host re-signing the SAME route during a read withholds the app', async () => {
  const d = await start('old', 41601);
  const t0 = Date.now() - 2000, prA = await rig.signProvider(t0, 'a', A), prB = await rig.signProvider(t0, 'b', B);
  let qAt = Date.now() - 50000;
  const verdict = async pr => assert.equal((await call(41601, 'POST', '/v1/network/qualifications', await rig.signQual(pr, (qAt += 5)))).status, 200);
  for (const pr of [prA, prB]) { assert.equal((await call(41601, 'POST', '/v1/network/providers', pr)).status, 200); await verdict(pr); }
  for (let i = 0; i < UNRELATED; i++) {   // chain-free providers at addresses no route names: each read re-verifies them (slower reads)
    const pr = await rig.signEnclaveProvider(t0, `1.0.${Math.floor(i / 200)}.${(i % 200) + 2}`);
    assert.equal((await call(41601, 'POST', '/v1/network/providers', pr)).status, 200); await verdict(pr);
  }
  assert.equal((await call(41601, 'POST', '/v1/network/policy/' + rig.id, {envelope: await rig.signPolicy(1)})).status, 200);
  epoch = Date.now();
  assert.equal((await publish(41601)).status, 200);
  assert.deepEqual(served(await routes(41601)), [A, B], 'control: no change during the read -> served');
  const reads = []; for (let i = 0; i < READS; i++) { const x = await readDuringResigns(41601); reads.push({served: served(x.r), pending: x.r.pending.map(p => p.id.slice(2, 10)), posted: x.posted}); }
  const withheld = reads.filter(x => x.served === null).length;
  note('live-same-route', {reads, withheld});
  assert.ok(withheld >= 1, `the live runtime never withheld the app under same-route re-signs: ${JSON.stringify(reads)}`);
  assert.deepEqual(served(await routes(41601)), [A, B], 'once the re-signs stop the app is served again');
  oldRecords = await records(41601);
  evidence.summaries.push({after: 'live', ...floorsOf()});
  await d.stop();
});

test('UPGRADE to 37366ab on the same state: same-route re-signs never withhold; every real change still applies', async () => {
  const before = sha(fs.readFileSync(path.join(stateDir, 'public-records.json'))), f0 = floorsOf();
  const d = await start('new', 41602);
  assert.equal(sha(fs.readFileSync(path.join(stateDir, 'public-records.json'))), before, 'loading does not rewrite the state');
  assert.deepEqual(strip(await records(41602)), strip(oldRecords), 'same signed records');
  const reads = [];
  for (let i = 0; i < READS; i++) {
    const x = await readDuringResigns(41602);
    reads.push({served: served(x.r), posted: x.posted});
    assert.deepEqual(served(x.r), [A, B], `same-route re-signs withheld the app on the candidate: ${JSON.stringify(x.r.pending)}`);
    assert.ok(x.r.deployments[rig.id].expiresAt <= last.expiresAt, 'served past the newest record\'s own expiry');
  }
  note('candidate-same-route', {reads});
  // replay floor written by the live runtime is enforced
  const replay = await publish(41602, {sequence: seq - 1}); assert.equal(replay.status, 400, JSON.stringify(replay.body));
  // a WITHDRAWAL (routes: []) landing among re-signs: the next read never serves the old routes
  await readDuringResigns(41602, async n => { if (n === 0) assert.equal((await publish(41602, {addresses: []})).status, 200); });
  assert.equal((await publish(41602, {addresses: []})).status, 200);
  assert.equal(served(await routes(41602)), null, 'withdrawn: old routes not served');
  // a ROUTE change (B dropped) among re-signs of the new route: never [A,B] after it
  assert.equal((await publish(41602, {addresses: [A]})).status, 200);
  const changed = await routes(41602); assert.deepEqual(served(changed), [A]);
  assert.equal((await publish(41602)).status, 200); assert.deepEqual(served(await routes(41602)), [A, B]);
  // an owner POLICY change: the route made under the old policy is withheld until republished under it
  assert.equal((await call(41602, 'POST', '/v1/network/policy/' + rig.id, {envelope: await rig.signPolicy(2)})).status, 200);
  const stale = await routes(41602); assert.equal(served(stale), null); assert.deepEqual(stale.pending.map(p => p.id), [rig.id]);
  policyNonce = 2; assert.equal((await publish(41602)).status, 200); assert.deepEqual(served(await routes(41602)), [A, B]);
  // a LEASE end landing during re-signs: by the next read after the bundle's 15 s lease cache, the app is withheld
  await readDuringResigns(41602, async n => { if (n === 1) rpc.setLeaseActive(false); });
  rpc.setLeaseActive(false);
  await sleep(16000);
  const ended = await routes(41602);
  assert.equal(served(ended), null, 'the lease end takes effect by the next read'); assert.deepEqual(ended.pending.map(p => p.id), [rig.id]);
  const refused = await publish(41602); assert.equal(refused.status, 400, 'a re-sign after the lease end is refused');
  rpc.setLeaseActive(true); await sleep(16000);
  assert.equal((await publish(41602)).status, 200); assert.deepEqual(served(await routes(41602)), [A, B], 'lease back: served again');
  newRecords = await records(41602);
  const f1 = floorsOf(); assertForward(f0, f1, 'upgrade'); evidence.summaries.push({after: 'candidate', ...f1});
  note('candidate-boundaries', {replay: replay.body.error, leaseEnded: ended.pending, refusedAfterLeaseEnd: refused.body.error});
  await d.stop();
});

test('ROLLBACK to 30cee0a on the state the candidate wrote: loads, same records, floors and policy kept, serves', async () => {
  const before = sha(fs.readFileSync(path.join(stateDir, 'public-records.json'))), f1 = floorsOf();
  const d = await start('old', 41603);
  assert.equal(sha(fs.readFileSync(path.join(stateDir, 'public-records.json'))), before, 'loading does not rewrite the state');
  assert.equal((await call(41603, 'GET', '/health')).status, 200);
  assert.deepEqual(strip(await records(41603)), strip(newRecords), 'same signed records after rollback');
  assert.deepEqual(served(await routes(41603)), [A, B], 'served from the publication the candidate accepted');
  const replay = await publish(41603, {sequence: seq - 1}); assert.equal(replay.status, 400, 'floor written by the candidate enforced after rollback');
  const oldPolicy = await call(41603, 'POST', '/v1/network/policy/' + rig.id, {envelope: await rig.signPolicy(1)});
  assert.equal(oldPolicy.status, 400, 'an older policy nonce is refused after rollback');
  const f2 = floorsOf(); assertForward(f1, f2, 'rollback'); evidence.summaries.push({after: 'rollback', ...f2});
  note('rollback', {replay: replay.body.error, oldPolicy: oldPolicy.body.error});
  await d.stop();
});
