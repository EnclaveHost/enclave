// BUILT-bundle compatibility: the deployed old runtime (897b1702...) and the candidate (cb9ff183...) run runDirectory with the
// production config schema and their real HTTP API on ONE state directory, in turn: old -> new -> restart -> old (rollback)
// -> new. Chain reads use local HTTPS JSON-RPC servers and each bundle's actual reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as rig from './rig.mjs';
import {startRpcFixture} from './rpc-fixture.mjs';

const {call, sha} = rig;
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-runtime-bundle-'));
const stateDir = path.join(T, 'state');
const evidence = {bundles: {new: rig.BUNDLES.new.sha256, old: rig.BUNDLES.old.sha256}, checks: []};
const note = (name, d = {}) => evidence.checks.push({name, ...d});
const running = new Set();
let rpc;
test.before(async () => { rpc = await startRpcFixture(rig); });
async function start(kind, port, {dir = stateDir, peers = []} = {}) {
  const b = await rig.loadBundle(kind);
  const config = rig.config({stateDir: dir, port, peers});
  config.rpc = rpc.urls;
  config.authorityPins.deployments = rig.deployments;
  config.authorityPins.registry = rig.registry;
  const r = await b.runDirectory(config);
  const inst = {kind, port, r, stop: async () => { r.close(); r.server.closeAllConnections?.(); await new Promise(ok => r.server.listening ? r.server.once('close', ok) : ok()); running.delete(inst); }};
  running.add(inst); return inst;
}
const records = async port => (await call(port, 'GET', '/v1/network/records')).body;
const strip = s => ({providers: s.providers, policies: s.policies, publications: s.publications});
let t0, pr1, oldSnapshot, epoch, mgmtSeq;

test.after(async () => {
  for (const i of [...running]) await i.stop();
  if (rpc) { await rpc.close(); evidence.rpc = {counts: rpc.counts, unexpected: rpc.unexpected}; }
  fs.writeFileSync(path.join(rig.CAND, 'logs', 'bundle-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  fs.rmSync(T, {recursive: true, force: true});
  if (rpc) assert.deepEqual(rpc.unexpected, []);
});
if (process.env.INJECT_FAILURE) test('INJECTED FAILURE (negative control)', () => assert.fail('injected'));

test('OLD runtime (deployed) writes real signed records through its own HTTP API; it has no management handler', async () => {
  const d = await start('old', 41101);
  t0 = Date.now() - 2000; pr1 = await rig.signProvider(t0);
  assert.equal((await call(41101, 'POST', '/v1/network/providers', pr1)).status, 200);
  assert.equal((await call(41101, 'POST', '/v1/network/qualifications', await rig.signQual(pr1))).status, 200);
  for (const n of [1, 2]) assert.equal((await call(41101, 'POST', '/v1/network/policy/' + rig.id, {envelope: await rig.signPolicy(n)})).status, 200, 'policy ' + n);
  epoch = Date.now();
  for (const s of [1, 2]) { const r = await call(41101, 'POST', '/v1/network/routes', {publication: await rig.routePublication(rig.policy(2), s, epoch)}); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  const mg = await call(41101, 'POST', '/v1/network/management', await rig.managementRecord(Date.now() - 1000));
  assert.equal(mg.status, 404, 'the deployed runtime lacks the management handler (the canary failure)');
  oldSnapshot = await records(41101);
  assert.equal(oldSnapshot.providers.length, 1); assert.equal(oldSnapshot.policies.length, 1); assert.equal(oldSnapshot.publications.length, 1);
  assert.equal(oldSnapshot.management, undefined);
  await d.stop();
  const s = rig.stateSummary(stateDir);
  assert.equal(Object.keys(s.floors).length, 1, 'one route replay floor file');
  note('old-writes', {state: s, managementPostOnOld: mg.status});
});

test('NEW runtime loads the old state byte-compatible: every record served unchanged, every replay floor enforced', async () => {
  const before = sha(fs.readFileSync(path.join(stateDir, 'public-records.json')));
  const d = await start('new', 41102);
  assert.equal(sha(fs.readFileSync(path.join(stateDir, 'public-records.json'))), before, 'loading does not rewrite the state');
  const snap = await records(41102);
  assert.deepEqual(strip(snap), strip(oldSnapshot), 'same signed records'); assert.deepEqual(snap.management, []);
  const prov = (await call(41102, 'GET', '/v1/network/providers')).body;
  assert.equal(prov.providers.length, 1); assert.equal(prov.providers[0].qualifications.length, 1);
  assert.equal((await call(41102, 'GET', '/v1/network/policy/' + rig.id)).body.envelope.policy.nonce, 2);
  const routes = (await call(41102, 'GET', '/v1/network/routes')).body;
  assert.ok(Object.keys(routes.deployments).length === 1, 'route map rebuilt from the old publication: ' + JSON.stringify(routes));
  // replays below the floors written by the old runtime
  const stale = [
    ['/v1/network/providers', await rig.signProvider(t0 - 1000), /stale/],
    ['/v1/network/policy/' + rig.id, {envelope: await rig.signPolicy(1)}, /stale|nonce/],
    ['/v1/network/routes', {publication: await rig.routePublication(rig.policy(2), 1, epoch)}, /./]];
  for (const [p, b, re] of stale) { const r = await call(41102, 'POST', p, b); assert.equal(r.status, 400, p + ' ' + JSON.stringify(r.body)); assert.match(r.body.error, re); }
  assert.deepEqual(strip(await records(41102)), strip(oldSnapshot), 'refused replays changed nothing');
  await d.stop();
  note('new-loads-old', {staleRefused: stale.length});
});

test('NEW runtime: signed management admission, refusals, and floors that survive a restart', async () => {
  let d = await start('new', 41103);
  mgmtSeq = Date.now() - 5000;
  const ok = await call(41103, 'POST', '/v1/network/management', await rig.managementRecord(mgmtSeq));
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.changed, true);
  const refuse = async (body, re) => { const r = await call(41103, 'POST', '/v1/network/management', body); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, re); };
  await refuse({}, /./);
  await refuse('{not json', /./);
  await refuse(await rig.managementRecord(mgmtSeq - 1000), /stale/);
  await refuse(await rig.managementRecord(mgmtSeq, rig.operator, '9.9.9.9'), /equivocation/);
  await refuse(await rig.managementRecord(mgmtSeq + 1, rig.stranger), /registry operator/);
  const forged = await rig.managementRecord(mgmtSeq + 2); forged.signature = (await rig.managementRecord(mgmtSeq + 2, rig.operator2)).signature;
  await refuse(forged, /./);
  assert.equal((await records(41103)).management.length, 1);
  await d.stop();
  d = await start('new', 41104); // restart: new module instance, same state
  const r = await call(41104, 'POST', '/v1/network/management', await rig.managementRecord(mgmtSeq - 1000));
  assert.equal(r.status, 400); assert.match(r.body.error, /stale/, 'management replay floor survived the restart');
  assert.equal((await records(41104)).management.length, 1);
  await d.stop();
  note('management', {refusals: 6, floorSurvivesRestart: true, state: rig.stateSummary(stateDir)});
});

test('ROLLBACK to the old runtime keeps the new keys; re-upgrade still enforces management floors', async () => {
  let d = await start('old', 41105);
  const snap = await records(41105);
  assert.deepEqual(strip(snap), strip(oldSnapshot), 'old runtime serves the same records after the upgrade');
  const pr2 = await rig.signProvider(t0 + 500, 'test-updated');
  assert.equal((await call(41105, 'POST', '/v1/network/providers', pr2)).status, 200, 'old runtime writes after rollback');
  await d.stop();
  const s = rig.stateSummary(stateDir);
  assert.ok(s.keys.includes('management') && s.keys.includes('managementFloors'), 'old runtime preserved management keys: ' + s.keys);
  assert.equal(s.management, 1);
  d = await start('new', 41106);
  const r = await call(41106, 'POST', '/v1/network/management', await rig.managementRecord(mgmtSeq - 1000));
  assert.equal(r.status, 400); assert.match(r.body.error, /stale/);
  const snap2 = await records(41106);
  assert.equal(snap2.providers[0].record.record.region, 'test-updated'); assert.equal(snap2.management.length, 1);
  await d.stop();
  note('rollback-roundtrip', {keysAfterOldWrite: s.keys});
});

test('NEW runtime full public API', async () => {
  const d = await start('new', 41107);
  const h = await call(41107, 'GET', '/health'); assert.equal(h.status, 200); assert.deepEqual(h.body, {ok: true, service: 'enclave-public-directory', version: 1});
  const o = await call(41107, 'OPTIONS', '/v1/network/providers'); assert.equal(o.status, 204); assert.equal(o.headers['access-control-allow-origin'], '*');
  for (const p of ['/v1/network/providers', '/v1/network/records', '/v1/network/routes', '/v1/network/policy/' + rig.id]) {
    const r = await call(41107, 'GET', p); assert.equal(r.status, 200, p); assert.equal(r.headers['access-control-allow-origin'], '*');
  }
  assert.equal((await call(41107, 'GET', '/v1/network/nothing')).status, 404);
  assert.equal((await call(41107, 'PUT', '/v1/network/providers', '{}')).status, 405);
  assert.equal((await call(41107, 'GET', '/v1/network/providers?x=1')).status, 400);
  assert.equal((await call(41107, 'POST', '/v1/network/providers', JSON.stringify({pad: 'x'.repeat(70000)}))).status, 413);
  assert.equal((await call(41107, 'POST', '/v1/network/policy/0x' + 'ef'.repeat(32), {envelope: await rig.signPolicy(9)})).status, 400);
  assert.equal((await call(41107, 'POST', '/v1/network/nothing', '{}')).status, 404);
  await d.stop();
  note('full-api');
});

test('GOSSIP old <-> new: each imports the other; the old runtime ignores management records without failing', async () => {
  const A = path.join(T, 'gossip-old'), B = path.join(T, 'gossip-new');
  const a = await start('old', 41201, {dir: A, peers: ['http://127.0.0.1:41202']});
  assert.equal((await call(41201, 'POST', '/v1/network/providers', await rig.signProvider(Date.now() - 1000))).status, 200);
  const b = await start('new', 41202, {dir: B, peers: ['http://127.0.0.1:41201']});
  assert.equal((await call(41202, 'POST', '/v1/network/management', await rig.managementRecord(Date.now() - 1000))).status, 200);
  assert.equal((await call(41202, 'POST', '/v1/network/policy/' + rig.id, {envelope: await rig.signPolicy(3)})).status, 200);
  let okB = false, okA = false;
  for (let i = 0; i < 50 && !(okA && okB); i++) {
    await new Promise(r => setTimeout(r, 500));
    okB = (await records(41202)).providers.length === 1;
    okA = (await records(41201)).policies.length === 1;
  }
  assert.ok(okB, 'new imported the provider from old'); assert.ok(okA, 'old imported the policy from new (10 s sync)');
  assert.equal((await call(41201, 'GET', '/health')).status, 200, 'old runtime healthy after importing a snapshot with management');
  await a.stop(); await b.stop();
  note('gossip');
});
