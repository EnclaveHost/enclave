// permit r6 (SOURCE ONLY, NOT RUN): enclave-router-attest/1 - the composite router's OWN authenticated channel to the legacy
// (protected-capable) manager. Consumed by router/control.mjs (admission + operation reconciliation) and by
// manager/protected-manager.mjs (the POST /router/attest route). The router still holds NO pairing key and verifies no
// client MAC itself: the manager's ControlServer.attest() verifies the exact client request WITHOUT consuming its sequence,
// and answers under an owner-selected router key K_r (a separate 32-byte install secret, never the pairing key, never
// request-provided). The router trusts only answers whose response MAC verifies under K_r for its own fresh nonce.
//
// purpose "stage":     is this exact signed POST /protected/vms authentic for a live session, and what is its operation's
//                      current durable outcome? -> { ok, deployment, operation, requestSha256, outcome, managerEpoch }
// purpose "operation": the exact durable outcome of one operation (executed | cancelled | in-progress | unseen).
// Nothing here creates, cancels or clears anything; it only lets the router decide BEFORE it latches, and resolve exactly
// its own pending reservation from a verified terminal outcome.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

export const ATTEST_SCHEMA = 'enclave-router-attest/1';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const mac = (key, ...parts) => createHmac('sha256', key).update(parts.join('\n')).digest('hex');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export function attestKey(key) {
  const k = Buffer.isBuffer(key) ? key : null;
  if (!k || k.length !== 32) throw Error('router attestation key must be exactly 32 bytes');
  return k;
}
/** The owner-selected install secret: a 64-hex file. Missing/short/unreadable refuses (no default, no generation here). */
export function readAttestKeyFile(file) {
  const t = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(t)) throw Error('router attestation key file must hold exactly 64 lowercase hex');
  return Buffer.from(t, 'hex');
}

export const requestMac = (key, nonce, raw) => mac(key, ATTEST_SCHEMA + ' req', nonce, sha(raw));
export const responseMac = (key, nonce, status, raw) => mac(key, ATTEST_SCHEMA + ' resp', nonce, String(status), sha(raw));

/** router side: -> the request body bytes + headers for one fresh nonce */
export function attestRequest(key, payload) {
  const nonce = randomBytes(16).toString('hex');
  const raw = Buffer.from(JSON.stringify({ schema: ATTEST_SCHEMA, nonce, ...payload }));
  return { nonce, raw, headers: { 'x-router-mac': requestMac(key, nonce, raw) } };
}
/** router side: the answer is trusted only with a verifying response MAC for THIS nonce */
export function verifyAttestResponse(key, nonce, r) {
  if (!r || !Buffer.isBuffer(r.raw) || typeof r.routerMac !== 'string' || !eq(r.routerMac, responseMac(key, nonce, r.status, r.raw)))
    throw Object.assign(Error('router attestation answer not authenticated'), { status: 503 });
  const b = JSON.parse(r.raw.toString('utf8'));
  if (b?.schema !== ATTEST_SCHEMA || b.nonce !== nonce) throw Object.assign(Error('router attestation answer for another request'), { status: 503 });
  return b;
}
/** manager side: -> parsed request, or null when the router MAC does not verify */
export function verifyAttestRequest(key, raw, headers) {
  let b; try { b = JSON.parse(raw.toString('utf8')); } catch { return null; }
  if (b?.schema !== ATTEST_SCHEMA || !/^[0-9a-f]{32}$/.test(String(b.nonce)) || !eq(String(headers['x-router-mac'] || ''), requestMac(key, b.nonce, raw))) return null;
  return b;
}
export const sha256hex = sha;
