// The contract between an Enclave host's MANAGED challenge front (challenge-replica-host.mjs, run by the network runtime)
// and the host's service-tls role (host-services/service-tls.mjs, run by the host-services runner): two processes, two
// packages, one host (work/challenge-host-tls-20261021). The front writes a declaration file; service-tls fronts the
// host-derived challenge name (host-service-names.mjs hostChallengeName) only while that declaration is valid for EXACTLY
// its pinned expectation and the process on the loopback port proves it holds the declared key. Nothing here is an
// authority: the platform host policy still admits the host on both sides, and every push is attested end to end.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const FRONT_PROOF_PATH = '/.well-known/enclave-challenge-front';
// Liveness is the HMAC proof service-tls asks for every 5 s (a dead or replaced front fails it at once), not the file's
// age: the declaration is rewritten only on start/stop and every 20 min, so its trust check (an ACL read on Windows) runs
// rarely. The validity bounds a stale serving file left by a crash; it never keeps a dead front fronted (no proof).
export const DECLARATION_TTL_MS = 3_600_000;
export const DECLARATION_EVERY_MS = 1_200_000;
const HEX64 = /^[0-9a-f]{64}$/;

/** HMAC-SHA256(proofKey, nonce): the front's answer to service-tls's proof request */
export const frontProof = (key, nonce) => createHmac('sha256', Buffer.from(key, 'hex')).update('enclave-challenge-front/v1|' + nonce).digest('hex');
export function proofMatches(key, nonce, proof) {
  if (typeof proof !== 'string' || !HEX64.test(proof)) return false;
  return timingSafeEqual(Buffer.from(frontProof(key, nonce), 'hex'), Buffer.from(proof, 'hex'));
}

/**
 * -> null when `doc` is a serving declaration of exactly the expected front, else the reason (a string).
 * expect: { hostId, name, origin, frontPort, release: { dnsSha256, runtimeBundleSha256 } } (service-tls's pinned config)
 */
export function frontDeclarationRefusal(doc, expect, now = Date.now()) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'not a declaration';
  if (doc.version !== 1 || doc.kind !== 'enclave-challenge-front') return 'not an enclave-challenge-front v1 declaration';
  if (doc.role !== 'app-zone-replica') return 'not an app-zone-replica front';
  if (doc.hostId !== expect.hostId) return 'declared for another host';
  if (doc.name !== expect.name || doc.origin !== `https://${expect.name}` || expect.origin !== doc.origin) return 'declared for another name';
  if (doc.release?.dnsSha256 !== expect.release.dnsSha256 || doc.release?.runtimeBundleSha256 !== expect.release.runtimeBundleSha256) return 'a release other than the pinned one';
  if (!Number.isSafeInteger(doc.issuedAt) || !Number.isSafeInteger(doc.expiresAt) || doc.expiresAt - doc.issuedAt > 2 * DECLARATION_TTL_MS || doc.issuedAt > now + 5000) return 'malformed validity';
  if (doc.expiresAt <= now) return 'expired (the front stopped heartbeating)';
  if (doc.state !== 'serving') return `the front is ${String(doc.state).slice(0, 20)}${doc.reason ? ` (${String(doc.reason).slice(0, 120)})` : ''}`;
  if (doc.front !== `127.0.0.1:${expect.frontPort}`) return 'declared on another address or port than the pinned loopback front';
  if (typeof doc.proofKey !== 'string' || !HEX64.test(doc.proofKey)) return 'no proof key';
  return null;
}
