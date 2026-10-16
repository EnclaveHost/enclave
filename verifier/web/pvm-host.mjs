// verifier/web/pvm-host.mjs: verify an attached Android pVM host (relay row mode "avf", e.g. pixel10-pvm-cpu) IN A BROWSER,
// the way verifier/metal-box.mjs verifies a metal SEV-SNP box: through the relay, over a nonce this page draws.
//
// What is checked, and what each check rests on:
//   1. FRESHNESS: GET <api>/v1/enclaves/<name>/attestation?nonce=<64 hex this page drew>. The relay asks the host VM for its
//      app evidence over that nonce and returns the VM's document verbatim (enclave-pvm-app-evidence/v3 or /v4), with the
//      transport key it verified when the box attached and its own allow-lists.
//   2. GENUINENESS AND BINDING: the document is judged by relay/pvm-evidence-core.mjs verifyPvmAppEvidence, the very rules
//      the relay runs (relay/pvm-app-attest.mjs), here over @noble (SHA-256, Ed25519, P-256) and verifier/web/avf.mjs (the
//      AVF chain on WebCrypto): a closed shape per version; the X.509 chain to a Google attestation root pinned in this
//      file (the relay's rootPins may only narrow those, never widen them); a secure VM; the APK's code hash and signing
//      authority on the list; an admissible runtime identity on the list and its W^X self-test; the leaf's challenge equal
//      to Bind3(transport key, OUR nonce, RuntimeID, InstanceID) || AppID; instanceSig, appKeySig and (v4) tlsKeySig.
//   3. THE BOX: the document's transport key must be the one the relay says it verified when the box attached, so the
//      relay's tunnel to <name> ends in this VM. That is the relay's statement; the evidence binds the key itself.
// What is NOT independent, and says so (omissions, never a silent pass): the app is the one the evidence names (the host
// serves its own idle app, so nothing independent says which app to expect) unless the caller pins expected.appId; and the
// allow-lists are the relay operator's own unless the caller pins expected.codeHashes / authorityHashes / runtimeIds. Either
// keeps a pass "limited"; only a caller who pins all four can see "verified".
import { sha256 } from "@noble/hashes/sha2";
import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/p256";
import { pvmEvidenceRules, PVM_APP_EVIDENCE_FORMAT_V3, PVM_APP_EVIDENCE_FORMAT_V4 } from "../../relay/pvm-evidence-core.mjs";
import { prepareAvfChain, avfVerifier, GOOGLE_ATTESTATION_ROOT_SHA256 } from "./avf.mjs";
import { FRESH_ATTESTATION_PATH, OPERATOR_STATED } from "../metal-box.mjs";

export const TECHNOLOGY = "android-avf-pvm";
export const APP_FROM_EVIDENCE = "expected-app-from-evidence";
export const MAX_ANSWER_BYTES = 512 * 1024;
const NAME = /^[A-Za-z0-9_-]{1,64}$/, HEX64 = /^[0-9a-f]{64}$/, AUTHORITY = /^(?:[0-9a-f]{2}){32,64}$/;
const ED25519_SPKI_PREFIX = "302a300506032b6570032100";
const MAX_LIST = 256, MAX_SOURCE = 300;
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// The cryptography relay/pvm-evidence-core.mjs asks for, in a browser: synchronous, so the shared rules run unchanged.
// Ed25519 is RFC 8032 strict (zip215: false: no non-canonical encodings, S < L), as OpenSSL verifies it in the relay.
function webCrypto(verifyAvf) {
  return {
    sha256: (b) => Buffer.from(sha256(b)),
    ed25519Verify: (spki, message, signature) => spki.length === 44 && toHex(spki.subarray(0, 12)) === ED25519_SPKI_PREFIX
      && ed25519.verify(signature, message, spki.subarray(12), { zip215: false }),
    isP256Spki: (der) => { try { p256.ProjectivePoint.fromHex(der.subarray(26)); return true; } catch { return false; } },
    verifyAvf,
  };
}

// judgePvmEvidence(envelope, expect) -> { result: verifyPvmAppEvidence's result, avf: the AVF verdict when it ran (component,
// root) }. expect is relay/pvm-app-attest.mjs verifyPvmAppEvidence's. The chain's signatures are checked first (WebCrypto is
// asynchronous), then the shared rules run.
export async function judgePvmEvidence(envelope, expect = {}) {
  const prepared = await prepareAvfChain(envelope && typeof envelope === "object" && Array.isArray(envelope.chain) ? envelope.chain : []);
  const avf = avfVerifier(prepared);
  let avfResult = null;
  const rules = pvmEvidenceRules(webCrypto((ev, opts) => (avfResult = avf(ev, opts))));
  return { result: rules.verifyPvmAppEvidence(envelope, expect), avf: avfResult };
}
// The browser's verifyPvmAppEvidence: the same result as relay/pvm-app-attest.mjs's, for the same document and expectations.
export const verifyPvmEvidenceWeb = async (envelope, expect = {}) => (await judgePvmEvidence(envelope, expect)).result;

// ---- the verdict a page renders ----
export const CHECK_LABELS = Object.freeze({
  document: "Evidence document has exactly the fields of its format (enclave-pvm-app-evidence v3 or v4), each in its exact form",
  googleChain: "VM certificate chain → Google's attestation root (pinned in this page's verifier): every link signed, in date, a CA where it must be",
  secureVm: "Protected VM is secure: every boot stage in normal mode, not debuggable (AVF isVmSecure)",
  release: "VM payload is an allowed release: the APK's code hash and its signing authority are on the list",
  runtime: "Wasm runtime is admissible and on the list, and its W^X self-test is clean",
  nonce: "Evidence names this page's nonce (32 random bytes drawn here); the certificate's challenge binds it",
  app: "App (its SHA-256) is the expected one",
  challenge: "Certificate's challenge = Bind3(transport key, this nonce, runtime, instance) ‖ app, as recomputed here",
  instance: "VM instance key signed that challenge (instanceSig, Ed25519)",
  appKey: "Attested transport key signed the app's sealing key for this nonce, app and instance (appKeySig, Ed25519)",
  tlsKey: "Attested transport key signed the app's TLS key for this nonce, app and instance (tlsKeySig, Ed25519)",
  transportKey: "Evidence's transport key = the key the relay verified when the box attached (the relay's tunnel ends in this VM)",
});
export const OMISSION_LABELS = Object.freeze({
  [APP_FROM_EVIDENCE]: "The app was taken from the evidence itself: the host serves its own app, and nothing independent of the box said which app it should run (pin one with expected.appId)",
  [OPERATOR_STATED]: "The allowed code hashes, signing authorities and runtimes are the relay operator's own list, not an expectation independent of the operator (pin your own with expected.codeHashes, authorityHashes and runtimeIds)",
});
const ORDER_V3 = ["document", "googleChain", "secureVm", "release", "runtime", "nonce", "app", "challenge", "instance", "appKey", "transportKey"];
const ORDER_V4 = [...ORDER_V3.slice(0, -1), "tlsKey", "transportKey"];
// the order relay/pvm-evidence-core.mjs evaluates them in: a refusal at one means every earlier one held, every later one
// was not reached (nonce, app and transportKey are compared here, beside the rules)
const SEQUENCE = ["document", "runtime", "googleChain", "challenge", "secureVm", "release", "instance", "appKey", "tlsKey"];

// reasonCheck(reason) -> the check a refusal of relay/pvm-evidence-core.mjs (or relay/avf-verify.mjs, inside it) belongs to
export function reasonCheck(reason) {
  const m = String(reason);
  if (/another nonce|evidence nonce|caller's nonce/.test(m)) return "nonce";
  if (/names another app|evidence app is|caller's expected app/.test(m)) return "app";
  if (/^attestation: /.test(m)) {
    const a = m.slice(13);
    if (/^leaf extension|attestationChallenge/.test(a)) return "challenge";
    if (/isVmSecure/.test(a)) return "secureVm";
    if (/code\/authority hashes|APK component/.test(a)) return "release";
    return "googleChain";
  }
  if (/instanceSig is not the instance key's signature/.test(m)) return "instance";
  if (/appKey is not signed/.test(m)) return "appKey";
  if (/TLS key is not signed/.test(m)) return "tlsKey";
  if (/^no allowed(CodeHashes|AuthorityHashes)/.test(m)) return "release";
  if (/^an empty rootPins/.test(m)) return "googleChain";
  if (/runtime|self-test|^exec_pages|^wx=|^maps=|^scope=|^execution=/.test(m) && !/^the evidence/.test(m)) return "runtime";
  return "document";
}

// hex lists: a caller's must be well-formed (a malformed pin is the caller's error); an operator's are filtered, as
// verifier/metal-box.mjs filters the measurement list
const listOf = (v, re, strict, what) => {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length > MAX_LIST) { if (strict) throw new Error(`expected.${what} must be a list of at most ${MAX_LIST}`); return null; }
  const out = v.map((x) => String(x).toLowerCase());
  if (strict && (!out.length || !out.every((x) => re.test(x)))) throw new Error(`expected.${what} must be a non-empty list of lowercase hex of the right length`);
  return out.filter((x) => re.test(x));
};
async function readCapped(r, max) {
  if (r.body && typeof r.body.getReader === "function") {
    const reader = r.body.getReader(), parts = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      n += value.length; if (n > max) { try { await reader.cancel(); } catch {} throw new Error(`the answer exceeds ${max / 1024} KiB`); }
      parts.push(value);
    }
    const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    return new TextDecoder().decode(all);
  }
  const text = await r.text();
  if (text.length > max) throw new Error(`the answer exceeds ${max / 1024} KiB`);
  return text;
}
const b64ToBytes = (s) => { const bin = atob(String(s)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

// verifyPvmHostWeb({ apiBase, name, expected, fetchImpl, timeoutMs, randomBytes?, now? }) -> the verdict (shape at the end).
//   expected: { codeHashes, authorityHashes, runtimeIds, appId, rootPins?, source? }: each given list REPLACES the operator's;
//   rootPins only narrow the pinned Google roots. randomBytes(n) and now() are for tests (a fixture answers a fixed nonce
//   at a fixed time); a page leaves them to crypto.getRandomValues and its clock.
export async function verifyPvmHostWeb({ apiBase = "https://api.enclave.host", name, expected = null, fetchImpl = globalThis.fetch, timeoutMs = 30000,
                                         randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)), now = () => new Date() } = {}) {
  const facts = [["box", typeof name === "string" ? name.slice(0, 64) : String(name)]];
  const verdict = (status, { checkOrder = ORDER_V4, checks = {}, omissions = [], reasons = [], summary } = {}) => ({
    status, technology: TECHNOLOGY, name: name ?? null, checkOrder, checkLabels: Object.fromEntries(checkOrder.map((k) => [k, CHECK_LABELS[k]])),
    checks: Object.fromEntries(checkOrder.map((k) => [k, checks[k]])), omissions, omissionLabels: Object.fromEntries(omissions.map((o) => [o, OMISSION_LABELS[o]])),
    reasons, summary, facts });
  const error = (why) => verdict("error", { reasons: [why], summary: `Could not verify ${typeof name === "string" && NAME.test(name) ? name : "the box"}: ${why}` });
  try {
    if (typeof name !== "string" || !NAME.test(name)) return error("no box name (an attached pVM host's name, e.g. pixel10-pvm-cpu)");
    if (typeof fetchImpl !== "function") return error("no fetch in this environment");
    if (expected != null && (typeof expected !== "object" || Array.isArray(expected))) return error("expected must be an object");
    const pin = {
      codeHashes: listOf(expected?.codeHashes, HEX64, true, "codeHashes"), authorityHashes: listOf(expected?.authorityHashes, AUTHORITY, true, "authorityHashes"),
      runtimeIds: listOf(expected?.runtimeIds, HEX64, true, "runtimeIds"), rootPins: listOf(expected?.rootPins, HEX64, true, "rootPins"),
    };
    const pinnedApp = expected?.appId == null ? null : String(expected.appId).toLowerCase();
    if (pinnedApp !== null && !HEX64.test(pinnedApp)) return error("expected.appId must be 64 hex (the app's SHA-256)");
    const nonce = randomBytes(32);
    if (!(nonce instanceof Uint8Array) || nonce.length !== 32) return error("no 32 random bytes for the nonce");
    const nonceHex = toHex(nonce);
    facts.push(["nonce", `${nonceHex.slice(0, 32)}… (drawn by this page)`]);

    // 1. the relay's answer: bounded, JSON, for this box and this nonce
    let body;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const fetchUnbound = fetchImpl;   // called unbound: a browser's fetch refuses any other `this` ("Illegal invocation")
      const r = await fetchUnbound(`${apiBase}${FRESH_ATTESTATION_PATH(name)}?nonce=${nonceHex}`, { signal: ctrl.signal, redirect: "error", credentials: "omit", headers: { accept: "application/json" } });
      const text = await readCapped(r, MAX_ANSWER_BYTES);
      try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}: the answer is not JSON`); }
      if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${String(body?.message || body?.error || "no document").slice(0, 300)}`);
    } catch (e) { return error(`fresh attestation of ${name}: ${e && e.name === "AbortError" ? `no answer within ${timeoutMs} ms` : e.message}`); }
    finally { clearTimeout(t); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return error("the relay's answer is not an object");
    if (body.mode !== undefined && body.mode !== "avf") return error(`${name} is not a pVM host (mode ${JSON.stringify(String(body.mode).slice(0, 32))})`);
    if (body.name !== undefined && body.name !== name) return error(`the relay answered for another box (${JSON.stringify(String(body.name).slice(0, 64))})`);
    const doc = body.document;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return error(`${name} returned no pVM evidence document`);
    if (typeof body.fetchedAt === "string") facts.push(["fetched at", `${body.fetchedAt.slice(0, 40)} (the relay's clock)`]);
    const v4 = doc.format === PVM_APP_EVIDENCE_FORMAT_V4, checkOrder = v4 || doc.format !== PVM_APP_EVIDENCE_FORMAT_V3 ? ORDER_V4 : ORDER_V3;
    facts.push(["evidence format", String(doc.format).slice(0, 64)]);

    // 2. what to expect: the caller's pins, else the operator's lists (each replaced separately); roots only ever narrow
    const op = body.operatorAllowlist && typeof body.operatorAllowlist === "object" && !Array.isArray(body.operatorAllowlist) ? body.operatorAllowlist : {};
    const opSource = typeof op.source === "string" && op.source ? op.source.slice(0, MAX_SOURCE) : "the relay's PVM_CPU policy";
    const lists = {
      codeHashes: pin.codeHashes || listOf(op.codeHashes, HEX64, false) || [], authorityHashes: pin.authorityHashes || listOf(op.authorityHashes, AUTHORITY, false) || [],
      runtimeIds: pin.runtimeIds || listOf(op.runtimeIds, HEX64, false) || [],
    };
    const fromOperator = ["codeHashes", "authorityHashes", "runtimeIds"].filter((k) => !pin[k]);
    const rootsGiven = pin.rootPins || listOf(op.rootPins, HEX64, false);
    const builtin = [...GOOGLE_ATTESTATION_ROOT_SHA256.values()];
    const rootPins = rootsGiven ? builtin.filter((p) => rootsGiven.includes(p)) : builtin;
    facts.push(["expected from", fromOperator.length === 0 ? String(expected.source || "caller").slice(0, MAX_SOURCE)
      : fromOperator.length === 3 ? `relay operator: ${opSource}` : `caller (${["codeHashes", "authorityHashes", "runtimeIds"].filter((k) => pin[k]).join(", ")}); relay operator (${fromOperator.join(", ")}): ${opSource}`]);

    // 3. the comparisons made here, beside the rules: our nonce (and the relay's echo), the app, the attach key
    const checks = {}, failures = [];
    checks.nonce = doc.nonce === nonceHex && (body.nonce === undefined || body.nonce === nonceHex);
    if (!checks.nonce) failures.push(body.nonce !== undefined && body.nonce !== nonceHex ? "the relay answered for another nonce" : "the evidence answers another nonce (stale or replayed)");
    const appId = pinnedApp || (typeof doc.app === "string" && HEX64.test(doc.app) ? doc.app : null);
    checks.app = appId !== null && doc.app === appId;
    if (!checks.app) failures.push(pinnedApp ? "the evidence names another app than the one you pinned" : "the evidence names no app (64 lowercase hex)");
    let attachSpki = null;
    try { const k = b64ToBytes(body.attachTransportKey); if (k.length === 44 && toHex(k.subarray(0, 12)) === ED25519_SPKI_PREFIX) attachSpki = toHex(k); } catch {}
    checks.transportKey = attachSpki !== null && doc.spki === attachSpki;
    if (!checks.transportKey) failures.push(attachSpki === null ? "the relay stated no attach transport key (base64 of a 44-byte Ed25519 SPKI): nothing ties this VM to the box's tunnel"
                                                                : "the evidence's transport key is not the key the relay verified when the box attached: this VM is not the one behind the box's tunnel");
    if (typeof doc.spki === "string" && /^[0-9a-f]{88}$/.test(doc.spki)) facts.push(["transport key", `sha256:${toHex(sha256(Uint8Array.from(doc.spki.match(/../g), (h) => parseInt(h, 16))))}`]);

    // 4. the shared rules, over our nonce and the expectations above
    const omissions = [...(pinnedApp ? [] : [APP_FROM_EVIDENCE]), ...(fromOperator.length ? [OPERATOR_STATED] : [])];
    let result = null, avf = null;
    if (![PVM_APP_EVIDENCE_FORMAT_V3, PVM_APP_EVIDENCE_FORMAT_V4].includes(doc.format)) {
      checks.document = false;
      failures.push(`${JSON.stringify(String(doc.format).slice(0, 64))} is not pVM host evidence (${PVM_APP_EVIDENCE_FORMAT_V3} or ${PVM_APP_EVIDENCE_FORMAT_V4}): an unbound format is refused`);
    } else if (!rootPins.length) {
      checks.googleChain = false; failures.push("the root pins given name none of the Google roots this page pins: refused (they may only narrow the built-in pins)");
    } else if (!lists.codeHashes.length || !lists.authorityHashes.length) {
      checks.release = false; failures.push(`no ${!lists.codeHashes.length ? "allowedCodeHashes" : "allowedAuthorityHashes"}: refusing (fail closed): neither you nor the relay operator named any`);
    } else if (!lists.runtimeIds.length) {
      checks.runtime = false; failures.push("no allowedRuntimeIds: refusing (fail closed): neither you nor the relay operator named any");
    } else {
      ({ result, avf } = await judgePvmEvidence(doc, { nonce: nonceHex, appId: appId || "00".repeat(32), allowedRuntimeIds: lists.runtimeIds,
        allowedCodeHashes: lists.codeHashes, allowedAuthorityHashes: lists.authorityHashes, rootPins, now: now().getTime() }));
      if (result.ok) for (const k of SEQUENCE) { if (k !== "tlsKey" || v4) checks[k] = true; }
      else {
        const at = reasonCheck(result.reasons.at(-1)), i = SEQUENCE.indexOf(at);
        if (i >= 0) { for (const k of SEQUENCE.slice(0, i)) checks[k] = true; checks[at] = false; }
        else checks[at] = false;
        failures.push(result.reasons.at(-1));
      }
    }

    // 5. what the evidence establishes, as facts
    if (avf && avf.ok) {
      facts.push(["APK", `${avf.component.name} (security version ${avf.component.securityVersion})`], ["code hash", avf.component.codeHash],
                 ["signing authority", avf.component.authorityHash], ["Google root", `${avf.root.subjectCn || "?"} (sha256:${avf.root.fp256})`]);
    }
    let rt = null;
    try { rt = typeof doc.identity === "string" && doc.identity.length <= 1024 ? JSON.parse(doc.identity) : null; } catch {}
    if (rt && typeof rt === "object" && typeof rt.name === "string") facts.push(["runtime", `${rt.name} ${rt.version} (${rt.execution}, ${rt.targetIsa} on ${rt.hostIsa})`.slice(0, 160)]);
    if (result && result.runtimeId) facts.push(["runtime id", result.runtimeId]);
    if (typeof doc.selftest === "string") facts.push(["self-test", doc.selftest.slice(0, 300)]);
    if (appId) facts.push(["app", `${appId}${pinnedApp ? "" : " (named by the evidence)"}`]);
    if (result && result.instanceId) facts.push(["instance", result.instanceId]);
    if (result && result.tlsSpkiSha256) facts.push(["TLS key", `sha256:${result.tlsSpkiSha256}`]);
    const keyFact = facts.find(([k]) => k === "transport key");
    facts.push(["channel", `this request's TLS ends at the relay (${String(apiBase).slice(0, 120)}); the evidence binds the VM's transport key${keyFact ? ` ${keyFact[1].slice(0, 23)}…` : ""}${v4 ? " and the app's TLS key" : ""}`]);

    if (failures.length || !result || !result.ok || checkOrder.some((k) => checks[k] !== true)) {
      const reasons = failures.length ? [...new Set(failures)] : ["a check did not hold"];
      // the headline is the rules' own refusal when they refused, else the first comparison that failed
      if (result && !result.ok) { const h = result.reasons.at(-1); reasons.splice(reasons.indexOf(h), 1); reasons.push(h); }
      return verdict("rejected", { checkOrder, checks, omissions, reasons, summary: `Not verified: ${reasons.at(-1)}` });
    }
    const status = omissions.length ? "limited" : "verified";
    const code = avf.component.codeHash.slice(0, 16), keySha = keyFact[1].slice(7, 23);
    const summary = `A genuine Android protected VM (certified through Google's attestation root, not debuggable) running ${pin.codeHashes ? "a release you pinned" : "a release on the relay operator's list"} `
      + `(code hash ${code}…, runtime ${rt.name} ${rt.version}) answered this page's nonce for app ${appId.slice(0, 16)}…${pinnedApp ? "" : " (the app the evidence names)"}, `
      + `and its transport key sha256:${keySha}… is the one the relay attached as ${name}${status === "limited" ? "; limited: what to expect was not independent of the operator or the box" : ""}.`;
    return verdict(status, { checkOrder, checks, omissions, reasons: [], summary });
  } catch (e) {
    return error(`verifier: ${e && e.message ? e.message : String(e)}`);
  }
}
