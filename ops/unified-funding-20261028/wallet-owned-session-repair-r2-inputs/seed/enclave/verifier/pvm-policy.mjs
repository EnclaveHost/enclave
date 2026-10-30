// verifier/pvm-policy.mjs: an INDEPENDENT check of the installed pVM client's signed policy, written from the owner's
// design text (shielded/anchor/avf/client/DESIGN.md at pvm-cpu/portable-runtime 4e55879b, recorded in
// docs/security/pvm-client-bootstrap-review.md), not from their src/trust.js, which the tests run beside this as a
// differential through the device run's recorded outcomes. Nothing here is cryptography of ours: Ed25519 and SHA-256
// from node:crypto.
//
// The rule: a policy is { policy: base64(exact JSON bytes), sig }; the bytes must be strict compact JSON (they round-trip
// unchanged) of a closed shape; the policy carries its own raw Ed25519 public key, whose sha256 must equal the anchored
// fingerprint given at install (or the nextPolicyKey a previously accepted policy named); the signature is Ed25519 over
// "enclave-pvm-client-policy-v1\n" || the exact bytes; the serial must be at least the install floor and above the newest
// accepted serial (the same serial with the same bytes is the same policy; the same serial with other bytes is
// equivocation); notBefore and notAfter are enforced on the client's clock; every list is non-empty; root pins may only
// narrow the built-in Google roots; formats and modes must be known; minClientVersion disables an older client. A policy
// that passes yields the EXPECTATIONS the consumer gate (verifier/admission.mjs) takes: nothing else supplies them.
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

export const POLICY_TYPE = "enclave-pvm-client-policy", POLICY_DOMAIN = "enclave-pvm-client-policy-v1\n";
// type 2 (INSTANCE-BINDING.md, client 0.5.0, 2026-09-24): the same fields, signature domain and serial space; a deployment
// entry may bind the INSTANCES that serve it, { id, app, instances }. A type-1 policy carrying instances is refused by name,
// never read as unbound; clients before 0.5.0 refuse type 2 as not a pVM client policy (the owner's test on the 0.4.1 build).
export const POLICY_TYPE_V2 = "enclave-pvm-client-policy/2", INSTANCE_ID = /^[0-9a-f]{64}$/, MAX_INSTANCES = 8;
export const PVM_EVIDENCE_FORMAT_V3 = "enclave-pvm-app-evidence/v3";
export const POLICY_FIELDS = ["type", "key", "serial", "notBefore", "notAfter", "codeHashes", "authorityHashes", "runtimeIds", "appIds", "googleRootPins", "formats", "sealedModes", "sealedWindow", "minClientVersion", "nextPolicyKey"];
export const BUILTIN_GOOGLE_ROOTS = ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"];   // relay/avf-verify.mjs pins
export const KNOWN_FORMATS = ["enclave-pvm-app-evidence/v2", "enclave-pvm-app-evidence/v3"], KNOWN_MODES = ["whole", "chunked"];
export const MAX_POLICY_BYTES = 64 * 1024;
// the optional deployment table (agreed with the pVM owner 2026-09-24, client 0.4.0): which app a deployment is expected to
// run, signed like every other field; an id is the platform ledger's bytes32 in canonical form, 0x + 64 lowercase hex
export const DEPLOYMENT_ID = /^0x[0-9a-f]{64}$/, MAX_DEPLOYMENTS = 64;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const isHex = (s, n) => typeof s === "string" && s.length === n && /^[0-9a-f]+$/.test(s);
const hexList = (v, n, max = 256) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every((x) => isHex(x, n)) && new Set(v).size === v.length;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const semver = (s) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(s)); return m ? [+m[1], +m[2], +m[3]] : null; };
const cmpVer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
export const keyFingerprint = (keyHex) => sha256hex(Buffer.from(keyHex, "hex"));

// verifyClientPolicy(envelope, { anchorFp, serialFloor, state?, now, clientVersion, builtinRoots?, knownFormats?, knownModes? })
//   -> { ok, reason, policy, serial, digest, disabled, expectationsFor(appIdHex) }
export function verifyClientPolicy(envelope, { anchorFp, serialFloor = 1, state = null, now = Date.now(), clientVersion = "0.0.0", builtinRoots = BUILTIN_GOOGLE_ROOTS, knownFormats = KNOWN_FORMATS, knownModes = KNOWN_MODES } = {}) {
  const no = (reason) => ({ ok: false, reason, policy: null, serial: null, digest: null, disabled: false });
  if (!isHex(anchorFp, 64)) return no("no anchored policy-key fingerprint: the client has no root to judge a policy against");
  if (!Number.isInteger(serialFloor) || serialFloor < 1) return no("the install serial floor must be a positive integer");
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return no("the policy envelope is not an object");
  if (Object.keys(envelope).sort().join(",") !== "policy,sig") return no("the policy envelope must be exactly { policy, sig }");
  if (typeof envelope.policy !== "string" || !envelope.policy || envelope.policy.length > MAX_POLICY_BYTES * 2 || !B64.test(envelope.policy)) return no("the policy is not strict base64");
  if (!isHex(envelope.sig, 128)) return no("the signature is not 64 bytes of hex");
  const bytes = Buffer.from(envelope.policy, "base64");
  if (bytes.toString("base64") !== envelope.policy) return no("the policy base64 is not canonical");
  let p; try { p = JSON.parse(bytes.toString("utf8")); } catch { return no("the policy bytes are not JSON"); }
  if (!p || typeof p !== "object" || Array.isArray(p)) return no("the policy is not an object");
  if (Buffer.from(JSON.stringify(p), "utf8").compare(bytes) !== 0) return no("the policy bytes are not strict compact JSON (they do not round-trip unchanged: padding, duplicate keys or key order)");
  // the 15 fields in their order; the one optional field, deployments, may stand anywhere (the contract fixes no position for it)
  if (Object.keys(p).filter((k) => k !== "deployments").join(",") !== POLICY_FIELDS.join(",")) return no(`the policy fields must be exactly ${POLICY_FIELDS.join(", ")} in that order, optionally with deployments (got ${Object.keys(p).join(", ")})`);
  if (p.type !== POLICY_TYPE && p.type !== POLICY_TYPE_V2) return no(`the policy type is ${JSON.stringify(p.type)}, not ${POLICY_TYPE} or ${POLICY_TYPE_V2}`);
  const typeV2 = p.type === POLICY_TYPE_V2;
  if (!isHex(p.key, 64)) return no("the policy key is not a raw 32-byte Ed25519 public key in hex");
  // 1. the key is the anchor (or the successor a previously accepted policy named)
  const fp = keyFingerprint(p.key);
  const successor = state && isHex(state.nextPolicyFp, 64) ? state.nextPolicyFp : null;
  if (fp !== anchorFp && fp !== successor) return no("the policy is signed by a key this client's anchor does not name");
  // 2. the signature over the domain and the exact bytes
  let sigOk = false;
  try { sigOk = cryptoVerify(null, Buffer.concat([Buffer.from(POLICY_DOMAIN), bytes]), createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(p.key, "hex")]), format: "der", type: "spki" }), Buffer.from(envelope.sig, "hex")); } catch { sigOk = false; }
  if (!sigOk) return no("the policy signature does not verify under the anchored key over the exact bytes");
  // 3. serial: floor, rollback, equivocation
  if (!Number.isInteger(p.serial) || p.serial < 1) return no("the policy serial is not a positive integer");
  const digest = sha256hex(bytes);
  if (p.serial < serialFloor) return no(`policy serial ${p.serial} is below the install floor ${serialFloor}`);
  if (state && Number.isInteger(state.serial)) {
    if (p.serial < state.serial) return no(`policy serial ${p.serial} is below the ${state.serial} this client holds: a rollback`);
    if (p.serial === state.serial && state.digest !== digest) return no(`policy serial ${p.serial} was already accepted with other bytes: equivocation`);
  }
  // 4. time, on the client's clock
  const nb = Date.parse(p.notBefore), na = Date.parse(p.notAfter);
  if (!Number.isFinite(nb) || !Number.isFinite(na) || !/Z$/.test(p.notBefore) || !/Z$/.test(p.notAfter) || na <= nb) return no("notBefore/notAfter are not a valid UTC window");
  if (now < nb) return no(`the policy is not yet valid (notBefore ${p.notBefore})`);
  if (now > na) return no(`the policy expired (notAfter ${p.notAfter}): no operation, never a stale fallback`);
  // 5. pins: non-empty, well-formed, roots only narrowed
  if (!hexList(p.codeHashes, 64)) return no("codeHashes must be a non-empty list of 32-byte hex hashes");
  if (!hexList(p.authorityHashes, 128)) return no("authorityHashes must be a non-empty list of 64-byte hex hashes");
  if (!hexList(p.runtimeIds, 64)) return no("runtimeIds must be a non-empty list of 32-byte hex ids");
  if (!hexList(p.appIds, 64)) return no("appIds must be a non-empty list of 32-byte hex ids");
  if (!hexList(p.googleRootPins, 64, 16)) return no("googleRootPins must be a non-empty list of root fingerprints (an empty list is never 'all')");
  const unknownRoot = p.googleRootPins.find((r) => !builtinRoots.includes(r));
  if (unknownRoot) return no(`googleRootPins names ${unknownRoot.slice(0, 16)}..., which is not a built-in Google root: a policy may narrow the roots, never widen them`);
  if (!Array.isArray(p.formats) || !p.formats.length || p.formats.some((f) => !knownFormats.includes(f)) || new Set(p.formats).size !== p.formats.length) return no("formats must be a non-empty list of evidence formats this client knows");
  if (!Array.isArray(p.sealedModes) || !p.sealedModes.length || p.sealedModes.some((m) => !knownModes.includes(m)) || new Set(p.sealedModes).size !== p.sealedModes.length) return no("sealedModes must be a non-empty list of modes this client knows");
  const w = p.sealedWindow;
  if (!w || typeof w !== "object" || Object.keys(w).sort().join(",") !== "maxRequests,seconds" || !Number.isInteger(w.seconds) || w.seconds < 1 || !Number.isInteger(w.maxRequests) || w.maxRequests < 1) return no("sealedWindow must be { seconds, maxRequests } with positive integers");
  if (p.nextPolicyKey !== null && !isHex(p.nextPolicyKey, 64)) return no("nextPolicyKey must be null or a raw Ed25519 public key in hex");
  // 5b. the deployment table, when present: a real table (never empty, at most 64), each entry exactly { id, app }, the id
  // canonical (never normalised), the app one the policy admits, no id twice; any fault refuses the WHOLE policy
  if ("deployments" in p) {
    const d = p.deployments;
    if (!Array.isArray(d) || d.length < 1 || d.length > MAX_DEPLOYMENTS) return no(`deployments must be a list of 1..${MAX_DEPLOYMENTS} entries (an empty table is never read as all, and absent means no table)`);
    const boundTo = new Map();   // InstanceID -> deployment id: an instance serves at most one deployment
    for (const e of d) {
      const keys = e && typeof e === "object" && !Array.isArray(e) ? Object.keys(e).sort().join(",") : null;
      if (keys === "app,id,instances" && !typeV2) return no(`a deployment binds instances, which only a ${POLICY_TYPE_V2} policy may: this ${POLICY_TYPE} policy is refused, never read as unbound`);
      if (keys !== "app,id" && !(typeV2 && keys === "app,id,instances")) return no(`each deployment must be exactly { id, app }${typeV2 ? " or { id, app, instances }" : ""}`);
      if (typeof e.id !== "string" || !DEPLOYMENT_ID.test(e.id)) return no(`deployment id ${JSON.stringify(e.id)} is not canonical bytes32 (0x + 64 lowercase hex): refused, never normalised`);
      if (!isHex(e.app, 64) || !p.appIds.includes(e.app)) return no(`deployment ${e.id.slice(0, 18)}... names an app the policy does not admit`);
      if ("instances" in e) {
        const inst = e.instances;
        if (!Array.isArray(inst) || inst.length < 1 || inst.length > MAX_INSTANCES || !inst.every((i) => typeof i === "string" && INSTANCE_ID.test(i)) || new Set(inst).size !== inst.length) return no(`deployment ${e.id.slice(0, 18)}...'s instances must be 1..${MAX_INSTANCES} unique InstanceIDs, 64 lowercase hex (an empty list is never read as unbound)`);
        for (const i of inst) { if (boundTo.has(i) && boundTo.get(i) !== e.id) return no(`InstanceID ${i.slice(0, 16)}... is bound to two deployments: ambiguous, the whole policy refused`); boundTo.set(i, e.id); }
      }
    }
    if (new Set(d.map((e) => e.id)).size !== d.length) return no("a deployment id appears twice: ambiguous, the whole policy refused");
    if (boundTo.size && !p.formats.includes(PVM_EVIDENCE_FORMAT_V3)) return no(`the policy binds instances but does not allow ${PVM_EVIDENCE_FORMAT_V3}, the only format that names one: incoherent, refused`);
  }
  // 6. the kill switch: an installed client below the minimum does not operate (the policy is still genuine)
  const minv = semver(p.minClientVersion), cv = semver(clientVersion);
  if (!minv) return no("minClientVersion is not a version");
  const disabled = !cv || cmpVer(cv, minv) < 0;
  const policy = p;
  return { ok: true, reason: disabled ? `this client (${clientVersion}) is below the policy's minimum ${p.minClientVersion}: disabled until updated` : "genuine policy under the anchored key, in its window, at or above the serial held", policy, serial: p.serial, digest, disabled,
    nextPolicyFp: p.nextPolicyKey ? keyFingerprint(p.nextPolicyKey) : null,
    // the expectations the consumer gate takes for ONE app: nothing outside the signed policy supplies them
    expectationsFor(appIdHex) {
      if (!isHex(appIdHex, 64) || !p.appIds.includes(appIdHex)) return { ok: false, reason: "the policy does not admit this app" };
      return { ok: true, expect: { appId: Buffer.from(appIdHex, "hex"), allowedRuntimeIds: [...p.runtimeIds], allowedCodeHashes: [...p.codeHashes], allowedAuthorityHashes: [...p.authorityHashes], rootPins: [...p.googleRootPins], formats: [...p.formats], sealedModes: [...p.sealedModes], sealedWindow: { ...w } } };
    },
    // the caller's selection: by deployment id (the expected app comes from the signed table, never from a catalog or a
    // relay), or by app alone; the expectations are then those of the selected app
    // a bound deployment (type 2, instances) narrows the expectation to v3 for one of its instances: a client can never run
    // such an entry without the instance expectation, because it is produced here, never assembled by the caller
    expectationsForSelection(sel) {
      const r = selectDeployment(p, sel); if (!r.ok) return r;
      const e = this.expectationsFor(r.app); if (!e.ok) return e;
      const expect = r.instances ? { ...e.expect, instanceIds: [...r.instances], formats: e.expect.formats.filter((f) => f === PVM_EVIDENCE_FORMAT_V3) } : e.expect;
      return { ...e, expect, app: r.app, deployment: r.deployment, instances: r.instances };
    } };
}

/**
 * selectDeployment(policy, { deployment?, app? }) -> { ok, app, deployment } | { ok: false, reason }, on a VERIFIED policy.
 * With a deployment id: canonical or refused (never normalised); the policy must carry a table naming it exactly once; an
 * app also given must be the one the table expects. Without one: the app alone, admitted by the policy. Never a default,
 * never the table's first entry, never a catalog's or a relay's word.
 */
export function selectDeployment(policy, { deployment = null, app = null } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!policy || !Array.isArray(policy.appIds)) return no("no verified policy to select from");
  if (deployment === null || deployment === undefined) {
    if (!app) return no("no app or deployment selected: nothing is implied");
    if (!isHex(app, 64) || !policy.appIds.includes(app)) return no("the policy does not admit this app");
    return { ok: true, app, deployment: null, instances: null };
  }
  if (typeof deployment !== "string" || !DEPLOYMENT_ID.test(deployment)) return no(`deployment ${JSON.stringify(deployment)} is not canonical bytes32 (0x + 64 lowercase hex): refused, never normalised`);
  if (!Array.isArray(policy.deployments)) return no("the policy names no deployments: select by app, or obtain a policy that names this deployment");
  const hits = policy.deployments.filter((e) => e.id === deployment);
  if (hits.length !== 1) return no(hits.length ? "the policy names this deployment more than once: ambiguous" : `the policy does not name deployment ${deployment.slice(0, 18)}...`);
  if (app !== null && app !== undefined && app !== hits[0].app) return no("the app given is not the app the signed policy expects for this deployment");
  // instances: the InstanceIDs a type-2 policy binds this deployment to, or null (unbound: any genuine instance of the app)
  return { ok: true, app: hits[0].app, deployment, instances: Array.isArray(hits[0].instances) ? [...hits[0].instances] : null };
}
