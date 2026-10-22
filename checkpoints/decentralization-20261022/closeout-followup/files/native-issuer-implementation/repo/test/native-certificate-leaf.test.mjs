// The native CA leaf signed IN-PROCESS by the platform API primary (metal/guest/native-certificate.mjs signNativeLeaf) and the
// connection boundaries it is delivered over. What runs here:
//   * throwaway CAs minted with openssl per run, shaped like the live native CA (P-256, CA:TRUE pathlen:0, a CRITICAL name
//     constraint permitting DNS:enclavehost.eth, a multi-RDN subject), plus a CA without a subjectKeyIdentifier;
//   * the leaf checked by OpenSSL (`openssl verify` with the name constraint and the hostname), by Node's X509Certificate,
//     and compared with the leaf the EXISTING openssl issuance (scripts/native-control-certificate.mjs) makes for the same
//     request: same issuer bytes, subject, extensions and criticality, same lifetime;
//   * the issuer only ever holds the CA key and the TARGET's PUBLIC key. Where a test also proves a real TLS handshake under the
//     leaf, the TARGET key is a separate test-only fixture (the guest holds it in reality; the issuer never does);
//   * pins: real TLS endpoints that count every application byte they receive.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import tls from 'node:tls';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate, generateKeyPairSync, createHash } from 'node:crypto';
import * as MC from '../metal/guest/measured-control.mjs';
import { signNativeLeaf, nativeCaFacts, caIssuerFacts, checkNativeRequest, pinnedRequest, pinnedSocket, untrustedRead, installNativeCertificate, REQUEST_FORMAT } from '../metal/guest/native-certificate.mjs';
import { issueNativeCertificate } from '../scripts/native-control-certificate.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-leaf-'));
const closers = [];
after(() => { for (const c of closers) { try { c(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true }); });
const API = 'api.enclavehost.eth', MCP = 'mcp.enclavehost.eth';
const o = (args, opts = {}) => execFileSync('openssl', args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString();
const read = (f) => fs.readFileSync(path.join(tmp, f), 'utf8');
let caN = 0;
/** a CA like the live native CA (optionally: expiring in `minutes`, without SKI, another key type) */
function mintCa({ subj = '/O=Enclave Test Org/OU=Native/CN=Enclave ENS Service CA', days = 30, minutes = null, ski = true, key = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256'], ca = true } = {}) {
  const n = `ca${++caN}`;
  const ext = ca ? ['-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'nameConstraints=critical,permitted;DNS:enclavehost.eth']
    : ['-addext', 'basicConstraints=critical,CA:FALSE'];
  const skiArgs = ski ? [] : ['-addext', 'subjectKeyIdentifier=none', '-addext', 'authorityKeyIdentifier=none'];
  if (minutes !== null) {
    o(['req', '-new', ...key, '-nodes', '-keyout', `${n}.key`, '-out', `${n}.csr`, '-subj', subj]);
    const end = new Date(Date.now() + minutes * 60e3).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z', start = new Date(Date.now() - 3600e3).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
    fs.writeFileSync(path.join(tmp, `${n}.ext`), 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,permitted;DNS:enclavehost.eth\nsubjectKeyIdentifier=hash\n');
    o(['x509', '-req', '-in', `${n}.csr`, '-key', `${n}.key`, '-not_before', start, '-not_after', end, '-extfile', `${n}.ext`, '-out', `${n}.pem`]);
  } else o(['req', '-x509', ...key, '-nodes', '-keyout', `${n}.key`, '-out', `${n}.pem`, '-subj', subj, '-days', String(days), ...ext, ...skiArgs]);
  const pem = read(`${n}.pem`);
  return { pem, keyPem: read(`${n}.key`), certFile: path.join(tmp, `${n}.pem`), keyFile: path.join(tmp, `${n}.key`), sha256: MC.sha256Hex(new X509Certificate(pem).raw) };
}
const CA = mintCa();
/** the request for a target key (what nativeCertificateRequest returns for a verified boot: PUBLIC data only) */
function requestFor(publicKey, ca = CA, names = [API, MCP]) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { format: REQUEST_FORMAT, names, caSha256: ca.sha256, spkiSha256: MC.sha256Hex(spki), spkiPem: publicKey.export({ type: 'spki', format: 'pem' }),
    bootId: '0'.repeat(32), configDigest: '0'.repeat(64), operator: '0x' + '1'.repeat(40), publicUrl: 'https://host.example', registryId: null };
}
const target = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });   // TEST-ONLY: in reality this private key never leaves the guest
const blocks = (chain) => chain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n/g);
function osslVerify(chain, ca, name) {
  const n = Math.random().toString(16).slice(2); fs.writeFileSync(path.join(tmp, `leaf-${n}.pem`), blocks(chain)[0]);
  try { return o(['verify', '-CAfile', ca.certFile, '-verify_hostname', name, `leaf-${n}.pem`]).trim(); } catch (e) { return String(e.stderr || e.message); }
}
/** extension names + criticality, in order, as openssl prints them */
function extensionsOf(leafPem) {
  const n = Math.random().toString(16).slice(2); fs.writeFileSync(path.join(tmp, `x-${n}.pem`), leafPem);
  const text = o(['x509', '-in', `x-${n}.pem`, '-noout', '-text']);
  return [...text.matchAll(/^\s+(X509v3 [A-Za-z ]+):( critical)?$/gm)].map((m) => m[1] + (m[2] ? ' (critical)' : ''));
}

test('the in-process leaf: OpenSSL and Node verify it under the name-constrained CA; it matches the existing openssl issuance profile', () => {
  const t = target(), request = requestFor(t.publicKey);
  const now = Date.now(), chain = signNativeLeaf({ request, caCertPem: CA.pem, caKeyPem: CA.keyPem, now });
  const [leafPem, caPem] = blocks(chain);
  assert.equal(new X509Certificate(caPem).raw.equals(new X509Certificate(CA.pem).raw), true, 'the CA certificate is passed through byte for byte');
  for (const name of [API, MCP]) assert.match(osslVerify(chain, CA, name), /: OK$/, `openssl verify -verify_hostname ${name}`);
  assert.match(osslVerify(chain, CA, 'get.enclavehost.eth'), /hostname mismatch/, 'only the bound names');
  const leaf = new X509Certificate(leafPem), ca = new X509Certificate(CA.pem);
  assert.ok(leaf.checkIssued(ca) && leaf.verify(ca.publicKey));
  assert.equal(leaf.ca, false);
  assert.equal(leaf.subjectAltName, `DNS:${API}, DNS:${MCP}`);
  assert.deepEqual(leaf.keyUsage, ['1.3.6.1.5.5.7.3.1'], 'extendedKeyUsage serverAuth only');
  assert.equal(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom), 7 * 86400e3, 'exactly the original 7 days');
  assert.ok(Date.parse(leaf.validFrom) <= now && Date.parse(leaf.validFrom) >= now - 11 * 60e3, 'notBefore allows bounded clock skew only');
  // issuer = the CA's subject DER exactly (not a CN string): compare the raw Name bytes
  const issuedBy = caIssuerFacts(leaf.raw), caFacts = caIssuerFacts(ca.raw);
  assert.ok(leaf.raw.includes(caFacts.subjectDer), 'the leaf carries the CA subject DER verbatim as its issuer');
  assert.equal(leaf.issuer, ca.subject);
  assert.equal(issuedBy.ski.equals(createHash('sha1').update(t.publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)).digest()), true, 'SKI = SHA-1 of the leaf key');
  // the existing openssl issuance for the SAME request: the same extensions, criticality and order; the same issuer and subject
  const ref = issueNativeCertificate({ request, caCertFile: CA.certFile, caKeyFile: CA.keyFile, days: 7, tmpRoot: tmp });
  const refLeaf = new X509Certificate(blocks(ref)[0]);
  assert.deepEqual(extensionsOf(leafPem), extensionsOf(blocks(ref)[0]));
  assert.deepEqual(extensionsOf(leafPem), ['X509v3 Basic Constraints (critical)', 'X509v3 Key Usage (critical)', 'X509v3 Extended Key Usage', 'X509v3 Subject Alternative Name',
    'X509v3 Subject Key Identifier', 'X509v3 Authority Key Identifier']);
  assert.equal(leaf.issuer, refLeaf.issuer); assert.equal(leaf.subject, refLeaf.subject); assert.equal(leaf.subjectAltName, refLeaf.subjectAltName);
  assert.equal(leaf.fingerprint256 !== refLeaf.fingerprint256, true);
  const akiOf = (pem) => /Authority Key Identifier:\s*\n\s*([0-9A-F:]+)/.exec(o(['x509', '-noout', '-text'], { input: pem }))[1];
  assert.equal(akiOf(leafPem), akiOf(blocks(ref)[0]), 'AKI = the CA subjectKeyIdentifier, as openssl writes it');
});

test('a real TLS handshake under the leaf (TEST-ONLY target key) and the guest install check accept it', async () => {
  const t = target(), chain = signNativeLeaf({ request: requestFor(t.publicKey), caCertPem: CA.pem, caKeyPem: CA.keyPem });
  const keyPem = t.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const c = await MC.checkNativeCertificate(chain, { keyPem, caSha256: CA.sha256, names: [API, MCP] });
  assert.equal(c.caPem.trim(), new X509Certificate(CA.pem).toString().trim());
  const server = tls.createServer({ key: keyPem, cert: blocks(chain)[0] }, (s) => s.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); closers.push(() => server.close());
  const got = await new Promise((resolve, reject) => { const s = tls.connect({ host: '127.0.0.1', port: server.address().port, servername: MCP, ca: CA.pem }, () => resolve(s.authorized));
    s.on('error', reject); });
  assert.equal(got, true);
});

test('the CA bounds: never past the CA notAfter; a CA without SKI gets no AKI; refusals never echo key text', () => {
  const t = target();
  const soon = mintCa({ minutes: 3 * 24 * 60 });
  const chain = signNativeLeaf({ request: requestFor(t.publicKey, soon), caCertPem: soon.pem, caKeyPem: soon.keyPem });
  assert.equal(new X509Certificate(blocks(chain)[0]).validTo, new X509Certificate(soon.pem).validTo, 'capped at the CA notAfter');
  assert.match(osslVerify(chain, soon, API), /: OK$/);
  const dying = mintCa({ minutes: 120 });
  assert.throws(() => signNativeLeaf({ request: requestFor(t.publicKey, dying), caCertPem: dying.pem, caKeyPem: dying.keyPem }), /expires too soon/);
  const noSki = mintCa({ ski: false });
  assert.equal(caIssuerFacts(new X509Certificate(noSki.pem).raw).ski, null);
  const c2 = signNativeLeaf({ request: requestFor(t.publicKey, noSki), caCertPem: noSki.pem, caKeyPem: noSki.keyPem });
  assert.ok(!extensionsOf(blocks(c2)[0]).includes('X509v3 Authority Key Identifier'));
  assert.match(osslVerify(c2, noSki, API), /: OK$/);
  // refusals
  const other = mintCa(), rsa = mintCa({ key: ['-newkey', 'rsa:2048'] }), p384 = mintCa({ key: ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-384'] }), notCa = mintCa({ ca: false });
  const cases = [
    [{ request: requestFor(t.publicKey), caCertPem: CA.pem, caKeyPem: other.keyPem }, /not the key of the native CA certificate/],
    [{ request: requestFor(t.publicKey, rsa), caCertPem: rsa.pem, caKeyPem: rsa.keyPem }, /EC P-256/],
    [{ request: requestFor(t.publicKey, p384), caCertPem: p384.pem, caKeyPem: p384.keyPem }, /EC P-256/],
    [{ request: requestFor(t.publicKey, notCa), caCertPem: notCa.pem, caKeyPem: notCa.keyPem }, /not a CA certificate/],
    [{ request: requestFor(t.publicKey, other), caCertPem: CA.pem, caKeyPem: CA.keyPem }, /not the native CA the boot is bound to/],
    [{ request: { ...requestFor(t.publicKey), names: [API, 'get.enclavehost.eth'] }, caCertPem: CA.pem, caKeyPem: CA.keyPem }, /native control names/],
    [{ request: { ...requestFor(t.publicKey), spkiPem: target().publicKey.export({ type: 'spki', format: 'pem' }) }, caCertPem: CA.pem, caKeyPem: CA.keyPem }, /not the attested key/],
    [{ request: requestFor(t.publicKey), caCertPem: CA.pem, caKeyPem: 'not a key' }, /unreadable/],
    [{ request: requestFor(t.publicKey), caCertPem: CA.pem, caKeyPem: CA.keyPem, days: 8 }, /days: 1 to 7/],
  ];
  for (const [opts, re] of cases) {
    let err; try { signNativeLeaf(opts); } catch (e) { err = e; }
    assert.ok(err, `refused: ${re}`); assert.match(err.message, re);
    for (const k of [CA.keyPem, other.keyPem, rsa.keyPem]) assert.ok(!err.message.includes(k.split('\n')[1]), 'no key text in the refusal');
  }
  assert.throws(() => nativeCaFacts({ caCertPem: CA.pem, caKeyPem: CA.keyPem, now: Date.now() + 60 * 86400e3 }), /not valid now/);
  assert.throws(() => checkNativeRequest({ ...requestFor(t.publicKey), format: 'x' }), /request format/);
});

// ---- the pin at every body-bearing boundary --------------------------------------------------------------------------------------
/** a real TLS endpoint that counts the application bytes it receives (and connections) */
async function countingEndpoint({ hang = false } = {}) {
  const k = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cert = MC.selfSignedCert(k.privateKey, k.publicKey, { cn: 'counting' });
  const st = { connections: 0, bytes: 0, data: '', closed: 0 };
  const server = tls.createServer({ key: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert }, (s) => {
    st.connections++;
    s.on('data', (d) => { st.bytes += d.length; st.data += d.toString('latin1'); if (!hang && /\r\n\r\n/.test(st.data)) s.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok'); });
    s.on('close', () => { st.closed++; }); s.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); closers.push(() => server.close());
  return { st, url: `https://127.0.0.1:${server.address().port}`, spki: MC.sha256Hex(k.publicKey.export({ type: 'spki', format: 'der' })) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('pins: a missing, null, malformed or wrong SPKI never lets an install (or any pinned request) send one application byte', async () => {
  const ep = await countingEndpoint();
  const body = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
  for (const spki of [undefined, null, '', 'zz', 'AB'.repeat(32), ep.spki.slice(0, 63)]) {
    await assert.rejects(installNativeCertificate({ controlUrl: ep.url, chainPem: body, spkiSha256: spki }), /attested key digest/);
    await assert.rejects(pinnedRequest(ep.url, { method: 'PUT', path: '/x', body, spkiSha256: spki }), /attested key digest/);
    await assert.rejects(pinnedSocket(ep.url, spki), /attested key digest/);
  }
  await sleep(100);
  assert.deepEqual([ep.st.connections, ep.st.bytes], [0, 0], 'refused before any connection');
  // a well-formed digest of ANOTHER key: the handshake happens, the key mismatches, and no application byte follows
  await assert.rejects(installNativeCertificate({ controlUrl: ep.url, chainPem: body, spkiSha256: 'ab'.repeat(32) }), /not the attested key/);
  await assert.rejects(pinnedRequest(ep.url, { method: 'PUT', path: '/x', body, spkiSha256: 'cd'.repeat(32) }), /not the attested key/);
  await sleep(100);
  assert.equal(ep.st.connections, 2); assert.equal(ep.st.bytes, 0, 'zero application bytes to a wrong key');
  // the right key: the PUT and its body go through
  const r = await installNativeCertificate({ controlUrl: ep.url, chainPem: body, spkiSha256: ep.spki });
  assert.equal(r.status, 200); assert.match(ep.st.data, /^PUT \/\.well-known\/enclave-native-certificate HTTP\/1\.1/); assert.ok(ep.st.data.endsWith(body));
});

test('untrustedRead: a body-less GET only, reporting the peer key; aborting releases the socket at once', async () => {
  const ep = await countingEndpoint();
  const r = await untrustedRead(ep.url, '/platform-api/config');
  assert.equal(r.status, 200); assert.equal(r.peerSpkiSha256, ep.spki);
  assert.match(ep.st.data, /^GET \/platform-api\/config HTTP\/1\.1\r\n/);
  assert.ok(!/content-length|transfer-encoding/i.test(ep.st.data), 'no request body is possible');
  await assert.rejects(untrustedRead(ep.url, 'http://evil/'), /absolute path/);
  // a hanging endpoint: the abort ends the attempt and the endpoint sees the socket close
  const hang = await countingEndpoint({ hang: true });
  const ac = new AbortController();
  const p = untrustedRead(hang.url, '/x', { timeoutMs: 30000, signal: ac.signal });
  await sleep(300); assert.equal(hang.st.connections, 1); assert.equal(hang.st.closed, 0);
  const t0 = Date.now(); ac.abort();
  await assert.rejects(p, /aborted/);
  await sleep(200);
  assert.equal(hang.st.closed, 1, 'the connection is released on abort'); assert.ok(Date.now() - t0 < 2000);
  const ac2 = new AbortController(); ac2.abort();
  await assert.rejects(pinnedRequest(hang.url, { path: '/', spkiSha256: hang.spki, signal: ac2.signal }), /aborted/);
});
