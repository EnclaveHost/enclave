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
//
// A policy is either {allowedMeasurements[, hostData]} or {deployment: {...}} (chain-policy.mjs):
// then the allowed measurements and the required HOST_DATA (the deployment id) come from Base,
// are re-read every recheckMs (default 60 s), and any change or failed read drops the pin, so
// the origin is refused until the chain admits it again.
import https from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import { verifyQuote } from '../../relay/snp-verify.mjs';
import { resolveDeploymentPolicy } from './chain-policy.mjs';

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

export function createAttestedFetch({ attested, fallbackFetch = fetch, kds = true, minTcb, chainFetch = fetch } = {}) {
  const pins = new Map(), inflight = new Map(), chain = new Map();
  // The policy in force for an origin; for chain policies, re-read when stale.
  async function policyOf(origin) {
    const policy = attested[origin];
    if (!policy.deployment) return policy;
    const c = chain.get(origin);
    if (c && Date.now() - c.at < (policy.deployment.recheckMs ?? 60000)) return c.policy;
    let next;
    try { next = await resolveDeploymentPolicy(policy.deployment, { fetchImpl: chainFetch }); }
    catch (e) { chain.delete(origin); pins.delete(origin); throw new Error('chain refuses enclave: ' + e.message); }
    if (c && JSON.stringify([c.policy.allowedMeasurements, c.policy.hostData]) !== JSON.stringify([next.allowedMeasurements, next.hostData])) pins.delete(origin);
    chain.set(origin, { policy: next, at: Date.now() });
    return next;
  }
  // One attestation per origin at a time: concurrent first requests share it.
  function attest(origin) {
    if (!inflight.has(origin)) inflight.set(origin, attestOnce(origin).finally(() => inflight.delete(origin)));
    return inflight.get(origin);
  }
  async function attestOnce(origin) {
    const policy = await policyOf(origin);
    const r = await request(origin + '/.well-known/enclave-attestation', {});
    if (r.status !== 200 || !r.peerDer) throw new Error('attestation unavailable');
    const doc = JSON.parse(r.body.toString('utf8'));
    const served = spkiOf(r.peerDer);
    if (!served.equals(spkiOf(doc.certificate))) throw new Error('served certificate differs from the attested one');
    const v = await verifyQuote(Buffer.from(doc.report, 'base64'), {
      transportKeySpki: served, challenge: Buffer.alloc(0), allowedMeasurements: policy.allowedMeasurements, kds, minTcb });
    if (!v.ok || v.vcekVerified !== true) throw new Error('enclave attestation refused: ' + (v.reasons || []).slice(-1)[0]);
    if (policy.hostData && v.hostData !== policy.hostData) throw new Error('enclave attestation refused: HOST_DATA is not this deployment');
    const pin = { spki: sha256(served), ca: doc.certificate, measurement: v.measurement, hostData: v.hostData, at: Date.now() };
    pins.set(origin, pin);
    return pin;
  }
  async function attestedFetch(url, opts = {}) {
    const origin = new URL(url).origin;
    if (!attested?.[origin]) return fallbackFetch(url, opts);
    if (attested[origin].deployment) await policyOf(origin);   // fail closed as soon as the chain withdraws it
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
  attestedFetch.chain = chain;
  return attestedFetch;
}
