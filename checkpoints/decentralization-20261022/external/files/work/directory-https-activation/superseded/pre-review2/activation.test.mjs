// Fixture test of activation/remote.py (the exact host program) against a running Caddy v2.11.4 serving the fixture form of
// the REAL baseline config, with `caddy reload` over its admin socket as the reload command. Run inside the network namespace
// (test/run-fixture.sh runs it after the proxy tests). The "host" is a temp directory; nothing touches a real host.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync, execFileSync} from 'node:child_process';
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

const ossl = args => execFileSync('openssl', args, {cwd: T, stdio: ['ignore', 'ignore', 'pipe']});
ossl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=fixture-ca',
  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']);
ossl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'api.key', '-out', 'api.csr', '-subj', '/CN=api.enclave.host']);
fs.writeFileSync(path.join(T, 'api.ext'), 'subjectAltName=DNS:api.enclave.host\nextendedKeyUsage=serverAuth\n');
ossl(['x509', '-req', '-in', 'api.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'api.pem', '-days', '2', '-extfile', 'api.ext']);

const hostDir = path.join(T, 'etc'), CF = path.join(hostDir, 'Caddyfile'), adminSock = path.join(T, 'admin.sock');
fs.mkdirSync(hostDir);
const fx = text => fixtureConfig(text, {adminSock, httpPort: PORTS.http, httpsPort: PORTS.https, storage: path.join(T, 'storage'), siteRoot: path.join(T, 'site'),
  legacyPort: PORTS.legacy, legacyCaFile: path.join(T, 'ca.pem'), ipfsPort: PORTS.ipfs, directoryPort: PORTS.directory, sinkPort: PORTS.sink}).text;
const BASE = Buffer.from(fx(fs.readFileSync(path.join(CAND, 'baseline', HOST + '.Caddyfile'), 'utf8')));
const RESULT = Buffer.from(fx(fs.readFileSync(path.join(CAND, 'result', HOST + '.Caddyfile'), 'utf8')));
fs.writeFileSync(CF, BASE);

const legacy = https.createServer({key: fs.readFileSync(path.join(T, 'api.key')), cert: fs.readFileSync(path.join(T, 'api.pem'))}, (q, s) => {
  q.resume(); s.writeHead(q.url === '/v1/network/records' ? 404 : 200, {'content-type': 'application/json'}); s.end(JSON.stringify({legacy: true, path: q.url}));
});
const operator = privateKeyToAccount('0x' + '2'.repeat(64));
const directory = new PublicDirectory({directory: path.join(T, 'directory'), checkers: [privateKeyToAccount('0x' + '3'.repeat(64)).address], hostOperator: async () => operator.address, leaseOf: async () => null});
await directory.read();
const now = Date.now();
await directory.accept('provider', await signProviderRecord(operator, {version: 1, providerId: providerIdFor(operator.address, '8.8.4.4'), operator: operator.address.toLowerCase(),
  address: '8.8.4.4', wgExitKey: Buffer.alloc(32, 1).toString('base64'), wgGuardKey: Buffer.alloc(32, 2).toString('base64'), ports: {exit: 51820, guard: 51821, control: 51822},
  roles: ['guard'], pricePerGiB6: 0, region: 'test', kind: 'community', hostId: '0x' + 'cd'.repeat(32), issuedAt: now, expiresAt: now + 1800000}));
let dirServer = createDirectoryServer(directory);
const listen = (srv, port) => new Promise((ok, no) => { srv.once('error', no); srv.listen(port, '127.0.0.1', () => ok(srv)); });
const close = srv => new Promise(ok => { srv.closeAllConnections?.(); srv.close(() => ok()); });
let caddy;

function run(mode, extra = {}) {
  const params = {mode, ip: IP, base_sha256: sha(BASE), result_sha256: sha(RESULT), result_b64: RESULT.toString('base64'), caddyfile: CF, caddy: CADDY,
    reload_argv: [CADDY, 'reload', '--config', CF, '--adapter', 'caddyfile', '--address', 'unix/' + adminSock], admin_socket: adminSock,
    https_port: PORTS.https, directory_port: PORTS.directory, ca_file: path.join(T, 'storage/pki/authorities/local/root.crt'), run_id: 'fixture', ...extra};
  const program = 'PARAMS = ' + JSON.stringify(JSON.stringify(params)) + '\n' + fs.readFileSync(path.join(CAND, 'activation/remote.py'), 'utf8');
  const r = spawnSync('python3', ['-'], {input: program, encoding: 'utf8', timeout: 300000, env: {PATH: process.env.PATH, HOME: T}});
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch {}
  assert.ok(out, 'remote.py output: ' + r.stdout + r.stderr);
  return {rc: r.status, out};
}
const file = () => sha(fs.readFileSync(CF));
const backup = path.join(hostDir, 'Caddyfile.before-directory-https'), prepared = path.join(hostDir, 'Caddyfile.directory-https-prepared');
const journal = () => fs.readFileSync(path.join(hostDir, 'directory-https.journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test.before(async () => {
  await listen(legacy, PORTS.legacy); await listen(dirServer, PORTS.directory);
  await listen(http.createServer((q, s) => { q.resume(); s.writeHead(404); s.end('sink'); }), PORTS.sink);
  await listen(http.createServer((q, s) => { q.resume(); s.writeHead(200); s.end('ipfs'); }), PORTS.ipfs);
  caddy = spawn(CADDY, ['run', '--config', CF, '--adapter', 'caddyfile'], {stdio: ['ignore', fs.openSync(path.join(T, 'caddy.log'), 'w'), fs.openSync(path.join(T, 'caddy.log'), 'a')],
    env: {PATH: process.env.PATH, HOME: T, XDG_DATA_HOME: path.join(T, 'data'), XDG_CONFIG_HOME: path.join(T, 'config')}});
  for (let i = 0; i < 100 && !fs.existsSync(path.join(T, 'storage/pki/authorities/local/root.crt')); i++) await new Promise(r => setTimeout(r, 200));
  await new Promise(r => setTimeout(r, 1500));
});
test.after(async () => {
  caddy?.kill('SIGTERM');
  fs.writeFileSync(path.join(CAND, 'logs/activation-fixture-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  fs.rmSync(T, {recursive: true, force: true}); setTimeout(() => process.exit(0), 300).unref();
});

test('status: baseline file, route not running', () => {
  const {rc, out} = run('status');
  assert.equal(rc, 0); assert.equal(out.isBase, true); assert.equal(out.runningHasRoute, false, 'admin socket readable, route absent');
  evidence.checks.push({name: 'status-baseline', out: {isBase: out.isBase, runningHasRoute: out.runningHasRoute}});
});

test('before-hash guard: a drifted file is refused untouched; a foreign backup is never overwritten', () => {
  fs.appendFileSync(CF, '# drift\n'); const drifted = file();
  let r = run('apply'); assert.equal(r.rc, 1); assert.match(r.out.error, /drifted/); assert.equal(file(), drifted);
  assert.ok(!fs.existsSync(backup) && !fs.existsSync(prepared), 'nothing written on refusal');
  fs.writeFileSync(CF, BASE);
  fs.writeFileSync(backup, 'not the baseline\n');
  r = run('apply'); assert.equal(r.rc, 1); assert.match(r.out.error, /backup/); assert.equal(file(), sha(BASE));
  assert.equal(fs.readFileSync(backup, 'utf8'), 'not the baseline\n'); fs.rmSync(backup);
  r = run('apply', {result_b64: Buffer.from('tampered').toString('base64')}); assert.equal(r.rc, 1); assert.match(r.out.error, /reviewed hash/);
  evidence.checks.push({name: 'guards', drift: true, foreignBackupKept: true, tamperedResult: true});
});

test('apply: validate, backup once, atomic install, graceful reload, local readback -> active; re-run is a no-op', () => {
  let r = run('apply');
  assert.equal(r.rc, 0, JSON.stringify(r.out)); assert.equal(r.out.state, 'active'); assert.equal(r.out.reloaded, true);
  assert.equal(file(), sha(RESULT)); assert.equal(sha(fs.readFileSync(backup)), sha(BASE)); assert.equal(r.out.after.runningHasRoute, true);
  assert.equal(r.out.evidence.records.equalsLocalDirectory, true); assert.equal(r.out.evidence.postRefusedByDirectory.status, 400);
  assert.deepEqual(journal().map(e => e.event).slice(-5), ['validated', 'backup', 'installed', 'reload', 'verified']);
  r = run('apply'); assert.equal(r.rc, 0); assert.equal(r.out.state, 'active'); assert.equal(r.out.reloaded, false, 'no second reload');
  evidence.checks.push({name: 'apply-and-idempotent', evidence: r.out.evidence});
});

test('rollback: restores the exact baseline, reloads once, route gone; re-run is a no-op', () => {
  let r = run('rollback'); assert.equal(r.rc, 0); assert.equal(r.out.state, 'rolled-back');
  assert.equal(file(), sha(BASE)); assert.equal(r.out.after.runningHasRoute, false);
  r = run('rollback'); assert.equal(r.out.state, 'baseline'); assert.equal(r.out.reloaded, false);
  evidence.checks.push({name: 'rollback'});
});

test('unknown outcome: file installed but never reloaded -> apply reconciles with exactly one reload', () => {
  fs.writeFileSync(CF, RESULT); // as if the connection dropped between install and reload
  const before = journal().filter(e => e.event === 'reload').length;
  const r = run('apply'); assert.equal(r.rc, 0, JSON.stringify(r.out)); assert.equal(r.out.state, 'active'); assert.equal(r.out.reloaded, true);
  assert.equal(journal().filter(e => e.event === 'reload').length, before + 1);
  assert.equal(sha(fs.readFileSync(backup)), sha(BASE), 'backup untouched');
  run('rollback');
  evidence.checks.push({name: 'reconcile-unknown-outcome'});
});

test('failed readback (local directory down) rolls back to the baseline and verifies it', async () => {
  await close(dirServer);
  const r = run('apply'); assert.equal(r.out.state, 'rolled-back', JSON.stringify(r.out)); assert.match(r.out.error, /records|directory/);
  assert.equal(file(), sha(BASE)); assert.equal(r.out.after.runningHasRoute, false); assert.equal(sha(fs.readFileSync(backup)), sha(BASE));
  assert.equal(journal().at(-1).event, 'rollback-done');
  dirServer = createDirectoryServer(directory); await listen(dirServer, PORTS.directory);
  evidence.checks.push({name: 'failure-rollback', error: r.out.error});
});

test('reload cap: two unverified reloads recorded for this result -> refused for operator review, nothing reloaded', () => {
  fs.writeFileSync(CF, RESULT);
  const j = path.join(hostDir, 'directory-https.journal.jsonl');
  for (let i = 0; i < 2; i++) fs.appendFileSync(j, JSON.stringify({at: 'x', run: 'lost', event: 'reload', result: sha(RESULT)}) + '\n');
  const r = run('apply'); assert.equal(r.rc, 1); assert.match(r.out.error, /operator review/); assert.equal(r.out.after.runningHasRoute, false);
  const back = run('rollback'); assert.equal(back.out.state, 'rolled-back'); assert.equal(file(), sha(BASE));
  evidence.checks.push({name: 'reload-cap'});
});
