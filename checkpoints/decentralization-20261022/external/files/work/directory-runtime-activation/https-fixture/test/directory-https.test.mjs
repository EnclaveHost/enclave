// Proxy fixture for the literal-IP HTTPS directory route (work/directory-https-activation). Run via test/run-fixture.sh:
// inside an unshared network namespace (loopback only: no Enclave API, minipc, DNS or Internet is reachable), with the
// exact deployed Caddy v2.11.4 binary, two instances side by side:
//   B = the REAL baseline Caddyfile of HOST, R = the REAL transformed result, both rewritten by fixture-config.mjs only;
// a fake legacy control API per instance (stands in for the minipc tunnel at 127.0.0.1:30443; it is a fixture), and the
// COPY for work/directory-runtime-activation: the directory is the BUILT candidate runtime
// (../../enclave-directory.mjs, sha cb9ff183..., runDirectory with the production config schema and its injected-reader
// seam), with real secp256k1 signatures (fixture keys, fixture lease). The frozen original is untouched.
// These are proxy tests: they prove routing, CORS and signature checking end to end, not organizational independence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {generateKeyPairSync} from 'node:crypto';
import {fixtureConfig} from './fixture-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), CAND = path.dirname(HERE);
const ENCLAVE = path.resolve(CAND, '../../enclave');
const imp = p => import(pathToFileURL(path.join(ENCLAVE, p)).href);
const req = createRequire(path.join(ENCLAVE, 'package.json'));
const {privateKeyToAccount} = await import(pathToFileURL(req.resolve('viem/accounts')).href);
const RUNTIME = path.resolve(CAND, '../enclave-directory.mjs');
assert.equal(createHash('sha256').update(fs.readFileSync(RUNTIME)).digest('hex'), 'cb9ff1839ebbaaf2335174cbf29d86a8f4060160eb548ca250111e5a081d82e5', 'built runtime');
const runtime = await import(pathToFileURL(RUNTIME).href);
const {DirectoryClient} = await imp('network/directory-client.mjs');
const {createDirectoryServer} = runtime;
const {signProviderRecord, signQualification, providerIdFor, CHECKS} = await imp('network/provider-directory.mjs');
const {defaultNetworkPolicy, signNetworkPolicy} = await imp('network/network-policy.mjs');
const {signDelegation, signRoute, recordHash} = await imp('network/route-record.mjs');
const {signManagementRecord} = await imp('network/management-record.mjs');
const {publishManagementRecord} = await imp('network/management-host.mjs');

const IPS = {'us-west': '134.199.235.187', 'eu-central': '134.209.248.172', 'ap-southeast': '165.245.191.129', 'ca-east': '146.190.246.39'};
const HOST = process.env.HOST || 'us-west', IP = IPS[HOST];
assert.ok(IP, 'HOST must be one of ' + Object.keys(IPS));
const GRAMMAR = /^\/v1\/network\/(providers|qualifications|routes|records|management|policy\/0x[0-9a-f]{64})$/;
const ORIGIN = 'https://independent-dashboard.example';
const sha = b => createHash('sha256').update(b).digest('hex');
const CADDY = path.join(HERE, 'bin/caddy-2.11.4');
assert.equal(sha(fs.readFileSync(CADDY)), 'b7105518e3ed1c0761f232e44fc09345535533c9cb0abf0e12809416c7ac64d9', 'exact deployed Caddy binary');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-https-'));
const PORTS = {B: {http: 38080, https: 38443, legacy: 39501}, R: {http: 39080, https: 39443, legacy: 39502}, ipfs: 39601, sink: 39701, directory: 39188};
const evidence = {host: HOST, ip: IP, caddySha256: sha(fs.readFileSync(CADDY)), checks: []};
const note = (name, detail = {}) => evidence.checks.push({name, ...detail});

// ---- fixture PKI for the fake legacy API (api.enclave.host) --------------------------------------------------------
const ossl = args => execFileSync('openssl', args, {cwd: T, stdio: ['ignore', 'ignore', 'pipe']});
ossl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2',
  '-subj', '/CN=legacy-api-fixture-ca', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']);
ossl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'api.key', '-out', 'api.csr', '-subj', '/CN=api.enclave.host']);
fs.writeFileSync(path.join(T, 'api.ext'), 'subjectAltName=DNS:api.enclave.host\nextendedKeyUsage=serverAuth\n');
ossl(['x509', '-req', '-in', 'api.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'api.pem', '-days', '2', '-extfile', 'api.ext']);

// ---- fixture site tree (the real config's roots, small files) -------------------------------------------------------
const baselineText = fs.readFileSync(path.join(CAND, 'baseline', HOST + '.Caddyfile'), 'utf8');
const resultText = fs.readFileSync(path.join(CAND, 'result', HOST + '.Caddyfile'), 'utf8');
const siteRoot = path.join(T, 'site');
const enclaveBlock = baselineText.slice(baselineText.indexOf('\nenclave.host {'), baselineText.indexOf('\nwww.enclave.host {'));
const currentSite = /root \* \/opt\/enclave-site\/(bafy[a-z0-9]+)\/site\n/.exec(enclaveBlock)[1];
const installers = /root \* \/opt\/enclave-site\/([^/\s]+)\/installers\n/.exec(enclaveBlock)[1];
const put = (rel, body) => { const f = path.join(siteRoot, rel); fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, body); };
for (const f of ['index.html', 'apps.html', 'dashboard.html', '404.html', 'js/boot.js']) put(`${currentSite}/site/${f}`, `fixture ${f}\n`);
put(`${installers}/installers/install.sh`, '#!/bin/sh\necho fixture installer\n');
put(`${currentSite}/site-root.block`, 'fixture root block');

// ---- recording upstreams ------------------------------------------------------------------------------------------
const hits = {legacyB: [], legacyR: [], ipfs: [], sink: [], directory: []};
function legacyApi(tag) {
  // Mimics the observed minipc API CORS: only https://enclave.host is allowed; /v1/network/records is 404 there.
  return https.createServer({key: fs.readFileSync(path.join(T, 'api.key')), cert: fs.readFileSync(path.join(T, 'api.pem'))}, (q, s) => {
    hits[tag].push({method: q.method, url: q.url, host: q.headers.host, auth: !!q.headers.authorization, cookie: !!q.headers.cookie});
    const cors = q.headers.origin === 'https://enclave.host' ? {'access-control-allow-origin': 'https://enclave.host', vary: 'Origin'} : {};
    q.resume();
    if (q.method === 'OPTIONS') { s.writeHead(204, {...cors, 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'Authorization,Content-Type'}); return s.end(); }
    const status = q.url === '/v1/network/records' ? 404 : 200;
    s.writeHead(status, {'content-type': 'application/json', ...cors});
    s.end(JSON.stringify({legacy: 'control-api-fixture', method: q.method, path: q.url}));
  });
}
const plain = (tag, status, body) => http.createServer((q, s) => { hits[tag].push({method: q.method, url: q.url, host: q.headers.host}); q.resume(); s.writeHead(status, {'content-type': 'text/plain'}); s.end(body + ' ' + q.url); });
const listen = (srv, port) => new Promise((ok, no) => { srv.once('error', no); srv.listen(port, '127.0.0.1', () => ok(srv)); });
const close = srv => new Promise(ok => { srv.closeAllConnections?.(); srv.close(() => ok()); });

// ---- the real directory, real signatures (fixture keys) -------------------------------------------------------------
const account = n => privateKeyToAccount('0x' + n.repeat(64));
const owner = account('1'), operator = account('2'), checker = account('3'), stranger = account('4');
const id = '0x' + 'ab'.repeat(32), runner = '0x' + 'cd'.repeat(32), deployments = '0x' + '05'.repeat(20);
const now0 = Date.now();
const lease = {id, owner: owner.address, runner, chainId: 8453, deployments, runnerOperator: operator.address, active: true, isPublic: true, leaseUntil: now0 + 3600000, validUntil: now0 + 3600000};
const ZERO = '0x' + '0'.repeat(40);
const running = await runtime.runDirectory({addressBook: '0xab214342d5A490150A4A977063A2f88E21F80907',
  authorityPins: {deployments: '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b', registry: '0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac', connectivity: '0x5f8b636e0768e84bd47b736652030b65db615111', sessionVaultFactory: '0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c'},
  bind: '127.0.0.1', checkers: [checker.address.toLowerCase()], peers: [], port: PORTS.directory, rpc: ['https://rpc-a.fixture.invalid', 'https://rpc-b.fixture.invalid'], stateDir: path.join(T, 'directory')},
  {reader: {authorityPins: {sessionVaultFactory: ZERO}, refresh: async ids => ids.filter(x => x === id).map(() => ({...lease})),
    registryEntries: async (_r, ids) => ids.map(h => (h === runner ? {active: true, operator: operator.address} : null)), bookAddress: async () => '0x' + '86'.repeat(20),
    agreed: async () => { throw Error('no chain in fixture'); }}});
const directory = running.directory;
let directoryServer = running.server;
const trackDirectory = srv => srv.prependListener('request', (q, s) => { const e = {method: q.method, url: q.url, remote: q.socket.remoteAddress}; hits.directory.push(e); s.on('finish', () => { e.status = s.statusCode; }); });
trackDirectory(directoryServer);
const providerAddress = '8.8.4.4';
const providerRecord = (issuedAt, region = 'test') => ({version: 1, providerId: providerIdFor(operator.address, providerAddress), operator: operator.address.toLowerCase(), address: providerAddress,
  wgExitKey: Buffer.alloc(32, 1).toString('base64'), wgGuardKey: Buffer.alloc(32, 2).toString('base64'), ports: {exit: 51820, guard: 51821, control: 51822},
  roles: ['guard', 'ingress', 'egress'], pricePerGiB6: 0, region, kind: 'community', hostId: runner, issuedAt, expiresAt: issuedAt + 1800000});
const routeKeys = generateKeyPairSync('ed25519');
async function publication(policy, sequence) {
  const t = Date.now();
  const delegation = {version: 2, deploymentId: id, runner, chainId: 8453, deployments, policyHash: recordHash(policy), epoch: t, notBefore: t, expiresAt: t + 3600000,
    publicKey: routeKeys.publicKey.export({format: 'der', type: 'spki'}).toString('base64'), ipns: 'k51' + 'a'.repeat(50)};
  const authorization = await signDelegation(operator, delegation, t);
  const record = {version: 2, deploymentId: id, delegationHash: recordHash(delegation), sequence, issuedAt: t, expiresAt: t + 60000,
    routes: [{circuit: 'f'.repeat(32), address: providerAddress, port: 443, transport: 'enclave-network'}]};
  return {version: 2, endpoint: 'https://old-control.example/t/host', policy, bundle: {authorization, ...signRoute(routeKeys.privateKey, record)}};
}

// ---- Caddy instances --------------------------------------------------------------------------------------------------
const caddy = {};
function startCaddy(tag, text) {
  const dir = path.join(T, 'caddy-' + tag); fs.mkdirSync(dir, {recursive: true});
  const fx = fixtureConfig(text, {adminSock: path.join(dir, 'admin.sock'), httpPort: PORTS[tag].http, httpsPort: PORTS[tag].https, storage: path.join(dir, 'storage'),
    siteRoot, legacyPort: PORTS[tag].legacy, legacyCaFile: path.join(T, 'ca.pem'), ipfsPort: PORTS.ipfs, directoryPort: PORTS.directory, sinkPort: PORTS.sink});
  const file = path.join(dir, 'Caddyfile'); fs.writeFileSync(file, fx.text);
  const log = fs.openSync(path.join(dir, 'caddy.log'), 'w');
  const child = spawn(CADDY, ['run', '--config', file, '--adapter', 'caddyfile'], {stdio: ['ignore', log, log],
    env: {PATH: process.env.PATH, HOME: dir, XDG_DATA_HOME: path.join(dir, 'data'), XDG_CONFIG_HOME: path.join(dir, 'config')}});
  caddy[tag] = {child, dir, file, fx, root: path.join(dir, 'storage', 'pki', 'authorities', 'local', 'root.crt')};
  return caddy[tag];
}
async function ready(tag) {
  for (let i = 0; i < 100; i++) {
    if (caddy[tag].child.exitCode !== null) break;
    try { if (fs.existsSync(caddy[tag].root)) { const r = await send(tag, {path: '/__ready__'}); if (r.status === 404) return; } } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw Error(`caddy ${tag} not ready:\n` + fs.readFileSync(path.join(caddy[tag].dir, 'caddy.log'), 'utf8').slice(-3000));
}

// One request to instance `tag`, as a client of https://<host> would make it (literal IP: no SNI; the certificate must be
// valid for the IP). -> {status, headers, body}
function send(tag, {method = 'GET', path: p = '/', host = IP, headers = {}, body, scheme = 'https', signal} = {}) {
  return new Promise((resolve, reject) => {
    const ipHost = /^\d+\.\d+\.\d+\.\d+$/.test(host);
    const opts = {host: '127.0.0.1', port: PORTS[tag][scheme], method, path: p, agent: false, signal, headers: {host, ...headers}};
    if (scheme === 'https') Object.assign(opts, {ca: fs.readFileSync(caddy[tag].root), servername: ipHost ? undefined : host, checkServerIdentity: (_h, cert) => tls.checkServerIdentity(host, cert)});
    const r = (scheme === 'https' ? https : http).request(opts, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    r.on('error', reject); if (body !== undefined) r.write(body); r.end();
  });
}
// A WHATWG fetch for the REAL DirectoryClient / management publisher: https://<ip>/... reaches instance `tag`.
const fetchVia = tag => async (url, init = {}) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== IP || u.port) throw Error('fixture fetch: unexpected origin ' + u.origin);
  const r = await send(tag, {method: init.method || 'GET', path: u.pathname + u.search, headers: init.headers || {}, body: init.body, signal: init.signal});
  if (r.status >= 300 && r.status < 400 && init.redirect === 'error') throw TypeError('redirect refused');
  const h = new Headers(); for (const [k, v] of Object.entries(r.headers)) h.set(k, Array.isArray(v) ? v.join(', ') : v);
  return new Response([204, 304].includes(r.status) ? null : r.body, {status: r.status, headers: h});
};
const json = r => JSON.parse(r.body.toString('utf8'));
const lastDirectory = () => hits.directory.at(-1);

const servers = {};
test.before(async () => {
  servers.legacyB = await listen(legacyApi('legacyB'), PORTS.B.legacy);
  servers.legacyR = await listen(legacyApi('legacyR'), PORTS.R.legacy);
  servers.ipfs = await listen(plain('ipfs', 200, 'ipfs-gateway-fixture'), PORTS.ipfs);
  servers.sink = await listen(plain('sink', 404, 'external-sink'), PORTS.sink);
  // the built runtime's runDirectory is already listening on PORTS.directory
  startCaddy('B', baselineText); startCaddy('R', resultText);
  await ready('B'); await ready('R');
});
test.after(async () => {
  for (const c of Object.values(caddy)) { c.child.kill('SIGTERM'); }
  await Promise.all([...Object.values(servers), directoryServer].map(s => s.listening ? close(s) : null));
  evidence.hits = {legacyB: hits.legacyB.length, legacyR: hits.legacyR.length, ipfs: hits.ipfs.length, sink: hits.sink.length, directory: hits.directory.length};
  fs.writeFileSync(path.join(CAND, 'logs', `fixture-evidence-${HOST}.json`), JSON.stringify(evidence, null, 2) + '\n');
  fs.rmSync(T, {recursive: true, force: true});
});

if (process.env.INJECT_FAILURE) test('INJECTED FAILURE (negative control: the runner must exit nonzero)', () => assert.fail('injected'));

test('the fixtures run the real configs: B and R differ by exactly the reviewed fragment', () => {
  // Render both real configs with identical fixture parameters (the running instances differ only in ports/paths).
  const same = {adminSock: '/A', httpPort: 1, httpsPort: 2, storage: '/S', siteRoot, legacyPort: 3, legacyCaFile: '/C', ipfsPort: 4, directoryPort: 5, sinkPort: 6};
  const b = fixtureConfig(baselineText, same).text.split('\n'), r = fixtureConfig(resultText, same).text.split('\n');
  const at = r.findIndex(l => l.includes('# BEGIN public signed-record directory'));
  const end = r.findIndex(l => l.includes('# END public signed-record directory'));
  assert.ok(at > 0 && end > at);
  assert.deepEqual([...r.slice(0, at), ...r.slice(end + 1)], b, 'outside the fragment the fixture configs are identical');
  assert.equal(caddy.R.fx.counts.directory, 1); assert.equal(caddy.B.fx.counts.directory, 0);
  assert.deepEqual({...caddy.B.fx.counts, directory: 1}, caddy.R.fx.counts);
  note('fixture-fidelity', {fragmentLines: end - at + 1, substitutions: caddy.R.fx.counts});
});

test('arbitrary-origin GET of every public read path: R answers from the local directory, B from the control tunnel', async () => {
  for (const [p, status] of [['/v1/network/providers', 200], ['/v1/network/records', 200], ['/v1/network/routes', 200], ['/v1/network/policy/' + id, 200], ['/v1/network/qualifications', 404], ['/v1/network/management', 404]]) {
    const dBefore = hits.directory.length, lBefore = hits.legacyR.length;
    const r = await send('R', {path: p, headers: {origin: ORIGIN}});
    assert.equal(r.status, status, p);
    assert.equal(r.headers['access-control-allow-origin'], '*', p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(hits.directory.length, dBefore + 1, p + ' reached the directory');
    assert.equal(lastDirectory().url, p); assert.equal(lastDirectory().remote, '127.0.0.2', 'never the loopback-privileged source');
    assert.equal(hits.legacyR.length, lBefore, p + ' never reached the control tunnel');
    const lb = hits.legacyB.length, b = await send('B', {path: p, headers: {origin: ORIGIN}});
    assert.equal(hits.legacyB.length, lb + 1, 'baseline sends ' + p + ' to the control tunnel');
    assert.equal(b.headers['access-control-allow-origin'], undefined, 'baseline: an arbitrary dashboard cannot read ' + p);
  }
  note('arbitrary-origin-get', {paths: 6});
});

test('CORS preflight for GET and POST is answered on the host; credentialed preflight stays legacy', async () => {
  for (const m of ['GET', 'POST']) for (const p of ['/v1/network/providers', '/v1/network/policy/' + id, '/v1/network/management']) {
    const d = hits.directory.length, l = hits.legacyR.length;
    const r = await send('R', {method: 'OPTIONS', path: p, headers: {origin: ORIGIN, 'access-control-request-method': m, 'access-control-request-headers': 'content-type'}});
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(r.headers['access-control-allow-methods'], 'GET, POST');
    assert.equal(r.headers['access-control-allow-headers'], 'content-type');
    assert.equal(r.headers['access-control-max-age'], '600');
    assert.equal(hits.directory.length, d); assert.equal(hits.legacyR.length, l);
  }
  const l = hits.legacyR.length;
  const r = await send('R', {method: 'OPTIONS', path: '/v1/network/providers', headers: {origin: 'https://enclave.host', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,content-type'}});
  assert.equal(hits.legacyR.length, l + 1); assert.equal(r.headers['access-control-allow-origin'], 'https://enclave.host');
  const put = await send('R', {method: 'OPTIONS', path: '/v1/network/providers', headers: {origin: ORIGIN, 'access-control-request-method': 'PUT'}});
  assert.equal(hits.legacyR.length, l + 2); assert.equal(put.headers['access-control-allow-origin'], undefined);
  note('preflight', {answeredOnHost: 6, credentialedToLegacy: true});
});

test('control tunnel OFFLINE: real DirectoryClient signed create/read/update over https://<ip>, invalid records refused by the local directory', async () => {
  await close(servers.legacyB); await close(servers.legacyR);
  const lB = hits.legacyB.length, lR = hits.legacyR.length;
  const baselineDown = await send('B', {path: '/v1/network/providers', headers: {origin: ORIGIN}});
  assert.equal(baselineDown.status, 502, 'the baseline HTTPS directory depends on the control tunnel');
  const client = new DirectoryClient({origins: ['https://' + IP], fetch: fetchVia('R')});
  const hostOperator = async h => (h === runner ? operator.address : null);
  // provider: create, read (signature + registry operator verified by the client), update
  const t1 = Date.now() - 1000, pr1 = await signProviderRecord(operator, providerRecord(t1));
  assert.deepEqual(await client.publish('/v1/network/providers', pr1), ['https://' + IP]);
  const q = {version: 1, providerId: pr1.record.providerId, operator: pr1.record.operator, address: providerAddress, wgExitKey: pr1.record.wgExitKey, wgGuardKey: pr1.record.wgGuardKey,
    roles: pr1.record.roles, checks: Object.fromEntries(CHECKS.map(k => [k, true])), issuedAt: Date.now() - 500, expiresAt: Date.now() + 590000};
  await client.publish('/v1/network/qualifications', await signQualification(checker, q));
  let got = await client.providers({hostOperator});
  assert.equal(got.providers.length, 1); assert.equal(got.providers[0].record.record.issuedAt, t1); assert.equal(got.providers[0].qualifications.length, 1);
  const pr2 = await signProviderRecord(operator, providerRecord(t1 + 500, 'test-updated'));
  await client.publish('/v1/network/providers', pr2);
  got = await client.providers({hostOperator});
  assert.equal(got.providers[0].record.record.region, 'test-updated', 'update visible'); assert.equal(got.providers[0].qualifications.length, 1, 'same keys keep the qualification');
  // the client itself refuses a record whose registry operator differs
  assert.equal((await client.providers({hostOperator: async () => stranger.address})).providers.length, 0);
  // owner policy: create, read, update
  const p1 = {...defaultNetworkPolicy(id), nonce: 1, issuedAt: 1}, p2 = {...p1, nonce: 2, issuedAt: 2};
  await client.publish('/v1/network/policy/' + id, {envelope: await signNetworkPolicy(owner, p1)});
  assert.equal((await client.policy(id, {owner: owner.address})).policy.nonce, 1);
  await client.publish('/v1/network/policy/' + id, {envelope: await signNetworkPolicy(owner, p2)});
  assert.equal((await client.policy(id, {owner: owner.address})).policy.nonce, 2);
  // a signed route for the current policy, and a host management record (management-host.mjs publisher)
  await client.publish('/v1/network/routes', {publication: await publication(p2, 1)});
  const mt = Date.now() - 1000;
  const mgmt = await signManagementRecord(operator, {version: 1, runner, operator: operator.address.toLowerCase(), chainId: 8453, deployments, address: '8.8.8.8', port: 443,
    spkiSha256: '44'.repeat(32), sequence: mt, issuedAt: mt, expiresAt: mt + 3600000});
  assert.deepEqual(await publishManagementRecord(mgmt, {directories: ['https://' + IP], fetch: fetchVia('R')}), ['https://' + IP]);
  const [{value: snap}] = await client.read('/v1/network/records');
  assert.equal(snap.version, 1); assert.equal(snap.providers.length, 1); assert.equal(snap.policies.length, 1); assert.equal(snap.publications.length, 1); assert.equal(snap.management.length, 1);
  const routes = json(await send('R', {path: '/v1/network/routes', headers: {origin: ORIGIN}}));
  assert.ok(Object.values(routes.deployments).length >= 1, 'route map built from the signed publication');
  // refusals by the local directory (each answered with CORS so a dashboard can read the reason)
  const refuse = async (p, body, re, status = 400) => {
    const d = hits.directory.length;
    const r = await send('R', {method: 'POST', path: p, headers: {origin: ORIGIN, 'content-type': 'application/json'}, body: typeof body === 'string' ? body : JSON.stringify(body)});
    assert.equal(r.status, status, p + ' ' + r.body); assert.equal(r.headers['access-control-allow-origin'], '*');
    if (re) assert.match(json(r).error, re);
    return {r, reachedDirectory: hits.directory.length > d};
  };
  await refuse('/v1/network/providers', {...pr2, record: {...pr2.record, address: '9.9.9.9'}}, /./);
  await refuse('/v1/network/providers', await signProviderRecord(stranger, {...providerRecord(Date.now()), operator: stranger.address.toLowerCase(), providerId: providerIdFor(stranger.address, providerAddress)}), /registry|operator/);
  await refuse('/v1/network/policy/' + id, {envelope: await signNetworkPolicy(stranger, {...p2, nonce: 3, issuedAt: 3})}, /owner/);
  await refuse('/v1/network/policy/' + id, {envelope: await signNetworkPolicy(owner, p1)}, /stale|nonce/);
  await refuse('/v1/network/policy/' + '0x' + 'ef'.repeat(32), {envelope: await signNetworkPolicy(owner, {...p2, nonce: 9})}, /mismatch/);
  await refuse('/v1/network/qualifications', await signQualification(stranger, q), /untrusted/);
  await refuse('/v1/network/management', {...mgmt, signature: (await signManagementRecord(stranger, {...mgmt.record, operator: stranger.address.toLowerCase(), sequence: mt + 1, issuedAt: mt + 1})).signature}, /./);
  await refuse('/v1/network/providers', '{not json', /./);
  const big = await refuse('/v1/network/providers', JSON.stringify({pad: 'x'.repeat(70000)}), null, 413);
  const q400 = await send('R', {path: '/v1/network/providers?x=1', headers: {origin: ORIGIN}});
  assert.equal(q400.status, 400); assert.match(json(q400).error, /query/);
  got = await client.providers({hostOperator});
  assert.equal(got.providers[0].record.record.region, 'test-updated', 'refused writes changed nothing');
  assert.equal((await client.policy(id, {owner: owner.address})).policy.nonce, 2);
  assert.equal(hits.legacyB.length, lB + 0, 'B had no listener'); assert.equal(hits.legacyR.length, lR, 'the control tunnel was never needed');
  note('offline-signed-crud', {providerUpdate: true, policyNonce: 2, route: true, management: true, refusals: 9, oversizeReachedDirectory: big.reachedDirectory});
});

test('requests outside the public grammar, or carrying credentials, keep the legacy route (control tunnel back online)', async () => {
  servers.legacyR = await listen(legacyApi('legacyR'), PORTS.R.legacy);
  servers.legacyB = await listen(legacyApi('legacyB'), PORTS.B.legacy);
  // Still the control API (legacy compatibility): its own paths, other policy-id spellings, other methods, credentials.
  const legacy = [
    {path: '/v1/network/byo/' + id}, {method: 'POST', path: `/v1/network/byo/${id}/view`, body: '{}'}, {path: '/v1/network/status/' + id},
    {path: '/v1/network/policy/0x' + 'AB'.repeat(32)}, {method: 'POST', path: '/v1/network/policy/0x' + 'Ab'.repeat(32), headers: {'content-type': 'application/json'}, body: '{}'},
    {method: 'PUT', path: '/v1/network/providers', body: '{}'}, {method: 'DELETE', path: '/v1/network/policy/' + id}, {method: 'HEAD', path: '/v1/network/providers'},
    {path: '/v1/network/providers', headers: {authorization: 'Bearer fixture'}}, {path: '/v1/network/records', headers: {cookie: 's=1'}},
    {method: 'POST', path: '/v1/network/policy/' + id, headers: {authorization: 'Bearer fixture', 'content-type': 'application/json'}, body: '{}'}];
  for (const r of legacy) {
    const d = hits.directory.length, l = hits.legacyR.length;
    const res = await send('R', {...r, headers: {origin: ORIGIN, ...(r.headers || {})}});
    assert.equal(hits.directory.length, d, JSON.stringify(r) + ' must not reach the directory');
    assert.equal(hits.legacyR.length, l + 1, JSON.stringify(r) + ' stays on the control API');
    const lb = hits.legacyB.length, b = await send('B', {...r, headers: {origin: ORIGIN, ...(r.headers || {})}});
    assert.equal(hits.legacyB.length, lb + 1); assert.equal(res.status, b.status); assert.equal(sha(res.body), sha(b.body));
    if (r.headers?.authorization) assert.equal(hits.legacyR.at(-1).auth, true, 'credentials preserved for legacy compatibility');
  }
  // Any other /v1/network/* path: 404 on the host, never a control-API answer on an origin advertised as a directory.
  // (The baseline sends these to the control API, whose network handler also answers 404 'not found' for them.)
  const unknown = ['/v1/network/providers/extra', '/v1/network/provider', '/v1/network/byo', '/v1/network/policy', '/v1/network/', '/V1/network/providers',
    '/v1/Network/providers', '/v1/NETWORK/records', '/v1/network/qualifications/x'];
  for (const p of unknown) for (const method of ['GET', 'POST']) {
    const d = hits.directory.length, l = hits.legacyR.length;
    const res = await send('R', {method, path: p, headers: {origin: ORIGIN, 'content-type': 'application/json'}, body: method === 'POST' ? '{}' : undefined});
    assert.equal(res.status, 404, p); assert.equal(res.headers['access-control-allow-origin'], '*'); assert.deepEqual(json(res), {error: 'not a public-record path'});
    assert.equal(hits.directory.length, d); assert.equal(hits.legacyR.length, l, method + ' ' + p + ' never reaches the control API');
  }
  // Odd spellings: whichever way Caddy matches them, only grammar paths can be served by the directory (invariants below).
  const odd = [];
  for (const p of ['/v2/network/providers', '/', '/v1network/providers', '/v1/network/policy/0x' + 'ab'.repeat(32) + '/../../providers', '/v1/network/%70roviders',
    '/v1/network/policy/' + id + '%2f..', '/v1/network/./providers', '//v1/network/providers']) {
    const d = hits.directory.length, l = hits.legacyR.length;
    const r = await send('R', {path: p, headers: {origin: ORIGIN}});
    odd.push({path: p, status: r.status, to: hits.directory.length > d ? 'directory' : hits.legacyR.length > l ? 'legacy' : 'caddy'});
  }
  note('legacy-preserved', {legacyCases: legacy.length, unknownHost404: unknown.length * 2, oddPaths: odd});
});

test('legacy routes outside the fragment are byte-for-byte unaffected', async () => {
  const corpus = [
    {path: '/native/status'}, {path: '/native/resolve?name=api.enclavehost.eth'}, {path: '/recovery-health'}, {path: '/health'}, {path: '/enclaves'},
    {path: '/availability'}, {path: '/route'}, {path: '/t/abcd/x'}, {path: '/mcp', method: 'POST', body: '{}'}, {path: '/v1/deployments'},
    {path: '/v1/network/status/' + id}, {method: 'OPTIONS', path: '/v1/deployments', headers: {origin: 'https://enclave.host', 'access-control-request-method': 'POST'}},
    {path: '/'}, {path: '/nope'},
    {host: 'enclave.host', path: '/'}, {host: 'enclave.host', path: '/apps'}, {host: 'enclave.host', path: '/dashboard'}, {host: 'enclave.host', path: '/js/boot.js'},
    {host: 'enclave.host', path: '/install.sh'}, {host: 'enclave.host', path: '/missing-page'}, {host: 'enclave.host', path: '/ipfs/' + currentSite + '?format=raw'},
    {host: 'enclave.host', path: '/v1/network/providers'}, {host: 'enclave.host', path: '/add-json', method: 'POST', body: '{}'},
    {host: 'www.enclave.host', path: '/x?y=1'}, {host: 'ipfs.enclave.host', path: '/ipfs/bafkreifixture'}, {host: 'ipfs.enclave.host', path: '/ipfs/' + currentSite + '?format=raw'},
    {host: 'bootstrap-' + HOST + '.enclave.host', path: '/ipfs/x'},
    {scheme: 'http', host: 'enclave.host', path: '/.well-known/acme-challenge/token'}, {scheme: 'http', host: 'ipfs.enclave.host', path: '/x'}];
  const KEEP = ['content-type', 'location', 'access-control-allow-origin', 'cache-control', 'content-security-policy', 'x-content-type-options', 'strict-transport-security', 'cross-origin-opener-policy'];
  const shape = r => ({status: r.status, body: sha(r.body), headers: Object.fromEntries(KEEP.filter(k => r.headers[k] !== undefined).map(k => [k, r.headers[k]]))});
  const upstreams = () => [hits.legacyB.length + hits.legacyR.length, hits.ipfs.length, hits.sink.length];
  const rows = [];
  for (const c of corpus) {
    const d = hits.directory.length;
    const s0 = {lB: hits.legacyB.length, lR: hits.legacyR.length, ipfs: hits.ipfs.length, sink: hits.sink.length};
    const b = await send('B', c); const mid = {ipfs: hits.ipfs.length, sink: hits.sink.length};
    const r = await send('R', c);
    assert.deepEqual(shape(r), shape(b), JSON.stringify(c));
    assert.equal(hits.directory.length, d, JSON.stringify(c) + ' never reaches the directory');
    assert.equal(hits.legacyR.length - s0.lR, hits.legacyB.length - s0.lB, JSON.stringify(c) + ' same control-tunnel use');
    assert.equal(hits.ipfs.length - mid.ipfs, mid.ipfs - s0.ipfs); assert.equal(hits.sink.length - mid.sink, mid.sink - s0.sink);
    rows.push({...c, status: r.status});
  }
  upstreams();
  note('legacy-corpus-identical', {cases: rows.length, statuses: rows.map(r => `${r.scheme || 'https'}://${r.host || IP}${r.path} ${r.status}`)});
});

test('directory down: 502, never a fallback to the control tunnel', async () => {
  await close(directoryServer);
  const l = hits.legacyR.length;
  for (const r of [{path: '/v1/network/providers'}, {method: 'POST', path: '/v1/network/policy/' + id, headers: {'content-type': 'application/json'}, body: '{}'}]) {
    const res = await send('R', {...r, headers: {origin: ORIGIN, ...(r.headers || {})}});
    assert.equal(res.status, 502); assert.equal(res.headers['access-control-allow-origin'], '*', 'a dashboard can read the outage');
  }
  assert.equal(hits.legacyR.length, l);
  directoryServer = createDirectoryServer(directory); trackDirectory(directoryServer); await listen(directoryServer, PORTS.directory);
  assert.equal((await send('R', {path: '/v1/network/providers', headers: {origin: ORIGIN}})).status, 200, 'recovers when the directory returns');
  note('no-fallback', {});
});

test('invariants: the directory only ever saw the public grammar, from 127.0.0.2; the control tunnel never saw a credential-free public-record request from R', () => {
  // What the directory serves is its own parse of the URL (network/directory-server.mjs: new URL(req.url).pathname).
  // Any request that is not exactly the grammar there must have been refused (4xx), never answered.
  for (const h of hits.directory) {
    assert.equal(h.remote, '127.0.0.2'); assert.ok(['GET', 'POST'].includes(h.method));
    const p = new URL(h.url, 'http://directory.local').pathname;
    if (!GRAMMAR.test(p)) { assert.ok(h.status >= 400 && h.status < 500, h.url + ' answered ' + h.status); (evidence.nonGrammarAtDirectory ||= []).push({url: h.url, status: h.status}); }
  }
  for (const h of hits.legacyR) assert.ok(!(GRAMMAR.test(h.url) && ['GET', 'POST'].includes(h.method) && !h.auth && !h.cookie), 'R leaked ' + h.method + ' ' + h.url);
  note('invariants', {directoryRequests: hits.directory.length, legacyRequestsFromR: hits.legacyR.length});
});
