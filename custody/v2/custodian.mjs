// A v2 custodian's RELEASE path (docs/security/secret-custody-v2.md §7, spec §2). It runs inside the custodian's own
// SEV-SNP guest and holds shares of the COMMITTEE key; it answers an attested guest with partial decryptions of that
// deployment's bundle, never with a share.
//
// Release decision, in order (each failure is a refusal; none is skipped, none downgrades):
//   1. well formed;  2. carries a challenge THIS custodian issued, unexpired and unused (consumed now);
//   3. chain state at one agreed block, not older than any this custodian has seen for the deployment;
//   4. a policy, not paused; policyRev / secretRev are current; committeeId / epoch are the committee's CURRENT ones, the
//      policy and the bundle name that committee, and THIS custodian holds shares in that epoch;
//   5. the bundle's label proof verifies for (chain, vault, id, secretRev, committee) - the anti-copy check (TDH2's role);
//   6. the ledger's (beneficial) owner is the policy's pinned owner;
//   7. the endpoint holds the LIVE lease, and its registered operator signed this exact release (v2 operator message);
//   8. rules parse, evidence format verified here, runtime admitted;
//   9. the platform verifier accepts the evidence for the admitted (measurement, runtime), TCB floor, VMPL,
//      report_data = v2 binding ‖ appId, HOST_DATA = the deployment id;
//  then one DLEQ-proved partial per index it holds, HPKE-sealed to the recipient key in the binding.
// Logged: deployment, endpoint, decision, reason. Never logged: shares, keys, nonces, plaintext.
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as v2 from "./protocol.mjs";
import * as hpke from "../hpke.mjs";
import { id32 } from "../protocol.mjs";
import { parseRules, admittedMeasurements } from "../rules.mjs";
import { recoverOperator } from "../chain.mjs";
import { Refusal, memoryHighWater } from "../custodian.mjs";
import { runtimeId as runtimeIdOf } from "../../isolation/contract/runtime.mjs";
import { parseShieldRules, shieldAdmittedMeasurements, SHIELD_RULES_FORMAT } from "./shield-rules.mjs";
import { ownerReadAllowed } from "../rules.mjs";
import { hashTypedData, recoverAddress } from "viem";
import { SHIELD_EVIDENCE_FORMAT } from "./shield-evidence.mjs";

export { Refusal, memoryHighWater };
const refuse = (status, code, message) => { throw new Refusal(status, code, message); };
const HEX32 = /^(0x)?[0-9a-f]{64}$/;
const toBytes32 = (h, what) => { if (typeof h !== "string" || !HEX32.test(h)) refuse(422, "bad_request", `${what} must be 32 bytes of lowercase hex`); return Buffer.from(h.replace(/^0x/, ""), "hex"); };
const asRev = (x, what) => { const s = String(x); if (!/^(0|[1-9][0-9]{0,18})$/.test(s)) refuse(422, "bad_request", `${what} must be a non-negative integer`); return BigInt(s); };
const ENDPOINT_RE = /^https:\/\/[a-z0-9.-]{1,253}(\/[A-Za-z0-9._~-]+){0,4}$/;
export const OPERATOR_SIG_TTL_SEC = 600;
// OWNER READ (docs/security/custody-owner-read.md): the policy owner's own signed request, for an ephemeral recipient key
export const OWNER_READ_TTL_SEC = 300, OWNER_READ_WINDOW_MS = 10 * 60_000, OWNER_READ_MAX_PER_WINDOW = 30, OWNER_READ_MAX_SIG_HEX = 16384;
const ERC1271_MAGIC = "0x1626ba7e";
const SECP_N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

// keys: { encPrivateKey (32 bytes) }; shares: { get(committeeId, epoch) -> [{ k, x }] | null } (the sealed state's view)
// shield: OPTIONAL (custody/v2/shield-evidence.mjs createShieldCustody), installed only by an operator who chooses to serve
// Enclave Shield recipients. It is consulted only for a Shield-format document under owner-committed Shield rules; every
// other request takes exactly the path below, unchanged.
export function createCustodianV2({ chainId, vault, encPrivateKey, shares, chain, verifiers, shield = null, highWater = memoryHighWater(),
                                    nonceTtlSec = 120, maxNonces = 10_000, maxNoncesPerClient = 64, now = () => Date.now(), log = console.log,
                                    hostGate = null }) {   // network/platform-host-policy.mjs gate; null = enforcement off (unchanged)
  if (!(encPrivateKey instanceof Uint8Array) || encPrivateKey.length !== 32) throw new Error("custodian: the encryption key is 32 bytes");
  if (!verifiers || typeof verifiers !== "object") throw new Error("custodian: a verifier table is required");
  const encKey = hpke.publicKeyOf(encPrivateKey);
  const encKeyHex = Buffer.from(encKey).toString("hex");
  // the host operator's attach signature names the custodian's party: it must be THIS custodian's committee key, never
  // one the host or a configuration chose (the node targets each custodian by its encKey: windows/node/shield-sessions.mjs)
  if (shield && shield.party !== encKeyHex) throw new Error("custodian: the Shield adapter's party must be this custodian's own encryption key");
  const vaultL = String(vault).toLowerCase();
  const nonces = new Map(), perClient = new Map();

  // every nonce carries the PURPOSE it was issued for: a guest release challenge never authorizes an owner read, nor the reverse
  function challenge({ client = "-", purpose = "release" } = {}) {
    const t = now();
    for (const [n, e] of nonces) if (e.exp <= t) { nonces.delete(n); perClient.set(e.client, (perClient.get(e.client) || 1) - 1); }
    if ((perClient.get(client) || 0) >= maxNoncesPerClient) refuse(429, "rate_limited", "Too many outstanding challenges from this client.");
    if (nonces.size >= maxNonces) refuse(503, "busy", "Too many outstanding challenges; retry shortly.");
    const nonce = randomBytes(32).toString("hex");
    nonces.set(nonce, { exp: t + nonceTtlSec * 1000, client, purpose });
    perClient.set(client, (perClient.get(client) || 0) + 1);
    return { encKey: encKeyHex, nonce, expiresAt: Math.floor((t + nonceTtlSec * 1000) / 1000) };
  }
  function consumeNonce(n, purpose = "release") {
    const e = nonces.get(n);
    nonces.delete(n);
    if (e) perClient.set(e.client, Math.max(0, (perClient.get(e.client) || 1) - 1));
    if (!e || e.exp <= now() || e.purpose !== purpose) refuse(403, "bad_challenge", "Unknown, expired, already-used or other-purpose challenge.");
  }

  async function decide(req) {
    // 1. shape
    if (!req || typeof req !== "object" || req.v !== 2) refuse(422, "bad_request", "A v2 custody release request is {v:2, ...}.");
    if (req.purpose !== undefined) refuse(422, "bad_request", "A guest release names no purpose (an owner read goes to /v2/custody/owner-read).");
    const id = String(req.id || "");
    if (!/^0x[0-9a-f]{64}$/.test(id)) refuse(422, "bad_request", "id must be a lowercase bytes32 deployment id.");
    const endpoint = String(req.endpoint || "");
    if (!/^https?:\/\/[^\s]{1,190}$/.test(endpoint)) refuse(422, "bad_request", "endpoint must be the lease holder's registered origin.");
    const committeeId = String(req.committeeId || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(committeeId)) refuse(422, "bad_request", "committeeId must be bytes32.");
    const policyRev = asRev(req.policyRev, "policyRev"), secretRev = asRev(req.secretRev, "secretRev");
    const epoch = Number(req.epoch);
    if (!Number.isInteger(epoch) || epoch < 1 || epoch > 0xffffffff) refuse(422, "bad_request", "epoch must be a committee epoch.");
    const recipientKey = toBytes32(req.recipientKey, "recipientKey");
    if (!Array.isArray(req.challenges) || !req.challenges.length || req.challenges.length > v2.MAX_MACHINES) refuse(422, "bad_request", "challenges: 1..96 entries.");
    const challenges = req.challenges.map((c) => ({ encKey: toBytes32(c && c.encKey, "challenge encKey"), nonce: toBytes32(c && c.nonce, "challenge nonce") }));
    const mine = challenges.filter((c) => c.encKey.toString("hex") === encKeyHex);
    if (mine.length !== 1) refuse(403, "not_challenged", "The request carries no challenge from this custodian.");
    const op = req.operator || {};
    const opExpiry = Number(op.expiry);
    if (!req.evidence || typeof req.evidence !== "object") refuse(422, "bad_request", "evidence is required.");
    // 2. this custodian's challenge, consumed
    consumeNonce(mine[0].nonce.toString("hex"));
    // 3. agreed chain state, never older than seen
    let s;
    try { s = await chain.readRelease({ id, endpoint }); }
    catch (e) { refuse(503, e.code || "chain_unreadable", `Chain state could not be confirmed (${e.message}); retry.`); }
    const hw = highWater.get(id);
    if (hw && (s.blockNumber < BigInt(hw.block) || s.policy.policyRev < BigInt(hw.policyRev) || s.policy.secretRev < BigInt(hw.secretRev)))
      refuse(503, "chain_rollback", "The chain state read is older than state this custodian has already seen; retry.");
    // 4. policy, revisions, committee, membership
    const pol = s.policy;
    if (pol.policyRev === 0n) refuse(404, "no_policy", "This deployment has no custody policy.");
    highWater.set(id, { block: String(s.blockNumber), policyRev: String(pol.policyRev), secretRev: String(pol.secretRev) });
    if (pol.paused) refuse(403, "paused", "The owner has paused releases for this deployment.");
    if (policyRev !== pol.policyRev || secretRev !== pol.secretRev)
      refuse(409, "stale_revision", `The request names policy ${policyRev} / secrets ${secretRev}; current is ${pol.policyRev} / ${pol.secretRev}.`);
    const com = s.committee;
    if (!com || pol.committeeId !== committeeId || s.bundle.committeeId !== committeeId) refuse(409, "wrong_committee", "The request's committee is not the policy's and bundle's committee.");
    if (com.epoch !== epoch) refuse(409, "stale_epoch", `The request names epoch ${epoch}; the committee is at ${com.epoch}.`);
    if (s.bundle.secretRev !== pol.secretRev || !s.bundle.data.length) refuse(404, "no_bundle", "No bundle at this revision.");
    if (!com.machines.some((m) => m.encKey === "0x" + encKeyHex)) refuse(403, "not_member", "This custodian is not a machine of the committee's current epoch.");
    const held = shares.get(committeeId, epoch);
    if (!held || !held.length) refuse(503, "no_share", "This custodian holds no share for this epoch (a handover may be in progress).");
    // 5. the label proof: this R was made for THIS deployment
    const label = v2.labelOf({ chainId, vault: vaultL, id, secretRev, committeeId });
    let labelOk = false;
    try { labelOk = v2.verifyLabelProof(s.bundle.data, label); } catch { labelOk = false; }
    if (!labelOk) refuse(403, "bad_label_proof", "The bundle was not made for this deployment (its label proof does not verify).");
    // 6. ownership
    if (!s.lease || s.beneficialOwner !== pol.owner) refuse(403, "owner_mismatch", "The ledger no longer names the policy's owner for this deployment.");
    // 7. live lease + operator authorization of THIS release
    if (s.lease.runner !== s.endpointId || !(s.lease.leaseUntil > s.blockTimestamp)) refuse(403, "not_lease_holder", `${endpoint} does not hold a live lease for ${id}.`);
    if (!s.endpointOperator) refuse(403, "not_registered", `${endpoint} has no active registry entry.`);
    // 7b. platform host policy (network/platform-host-policy.mjs), judged on the lease host's operator and ACCEPTED owner
    //     at the same agreed block as everything above. Off unless configured; once configured it never fails open.
    if (hostGate) {
      if (!s.platform) refuse(503, "host_policy_unreadable", "The platform host policy facts were not read with this release; retry.");
      const host = s.platform.hosts[s.endpointId];
      const g = hostGate.decideHost({ ...host, endpoint }, s.platform);
      if (!g.admit) {
        if (g.status === "behind" && typeof hostGate.refresh === "function") hostGate.refresh().catch(() => {});
        // 403 only for a judgement ABOUT THIS HOST (ban, allowlist miss); an anchor, a node behind it, or the admin's
        // authority (rotation / ERC-1271 being re-signed) is a platform state to retry: 503, nothing released either way
        refuse(["behind", "anchor", "authority", "authority-unread", "unanchored"].includes(g.status) ? 503 : 403, "host_refused", `Platform host policy: ${g.reason}.`);
      }
    }
    const nowSec = Math.floor(now() / 1000);
    if (!Number.isInteger(opExpiry) || opExpiry <= nowSec || opExpiry > nowSec + OPERATOR_SIG_TTL_SEC) refuse(422, "bad_operator_expiry", `operator.expiry must be within the next ${OPERATOR_SIG_TTL_SEC} s.`);
    // 8. rules, format, runtime (a Shield document: only under the operator's Shield adapter AND the owner's Shield rules)
    const isShield = req.evidence.format === SHIELD_EVIDENCE_FORMAT && !!shield;
    let rules;
    if (isShield) {
      try { rules = parseShieldRules(pol.rules); } catch (e) { refuse(403, "bad_rules", `The deployment's rules do not admit an Enclave Shield recipient: ${e.message}.`); }
    } else {
      try { rules = parseRules(pol.rules); } catch (e) { refuse(403, "bad_rules", `The deployment's rules do not parse: ${e.message}.`); }
    }
    const verify = isShield ? shield.verify : Object.prototype.hasOwnProperty.call(verifiers, req.evidence.format) ? verifiers[req.evidence.format] : null;
    if (!verify) refuse(403, "unsupported_evidence", `Evidence format ${JSON.stringify(String(req.evidence.format)).slice(0, 80)} is not one this custodian verifies.`);
    let rid;
    try { rid = runtimeIdOf(req.evidence.runtime); } catch (e) { refuse(403, "bad_runtime", e.message); }
    const allowed = isShield ? shieldAdmittedMeasurements(rules, rid.toString("hex")) : admittedMeasurements(rules, rid.toString("hex"));
    if (!allowed.length) refuse(403, "runtime_not_admitted", "The guest's runtime is not one the owner admitted.");
    let transportSpki;
    try { transportSpki = new Uint8Array(Buffer.from(String(req.evidence.transportKey || ""), "base64")); } catch { transportSpki = new Uint8Array(0); }
    let binding;
    try { binding = v2.releaseBinding({ chainId, vault: vaultL, id, policyRev, secretRev, committeeId, epoch, challenges, runtimeId: new Uint8Array(rid), transportSpki, recipientKey }); }
    catch (e) { refuse(422, "bad_request", e.message); }
    const signer = await recoverOperator(v2.operatorMessage({ chainId, vault: vaultL, id, endpoint, binding, expiry: opExpiry }), op.sig);
    if (!signer || signer !== s.endpointOperator) refuse(403, "operator_sig", "The release is not signed by the lease holder's registered operator.");
    // 9. hardware evidence
    const v = await verify({ doc: req.evidence, allowedMeasurements: allowed, minTcb: rules.minTcb, vmpl: rules.vmpl, binding,
                             appId: Buffer.from(rules.appId, "hex"), hostData: id32(id),
                             // A Shield report binds the LEDGER owner, the one the guest's own quorum reads (the row's owner: a
                             // session vault's contract for a vault-owned deployment). Authorization by the policy's owner is
                             // step 6 above, unchanged: beneficialOwnerOf(id) must still be pol.owner.
                             ...(isShield ? { owner: s.lease.owner, endpoint, endpointOperator: s.endpointOperator, rules } : {}) });
    if (!v || v.ok !== true) refuse(403, "evidence_refused", (v && v.reason) || "The evidence did not verify.");
    // the partials
    const commitments = [];
    for (let i = 0; i < com.commitments.length; i += 33) commitments.push(com.commitments.subarray(i, i + 33));
    const R = v2.parseBundle(s.bundle.data).R;
    const records = held.map(({ k, x }) => v2.partial({ k, x, R, binding, commitments }));
    const sealed = v2.sealPartials({ recipientKey, binding, encKey, records });
    return { id, endpoint, count: records.length, indices: held.map((h) => h.k), sealed, synthetic: v.synthetic === true, measurement: v.measurement };
  }

  // ---- OWNER READ: the policy owner receives its own deployment's partials (docs/security/custody-owner-read.md) --------
  // Every chain fact at ONE agreed block (readOwnerRead, the same high-water marks as a release): the policy, its rules'
  // explicit ownerRead opt-in, the current committee and epoch, the bundle and its label proof, the ledger's beneficial
  // owner, and the signer (EOA recover, or the contract owner's ERC-1271 verdict at that block). The partials are bound to
  // ownerReadBinding (a distinct domain) and HPKE-sealed to the request's EPHEMERAL recipient key.
  const ownerReads = new Map();                              // id -> recent read timestamps
  async function ownerDecide(req) {
    if (!req || typeof req !== "object" || req.v !== 2 || req.purpose !== v2.OWNER_READ_PURPOSE)
      refuse(422, "bad_request", `An owner read is {v:2, purpose:"${v2.OWNER_READ_PURPOSE}", ...}.`);
    for (const k of ["evidence", "operator", "endpoint"]) if (k in req) refuse(422, "bad_request", "An owner read carries no guest evidence, operator signature or endpoint.");
    const id = String(req.id || "");
    if (!/^0x[0-9a-f]{64}$/.test(id)) refuse(422, "bad_request", "id must be a lowercase bytes32 deployment id.");
    const committeeId = String(req.committeeId || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(committeeId)) refuse(422, "bad_request", "committeeId must be bytes32.");
    const policyRev = asRev(req.policyRev, "policyRev"), secretRev = asRev(req.secretRev, "secretRev");
    const epoch = Number(req.epoch);
    if (!Number.isInteger(epoch) || epoch < 1 || epoch > 0xffffffff) refuse(422, "bad_request", "epoch must be a committee epoch.");
    const recipientKey = toBytes32(req.recipientKey, "recipientKey");
    if (!Array.isArray(req.challenges) || !req.challenges.length || req.challenges.length > v2.MAX_MACHINES) refuse(422, "bad_request", "challenges: 1..96 entries.");
    const challenges = req.challenges.map((c) => ({ encKey: toBytes32(c && c.encKey, "challenge encKey"), nonce: toBytes32(c && c.nonce, "challenge nonce") }));
    const mine = challenges.filter((c) => c.encKey.toString("hex") === encKeyHex);
    if (mine.length !== 1) refuse(403, "not_challenged", "The request carries no owner-read challenge from this custodian.");
    const expiry = Number(req.expiry), sig = String(req.sig || "").toLowerCase();
    if (!/^0x[0-9a-f]+$/.test(sig) || sig.length > OWNER_READ_MAX_SIG_HEX || sig.length % 2) refuse(422, "bad_request", "sig must be a hex signature.");
    // 1. this custodian's OWNER-READ challenge, consumed (a guest release challenge does not count)
    consumeNonce(mine[0].nonce.toString("hex"), "owner-read");
    const nowMs = now(), nowSec = Math.floor(nowMs / 1000);
    if (!Number.isInteger(expiry) || expiry <= nowSec || expiry > nowSec + OWNER_READ_TTL_SEC) refuse(422, "bad_expiry", `expiry must be within the next ${OWNER_READ_TTL_SEC} s.`);
    // the per-deployment budget counts only reads the owner signed (step 6), so a stranger cannot spend the owner's
    if ((ownerReads.get(id) || []).filter((x) => x > nowMs - OWNER_READ_WINDOW_MS).length >= OWNER_READ_MAX_PER_WINDOW) refuse(429, "rate_limited", "Too many owner reads for this deployment; retry later.");
    const typed = v2.ownerReadTypedData({ chainId, vault: vaultL, id, policyRev, secretRev, committeeId, epoch, challenges, recipientKey, expiry });
    const digest = hashTypedData(typed);
    // 2. one agreed read, never older than seen
    let s;
    try { s = await chain.readOwnerRead({ id, digest, sig }); }
    catch (e) { refuse(503, e.code || "chain_unreadable", `Chain state could not be confirmed (${e.message}); retry.`); }
    const hw = highWater.get(id);
    if (hw && (s.blockNumber < BigInt(hw.block) || s.policy.policyRev < BigInt(hw.policyRev) || s.policy.secretRev < BigInt(hw.secretRev)))
      refuse(503, "chain_rollback", "The chain state read is older than state this custodian has already seen; retry.");
    // 3. policy, revisions, committee, membership, bundle
    const pol = s.policy;
    if (pol.policyRev === 0n) refuse(404, "no_policy", "This deployment has no custody policy.");
    highWater.set(id, { block: String(s.blockNumber), policyRev: String(pol.policyRev), secretRev: String(pol.secretRev) });
    if (policyRev !== pol.policyRev || secretRev !== pol.secretRev)
      refuse(409, "stale_revision", `The request names policy ${policyRev} / secrets ${secretRev}; current is ${pol.policyRev} / ${pol.secretRev}.`);
    const com = s.committee;
    if (!com || pol.committeeId !== committeeId || s.bundle.committeeId !== committeeId) refuse(409, "wrong_committee", "The request's committee is not the policy's and bundle's committee.");
    if (com.epoch !== epoch) refuse(409, "stale_epoch", `The request names epoch ${epoch}; the committee is at ${com.epoch}.`);
    if (s.bundle.secretRev !== pol.secretRev || !s.bundle.data.length) refuse(404, "no_bundle", "No bundle at this revision.");
    if (!com.machines.some((m) => m.encKey === "0x" + encKeyHex)) refuse(403, "not_member", "This custodian is not a machine of the committee's current epoch.");
    const held = shares.get(committeeId, epoch);
    if (!held || !held.length) refuse(503, "no_share", "This custodian holds no share for this epoch (a handover may be in progress).");
    // 4. the owner's EXPLICIT opt-in, in the policy's own rules (missing = false)
    let rules;
    try {
      const o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pol.rules));
      rules = o && o.format === SHIELD_RULES_FORMAT ? parseShieldRules(pol.rules) : parseRules(pol.rules);
    } catch (e) { refuse(403, "bad_rules", `The deployment's rules do not parse: ${e.message}.`); }
    if (!ownerReadAllowed(rules)) refuse(403, "owner_read_disabled", "The deployment's rules do not allow an owner read (ownerRead is not true).");
    // 5. the pause guarantee: nothing is released for a paused deployment, to the owner either
    if (pol.paused) refuse(403, "paused", "The owner has paused releases for this deployment (owner reads included).");
    // 6. identity: the ledger still gives the policy to its pinned owner, and that owner signed THIS request
    if (!s.lease || s.beneficialOwner !== pol.owner) refuse(403, "owner_mismatch", "The ledger no longer names the policy's owner for this deployment.");
    if (s.ownerIsContract) {
      if (s.erc1271 !== ERC1271_MAGIC) refuse(403, "owner_sig", "The policy owner (a contract) does not accept this signature (ERC-1271).");
    } else {
      if (sig.length !== 132) refuse(403, "owner_sig", "An EOA owner signs with a 65-byte signature.");
      const sv = BigInt("0x" + sig.slice(66, 130)), v = parseInt(sig.slice(130, 132), 16);
      if (sv > SECP_N_HALF || ![0, 1, 27, 28].includes(v)) refuse(403, "owner_sig", "The signature is not canonical (low-s, v 27/28).");
      let signer = null;
      try { signer = (await recoverAddress({ hash: digest, signature: sig })).toLowerCase(); } catch { signer = null; }
      if (!signer || signer !== pol.owner) refuse(403, "owner_sig", "The owner read is not signed by the policy's owner.");
    }
    const counted = (ownerReads.get(id) || []).filter((x) => x > nowMs - OWNER_READ_WINDOW_MS);   // again: reads may run concurrently
    if (counted.length >= OWNER_READ_MAX_PER_WINDOW) refuse(429, "rate_limited", "Too many owner reads for this deployment; retry later.");
    counted.push(nowMs); ownerReads.set(id, counted);
    if (ownerReads.size > 10_000) ownerReads.delete(ownerReads.keys().next().value);
    // 7. the label proof: this bundle was made for THIS deployment
    const label = v2.labelOf({ chainId, vault: vaultL, id, secretRev, committeeId });
    let labelOk = false;
    try { labelOk = v2.verifyLabelProof(s.bundle.data, label); } catch { labelOk = false; }
    if (!labelOk) refuse(403, "bad_label_proof", "The bundle was not made for this deployment (its label proof does not verify).");
    // the partials, bound to the owner-read binding and sealed to the ephemeral recipient key
    const binding = v2.ownerReadBinding({ chainId, vault: vaultL, id, policyRev, secretRev, committeeId, epoch, challenges, recipientKey, expiry });
    const commitments = [];
    for (let i = 0; i < com.commitments.length; i += 33) commitments.push(com.commitments.subarray(i, i + 33));
    const R = v2.parseBundle(s.bundle.data).R;
    const records = held.map(({ k, x }) => v2.partial({ k, x, R, binding, commitments }));
    return { id, count: records.length, indices: held.map((h) => h.k), sealed: v2.sealPartials({ recipientKey, binding, encKey, records }) };
  }
  async function ownerRead(req) {
    const id = req && typeof req.id === "string" ? req.id.slice(0, 66) : "?";
    try {
      const r = await ownerDecide(req);
      log(`[custodian-v2 ${encKeyHex.slice(0, 12)}] owner-read ${id}: OK (indices ${r.indices.join(",")})`);
      return { v: 2, encKey: encKeyHex, count: r.count, sealed: Buffer.from(r.sealed).toString("base64") };
    } catch (e) {
      if (!(e instanceof Refusal)) { log(`[custodian-v2 ${encKeyHex.slice(0, 12)}] owner-read ${id}: ERROR ${e.message}`); throw new Refusal(500, "internal", "Internal error."); }
      log(`[custodian-v2 ${encKeyHex.slice(0, 12)}] owner-read ${id}: REFUSED ${e.code}: ${e.message}`);
      throw e;
    }
  }

  async function release(req) {
    const id = req && typeof req.id === "string" ? req.id.slice(0, 66) : "?";
    const ep = req && typeof req.endpoint === "string" ? req.endpoint.slice(0, 120) : "?";
    try {
      const r = await decide(req);
      log(`[custodian-v2 ${encKeyHex.slice(0, 12)}] release ${id} to ${ep}: OK (indices ${r.indices.join(",")}, measurement ${String(r.measurement).slice(0, 16)}...${r.synthetic ? ", SYNTHETIC roots" : ""})`);
      return { v: 2, encKey: encKeyHex, count: r.count, sealed: Buffer.from(r.sealed).toString("base64") };
    } catch (e) {
      if (!(e instanceof Refusal)) { log(`[custodian-v2 ${encKeyHex.slice(0, 12)}] release ${id} to ${ep}: ERROR ${e.message}`); throw new Refusal(500, "internal", "Internal error."); }
      log(`[custodian-v2 ${encKeyHex.slice(0, 12)}] release ${id} to ${ep}: REFUSED ${e.code}: ${e.message}`);
      throw e;
    }
  }
  return { encKey, encKeyHex, challenge: (o = {}) => challenge({ client: o.client }), release, _nonces: nonces,
           // owner read (custody/v2/http.mjs /v2/custody/owner-read{,/challenge})
           ownerChallenge: (o = {}) => challenge({ client: o.client, purpose: "owner-read" }), ownerRead,
           // the Shield host-session routes, when the operator installed the adapter (POST bodies as in shield-host-session.mjs)
           ...(shield ? { shieldChallenge: (b) => shield.challenge(b), shieldAttest: (b) => shield.attest(b), shieldLimits: shield.limits || null } : {}) };
}
export { ENDPOINT_RE };
