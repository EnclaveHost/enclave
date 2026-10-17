// verifier/web/snp-app.mjs: ONE APP's own SEV-SNP guest on a confidential server (metal0: every app in its own SNP guest),
// verified IN THIS BROWSER and tied to the server this page verifies first (verifier/metal-box.mjs).
//
// The flow (verifySnpAppWith):
//   1. THE SERVER: the whole metal-box check (this page's nonce, the AMD chain, the TCB floor, the measurement). Only a pass
//      ("verified" or "limited") goes on, and it hands back the processor's chip id, which the relay cannot choose.
//   2. THE APP: a FRESH 32-byte nonce, then ONE request, GET <api>/v1/enclaves/<name>/apps/<deployment>/attestation?nonce=<hex>.
//      The relay asks the app's own public origin (https://<id8>.app.enclave.host/.well-known/enclave-attestation) for its
//      guest's report over that nonce and answers the document verbatim with the key that origin presented in the TLS
//      handshake (handshakeSpki). The guest's front serves that path on the app's own listener and refuses any certificate
//      for another key, so the key the report binds is the key the app's public certificate carries. Never retried.
//   3. THE EXPECTATION: GET <api>/v1/expected-guest?id=<deployment>, the relay's published prediction of the guest this
//      deployment must run (the app's SHA-256 derived from the chain, and (measurement, runtime id) pairs per installed
//      release, isolation/m4/expected-measurement.sh). The report must match one pair exactly.
//   4. THE RULES: verifier/snp.mjs verifySnp for the domain format (the AMD chain to the pinned ARK, the VCEK, the guest
//      policy, VMPL 0, the TCB floor, the measurement, the ABI/2 binding Bind2(handshake key, this nonce, runtime id), the app
//      in report_data[32:64], and HOST_DATA equal to the deployment id), then the chip id against the server's.
// The relay is trusted for what it states and the verdict says which: the predicted app and measurements are its own
// derivation, not this page's. It cannot forge the report. A pass is "limited" unless the caller pins the measurement.
import { TECH } from "../envelope.mjs";
import { validateRuntimeIdentity } from "../../isolation/contract/runtime.mjs";
import { runtimeIdWeb, bind2Web } from "./shield-app.mjs";
import { base64ToBytes } from "./x509.mjs";

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const HEX64 = /^[0-9a-f]{64}$/, HEX96 = /^[0-9a-f]{96}$/, DEPLOYMENT = /^0x[0-9a-fA-F]{64}$/;
export const MAX_APP_ANSWER = 256 * 1024, MAX_IMAGES = 512;
export const SNP_APP_PATH = (name, deployment, nonceHex) => `/v1/enclaves/${encodeURIComponent(name)}/apps/${encodeURIComponent(deployment)}/attestation?nonce=${nonceHex}`;
export const EXPECTED_GUEST_PATH = (deployment) => `/v1/expected-guest?id=${encodeURIComponent(deployment)}`;

export const SNP_APP_CHECKS = Object.freeze([
  ["server", "the confidential server itself verified first (its AMD-signed report over this page's own nonce)"],
  ["app-document", "the app's document is ABI/2, answers this page's nonce, and names the key the app's public TLS certificate carries"],
  ["app-runtime", "runtime identity is admissible and one the prediction lists"],
  ["app-identity", "the app is the one the deployment names (the relay's prediction from the catalog)"],
  ["report shape", "the app guest's report parses (an AMD SEV-SNP attestation report)"],
  ["product line", "the processor's product line is a supported AMD EPYC"],
  ["chain", "AMD certificate chain to the pinned AMD root"],
  ["crl", "AMD revocation list checked"],
  ["signature", "the report is signed by this processor's VCEK"],
  ["vcek identity", "the VCEK belongs to this chip at this TCB"],
  ["tcb policy", "firmware TCB at or above the published floor"],
  ["guest policy", "guest policy forbids debug and migration"],
  ["vmpl", "report produced at VMPL 0"],
  ["measurement", "the guest's launch measurement is the one predicted for this app's runtime"],
  ["binding", "report binds the app's TLS key, this page's nonce and the runtime (Bind2, recomputed here)"],
  ["app id", "report names the app the deployment runs"],
  ["host data", "report's HOST_DATA is this deployment's id, set by the host at launch and signed by the processor"],
  ["same-chip", "the app guest runs on the same processor as the server verified above (AMD chip id)"],
].map(([key, label]) => Object.freeze({ key, label })));
export const SNP_APP_CHECK_ORDER = Object.freeze(SNP_APP_CHECKS.map((c) => c.key));
export const SNP_APP_CHECK_LABELS = Object.freeze(Object.fromEntries(SNP_APP_CHECKS.map((c) => [c.key, c.label])));
export const RELAY_PREDICTED = "expected-guest-relay-predicted";
export const SNP_APP_OMISSION_LABELS = Object.freeze({
  [RELAY_PREDICTED]: "The app and the guest measurements this page expects come from the relay's own prediction (/v1/expected-guest: derived from the catalog and the installed releases), not from a build this page reproduced. The report is checked against them exactly, but what they should be is the relay's statement.",
  "crl-revocation-unchecked": "AMD's revocation list was not checked.",
  "tcb-floor-unjudged": "No firmware floor is published for this processor line.",
  "expected-measurement-operator-stated": "The server's own measurement was compared with the relay operator's allowlist, not an independent reproduction.",
});

// deps: { fetchImpl, verifyBox(name) -> metal-box result, verify(doc, { policy, context, collateral }) -> verdict (verifyEvidenceWeb),
//         collateral, randomBytes(n), now() -> Date, tcbFloors }
// expected: { measurements: [hex96] } pins the guest measurement (the caller's own reproduction); then a pass can be "verified".
export async function verifySnpAppWith(deps, { apiBase = "https://api.enclave.host", name, deployment, expected = null, timeoutMs = 45000 } = {}) {
  const checks = Object.fromEntries(SNP_APP_CHECK_ORDER.map((k) => [k, undefined]));
  let facts = [["Box", typeof name === "string" ? name : "(none)"]], omissions = [], reasons = [];
  const verdict = (status, summary) => ({ status, technology: TECH.SNP, name: name ?? null, checkOrder: [...SNP_APP_CHECK_ORDER], checkLabels: { ...SNP_APP_CHECK_LABELS },
                                          checks, omissions, omissionLabels: Object.fromEntries(omissions.map((o) => [o, SNP_APP_OMISSION_LABELS[o] || o])), reasons, summary, facts });
  const error = (why) => { reasons = [...reasons, why]; return verdict("error", `This app's SEV-SNP guest could not be verified (${why}); that is not a verdict on the app.`); };
  const refuse = (why) => { reasons = [...reasons, why]; return verdict("rejected", `This app's SEV-SNP guest evidence was refused (${why}); nothing about the app's guest is established.`); };
  const getJson = async (url, left, what) => {
    if (left <= 0) throw Object.assign(new Error(`no answer within ${timeoutMs} ms`), { soft: true });
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), left);
    const fetchImpl = deps.fetchImpl;   // called unbound: a browser's fetch refuses any other `this` ("Illegal invocation")
    try {
      let r;
      try { r = await fetchImpl(url, { method: "GET", signal: ctrl.signal, redirect: "error", credentials: "omit", headers: { accept: "application/json" } }); }
      catch (e) { throw Object.assign(new Error(`${what}: ${e && e.name === "AbortError" ? `no answer within ${timeoutMs} ms` : e.message}`), { soft: true }); }
      const text = await r.text();
      if (text.length > MAX_APP_ANSWER) throw Object.assign(new Error(`${what}: the answer exceeds ${MAX_APP_ANSWER} bytes`), { soft: true });
      let body; try { body = JSON.parse(text); } catch { throw Object.assign(new Error(`${what}: HTTP ${r.status}: the answer is not JSON`), { soft: true }); }
      return { status: r.status, body };
    } finally { clearTimeout(t); }
  };
  try {
    if (typeof deployment !== "string" || !DEPLOYMENT.test(deployment)) return error("no deployment id (0x and 64 hex digits)");
    const dep = deployment.toLowerCase(), deadline = Date.now() + timeoutMs;
    const pinned = expected && Array.isArray(expected.measurements) && expected.measurements.length ? expected.measurements.map((m) => String(m).toLowerCase()) : null;
    if (pinned && !pinned.every((m) => HEX96.test(m))) return error("expected measurements must be 96 hex characters each");

    // ---- 1. the server, whole; nothing about the app is asked unless it passed
    const box = await deps.verifyBox(name);
    facts.push(["Deployment", dep]);
    if (!box || (box.status !== "verified" && box.status !== "limited")) {
      checks.server = box && box.status === "rejected" ? false : undefined;
      const why = String((box?.reasons || []).at(-1) || box?.status || "no verdict");
      return box && box.status === "rejected" ? refuse(`the server ${name} did not verify: ${why}`) : error(`the server ${name} could not be checked: ${why}`);
    }
    checks.server = true;
    const serverChip = String(box.claims?.chipId || "").toLowerCase();
    facts.push(["Server verdict", `${box.status} (measurement ${String(box.measurement || "").slice(0, 16)}…)`]);
    for (const o of box.omissions || []) if (!omissions.includes(o)) omissions.push(o);

    // ---- 2. the app: a fresh nonce, one request, never retried
    const nonce = Buffer.from(Uint8Array.from(deps.randomBytes(32))), nonceHex = toHex(nonce);
    facts.push(["App nonce (drawn by this page)", `${nonceHex.slice(0, 32)}…`]);
    let a;
    try { a = await getJson(`${apiBase}${SNP_APP_PATH(name, dep, nonceHex)}`, deadline - Date.now(), "app attestation"); }
    catch (e) { return error(e.message); }
    if (a.status === 503 && a.body?.error === "busy") {
      const after = Number.isSafeInteger(a.body.retryAfter) && a.body.retryAfter > 0 && a.body.retryAfter <= 3600 ? ` (the relay suggests ${a.body.retryAfter} s)` : "";
      return error(`app attestation: busy: this app's guest was asked for a report moments ago or a check is in flight; this page does not retry; try again later${after}`);
    }
    if (a.status !== 200) return error(`app attestation: HTTP ${a.status}: ${a.body?.message || a.body?.error || "no answer"}`);
    const answer = a.body;
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return error("app attestation: the answer is not a JSON object");
    if (answer.mode !== "snp") return error(`${name} is not a confidential server (mode ${JSON.stringify(answer.mode ?? null)})`);
    if (answer.name != null && answer.name !== name) return refuse("the relay answered for another host");
    if (typeof answer.deployment !== "string" || answer.deployment.toLowerCase() !== dep) return refuse("the relay answered for another deployment");
    if (answer.nonce !== nonceHex) return refuse("the relay answered for another nonce");
    if (typeof answer.origin === "string" && answer.origin.length <= 200) facts.push(["Fetched from the app's own origin", answer.origin]);
    const doc = answer.document;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return error("the answer carries no app document");
    let spki;
    try { if (typeof answer.handshakeSpki !== "string" || answer.handshakeSpki.length > 5500) throw new Error("handshakeSpki missing or oversized"); spki = Buffer.from(base64ToBytes(answer.handshakeSpki)); if (spki.length < 44 || spki.length > 4096) throw new Error("handshakeSpki is not a key"); }
    catch (e) { return error(`the answer: ${e.message}`); }

    // ---- 3. the relay's prediction for this deployment
    let p;
    try { p = await getJson(`${apiBase}${EXPECTED_GUEST_PATH(dep)}`, deadline - Date.now(), "expected guest"); }
    catch (e) { return error(e.message); }
    if (p.status === 503) return error(`expected guest: the relay is still predicting this app's guest; try again in ${Number(p.body?.retryAfterSec) || 30} s`);
    if (p.status !== 200) return error(`expected guest: HTTP ${p.status}: ${p.body?.message || p.body?.error || "no prediction"}`);
    const pred = p.body;
    if (!pred || String(pred.id || "").toLowerCase() !== dep || !HEX64.test(pred.appId || "") || !Array.isArray(pred.images) || !pred.images.length || pred.images.length > MAX_IMAGES
        || !pred.images.every((i) => i && HEX96.test(i.measurement || "") && HEX64.test(i.runtimeId || "")))
      return error("expected guest: the prediction is not usable (id, appId, images)");
    facts.push(["App SHA-256 (predicted by the relay)", pred.appId], ["Predicted images", `${pred.images.length} (measurement, runtime) pair(s)${pred.complete === false ? ", more still being measured" : ""}`]);

    // ---- 4. the document's own claims, then the report under the AMD chain
    checks["app-document"] = doc.format === "sev-snp-guest-domain-v1" && doc.abi === "enclave-domain-abi/2" && doc.nonce === nonceHex
      && typeof doc.transportKey === "string" && doc.transportKey === answer.handshakeSpki;
    if (!checks["app-document"]) return refuse(doc.abi !== "enclave-domain-abi/2" ? `the document is ${doc.abi ?? "ABI/1"}, not ABI/2` : doc.transportKey !== answer.handshakeSpki ? "the document names another key than the app's TLS certificate carries" : "the document is not an SEV-SNP domain document over this page's nonce");
    let rid;
    try { const why = validateRuntimeIdentity(doc.runtime); if (why) throw new Error(why); rid = toHex(runtimeIdWeb(doc.runtime)); }
    catch (e) { checks["app-runtime"] = false; return refuse(`inadmissible runtime identity: ${e.message}`); }
    const pairs = pred.images.filter((i) => i.runtimeId === rid);
    checks["app-runtime"] = pairs.length > 0;
    const rt = doc.runtime;
    facts.push(["Runtime", `${rt.name} ${rt.version} (${rt.execution}, ${rt.targetIsa} on ${rt.hostIsa}, W^X ${rt.wx}, cache ${rt.cache}, CPU features ${rt.cpuFeatures})`], ["Runtime id", rid]);
    if (!pairs.length) return refuse("the guest's runtime is not one the prediction lists");
    checks["app-identity"] = doc.appSha256 === pred.appId;
    if (!checks["app-identity"]) return refuse("the guest runs another app than the deployment names");
    const allowed = pinned || pairs.map((i) => i.measurement.toLowerCase());
    const context = { transportKeySpki: spki, expectedBinding: bind2Web(spki, nonce, Buffer.from(rid, "hex")), expectedAppId: Buffer.from(pred.appId, "hex"),
                      expectedHostData: Buffer.from(dep.slice(2), "hex"), now: (deps.now ? deps.now() : new Date()).toISOString(),
                      ...(typeof doc.certs === "string" && doc.certs ? { auxblob: Buffer.from(base64ToBytes(doc.certs)) } : {}) };
    let v;
    try { v = await deps.verify(doc, { policy: { snp: { allowedMeasurements: allowed, minTcb: deps.tcbFloors } }, context, collateral: deps.collateral }); }
    catch (e) { return error(`verifier: ${e.message}`); }
    for (const [k, x] of Object.entries(v.checks || {})) if (k in checks) checks[k] = x;
    for (const o of v.omissions || []) if (!omissions.includes(o)) omissions.push(o);
    if (v.status !== "verified" && v.status !== "limited") return v.status === "rejected" ? refuse(String((v.reasons || []).at(-1) || "rejected").replace(/^REJECT:\s*/, "")) : error(String((v.reasons || []).at(-1) || v.status));
    const appChip = String(v.claims?.chipId || "").toLowerCase();
    checks["same-chip"] = !!serverChip && appChip === serverChip;
    if (!checks["same-chip"]) return refuse("the app guest's report comes from another processor than the server verified above");
    const hit = pairs.find((i) => i.measurement.toLowerCase() === v.claims.measurement);
    facts.push(["Guest measurement", v.claims.measurement], ...(hit?.release ? [["Release (predicted)", hit.release]] : []),
               ["App TLS key sha256 (the key its certificate carries)", v.claims.transportSpkiSha256], ["TCB", Object.entries(v.claims.tcb?.reported || {}).map(([k, n]) => `${k} ${n}`).join(", ")]);
    if (!pinned) omissions.push(RELAY_PREDICTED);
    reasons = omissions.map((o) => `OMITTED (${o}): ${SNP_APP_OMISSION_LABELS[o] || o}`);
    const status = omissions.length ? "limited" : "verified";
    return verdict(status, `This app's own SEV-SNP guest on ${name} answered this page's nonce with a report signed by the same AMD processor as the server: `
      + "memory encrypted and kept from the host and its operator by the processor, debug and migration off, at VMPL 0, launched for this deployment, running the app the deployment names, "
      + "with its TLS key (the one its public certificate carries) and runtime bound into the report. "
      + (pinned ? "The guest measurement matched your own pin." : "The guest measurement matched the relay's prediction for this app; that prediction is the relay's, not a build this page reproduced."));
  } catch (e) { return error(`verifier: ${e && e.message ? e.message : String(e)}`); }
}
