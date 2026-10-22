// BUILT-bundle test of the route-record partial-qualification fix: the LIVE runtime (cb9ff183..., runtime-cb9ff18 on all four
// fronts) and the candidate (2467cea0..., abe86262 + route-record.mjs patch) run runDirectory with the production config
// schema and their real HTTP API on ONE state directory, in turn: old -> new (upgrade) -> old (rollback). Chain reads use
// the local HTTPS JSON-RPC fixture and each bundle's actual reader. Reproduces 2026-10-21 16:01:51Z on the live bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as rig from './rig.mjs';
import {startRpcFixture} from './rpc-fixture.mjs';

const {call, sha} = rig;
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-runtime-partial-'));
const stateDir = path.join(T, 'state');
const A = rig.providerAddress, B = '8.8.8.8', label = rig.id.slice(2, 10);
const evidence = {bundles: {new: rig.BUNDLES.new.sha256, old: rig.BUNDLES.old.sha256}, checks: []};
const note = (name, d = {}) => evidence.checks.push({name, ...d});
const running = new Set();
let rpc, prA, prB, epoch, qAt = Date.now() - 50000, oldRecords, newRecords;
const nextQ = () => (qAt += 1000);   // strictly later verdicts from the same checker
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
  return {labels: r.labels[label]?.addresses || null, https: r.deployments[rig.id]?.httpsRoutes?.map(x => x.address) || null, pending: (r.pending || []).map(x => x.id)}; };
const verdict = async (port, pr, failed = {}) => { const r = await call(port, 'POST', '/v1/network/qualifications', await rig.signQual(pr, nextQ(), failed)); assert.equal(r.status, 200, JSON.stringify(r.body)); };
const publish = (port, seq, addresses) => rig.routePublication(rig.policy(1), seq, epoch, addresses).then(p => call(port, 'POST', '/v1/network/routes', {publication: p}));

test.after(async () => {
  for (const i of [...running]) await i.stop();
  if (rpc) { await rpc.close(); evidence.rpc = {counts: rpc.counts, unexpected: rpc.unexpected}; }
  fs.mkdirSync(path.join(rig.CAND, 'logs'), {recursive: true});
  fs.writeFileSync(path.join(rig.CAND, 'logs', 'partial-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  fs.rmSync(T, {recursive: true, force: true});
  if (rpc) assert.deepEqual(rpc.unexpected, []);
});
if (process.env.INJECT_FAILURE) test('INJECTED FAILURE (negative control)', () => assert.fail('injected'));

test('LIVE runtime cb9ff18 reproduces the incident: one provider loses its passing verdict -> the whole app label disappears', async () => {
  const d = await start('old', 41401);
  const t0 = Date.now() - 2000; prA = await rig.signProvider(t0, 'a', A); prB = await rig.signProvider(t0, 'b', B);
  for (const pr of [prA, prB]) { assert.equal((await call(41401, 'POST', '/v1/network/providers', pr)).status, 200); await verdict(41401, pr); }
  assert.equal((await call(41401, 'POST', '/v1/network/policy/' + rig.id, {envelope: await rig.signPolicy(1)})).status, 200);
  epoch = Date.now();
  const r = await publish(41401, 1, [A, B]); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await served(41401)).labels, [A, B]);
  await verdict(41401, prB, {payloadIntegrity: false});   // throughput non-pass, every security check true
  const s = await served(41401);
  assert.equal(s.labels, null, 'live runtime withdraws the whole app (the 16:01:51Z outage)'); assert.deepEqual(s.pending, [rig.id]);
  oldRecords = await records(41401);
  await d.stop();
  note('live-reproduces', {afterPayloadFail: s});
});

test('UPGRADE to 2467cea on the same state: no state rewrite, same signed records, the app stays served by the qualified provider', async () => {
  const before = sha(fs.readFileSync(path.join(stateDir, 'public-records.json')));
  const d = await start('new', 41402);
  assert.equal(sha(fs.readFileSync(path.join(stateDir, 'public-records.json'))), before, 'loading does not rewrite the state');
  const snap = await records(41402);
  assert.deepEqual(strip(snap), strip(oldRecords), 'same signed records (original envelopes, both routes)');
  assert.deepEqual(snap.publications[0].bundle.record.routes.map(x => x.address), [A, B], 'replication carries the original signed record');
  const s = await served(41402);
  assert.deepEqual(s.labels, [A]); assert.deepEqual(s.https, [A]); assert.deepEqual(s.pending, []);
  // replay floor written by the live runtime is enforced by the new one
  const replay = await publish(41402, 1, [A]); assert.equal(replay.status, 400, JSON.stringify(replay.body));
  note('upgrade', {served: s, replay: replay.body.error});
  // recovery, security revocation, nothing qualified
  await verdict(41402, prB); assert.deepEqual((await served(41402)).labels, [A, B], 'B passes again: both served from the same signed record');
  await verdict(41402, prA, {blocksPrivateDestinations: false});
  assert.deepEqual((await served(41402)).labels, [B], 'a security failure withholds that provider at once');
  await verdict(41402, prB, {payloadIntegrity: false});
  const none = await served(41402);
  assert.equal(none.labels, null, 'no qualified route: withheld, never served through an unqualified provider'); assert.deepEqual(none.pending, [rig.id]);
  // publication: only-unqualified refused; partially qualified accepted for its qualified route
  const refused = await publish(41402, 2, [A, B]); assert.equal(refused.status, 400); assert.match(refused.body.error, /qualified/);
  await verdict(41402, prB);
  const ok = await publish(41402, 2, [A, B]); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual((await served(41402)).labels, [B]);
  newRecords = await records(41402);
  await d.stop();
  note('new-semantics', {noneQualified: none, refusedPublication: refused.body.error});
});

test('ROLLBACK to the live runtime on the state the new one wrote: loads, same records, old (all-or-nothing) semantics', async () => {
  const before = sha(fs.readFileSync(path.join(stateDir, 'public-records.json')));
  const d = await start('old', 41403);
  assert.equal(sha(fs.readFileSync(path.join(stateDir, 'public-records.json'))), before, 'loading does not rewrite the state');
  assert.equal((await call(41403, 'GET', '/health')).status, 200);
  assert.deepEqual(strip(await records(41403)), strip(newRecords), 'same signed records after rollback');
  assert.equal((await served(41403)).labels, null, 'A is still disqualified: the live runtime withholds the whole record, as before');
  const replay = await publish(41403, 2, [B]); assert.equal(replay.status, 400, 'floor written by the new runtime enforced after rollback');
  await d.stop();
  note('rollback', {replay: replay.body.error});
});
