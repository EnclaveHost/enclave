// activation/runtime-remote.py (the exact host program) against the REAL bundles run as the service command line
// (`node <bundle> <config.json>`, the systemd ExecStart form) under test/fake/systemctl.py, on state written by the
// deployed old runtime's own HTTP API. Temp directories only; network namespace (no chain, no hosts).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as rig from './rig.mjs';
import {startRpcFixture} from './rpc-fixture.mjs';

const {call, sha} = rig;
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-runtime-remote-'));
const P = (...p) => path.join(T, ...p);
const PORT = 41301, NODE = process.execPath, sleep = ms => new Promise(r => setTimeout(r, ms));
const evidence = {checks: []};
for (const d of ['opt/runtime-30cee0a', 'etc', 'dropins', 'systemd', 'state']) fs.mkdirSync(P(d), {recursive: true});
const OLD = P('opt/runtime-30cee0a/enclave-directory.mjs'), NEW = P('opt/runtime-37366ab/enclave-directory.mjs'), CFG = P('etc/config-f6959cb.json');
fs.copyFileSync(rig.BUNDLES.old.file, OLD);
const dropinText = bundle => `[Service]\nExecStart=\nExecStart=${NODE} ${bundle} ${CFG}\n`;
const DROPIN = P('dropins/zz-authority-pins.conf'), BACKUP = P('dropins/rollback-before-runtime-37366ab.txt');
const BASE = Buffer.from(dropinText(OLD)), NEWD = Buffer.from(dropinText(NEW)), OTHER = Buffer.from(dropinText(OLD) + '# another writer\n');
fs.writeFileSync(P('dropins/30-authority-pins.conf'), `[Service]\nExecStart=\nExecStart=${NODE} ${P('opt/25dd936/enclave-directory.mjs')} ${CFG}\n`);
fs.writeFileSync(DROPIN, BASE);
fs.writeFileSync(P('systemd/config.json'), JSON.stringify({fragment_argv: [NODE, P('opt/2d848c8/enclave-directory.mjs'), P('etc/config.json')], dropin_dir: P('dropins'), log: P('service.log')}));
const SYSTEMCTL = ['python3', path.join(rig.HERE, 'fake/systemctl.py')];
const envBase = {PATH: process.env.PATH, HOME: T, FAKE_SYSTEMD: P('systemd'), NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS};
const sysctl = (args, env = {}) => new Promise((resolve, reject) => { const c = spawn(SYSTEMCTL[0], [SYSTEMCTL[1], ...args], {env: {...envBase, ...env}, stdio: 'ignore'}); c.on('error', reject); c.on('close', resolve); });
const servicePid = () => { try { return Number(fs.readFileSync(P('systemd/pid'), 'utf8')); } catch { return 0; } };
const cmdline = pid => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; } };
const file = f => sha(fs.readFileSync(f));
const journal = () => fs.existsSync(P('journal.jsonl')) ? fs.readFileSync(P('journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const holders = new Set();

function run(mode, extra = {}, env = {}, {timeoutMs = 150000} = {}) {
  const params = {mode, unit: 'enclave-public-directory', dropin: DROPIN, base_dropin_sha256: sha(BASE), new_dropin_b64: NEWD.toString('base64'), new_dropin_sha256: sha(NEWD),
    backup: BACKUP, bundle_path: NEW, bundle_sha256: rig.BUNDLES.new.sha256, bundle_b64: fs.readFileSync(rig.BUNDLES.new.file).toString('base64'),
    old_bundle_path: OLD, old_bundle_sha256: rig.BUNDLES.old.sha256, config_path: CFG, config_sha256: file(CFG), node: NODE, state_dir: P('state'), port: PORT,
    lock: P('runtime.lock'), journal: P('journal.jsonl'), systemctl: SYSTEMCTL, critical_labels: [rig.id.slice(2, 10)], minimum_routes: 1, run_id: 'fixture',
    active_timeout_s: 8, health_timeout_s: 10, routes_timeout_s: 20, routes_needed: 2, restart_cap: 2, ...extra};
  const program = 'PARAMS = ' + JSON.stringify(JSON.stringify(params)) + '\n' + fs.readFileSync(path.join(rig.CAND, 'activation/runtime-remote.py'), 'utf8');
  return new Promise((resolve, reject) => {
    const c = spawn('python3', ['-'], {env: {...envBase, ...env}, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { c.kill('SIGKILL'); reject(Error(`runtime-remote ${mode} timed out`)); }, timeoutMs);
    c.on('close', code => { clearTimeout(timer); let o = null; try { o = JSON.parse(out.trim().split('\n').at(-1)); } catch {}
      if (!o) return reject(Error(`no answer (exit ${code}): ${out}${err}`)); resolve({rc: code, out: o}); });
    c.stdin.end(program);
  });
}
async function holdLock(f) {
  const c = spawn('flock', ['-x', '-n', f, 'sleep', '60'], {stdio: 'ignore', detached: true}); holders.add(c); await sleep(300);
  assert.equal(c.exitCode, null);
  return async () => { const done = new Promise(r => c.once('exit', r)); process.kill(-c.pid, 'SIGTERM'); await done; holders.delete(c); };
}
async function waitHealthy() { for (let i = 0; i < 60; i++) { try { if ((await call(PORT, 'GET', '/health')).status === 200) return; } catch {} await sleep(250); } throw Error('service not healthy: ' + fs.readFileSync(P('service.log'), 'utf8').slice(-1500)); }

let liveProviderAt, rpc, seedDirectory, refreshTimer, refreshPending = Promise.resolve(), sequence = 1, epoch;
async function refreshRoute() {
  const response = await call(PORT, 'POST', '/v1/network/routes',
    {publication: await rig.routePublication(rig.policy(2), ++sequence, epoch)});
  assert.equal(response.status, 200, JSON.stringify(response.body));
}
test.before(async () => {
  rpc = await startRpcFixture(rig);
  const config = rig.config({stateDir: P('state'), port: PORT});
  config.rpc = rpc.urls;
  config.authorityPins.deployments = rig.deployments;
  config.authorityPins.registry = rig.registry;
  fs.writeFileSync(CFG, JSON.stringify(config));
  // Real records written by the deployed old runtime's HTTP API and RPC reader.
  const b = await rig.loadBundle('old');
  const d = seedDirectory = await b.runDirectory({...config, port: 41399});
  const t0 = Date.now() - 2000, pr = await rig.signProvider(t0);
  epoch = t0;
  for (const [p, body] of [['/v1/network/providers', pr], ['/v1/network/qualifications', await rig.signQual(pr)],
    ['/v1/network/policy/' + rig.id, {envelope: await rig.signPolicy(1)}], ['/v1/network/policy/' + rig.id, {envelope: await rig.signPolicy(2)}],
    ['/v1/network/routes', {publication: await rig.routePublication(rig.policy(2), sequence, epoch)}]]) assert.equal((await call(41399, 'POST', p, body)).status, 200, p);
  d.close(); await new Promise(ok => d.server.listening ? d.server.once('close', ok) : ok());
  seedDirectory = null;
  // "systemd": load the drop-ins and start the old runtime exactly as its ExecStart.
  await sysctl(['daemon-reload']); await sysctl(['restart', 'enclave-public-directory']); await waitHealthy();
  assert.deepEqual(cmdline(servicePid()), [NODE, OLD, CFG]);
  await refreshRoute();
  const routes = await call(PORT, 'GET', '/v1/network/routes');
  assert.equal(routes.status, 200);
  assert.ok(routes.body.labels[rig.id.slice(2, 10)], JSON.stringify(routes.body));
  // Keep publishing valid short-lived records through restarts. Connection errors
  // are expected during the deliberate failure cases; final readbacks must pass.
  refreshTimer = setInterval(() => {
    refreshPending = refreshPending.then(refreshRoute).catch(() => {});
  }, 10000);
});
test.after(async () => {
  clearInterval(refreshTimer);
  await refreshPending;
  if (seedDirectory) { seedDirectory.close(); seedDirectory.server.closeAllConnections(); }
  for (const h of holders) { const done = new Promise(r => h.once('exit', r)); try { process.kill(-h.pid, 'SIGTERM'); } catch {} await done; }
  await sysctl(['stop', 'enclave-public-directory']);
  if (rpc) {
    await rpc.close();
    evidence.rpc = {counts: rpc.counts, unexpected: rpc.unexpected};
    assert.deepEqual(rpc.unexpected, []);
  }
  fs.writeFileSync(path.join(rig.CAND, 'logs', 'remote-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  fs.rmSync(T, {recursive: true, force: true});
});
if (process.env.INJECT_FAILURE) test('INJECTED FAILURE (negative control)', () => assert.fail('injected'));

test('status: baseline drop-in, old runtime running, preconditions clean', async () => {
  const {rc, out} = await run('status');
  assert.equal(rc, 0); assert.equal(out.isBase, true); assert.deepEqual(out.running, [NODE, OLD, CFG]); assert.deepEqual(out.preconditionProblems, []);
  evidence.checks.push({name: 'status'});
});

test('guards: drift, tampered bundle, foreign bundle file, foreign backup, config change, held lock -> refused, nothing written', async () => {
  const pid0 = servicePid();
  fs.writeFileSync(DROPIN, OTHER);
  let r = await run('apply'); assert.equal(r.out.state, 'refused'); assert.match(r.out.error, /drifted/); assert.equal(file(DROPIN), sha(OTHER)); fs.writeFileSync(DROPIN, BASE);
  r = await run('apply', {bundle_b64: Buffer.from('tampered').toString('base64')}); assert.equal(r.out.state, 'refused'); assert.match(r.out.error, /reviewed hashes/);
  fs.mkdirSync(path.dirname(NEW), {recursive: true}); fs.writeFileSync(NEW, 'someone else');
  r = await run('apply'); assert.match(r.out.error, /different file exists/); assert.equal(fs.readFileSync(NEW, 'utf8'), 'someone else'); fs.rmSync(NEW);
  fs.writeFileSync(BACKUP, 'foreign'); r = await run('apply'); assert.match(r.out.error, /backup/); assert.equal(fs.readFileSync(BACKUP, 'utf8'), 'foreign'); fs.rmSync(BACKUP);
  r = await run('apply', {config_sha256: '0'.repeat(64)}); assert.match(r.out.error, /config hash/);
  const release = await holdLock(P('runtime.lock')); r = await run('apply'); assert.match(r.out.error, /lock held/); await release();
  assert.equal(file(DROPIN), sha(BASE)); assert.ok(!fs.existsSync(NEW) && !fs.existsSync(BACKUP)); assert.equal(servicePid(), pid0, 'service untouched');
  assert.equal(journal().length, 0);
  evidence.checks.push({name: 'guards', cases: 6});
});

test('daemon-reload that does not take effect: drop-in restored, NO restart, old runtime untouched', async () => {
  const pid0 = servicePid();
  const r = await run('apply', {}, {FAKE_RELOAD_NOOP: '1'});
  assert.equal(r.rc, 1); assert.equal(r.out.state, 'refused'); assert.match(r.out.error, /effective ExecStart/); assert.equal(r.out.restoredDropin, true);
  assert.equal(file(DROPIN), sha(BASE)); assert.equal(servicePid(), pid0); assert.deepEqual(cmdline(pid0), [NODE, OLD, CFG]);
  assert.equal(file(NEW), rig.BUNDLES.new.sha256, 'the verified bundle file stays (inert, reused next time)');
  await sysctl(['daemon-reload']);
  evidence.checks.push({name: 'reload-not-effective'});
});

test('apply: bundle install + load check, backup once, CAS drop-in, daemon-reload, restart, verification -> active; re-run does not restart', async () => {
  const before = rig.stateSummary(P('state'));
  let r = await run('apply');
  assert.equal(r.rc, 0, JSON.stringify(r.out)); assert.equal(r.out.state, 'active'); assert.equal(r.out.restarted, true);
  assert.equal(r.out.evidence.invalidManagement, 400); assert.equal(r.out.evidence.managementHandler, true); assert.equal(r.out.evidence.continuity, 'forward');
  assert.equal(file(DROPIN), sha(NEWD)); assert.equal(file(BACKUP), sha(BASE)); assert.deepEqual(cmdline(servicePid()), [NODE, NEW, CFG]);
  const after = rig.stateSummary(P('state'));
  for (const [key, floor] of Object.entries(before.floors)) {
    assert.equal(after.floors[key].epoch, floor.epoch);
    assert.ok(after.floors[key].sequence >= floor.sequence, 'signed refresh may advance the replay floor');
  }
  assert.deepEqual(after.policies, before.policies);
  const pid1 = servicePid();
  r = await run('apply'); assert.equal(r.out.state, 'active'); assert.equal(r.out.restarted, false); assert.equal(servicePid(), pid1);
  evidence.checks.push({name: 'apply', evidence: r.out.evidence});
});

test('reconcile refuses changed executable/config and missing initial baseline without restarting', async () => {
  const pid0 = servicePid();
  for (const f of [NEW, CFG]) {
    const original = fs.readFileSync(f);
    try {
      fs.appendFileSync(f, '\n ');
      const r = await run('apply', f === CFG ? {config_sha256: sha(original)} : {});
      assert.equal(r.out.state, 'refused', JSON.stringify(r.out));
      assert.match(r.out.error, /hash differs/);
      assert.equal(servicePid(), pid0);
    } finally { fs.writeFileSync(f, original); }
  }
  const baseline = P('journal.jsonl.baseline.json'), original = fs.readFileSync(baseline);
  try {
    fs.unlinkSync(baseline);
    const r = await run('apply');
    assert.notEqual(r.out.state, 'active');
    assert.match(r.out.error, /baseline missing/);
    assert.equal(servicePid(), pid0);
  } finally { fs.writeFileSync(baseline, original, {mode: 0o600}); }
  evidence.checks.push({name: 'reconcile-drift-and-missing-baseline'});
});

test('records written while live by the new runtime survive; nothing is rolled back in the state directory', async () => {
  liveProviderAt = Date.now() - 1000;
  const w = await call(PORT, 'POST', '/v1/network/providers', await rig.signEnclaveProvider(liveProviderAt));
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const r = await run('rollback'); assert.equal(r.rc, 0, JSON.stringify(r.out)); assert.equal(r.out.state, 'rolled-back'); assert.equal(r.out.verified, true);
  assert.equal(file(DROPIN), sha(BASE)); assert.deepEqual(cmdline(servicePid()), [NODE, OLD, CFG]);
  const snap = (await call(PORT, 'GET', '/v1/network/records')).body;
  assert.ok(snap.providers.some(p => p.record.record.issuedAt === liveProviderAt), 'the old runtime serves the record the new one stored');
  const again = await run('rollback'); assert.equal(again.out.state, 'baseline'); assert.equal(again.out.restarted, false);
  evidence.checks.push({name: 'live-writes-survive-rollback'});
});

test('new runtime fails to start -> automatic rollback to the verified old runtime', async () => {
  const r = await run('apply', {}, {FAKE_CRASH_FOR: 'runtime-37366ab'});
  assert.equal(r.rc, 1); assert.equal(r.out.state, 'rolled-back', JSON.stringify(r.out)); assert.match(r.out.error, /not running/);
  assert.equal(file(DROPIN), sha(BASE)); assert.deepEqual(cmdline(servicePid()), [NODE, OLD, CFG]); assert.equal(journal().at(-1).event, 'rollback-done');
  evidence.checks.push({name: 'start-failure-rollback'});
});

test('RACE: another writer changes the drop-in while the failed new runtime is being detected -> rollback refuses, their bytes survive', async () => {
  const n0 = journal().length;
  const p = run('apply', {}, {FAKE_CRASH_FOR: 'runtime-37366ab'});
  for (let i = 0; i < 400 && !journal().slice(n0).some(e => e.event === 'restart' && e.target === 'new'); i++) await sleep(25);
  fs.writeFileSync(DROPIN, OTHER);
  const r = await p;
  assert.equal(r.rc, 1); assert.equal(r.out.state, 'rollback-refused-drift', JSON.stringify(r.out)); assert.equal(file(DROPIN), sha(OTHER));
  assert.equal((await run('apply')).out.state, 'refused'); assert.equal((await run('rollback')).out.state, 'refused'); assert.equal(file(DROPIN), sha(OTHER));
  // operator: put the baseline back and let rollback reconcile (baseline drop-in, old runtime not running)
  fs.writeFileSync(DROPIN, BASE);
  const back = await run('rollback'); assert.equal(back.out.state, 'rolled-back', JSON.stringify(back.out)); assert.equal(back.out.restarted, true);
  assert.deepEqual(cmdline(servicePid()), [NODE, OLD, CFG]);
  evidence.checks.push({name: 'dropin-race'});
});

test('unknown outcome: drop-in installed and loaded but never restarted -> apply reconciles with exactly one restart', async () => {
  fs.writeFileSync(DROPIN, NEWD); await sysctl(['daemon-reload']); // as if the connection dropped before the restart
  const n0 = journal().filter(e => e.event === 'restart').length;
  const r = await run('apply'); assert.equal(r.out.state, 'active', JSON.stringify(r.out)); assert.equal(r.out.restarted, true);
  assert.equal(journal().filter(e => e.event === 'restart').length, n0 + 1); assert.deepEqual(cmdline(servicePid()), [NODE, NEW, CFG]);
  evidence.checks.push({name: 'reconcile-unknown'});
});

test('restart cap: two unverified restarts recorded -> refused for operator review, nothing restarted', async () => {
  const r0 = await run('rollback'); assert.equal(r0.out.state, 'rolled-back');
  fs.writeFileSync(DROPIN, NEWD); await sysctl(['daemon-reload']);
  for (let i = 0; i < 2; i++) fs.appendFileSync(P('journal.jsonl'), JSON.stringify({at: 'x', run: 'lost', event: 'restart', target: 'new'}) + '\n');
  const pid0 = servicePid();
  const r = await run('apply'); assert.equal(r.out.state, 'refused'); assert.match(r.out.error, /operator review/); assert.equal(servicePid(), pid0);
  fs.writeFileSync(DROPIN, BASE); await sysctl(['daemon-reload']);
  evidence.checks.push({name: 'restart-cap'});
});

test('rollback whose old runtime cannot start is rollback-unverified (never "restored"); a later rollback reconciles', async () => {
  const a = await run('apply'); assert.equal(a.out.state, 'active', JSON.stringify(a.out));
  const r = await run('rollback', {}, {FAKE_CRASH_FOR: 'runtime-30cee0a'});
  assert.equal(r.rc, 1); assert.equal(r.out.state, 'rollback-unverified', JSON.stringify(r.out));
  assert.equal(file(DROPIN), sha(BASE));
  const fix = await run('rollback'); assert.equal(fix.rc, 0); assert.equal(fix.out.state, 'rolled-back'); assert.equal(fix.out.restarted, true);
  assert.deepEqual(cmdline(servicePid()), [NODE, OLD, CFG]);
  const s = rig.stateSummary(P('state'));
  assert.ok(s.providers >= 2, 'state kept every record through all of the above');
  evidence.checks.push({name: 'rollback-unverified-then-reconciled', finalState: s});
});
