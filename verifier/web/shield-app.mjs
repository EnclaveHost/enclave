// verifier/web/shield-app.mjs: ONE APP's Enclave Shield partition (a VBS-isolated Hyper-V partition on a Windows host),
// verified IN THIS BROWSER and chained to the host boot this page verifies first (verifier/web/shield-host.mjs).
//
// The flow (verifyShieldAppWith):
//   1. THE HOST: verifyShieldHostSessionWith, the whole host check (this page's nonce, this page's TPM credential, the relay's
//      own hv-node rules). Only a pass ("limited") goes on, and it hands back what an app check needs and nothing the relay
//      could choose: the VSM identity key (IDKS) read from the SAME measured-boot log the TPM quote covered, and the verified
//      boot record ({ ekCertSha256, pcr0 }).
//   2. THE APP: a FRESH 32-byte nonce, then ONE request, GET <api>/v1/enclaves/<name>/apps/<deployment>/attestation?nonce=<hex>.
//      The relay asks the app's partition for its guest report over that nonce and answers the app's document, the app's TLS
//      key as the node stated it (handshakeSpki), the app and runtime it derived from the deployment's catalog entry
//      (expected) and its Shield app policy (measurements, minimumGuestSvn, platforms). Guest reports are a shared,
//      rate-limited resource on the host, so this page never retries: a 503 "busy" is an error the viewer may retry later.
//   3. THE RULES: relay/vbs-app-verify.mjs verifyVbsAppEvidence's, with relay/vbs-app-core.mjs (the document, the report
//      envelope, the user data) and relay/vbs-vm-report-core.mjs (the HCLA envelope, VTL 5 enabled / VTL 2 guest / policy 0,
//      the guest SVN floor, the measurement list, the user data, RSA-PSS-SHA256 salt 32 under the IDKS) shared with the relay,
//      then platformAdmitted (relay/shield-app-policy.mjs's rule) for the verified boot. The hashes are @noble/hashes, the
//      signature WebCrypto. The runtime digest and the ABI/2 binding are isolation/contract/runtime.mjs's runtimeId and bind2
//      restated over @noble (the pinned contract copy hashes with node:crypto); test/verifier-web-shield-app.test.mjs holds
//      them to isolation/contract/vectors.json.
// The relay is trusted for what it states and the verdict says which: the expected app and runtime (derived from the catalog,
// not by this page) and the image list (the operator's own). It cannot forge the report: the IDKS comes from the host check.
// A pass is at most "limited": the host's two omissions stand (PCR 0 unpinned; the hypervisor, the paravisor and physical
// access stay trusted and this page has no evidence of its own that the host cannot read a partition), plus those two.
import { sha256 as nobleSha256 } from "@noble/hashes/sha2";
import { TECH } from "../envelope.mjs";
import { canonical, validateRuntimeIdentity } from "../../isolation/contract/runtime.mjs";
import { vbsVmReportWith } from "../../relay/vbs-vm-report-core.mjs";
import { validImageIdentities } from "../../relay/vbs-image-identity.mjs";
import { vbsAppDocChecks, vbsAppReportEnvelope, vbsAppUserData, platformsValid, platformAdmitted } from "../../relay/vbs-app-core.mjs";
import { runAsync } from "../../relay/hvnode-core.mjs";
import { verifyShieldHostSessionWith, SHIELD_CHECK_ORDER, SHIELD_CHECK_LABELS, SHIELD_OMISSION_LABELS } from "./shield-host.mjs";
import { base64ToBytes } from "./x509.mjs";

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = (...parts) => { const h = nobleSha256.create(); for (const p of parts) h.update(p); return Buffer.from(h.digest()); };
const b64url = (b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unsigned = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); };
const asBuffer = (x) => (x instanceof Uint8Array && !Buffer.isBuffer(x) ? Buffer.from(x.buffer, x.byteOffset, x.byteLength) : x);
const subtle = () => { const s = globalThis.crypto && globalThis.crypto.subtle; if (!s) throw new Error("WebCrypto (crypto.subtle) is not available"); return s; };
const HEX64 = /^[0-9a-f]{64}$/, DEPLOYMENT = /^0x[0-9a-fA-F]{64}$/;
export const MAX_APP_ANSWER = 256 * 1024, MAX_POLICY_ENTRIES = 256, MAX_SOURCE_CHARS = 512;

// ---- isolation/contract/runtime.mjs's runtimeId and bind2, over @noble ---------------------------------------------------------
// runtimeId: sha256 of the canonical identity. The contract hashes only its eight fields; validateRuntimeIdentity (the
// contract's own) refuses an unknown field and requires all eight, so once it passes, the identity IS those fields.
export function runtimeIdWeb(r) {
  const why = validateRuntimeIdentity(r);
  if (why) throw new Error(`inadmissible runtime identity: ${why}`);
  return sha256(canonical(r));
}
export function bind2Web(spki, nonce, rid) {
  if (nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  if (rid.length !== 32) throw new Error("runtime id must be 32 bytes");
  return sha256(Buffer.from("enclave-bind-v2\n"), Buffer.from(spki), Buffer.from(nonce), Buffer.from(rid));
}
const REPORT = vbsVmReportWith({ sha256 });
// the report's signature request, answered with WebCrypto; key = { modulus, exponent } (big-endian bytes, from the boot log)
const OPS = Object.freeze({
  rsaPssSha256: async ({ key, data, sig }) => {
    const k = await subtle().importKey("jwk", { kty: "RSA", n: b64url(unsigned(key.modulus)), e: b64url(unsigned(key.exponent)) }, { name: "RSA-PSS", hash: "SHA-256" }, false, ["verify"]);
    return subtle().verify({ name: "RSA-PSS", saltLength: 32 }, k, sig, data);
  },
});

// ---- the app's evidence ------------------------------------------------------------------------------------------------------
// The app keys, in the order the site shows them; each is true/false when it ran, undefined when it did not.
export const SHIELD_APP_CHECKS = Object.freeze([
  ["app-report", "the app partition's report parses (the paravisor's HCLA envelope around a VBS report) and its claims hash to the signed report data"],
  ["app-signature", "app partition report signed by this boot's VSM identity key (the one the TPM-quoted log names)"],
  ["app-isolation", "partition is VBS-isolated at the expected level and not debuggable (VTL 2 guest, VTL 5 enabled, policy 0)"],
  ["app-svn", "the partition's guest SVN is at or above the operator's floor"],
  ["app-measurement", "partition image measurement is on the operator's list"],
  ["app-image-identity", "image signer, product and module match the operator's pins for this measurement (when required)"],
  ["app-binding", "the report binds the app's TLS key, this page's nonce, the runtime and the app (user data recomputed here)"],
  ["app-document", "the app's document is ABI/2, answers this page's nonce and names the TLS key the node stated"],
  ["app-identity", "the app is the one the deployment names (its SHA-256, derived by the relay from the catalog)"],
  ["app-runtime", "runtime identity is admissible and the one expected"],
  ["app-platform", "this boot's platform is admitted by the operator's Shield app policy (its pinned TPM and firmware, or any attested TPM)"],
].map(([key, label]) => Object.freeze({ key, label })));
export const SHIELD_APP_CHECK_ORDER = Object.freeze([...SHIELD_CHECK_ORDER, ...SHIELD_APP_CHECKS.map((c) => c.key)]);
export const SHIELD_APP_CHECK_LABELS = Object.freeze({ ...SHIELD_CHECK_LABELS, ...Object.fromEntries(SHIELD_APP_CHECKS.map((c) => [c.key, c.label])) });
export const SHIELD_APP_OMISSION_LABELS = Object.freeze({
  ...SHIELD_OMISSION_LABELS,
  "app-expectation-relay-derived": "The app and runtime this page expects (the app's SHA-256 and the runtime identity) were derived by the relay from the deployment's catalog entry and config, not by this page. The report is checked against them exactly, but what they should be is the relay's statement.",
  "image-list-operator-stated": "The partition image measurements accepted here are the relay operator's own list (its Shield app policy); nothing independent in this page says which image builds are acceptable.",
});
const APP_OMISSIONS = ["app-expectation-relay-derived", "image-list-operator-stated"];

// verifyShieldAppEvidenceWeb(input, policy) -> { ok, reason?, checks (the app keys), measurement?, guestSvn?, rid? }. The same
// rules and the same first refusal as relay/vbs-app-verify.mjs verifyVbsAppEvidence for a host session that verified, then
// relay/shield-app-policy.mjs's platformAdmitted.
//   input:  { doc, handshakeSpki, nonce (bytes: Buffer or Uint8Array), expectedAppSha256, expectedRuntimeId (hex), idks: { modulus, exponent } |
//             null (from the verified boot's log), boot: { ekCertSha256, pcr0 } (the verified boot) }
//   policy: { allowedMeasurements: [hex], minimumGuestSvn, platforms: "attested" | [{ ekCertSha256, pcr0 }] }
export async function verifyShieldAppEvidenceWeb({ doc, handshakeSpki, nonce, expectedAppSha256, expectedRuntimeId, idks = null, boot = null } = {}, policy = {}) {
  const checks = Object.fromEntries(SHIELD_APP_CHECKS.map((c) => [c.key, undefined]));
  let reason = null;
  const refuse = (why) => { if (reason === null) reason = why; };
  try {
    handshakeSpki = asBuffer(handshakeSpki); nonce = asBuffer(nonce);
    if (idks) idks = { modulus: asBuffer(idks.modulus), exponent: asBuffer(idks.exponent) };
    const pre = vbsAppDocChecks({ doc, handshakeSpki, nonce, expectedAppSha256, expectedRuntimeId }, { runtimeId: runtimeIdWeb, validateRuntimeIdentity });
    checks["app-document"] = pre.checks.document; checks["app-identity"] = pre.checks.app; checks["app-runtime"] = pre.checks.runtime;
    if (pre.reason) { refuse(pre.reason); if (pre.checks.document === undefined) return { ok: false, reason, checks }; }
    let env;
    try { env = doc && typeof doc === "object" ? vbsAppReportEnvelope(doc) : { reason: "report missing or oversized" }; } catch (e) { env = { reason: e.message }; }
    if (env.reason) { checks["app-report"] = false; refuse(env.reason); return { ok: false, reason, checks }; }
    if (!idks) refuse("authenticated boot log contains no IDKS");
    const userData = pre.rid ? vbsAppUserData(bind2Web(handshakeSpki, nonce, pre.rid), expectedAppSha256) : Buffer.alloc(64);
    const r = await runAsync(REPORT.vbsVmReportChecks({ envelope: env.envelope, idksPublicKey: idks, expectedUserData: userData,
                                                        allowedMeasurements: policy.allowedMeasurements, minimumGuestSvn: policy.minimumGuestSvn ?? 0,
                                                        imageIdentities: policy.imageIdentities }), OPS);
    checks["app-report"] = r.checks.envelope; checks["app-isolation"] = r.checks.vtl; checks["app-svn"] = r.checks.svn; checks["app-measurement"] = r.checks.measurement;
    checks["app-image-identity"] = r.checks["image-identity"];
    checks["app-binding"] = pre.rid ? r.checks["user-data"] : undefined;   // with no runtime id there is nothing to recompute
    checks["app-signature"] = idks ? r.checks.signature : false;
    if (!r.ok) refuse(r.reason);
    if (r.checks.inputs === false) {   // the policy itself is unusable: no list, or no floor, to hold the report to
      if (!Array.isArray(policy.allowedMeasurements) || !policy.allowedMeasurements.length || !policy.allowedMeasurements.every((x) => typeof x === "string" && HEX64.test(x))) checks["app-measurement"] = false;
      const floor = policy.minimumGuestSvn ?? 0; if (!Number.isSafeInteger(floor) || floor < 0) checks["app-svn"] = false;
      if (policy.imageIdentities !== undefined && !validImageIdentities(policy.imageIdentities)) checks["app-image-identity"] = false;
      return { ok: false, reason, checks };
    }
    checks["app-platform"] = platformAdmitted(policy.platforms, boot);
    if (!checks["app-platform"]) refuse(platformsValid(policy.platforms) ? "authenticated TPM/platform pair is not admitted" : 'explicit TPM identity and platform firmware pins (or "attested") are required');
    if (reason !== null) return { ok: false, reason, checks };
    return { ok: true, checks, measurement: r.measurement, guestSvn: r.guestSvn, identity: r.identity, rid: pre.rid };
  } catch (e) { refuse(e && e.message ? e.message : String(e)); return { ok: false, reason, checks }; }
}

// ---- the flow ----------------------------------------------------------------------------------------------------------------
export const SHIELD_APP_PATH = (name, deployment, nonceHex) => `/v1/enclaves/${encodeURIComponent(name)}/apps/${encodeURIComponent(deployment)}/attestation?nonce=${nonceHex}`;
const b64cap = (cap) => 4 * Math.ceil(cap / 3) + 4;
const b64field = (v, cap, what) => { if (typeof v !== "string" || !v.length || v.length > b64cap(cap)) throw new Error(`${what} missing or oversized`); const b = base64ToBytes(v); if (!b.length || b.length > cap) throw new Error(`${what} missing or oversized`); return Buffer.from(b); };
const text = (v) => (typeof v === "string" ? (v.length > MAX_SOURCE_CHARS ? `${v.slice(0, MAX_SOURCE_CHARS)}…` : v) : "(not stated)");

// deps: verifyShieldHostWith's ({ fetchImpl, randomBytes, now, ekRoots?, ekRootPins? }). randomBytes is called four times, in
// order: the host's nonce, credential and MakeCredential seed, then the app's nonce. timeoutMs bounds the whole check.
export async function verifyShieldAppWith(deps, { apiBase = "https://api.enclave.host", name, deployment, timeoutMs = 60000 } = {}) {
  const checks = Object.fromEntries(SHIELD_APP_CHECK_ORDER.map((k) => [k, undefined]));
  let facts = [["Box", typeof name === "string" ? name : "(none)"]], omissions = [], reasons = [];
  const verdict = (status, summary) => ({ status, technology: TECH.HYPERV, name: name ?? null, checkOrder: [...SHIELD_APP_CHECK_ORDER], checkLabels: { ...SHIELD_APP_CHECK_LABELS },
                                          checks, omissions, omissionLabels: Object.fromEntries(omissions.map((o) => [o, SHIELD_APP_OMISSION_LABELS[o] || o])), reasons, summary, facts });
  const error = (why) => { reasons = [...reasons, why]; return verdict("error", `This app's Enclave Shield partition could not be verified (${why}); that is not a verdict on the app.`); };
  const refuse = (why) => { reasons = [...reasons, why]; return verdict("rejected", `This app's Enclave Shield partition evidence was refused (${why}); nothing about the app's partition is established.`); };
  try {
    if (typeof deployment !== "string" || !DEPLOYMENT.test(deployment)) return error("no deployment id (0x and 64 hex digits)");
    const deadline = Date.now() + timeoutMs;

    // ---- 1. the host, whole; nothing about the app is asked unless it passed
    const host = await verifyShieldHostSessionWith(deps, { apiBase, name, timeoutMs });
    Object.assign(checks, host.verdict.checks);
    facts = [...host.verdict.facts, ["Deployment", deployment.toLowerCase()]];
    omissions = [...host.verdict.omissions]; reasons = [...host.verdict.reasons];
    if (host.verdict.status !== "limited") return verdict(host.verdict.status, host.verdict.summary);
    if (!host.session) return error("the host check passed but its VSM identity key could not be read back from the verified log");
    const { idks, boot } = host.session;
    reasons = [];   // the host's OMITTED/WARNING lines are restated below, with the app's

    // ---- 2. the app: a fresh nonce, one request, never retried
    const nonce = Buffer.from(Uint8Array.from(deps.randomBytes(32))), nonceHex = toHex(nonce);
    facts.push(["App nonce (drawn by this page)", `${nonceHex.slice(0, 32)}…`]);
    let answer;
    {
      const left = deadline - Date.now();
      if (left <= 0) return error(`no answer within ${timeoutMs} ms`);
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), left);
      const fetchImpl = deps.fetchImpl;   // called unbound: a browser's fetch refuses any other `this` ("Illegal invocation")
      try {
        let r;
        try { r = await fetchImpl(`${apiBase}${SHIELD_APP_PATH(name, deployment, nonceHex)}`, { method: "GET", signal: ctrl.signal, redirect: "error", credentials: "omit", headers: { accept: "application/json" } }); }
        catch (e) { return error(`app attestation: ${e && e.name === "AbortError" ? `no answer within ${timeoutMs} ms` : e.message}`); }
        const body = await r.text();
        if (body.length > MAX_APP_ANSWER) return error(`app attestation: the answer exceeds ${MAX_APP_ANSWER} bytes`);
        try { answer = JSON.parse(body); } catch { return error(`app attestation: HTTP ${r.status}: the answer is not JSON`); }
        if (r.status === 503 && answer?.error === "busy") {
          const after = Number.isSafeInteger(answer.retryAfter) && answer.retryAfter > 0 && answer.retryAfter <= 3600 ? ` (the relay suggests ${answer.retryAfter} s)` : "";
          return error(`app attestation: busy: this app's partition was asked for a report moments ago or a check is in flight; guest reports are rate-limited on the host, so this page does not retry; try again later${after}`);
        }
        if (r.status !== 200) return error(`app attestation: HTTP ${r.status}: ${answer?.message || answer?.error || "no answer"}`);
        if (!answer || typeof answer !== "object" || Array.isArray(answer)) return error("app attestation: the answer is not a JSON object");
      } finally { clearTimeout(t); }
    }
    if (answer.mode !== "hv-node") return error(`${name} is not an Enclave Shield host (mode ${JSON.stringify(answer.mode ?? null)})`);
    if (answer.name != null && answer.name !== name) return refuse("the relay answered for another host");
    if (typeof answer.deployment !== "string" || answer.deployment.toLowerCase() !== deployment.toLowerCase()) return refuse("the relay answered for another deployment");
    if (answer.nonce !== nonceHex) return refuse("the relay answered for another nonce");
    if (typeof answer.fetchedAt === "string" && answer.fetchedAt.length <= 64) facts.push(["App report fetched at", answer.fetchedAt]);

    // the relay's statements, bounded before anything reads them
    const doc = answer.document, exp = answer.expected, pol = answer.policy;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return error("the answer carries no app document");
    if (!exp || typeof exp !== "object" || !HEX64.test(exp.appSha256 || "") || !HEX64.test(exp.runtimeId || "")) return error("the answer carries no expected app and runtime (expected.appSha256, expected.runtimeId)");
    if (!pol || typeof pol !== "object" || !Array.isArray(pol.measurements) || !pol.measurements.length || pol.measurements.length > MAX_POLICY_ENTRIES || !pol.measurements.every((m) => typeof m === "string" && HEX64.test(m)))
      return error("the answer carries no usable image list (policy.measurements)");
    if (!Number.isSafeInteger(pol.minimumGuestSvn) || pol.minimumGuestSvn < 0) return error("the answer carries no usable guest SVN floor (policy.minimumGuestSvn)");
    if (pol.imageIdentities !== undefined && !validImageIdentities(pol.imageIdentities)) return error("the answer carries no usable image signer/product/module pins (policy.imageIdentities)");
    if (!platformsValid(pol.platforms) || (Array.isArray(pol.platforms) && pol.platforms.length > MAX_POLICY_ENTRIES)) return error('the answer carries no usable platform policy (policy.platforms: "attested" or pins)');
    let handshakeSpki;
    try { handshakeSpki = b64field(answer.handshakeSpki, 4096, "handshakeSpki"); } catch (e) { return error(`the answer: ${e.message}`); }
    facts.push(["App SHA-256 (expected; derived by the relay)", exp.appSha256], ["Expected app and runtime: source", text(exp.source)],
               ["App TLS key sha256 (the key the app's TLS certificate must carry)", toHex(sha256(handshakeSpki))]);
    omissions = [...omissions, ...APP_OMISSIONS];

    // ---- 3. the relay's own rules for an app, in this page
    const v = await verifyShieldAppEvidenceWeb({ doc, handshakeSpki, nonce, expectedAppSha256: exp.appSha256, expectedRuntimeId: exp.runtimeId, idks, boot },
                                               { allowedMeasurements: pol.measurements, minimumGuestSvn: pol.minimumGuestSvn,
                                                 imageIdentities: pol.imageIdentities, platforms: pol.platforms });
    Object.assign(checks, v.checks);
    const rt = doc.runtime;
    if (checks["app-runtime"]) facts.push(["Runtime", `${rt.name} ${rt.version} (${rt.execution}, ${rt.targetIsa} on ${rt.hostIsa}, W^X ${rt.wx}, cache ${rt.cache}, CPU features ${rt.cpuFeatures})`]);
    facts.push(["Runtime id (expected)", exp.runtimeId]);
    facts.push(["Shield app policy: source", text(pol.source)],
               ["Platform policy", pol.platforms === "attested" ? "attested: any TPM chained to the pinned roots, on a boot that passed the host checks" : `${pol.platforms.length} pinned TPM/firmware pair(s)`]);
    if (!v.ok) return refuse(v.reason);
    facts.push(["Image measurement (on the operator's list)", v.measurement], ["Guest SVN", String(v.guestSvn)]);
    if (pol.imageIdentities !== undefined) facts.push(["Image signer (pinned for this measurement)", v.identity.signer],
      ["Image product / module", `${v.identity.productId} / ${v.identity.moduleId}`]);
    reasons = [...omissions.map((o) => `OMITTED (${o}): ${SHIELD_APP_OMISSION_LABELS[o] || o}`), ...host.verdict.reasons.filter((r) => r.startsWith("WARNING: "))];
    return verdict("limited", `This app's Enclave Shield partition on ${name} answered this page's nonce with a report signed by the VSM identity key of the boot the host's TPM just quoted: `
      + "a VBS-isolated partition (VTL 2 guest, VTL 5 enabled, not debuggable) running an image on the operator's list, bound to the app's TLS key, the runtime and the app the deployment names; "
      + "the expected app and runtime were derived by the relay from the catalog and the image list is the operator's, Microsoft's hypervisor, the paravisor and physical access stay trusted "
      + "and this page has no evidence of its own that the host cannot read the partition, and the firmware measurement (PCR 0) is not pinned.");
  } catch (e) { return error(`verifier: ${e && e.message ? e.message : String(e)}`); }
}
