// A fresh public challenge proves consumption of dedicated random canaries, not attestation by itself.
// Never send marker values or expected HMACs to the endpoint; never return peer-controlled response text.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const HEX = /^[0-9a-f]{64}$/;
const NAME = /^CANARY_[A-Z0-9_]{1,40}$/;
const MARKER = /^CANARY_[0-9]{8}T[0-9]{6}Z_[a-z0-9-]{1,32}_[0-9a-f]{64}$/;
const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const mac = (value, name, challenge) => createHmac('sha256', value).update(`enclave-custody-canary-proof-v1\n${name}\n${challenge}`).digest('hex');
function validateSets(sets) {
  if (!Array.isArray(sets) || !sets.length) throw new Error('proof: required marker sets missing');
  for (const set of sets) {
    const names = plain(set) ? Object.keys(set) : [];
    if (!names.length || names.length > 8 || names.some(n => !NAME.test(n) || !MARKER.test(set[n])))
      throw new Error('proof: dedicated canary markers required');
  }
}
export function evalProof({ challenge, body, required, rejected = [] }) {
  validateSets(required);
  if (rejected.length) validateSets(rejected);
  if (!HEX.test(challenge)) throw new Error('proof: malformed challenge');
  const names = Object.keys(required[0]).sort();
  // A single app cannot simultaneously hold two different values under the same name.
  if (required.some(s => !same(Object.keys(s).sort(), names) || names.some(n => s[n] !== required[0][n])))
    throw new Error('proof: required marker sets conflict');
  const reasons = [];
  const shape = plain(body) && same(Object.keys(body).sort(), ['names', 'proofs', 'v']) && body.v === 1
    && Array.isArray(body.names) && same(body.names, names) && plain(body.proofs)
    && same(Object.keys(body.proofs).sort(), names) && names.every(n => HEX.test(body.proofs[n]));
  if (!shape) reasons.push('response shape or marker names differ');
  let matched = false, oldMatches = 0;
  if (shape) {
    const matches = set => names.every(n => typeof set[n] === 'string'
      && timingSafeEqual(Buffer.from(body.proofs[n], 'hex'), Buffer.from(mac(set[n], n, challenge), 'hex')));
    matched = required.every(matches);
    oldMatches = rejected.filter(matches).length;
    if (!matched) reasons.push('current canary proof did not match');
    if (oldMatches) reasons.push('proof matched a rejected canary revision');
  }
  return { outcome: reasons.length ? 'fail' : 'pass', reasons,
    evidence: { challenge, names, currentMatched: matched, rejectedSetsMatched: oldMatches,
      scope: 'Fresh HMAC proves value consumption at the queried endpoint; real SNP release evidence is a separate mandatory gate.' } };
}
export async function proveConsumption({ id, required, rejected = [], fetchImpl = fetch, rng = randomBytes }) {
  if (!/^0x[0-9a-f]{64}$/.test(String(id))) throw new Error('proof: deployment id required');
  validateSets(required); if (rejected.length) validateSets(rejected);
  const bytes = rng(32);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('proof: challenge generator failed');
  const challenge = Buffer.from(bytes).toString('hex');
  const url = `https://${id.slice(2, 10)}.app.enclave.host/canary/proof?c=${challenge}`;
  const fail = reason => ({ outcome: 'fail', reasons: [reason], evidence: { id, challenge, scope: 'Endpoint proof only; no hardware claim.' } });
  try {
    const r = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (r.status !== 200 || r.redirected || (r.url && r.url !== url)) return fail('HTTP endpoint did not answer directly with 200');
    if (!/^application\/json(?:\s*;|$)/i.test(r.headers.get('content-type') || '')
      || !(r.headers.get('cache-control') || '').split(',').some(x => x.trim().toLowerCase() === 'no-store')) return fail('proof response headers invalid');
    const declared = r.headers.get('content-length');
    if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > 4096)) return fail('proof response exceeds size limit');
    const reader = r.body?.getReader();
    if (!reader) return fail('proof response body absent');
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); return fail('proof response exceeds size limit'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = evalProof({ challenge, body, required, rejected });
    return { ...result, evidence: { id, ...result.evidence } };
  } catch { return fail('proof request, decoding or validation failed'); }
}
