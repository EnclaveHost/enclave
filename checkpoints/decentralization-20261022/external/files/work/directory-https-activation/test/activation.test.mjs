// Fixture test of activation/remote.py (the exact host program) against a running Caddy v2.11.4 serving the fixture form of
// the REAL us-west baseline config, with `caddy reload` over its admin socket as the reload command. Run inside the network
// namespace by test/run-fixture.sh. The "host" is a temp directory; nothing touches a real host.
// remote.py runs as an ASYNCHRONOUS child (bounded timeout, awaited) so this process's directory and legacy servers keep
// answering its HTTPS/direct readbacks. Every server and Caddy is closed and awaited in after(); there is no forced exit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {fixtureConfig} from './fixture-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), CAND = path.dirname(HERE), ENCLAVE = path.resolve(CAND, '../enclave');
const imp = p => import(pathToFileURL(path.join(ENCLAVE, p)).href);
const req = createRequire(path.join(ENCLAVE, 'package.json'));
const {privateKeyToAccount} = await import(pathToFileURL(req.resolve('viem/accounts')).href);
const {PublicDirectory} = await imp('network/public-directory.mjs');
const {createDirectoryServer} = await imp('network/directory-server.mjs');
const {signProviderRecord, providerIdFor} = await imp('network/provider-directory.mjs');
const sha = b => createHash('sha256').update(b).digest('hex');
const HOST = 'us-west', IP = '134.199.235.187', CADDY = path.join(HERE, 'bin/caddy-2.11.4');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-https-act-'));
const PORTS = {http: 40080, https: 40443, legacy: 40501, ipfs: 40601, sink: 40701, directory: 40188};
const evidence = {checks: []};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ossl = args => execFileSync('openssl', args, {cwd: T, stdio: ['ignore', 'ignore', 'pipe']});
ossl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=fixture-ca',
  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']);
ossl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'api.key', '-out', 'api.csr', '-subj', '/CN=api.enclave.host']);
fs.writeFileSync(path.join(T, 'api.ext'), 'subjectAltName=DNS:api.enclave.host\nextendedKeyUsage=serverAuth\n');
ossl(['x509', '-req', '-in', 'api.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'api.pem', '-days', '2', '-extfile', 'api.ext']);

const hostDir = path.join(T, 'etc'), CF = path.join(hostDir, 'Caddyfile'), adminSock = path.join(T, 'admin.sock');
const siteLock = path.join(T, 'site-release.lock');
fs.mkdirSync(hostDir); // siteLock is deliberately ABSENT at first: remote.py must create and hold it
const fx = text => fixtureConfig(text, {adminSock, httpPort: PORTS.http, httpsPort: PORTS.https, storage: path.join(T, 'storage'), siteRoot: path.join(T, 'site'),
  legacyPort: PORTS.legacy, legacyCaFile: path.join(T, 'ca.pem'), ipfsPort: PORTS.ipfs, directoryPort: PORTS.directory, sinkPort: PORTS.sink}).text;
const BASE = Buffer.from(fx(fs.readFileSync(path.join(CAND, 'baseline', HOST + '.Caddyfile'), 'utf8')));
const RESULT = Buffer.from(fx(fs.readFileSync(path.join(CAND, 'result', HOST + '.Caddyfile'), 'utf8')));
const OTHER = Buffer.concat([BASE, Buffer.from('\n# another writer changed this file\n')]);
fs.writeFileSync(CF, BASE);

const legacy = https.createServer({key: fs.readFileSync(path.join(T, 'api.key')), cert: fs.readFileSync(path.join(T, 'api.pem'))}, (q, s) => {
  q.resume(); s.writeHead(q.url === '/v1/network/records' ? 404 : 200, {'content-type': 'application/json'}); s.end(JSON.stringify({legacy: true, path: q.url}));
});
const sink = http.createServer((q, s) => { q.resume(); s.writeHead(404); s.end('sink'); });
const ipfs = http.createServer((q, s) => { q.resume(); s.writeHead(200); s.end('ipfs'); });
const operator = privateKeyToAccount('0x' + '2'.repeat(64)), checker = privateKeyToAccount('0x' + '3'.repeat(64));
const directory = new PublicDirectory({directory: path.join(T, 'directory'), checkers: [checker.address], hostOperator: async () => operator.address, leaseOf: async () => null});
await directory.read();
const now = Date.now();
await directory.accept('provider', await signProviderRecord(operator, {version: 1, providerId: providerIdFor(operator.address, '8.8.4.4'), operator: operator.address.toLowerCase(),
  address: '8.8.4.4', wgExitKey: Buffer.alloc(32, 1).toString('base64'), wgGuardKey: Buffer.alloc(32, 2).toString('base64'), ports: {exit: 51820, guard: 51821, control: 51822},
  roles: ['guard'], pricePerGiB6: 0, region: 'test', kind: 'community', hostId: '0x' + 'cd'.repeat(32), issuedAt: now, expiresAt: now + 1800000}));
let dirServer = createDirectoryServer(directory);
const listen = (srv, port) => new Promise((ok, no) => { srv.once('error', no); srv.listen(port, '127.0.0.1', () => ok(srv)); });
const close = srv => new Promise(ok => { if (!srv.listening) return ok(); srv.closeAllConnections?.(); srv.close(() => ok()); });
const exited = child => new Promise(ok => { if (child.exitCode !== null || child.signalCode !== null) return ok(); child.once('exit', () => ok()); });
let caddy;
const holders = new Set();

const reloadArgv = [CADDY, 'reload', '--config', CF, '--adapter', 'caddyfile', '--address', 'unix/' + adminSock];
// remote.py as an awaited asynchronous child, killed (and reported as a failure) after timeoutMs.
function run(mode, extra = {}, {timeoutMs = 120000} = {}) {
  const params = {mode, ip: IP, base_sha256: sha(BASE), result_sha256: sha(RESULT), result_b64: RESULT.toString('base64'), caddyfile: CF, caddy: CADDY,
    reload_argv: reloadArgv, admin_socket: adminSock, https_port: PORTS.https, directory_port: PORTS.directory, peer_locks: [siteLock],
    ca_file: path.join(T, 'storage/pki/authorities/local/root.crt'), run_id: 'fixture', verify_attempts: 3, verify_sleep_s: 1, ...extra};
  const program = 'PARAMS = ' + JSON.stringify(JSON.stringify(params)) + '\n' + fs.readFileSync(path.join(CAND, 'activation/remote.py'), 'utf8');
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-'], {env: {PATH: process.env.PATH, HOME: T}, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error(`remote.py ${mode} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      let out = null; try { out = JSON.parse(stdout.trim().split('\n').at(-1)); } catch {}
      if (!out) return reject(Error(`remote.py ${mode} gave no answer (exit ${code}): ${stdout}${stderr}`));
      resolve({rc: code, out});
    });
    child.stdin.end(program);
  });
}
// A real flock(2) holder (util-linux flock, the same primitive site-release's lockRoot uses), released by killing it.
async function holdLock(file) {
  // flock's command child inherits the locked descriptor, so release = kill the holder's whole process group.
  const child = spawn('flock', ['-x', '-n', file, 'sleep', '60'], {stdio: 'ignore', detached: true}); holders.add(child);
  await sleep(300); assert.equal(child.exitCode, null, 'lock holder running');
  return async () => { const done = exited(child); process.kill(-child.pid, 'SIGTERM'); await done; holders.delete(child); await sleep(100); };
}
const adminHasRoute = () => new Promise(resolve => {
  const q = http.request({socketPath: adminSock, path: '/config/apps/http', headers: {host: 'localhost'}}, res => {
    let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve(res.statusCode === 200 && b.includes('"local_address":"127.0.0.2"')));
  });
  q.on('error', () => resolve(false)); q.end();
});
const file = () => sha(fs.readFileSync(CF));
const backup = path.join(hostDir, 'Caddyfile.before-directory-https'), prepared = path.join(hostDir, 'Caddyfile.directory-https-prepared');
const journalFile = path.join(hostDir, 'directory-https.journal.jsonl');
const journal = () => fs.existsSync(journalFile) ? fs.readFileSync(journalFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

test.before(async () => {
  await listen(legacy, PORTS.legacy); await listen(dirServer, PORTS.directory); await listen(sink, PORTS.sink); await listen(ipfs, PORTS.ipfs);
  const log = fs.openSync(path.join(T, 'caddy.log'), 'w');
  caddy = spawn(CADDY, ['run', '--config', CF, '--adapter', 'caddyfile'], {stdio: ['ignore', log, log],
    env: {PATH: process.env.PATH, HOME: T, XDG_DATA_HOME: path.join(T, 'data'), XDG_CONFIG_HOME: path.join(T, 'config')}});
  for (let i = 0; i < 100 && !fs.existsSync(path.join(T, 'storage/pki/authorities/local/root.crt')); i++) await sleep(200);
  assert.ok(fs.existsSync(path.join(T, 'storage/pki/authorities/local/root.crt')), 'caddy started: ' + fs.readFileSync(path.join(T, 'caddy.log'), 'utf8').slice(-2000));
  await sleep(1000);
});
test.after(async () => {
  for (const h of holders) { const done = exited(h); try { process.kill(-h.pid, 'SIGTERM'); } catch {} await done; }
  if (caddy) { caddy.kill('SIGTERM'); await exited(caddy); }
  await Promise.all([legacy, sink, ipfs, dirServer].map(close));
  fs.writeFileSync(path.join(CAND, 'logs/activation-fixture-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  fs.rmSync(T, {recursive: true, force: true});
});

if (process.env.INJECT_FAILURE) test('INJECTED FAILURE (negative control: the runner must exit nonzero)', () => assert.fail('injected'));

test('status: baseline file, route not running', async () => {
  const {rc, out} = await run('status');
  assert.equal(rc, 0); assert.equal(out.isBase, true); assert.equal(out.runningHasRoute, false, 'admin socket readable, route absent');
  assert.equal(out.peerLocksHeld, 1, 'the initially absent site-release lock was created and held');
  assert.ok(fs.existsSync(siteLock), 'created on first use and never unlinked');
  const missing = await run('apply', {peer_locks: [path.join(T, 'no-release-root', '.site-release.lock')]});
  assert.equal(missing.rc, 1); assert.equal(missing.out.state, 'refused'); assert.match(missing.out.error, /lock root .* is missing/);
  assert.equal(file(), sha(BASE)); assert.ok(!fs.existsSync(backup) && !fs.existsSync(prepared));
  evidence.checks.push({name: 'status-baseline', peerLocksHeld: out.peerLocksHeld, absentPeerLockCreated: true, missingReleaseRootRefused: true});
});

test('before-hash guard: drift, a foreign backup, a foreign prepared file and tampered bytes are refused with nothing written', async () => {
  fs.appendFileSync(CF, '# drift\n'); const drifted = file();
  let r = await run('apply'); assert.equal(r.rc, 1); assert.equal(r.out.state, 'refused'); assert.match(r.out.error, /drifted/); assert.equal(file(), drifted);
  assert.ok(!fs.existsSync(backup) && !fs.existsSync(prepared), 'nothing written on refusal');
  fs.writeFileSync(CF, BASE);
  fs.writeFileSync(backup, 'not the baseline\n');
  r = await run('apply'); assert.equal(r.rc, 1); assert.match(r.out.error, /backup/); assert.equal(file(), sha(BASE));
  assert.equal(fs.readFileSync(backup, 'utf8'), 'not the baseline\n'); assert.ok(!fs.existsSync(prepared)); fs.rmSync(backup);
  fs.writeFileSync(prepared, 'someone else\n');
  r = await run('apply'); assert.equal(r.rc, 1); assert.match(r.out.error, /prepared/); assert.equal(fs.readFileSync(prepared, 'utf8'), 'someone else\n'); fs.rmSync(prepared);
  r = await run('apply', {result_b64: Buffer.from('tampered').toString('base64')}); assert.equal(r.rc, 1); assert.match(r.out.error, /reviewed hash/);
  assert.equal(journal().length, 0, 'no journal entry for refused-before-change runs');
  evidence.checks.push({name: 'guards', drift: true, foreignBackupKept: true, foreignPreparedKept: true, tamperedResult: true});
});

test('locks: own lock held -> refused; site-release lock held -> refused; nothing written either time', async () => {
  let release = await holdLock(path.join(hostDir, 'directory-https.lock'));
  let r = await run('apply'); assert.equal(r.rc, 1); assert.equal(r.out.state, 'refused'); assert.match(r.out.error, /lock held/); await release();
  release = await holdLock(siteLock);
  r = await run('apply'); assert.equal(r.rc, 1); assert.match(r.out.error, /lock held/); await release();
  assert.equal(file(), sha(BASE)); assert.ok(!fs.existsSync(backup) && !fs.existsSync(prepared));
  evidence.checks.push({name: 'locks', ownLockRefused: true, siteReleaseLockRefused: true});
});

test('apply: validate, backup once, CAS install, graceful reload, local readback -> active; re-run is a no-op', async () => {
  let r = await run('apply');
  assert.equal(r.rc, 0, JSON.stringify(r.out)); assert.equal(r.out.state, 'active'); assert.equal(r.out.reloaded, true);
  assert.equal(file(), sha(RESULT)); assert.equal(sha(fs.readFileSync(backup)), sha(BASE)); assert.equal(r.out.after.runningHasRoute, true);
  assert.equal(r.out.evidence.records.equalsLocalDirectory, true); assert.equal(r.out.evidence.postRefusedByDirectory.status, 400);
  assert.deepEqual(journal().map(e => e.event).slice(-5), ['validated', 'backup', 'installed', 'reload', 'verified']);
  r = await run('apply'); assert.equal(r.rc, 0); assert.equal(r.out.state, 'active'); assert.equal(r.out.reloaded, false, 'no second reload');
  evidence.checks.push({name: 'apply-and-idempotent', evidence: r.out.evidence});
});

test('rollback: CAS restore of the exact baseline, one reload, restored state verified; re-run is a no-op', async () => {
  let r = await run('rollback'); assert.equal(r.rc, 0, JSON.stringify(r.out)); assert.equal(r.out.state, 'rolled-back'); assert.equal(r.out.verified, true);
  assert.equal(file(), sha(BASE)); assert.equal(r.out.after.runningHasRoute, false);
  r = await run('rollback'); assert.equal(r.out.state, 'baseline'); assert.equal(r.out.reloaded, false); assert.equal(r.out.verified, true);
  evidence.checks.push({name: 'rollback'});
});

test('unknown outcome: file installed but never reloaded -> apply reconciles with exactly one reload', async () => {
  fs.writeFileSync(CF, RESULT); // as if the connection dropped between install and reload
  const before = journal().filter(e => e.event === 'reload').length;
  const r = await run('apply'); assert.equal(r.rc, 0, JSON.stringify(r.out)); assert.equal(r.out.state, 'active'); assert.equal(r.out.reloaded, true);
  assert.equal(journal().filter(e => e.event === 'reload').length, before + 1);
  assert.equal(sha(fs.readFileSync(backup)), sha(BASE), 'backup untouched');
  assert.equal((await run('rollback')).out.state, 'rolled-back');
  evidence.checks.push({name: 'reconcile-unknown-outcome'});
});

test('failed readback (local directory down) -> automatic rollback, restored state verified', async () => {
  await close(dirServer);
  const r = await run('apply'); assert.equal(r.rc, 1); assert.equal(r.out.state, 'rolled-back', JSON.stringify(r.out)); assert.match(r.out.error, /records|directory/);
  assert.equal(r.out.verified, true); assert.equal(file(), sha(BASE)); assert.equal(r.out.after.runningHasRoute, false); assert.equal(sha(fs.readFileSync(backup)), sha(BASE));
  assert.equal(journal().at(-1).event, 'rollback-done');
  evidence.checks.push({name: 'failure-rollback', error: r.out.error});
});

test('the site-release lock is held for the whole operation: a site release starting mid-activation is blocked', async () => {
  const p = run('apply'); // directory still down: validate, install, reload, then ~3 s of failing readback, then rollback
  let live = false;
  for (let i = 0; i < 400 && !(live = await adminHasRoute()); i++) await sleep(25);
  assert.ok(live, 'mid-operation');
  const probe = await new Promise(resolve => { const c = spawn('flock', ['-x', '-n', siteLock, 'true'], {stdio: 'ignore'}); c.on('close', resolve); });
  assert.equal(probe, 1, 'a site release (flock -n on the same lock) cannot start while the activation runs');
  const r = await p; assert.equal(r.out.state, 'rolled-back'); assert.equal(file(), sha(BASE));
  const after = await new Promise(resolve => { const c = spawn('flock', ['-x', '-n', siteLock, 'true'], {stdio: 'ignore'}); c.on('close', resolve); });
  assert.equal(after, 0, 'released when the run ends'); assert.ok(fs.existsSync(siteLock));
  evidence.checks.push({name: 'peer-lock-held-during-operation'});
});

test('CROSS-WRITER RACE: another writer changes the Caddyfile during a failing readback -> rollback refuses, their bytes survive', async () => {
  // directory still down: verification will fail after the reload; meanwhile an unlocked writer replaces the file.
  const p = run('apply', {verify_attempts: 4, verify_sleep_s: 1});
  // wait until Caddy is actually RUNNING the result (reload done, verification in progress), then write
  let live = false;
  for (let i = 0; i < 400 && !(live = await adminHasRoute()); i++) await sleep(25);
  assert.ok(live, 'the result became the running config');
  fs.writeFileSync(CF, OTHER);
  const r = await p;
  assert.equal(r.rc, 1); assert.equal(r.out.state, 'rollback-refused-drift', JSON.stringify(r.out));
  assert.equal(file(), sha(OTHER), 'the other writer\'s bytes are untouched'); assert.equal(sha(fs.readFileSync(backup)), sha(BASE));
  assert.equal(journal().at(-1).event, 'rollback-refused');
  // the host is now in a state this tool does not own: apply and rollback both refuse without writing
  assert.equal((await run('apply')).out.state, 'refused'); assert.equal((await run('rollback')).out.state, 'refused'); assert.equal(file(), sha(OTHER));
  // operator restores the result bytes and rolls back deliberately
  fs.writeFileSync(CF, RESULT);
  const back = await run('rollback'); assert.equal(back.out.state, 'rolled-back'); assert.equal(file(), sha(BASE));
  evidence.checks.push({name: 'cross-writer-race', refused: true, otherBytesPreserved: true});
});

test('rollback whose reload fails is reported rollback-unverified (never "restored"), then reconciled by one baseline reload', async () => {
  // the reload command succeeds for the result but fails for the baseline
  const flaky = ['sh', '-c', `grep -q publicDirectory '${CF}' && exec "$0" "$@" || exit 7`, ...reloadArgv];
  const r = await run('apply', {reload_argv: flaky}); // directory still down -> verify fails -> restore written, reload exit 7
  assert.equal(r.rc, 1); assert.equal(r.out.state, 'rollback-unverified', JSON.stringify(r.out)); assert.equal(r.out.verified, false);
  assert.equal(file(), sha(BASE)); assert.equal(r.out.running, true, 'the route is still running: not restored');
  const fix = await run('rollback'); assert.equal(fix.rc, 0); assert.equal(fix.out.state, 'rolled-back'); assert.equal(fix.out.reloaded, true); assert.equal(fix.out.running, false);
  evidence.checks.push({name: 'rollback-unverified-then-reconciled'});
});

test('reload cap: two unverified reloads recorded for this result -> refused for operator review, nothing reloaded', async () => {
  dirServer = createDirectoryServer(directory); await listen(dirServer, PORTS.directory);
  fs.writeFileSync(CF, RESULT);
  for (let i = 0; i < 2; i++) fs.appendFileSync(journalFile, JSON.stringify({at: 'x', run: 'lost', event: 'reload', result: sha(RESULT)}) + '\n');
  const r = await run('apply'); assert.equal(r.rc, 1); assert.equal(r.out.state, 'refused'); assert.match(r.out.error, /operator review/); assert.equal(r.out.after.runningHasRoute, false);
  const back = await run('rollback'); assert.equal(back.out.state, 'rolled-back'); assert.equal(file(), sha(BASE));
  evidence.checks.push({name: 'reload-cap'});
});
