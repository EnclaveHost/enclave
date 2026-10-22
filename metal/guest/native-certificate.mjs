// metal/guest/native-certificate.mjs -- the native CA leaf for ONE verified measured control boot, as a library: the request
// (public data of a VERIFIED boot: its attested control TLS public key and bound names), the pinned connection to that boot's
// control front, and a signer that needs no openssl (the measured control guest has none).
//
// Used by scripts/native-control-certificate.mjs (the offline/admin CLI, which keeps its openssl `issue`) and by
// metal/guest/native-issuer.mjs (the platform API primary). This module has NO command line of its own: inside a bundle every
// module's import.meta.url is the bundle's, so a "main" check here would run in the role (host-role-bundling lesson).
//
// signNativeLeaf: a narrow DER encoder for exactly ONE certificate shape, the profile the existing native CA issues today
// (openssl x509 -new -force_pubkey ... -extfile, see scripts/native-control-certificate.mjs issueNativeCertificate):
//   v3, a positive 16-byte random serial, ecdsa-with-SHA256, issuer = the CA certificate's subject EXACTLY as encoded in it,
//   subject CN = the first bound name, validity at most 7 days and never past the CA's notAfter, and the extensions in the
//   order openssl writes them: basicConstraints critical CA:FALSE, keyUsage critical digitalSignature, extendedKeyUsage
//   serverAuth, subjectAltName = the bound names, subjectKeyIdentifier (SHA-1 of the leaf key), authorityKeyIdentifier (the
//   CA's own subjectKeyIdentifier; omitted when the CA has none). Only a P-256 CA key is accepted (the native CA's), and only
//   when it is the key of that CA certificate. The CA certificate itself is never changed or re-encoded.
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { X509Certificate, createHash, createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign } from 'node:crypto';
import { parseStatement, sha256Hex, NATIVE_NAMES, EVIDENCE_FORMAT, NATIVE_CERT_PATH } from './measured-control.mjs';

export const REQUEST_FORMAT = 'enclave-native-certificate-request/v1';
export const MAX_DAYS = 7;   // the existing native service certificate lifetime (renewed, never long-lived)
const DAY_MS = 86400e3;
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

/** A request's shape, names and key -> the request's public key (KeyObject), or throws. */
export function checkNativeRequest(r) {
  if (!r || r.format !== REQUEST_FORMAT) throw new Error(`request format must be ${REQUEST_FORMAT}`);
  if (!Array.isArray(r.names) || !r.names.length || r.names.some((n) => !NATIVE_NAMES.includes(n)) || new Set(r.names).size !== r.names.length) throw new Error('request names must be native control names');
  if (!/^[0-9a-f]{64}$/.test(String(r.caSha256)) || !/^[0-9a-f]{64}$/.test(String(r.spkiSha256))) throw new Error('request caSha256/spkiSha256 malformed');
  const k = createPublicKey(r.spkiPem);
  if (sha256Hex(k.export({ type: 'spki', format: 'der' })) !== r.spkiSha256) throw new Error('request public key is not the attested key it names');
  return k;
}

// ---- the attested control key's TLS connection ------------------------------------------------------------------------------
const SPKI_HEX = /^[0-9a-f]{64}$/;
/** an abort signal ends the attempt and RELEASES its socket (a stopped issuer leaves no connection or timer behind) */
function tlsTo(controlUrl, { timeoutMs, signal }) {
  const u = new URL(controlUrl);
  if (u.protocol !== 'https:') return Promise.reject(new Error('an https control URL is required'));
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: Number(u.port || 443), rejectUnauthorized: false, minVersion: 'TLSv1.2', ...(net.isIP(host) ? {} : { servername: host }) });
    const onAbort = () => { s.destroy(); finish(new Error('aborted')); };
    const t = setTimeout(() => { s.destroy(); finish(new Error(`no TLS handshake within ${timeoutMs} ms`)); }, timeoutMs);
    let done = false;
    const finish = (e) => { if (done) return; done = true; clearTimeout(t); signal?.removeEventListener('abort', onAbort); if (e) reject(e); else {
      let got = null;
      try { got = sha256Hex(new X509Certificate(s.getPeerCertificate().raw).publicKey.export({ type: 'spki', format: 'der' })); } catch {}
      s.peerSpkiSha256 = got; resolve(s); } };
    signal?.addEventListener('abort', onAbort, { once: true });
    s.once('error', (e) => finish(e));
    s.once('secureConnect', () => finish(null));
  });
}
/**
 * The handshake completes, and the peer's SPKI is compared on THAT secure socket before any request byte exists.
 * (rejectUnauthorized:false with a checkServerIdentity-only pin is not a pin: Node skips checkServerIdentity when chain
 * validation already failed, so a self-signed impostor would be accepted.) A pin is REQUIRED: a missing, null or malformed
 * digest is refused before any connection is made.
 */
export async function pinnedSocket(controlUrl, spkiSha256, { timeoutMs = 15000, signal } = {}) {
  if (typeof spkiSha256 !== 'string' || !SPKI_HEX.test(spkiSha256)) throw new Error('the attested key digest (64 lowercase hex) is required: nothing is sent unpinned');
  const s = await tlsTo(controlUrl, { timeoutMs, signal });
  if (s.peerSpkiSha256 !== spkiSha256) { s.destroy(); throw new Error('the endpoint is not the attested key'); }
  return s;
}
function httpOver(sock, controlUrl, { method, path: p, body, timeoutMs, maxBytes, signal }) {
  const u = new URL(controlUrl);
  return new Promise((resolve, reject) => {
    const onAbort = () => req.destroy(new Error('aborted'));
    const req = http.request({ createConnection: () => sock, host: u.hostname, port: u.port || 443, method, path: p, timeout: timeoutMs,
      headers: { host: u.host, ...(body ? { 'content-type': 'application/x-pem-file', 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > maxBytes) req.destroy(new Error('answer too large')); else chunks.push(c); });
      res.on('end', () => { signal?.removeEventListener('abort', onAbort); sock.destroy(); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), peerSpkiSha256: sock.peerSpkiSha256 }); });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', (e) => { signal?.removeEventListener('abort', onAbort); sock.destroy(); reject(e); });
    req.end(body || undefined);
  });
}
/** One HTTP request over pinnedSocket (nothing is sent before the key matched). -> { status, body, peerSpkiSha256 } */
export async function pinnedRequest(controlUrl, { method = 'GET', path: p, body = null, spkiSha256, timeoutMs = 15000, maxBytes = 512 * 1024, signal } = {}) {
  const sock = await pinnedSocket(controlUrl, spkiSha256, { timeoutMs, signal });
  return httpOver(sock, controlUrl, { method, path: p, body, timeoutMs, maxBytes, signal });
}
/**
 * A bounded, body-less GET from a control front WITHOUT a pin, for public data a caller trusts only after its own checks (the
 * leaf a front serves now, a member's bound config). It can never carry a request body or another method, and it reports the
 * key the peer presented. -> { status, body, peerSpkiSha256 }
 */
export async function untrustedRead(controlUrl, path, { timeoutMs = 15000, maxBytes = 256 * 1024, signal } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('an absolute path is required');
  const sock = await tlsTo(controlUrl, { timeoutMs, signal });
  return httpOver(sock, controlUrl, { method: 'GET', path, body: null, timeoutMs, maxBytes, signal });
}
/** The install: a PUT of the chain to the boot's front, ONLY over a connection pinned to its attested key. */
export function installNativeCertificate({ controlUrl, chainPem, spkiSha256, timeoutMs, signal }) {
  if (typeof spkiSha256 !== 'string' || !SPKI_HEX.test(spkiSha256)) return Promise.reject(new Error('install refused: the attested key digest (64 lowercase hex) is required'));
  if (typeof chainPem !== 'string' || !chainPem) return Promise.reject(new Error('install refused: no chain'));
  return pinnedRequest(controlUrl, { method: 'PUT', path: NATIVE_CERT_PATH, body: chainPem, spkiSha256, timeoutMs, signal });
}

// ---- DER: a reader for the CA certificate, a writer for exactly the leaf shape above ------------------------------------------
/** one TLV at off -> { tag, start (of the value), end, raw (the whole TLV) }; definite lengths only (DER) */
function tlvAt(buf, off) {
  if (off + 2 > buf.length) throw new Error('DER: truncated');
  const tag = buf[off]; let len = buf[off + 1], p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || p + n > buf.length) throw new Error('DER: bad length');
    len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[p + i];
    p += n;
  }
  if (p + len > buf.length) throw new Error('DER: truncated value');
  return { tag, start: p, end: p + len, raw: buf.subarray(off, p + len) };
}
const children = (buf, t) => { const out = []; for (let p = t.start; p < t.end;) { const c = tlvAt(buf, p); out.push(c); p = c.end; } return out; };
const OID = { SKI: '551d0e', BC: '551d13', KU: '551d0f', EKU: '551d25', SAN: '551d11', AKI: '551d23', CN: '550403', SERVER_AUTH: '2b06010505070301', ECDSA_SHA256: '2a8648ce3d040302' };
/** The CA certificate's subject (exact DER) and its subjectKeyIdentifier (null when it has none). */
export function caIssuerFacts(caDer) {
  const cert = tlvAt(caDer, 0), [tbsT] = children(caDer, cert), tbs = children(caDer, tbsT);
  let i = tbs[0].tag === 0xa0 ? 1 : 0;   // [0] version
  const subject = tbs[i + 4];                                    // serial, signature, issuer, validity, SUBJECT
  if (!subject || subject.tag !== 0x30) throw new Error('the CA certificate has no subject');
  let ski = null;
  const ext = tbs.find((t) => t.tag === 0xa3);
  if (ext) for (const e of children(caDer, children(caDer, ext)[0])) {
    const f = children(caDer, e);
    if (f[0].tag === 0x06 && caDer.subarray(f[0].start, f[0].end).toString('hex') === OID.SKI) {
      const octets = f[f.length - 1], inner = tlvAt(caDer, octets.start);
      if (inner.tag !== 0x04) throw new Error('the CA subjectKeyIdentifier is not an OCTET STRING');
      ski = Buffer.from(caDer.subarray(inner.start, inner.end));
    }
  }
  return { subjectDer: Buffer.from(subject.raw), ski };
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts), n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
};
const seq = (...p) => tlv(0x30, ...p), set = (...p) => tlv(0x31, ...p), octets = (b) => tlv(0x04, b), oidHex = (h) => tlv(0x06, Buffer.from(h, 'hex'));
const pad2 = (n) => String(n).padStart(2, '0');
/** RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050, both to the second in UTC */
function timeDer(ms) {
  const d = new Date(Math.floor(ms / 1000) * 1000), y = d.getUTCFullYear();
  const rest = `${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(pad2(y % 100) + rest)) : tlv(0x18, Buffer.from(String(y) + rest));
}
/** the subjectPublicKey BIT STRING's key bytes of a DER SPKI (what RFC 5280 key identifiers hash) */
function spkiKeyBits(spkiDer) {
  const [, bits] = children(spkiDer, tlvAt(spkiDer, 0));
  if (!bits || bits.tag !== 0x03 || spkiDer[bits.start] !== 0) throw new Error('SPKI: no public key bit string');
  return spkiDer.subarray(bits.start + 1, bits.end);
}
const pem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

/**
 * The native CA credentials, checked: a CA certificate, a P-256 private key that IS that certificate's key, valid now.
 * -> { ca (X509Certificate), caKey (KeyObject), caFrom, caTo (ms), caSha256 (of the CA DER) }, or throws (never with key text).
 */
export function nativeCaFacts({ caCertPem, caKeyPem, now = Date.now() }) {
  let ca; try { ca = new X509Certificate(caCertPem); } catch (e) { throw new Error(`the native CA certificate is unreadable: ${e.message}`); }
  if (!ca.ca) throw new Error('the native CA certificate is not a CA certificate');
  let caKey; try { caKey = createPrivateKey(caKeyPem); } catch { throw new Error('the native CA key is unreadable'); }   // never the key's text in a message
  if (caKey.asymmetricKeyType !== 'ec' || caKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('the native CA key must be an EC P-256 key (ecdsa-with-SHA256)');
  if (!createPublicKey(caKey).export({ type: 'spki', format: 'der' }).equals(ca.publicKey.export({ type: 'spki', format: 'der' }))) throw new Error('the native CA key is not the key of the native CA certificate');
  const caFrom = Date.parse(ca.validFrom), caTo = Date.parse(ca.validTo);
  if (!(caFrom <= now && now < caTo)) throw new Error('the native CA certificate is not valid now');
  return { ca, caKey, caFrom, caTo, caSha256: sha256Hex(ca.raw) };
}

/**
 * The CA holder's signature, in-process -> the chain PEM (the leaf, then the CA certificate: its own DER bytes, unchanged).
 *   request    a nativeCertificateRequest (public data of a verified boot); its caSha256 must be THIS CA certificate's
 *   caCertPem  the native CA certificate (PEM); caKeyPem its private key (PEM, PKCS#8 or SEC1), P-256 only
 *   days       1..7; the leaf never outlives the CA (notAfter = min(notBefore + days, CA notAfter))
 *   skewMs     notBefore is this much before now (a member's clock may lag the issuer's), and never before the CA's notBefore
 */
export function signNativeLeaf({ request, caCertPem, caKeyPem, days = MAX_DAYS, now = Date.now(), skewMs = 10 * 60e3, minRemainingMs = DAY_MS }) {
  const leafKey = checkNativeRequest(request);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`days: 1 to ${MAX_DAYS}`);
  const { ca, caKey, caFrom, caTo, caSha256 } = nativeCaFacts({ caCertPem, caKeyPem, now });
  if (caSha256 !== request.caSha256) throw new Error('this CA is not the native CA the boot is bound to');
  const notBefore = Math.max(Math.floor((now - skewMs) / 1000) * 1000, Math.ceil(caFrom / 1000) * 1000);
  const notAfter = Math.min(notBefore + days * DAY_MS, Math.floor(caTo / 1000) * 1000);
  if (notAfter - now < minRemainingMs) throw new Error('the native CA certificate expires too soon to issue a useful leaf');
  const { subjectDer: issuer, ski: caSki } = caIssuerFacts(ca.raw);
  const spkiDer = leafKey.export({ type: 'spki', format: 'der' });
  const serial = randomBytes(16); serial[0] = (serial[0] & 0x7f) | 0x01;
  const alg = seq(oidHex(OID.ECDSA_SHA256));
  const ext = (o, critical, value) => seq(oidHex(o), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), octets(value));
  const extensions = seq(
    ext(OID.BC, true, seq()),                                                          // CA:FALSE
    ext(OID.KU, true, tlv(0x03, Buffer.from([0x07, 0x80]))),                           // digitalSignature
    ext(OID.EKU, false, seq(oidHex(OID.SERVER_AUTH))),
    ext(OID.SAN, false, seq(...request.names.map((n) => tlv(0x82, Buffer.from(n, 'ascii'))))),
    ext(OID.SKI, false, octets(createHash('sha1').update(spkiKeyBits(spkiDer)).digest())),
    ...(caSki ? [ext(OID.AKI, false, seq(tlv(0x80, caSki)))] : []));
  const tbs = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, serial), alg, issuer, seq(timeDer(notBefore), timeDer(notAfter)),
    seq(set(seq(oidHex(OID.CN), tlv(0x0c, Buffer.from(request.names[0], 'utf8'))))), spkiDer, tlv(0xa3, extensions));
  const leafPem = pem(seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), cryptoSign('sha256', tbs, caKey)]))));
  // what was signed is what was meant: issued by this CA, under its key, over the request's key, for exactly these names
  const leaf = new X509Certificate(leafPem);
  if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey) || leaf.ca || !leaf.publicKey.export({ type: 'spki', format: 'der' }).equals(spkiDer)
      || request.names.some((n) => leaf.checkHost(n, { subject: 'never' }) !== n) || Date.parse(leaf.validTo) !== notAfter)
    throw new Error('the encoded leaf does not verify as intended');
  return leafPem + pem(ca.raw);   // the CA certificate's own DER bytes, as the one PEM block the guest's install check expects
}
