// The BUILT bundles started exactly as the unit's ExecStart (`node <bundle> <config.json>`, cwd /, minimal env), with the
// production config schema, on state written by the old runtime: startup, API, SIGTERM, corrupt-state refusal and memory.
// No chain in the fixture: chain-dependent admissions must fail CLOSED (400), never accept or corrupt state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as rig from './rig.mjs';
import {startRpcFixture} from './rpc-fixture.mjs';

const {call, sha} = rig;
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-runtime-cli-'));
const state = path.join(T, 'state'), cfg = path.join(T, 'config.json'), PORT = 41401;
fs.writeFileSync(cfg, JSON.stringify(rig.config({stateDir: state, port: PORT})));
const evidence = {checks: []}, procs = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function launch(kind, config = cfg) {
  const out = [];
  const p = spawn(process.execPath, [rig.BUNDLES[kind].file, config], {cwd: '/', env: {PATH: process.env.PATH}, stdio: ['ignore', 'pipe', 'pipe']});
  p.stdout.on('data', d => out.push(String(d))); p.stderr.on('data', d => out.push(String(d))); procs.add(p);
  p.done = new Promise(r => p.once('exit', (code, signal) => { procs.delete(p); r({code, signal}); }));
  p.log = () => out.join('');
  return p;
}
async function healthy(p) {
  for (let i = 0; i < 80; i++) { if (p.exitCode !== null) break; try { if ((await call(PORT, 'GET', '/health')).status === 200) return; } catch {} await sleep(150); }
  throw Error('not healthy: ' + p.log());
}
const rss = pid => Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024;
async function term(p) { const t = Date.now(); p.kill('SIGTERM'); const r = await p.done; return {...r, ms: Date.now() - t}; }

let seeded, seedDirectory, seedRpc;
test.before(async () => {
  seedRpc = await startRpcFixture(rig);
  const config = rig.config({stateDir: state, port: 41499});
  config.rpc = seedRpc.urls;
  config.authorityPins.deployments = rig.deployments;
  config.authorityPins.registry = rig.registry;
  const b = await rig.loadBundle('old');
  const d = seedDirectory = await b.runDirectory(config);
  const pr = await rig.signProvider(Date.now() - 2000);
  for (const [p, body] of [['/v1/network/providers', pr], ['/v1/network/qualifications', await rig.signQual(pr)], ['/v1/network/policy/' + rig.id, {envelope: await rig.signPolicy(2)}],
    ['/v1/network/routes', {publication: await rig.routePublication(rig.policy(2), 3)}]]) assert.equal((await call(41499, 'POST', p, body)).status, 200, p);
  d.close(); await new Promise(ok => d.server.listening ? d.server.once('close', ok) : ok());
  seedDirectory = null;
  await seedRpc.close();
  assert.deepEqual(seedRpc.unexpected, []);
  seedRpc = null;
  seeded = rig.stateSummary(state);
});
test.after(async () => {
  if (seedDirectory) { seedDirectory.close(); seedDirectory.server.closeAllConnections(); }
  if (seedRpc) await seedRpc.close();
  for (const p of [...procs]) { p.kill('SIGKILL'); await p.done; }
  fs.writeFileSync(path.join(rig.CAND, 'logs', 'cli-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  fs.rmSync(T, {recursive: true, force: true});
});
test.afterEach(async () => {
  for (const p of [...procs]) { p.kill('SIGKILL'); await p.done; }
});
if (process.env.INJECT_FAILURE) test('INJECTED FAILURE (negative control)', () => assert.fail('injected'));

let oldRecords;
test('OLD runtime as ExecStart: serves the state; SIGTERM exits cleanly', async () => {
  const p = launch('old'); await healthy(p);
  oldRecords = (await call(PORT, 'GET', '/v1/network/records')).body;
  assert.equal(oldRecords.providers.length, 1); assert.equal(oldRecords.policies.length, 1); assert.equal(oldRecords.publications.length, 1);
  assert.equal((await call(PORT, 'POST', '/v1/network/management', '{}')).status, 404, 'old runtime: no management handler');
  const mem = rss(p.pid); const t = await term(p);
  assert.ok(t.code === 0 || t.signal === 'SIGTERM', JSON.stringify(t));
  evidence.checks.push({name: 'old-cli', rssMiB: Math.round(mem), term: t});
});

test('NEW runtime as ExecStart on the same state: same records, full API, management handler, chain-dependent writes fail closed', async () => {
  const before = sha(fs.readFileSync(path.join(state, 'public-records.json')));
  const p = launch('new'); await healthy(p);
  assert.match(p.log(), /public signed-record directory listening on/);
  const snap = (await call(PORT, 'GET', '/v1/network/records')).body;
  assert.deepEqual({providers: snap.providers, policies: snap.policies, publications: snap.publications},
    {providers: oldRecords.providers, policies: oldRecords.policies, publications: oldRecords.publications});
  assert.deepEqual(snap.management, []);
  for (const q of ['/v1/network/providers', '/v1/network/routes']) assert.equal((await call(PORT, 'GET', q)).status, 200, q);
  assert.deepEqual((await call(PORT, 'GET', '/v1/network/routes')).body.deployments, {},
    'unreachable chain cannot authorize a route from persisted records alone');
  const policy = await call(PORT, 'GET', '/v1/network/policy/' + rig.id);
  assert.equal(policy.status, 400);
  assert.match(policy.body.error, /chain|quorum/i, 'policy ownership cannot be checked without the chain');
  const inv = await call(PORT, 'POST', '/v1/network/management', '{}'); assert.equal(inv.status, 400); assert.equal(inv.headers['access-control-allow-origin'], '*');
  // A correctly signed management record needs the registry operator from the chain: unreachable here -> refused, not stored.
  const m = await call(PORT, 'POST', '/v1/network/management', await rig.managementRecord(Date.now() - 1000));
  assert.equal(m.status, 400, JSON.stringify(m.body));
  // chain-free write through the CLI runtime
  assert.equal((await call(PORT, 'POST', '/v1/network/providers', await rig.signEnclaveProvider(Date.now() - 1000))).status, 200);
  const s = rig.stateSummary(state);
  assert.deepEqual(s.floors, seeded.floors, 'replay floors untouched by start/serve'); assert.equal(s.management, 0); assert.equal(s.providers, 2);
  assert.notEqual(sha(fs.readFileSync(path.join(state, 'public-records.json'))), before, 'only the accepted write changed the state');
  const mem = rss(p.pid); const t = await term(p);
  assert.ok(t.code === 0 || t.signal === 'SIGTERM', JSON.stringify(t)); assert.ok(t.ms < 5000, 'stops promptly: ' + t.ms);
  evidence.checks.push({name: 'new-cli', rssMiB: Math.round(mem), term: t, managementWithoutChain: m.body});
});

test('OLD runtime again (rollback) serves what the new runtime stored', async () => {
  const p = launch('old'); await healthy(p);
  assert.equal((await call(PORT, 'GET', '/v1/network/records')).body.providers.length, 2);
  await term(p);
  evidence.checks.push({name: 'old-after-new'});
});

test('damaged state: the new runtime refuses to start (fails closed), the state file is left as it was', async () => {
  const bad = path.join(T, 'bad'); fs.mkdirSync(bad); fs.writeFileSync(path.join(bad, 'public-records.json'), '{"version":1,"providers":{');
  const badCfg = path.join(T, 'bad.json'); fs.writeFileSync(badCfg, JSON.stringify(rig.config({stateDir: bad, port: PORT + 1})));
  const before = sha(fs.readFileSync(path.join(bad, 'public-records.json')));
  const p = launch('new', badCfg); const r = await Promise.race([p.done, sleep(8000).then(() => null)]);
  assert.ok(r && r.code !== 0, 'exited non-zero: ' + JSON.stringify(r) + p.log().slice(-300));
  assert.equal(sha(fs.readFileSync(path.join(bad, 'public-records.json'))), before, 'never reset');
  const v2 = path.join(T, 'v2'); fs.mkdirSync(v2); fs.writeFileSync(path.join(v2, 'public-records.json'), '{"version":2}');
  const v2Cfg = path.join(T, 'v2.json'); fs.writeFileSync(v2Cfg, JSON.stringify(rig.config({stateDir: v2, port: PORT + 2})));
  const p2 = launch('new', v2Cfg); const r2 = await Promise.race([p2.done, sleep(8000).then(() => null)]);
  assert.ok(r2 && r2.code !== 0, 'unknown state version refused');
  evidence.checks.push({name: 'damaged-state-refused'});
});
