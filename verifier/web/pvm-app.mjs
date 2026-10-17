// verifier/web/pvm-app.mjs: ONE APP's own protected VM on a phone host (relay mode "avf": every app in its own pVM),
// verified IN THIS BROWSER and tied to the phone this page verifies first (verifier/web/pvm-host.mjs).
//
// The flow (verifyPvmAppWith):
//   1. THE PHONE: the whole host check (verifyPvmHostWeb: its host VM's evidence over this page's nonce, Google's chain, the
//      release, the runtime, the attach key). Only a pass goes on; it hands back the transport key the box attached with.
//   2. THE APP: a FRESH 32-byte nonce, then ONE request, GET <api>/v1/enclaves/<name>/apps/<deployment>/attestation?nonce=.
//      The relay asks the app's own public origin (https://<id8>.app.enclave.host/.well-known/enclave-attestation, which the
//      VM's front answers on the app's own TLS listener before the app sees it) and answers the VM's evidence verbatim, with
//      the key that origin presented in the TLS handshake, the app it derived from the catalog, the attach key, and - the app
//      VM being a sibling of the box's own VM - the box's sibling statement over the same nonce and its registered proof key.
//   3. THE RULES: relay/pvm-evidence-core.mjs verifyPvmAppEvidence (the market's own admission rules) over this nonce and the
//      expected app, v4 required: Google's chain, a secure VM, the release and runtime on the list, the challenge, the instance,
//      app and TLS key signatures. Then here: the TLS key the evidence binds is the key the app's public certificate carries,
//      and the VM is this phone's: the tunnel's own VM, or a sibling whose statement (nonce, its transport key, its instance,
//      this deployment) recovers, on secp256k1 in this page, to the box's proof key - a key only VMs of the pinned build hold.
// The relay is trusted for what it states and the verdict says which: the expected app (its catalog derivation), the
// allow-lists (the operator's, unless pinned), and the proof key (its registry read; the registry id is shown to check on
// chain). It cannot forge the evidence. A pass is "limited" unless everything it states is pinned by the caller.
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { judgePvmEvidence, reasonCheck, SEQUENCE, CHECK_LABELS as HOST_LABELS, OMISSION_LABELS as HOST_OMISSIONS, TECHNOLOGY } from "./pvm-host.mjs";
import { PVM_APP_EVIDENCE_FORMAT_V4 } from "../../relay/pvm-evidence-core.mjs";
import { GOOGLE_ATTESTATION_ROOT_SHA256 } from "./avf.mjs";
import { OPERATOR_STATED } from "../metal-box.mjs";

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(String(h).match(/../g) || [], (x) => parseInt(x, 16));
const b64ToBytes = (s) => { const bin = atob(String(s)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const cat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const HEX64 = /^[0-9a-f]{64}$/, DEPLOYMENT = /^0x[0-9a-fA-F]{64}$/, ADDR = /^0x[0-9a-f]{40}$/, AUTHORITY = /^(?:[0-9a-f]{2}){32,64}$/;
export const MAX_APP_ANSWER = 512 * 1024, MAX_LIST = 256;
export const PVM_APP_PATH = (name, deployment, nonceHex) => `/v1/enclaves/${encodeURIComponent(name)}/apps/${encodeURIComponent(deployment)}/attestation?nonce=${nonceHex}`;
export const SIBLING_FORMAT = "enclave-pvm-sibling/v1";

// relay/pvm-market.mjs siblingDigest and checkSibling, restated for a page (@noble instead of node:crypto and viem)
export function siblingDigestWeb({ nonce, transportSpki, instanceId, deployment }) {
  return sha256(cat(new TextEncoder().encode("enclave-pvm-sibling-v1\n"), fromHex(nonce), sha256(fromHex(transportSpki)), fromHex(instanceId), fromHex(String(deployment).slice(2))));
}
export function recoverSignerWeb(digest, sigHex) {
  if (!/^[0-9a-f]{130}$/.test(String(sigHex))) throw new Error("the sibling signature is malformed");
  const raw = fromHex(sigHex), v = raw[64], bit = v >= 27 ? v - 27 : v;
  if (bit !== 0 && bit !== 1) throw new Error("the sibling signature's recovery id is not 0, 1, 27 or 28");
  const pub = secp256k1.Signature.fromCompact(raw.subarray(0, 64)).addRecoveryBit(bit).recoverPublicKey(digest).toRawBytes(false);
  return "0x" + toHex(keccak_256(pub.subarray(1)).subarray(12));
}
export function checkSiblingWeb(s, { nonce, deployment, transportSpki, instanceId, proofKey }) {
  if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).sort().join() !== "deployment,format,instanceId,nonce,proofKey,sig,transportSpki")
    throw new Error("the sibling statement is malformed");
  if (s.format !== SIBLING_FORMAT || s.nonce !== nonce || s.deployment !== deployment || s.transportSpki !== transportSpki || s.instanceId !== instanceId)
    throw new Error("the sibling statement is not for this nonce, deployment and VM");
  if (!ADDR.test(String(proofKey || "")) || /^0x0{40}$/.test(String(proofKey))) throw new Error("the box has no registered proof key");
  let who;
  try { who = recoverSignerWeb(siblingDigestWeb({ nonce, transportSpki, instanceId, deployment }), s.sig); }
  catch (e) { throw new Error(/malformed|recovery id/.test(e.message) ? e.message : "the sibling signature does not recover"); }
  if (who !== String(proofKey).toLowerCase()) throw new Error("the VM does not hold this box's registered proof key");
}

const APP_ORDER = ["host", "document", "googleChain", "secureVm", "release", "runtime", "nonce", "app", "challenge", "instance", "appKey", "tlsKey", "tlsHandshake", "sameHost"];
export const PVM_APP_CHECK_LABELS = Object.freeze({
  host: "The phone itself verified first (its own protected VM's evidence over this page's nonce, Google's chain, the release)",
  ...Object.fromEntries(APP_ORDER.filter((k) => HOST_LABELS[k]).map((k) => [k, HOST_LABELS[k]])),
  app: "App (its SHA-256) is the one the deployment names (the relay's derivation from the catalog)",
  tlsHandshake: "The TLS key the evidence binds is the key the app's public certificate carries (seen in the TLS handshake)",
  sameHost: "This VM is the phone's: the box's own VM, or a sibling holding the phone's registered proof key (recovered here on secp256k1)",
});
export const PVM_APP_CHECK_ORDER = Object.freeze(APP_ORDER);
export const APP_RELAY_DERIVED = "app-expectation-relay-derived", PROOF_KEY_RELAY_STATED = "proof-key-relay-stated";
export const PVM_APP_OMISSION_LABELS = Object.freeze({
  [OPERATOR_STATED]: HOST_OMISSIONS[OPERATOR_STATED],
  [APP_RELAY_DERIVED]: "The app this page expects (its SHA-256) was derived by the relay from the deployment's catalog entry, not by this page. The evidence is checked against it exactly, but what it should be is the relay's statement.",
  [PROOF_KEY_RELAY_STATED]: "The phone's proof key was read from the on-chain registry by the relay, not by this page (the registry id is shown so you can read it yourself).",
});

// deps: { fetchImpl, verifyHost(name) -> verifyPvmHostWeb's verdict, randomBytes(n), now() -> Date }
// expected: { appId, codeHashes, authorityHashes, runtimeIds, rootPins, proofKey } pins what the relay would otherwise state.
export async function verifyPvmAppWith(deps, { apiBase = "https://api.enclave.host", name, deployment, expected = null, timeoutMs = 45000 } = {}) {
  const checks = Object.fromEntries(APP_ORDER.map((k) => [k, undefined]));
  let facts = [["Box", typeof name === "string" ? name.slice(0, 64) : "(none)"]], omissions = [], reasons = [];
  const verdict = (status, summary) => ({ status, technology: TECHNOLOGY, name: name ?? null, checkOrder: [...APP_ORDER], checkLabels: { ...PVM_APP_CHECK_LABELS },
                                          checks, omissions, omissionLabels: Object.fromEntries(omissions.map((o) => [o, PVM_APP_OMISSION_LABELS[o] || o])), reasons, summary, facts });
  const error = (why) => { reasons = [...reasons, why]; return verdict("error", `This app's protected VM could not be verified (${why}); that is not a verdict on the app.`); };
  const refuse = (key, why) => { if (key) checks[key] = false; reasons = [...reasons, why]; return verdict("rejected", `This app's protected VM evidence was refused (${why}); nothing about the app's VM is established.`); };
  try {
    if (typeof deployment !== "string" || !DEPLOYMENT.test(deployment)) return error("no deployment id (0x and 64 hex digits)");
    const dep = deployment.toLowerCase(), deadline = Date.now() + timeoutMs;
    const pinList = (v, re) => (v == null ? null : Array.isArray(v) && v.length && v.length <= MAX_LIST && v.every((x) => re.test(String(x).toLowerCase())) ? v.map((x) => String(x).toLowerCase()) : undefined);
    const pin = { appId: expected?.appId == null ? null : String(expected.appId).toLowerCase(), codeHashes: pinList(expected?.codeHashes, HEX64),
                  authorityHashes: pinList(expected?.authorityHashes, AUTHORITY), runtimeIds: pinList(expected?.runtimeIds, HEX64), rootPins: pinList(expected?.rootPins, HEX64),
                  proofKey: expected?.proofKey == null ? null : String(expected.proofKey).toLowerCase() };
    if ((pin.appId !== null && !HEX64.test(pin.appId)) || Object.values(pin).includes(undefined) || (pin.proofKey !== null && !ADDR.test(pin.proofKey)))
      return error("an expected value is malformed (appId 64 hex, lists of hex, proofKey an address)");

    // ---- 1. the phone, whole; nothing about the app is asked unless it passed
    const host = await deps.verifyHost(name);
    facts.push(["Deployment", dep]);
    if (!host || (host.status !== "verified" && host.status !== "limited")) {
      const why = String((host?.reasons || []).at(-1) || host?.status || "no verdict");
      return host && host.status === "rejected" ? refuse("host", `the phone ${name} did not verify: ${why}`) : error(`the phone ${name} could not be checked: ${why}`);
    }
    checks.host = true;
    const hostKeyFact = (host.facts || []).find(([k]) => k === "transport key");
    facts.push(["Phone verdict", `${host.status}${hostKeyFact ? ` (attach key ${String(hostKeyFact[1]).slice(0, 23)}…)` : ""}`]);

    // ---- 2. the app: a fresh nonce, one request, never retried
    const nonce = Uint8Array.from(deps.randomBytes(32)), nonceHex = toHex(nonce);
    if (nonce.length !== 32) return error("no 32 random bytes for the nonce");
    facts.push(["App nonce (drawn by this page)", `${nonceHex.slice(0, 32)}…`]);
    let body, status;
    {
      const left = deadline - Date.now(); if (left <= 0) return error(`no answer within ${timeoutMs} ms`);
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), left);
      const fetchImpl = deps.fetchImpl;   // called unbound: a browser's fetch refuses any other `this` ("Illegal invocation")
      try {
        let r;
        try { r = await fetchImpl(`${apiBase}${PVM_APP_PATH(name, dep, nonceHex)}`, { method: "GET", signal: ctrl.signal, redirect: "error", credentials: "omit", headers: { accept: "application/json" } }); }
        catch (e) { return error(`app attestation: ${e && e.name === "AbortError" ? `no answer within ${timeoutMs} ms` : e.message}`); }
        const text = await r.text(); status = r.status;
        if (text.length > MAX_APP_ANSWER) return error(`app attestation: the answer exceeds ${MAX_APP_ANSWER} bytes`);
        try { body = JSON.parse(text); } catch { return error(`app attestation: HTTP ${r.status}: the answer is not JSON`); }
      } finally { clearTimeout(t); }
    }
    if (status === 503 && body?.error === "busy") {
      const after = Number.isSafeInteger(body.retryAfter) && body.retryAfter > 0 && body.retryAfter <= 3600 ? ` (the relay suggests ${body.retryAfter} s)` : "";
      return error(`app attestation: busy: this app's VM was asked for evidence moments ago or a check is in flight; this page does not retry; try again later${after}`);
    }
    if (status !== 200) return error(`app attestation: HTTP ${status}: ${String(body?.message || body?.error || "no answer").slice(0, 300)}`);
    if (!body || typeof body !== "object" || Array.isArray(body)) return error("app attestation: the answer is not a JSON object");
    if (body.mode !== "avf") return error(`${name} is not a phone host (mode ${JSON.stringify(String(body.mode ?? null).slice(0, 32))})`);
    if (body.name != null && body.name !== name) return refuse(null, "the relay answered for another host");
    if (typeof body.deployment !== "string" || body.deployment.toLowerCase() !== dep) return refuse(null, "the relay answered for another deployment");
    if (body.nonce !== nonceHex) return refuse("nonce", "the relay answered for another nonce");
    if (typeof body.origin === "string" && body.origin.length <= 200) facts.push(["Fetched from the app's own origin", body.origin]);
    const doc = body.document;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return error("the answer carries no evidence document");
    let handshakeHex, attachHex;
    try { const k = b64ToBytes(body.handshakeSpki); if (k.length < 44 || k.length > 4096) throw new Error(); handshakeHex = toHex(k); } catch { return error("the answer carries no usable handshake key (handshakeSpki)"); }
    try { const k = b64ToBytes(body.attachTransportKey); if (k.length !== 44) throw new Error(); attachHex = toHex(k); } catch { return error("the answer carries no attach transport key"); }
    if (hostKeyFact && String(hostKeyFact[1]) !== `sha256:${toHex(sha256(fromHex(attachHex)))}`) return refuse("host", "the attach key the relay states now is not the one the phone check just verified (it re-attached?)");

    // ---- 3. what to expect: the caller's pins, else the relay's statements (each named as an omission)
    const appId = pin.appId || (HEX64.test(String(body.expected?.appSha256 || "")) ? body.expected.appSha256 : null);
    if (!appId) return error("the answer carries no expected app (expected.appSha256)");
    facts.push([pin.appId ? "App SHA-256 (your pin)" : "App SHA-256 (derived by the relay from the catalog)", appId]);
    const op = body.operatorAllowlist && typeof body.operatorAllowlist === "object" && !Array.isArray(body.operatorAllowlist) ? body.operatorAllowlist : {};
    const opList = (v, re) => (Array.isArray(v) && v.length <= MAX_LIST ? v.map((x) => String(x).toLowerCase()).filter((x) => re.test(x)) : []);
    const lists = { codeHashes: pin.codeHashes || opList(op.codeHashes, HEX64), authorityHashes: pin.authorityHashes || opList(op.authorityHashes, AUTHORITY), runtimeIds: pin.runtimeIds || opList(op.runtimeIds, HEX64) };
    const builtin = [...GOOGLE_ATTESTATION_ROOT_SHA256.values()], given = pin.rootPins || (Array.isArray(op.rootPins) ? opList(op.rootPins, HEX64) : null);
    const rootPins = given ? builtin.filter((p) => given.includes(p)) : builtin;
    if (!rootPins.length) return refuse("googleChain", "the root pins given name none of the Google roots this page pins");
    if (!lists.codeHashes.length || !lists.authorityHashes.length) return refuse("release", "no allowed code hashes or signing authorities: refusing (fail closed)");
    if (!lists.runtimeIds.length) return refuse("runtime", "no allowed runtime ids: refusing (fail closed)");
    if (!(pin.codeHashes && pin.authorityHashes && pin.runtimeIds)) omissions.push(OPERATOR_STATED);
    if (!pin.appId) omissions.push(APP_RELAY_DERIVED);

    // ---- 4. the market's own admission rules, over this nonce and that app, v4 (a TLS key) required
    checks.nonce = doc.nonce === nonceHex;
    if (!checks.nonce) return refuse("nonce", "the evidence answers another nonce (stale or replayed)");
    checks.app = doc.app === appId;
    if (!checks.app) return refuse("app", "the VM runs another app than the deployment names");
    if (doc.format !== PVM_APP_EVIDENCE_FORMAT_V4) return refuse("document", `${JSON.stringify(String(doc.format).slice(0, 64))} binds no TLS key: refused (v4 required)`);
    const { result, avf } = await judgePvmEvidence(doc, { nonce: nonceHex, appId, requireTls: true, allowedRuntimeIds: lists.runtimeIds,
      allowedCodeHashes: lists.codeHashes, allowedAuthorityHashes: lists.authorityHashes, rootPins, now: (deps.now ? deps.now() : new Date()).getTime() });
    if (!result.ok) {
      const at = reasonCheck(result.reasons.at(-1)), i = SEQUENCE.indexOf(at);
      if (i >= 0) for (const k of SEQUENCE.slice(0, i)) checks[k] = true;
      return refuse(at, result.reasons.at(-1));
    }
    for (const k of SEQUENCE) checks[k] = true;
    if (avf && avf.ok) facts.push(["APK", `${avf.component.name} (security version ${avf.component.securityVersion})`], ["Code hash", avf.component.codeHash], ["Google root", `${avf.root.subjectCn || "?"} (sha256:${avf.root.fp256})`]);
    let rt = null; try { rt = JSON.parse(doc.identity); } catch {}
    if (rt && typeof rt.name === "string") facts.push(["Runtime", `${rt.name} ${rt.version} (${rt.execution}, ${rt.targetIsa} on ${rt.hostIsa})`.slice(0, 160)]);
    facts.push(["Runtime id", result.runtimeId], ["Instance", result.instanceId], ["App TLS key sha256 (the key its certificate carries)", result.tlsSpkiSha256]);

    // ---- 5. the TLS handshake and the phone
    checks.tlsHandshake = result.tlsSpki === handshakeHex;
    if (!checks.tlsHandshake) return refuse("tlsHandshake", "the TLS key the evidence binds is not the key the app's public certificate carries");
    if (result.transportSpki === attachHex) { checks.sameHost = true; facts.push(["This VM", "the phone's own attached VM"]); }
    else {
      const proofKey = pin.proofKey || (ADDR.test(String(body.proofKey || "")) ? String(body.proofKey).toLowerCase() : null);
      if (!proofKey) return refuse("sameHost", "the VM is not the phone's attached VM and the relay stated no proof key for the phone");
      if (!body.sibling) return refuse("sameHost", "the VM is not the phone's attached VM and the phone gave no sibling statement");
      try { checkSiblingWeb(body.sibling, { nonce: nonceHex, deployment: dep, transportSpki: result.transportSpki, instanceId: result.instanceId, proofKey }); }
      catch (e) { return refuse("sameHost", e.message); }
      checks.sameHost = true;
      if (!pin.proofKey) omissions.push(PROOF_KEY_RELAY_STATED);
      facts.push(["This VM", `a sibling of the phone's VM, holding its proof key ${proofKey}`], ...(typeof body.registryId === "string" && HEX64.test(body.registryId.slice(2)) ? [["Phone's registry id (proof key on chain)", body.registryId]] : []));
    }
    reasons = omissions.map((o) => `OMITTED (${o}): ${PVM_APP_OMISSION_LABELS[o] || o}`);
    const st = omissions.length ? "limited" : "verified";
    return verdict(st, `This app's own protected VM on ${name} answered this page's nonce with evidence certified through Google's attestation root: a secure, not debuggable pKVM VM `
      + `running ${pin.codeHashes ? "a release you pinned" : "a release on the relay operator's list"}, the app the deployment names, with its TLS key (the one its public certificate carries) bound under the VM's attested key, `
      + `and the VM is the phone's own or holds the phone's registered proof key. Android is kept out of its memory by pKVM; the hypervisor, Google's chain and the phone's hardware stay trusted`
      + (st === "limited" ? "; limited: what to expect was stated by the relay, not by you." : "."));
  } catch (e) { return error(`verifier: ${e && e.message ? e.message : String(e)}`); }
}
