// A fetch() for RPC upstreams that are SEV-SNP enclaves (rpc/snp/front.py).
//
// Before the first request to an attested origin it fetches the origin's
// /.well-known/enclave-attestation, requires the TLS certificate it was served on
// to be the certificate in that document, and verifies the SNP report with the
// repo's verifier (relay/snp-verify.mjs): AMD VCEK -> ASK -> ARK, VMPL0, no
// DEBUG/MIGRATE_MA, measurement on the caller's allowlist, report_data ==
// sha256(served SPKI). Requests are then sent only over TLS whose peer key hashes
// to that pin. The enclave makes a new key every boot, so a pin mismatch triggers
// one re-attestation and one retry; anything else fails closed. Non-attested
// origins go to the ordinary fetch.
import https from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import { verifyQuote } from '../../relay/snp-verify.mjs';

const spkiOf = (pemOrDer) => new X509Certificate(pemOrDer).publicKey.export({ type: 'spki', format: 'der' });
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const MAX_BODY = 16 << 20;

function request(url, { method = 'GET', headers = {}, body, signal, ca, pin }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers, signal,
      servername: 'enclave-rpc', ca, rejectUnauthorized: Boolean(ca),
      // With a pin, the peer key must be the attested one; the CA check alone only
      // proves the self-signed certificate matches itself.
      checkServerIdentity: (_host, cert) => (pin && sha256(spkiOf(cert.raw)) !== pin ? new Error('attested key pin mismatch') : undefined),
    }, (res) => {
      const chunks = []; let size = 0;
      const peer = res.socket.getPeerCertificate(false);
      res.on('data', (c) => { size += c.length; if (size > MAX_BODY) req.destroy(new Error('response too large')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), peerDer: peer?.raw }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function createAttestedFetch({ attested, fallbackFetch = fetch, kds = true, minTcb } = {}) {
  const pins = new Map(), inflight = new Map();
  // One attestation per origin at a time: concurrent first requests share it.
  function attest(origin) {
    if (!inflight.has(origin)) inflight.set(origin, attestOnce(origin).finally(() => inflight.delete(origin)));
    return inflight.get(origin);
  }
  async function attestOnce(origin) {
    const policy = attested[origin];
    const r = await request(origin + '/.well-known/enclave-attestation', {});
    if (r.status !== 200 || !r.peerDer) throw new Error('attestation unavailable');
    const doc = JSON.parse(r.body.toString('utf8'));
    const served = spkiOf(r.peerDer);
    if (!served.equals(spkiOf(doc.certificate))) throw new Error('served certificate differs from the attested one');
    const v = await verifyQuote(Buffer.from(doc.report, 'base64'), {
      transportKeySpki: served, challenge: Buffer.alloc(0), allowedMeasurements: policy.allowedMeasurements, kds, minTcb });
    if (!v.ok || v.vcekVerified !== true) throw new Error('enclave attestation refused: ' + (v.reasons || []).slice(-1)[0]);
    const pin = { spki: sha256(served), ca: doc.certificate, measurement: v.measurement, at: Date.now() };
    pins.set(origin, pin);
    return pin;
  }
  async function attestedFetch(url, opts = {}) {
    const origin = new URL(url).origin;
    if (!attested?.[origin]) return fallbackFetch(url, opts);
    for (let attempt = 0; attempt < 2; attempt++) {
      const pin = pins.get(origin) || await attest(origin);
      try {
        const r = await request(url, { ...opts, ca: pin.ca, pin: pin.spki });
        return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
      } catch (e) {
        if (attempt === 0 && /pin mismatch|self.signed|unable to verify|certificate/i.test(e.message)) { pins.delete(origin); continue; }
        throw e;
      }
    }
    throw new Error('attested upstream unavailable');
  }
  attestedFetch.pins = pins;
  return attestedFetch;
}
