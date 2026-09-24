// trust.js -- what an INSTALLED pVM client trusts, and how it checks everything else (client/DESIGN.md, agreed with the
// Enclave verifier session; LAB, not production). A web page cannot authenticate its own malicious replacement, so the
// client is an artifact installed before first contact (a CLI, or a browser extension a site cannot replace), and it
// never evaluates bytes it fetches. Its anchors are given at install, out of band: the POLICY key fingerprint, a policy
// serial floor, and the RELEASE key fingerprint; Google's attestation roots are built in (a policy may only narrow them).
// Everything fetched -- policies, update manifests and bytes, evidence -- is data verified here, from carriers it does not
// trust.
//   initialState(anchor)                                  -> the client's memory, starting at the install anchor
//   verifyPolicy(envelope, { state, now })                -> { ok, reasons, policy, pins, state }
//   verifyUpdate(envelope, bytes, { state, now, currentVersion, artifact }) -> { ok, reasons, manifest, state }
// Signatures cover the EXACT signed bytes (no canonicalisation on either side), under distinct domain strings; the bytes
// must also be strict JSON (they round-trip through JSON.parse/JSON.stringify unchanged: no duplicate keys, no padding).
// Keys rotate only by a signed statement (nextPolicyKey / nextReleaseKey); losing a key means reinstalling. Toward
// production the update manifest becomes a Sigstore bundle under the release workflow's identity; this Ed25519 manifest is
// the LAB stand-in.
import { GOOGLE_ATTESTATION_ROOT_SHA256, PVM_APP_EVIDENCE_FORMAT, PVM_APP_EVIDENCE_FORMAT_V2, PVM_APP_EVIDENCE_FORMAT_V3, fromHex, toHex, sha256 } from "../../web/pvm-verify.js";

export const CLIENT_VERSION = "0.5.0";   // inside the artifact's bytes: it cannot be claimed without changing the artifact's hash
export const POLICY_DOMAIN = "enclave-pvm-client-policy-v1\n";
export const UPDATE_DOMAIN = "enclave-pvm-client-update-v1\n";
export const UPDATE_COUNTERSIGN_DOMAIN = "enclave-pvm-client-update-countersign-v1\n";
export const VERSION_MARKER = "/*! enclave-pvm-client ";   // the artifact's first line: /*! enclave-pvm-client <version> ... */
const te = new TextEncoder(), td = new TextDecoder("utf-8", { fatal: true });
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const subtle = () => globalThis.crypto.subtle;
const MAX_DOC = 64 * 1024;

export const fingerprint = async (rawKeyHex) => toHex(await sha256(fromHex(rawKeyHex)));
export function semver(v) {
  const m = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(String(v));
  return m ? [+m[1], +m[2], +m[3]] : null;
}
export const semverCmp = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/** The client's memory at install: { policyFp, nextPolicyFp, serial (the floor), digest, releaseFp, nextReleaseFp }. */
export function initialState({ policyKeyFp, serialFloor, releaseKeyFp }) {
  if (!HEX(64).test(policyKeyFp || "") || !HEX(64).test(releaseKeyFp || "") || !Number.isSafeInteger(serialFloor) || serialFloor < 1)
    throw new Error("the install anchor needs a policy key fingerprint, a serial floor >= 1 and a release key fingerprint");
  if (policyKeyFp === releaseKeyFp) throw new Error("the policy key and the release key must be distinct");
  return { policyFp: policyKeyFp, nextPolicyFp: null, serial: serialFloor, digest: null, releaseFp: releaseKeyFp, nextReleaseFp: null };
}

// the exact signed bytes of an envelope field: canonical base64, bounded, strict UTF-8 JSON
function signedBytes(b64, what) {
  if (typeof b64 !== "string" || b64.length > (MAX_DOC * 4) / 3 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4) throw new Error(`the ${what} is not canonical base64`);
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (!bytes.length || bytes.length > MAX_DOC) throw new Error(`the ${what} is not 1..${MAX_DOC} bytes`);
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  if (btoa(s) !== b64) throw new Error(`the ${what} is not canonical base64`);
  let text, body;
  try { text = td.decode(bytes); body = JSON.parse(text); } catch { throw new Error(`the ${what} is not UTF-8 JSON`); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`the ${what} is not a JSON object`);
  if (JSON.stringify(body) !== text) throw new Error(`the ${what} is not strict JSON (duplicate keys, padding or escapes that do not round-trip)`);
  return { bytes, body };
}
async function edVerify(keyHex, sigHex, domain, bytes) {
  const k = await subtle().importKey("raw", fromHex(keyHex), { name: "Ed25519" }, false, ["verify"]);
  return subtle().verify({ name: "Ed25519" }, k, fromHex(sigHex), new Uint8Array([...te.encode(domain), ...bytes]));
}
const closed = (o, keys) => Object.keys(o).sort().join() === [...keys].sort().join();
const list = (v, re, max = 64) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every((x) => typeof x === "string" && re.test(x)) && new Set(v).size === v.length;
const time = (s) => (typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s) ? Date.parse(s) : NaN);

const POLICY_KEYS = ["appIds", "authorityHashes", "codeHashes", "formats", "googleRootPins", "key", "minClientVersion", "nextPolicyKey",
                     "notAfter", "notBefore", "runtimeIds", "sealedModes", "sealedWindow", "serial", "type"];
// The optional deployment table (client/DESIGN.md "Deployments"; since 0.4.0): which app a deployment is expected to run,
// signed like every other field. A deployment id is the platform ledger's bytes32, canonical: 0x + 64 lowercase hex.
export const DEPLOYMENT_ID = /^0x[0-9a-f]{64}$/;
const MAX_DEPLOYMENTS = 64, MAX_INSTANCES = 8;
// The policy's own version (INSTANCE-BINDING.md, agreed with the verifier session). Type 1 (clients 0.1.0 and later): table
// entries are exactly { id, app }. Type 2 (clients 0.5.0 and later): an entry may also bind the deployment to the VM
// INSTANCES that serve it, { id, app, instances }; a client before 0.5.0 refuses type 2 as "not a pVM client policy", so
// an old client can never run a bound deployment as unbound. Serials are one space across both types.
export const POLICY_TYPE = "enclave-pvm-client-policy", POLICY_TYPE_V2 = "enclave-pvm-client-policy/2";
export const INSTANCE_ID = /^[0-9a-f]{64}$/;

/**
 * A signed policy { policy: base64(exact JSON bytes), sig } under the client's anchored policy key (or the next key a
 * previous accepted policy named). Returns the pins for verifyPvmAppEvidence and the client's updated memory.
 */
export async function verifyPolicy(env, { state, now = Date.now(), clientVersion = CLIENT_VERSION } = {}) {
  const no = (m) => ({ ok: false, reasons: [m], policy: null, pins: null, state });
  if (!state || !HEX(64).test(state.policyFp || "")) return no("no policy key was anchored at install: refusing (fail closed)");
  if (!env || typeof env !== "object" || Array.isArray(env) || !closed(env, ["policy", "sig"])) return no("the policy envelope must be exactly { policy, sig }");
  if (typeof env.sig !== "string" || !HEX(128).test(env.sig)) return no("the policy signature is not 64 bytes of lowercase hex");
  let bytes, b;
  try { ({ bytes, body: b } = signedBytes(env.policy, "policy")); } catch (e) { return no(e.message); }
  if (typeof b.key !== "string" || !HEX(64).test(b.key)) return no("the policy's key is not 32 bytes of lowercase hex");
  const fp = await fingerprint(b.key);
  if (fp !== state.policyFp && fp !== state.nextPolicyFp) return no("the policy is signed by a key this client's anchor does not name");
  let sigOk = false;
  try { sigOk = await edVerify(b.key, env.sig, POLICY_DOMAIN, bytes); } catch (e) { return no(`the policy signature cannot be checked here (${e.name}): refusing, no fallback`); }
  if (!sigOk) return no("the policy signature does not verify over its exact bytes");
  if (!closed(b, POLICY_KEYS) && !closed(b, [...POLICY_KEYS, "deployments"])) return no(`the policy fields must be exactly ${POLICY_KEYS.join(",")}, optionally with deployments`);
  if (b.type !== POLICY_TYPE && b.type !== POLICY_TYPE_V2) return no("not a pVM client policy");
  const typeV2 = b.type === POLICY_TYPE_V2;
  if (!Number.isSafeInteger(b.serial) || b.serial < 1) return no("the policy serial is not a positive integer");
  const nb = time(b.notBefore), na = time(b.notAfter);
  if (!(nb < na)) return no("the policy validity is not notBefore < notAfter (UTC seconds, Z)");
  if (now < nb) return no(`the policy is not valid before ${b.notBefore}: no operation`);
  if (now > na) return no(`the policy expired at ${b.notAfter}: no operation, never a stale fallback`);
  if (!list(b.codeHashes, HEX(64)) || !list(b.appIds, HEX(64)) || !list(b.runtimeIds, HEX(64)) || !list(b.authorityHashes, HEX(128)))
    return no("the policy's code hashes, app IDs, runtime IDs and authority hashes must be non-empty lists of lowercase hex (an empty list is never read as all)");
  if (!list(b.googleRootPins, HEX(64), 8) || !b.googleRootPins.every((p) => GOOGLE_ATTESTATION_ROOT_SHA256.includes(p)))
    return no("the policy's root pins may only narrow the Google attestation roots built into this client, never widen or empty them");
  if (!list(b.formats, /./, 3) || !b.formats.every((f) => f === PVM_APP_EVIDENCE_FORMAT_V3 || f === PVM_APP_EVIDENCE_FORMAT_V2 || f === PVM_APP_EVIDENCE_FORMAT)) return no("the policy's evidence formats are not known to this client");
  if (!list(b.sealedModes, /./, 2) || !b.sealedModes.every((m) => m === "whole" || m === "chunked")) return no("the policy's sealed modes are not known to this client");
  const w = b.sealedWindow;
  if (!w || typeof w !== "object" || !closed(w, ["maxRequests", "seconds"]) || !Number.isSafeInteger(w.seconds) || !Number.isSafeInteger(w.maxRequests) || w.seconds < 1 || w.maxRequests < 1)
    return no("the policy's sealedWindow must be exactly { seconds, maxRequests }");
  if ("deployments" in b) {   // present means a real table: 1..64 entries, ids unique, every app admitted
    const d = b.deployments;
    if (!Array.isArray(d) || d.length < 1 || d.length > MAX_DEPLOYMENTS) return no(`the policy's deployments must be a list of 1..${MAX_DEPLOYMENTS} entries (an empty table is never read as all)`);
    const seen = new Map();   // InstanceID -> the deployment that lists it
    for (const e of d) {
      if (!e || typeof e !== "object" || Array.isArray(e)) return no(`each deployment must be exactly { id, app }${typeV2 ? " or { id, app, instances }" : ""}`);
      if (!typeV2 && "instances" in e) return no(`a deployment binds instances, which only a ${POLICY_TYPE_V2} policy may: this ${POLICY_TYPE} policy is refused, never read as unbound`);
      if (!closed(e, ["app", "id"]) && !(typeV2 && closed(e, ["app", "id", "instances"]))) return no(`each deployment must be exactly { id, app }${typeV2 ? " or { id, app, instances }" : ""}`);
      if (typeof e.id !== "string" || !DEPLOYMENT_ID.test(e.id)) return no(`deployment id ${JSON.stringify(e.id)} is not 0x + 64 lowercase hex (the ledger's bytes32)`);
      if (typeof e.app !== "string" || !HEX(64).test(e.app) || !b.appIds.includes(e.app)) return no(`deployment ${e.id}'s app is not one of the policy's appIds`);
      if ("instances" in e) {
        if (!list(e.instances, INSTANCE_ID, MAX_INSTANCES)) return no(`deployment ${e.id}'s instances must be 1..${MAX_INSTANCES} unique InstanceIDs, 64 lowercase hex (an empty list is never read as any)`);
        for (const i of e.instances) {
          if (seen.has(i)) return no(`instance ${i.slice(0, 16)}... is bound to two deployments (${seen.get(i).slice(0, 18)}... and ${e.id.slice(0, 18)}...): an instance serving both could not tell them apart, refused`);
          seen.set(i, e.id);
        }
      }
    }
    if (new Set(d.map((e) => e.id)).size !== d.length) return no("the policy names a deployment id twice: ambiguous, refused");
    if (seen.size && !b.formats.includes(PVM_APP_EVIDENCE_FORMAT_V3)) return no(`the policy binds instances but does not allow ${PVM_APP_EVIDENCE_FORMAT_V3}, the only format that names one: incoherent, refused`);
  }
  if (!semver(b.minClientVersion)) return no("the policy's minClientVersion is not MAJOR.MINOR.PATCH");
  if (b.nextPolicyKey !== null && (typeof b.nextPolicyKey !== "string" || !HEX(64).test(b.nextPolicyKey) || b.nextPolicyKey === b.key)) return no("the policy's nextPolicyKey is not null or another 32-byte key");
  if (b.serial < state.serial) return no(`policy serial ${b.serial} is below the ${state.serial} this client holds (its install floor or a newer policy it accepted): a rollback, refused`);
  const digest = toHex(await sha256(bytes));
  if (b.serial === state.serial && state.digest && digest !== state.digest) return no(`a second, different policy with serial ${b.serial}: equivocation, refused`);
  if (semverCmp(clientVersion, b.minClientVersion) < 0) return no(`this client (${clientVersion}) is below the policy's minimum ${b.minClientVersion}: disabled until updated`);
  const next = { ...state, policyFp: fp, nextPolicyFp: b.nextPolicyKey ? await fingerprint(b.nextPolicyKey) : null, serial: b.serial, digest };
  const pins = { allowedCodeHashes: b.codeHashes, allowedAuthorityHashes: b.authorityHashes, allowedRuntimeIds: b.runtimeIds, rootPins: b.googleRootPins };
  return { ok: true, reasons: [`policy serial ${b.serial}${fp === state.nextPolicyFp ? " (under the rotated key)" : ""}, valid to ${b.notAfter}`], policy: b, pins, state: next };
}

/**
 * The caller's selection against a VERIFIED policy: { deployment } (and optionally the app it must run), or { app } alone.
 * The expected app comes from the signed table, never from a catalog or a relay. -> { ok, app, deployment } | { ok: false, reason }
 */
export function selectDeployment(policy, { deployment = null, app = null } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (deployment === null) {
    if (!app) return no("no app or deployment selected");
    if (!policy.appIds.includes(app)) return no("the policy does not admit this app");
    return { ok: true, app, deployment: null, instances: null };
  }
  if (typeof deployment !== "string" || !DEPLOYMENT_ID.test(deployment)) return no(`deployment ${JSON.stringify(deployment)} is not 0x + 64 lowercase hex: not normalized, refused`);
  // (since 0.5.0) instances: the InstanceIDs a type-2 policy binds this deployment to, or null (unbound: any genuine
  // instance of the app, the 0.4 guarantee)
  if (!Array.isArray(policy.deployments)) return no("the policy names no deployments: select an app, or get a policy that names this deployment");
  const hits = policy.deployments.filter((e) => e.id === deployment);
  if (hits.length !== 1) return no(hits.length ? "the policy names this deployment more than once: ambiguous" : `the policy does not name deployment ${deployment}`);
  if (app && app !== hits[0].app) return no(`the selected app ${app.slice(0, 16)}... is not the app the policy expects for deployment ${deployment.slice(0, 18)}... (${hits[0].app.slice(0, 16)}...)`);
  return { ok: true, app: hits[0].app, deployment, instances: hits[0].instances || null };
}

const UPDATE_KEYS = ["artifact", "artifactSha256", "nextReleaseKey", "notAfter", "policyKey", "releaseKey", "size", "sourceCommit", "type", "version"];

/**
 * A code update: { manifest: base64(exact JSON bytes), releaseSig, policySig } and the bytes some carrier delivered. BOTH
 * keys: the release key signs, the anchored policy key countersigns -- no single key ships code. The bytes must hash to the
 * manifest, and carry the manifest's version in their own first line. The caller installs the bytes beside the running
 * client for the NEXT start; nothing fetched is ever evaluated by the running client.
 */
export async function verifyUpdate(env, bytes, { state, now = Date.now(), currentVersion = CLIENT_VERSION, artifact } = {}) {
  const no = (m) => ({ ok: false, reasons: [m], manifest: null, state });
  if (!state || !HEX(64).test(state.releaseFp || "") || !HEX(64).test(state.policyFp || "")) return no("no release or policy key was anchored at install: refusing (fail closed)");
  if (!env || typeof env !== "object" || Array.isArray(env) || !closed(env, ["manifest", "policySig", "releaseSig"])) return no("the update envelope must be exactly { manifest, releaseSig, policySig }");
  if (!HEX(128).test(env.releaseSig || "") || !HEX(128).test(env.policySig || "")) return no("the update signatures are not 64 bytes of lowercase hex each");
  let mb, b;
  try { ({ bytes: mb, body: b } = signedBytes(env.manifest, "update manifest")); } catch (e) { return no(e.message); }
  if (!HEX(64).test(b.releaseKey || "") || !HEX(64).test(b.policyKey || "")) return no("the manifest's release and policy keys are not 32 bytes of lowercase hex");
  const rfp = await fingerprint(b.releaseKey), pfp = await fingerprint(b.policyKey);
  if (rfp !== state.releaseFp && rfp !== state.nextReleaseFp) return no("the update is signed by a release key this client's anchor does not name");
  if (pfp !== state.policyFp) return no("the update is countersigned by a policy key this client's anchor does not name");
  try {
    if (!(await edVerify(b.releaseKey, env.releaseSig, UPDATE_DOMAIN, mb))) return no("the release signature does not verify over the manifest's exact bytes");
    if (!(await edVerify(b.policyKey, env.policySig, UPDATE_COUNTERSIGN_DOMAIN, mb))) return no("the policy countersignature does not verify: one key alone cannot ship code");
  } catch (e) { return no(`the update signatures cannot be checked here (${e.name}): refusing, no fallback`); }
  if (!closed(b, UPDATE_KEYS)) return no(`the manifest fields must be exactly ${UPDATE_KEYS.join(",")}`);
  if (b.type !== "enclave-pvm-client-update") return no("not a pVM client update manifest");
  if (artifact && b.artifact !== artifact) return no(`the manifest is for ${JSON.stringify(b.artifact)}, not ${JSON.stringify(artifact)}`);
  if (!semver(b.version) || !HEX(64).test(b.artifactSha256 || "") || !Number.isSafeInteger(b.size) || b.size < 1 || !HEX(40).test(b.sourceCommit || ""))
    return no("the manifest's version, artifactSha256, size or sourceCommit is malformed");
  const na = time(b.notAfter);
  if (!(now <= na)) return no(`the update manifest expired at ${b.notAfter}`);
  if (b.nextReleaseKey !== null && (!HEX(64).test(b.nextReleaseKey || "") || b.nextReleaseKey === b.releaseKey)) return no("the manifest's nextReleaseKey is not null or another 32-byte key");
  if (semverCmp(b.version, currentVersion) <= 0) return no(`update ${b.version} is not newer than the installed ${currentVersion}: a downgrade or a replay, refused`);
  const x = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (x.length !== b.size) return no(`the delivered artifact is ${x.length} bytes; the signed manifest says ${b.size}`);
  if (toHex(await sha256(x)) !== b.artifactSha256) return no("the delivered bytes are not the signed artifact (sha256 differs)");
  const first = new TextDecoder().decode(x.subarray(0, 200)).split("\n")[0];
  if (!first.startsWith(`${VERSION_MARKER}${b.version} `)) return no(`the artifact's own version line is not ${b.version}: a manifest cannot rename an artifact's version`);
  const next = { ...state, releaseFp: rfp, nextReleaseFp: b.nextReleaseKey ? await fingerprint(b.nextReleaseKey) : null };
  return { ok: true, reasons: [`update ${b.version} (${b.artifact}, source ${b.sourceCommit.slice(0, 12)}) signed and countersigned; install for the next start`], manifest: b, state: next };
}
