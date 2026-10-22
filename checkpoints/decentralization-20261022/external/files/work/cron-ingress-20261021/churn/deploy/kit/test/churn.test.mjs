// BUILT-bundle test of the route-map churn fix (public-directory routeContext narrowed to the providers at the app's
// signed route addresses). The LIVE runtime (2467cea0..., runtime-2467cea on all four fronts since 16:38Z) and the
// candidate (30cee0a9..., the same source + that one routeContext change) run runDirectory with the production config
// schema and their real HTTP API on ONE state directory, in turn: live -> candidate (upgrade) -> live (rollback).
// Chain reads use the local HTTPS JSON-RPC fixture and each bundle's actual reader.
// "Churn" = passing verdicts for providers that the app's signed route does NOT name, posted continuously while
// /v1/network/routes verifies (the live cadence is one verdict about every 30 s against 4-8 s reads on eu-central).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as rig from './rig.mjs';
import {startRpcFixture} from './rpc-fixture.mjs';

const {call, sha} = rig;
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-runtime-churn-'));
const stateDir = path.join(T, 'state');
const A = rig.providerAddress, B = '8.8.8.8', label = rig.id.slice(2, 10);
const UNRELATED = 24, READS = 4, POSTERS = 3;
const evidence = {bundles: {new: rig.BUNDLES.new.sha256, old: rig.BUNDLES.old.sha256}, checks: [], summaries: []};
const note = (name, d = {}) => evidence.checks.push({name, ...d});
const running = new Set();
let rpc, prA, prB, unrelated = [], epoch, qAt = Date.now() - 50000, oldRecords, newRecords;
const nextQ = () => (qAt += 5);   // strictly later verdicts from the same checker
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
const served = async port => { const r = (await call(port, 'GET', '/v1/network/routes')).body;
  return {labels: r.labels[label]?.addresses || null, pending: (r.pending || []).map(x => x.id)}; };
const verdict = async (port, pr, failed = {}) => { const r = await call(port, 'POST', '/v1/network/qualifications', await rig.signQual(pr, nextQ(), failed)); assert.equal(r.status, 200, JSON.stringify(r.body)); };
const publish = (port, seq, addresses, nonce = 1) => rig.routePublication(rig.policy(nonce), seq, epoch, addresses).then(p => call(port, 'POST', '/v1/network/routes', {publication: p}));
// One route-map read while POSTERS loops keep posting passing verdicts for the unrelated providers until it completes.
async function readDuringChurn(port) {
  let done = false, posted = 0, k = 0;
  const read = served(port).finally(() => { done = true; });
  const loops = Array.from({length: POSTERS}, async () => { while (!done) { await verdict(port, unrelated[k++ % unrelated.length]); posted++; } });
  const r = await read; await Promise.all(loops); return {...r, posted};
}
// Replay floors and policy nonces only ever move forward across runtimes.
const floorsOf = () => rig.stateSummary(stateDir);
function assertForward(prev, next, why) {
  for (const [f, v] of Object.entries(prev.floors)) for (const [k, x] of Object.entries(v)) if (typeof x === 'number')
    assert.ok(typeof next.floors[f]?.[k] === 'number' && next.floors[f][k] >= x, `${why}: floor ${f}.${k} went back (${x} -> ${next.floors[f]?.[k]})`);
  for (const [id, n] of Object.entries(prev.policies)) assert.ok(next.policies[id] >= n, `${why}: policy nonce went back`);
  assert.ok(next.providers >= prev.providers && next.publications >= prev.publications, `${why}: records lost`);
}

test.after(async () => {
  for (const i of [...running]) await i.stop();
  if (rpc) { await rpc.close(); evidence.rpc = {counts: rpc.counts, unexpected: rpc.unexpected}; }
  fs.mkdirSync(path.join(rig.CAND, 'logs'), {recursive: true});
  fs.writeFileSync(path.join(rig.CAND, 'logs', 'churn-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  fs.rmSync(T, {recursive: true, force: true});
  if (rpc) assert.deepEqual(rpc.unexpected, []);
});
if (process.env.INJECT_FAILURE) test('INJECTED FAILURE (negative control)', () => assert.fail('injected'));

test('LIVE runtime 2467cea: verdicts for providers the route does not name, landing during a read, withhold the app', async () => {
  const d = await start('old', 41501);
  const t0 = Date.now() - 2000; prA = await rig.signProvider(t0, 'a', A); prB = await rig.signProvider(t0, 'b', B);
  for (const pr of [prA, prB]) { assert.equal((await call(41501, 'POST', '/v1/network/providers', pr)).status, 200); await verdict(41501, pr); }
  for (let i = 0; i < UNRELATED; i++) {   // chain-free providers (kind enclave) at addresses no route names
    const pr = await rig.signEnclaveProvider(t0, `1.0.${Math.floor(i / 200)}.${(i % 200) + 2}`);
    assert.equal((await call(41501, 'POST', '/v1/network/providers', pr)).status, 200); await verdict(41501, pr); unrelated.push(pr);
  }
  assert.equal((await call(41501, 'POST', '/v1/network/policy/' + rig.id, {envelope: await rig.signPolicy(1)})).status, 200);
  epoch = Date.now();
  const r = await publish(41501, 1, [A, B]); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await served(41501)).labels, [A, B], 'control: no change during the read -> served');
  const reads = []; for (let i = 0; i < READS; i++) reads.push(await readDuringChurn(41501));
  const withheld = reads.filter(x => x.labels === null).length;
  note('live-churn', {reads, withheld});
  assert.ok(withheld >= 1, `the live runtime never withheld the app under unrelated churn: ${JSON.stringify(reads)}`);
  for (const x of reads) if (x.labels === null) assert.deepEqual(x.pending, [rig.id], 'withheld as no_current_verified_route');
  assert.deepEqual((await served(41501)).labels, [A, B], 'once the churn stops the app is served again');
  oldRecords = await records(41501);
  evidence.summaries.push({after: 'live', ...floorsOf()});
  await d.stop();
});

test('UPGRADE to 30cee0a on the same state: no rewrite, same records; unrelated churn never withholds; route-named changes still apply', async () => {
  const before = sha(fs.readFileSync(path.join(stateDir, 'public-records.json'))), f0 = floorsOf();
  const d = await start('new', 41502);
  assert.equal(sha(fs.readFileSync(path.join(stateDir, 'public-records.json'))), before, 'loading does not rewrite the state');
  assert.deepEqual(strip(await records(41502)), strip(oldRecords), 'same signed records');
  assert.deepEqual((await served(41502)).labels, [A, B]);
  const reads = []; for (let i = 0; i < READS; i++) reads.push(await readDuringChurn(41502));
  note('candidate-churn', {reads});
  for (const x of reads) assert.deepEqual(x.labels, [A, B], `unrelated churn withheld the app on the candidate: ${JSON.stringify(reads)}`);
  // the replay floor the live runtime wrote is enforced
  const replay = await publish(41502, 1, [A]); assert.equal(replay.status, 400, JSON.stringify(replay.body));
  // a NEGATIVE verdict for a provider the signed route names (racing a read; the exact in-read interleaving is covered
  // deterministically by churn/tree/test/route-context-churn.test.mjs): once accepted, B is never served
  const racing = served(41502);
  await verdict(41502, prB, {blocksPrivateDestinations: false});
  await racing;
  assert.deepEqual((await served(41502)).labels, [A], 'security failure for B: withheld at once');
  await verdict(41502, prB); assert.deepEqual((await served(41502)).labels, [A, B], 'B passes again (strictly later verdict)');
  // a policy change invalidates the route (policy stays in the context): withheld until republished under it
  assert.equal((await call(41502, 'POST', '/v1/network/policy/' + rig.id, {envelope: await rig.signPolicy(2)})).status, 200);
  const stale = await served(41502); assert.equal(stale.labels, null, 'route under the old policy is not served'); assert.deepEqual(stale.pending, [rig.id]);
  const ok = await publish(41502, 2, [A, B], 2); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual((await served(41502)).labels, [A, B]);
  newRecords = await records(41502);
  const f1 = floorsOf(); assertForward(f0, f1, 'upgrade'); evidence.summaries.push({after: 'candidate', ...f1});
  note('candidate-semantics', {replay: replay.body.error, policyChangeWithheld: stale});
  await d.stop();
});

test('ROLLBACK to 2467cea on the state the candidate wrote: loads, same records, floors and policy kept, serves', async () => {
  const before = sha(fs.readFileSync(path.join(stateDir, 'public-records.json'))), f1 = floorsOf();
  const d = await start('old', 41503);
  assert.equal(sha(fs.readFileSync(path.join(stateDir, 'public-records.json'))), before, 'loading does not rewrite the state');
  assert.equal((await call(41503, 'GET', '/health')).status, 200);
  assert.deepEqual(strip(await records(41503)), strip(newRecords), 'same signed records after rollback');
  assert.deepEqual((await served(41503)).labels, [A, B], 'served from the publication the candidate accepted');
  const replay = await publish(41503, 2, [A, B], 2); assert.equal(replay.status, 400, 'floor written by the candidate enforced after rollback');
  const oldPolicy = await call(41503, 'POST', '/v1/network/policy/' + rig.id, {envelope: await rig.signPolicy(1)});
  assert.equal(oldPolicy.status, 400, 'an older policy nonce is refused after rollback');
  const f2 = floorsOf(); assertForward(f1, f2, 'rollback'); evidence.summaries.push({after: 'rollback', ...f2});
  note('rollback', {replay: replay.body.error, oldPolicy: oldPolicy.body.error});
  await d.stop();
});
