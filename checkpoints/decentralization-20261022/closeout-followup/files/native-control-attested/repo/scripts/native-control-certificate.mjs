#!/usr/bin/env node
// scripts/native-control-certificate.mjs -- the native CA's leaf for ONE measured control boot (metal/guest/measured-control.mjs
// nativeControl): the existing native CA certifies that boot's ATTESTED control TLS public key for the native control names
// the boot is bound to serve. The guest's private key never leaves the guest; the leaf is public; the CA key stays wherever its
// holder keeps it (it is read only by openssl, from the path given, and never copied, printed or logged).
//
//   request  --control-url https://<ip>:<port> --config <the host's direct config JSON> --measurement <96 hex>... --rpc A --rpc B
//            [--quorum N] [--registry 0x..] --out request.json
//            verifyMeasuredControl (unchanged: AMD chain, measurement, HOST_DATA = that config, TLS peer = attested key,
//            supervisor keys, ORIGINAL registry through the RPC quorum) must say "verified"; the evidence is then re-read over a
//            connection pinned to the attested key (same boot), and the request names that key, the boot and the bound names.
//   issue    --request request.json --ca-cert ca.pem --ca-key <path> [--days 1..7] --out chain.pem
//            run by the CA holder, offline: the leaf (SAN = the bound names, serverAuth) over the request's public key,
//            followed by the CA certificate. The CA certificate must be the one the boot is bound to (its sha256).
//   install  --chain chain.pem --control-url https://<ip>:<port> --spki <sha256 of the attested key>
//            PUT to the guest's front over a connection pinned to the attested key; the guest accepts it only after its own
//            checks (bound CA, its own key, every bound name through a real TLS handshake).
// Issuance is the CA holder's decision for this boot. It does not replace the platform host policy: discovery still judges
// the boot's registry host freshly (network/native-control-routes.mjs), so a later ban withdraws it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPublicKey, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStatement, sha256Hex, NATIVE_NAMES, EVIDENCE_FORMAT, EVIDENCE_PATH, NATIVE_CERT_PATH } from '../metal/guest/measured-control.mjs';

export const REQUEST_FORMAT = 'enclave-native-certificate-request/v1';
export const MAX_DAYS = 7;   // the existing native service certificate lifetime (renewed, never long-lived)
const spkiOf = (pem) => new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });

/**
 * The request for one VERIFIED boot. evidence: the evidence JSON re-read over a connection pinned to identity's key;
 * identity: verifyMeasuredControl(...).identity of a "verified" result. -> request object (public data only).
 */
export function nativeCertificateRequest({ evidence, identity }) {
  if (!evidence || evidence.format !== EVIDENCE_FORMAT || typeof evidence.certificate !== 'string') throw new Error('evidence: the control front\'s evidence document is required');
  const st = parseStatement(evidence.statement);
  if (!identity || st.bootId !== identity.bootId || st.keys.controlTls.spkiSha256 !== identity.controlTlsSpkiSha256) throw new Error('the evidence is not from the verified boot');
  if (!st.native) throw new Error('this boot is not bound to serve native control names (no nativeControl in its config)');
  const spki = spkiOf(evidence.certificate);
  if (sha256Hex(spki) !== st.keys.controlTls.spkiSha256) throw new Error('the evidence certificate does not carry the attested control key');
  return { format: REQUEST_FORMAT, names: [...st.native.names], caSha256: st.native.caSha256, spkiSha256: st.keys.controlTls.spkiSha256,
    spkiPem: createPublicKey({ key: spki, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }),
    bootId: st.bootId, configDigest: st.configDigest, operator: st.identity.operator, publicUrl: st.identity.publicUrl, registryId: identity.registryId ?? null };
}

function checkRequest(r) {
  if (!r || r.format !== REQUEST_FORMAT) throw new Error(`request format must be ${REQUEST_FORMAT}`);
  if (!Array.isArray(r.names) || !r.names.length || r.names.some((n) => !NATIVE_NAMES.includes(n)) || new Set(r.names).size !== r.names.length) throw new Error('request names must be native control names');
  if (!/^[0-9a-f]{64}$/.test(String(r.caSha256)) || !/^[0-9a-f]{64}$/.test(String(r.spkiSha256))) throw new Error('request caSha256/spkiSha256 malformed');
  const k = createPublicKey(r.spkiPem);
  if (sha256Hex(k.export({ type: 'spki', format: 'der' })) !== r.spkiSha256) throw new Error('request public key is not the attested key it names');
  return k;
}

/** The CA holder's issuance -> the chain PEM (leaf, then the CA certificate). The CA key is read by openssl only. */
export function issueNativeCertificate({ request, caCertFile, caKeyFile, days = MAX_DAYS, openssl = 'openssl', tmpRoot = os.tmpdir() }) {
  const key = checkRequest(request);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`days: 1 to ${MAX_DAYS}`);
  const caPem = fs.readFileSync(caCertFile, 'utf8'), ca = new X509Certificate(caPem);
  if (sha256Hex(ca.raw) !== request.caSha256) throw new Error('this CA is not the native CA the boot is bound to');
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'native-leaf-'));
  try {
    fs.writeFileSync(path.join(dir, 'pub.pem'), key.export({ type: 'spki', format: 'pem' }));
    fs.writeFileSync(path.join(dir, 'ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n'
      + `subjectAltName=${request.names.map((n) => 'DNS:' + n).join(',')}\n`);
    execFileSync(openssl, ['x509', '-new', '-force_pubkey', 'pub.pem', '-subj', `/CN=${request.names[0]}`, '-CA', path.resolve(caCertFile), '-CAkey', path.resolve(caKeyFile),
      '-set_serial', '0x' + randomBytes(16).toString('hex').replace(/^[89a-f]/, '1'), '-days', String(days), '-sha256', '-extfile', 'ext', '-out', 'leaf.pem'],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const leafPem = fs.readFileSync(path.join(dir, 'leaf.pem'), 'utf8');
    if (sha256Hex(spkiOf(leafPem)) !== request.spkiSha256 || !new X509Certificate(leafPem).checkIssued(ca)) throw new Error('openssl produced an unexpected leaf');
    return leafPem + (caPem.endsWith('\n') ? caPem : caPem + '\n');
  } catch (e) {
    // openssl's own message only (it never prints key material); never the arguments
    throw new Error(`issuance failed: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** One request to the control front over a connection pinned to the attested key (no CA: the attestation is the trust). */
export function pinnedRequest(controlUrl, { method = 'GET', path: p, body = null, spkiSha256, timeoutMs = 15000 }) {
  const u = new URL(controlUrl);
  if (u.protocol !== 'https:' || !/^[0-9a-f]{64}$/.test(String(spkiSha256))) throw new Error('an https control URL and the attested key digest are required');
  return new Promise((resolve, reject) => {
    const req = https.request({ host: u.hostname, port: u.port || 443, method, path: p, agent: false, timeout: timeoutMs, rejectUnauthorized: false,
      checkServerIdentity: (_h, cert) => (sha256Hex(spkiOf(cert.raw)) === spkiSha256 ? undefined : new Error('the endpoint is not the attested key')),
      headers: body ? { 'content-type': 'application/x-pem-file', 'content-length': Buffer.byteLength(body) } : {} }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 512 * 1024) req.destroy(new Error('answer too large')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body || undefined);
  });
}
export const installNativeCertificate = ({ controlUrl, chainPem, spkiSha256, timeoutMs }) => pinnedRequest(controlUrl, { method: 'PUT', path: NATIVE_CERT_PATH, body: chainPem, spkiSha256, timeoutMs });

// ---- command line -----------------------------------------------------------------------------------------------------------
function args(argv) {
  const o = { _: [] }, multi = new Set(['measurement', 'rpc']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2), v = argv[++i];
    if (v === undefined) throw new Error(`--${k} needs a value`);
    if (multi.has(k)) (o[k] ||= []).push(v); else o[k] = v;
  }
  return o;
}
const need = (o, ...ks) => { for (const k of ks) if (o[k] === undefined) throw new Error(`--${k} is required`); };
const writeNew = (file, text) => fs.writeFileSync(file, text, { flag: 'wx', mode: 0o644 });
export async function main(argv = process.argv.slice(2), out = (s) => process.stdout.write(s + '\n')) {
  const o = args(argv), cmd = o._[0];
  if (cmd === 'request') {
    need(o, 'control-url', 'config', 'measurement', 'rpc', 'out');
    const { verifyMeasuredControl } = await import('../metal/measured-control-verify.mjs');
    const { quorumRegistry } = await import('../metal/guest/platform-api-verify.mjs');
    const { httpCollateral } = await import('../verifier/collateral.mjs');
    const { TCB_FLOORS } = await import('../verifier/metal-box.mjs');
    const config = JSON.parse(fs.readFileSync(o.config, 'utf8'));
    const registry = quorumRegistry({ rpcs: o.rpc, quorum: Number(o.quorum || o.rpc.length), registry: o.registry || config.contracts?.registry });
    const v = await verifyMeasuredControl({ url: o['control-url'], expect: { config, measurements: o.measurement, minTcb: TCB_FLOORS }, collateral: httpCollateral(), registry });
    if (v.status !== 'verified') throw new Error(`the boot is not verified (${v.status}): ${v.reasons.slice(-3).join('; ')}`);
    const r = await pinnedRequest(o['control-url'], { path: `${EVIDENCE_PATH}?nonce=${randomBytes(32).toString('hex')}`, spkiSha256: v.identity.controlTlsSpkiSha256 });
    if (r.status !== 200) throw new Error(`evidence re-read: HTTP ${r.status}`);
    const req = nativeCertificateRequest({ evidence: JSON.parse(r.body), identity: v.identity });
    writeNew(o.out, JSON.stringify(req, null, 2) + '\n');
    out(JSON.stringify({ out: o.out, names: req.names, spkiSha256: req.spkiSha256, bootId: req.bootId, registryId: req.registryId }));
  } else if (cmd === 'issue') {
    need(o, 'request', 'ca-cert', 'ca-key', 'out');
    const chain = issueNativeCertificate({ request: JSON.parse(fs.readFileSync(o.request, 'utf8')), caCertFile: o['ca-cert'], caKeyFile: o['ca-key'], days: Number(o.days || MAX_DAYS) });
    writeNew(o.out, chain);
    const leaf = new X509Certificate(chain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0]);
    out(JSON.stringify({ out: o.out, subjectAltName: leaf.subjectAltName, validTo: leaf.validTo }));
  } else if (cmd === 'install') {
    need(o, 'chain', 'control-url', 'spki');
    const r = await installNativeCertificate({ controlUrl: o['control-url'], chainPem: fs.readFileSync(o.chain, 'utf8'), spkiSha256: o.spki });
    out(r.body.trim());
    if (r.status !== 200) throw new Error(`the guest refused the certificate: HTTP ${r.status}`);
  } else throw new Error('commands: request | issue | install');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => { process.stderr.write(`native-control-certificate: ${e.message}\n`); process.exit(1); });
