// metal/measured-control-verify.mjs -- verify that an independent host's control plane is the MEASURED control guest the
// owner approved, and that the process answering on its endpoint holds the keys that guest minted. Used by the owner's
// `check`, by any client before it trusts the host's endpoint, and by tests. No Enclave service is consulted.
//
// The checks, in order (work/measured-control-interface.txt section 4):
//   1. one TLS connection to the endpoint, no CA validation: the peer SPKI is captured on the SAME socket that returns
//      the evidence for OUR nonce;
//   2. the evidence is bounded and well-formed, and its statement is canonical (the bound bytes are the served bytes);
//   3. the statement names the owner's config digest and the HOST_DATA derived from it;
//   4. the TLS peer is the attested control key (sha256(SPKI) == statement.keys.controlTls);
//   5. the SNP report, through the repository's verifier UNCHANGED (verifier/snp.mjs, domain ABI/2 rule):
//      - AMD chain, CRL, signature, VCEK identity, TCB floor, DEBUG/MIGRATE_MA off, VMPL 0;
//      - measurement allowed;
//      - report_data == sha256(domain || sha256(statement) || nonce), [32:64] == CONTROL_ROLE;
//      - HOST_DATA == expected.
//      Only "verified" passes;
//   6. the running supervisor, over a second TLS connection pinned to that SPKI, reports the minted proof key and
//      session key;
//   7. the registry entry, through the owner's quorum: active, the owner's operator, the minted proof key.
// status: verified | pending (not yet registered / proof key not yet republished) | unknown (a quorum or collateral read
// failed) | rejected (any definite mismatch). Only "verified" may be reported READY.
import https from 'node:https';
import { randomBytes, X509Certificate } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { parseEnvelope, EnvelopeError } from '../verifier/envelope.mjs';
import { verifySnp } from '../verifier/snp.mjs';
import { EVIDENCE_FORMAT, EVIDENCE_PATH, CONTROL_ROLE, canonicalDirectConfig, configDigest, hostDataHex, parseStatement, bindingFor,
  addressOfPublicKey, jwkThumbprint, sha256Hex } from './guest/measured-control.mjs';

export const MAX_EVIDENCE_BYTES = 256 * 1024;
const HEX96 = /^[0-9a-f]{96}$/;
const keccakBytes = (b) => keccak256(b);
export const registryIdOf = (publicUrl) => keccak256(toHex(String(publicUrl).replace(/\/+$/, '')));   // EnclaveRegistry.idOf(endpoint)
export const proofAddressOf = (statement) => addressOfPublicKey(statement.keys.proof.publicKey, keccakBytes);

function endpointOf(raw) {
  let u; try { u = new URL(String(raw)); } catch { throw new Error('control endpoint is not a URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search || (u.pathname !== '/' && u.pathname !== '')) throw new Error('control endpoint must be an https origin (the forwarded control port)');
  return u;
}
/** One GET over one TLS connection; the peer SPKI from that same socket. pinSha256: refuse any other peer key. */
export function tlsGet(origin, pathAndQuery, { timeoutMs = 15000, maxBytes = MAX_EVIDENCE_BYTES, pinSha256 = null } = {}) {
  const u = endpointOf(origin);
  return new Promise((resolve, reject) => {
    let peerSpki = null;
    const req = https.request({ host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || 443, path: pathAndQuery, method: 'GET', agent: false, timeout: timeoutMs,
      rejectUnauthorized: false, servername: /^[\d.]+$|:/.test(u.hostname) ? undefined : u.hostname, headers: { accept: 'application/json' },
      // trust comes from the attestation, not a CA; a pinned request refuses any other key before a byte is sent
      checkServerIdentity: () => undefined }, (res) => {
      let size = 0; const chunks = [];
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(new Error(`answer exceeds ${maxBytes} bytes`)); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), peerSpki }));
      res.on('error', reject);
    });
    req.on('socket', (s) => s.once('secureConnect', () => {
      try { peerSpki = new X509Certificate(s.getPeerCertificate(true).raw).publicKey.export({ type: 'spki', format: 'der' }); }
      catch (e) { req.destroy(new Error(`no peer certificate: ${e.message}`)); return; }
      if (pinSha256 && sha256Hex(peerSpki) !== pinSha256) req.destroy(new Error('the endpoint presented a key other than the attested control key'));
    }));
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * verifyMeasuredControl(opts) -> { status, checks, reasons, identity, measurement }
 *   url: https origin of the forwarded control port.
 *   expect: { config (raw or canonical) | configDigest, measurements: [96 hex], minTcb, crl ("required"), roots?, product?,
 *             guestPolicy? }.
 *   collateral: verifier/collateral.mjs adapter.
 *   registry: async (registryId) -> { operator, proofKey, active } | null (not registered); THROWS when the owner's quorum
 *             cannot agree. Required: without it the result is at best "pending".
 *   nonce (tests), now, timeoutMs.
 */
export async function verifyMeasuredControl({ url, expect = {}, collateral = null, registry = null, nonce = randomBytes(32), now = new Date(), timeoutMs = 15000 } = {}) {
  const checks = {}, reasons = [], identity = {};
  const result = (status) => ({ status, ready: status === 'verified', checks, reasons, identity });
  const fail = (name, why) => { checks[name] = false; reasons.push(`REJECT (${name}): ${why}`); return result('rejected'); };
  const unknown = (name, why) => { checks[name] = null; reasons.push(`UNKNOWN (${name}): ${why}`); return result('unknown'); };
  const pass = (name, why) => { checks[name] = true; reasons.push(why); };

  // the owner's expectations, checked before anything is fetched
  let wantDigest;
  try { wantDigest = expect.config ? configDigest(canonicalDirectConfig(expect.config)) : String(expect.configDigest || ''); }
  catch (e) { return fail('expectation', `the expected direct config is invalid: ${e.message}`); }
  if (!/^[0-9a-f]{64}$/.test(wantDigest)) return fail('expectation', 'no expected config digest: there is nothing to compare the guest with');
  const measurements = (expect.measurements || []).map((m) => String(m).toLowerCase());
  if (!measurements.length || !measurements.every((m) => HEX96.test(m))) return fail('expectation', 'expected measurements: one or more 96-hex launch digests the owner recomputed from the reviewed control image');
  if (!Buffer.isBuffer(nonce) || nonce.length !== 32) return fail('expectation', 'nonce must be 32 bytes');

  // 1. evidence and the peer key from one connection
  let got;
  try { got = await tlsGet(url, `${EVIDENCE_PATH}?nonce=${nonce.toString('hex')}`, { timeoutMs }); }
  catch (e) { return unknown('evidence', `control endpoint unreachable: ${String(e.message).slice(0, 160)}`); }
  if (got.status !== 200) return got.status === 429 || got.status >= 500 ? unknown('evidence', `HTTP ${got.status}`) : fail('evidence', `HTTP ${got.status}`);
  let ev; try { ev = JSON.parse(got.body.toString('utf8')); } catch { return fail('evidence', 'not JSON'); }
  // 2. shape and statement
  if (!ev || typeof ev !== 'object' || ev.format !== EVIDENCE_FORMAT) return fail('evidence', `format ${ev?.format ?? 'none'} is not ${EVIDENCE_FORMAT}`);
  let st; try { st = parseStatement(ev.statement); } catch (e) { return fail('statement', e.message); }
  pass('statement', 'the statement is canonical and well-formed');
  Object.assign(identity, { bootId: st.bootId, operator: st.identity.operator, publicUrl: st.identity.publicUrl, controlTlsSpkiSha256: st.keys.controlTls.spkiSha256,
    proofKey: proofAddressOf(st), sessionKid: jwkThumbprint(st.keys.session), registryId: registryIdOf(st.identity.publicUrl) });
  // 3. the owner's config, and HOST_DATA derived from it
  if (st.configDigest !== wantDigest) return fail('config', `the guest runs config ${st.configDigest.slice(0, 16)}…, not the owner's ${wantDigest.slice(0, 16)}…`);
  const wantHostData = hostDataHex(wantDigest);
  if (st.hostData !== wantHostData) return fail('config', 'the statement names HOST_DATA that is not derived from the config digest');
  pass('config', `config ${wantDigest.slice(0, 16)}… (HOST_DATA ${wantHostData.slice(0, 16)}…)`);
  // 4. the TLS peer is the attested key
  if (!got.peerSpki || sha256Hex(got.peerSpki) !== st.keys.controlTls.spkiSha256) return fail('endpoint key', 'the TLS peer is not the control key the statement names: another process or a relay terminates this connection');
  pass('endpoint key', `the TLS peer holds the attested control key sha256:${st.keys.controlTls.spkiSha256.slice(0, 16)}…`);
  // 5. the hardware report, through the repository verifier
  if (st.mode !== 'snp' || typeof ev.report !== 'string' || !ev.report) return fail('report', `no hardware report (mode ${st.mode}${ev.unattested ? `: ${ev.unattested}` : ''}): an unattested launch proves nothing`);
  let env;
  try { env = parseEnvelope({ format: 'sev-snp-guest-domain-v1', report: ev.report, abi: 'enclave-domain-abi/2', ...(typeof ev.certs === 'string' ? { certs: ev.certs } : {}) }); }
  catch (e) { return fail('report', e instanceof EnvelopeError ? e.message : `malformed report: ${e.message}`); }
  const policy = { allowedMeasurements: measurements, minTcb: expect.minTcb, crl: expect.crl ?? 'required',
    ...(expect.roots ? { roots: expect.roots } : {}), ...(expect.product ? { product: expect.product } : {}), ...(expect.guestPolicy ? { guestPolicy: expect.guestPolicy } : {}) };
  const context = { transportKeySpki: got.peerSpki, expectedBinding: bindingFor(ev.statement, nonce), expectedAppId: CONTROL_ROLE,
    expectedHostData: Buffer.from(wantHostData, 'hex'), now, ...(typeof ev.certs === 'string' ? { auxblob: Buffer.from(ev.certs, 'base64') } : {}) };
  let v;
  try { v = await verifySnp(env, policy, context, collateral); }
  catch (e) { return unknown('report', `verifier: ${e.message}`); }
  identity.measurement = v.claims?.measurement ?? null;
  checks.hardware = v.checks;
  if (v.status !== 'verified') {
    reasons.push(...v.reasons.map((r) => `report: ${r}`));
    const collateralMissing = v.status === 'rejected' && (v.checks?.vcek === false || v.checks?.chain === false) && /unavailable|no VCEK|no AMD/.test(v.reasons.join(' '));
    if (collateralMissing) return unknown('report', 'AMD collateral could not be obtained');
    checks.report = false;
    return result('rejected');   // "limited" too: an omitted security check is not readiness
  }
  pass('report', `SEV-SNP report verified: measurement ${identity.measurement.slice(0, 16)}… is allowed, it binds this statement and our nonce, its role is the control guest, HOST_DATA binds the config`);
  // 6. the running supervisor holds the minted keys (a second connection, pinned to the attested key)
  try {
    const a = await tlsGet(url, '/v1/attestation', { timeoutMs, pinSha256: st.keys.controlTls.spkiSha256, maxBytes: 1024 * 1024 });
    const j = a.status === 200 ? JSON.parse(a.body.toString('utf8')) : null;
    if (!j) return unknown('supervisor', `the supervisor answered HTTP ${a.status}`);
    if (String(j.proofKey?.address || '').toLowerCase() !== identity.proofKey) return fail('supervisor', `the running supervisor signs proofs with ${j.proofKey?.address || 'no key'}, not the minted ${identity.proofKey}`);
    if (j.sessionKey?.kid !== identity.sessionKid) return fail('supervisor', 'the running supervisor\'s session key is not the minted one');
    pass('supervisor', `the supervisor behind the attested endpoint uses the minted proof key ${identity.proofKey} and session key ${identity.sessionKid.slice(0, 12)}…`);
  } catch (e) { return /other than the attested/.test(e.message) ? fail('supervisor', e.message) : unknown('supervisor', String(e.message).slice(0, 160)); }
  // 7. the registry, through the owner's quorum
  if (typeof registry !== 'function') { checks.registry = null; reasons.push('PENDING (registry): no quorum reader supplied, so the on-chain identity is not checked'); return result('pending'); }
  let e;
  try { e = await registry(identity.registryId); }
  catch (err) { return unknown('registry', `the owner's quorum did not agree: ${String(err.message).slice(0, 160)}`); }
  if (!e) { checks.registry = null; reasons.push(`PENDING (registry): ${st.identity.publicUrl} is not registered yet`); return result('pending'); }
  if (String(e.operator).toLowerCase() !== st.identity.operator) return fail('registry', `registered to ${e.operator}, not the bound operator ${st.identity.operator}`);
  if (!e.active) return fail('registry', 'registered but inactive');
  if (String(e.proofKey).toLowerCase() !== identity.proofKey) {
    checks.registry = null;
    reasons.push(`PENDING (registry): the registry's proof key ${e.proofKey} is not this boot's ${identity.proofKey} (the guest republishes it at boot; a key used outside the guest would show here)`);
    return result('pending');
  }
  pass('registry', `registry entry ${identity.registryId.slice(0, 18)}… is active, operated by ${st.identity.operator}, with the minted proof key`);
  return result('verified');
}
