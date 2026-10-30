// A key custodian: one member of a custody committee (docs/security/secret-custody.md). It holds ONE durable secret, its
// X25519 share key; every share it is responsible for sits on chain sealed to that key. It releases its share of a
// deployment's data key ONLY to a recipient key bound in fresh hardware evidence, and only when every check below passes
// on chain state that several RPCs agree on.
//
// Release decision, in order (each failure is a refusal; none is skipped, none downgrades):
//   1. the request is well formed;
//   2. it carries a challenge THIS custodian issued, unexpired and unused (consumed now, whatever the verdict);
//   3. chain state at one block, agreed by >= minAgree RPCs, and not older than any state this custodian has already seen
//      for the deployment (no rollback through a lagging or lying RPC);
//   4. the policy is not paused; the request's policyRev / secretRev / epoch are the CURRENT ones (stale = refused);
//   5. the bundle exists, its share set is complete, and this custodian is a member of that epoch;
//   6. the ledger's (beneficial) owner is still the policy's pinned owner;
//   7. the endpoint holds the deployment's LIVE lease, and its registered operator signed this exact release (binding);
//   8. the rules parse; the evidence format is one this custodian verifies; the stated runtime is admitted;
//   9. the platform verifier accepts the evidence for exactly: the admitted (measurement, runtime) pairs, the TCB floor,
//      the VMPL, report_data = binding ‖ appId, HOST_DATA = the deployment id;
//  10. its own share opens and matches the on-chain commitments;
//  then the share is HPKE-sealed to the recipient key named in the binding.
//
// Logged: the deployment, endpoint, decision and reason. Never logged: shares, keys, nonces, plaintext.
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as P from "./protocol.mjs";
import * as th from "./threshold.mjs";
import * as hpke from "./hpke.mjs";
import { parseRules, admittedMeasurements } from "./rules.mjs";
import { recoverOperator } from "./chain.mjs";
import { runtimeId as runtimeIdOf } from "../isolation/contract/runtime.mjs";

export class Refusal extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const refuse = (status, code, message) => { throw new Refusal(status, code, message); };
const HEX32 = /^(0x)?[0-9a-f]{64}$/;
const toBytes32 = (h, what) => { if (typeof h !== "string" || !HEX32.test(h)) refuse(422, "bad_request", `${what} must be 32 bytes of lowercase hex`); return Buffer.from(h.replace(/^0x/, ""), "hex"); };
const asRev = (x, what) => { const s = String(x); if (!/^(0|[1-9][0-9]{0,18})$/.test(s)) refuse(422, "bad_request", `${what} must be a non-negative integer`); return BigInt(s); };

// in-memory high-water marks unless the caller passes a durable store ({ get(id), set(id, v) })
export const memoryHighWater = () => { const m = new Map(); return { get: (id) => m.get(id) || null, set: (id, v) => { m.set(id, v); } }; };

export function createCustodian({ chainId, vault, encPrivateKey, chain, verifiers, highWater = memoryHighWater(),
                                  nonceTtlSec = 120, maxNonces = 10_000, maxNoncesPerClient = 64, now = () => Date.now(), log = console.log }) {
  if (!(encPrivateKey instanceof Uint8Array) || encPrivateKey.length !== 32) throw new Error("custodian: the share key is 32 bytes");
  if (!verifiers || typeof verifiers !== "object") throw new Error("custodian: a verifier table is required");
  const encKey = hpke.publicKeyOf(encPrivateKey);
  const encKeyHex = P.hex(encKey);
  const vaultL = String(vault).toLowerCase();
  const nonces = new Map();   // nonce hex -> { exp, client }
  const perClient = new Map();   // client -> outstanding challenges (review M2: one client cannot fill the table)

  function challenge({ client = "-" } = {}) {
    const t = now();
    for (const [n, e] of nonces) if (e.exp <= t) { nonces.delete(n); perClient.set(e.client, (perClient.get(e.client) || 1) - 1); }
    if ((perClient.get(client) || 0) >= maxNoncesPerClient) refuse(429, "rate_limited", "Too many outstanding challenges from this client.");
    if (nonces.size >= maxNonces) refuse(503, "busy", "Too many outstanding challenges; retry shortly.");
    const nonce = randomBytes(32).toString("hex");
    nonces.set(nonce, { exp: t + nonceTtlSec * 1000, client });
    perClient.set(client, (perClient.get(client) || 0) + 1);
    return { encKey: encKeyHex, nonce, expiresAt: Math.floor((t + nonceTtlSec * 1000) / 1000) };
  }
  function consumeNonce(n) {
    const e = nonces.get(n);
    nonces.delete(n);   // single use, whatever happens next
    if (e) perClient.set(e.client, Math.max(0, (perClient.get(e.client) || 1) - 1));
    if (!e || e.exp <= now()) refuse(403, "bad_challenge", "Unknown, expired or already-used challenge.");
  }

  async function decide(req) {
    // 1. shape
    if (!req || typeof req !== "object" || req.v !== 1) refuse(422, "bad_request", "A custody release request is {v:1, ...}.");
    const id = String(req.id || "");
    if (!/^0x[0-9a-f]{64}$/.test(id)) refuse(422, "bad_request", "id must be a lowercase bytes32 deployment id.");
    const endpoint = String(req.endpoint || "");
    if (!/^https?:\/\/[^\s]{1,190}$/.test(endpoint)) refuse(422, "bad_request", "endpoint must be the lease holder's registered origin.");
    const policyRev = asRev(req.policyRev, "policyRev"), secretRev = asRev(req.secretRev, "secretRev");
    const epoch = Number(req.epoch);
    if (!Number.isInteger(epoch) || epoch < 1 || epoch > 0xffffffff) refuse(422, "bad_request", "epoch must be a committee epoch.");
    const recipientKey = toBytes32(req.recipientKey, "recipientKey");
    if (!Array.isArray(req.challenges) || !req.challenges.length || req.challenges.length > th.MAX_MEMBERS) refuse(422, "bad_request", "challenges: 1..32 entries.");
    const challenges = req.challenges.map((c) => ({ encKey: toBytes32(c && c.encKey, "challenge encKey"), nonce: toBytes32(c && c.nonce, "challenge nonce") }));
    const mine = challenges.filter((c) => P.hex(c.encKey) === encKeyHex);
    if (mine.length !== 1) refuse(403, "not_challenged", "The request carries no challenge from this custodian.");
    const op = req.operator || {};
    const opExpiry = Number(op.expiry);
    if (!req.evidence || typeof req.evidence !== "object") refuse(422, "bad_request", "evidence is required.");

    // 2. this custodian's challenge, consumed
    consumeNonce(P.hex(mine[0].nonce));

    // 3. agreed chain state, never older than what this custodian has seen
    let s;
    try { s = await chain.readRelease({ id, endpoint }); }
    catch (e) { refuse(503, e.code || "chain_unreadable", `Chain state could not be confirmed (${e.message}); retry.`); }
    const hw = highWater.get(id);
    if (hw && (s.blockNumber < BigInt(hw.block) || s.policy.policyRev < BigInt(hw.policyRev) || s.policy.secretRev < BigInt(hw.secretRev)))
      refuse(503, "chain_rollback", "The chain state read is older than state this custodian has already seen; retry.");
    // 4. policy and revisions (the high-water mark is kept only for deployments that HAVE a policy: random ids must not
    // grow the durable store, review M2)
    const pol = s.policy;
    if (pol.policyRev === 0n) refuse(404, "no_policy", "This deployment has no custody policy.");
    highWater.set(id, { block: String(s.blockNumber), policyRev: String(s.policy.policyRev), secretRev: String(s.policy.secretRev) });
    if (pol.paused) refuse(403, "paused", "The owner has paused releases for this deployment.");
    if (policyRev !== pol.policyRev || secretRev !== pol.secretRev || epoch !== s.bundle.epoch)
      refuse(409, "stale_revision", `The request names policy ${policyRev} / secrets ${secretRev} / epoch ${epoch}; current is ${pol.policyRev} / ${pol.secretRev} / ${s.bundle.epoch}.`);
    // 5. bundle, shares, membership
    if (!s.bundle.ciphertext.length || !s.shares || !s.shares.complete || !s.committee) refuse(404, "no_bundle", "No complete bundle at this revision.");
    const index = s.committee.members.findIndex((m) => timingSafeEqual(Buffer.from(m.encKey), Buffer.from(encKey)));
    if (index < 0) refuse(403, "not_member", "This custodian is not a member of the bundle's committee epoch.");
    const sealed = s.shares.sealedShares[index];
    if (!sealed || sealed.length !== P.SEALED_SHARE_BYTES) refuse(404, "no_share", "This custodian holds no share at this revision and epoch.");
    // 6. ownership
    if (!s.lease || s.beneficialOwner !== pol.owner) refuse(403, "owner_mismatch", "The ledger no longer names the policy's owner for this deployment.");
    // 7. live lease + the lease holder's operator authorized THIS release
    if (s.lease.runner !== s.endpointId || !(s.lease.leaseUntil > s.blockTimestamp)) refuse(403, "not_lease_holder", `${endpoint} does not hold a live lease for ${id}.`);
    if (!s.endpointOperator) refuse(403, "not_registered", `${endpoint} has no active registry entry.`);
    const nowSec = Math.floor(now() / 1000);
    if (!Number.isInteger(opExpiry) || opExpiry <= nowSec || opExpiry > nowSec + P.OPERATOR_SIG_TTL_SEC) refuse(422, "bad_operator_expiry", `operator.expiry must be within the next ${P.OPERATOR_SIG_TTL_SEC} s.`);
    // 8. rules, format, runtime
    let rules;
    try { rules = parseRules(pol.rules); } catch (e) { refuse(403, "bad_rules", `The deployment's rules do not parse: ${e.message}.`); }
    const verify = Object.prototype.hasOwnProperty.call(verifiers, req.evidence.format) ? verifiers[req.evidence.format] : null;
    if (!verify) refuse(403, "unsupported_evidence", `Evidence format ${JSON.stringify(String(req.evidence.format)).slice(0, 80)} is not one this custodian verifies.`);
    let rid;
    try { rid = runtimeIdOf(req.evidence.runtime); } catch (e) { refuse(403, "bad_runtime", e.message); }
    const allowed = admittedMeasurements(rules, rid.toString("hex"));
    if (!allowed.length) refuse(403, "runtime_not_admitted", "The guest's runtime is not one the owner admitted.");
    let transportSpki;
    try { transportSpki = new Uint8Array(Buffer.from(String(req.evidence.transportKey || ""), "base64")); } catch { transportSpki = new Uint8Array(0); }
    let binding;
    try {
      binding = P.releaseBinding({ chainId, vault: vaultL, id, policyRev, secretRev, epoch, challenges, runtimeId: new Uint8Array(rid), transportSpki, recipientKey });
    } catch (e) { refuse(422, "bad_request", e.message); }
    const signer = await recoverOperator(P.operatorMessage({ chainId, vault: vaultL, id, endpoint, binding, expiry: opExpiry }), op.sig);
    if (!signer || signer !== s.endpointOperator) refuse(403, "operator_sig", "The release is not signed by the lease holder's registered operator.");
    // 9. the hardware evidence
    const v = await verify({ doc: req.evidence, allowedMeasurements: allowed, minTcb: rules.minTcb, vmpl: rules.vmpl, binding,
                             appId: Buffer.from(rules.appId, "hex"), hostData: P.id32(id) });
    if (!v || v.ok !== true) refuse(403, "evidence_refused", (v && v.reason) || "The evidence did not verify.");
    // 10. this custodian's share
    const commitments = P.splitCommitments(s.shares.commitments);
    let y;
    try {
      y = P.openShareAtRest(encPrivateKey, { chainId, vault: vaultL, id, secretRev, committeeId: pol.committeeId, epoch, index, commitments }, sealed);
    } catch { refuse(500, "share_unopenable", "This custodian's share does not open under its key (wrong key, or a corrupt bundle)."); }
    if (!th.verifyShare(index + 1, y, commitments)) refuse(500, "share_inconsistent", "This custodian's share does not match the bundle's commitments.");
    const out = P.sealResponse({ recipientKey, binding, encKey, index, y });
    return { id, endpoint, index, sealed: out, synthetic: v.synthetic === true, measurement: v.measurement };
  }

  async function release(req) {
    const id = req && typeof req.id === "string" ? req.id.slice(0, 66) : "?";
    const ep = req && typeof req.endpoint === "string" ? req.endpoint.slice(0, 120) : "?";
    try {
      const r = await decide(req);
      log(`[custodian ${encKeyHex.slice(0, 12)}] release ${id} to ${ep}: OK (member ${r.index}, measurement ${String(r.measurement).slice(0, 16)}...${r.synthetic ? ", SYNTHETIC roots" : ""})`);
      return { v: 1, encKey: encKeyHex, index: r.index, sealed: Buffer.from(r.sealed).toString("base64") };
    } catch (e) {
      if (!(e instanceof Refusal)) { log(`[custodian ${encKeyHex.slice(0, 12)}] release ${id} to ${ep}: ERROR ${e.message}`); throw new Refusal(500, "internal", "Internal error."); }
      log(`[custodian ${encKeyHex.slice(0, 12)}] release ${id} to ${ep}: REFUSED ${e.code}: ${e.message}`);
      throw e;
    }
  }

  return { encKey, encKeyHex, challenge, release, _nonces: nonces };
}

// HTTP surface:  GET /v1/custody/info   POST /v1/custody/challenge   POST /v1/custody/release
// a token bucket per client address (review M2): each request is cheap to send and a release costs this custodian a read
// across all its RPCs. `clientOf` names the client (the socket's address by default; behind a reverse proxy, its header).
export function rateLimiter({ capacity = 30, refillPerSec = 1, now = () => Date.now(), maxClients = 100_000 } = {}) {
  const b = new Map();
  return (key) => {
    const t = now();
    const e = b.get(key) || { tokens: capacity, at: t };
    e.tokens = Math.min(capacity, e.tokens + ((t - e.at) / 1000) * refillPerSec); e.at = t;
    if (b.size > maxClients) b.clear();
    if (e.tokens < 1) { b.set(key, e); return false; }
    e.tokens -= 1; b.set(key, e); return true;
  };
}

export function custodianHandler(c, { info = {}, maxBody = 65536, rate = rateLimiter(), clientOf = (req) => req.socket.remoteAddress || "-" } = {}) {
  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  return async (req, res) => {
    const u = new URL(req.url, "http://x");
    const client = String(clientOf(req) || "-").slice(0, 64);
    if (req.method === "POST" && !rate(client)) return json(res, 429, { error: "rate_limited", message: "Too many requests; retry shortly." });
    try {
      if (req.method === "GET" && u.pathname === "/v1/custody/info") return json(res, 200, { v: 1, encKey: c.encKeyHex, ...info });
      if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed", message: "POST only." });
      const chunks = []; let n = 0;
      for await (const ch of req) { n += ch.length; if (n > maxBody) return json(res, 413, { error: "too_large", message: "Body too large." }); chunks.push(ch); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return json(res, 400, { error: "bad_json", message: "Body must be JSON." }); }
      if (u.pathname === "/v1/custody/challenge") return json(res, 200, c.challenge({ client }));
      if (u.pathname === "/v1/custody/release") return json(res, 200, await c.release(body));
      return json(res, 404, { error: "not_found", message: "Unknown custody route." });
    } catch (e) {
      if (e instanceof Refusal) return json(res, e.status, { error: e.code, message: e.message });
      return json(res, 500, { error: "internal", message: "Internal error." });
    }
  };
}

export const serveCustodian = (c, { port = 0, host = "127.0.0.1", info, rate, clientOf } = {}) => new Promise((resolve) => {
  const srv = http.createServer(custodianHandler(c, { info, ...(rate ? { rate } : {}), ...(clientOf ? { clientOf } : {}) }));
  srv.listen(port, host, () => resolve(srv));
});
