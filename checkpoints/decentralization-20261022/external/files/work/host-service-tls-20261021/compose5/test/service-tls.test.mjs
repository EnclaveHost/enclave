// The service-tls host role (network/host-services/service-tls.mjs + acme-http01.mjs; work/host-service-tls-20261021, G3)
// against a FIXTURE ACME CA: an in-process RFC 8555 server (injected fetch) that verifies every JWS with jose, performs the
// http-01 validation over a real loopback connection to the role's port-80 front, and signs our CSR with an openssl
// fixture CA (root -> intermediate -> leaf). Nothing here reaches a real CA or the network.
//   - configuration: exact derived names (e49's host-service-names.mjs, pinned by sha256), "off" refused, port clashes,
//     fronted roles must run here on loopback, the runner binds it and refuses advertising it;
//   - acceptance: Node's TLS verifier + exact guards; wrong SAN, wildcard, wrong key, expired / not-yet-valid leaf,
//     non-CA intermediate, expired intermediate, untrusted root, clientAuth-only leaf are all refused;
//   - storage: one atomic key+chain document; a crash at every persistence step keeps the previous valid pair;
//   - key directory preflight: POSIX mode/owner/link, Windows ACL evaluation (the PowerShell read itself is NOT run here);
//   - ACME protocol paths: badNonce retry (once), rate limit with Retry-After, 5xx, non-JSON errors, account reuse and
//     accountDoesNotExist reset, off-origin URLs, extra identifiers, foreign authorizations, invalid authorization,
//     poll timeout, certificate 404 retry, oversized bodies, EAB demand, redirect refusal and bounded fetches;
//   - the role end to end: challenge lifecycle, raw passthrough without logging content, SNI-exact TLS, stored certificate
//     loading, renewal, a failed renewal (CA error or misissued chain) keeps the valid certificate, crash during renewal,
//     admin refusal closes everything and stops orders, no order without a fresh admit.
//   node --test test/service-tls.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { flattenedVerify, importJWK, calculateJwkThumbprint } from 'jose';
import { keccak256, toBytes } from 'viem';
import { hostServiceNames } from '../network/host-service-names.mjs';
import { hostIdOfEndpoint } from '../network/host-service-gate.mjs';
import { createAcmeClient, newKey, pemWrap, jwkThumbprint, retryAfterAt } from '../network/host-services/acme-http01.mjs';
import { validateServiceTlsConfig, bindServiceTls, validateLaunchConfig, ingressPorts, verifyCertificate, createKeyStore, checkKeyDir,
  evaluateWindowsAcl, startServiceTls, policyAdmission, SERVICE_TLS_ROLE } from '../network/host-services/service-tls.mjs';
import { validateHostServicesConfig } from '../network/host-services/runner.mjs';
import { ROLES } from '../network/host-services/roles.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(process.env.SERVICE_TLS_TMP || os.tmpdir(), 'service-tls-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const ENDPOINT = 'https://host-a.example';
const HOST_ID = hostIdOfEndpoint(ENDPOINT);
const ZONE = 'svc.example.test';
const NAMES = hostServiceNames(HOST_ID, ZONE);
const CERT_NAMES = [NAMES['directory-replica'], NAMES['bootstrap-replica']];
const fast = () => Promise.resolve();
const OP_ZONE = (zone) => ({ hostId: HOST_ID, zone, httpPort: 18280, tlsPorts: { 'directory-replica': 18288 }, ca: 'letsencrypt' });

// ---- the openssl fixture CA ---------------------------------------------------------------------------------------------
function openssl(args, input = null) {
  return new Promise((ok, no) => {
    const p = spawn('openssl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => (code === 0 ? ok(out) : no(new Error(`openssl ${args[0]}: ${err.slice(0, 300)}`))));
    p.stdin.end(input ?? '');
  });
}
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, 'Z');
let serial = 1;
const DIR = path.join(TMP, 'ca'); fs.mkdirSync(DIR);
const f = (n) => path.join(DIR, n);
async function makeCa(name, { issuer = null, ca = true, notBefore = Date.now() - 86400e3, notAfter = Date.now() + 3650 * 86400e3 } = {}) {
  await openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', f(`${name}.key`), '-subj', `/CN=Fixture ${name}`, '-out', f(`${name}.csr`)]);
  fs.writeFileSync(f(`${name}.ext`), `basicConstraints=critical,${ca ? 'CA:TRUE' : 'CA:FALSE'}\nkeyUsage=critical,keyCertSign,cRLSign,digitalSignature\nsubjectKeyIdentifier=hash\n`);
  const signer = issuer ? ['-CA', f(`${issuer}.pem`), '-CAkey', f(`${issuer}.key`)] : ['-key', f(`${name}.key`)];
  await openssl(['x509', '-req', '-in', f(`${name}.csr`), ...signer, '-extfile', f(`${name}.ext`), '-not_before', stamp(notBefore), '-not_after', stamp(notAfter), '-set_serial', String(serial++), '-out', f(`${name}.pem`)]);
  return fs.readFileSync(f(`${name}.pem`), 'utf8');
}
const ROOT = await makeCa('root');
await makeCa('int', { issuer: 'root' });
await makeCa('int-noca', { issuer: 'root', ca: false });
await makeCa('int-expired', { issuer: 'root', notBefore: Date.now() - 400 * 86400e3, notAfter: Date.now() - 30 * 86400e3 });
await makeCa('other-root');
await makeCa('other-int', { issuer: 'other-root' });
const ROOTS = [ROOT];
/** sign a CSR (PEM) as the fixture CA would; `mode` misissues on purpose */
async function signLeaf(csrPem, names, mode = null) {
  const id = serial++;
  let csr = csrPem;
  if (mode === 'wrongKey') { await openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', f(`x${id}.key`), '-subj', '/CN=x', '-out', f(`x${id}.csr`)]); csr = fs.readFileSync(f(`x${id}.csr`), 'utf8'); }
  const sans = mode === 'sanExtra' ? [...names, 'evil.example.test'] : mode === 'sanMissing' ? names.slice(1) : mode === 'wildcard' ? [`*.${ZONE}`] : names;
  const eku = mode === 'clientAuth' ? 'clientAuth' : 'serverAuth';
  fs.writeFileSync(f(`l${id}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${eku}\nsubjectAltName=${sans.map((n) => `DNS:${n}`).join(',')}\n`);
  fs.writeFileSync(f(`l${id}.csr`), csr);
  const issuer = { nonCaInt: 'int-noca', expiredInt: 'int-expired', untrusted: 'other-int' }[mode] || 'int';
  const nb = mode === 'notYetValid' ? Date.now() + 86400e3 : mode === 'expiredLeaf' ? Date.now() - 100 * 86400e3 : Date.now() - 3600e3;
  const na = mode === 'expiredLeaf' ? Date.now() - 86400e3 : nb + 90 * 86400e3;
  await openssl(['x509', '-req', '-in', f(`l${id}.csr`), '-CA', f(`${issuer}.pem`), '-CAkey', f(`${issuer}.key`), '-extfile', f(`l${id}.ext`), '-not_before', stamp(nb), '-not_after', stamp(na), '-set_serial', String(id), '-out', f(`l${id}.pem`)]);
  return fs.readFileSync(f(`l${id}.pem`), 'utf8') + fs.readFileSync(f(`${issuer}.pem`), 'utf8');
}
const csrFor = async (names, key) => pemWrap('CERTIFICATE REQUEST', (await import('../network/host-services/acme-http01.mjs')).buildCsr(names, key));
async function pairFor(names, mode = null) {
  const key = newKey();
  return { keyPem: key.export({ type: 'pkcs8', format: 'pem' }), chainPem: await signLeaf(await csrFor(names, key), names, mode) };
}

// ---- the fixture ACME CA (injected fetch) -------------------------------------------------------------------------------
const BASE = 'https://acme.fixture.test';
function fixtureCa({ validate, faults = {} } = {}) {
  const st = { nonces: new Set(), accounts: new Map(), orders: new Map(), authzs: new Map(), newAccounts: 0, newOrders: [], fetches: [], violations: [], validations: [] };
  let n = 0;
  const nonce = () => { const v = `n${++n}x${Math.random().toString(36).slice(2)}`; st.nonces.add(v); return v; };
  const res = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'replay-nonce': nonce(), 'content-type': typeof body === 'string' ? 'text/plain' : (status >= 400 ? 'application/problem+json' : 'application/json'), ...headers } });
  const problem = (status, type, detail = '', headers = {}) => res(status, { type: `urn:ietf:params:acme:error:${type}`, detail }, headers);
  const url = (p) => (faults.offOrigin === p ? `https://evil.example.test/${p}` : `${BASE}/${p}`);
  async function handle(u, init) {
    st.fetches.push(u);
    if (init.redirect !== 'error' || !init.signal) st.violations.push(`unbounded or redirecting fetch ${u}`);
    if (u === `${BASE}/directory`) {
      if (faults.oversize) return new Response('x'.repeat(300 * 1024), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ newNonce: url('nonce'), newAccount: url('acct'), newOrder: `${BASE}/order`, meta: faults.eab ? { externalAccountRequired: true } : {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u === `${BASE}/nonce`) return new Response(null, { status: 200, headers: { 'replay-nonce': nonce() } });
    // every POST: a JWS with a fresh nonce, our url, ES256, signed by the account (jose verifies it)
    const jws = JSON.parse(init.body);
    const prot = JSON.parse(Buffer.from(jws.protected, 'base64url'));
    if (prot.alg !== 'ES256' || prot.url !== u) return problem(400, 'malformed', 'bad protected header');
    if (faults.badNonce > 0) { faults.badNonce--; return problem(400, 'badNonce', 'stale'); }
    if (!st.nonces.delete(prot.nonce)) return problem(400, 'badNonce', 'unknown nonce');
    let jwk;
    if (prot.jwk) { if (u !== `${BASE}/acct`) return problem(400, 'malformed', 'jwk only on newAccount'); jwk = prot.jwk; }
    else { jwk = st.accounts.get(prot.kid); if (!jwk) return problem(400, 'accountDoesNotExist', 'no such account'); }
    try { await flattenedVerify(jws, await importJWK(jwk, 'ES256')); } catch { st.violations.push(`bad signature ${u}`); return problem(400, 'malformed', 'signature'); }
    const payload = jws.payload ? JSON.parse(Buffer.from(jws.payload, 'base64url')) : null;
    if (u === `${BASE}/acct`) {
      st.newAccounts++;
      const kid = `${BASE}/acct/${st.newAccounts}`; st.accounts.set(kid, jwk);
      return res(201, { status: 'valid' }, { location: faults.offOrigin === 'acctloc' ? 'https://evil.example.test/acct/1' : kid });
    }
    const acctKid = prot.kid;
    if (u === `${BASE}/order`) {
      if (faults.rateLimited) return problem(429, 'rateLimited', 'too many certificates already issued for this exact set: retry after 2099-01-01T00:00:00Z', { 'retry-after': '3600' });
      if (faults.serverError) return problem(500, 'serverInternal', 'oops');
      if (faults.nonJson) return new Response('<html>outage</html>', { status: 503, headers: { 'content-type': 'text/html', 'replay-nonce': nonce() } });
      if (faults.accountGone) { faults.accountGone = false; st.accounts.delete(acctKid); return problem(400, 'accountDoesNotExist', 'gone'); }
      const ids = payload.identifiers.map((i) => i.value);
      st.newOrders.push(ids);
      const oid = `o${st.orders.size + 1}`;
      const idents = faults.extraIdentifier ? [...ids, 'evil.example.test'] : ids;
      const authorizations = idents.map((name, i) => {
        const aid = `${oid}a${i}`;
        st.authzs.set(aid, { status: faults.prevalid ? 'valid' : 'pending', identifier: { type: 'dns', value: faults.foreignAuthz ? 'evil.example.test' : name }, token: `tok_${aid}_${'A'.repeat(20)}`, acct: acctKid });
        return url(`authz/${aid}`);
      });
      const order = { status: 'pending', identifiers: idents.map((value) => ({ type: 'dns', value })), authorizations, finalize: url('finalize'), names: ids, acct: acctKid };
      st.orders.set(oid, order);
      return res(201, { status: order.status, identifiers: order.identifiers, authorizations, finalize: order.finalize.replace('finalize', `finalize/${oid}`) }, { location: `${BASE}/order/${oid}` });
    }
    let m;
    if ((m = /^https:\/\/acme\.fixture\.test\/authz\/(\w+)$/.exec(u))) {
      const a = st.authzs.get(m[1]);
      return res(200, { status: a.status, identifier: a.identifier, challenges: [{ type: 'dns-01', url: `${BASE}/chall/${m[1]}/dns`, token: a.token }, { type: 'http-01', url: `${BASE}/chall/${m[1]}`, token: a.token, status: a.status }] });
    }
    if ((m = /^https:\/\/acme\.fixture\.test\/chall\/(\w+)$/.exec(u))) {
      const a = st.authzs.get(m[1]);
      if (faults.pollStuck) return res(200, { status: 'processing' });
      const expect = `${a.token}.${await calculateJwkThumbprint(st.accounts.get(a.acct))}`;
      const got = await validate(a.identifier.value, a.token);
      st.validations.push({ name: a.identifier.value, ok: got === expect });
      a.status = !faults.authzInvalid && got === expect ? 'valid' : 'invalid';
      return res(200, { status: 'processing' });
    }
    if ((m = /^https:\/\/acme\.fixture\.test\/finalize\/(\w+)$/.exec(u))) {
      const o = st.orders.get(m[1]);
      if (o.authorizations.some((x) => st.authzs.get(x.split('/').pop()).status !== 'valid')) return problem(403, 'orderNotReady', 'authorizations pending');
      // Let's Encrypt (Boulder) refuses a CSR whose signature fails or whose CN is longer than 64 bytes (X.509 ub-common-name)
      const csrPem = pemWrap('CERTIFICATE REQUEST', Buffer.from(payload.csr, 'base64url'));
      let subject; try { subject = await openssl(['req', '-noout', '-verify', '-subject', '-nameopt', 'RFC2253'], csrPem); } catch { return problem(400, 'badCSR', 'CSR signature or encoding'); }
      const cn = /CN=([^,\n]*)/.exec(subject)?.[1];
      if (cn && Buffer.byteLength(cn) > 64) { st.badCsr = (st.badCsr || 0) + 1; return problem(400, 'badCSR', 'CN was longer than 64 bytes'); }
      o.chain = await signLeaf(csrPem, o.names, faults.misissue || null);
      o.status = 'valid';
      return res(200, { status: 'processing' });
    }
    if ((m = /^https:\/\/acme\.fixture\.test\/order\/(\w+)$/.exec(u))) {
      const o = st.orders.get(m[1]);
      return res(200, { status: o.status, ...(o.status === 'valid' ? { certificate: `${BASE}/cert/${m[1]}` } : {}) });
    }
    if ((m = /^https:\/\/acme\.fixture\.test\/cert\/(\w+)$/.exec(u))) {
      if (faults.cert404 > 0) { faults.cert404--; return problem(404, 'malformed', 'Certificate not found'); }
      return new Response(st.orders.get(m[1]).chain, { status: 200, headers: { 'content-type': 'application/pem-certificate-chain', 'replay-nonce': nonce() } });
    }
    return problem(404, 'malformed', 'no such resource');
  }
  return { st, faults, fetch: async (u, init = {}) => { if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError'); return handle(String(u), init); } };
}
const memAccount = () => { let rec = null; const a = { saves: 0, forgets: 0, load: () => rec, save: (r) => { a.saves++; rec = r; }, forget: () => { a.forgets++; rec = null; } }; return a; };
const memChallenges = () => { const m = new Map(); return { m, set: (n, t, ka) => m.set(`${n}|${t}`, ka), delete: (n, t) => m.delete(`${n}|${t}`) }; };
const client = (fx, account = memAccount(), o = {}) => createAcmeClient({ directoryUrl: `${BASE}/directory`, account, fetch: fx.fetch, sleep: fast, certFetchGapMs: 0, ...o });

// ---- names and configuration --------------------------------------------------------------------------------------------
test('names: e49\'s pinned derivation, full 32-byte host id in base32, exact vectors', () => {
  const pinned = fs.readFileSync(path.join(REPO, 'network/host-service-names.mjs'));
  assert.equal(createHash('sha256').update(pinned).digest('hex'), '08bda1e6dab058cbad50eed9c4f03997dd3ae9fdfd5c021ab6fdefe785f62b80');
  const v = hostServiceNames('0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a', 'svc.enclave.host');
  assert.equal(v['directory-replica'], 'dir-f7hpjdlk22izuytea5czfmjykwlixh334uwemn3emcngrl2bir5a.svc.enclave.host');
  assert.equal(v['bootstrap-replica'], 'boot-f7hpjdlk22izuytea5czfmjykwlixh334uwemn3emcngrl2bir5a.svc.enclave.host');
  assert.equal(v['policy-mirror'], 'policy-f7hpjdlk22izuytea5czfmjykwlixh334uwemn3emcngrl2bir5a.svc.enclave.host');
  assert.equal(hostServiceNames('0x' + '01'.repeat(32), 'example.test')['directory-replica'], 'dir-aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaq.example.test');
  // the zone root chose (G3-HANDOFF): the app zone itself
  assert.equal(hostServiceNames('0x' + '01'.repeat(32), 'app.enclave.host')['policy-mirror'], 'policy-aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaq.app.enclave.host');
  assert.deepEqual(validateServiceTlsConfig({ ...OP_ZONE('app.enclave.host') }).zone, 'app.enclave.host');
});

const OP = { hostId: HOST_ID, zone: ZONE, httpPort: 18280, tlsPorts: { 'directory-replica': 18288, 'bootstrap-replica': 18289 }, ca: 'letsencrypt' };
const hostCfg = (extra = {}, op = OP) => ({ format: 'enclave-host-services/v1', host: { endpoint: ENDPOINT }, platformHostPolicy: 'production',
  packagesDir: '/opt/hs/packages', stateRoot: '/var/lib/hs', services: [
    { role: 'bootstrap-replica', package: 'sha256:' + '0'.repeat(64), config: { port: 18189, bind: '127.0.0.1', directory: '/var/lib/hs/a', manifest: '/var/lib/hs/m.json' } },
    { role: 'directory-replica', package: 'sha256:' + '1'.repeat(64), config: { port: 18188, bind: '127.0.0.1', stateDir: '/var/lib/hs/dir', rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'], addressBook: '0xab214342d5a490150a4a977063a2f88e21f80907', checkers: ['0x' + '22'.repeat(20)] } },
    { role: 'service-tls', package: 'sha256:' + '2'.repeat(64), config: op }], ...extra });

test('config: only zone/ports/ca; no secret, no names, no staging CA, distinct ports', () => {
  assert.deepEqual(validateServiceTlsConfig(OP), OP);
  assert.throws(() => validateServiceTlsConfig({ ...OP, names: ['evil.example'] }), /unknown config field "names"/);
  assert.throws(() => validateServiceTlsConfig({ ...OP, accountKey: 'x' }), /unknown config field/);
  assert.throws(() => validateServiceTlsConfig({ ...OP, ca: 'letsencrypt-staging' }), /ca must be one of letsencrypt/);
  assert.throws(() => validateServiceTlsConfig({ ...OP, ca: 'https://acme.evil/directory' }), /ca must be/);
  assert.throws(() => validateServiceTlsConfig({ ...OP, zone: 'Not A Zone' }), /lowercase DNS zone/);
  assert.throws(() => validateServiceTlsConfig({ ...OP, tlsPorts: { 'route-dns': 18291 } }), /no derived service name/);
  assert.throws(() => validateServiceTlsConfig({ ...OP, tlsPorts: { 'directory-replica': 18280 } }), /distinct/);
  assert.equal(ROLES['service-tls'], SERVICE_TLS_ROLE);
});

test('runner binding: endpoint, upstream ports, state dir and the gate\'s policy; "off", clashes and advertising refused', () => {
  const v = validateHostServicesConfig(hostCfg());
  const c = v.services.find((s) => s.role === 'service-tls').config;
  assert.deepEqual(c.host, { endpoint: ENDPOINT, hostId: HOST_ID });
  assert.deepEqual(c.upstreams, { 'directory-replica': 18188, 'bootstrap-replica': 18189 });
  assert.equal(c.stateDir, path.join('/var/lib/hs', 'service-tls'));
  assert.deepEqual(c.policy, { platformHostPolicy: 'production' });
  assert.deepEqual(validateLaunchConfig(JSON.parse(JSON.stringify(c))), c);
  // e49's G1 shape (work/host-service-transport-20261021/interface/G3-HANDOFF.txt): role ports + tls { httpPort, tlsPorts }
  assert.deepEqual(ingressPorts(c), { ports: { 'directory-replica': 18188, 'bootstrap-replica': 18189 }, tls: { httpPort: 18280, tlsPorts: { 'directory-replica': 18288, 'bootstrap-replica': 18289 } } });
  assert.equal(JSON.stringify(c).match(/PRIVATE|secret|keyPem/i), null);
  assert.throws(() => validateHostServicesConfig(hostCfg({ platformHostPolicy: 'off' })), /refused with platformHostPolicy "off"/);
  assert.throws(() => validateHostServicesConfig(hostCfg({}, { ...OP, tlsPorts: { 'policy-mirror': 18290 } })), /does not run policy-mirror/);
  assert.throws(() => validateHostServicesConfig(hostCfg({}, { ...OP, httpPort: 18188 })), /port 18188 is another role's/);
  assert.throws(() => validateHostServicesConfig(hostCfg({ host: { endpoint: ENDPOINT, publicEndpoints: { 'service-tls': ['https://x/'] } } })), /not advertised on its own/);
  const pub = hostCfg(); pub.services[0].config.bind = '10.0.0.5';
  assert.throws(() => validateHostServicesConfig(pub), /must listen on 127\.0\.0\.1 or 0\.0\.0\.0/);
  assert.throws(() => validateLaunchConfig({ ...c, host: { ...c.host, hostId: '0x' + '3'.repeat(64) } }), /keccak256 of host\.endpoint/);
  assert.throws(() => validateLaunchConfig({ ...c, policy: { platformHostPolicy: 'off' } }), /"off" is refused/);
  // B7 (root correction): the registry id = keccak256 of the endpoint bytes EXACTLY as registered is the authority. A host
  // validly registered WITH a trailing slash is accepted with its exact id (no rewrite); any other id is refused.
  const slashId = keccak256(toBytes(ENDPOINT + '/'));
  assert.notEqual(slashId, HOST_ID);
  const slash = validateHostServicesConfig(hostCfg({ host: { endpoint: ENDPOINT + '/' } }, { ...OP, hostId: slashId })).services.find((x) => x.role === 'service-tls').config;
  assert.deepEqual(slash.host, { endpoint: ENDPOINT + '/', hostId: slashId }, 'kept byte for byte');
  assert.equal(validateLaunchConfig(JSON.parse(JSON.stringify(slash))).hostId, slashId);
  assert.notDeepEqual(hostServiceNames(slashId, ZONE), NAMES, 'the names follow the registry id');
  assert.throws(() => validateHostServicesConfig(hostCfg({ host: { endpoint: ENDPOINT + '/' } })), /keccak256 of host\.endpoint exactly as registered/, 'the stripped id is not this host\'s');
  assert.throws(() => validateHostServicesConfig(hostCfg({}, { ...OP, hostId: slashId })), /exactly as registered/);
  assert.throws(() => validateHostServicesConfig(hostCfg({}, { ...OP, hostId: hostIdOfEndpoint('https://host-b.example') })), /exactly as registered/);
  assert.throws(() => validateLaunchConfig({ ...slash, host: { ...slash.host, endpoint: ENDPOINT } }), /keccak256 of host\.endpoint/);
  assert.throws(() => validateServiceTlsConfig({ ...OP, hostId: '0x' + '0'.repeat(64) }), /registry id/);
  assert.throws(() => validateServiceTlsConfig({ ...OP, hostId: HOST_ID.toUpperCase().replace('0X', '0x') }), /registry id/);
});

test('G1 contract: e49\'s host-service transport accepts ingressPorts() and routes 80 -> httpPort, 443 -> tlsPorts[role] for the SAME names', async (t) => {
  let g1; try { g1 = await import('../network/host-service-transport.mjs'); } catch { return t.skip('e49\'s network/host-service-transport.mjs is not in this tree (it is in the integration tree)'); }
  const c = validateHostServicesConfig(hostCfg()).services.find((x) => x.role === 'service-tls').config;
  const ip = ingressPorts(c);
  const config = { zone: c.zone, exits: ['a'.repeat(16)], ...ip };
  assert.deepEqual(g1.validateHostServicesTransport(config).tls, ip.tls);
  const tr = new g1.HostServiceTransport({ runtime: null, providers: null, grants: null, hostId: c.hostId, config });
  const names = hostServiceNames(c.hostId, c.zone);
  assert.deepEqual(tr.names, { [names['directory-replica']]: { http: 18280, tls: 18288 }, [names['bootstrap-replica']]: { http: 18280, tls: 18289 } });
  assert.deepEqual(Object.keys(tr.names).sort(), [...CERT_NAMES].sort(), 'the names G1 routes are exactly the names G3 certifies');
  // without G3 (no tls block): port 80 goes straight to each role port and 443 is closed (the behaviour, not the
  // normalized representation: e49 rev4 omits an absent tls instead of returning null)
  const { tls: _omit, ...plain } = config;
  const bare = new g1.HostServiceTransport({ runtime: null, providers: null, grants: null, hostId: c.hostId, config: plain });
  assert.deepEqual(bare.names, { [names['directory-replica']]: { http: 18188, tls: null }, [names['bootstrap-replica']]: { http: 18189, tls: null } });
  assert.ok(g1.validateHostServicesTransport(plain).tls == null);
});

// ---- acceptance ---------------------------------------------------------------------------------------------------------
test('acceptance: Node\'s TLS verifier + exact guards accept only the exact, valid, trusted pair', async () => {
  const good = await pairFor(CERT_NAMES);
  const info = await verifyCertificate({ names: CERT_NAMES, ...good, roots: ROOTS });
  assert.ok(info.notBefore < Date.now() && info.renewAt < info.notAfter && /^[0-9A-F:]+$/.test(info.fingerprint));
  // the production trust store does not know the fixture root: no bypass
  await assert.rejects(verifyCertificate({ names: CERT_NAMES, ...good }), /TLS verifier/);
  await assert.rejects(verifyCertificate({ names: [...CERT_NAMES, NAMES['policy-mirror']], ...good, roots: ROOTS }), /SAN set/);
  const other = await pairFor(CERT_NAMES);
  await assert.rejects(verifyCertificate({ names: CERT_NAMES, keyPem: other.keyPem, chainPem: good.chainPem, roots: ROOTS }), /does not hold our key/);
  await assert.rejects(verifyCertificate({ names: CERT_NAMES, keyPem: 'garbage', chainPem: good.chainPem, roots: ROOTS }), /unparseable/);
  await assert.rejects(verifyCertificate({ names: CERT_NAMES, ...good, roots: ROOTS, now: info.notAfter + 1 }), /validity/);
  const cases = { sanExtra: /SAN set/, sanMissing: /SAN set/, wildcard: /SAN set/, wrongKey: /does not hold our key/, expiredLeaf: /validity/, notYetValid: /validity/,
    clientAuth: /serverAuth/, nonCaInt: /TLS verifier/, expiredInt: /TLS verifier/, untrusted: /TLS verifier/ };
  for (const [mode, re] of Object.entries(cases)) await assert.rejects(verifyCertificate({ names: CERT_NAMES, ...(await pairFor(CERT_NAMES, mode)), roots: ROOTS }), re, mode);
});

test('acceptance: the verifier itself (not only the guards) refuses a bad intermediate and an expired chain member', async () => {
  // guards pass for these (exact SAN, our key, leaf in validity, serverAuth): only OpenSSL's path validation can refuse
  for (const mode of ['nonCaInt', 'expiredInt', 'untrusted']) {
    const p = await pairFor(CERT_NAMES, mode);
    const leaf = new X509Certificate(p.chainPem);
    assert.equal(leaf.subjectAltName, CERT_NAMES.map((n) => `DNS:${n}`).join(', '));
    await assert.rejects(verifyCertificate({ names: CERT_NAMES, ...p, roots: ROOTS }), (e) => /refused by the TLS verifier/.test(e.message), mode);
  }
});

// ---- storage ------------------------------------------------------------------------------------------------------------
function crashingFs(step, { partial = false } = {}) {
  let crashed = false;
  const die = (op) => { crashed = true; const e = new Error(`simulated crash at ${op}`); e.code = 'ECRASH'; throw e; };
  return new Proxy(fs, { get(t, k) {
    const real = t[k];
    if (typeof real !== 'function') return real;
    return (...a) => {
      if (crashed && ['unlinkSync', 'writeSync', 'renameSync', 'fsyncSync', 'openSync'].includes(k)) die(`${k} after the crash`);
      if (k === step.op && (step.match ? step.match(a) : true) && --step.n === 0) {
        if (k === 'writeSync' && partial) real.call(t, a[0], String(a[1]).slice(0, 40));
        die(k);
      }
      return real.apply(t, a);
    };
  } });
}
test('storage: one atomic key+chain document; a crash at every step keeps the previous pair, never a mismatch', async () => {
  const A = await pairFor(CERT_NAMES), B = await pairFor(CERT_NAMES);
  const steps = [
    { op: 'openSync', n: 1, expect: 'A' }, { op: 'writeSync', n: 1, expect: 'A' }, { op: 'writeSync', n: 1, expect: 'A', partial: true },
    { op: 'fsyncSync', n: 1, expect: 'A' }, { op: 'closeSync', n: 1, expect: 'A' }, { op: 'renameSync', n: 1, expect: 'A' },
    { op: 'openSync', n: 2, expect: 'B' },                    // after the rename: the directory fsync
  ];
  for (const s of steps) {
    const dir = fs.mkdtempSync(path.join(TMP, 'store-'));
    createKeyStore(dir).writeDoc(A.keyPem, A.chainPem);
    assert.throws(() => createKeyStore(dir, { fsx: crashingFs({ ...s }, { partial: s.partial }) }).writeDoc(B.keyPem, B.chainPem), /simulated crash/);
    const after = createKeyStore(dir);                           // the restarted process
    after.cleanup();
    assert.deepEqual(fs.readdirSync(dir).sort(), ['current.pem'], `${s.op}#${s.n}: leftovers cleaned`);
    const doc = after.readDoc();
    assert.deepEqual(doc, s.expect === 'A' ? { keyPem: A.keyPem, chainPem: A.chainPem } : { keyPem: B.keyPem, chainPem: B.chainPem }, `${s.op}#${s.n}${s.partial ? ' partial' : ''}`);
    await verifyCertificate({ names: CERT_NAMES, ...doc, roots: ROOTS });
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'current.pem')).mode & 0o777, 0o600);
  }
});

// ---- key directory preflight --------------------------------------------------------------------------------------------
test('key directory: private POSIX directory only; Windows ACL limited to SYSTEM/Administrators/LOCAL SERVICE', async () => {
  const ok = path.join(TMP, 'keys-ok');
  assert.deepEqual(await checkKeyDir(ok), { platform: process.platform, mode: '700', ownerIsSelf: true });
  const wide = path.join(TMP, 'keys-wide'); fs.mkdirSync(wide, { mode: 0o700 }); fs.chmodSync(wide, 0o755);
  await assert.rejects(checkKeyDir(wide), /mode 755: group\/other access is refused/);
  assert.equal(fs.statSync(wide).mode & 0o777, 0o755, 'nothing repaired silently');
  await assert.rejects(checkKeyDir(ok, { getuid: () => 4242 }), /owned by another user/);
  const link = path.join(TMP, 'keys-link'); fs.symlinkSync(ok, link);
  await assert.rejects(checkKeyDir(link), /not a directory/);
  // Windows: the hs2 installer's state ACL (SYSTEM F, Administrators F, LOCAL SERVICE M; inherited) is accepted
  const hs2 = { owner: 'S-1-5-19', rules: [{ sid: 'S-1-5-18', allow: true, rights: 2032127, inherited: true }, { sid: 'S-1-5-32-544', allow: true, rights: 2032127, inherited: true },
    { sid: 'S-1-5-19', allow: true, rights: 1245631, inherited: true }, { sid: 'S-1-3-0', allow: true, rights: 268435456, inherited: true }] };
  assert.deepEqual(evaluateWindowsAcl(hs2), { platform: 'win32', owner: 'S-1-5-19', sids: ['S-1-3-0', 'S-1-5-18', 'S-1-5-19', 'S-1-5-32-544'] });
  for (const sid of ['S-1-5-32-545', 'S-1-1-0', 'S-1-5-11', 'S-1-5-21-1-2-3-1001']) assert.throws(() => evaluateWindowsAcl({ ...hs2, rules: [...hs2.rules, { sid, allow: true, rights: 1179817, inherited: true }] }), new RegExp(`grants access to ${sid}`));
  assert.deepEqual(evaluateWindowsAcl({ ...hs2, rules: [...hs2.rules, { sid: 'S-1-1-0', allow: false, rights: 2032127, inherited: false }] }).sids.includes('S-1-1-0'), false);
  assert.throws(() => evaluateWindowsAcl({ ...hs2, owner: 'S-1-5-21-1-2-3-1001' }), /owner/);
  assert.throws(() => evaluateWindowsAcl({ ...hs2, rules: hs2.rules.filter((r) => r.sid !== 'S-1-5-19') }), /LOCAL SERVICE nothing/);
  const wdir = path.join(TMP, 'keys-win');
  assert.equal((await checkKeyDir(wdir, { platform: 'win32', windowsAcl: async () => hs2 })).owner, 'S-1-5-19');
  await assert.rejects(checkKeyDir(wdir, { platform: 'win32', windowsAcl: async () => { throw new Error('access denied'); } }), /ACL preflight failed: access denied/);
});

// ---- ACME protocol paths ------------------------------------------------------------------------------------------------
const autoValid = (ch) => async (name, token) => ch.m.get(`${name}|${token}`) ?? null;
test('csr: no CN over 64 bytes (the derived names are longer): empty subject, names only in the SAN; a short name keeps its CN', async () => {
  const { buildCsr } = await import('../network/host-services/acme-http01.mjs');
  assert.ok(CERT_NAMES.every((n) => n.length > 64), 'derived names exceed ub-common-name');
  const long = await openssl(['req', '-noout', '-verify', '-subject', '-text'], pemWrap('CERTIFICATE REQUEST', buildCsr(CERT_NAMES, newKey())));
  assert.doesNotMatch(long, /CN\s*=/);
  for (const n of CERT_NAMES) assert.match(long, new RegExp(`DNS:${n.replace(/\./g, '\\.')}`));
  const short = await openssl(['req', '-noout', '-verify', '-subject'], pemWrap('CERTIFICATE REQUEST', buildCsr(['a.example.test', ...CERT_NAMES], newKey())));
  assert.match(short, /CN\s*=\s*a\.example\.test/);
});

test('acme: a full order, every JWS verified by jose, our thumbprint equals jose\'s, the account is persisted and reused', async () => {
  const ch = memChallenges(), fx = fixtureCa({ validate: autoValid(ch) }), acct = memAccount();
  const c = client(fx, acct);
  const chain = await c.issue(CERT_NAMES, { key: newKey(), challenges: ch });
  assert.match(chain, /BEGIN CERTIFICATE/);
  assert.deepEqual(fx.st.violations, []);
  assert.equal(fx.st.badCsr, undefined, 'the CA accepted our CSR');
  assert.deepEqual(fx.st.newOrders, [CERT_NAMES]);
  assert.deepEqual(fx.st.validations.map((v) => v.ok), [true, true]);
  assert.equal(ch.m.size, 0, 'challenge answers removed after validation');
  const jwk = fx.st.accounts.get(acct.load().kid);
  assert.equal(jwkThumbprint(jwk), await calculateJwkThumbprint(jwk));
  assert.equal(fx.st.newAccounts, 1);
  await createAcmeClient({ directoryUrl: `${BASE}/directory`, account: acct, fetch: fx.fetch, sleep: fast }).issue(CERT_NAMES, { key: newKey(), challenges: ch });
  assert.equal(fx.st.newAccounts, 1, 'a restarted client reuses the stored account');
});

test('acme: protocol error paths', async (t) => {
  const run = async (faults, o = {}) => { const ch = memChallenges(), fx = fixtureCa({ validate: autoValid(ch), faults }); const acct = o.account || memAccount();
    const p = client(fx, acct, o.client).issue(o.names || CERT_NAMES, { key: newKey(), challenges: ch }); return { p, fx, ch, acct }; };
  await t.test('one badNonce is retried', async () => { const { p, fx } = await run({ badNonce: 1 }); await p; assert.equal(fx.st.newOrders.length, 1); });
  await t.test('a second badNonce in a row fails', async () => { const { p } = await run({ badNonce: 2 }); await assert.rejects(p, /ACME 400: urn:ietf:params:acme:error:badNonce/); });
  await t.test('rate limit carries the later of Retry-After and the detail date', async () => {
    const { p } = await run({ rateLimited: true });
    await assert.rejects(p, (e) => e.status === 429 && /rateLimited/.test(e.type) && e.retryAt > Date.now() + 3500e3);
    assert.equal(retryAfterAt('', '120', 1000), 121000);
    assert.equal(retryAfterAt('retry after 2099-01-01T00:00:00Z', '', 0), 7 * 86400e3, 'capped at a week');
  });
  await t.test('5xx and non-JSON errors', async () => {
    await assert.rejects((await run({ serverError: true })).p, (e) => e.status === 500);
    await assert.rejects((await run({ nonJson: true })).p, (e) => e.status === 503 && /non-JSON/.test(e.message));
  });
  await t.test('accountDoesNotExist forgets the stored account; the next order registers afresh', async () => {
    const ch = memChallenges(), fx = fixtureCa({ validate: autoValid(ch), faults: { accountGone: true } }), acct = memAccount();
    const c = client(fx, acct);
    await assert.rejects(c.issue(CERT_NAMES, { key: newKey(), challenges: ch }), /accountDoesNotExist/);
    assert.equal(acct.forgets, 1); assert.equal(acct.load(), null);
    await c.issue(CERT_NAMES, { key: newKey(), challenges: ch });
    assert.equal(fx.st.newAccounts, 2);
  });
  await t.test('URLs off the directory\'s origin are refused before use', async () => {
    await assert.rejects((await run({ offOrigin: 'acct' })).p, /newAccount is not on the directory's origin/);
    await assert.rejects((await run({ offOrigin: 'acctloc' })).p, /account location is not on the directory's origin/);
    const r = await run({ offOrigin: 'finalize' });
    await assert.rejects(r.p, /finalize is not on the directory's origin/);
    assert.ok(!r.fx.st.fetches.some((u) => u.includes('evil')));
  });
  await t.test('an order for other identifiers, or a foreign authorization, is refused; no challenge is answered', async () => {
    const a = await run({ extraIdentifier: true }); await assert.rejects(a.p, /order names other identifiers/); assert.equal(a.fx.st.validations.length, 0);
    const b = await run({ foreignAuthz: true }); await assert.rejects(b.p, /authorization is for another identifier/); assert.equal(b.fx.st.validations.length, 0);
  });
  await t.test('an invalid authorization fails the order and removes the challenge answer', async () => {
    const r = await run({ authzInvalid: true }); await assert.rejects(r.p, /became invalid/); assert.equal(r.ch.m.size, 0);
  });
  await t.test('a poll that never completes gives up', async () => {
    let clock = 0; const r = await run({ pollStuck: true }, { client: { now: () => (clock += 20_000), pollMs: 90_000 } });
    await assert.rejects(r.p, /still pending after 90 s/); assert.equal(r.ch.m.size, 0);
  });
  await t.test('certificate 404 is retried, then succeeds', async () => { const { p } = await run({ cert404: 2 }); assert.match(await p, /BEGIN CERTIFICATE/); });
  await t.test('an oversized body is refused', async () => { await assert.rejects((await run({ oversize: true })).p, /over 262144 bytes/); });
  await t.test('a CA demanding External Account Binding is refused (no CA credential here)', async () => { await assert.rejects((await run({ eab: true })).p, /External Account Binding/); });
  await t.test('an already-valid authorization needs no challenge', async () => { const r = await run({ prevalid: true }); await r.p; assert.equal(r.fx.st.validations.length, 0); });
  await t.test('an aborted order stops at the next CA call', async () => {
    const ch = memChallenges(), fx = fixtureCa({ validate: autoValid(ch) }), ac = new AbortController(); ac.abort();
    await assert.rejects(client(fx).issue(CERT_NAMES, { key: newKey(), challenges: ch, signal: ac.signal }), /abort/i);
    assert.equal(fx.st.newOrders.length, 0);
  });
  await t.test('every CA call was bounded and refused redirects', async () => { const { p, fx } = await run({}); await p; assert.deepEqual(fx.st.violations, []); });
});

// ---- the role end to end ------------------------------------------------------------------------------------------------
async function upstream(role) {
  const u = { role, got: [] };
  u.server = net.createServer((s) => { s.on('data', (d) => { u.got.push(d.toString('latin1')); s.write(`UPSTREAM ${role} ${d.length}\n`); }); s.on('error', () => {}); });
  await new Promise((ok) => u.server.listen(0, '127.0.0.1', ok));
  u.port = u.server.address().port;
  return u;
}
function raw(port, text, { wait = 300 } = {}) {
  return new Promise((ok, no) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let out = ''; s.on('data', (d) => { out += d; }); s.on('error', no);
    s.on('close', () => ok(out)); setTimeout(() => { s.destroy(); ok(out); }, wait);
  });
}
const httpGet = (port, host, target) => raw(port, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
function tlsTalk(port, servername, payload = 'ping') {
  return new Promise((ok, no) => {
    const s = tls.connect({ port, host: '127.0.0.1', ...(servername ? { servername } : {}), ca: ROOTS, rejectUnauthorized: true, ALPNProtocols: ['h2', 'http/1.1'] }, () => {
      const fp = s.getPeerCertificate().fingerprint256; s.write(payload);
      s.once('data', (d) => { s.end(); ok({ fp, reply: String(d), alpn: s.alpnProtocol, version: s.getProtocol() }); });
    });
    s.on('error', no); setTimeout(() => { s.destroy(); no(new Error('tls timeout')); }, 3000);
  });
}
async function harness(o = {}) {
  const ups = { 'directory-replica': await upstream('dir'), 'bootstrap-replica': await upstream('boot'), 'policy-mirror': await upstream('policy') };
  const stateDir = o.stateDir || fs.mkdtempSync(path.join(TMP, 'role-'));
  const c = { hostId: HOST_ID, zone: ZONE, httpPort: 0, tlsPorts: { 'directory-replica': 0, 'bootstrap-replica': 0 }, ca: 'letsencrypt', host: { endpoint: ENDPOINT, hostId: HOST_ID },
    upstreams: Object.fromEntries(Object.entries(ups).map(([r, u]) => [r, u.port])), stateDir, policy: { platformHostPolicy: 'production' } };
  const h = { ups, stateDir, logs: [], decision: { admit: true, status: 'admitted' }, admits: 0, clock: null };
  let role = null;
  // a restart keeps talking to the SAME CA (its stored account is known there)
  const fx = o.fx || fixtureCa({ faults: o.faults || {}, validate: (name, token) => fx.validator(name, token) });
  h.crossProbes = [];
  fx.validator = async (name, token) => {
    const target = `/.well-known/acme-challenge/${token}`;
    // while the token is pending: the SAME token under another name of this host, or an unknown Host, gets no answer
    const other = CERT_NAMES.find((n) => n !== name);
    h.crossProbes.push((await httpGet(role.ports.http, other, target)).split('\r\n')[0], (await httpGet(role.ports.http, 'evil.example.test', target)).split('\r\n')[0]);
    const r = await httpGet(role.ports.http, name, target);
    return r.startsWith('HTTP/1.1 200') ? r.split('\r\n\r\n')[1] : null;
  };
  h.fx = fx;
  h.admit = async () => { h.admits++; if (h.decision instanceof Error) throw h.decision; return h.decision; };
  role = await startServiceTls(c, { admit: h.admit, directoryUrl: `${BASE}/directory`, fetch: fx.fetch, roots: ROOTS, loop: false, log: (m) => h.logs.push(m),
    now: () => h.clock ?? Date.now(), fsx: o.fsx || fs, ...(o.budget ? { budget: o.budget } : {}), acmeOptions: { sleep: () => new Promise((ok) => setImmediate(ok)), certFetchGapMs: 0 } });
  h.role = role;
  h.close = async () => { await role.stop(); for (const u of Object.values(ups)) u.server.close(); };
  return h;
}

test('role: admitted host -> challenge lifecycle on port 80, exact certificate, SNI-exact TLS to the role, raw passthrough, no content logged', async () => {
  const h = await harness();
  try {
    const { role, ups, fx } = h;
    assert.equal(role.status().listening.http, true);
    assert.deepEqual(role.status().listening.tls, { 'directory-replica': false, 'bootstrap-replica': false }, 'no TLS before a certificate');
    await role.tick();
    assert.deepEqual(fx.st.newOrders, [CERT_NAMES], 'exactly this host\'s names, one order');
    assert.deepEqual(fx.st.validations, CERT_NAMES.map((name) => ({ name, ok: true })), 'http-01 validated through the real port-80 front');
    assert.deepEqual(h.crossProbes, ['HTTP/1.1 404 Not Found', 'HTTP/1.1 421 Misdirected Request', 'HTTP/1.1 404 Not Found', 'HTTP/1.1 421 Misdirected Request'],
      'a pending answer is served only for its exact name');
    const s = role.status();
    assert.ok(s.certificate && s.listening.tls['directory-replica'] && s.listening.tls['bootstrap-replica']);
    // the stored document holds key + chain; it verifies
    const doc = createKeyStore(path.join(h.stateDir, 'keys')).readDoc();
    await verifyCertificate({ names: CERT_NAMES, ...doc, roots: ROOTS });
    // the challenge answer is gone after validation; any unknown token -> 404, never forwarded to the role
    const before = ups['directory-replica'].got.length;
    assert.match(await httpGet(role.ports.http, NAMES['directory-replica'], '/.well-known/acme-challenge/tok_o1a0_AAAAAAAAAAAAAAAAAAAA'), /^HTTP\/1\.1 404/);
    assert.equal(ups['directory-replica'].got.length, before);
    // passthrough: byte-exact to the right role, credentials untouched and never logged
    const req = `POST /v1/x?q=1 HTTP/1.1\r\nHost: ${NAMES['directory-replica']}\r\nAuthorization: Bearer sekrit-token\r\nCookie: sid=cookie-value\r\ncontent-length: 4\r\n\r\nbody`;
    assert.match(await raw(role.ports.http, req), /^UPSTREAM dir /);
    assert.equal(ups['directory-replica'].got.join(''), req);
    assert.match(await httpGet(role.ports.http, `${NAMES['policy-mirror']}:80`, '/platform-policy/x'), /^UPSTREAM policy/, 'port 80 fronts every role this host runs');
    // unknown / other-host / missing Host -> no route
    const otherHost = hostServiceNames(hostIdOfEndpoint('https://host-b.example'), ZONE)['directory-replica'];
    for (const host of [otherHost, 'evil.example.test', `dir-x.${ZONE}`]) assert.match(await httpGet(role.ports.http, host, '/'), /^HTTP\/1\.1 421/);
    assert.match(await raw(role.ports.http, 'GET / HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 400/);
    assert.match(await raw(role.ports.http, `GET / HTTP/1.1\r\nHost: a\r\nX: ${'y'.repeat(17000)}`), /^HTTP\/1\.1 431/);
    // TLS: exact SNI only, the issued certificate, ALPN http/1.1, TLS >= 1.2, raw pipe to the role
    const t1 = await tlsTalk(role.ports.tls['directory-replica'], NAMES['directory-replica'], 'GET / HTTP/1.1\r\nAuthorization: Bearer sekrit-token\r\n\r\n');
    assert.equal(t1.fp, s.certificate.fingerprint); assert.match(t1.reply, /^UPSTREAM dir/); assert.equal(t1.alpn, 'http/1.1'); assert.match(t1.version, /^TLSv1\.[23]$/);
    assert.match((await tlsTalk(role.ports.tls['bootstrap-replica'], NAMES['bootstrap-replica'])).reply, /^UPSTREAM boot/);
    await assert.rejects(tlsTalk(role.ports.tls['directory-replica'], NAMES['bootstrap-replica']), 'another role\'s name on this port');
    await assert.rejects(tlsTalk(role.ports.tls['directory-replica'], 'evil.example.test'));
    await assert.rejects(tlsTalk(role.ports.tls['directory-replica'], null), 'no SNI: no default certificate');
    const logs = h.logs.join('\n');
    for (const secret of ['sekrit', 'cookie-value', '/v1/x', 'Authorization', 'PRIVATE KEY']) assert.ok(!logs.includes(secret), `log carries no ${secret}`);
    assert.deepEqual(fx.st.violations, []);
  } finally { await h.close(); }
});

test('role: a stored valid certificate is loaded and served without an order; renewal at 2/3 replaces it', async () => {
  const first = await harness(); await first.role.tick(); const fp1 = first.role.status().certificate.fingerprint; await first.close();
  const h = await harness({ stateDir: first.stateDir, fx: first.fx });
  try {
    assert.equal(h.role.status().certificate.fingerprint, fp1);
    assert.equal(h.role.status().listening.tls['directory-replica'], true, 'serving right after the admit');
    await h.role.tick();
    assert.equal(h.fx.st.newOrders.length, 1, 'no order while the certificate is fresh (only the first instance\'s)');
    assert.equal(h.fx.st.newAccounts, 1);
    h.clock = h.role.status().certificate.renewAt + 1000;
    await h.role.tick();
    assert.equal(h.fx.st.newOrders.length, 2, 'renewed at 2/3 of the lifetime');
    assert.equal(h.fx.st.newAccounts, 1, 'with the stored account');
    const fp2 = h.role.status().certificate.fingerprint;
    assert.notEqual(fp2, fp1);
    assert.equal((await tlsTalk(h.role.ports.tls['directory-replica'], NAMES['directory-replica'])).fp, fp2, 'new handshakes get the renewed certificate');
  } finally { await h.close(); }
});

test('role: a failed renewal keeps the valid certificate serving and backs off 15 min, doubling', async () => {
  const h = await harness({ budget: { count: 100, windowMs: 7 * 86400e3 } });   // misissued chains count; the budget is tested below
  try {
    await h.role.tick();
    const fp = h.role.status().certificate.fingerprint, renewAt = h.role.status().certificate.renewAt;
    const doc = fs.readFileSync(path.join(h.stateDir, 'keys', 'current.pem'), 'utf8');
    for (const [faults, re] of [[{ serverError: true }, /ACME 500/], [{ authzInvalid: true }, /became invalid/], [{ misissue: 'sanExtra' }, /SAN set/],
      [{ misissue: 'expiredInt' }, /TLS verifier/], [{ misissue: 'wrongKey' }, /does not hold our key/]]) {
      Object.assign(h.fx.faults, { serverError: false, authzInvalid: false, misissue: null }, faults);
      h.clock = Math.max(renewAt + 1000, h.role.status().nextAt);
      const failures = h.role.status().failures;
      await h.role.tick();
      const s = h.role.status();
      assert.match(s.lastError, re);
      assert.equal(s.failures, failures + 1);
      assert.equal(s.nextAt - h.clock, Math.min(24 * 3600e3, 15 * 60e3 * 2 ** failures), 'backoff 15 min doubling');
      assert.equal(s.certificate.fingerprint, fp, 'still the valid certificate');
      assert.equal(fs.readFileSync(path.join(h.stateDir, 'keys', 'current.pem'), 'utf8'), doc, 'the stored pair is untouched');
      assert.equal((await tlsTalk(h.role.ports.tls['directory-replica'], NAMES['directory-replica'])).fp, fp);
      const orders = h.fx.st.newOrders.length; await h.role.tick();
      assert.equal(h.fx.st.newOrders.length, orders, 'no new order before the backoff ends');
    }
    Object.assign(h.fx.faults, { misissue: null, rateLimited: true });
    h.clock = h.role.status().nextAt;
    await h.role.tick();
    assert.ok(h.role.status().nextAt >= Date.parse('2099-01-01T00:00:00Z') || h.role.status().nextAt >= h.clock + 3600e3, 'the CA\'s retry-after is honoured');
  } finally { await h.close(); }
});

test('role: a crash while saving a renewed certificate keeps the previous valid pair for the restart', async () => {
  const first = await harness(); await first.role.tick(); const fp1 = first.role.status().certificate.fingerprint; const renewAt = first.role.status().certificate.renewAt; await first.close();
  const fsx = crashingFs({ op: 'renameSync', n: 1, match: (a) => String(a[1]).endsWith('current.pem') });
  const h = await harness({ stateDir: first.stateDir, fsx, fx: first.fx });
  try {
    h.clock = renewAt + 1000;
    await h.role.tick();
    const s = h.role.status();
    assert.notEqual(s.certificate.fingerprint, fp1, 'the new pair serves from memory');
    assert.equal(s.unsaved, true);
    assert.ok(h.logs.some((l) => /saving the new certificate failed/.test(l)));
  } finally { await h.close(); }
  const restarted = await harness({ stateDir: first.stateDir, fx: first.fx });
  try {
    assert.equal(restarted.role.status().certificate.fingerprint, fp1, 'the restart loads the previous valid pair');
    assert.equal((await tlsTalk(restarted.role.ports.tls['directory-replica'], NAMES['directory-replica'])).fp, fp1);
  } finally { await restarted.close(); }
});

test('role: an invalid stored certificate is not used and a new one is ordered', async () => {
  const stateDir = fs.mkdtempSync(path.join(TMP, 'role-'));
  fs.mkdirSync(path.join(stateDir, 'keys'), { mode: 0o700 });
  const bad = await pairFor(CERT_NAMES, 'expiredLeaf');
  createKeyStore(path.join(stateDir, 'keys')).writeDoc(bad.keyPem, bad.chainPem);
  const h = await harness({ stateDir });
  try {
    assert.equal(h.role.status().certificate, null);
    assert.ok(h.logs.some((l) => /stored certificate is not used \(certificate: outside its validity period\)/.test(l)));
    await h.role.tick();
    assert.ok(h.role.status().certificate);
  } finally { await h.close(); }
});

test('role: an admin refusal closes every listener, aborts and stops orders; a later admit resumes', async () => {
  const h = await harness();
  try {
    await h.role.tick();
    const ports = h.role.ports;
    h.decision = { admit: false, status: 'banned', reason: 'host is banned by the platform host policy' };
    await h.role.checkPolicy();
    const s = h.role.status();
    assert.equal(s.refused, 'host is banned by the platform host policy');
    assert.deepEqual(s.listening, { http: false, tls: { 'directory-replica': false, 'bootstrap-replica': false } });
    await assert.rejects(tlsTalk(ports.tls['directory-replica'], NAMES['directory-replica']), /ECONNREFUSED/);
    assert.equal(await raw(ports.http, `GET / HTTP/1.1\r\nHost: ${NAMES['directory-replica']}\r\n\r\n`).catch((e) => e.code), 'ECONNREFUSED');
    h.clock = s.certificate.renewAt + 1000;
    const orders = h.fx.st.newOrders.length;
    await h.role.tick();
    assert.equal(h.fx.st.newOrders.length, orders, 'no renewal while refused');
    // a transient policy error changes nothing (still refused, still no order)
    h.decision = new Error('rpc quorum unavailable');
    await h.role.checkPolicy(); await h.role.tick();
    assert.equal(h.role.status().refused, 'host is banned by the platform host policy');
    assert.equal(h.fx.st.newOrders.length, orders);
    h.decision = { admit: true, status: 'admitted' };
    await h.role.checkPolicy();
    assert.equal(h.role.status().listening.http, true);
    await h.role.tick();
    assert.equal(h.fx.st.newOrders.length, orders + 1, 'renewal resumes after the admit');
  } finally { await h.close(); }
});

test('role: an order in flight is aborted by a refusal and nothing is installed', async () => {
  const h = await harness();
  try {
    h.fx.faults.pollStuck = true;                               // the authorization never completes
    const tick = h.role.tick();
    await new Promise((ok) => setTimeout(ok, 50));
    h.decision = { admit: false, status: 'not-allowed', reason: 'allowlist miss' };
    await h.role.checkPolicy();
    await tick;
    assert.equal(h.role.status().certificate, null);
    assert.match(h.role.status().lastError, /abort/i);
    assert.equal(h.role.status().listening.http, false);
  } finally { await h.close(); }
});

test('role: no order without a FRESH admit right before it; nothing listens before the first admit', async () => {
  const h = await harness();
  try {
    h.decision = new Error('rpc quorum unavailable');
    await h.role.tick();                                         // admitted at start; the pre-order admit fails
    assert.equal(h.fx.st.newOrders.length, 0);
    assert.match(h.role.status().lastError, /platform host policy unavailable/);
    h.decision = { admit: false, status: 'inactive', reason: 'host registry entry is not active' };
    h.clock = h.role.status().nextAt;
    await h.role.tick();
    assert.equal(h.fx.st.newOrders.length, 0);
    assert.equal(h.role.status().refused, 'host registry entry is not active');
  } finally { await h.close(); }
  const stateDir = fs.mkdtempSync(path.join(TMP, 'role-'));
  const cold = await startServiceTls({ hostId: HOST_ID, zone: ZONE, httpPort: 0, tlsPorts: { 'directory-replica': 0 }, ca: 'letsencrypt', host: { endpoint: ENDPOINT, hostId: HOST_ID },
    upstreams: { 'directory-replica': 1 }, stateDir, policy: { platformHostPolicy: 'production' } }, { admit: async () => { throw new Error('rpc down'); }, loop: false, log: () => {} });
  assert.deepEqual(cold.status().listening, { http: false, tls: { 'directory-replica': false } });
  await cold.tick();
  assert.equal(cold.status().orders, 0);
  await cold.stop();
  // the real production admission over an unreachable quorum is an error, never an admit
  const admit = await policyAdmission({ hostId: HOST_ID, host: { hostId: HOST_ID }, stateDir, policy: { platformHostPolicy: { book: '0x' + '11'.repeat(20), hostOwnership: '0x' + '12'.repeat(20), mirrors: [], rpcs: ['http://127.0.0.1:9'], minAgree: 1, activation: 'required' } } });
  await assert.rejects(admit());
});

test('role: a "not-activated" platform policy is the runtime\'s own admit (today\'s behaviour, reported)', async () => {
  const h = await harness();
  try {
    h.decision = { admit: true, status: 'not-activated', reason: 'the platform host policy is not activated' };
    await h.role.checkPolicy(); await h.role.tick();
    assert.equal(h.fx.st.newOrders.length, 1);
  } finally { await h.close(); }
});

test('role: a local issuance budget (2 per rolling week) and the backoff survive restarts; misissued chains count', async () => {
  const h = await harness();
  let stateDir = h.stateDir;
  try {
    h.fx.faults.misissue = 'sanExtra';
    await h.role.tick();                                         // issued by the CA, refused by us: counted
    assert.equal(h.role.status().issuedInWindow, 1);
    const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, 'keys', 'issuance.json'), 'utf8'));
    assert.equal(ledger.failures, 1); assert.equal(ledger.issued.length, 1); assert.equal(ledger.nextAt, h.role.status().nextAt);
  } finally { await h.close(); }
  // a restart (a crash loop) keeps the backoff: no order before nextAt
  const r = await harness({ stateDir, fx: h.fx });
  try {
    const orders = r.fx.st.newOrders.length;
    assert.equal(r.role.status().failures, 1);
    await r.role.tick();
    assert.equal(r.fx.st.newOrders.length, orders, 'the persisted backoff holds across the restart');
    r.clock = r.role.status().nextAt;
    await r.role.tick();                                         // second misissue: budget now spent
    assert.equal(r.role.status().issuedInWindow, 2);
    r.fx.faults.misissue = null;
    r.clock = r.role.status().nextAt;
    await r.role.tick();
    assert.equal(r.fx.st.newOrders.length, orders + 1, 'no third order inside the window');
    assert.match(r.role.status().lastError, /issuance budget spent \(2 certificates per 7 days\)/);
    const first = JSON.parse(fs.readFileSync(path.join(stateDir, 'keys', 'issuance.json'), 'utf8')).issued[0];
    assert.equal(r.role.status().nextAt, first + 7 * 86400e3);
    r.clock = first + 7 * 86400e3 + 1;
    await r.role.tick();
    assert.ok(r.role.status().certificate, 'issued once the oldest leaves the window');
  } finally { await r.close(); }
});
