// verifier/web/shield-host.mjs: an Enclave Shield host (the NucBox "hv-node": a Windows Hyper-V host attested by its TPM),
// verified IN THIS BROWSER, with the credential minted here so the relay cannot stand in for the TPM.
//
// The rules are relay/hvnode-core.mjs hvNodeChecks, the same code the relay runs (relay/hvnode-verify.mjs has what a pass
// proves and does not): production only, no dev tier, fail closed, PCR 0 recorded but unpinned. This module answers its
// crypto requests with WebCrypto (RSASSA-PKCS1-v1_5 for the quote and the EK chain's RSA links, ECDSA for EC links),
// @noble/curves (Ed25519, strict RFC 8032) and @noble/hashes (SHA-256), and walks the EK chain with
// verifier/web/tpm-certs.mjs against the roots embedded there.
//
// The flow (verifyShieldHostWith), two requests because THIS PAGE mints the credential:
//   1. POST <api>/v1/enclaves/<name>/attestation { nonce }: 32 bytes this page drew. The relay challenges the host with it
//      and answers { mode: "hv-node", session, nonce, keys: { ek, ekChain, aikPub, aikName } } (the host's vbs-keys frame).
//   2. The page checks the keys (aikName == 0x000B || sha256(aikPub), a restricted signing key, an RSA EK certificate),
//      draws its OWN 32-byte credential, runs TPM2_MakeCredential for (EK, aikName) itself (tpm-credential.mjs) and POSTs
//      { session, credentialBlob, secret } to <api>/v1/enclaves/<name>/attestation/credential. The relay relays the blob;
//      only the TPM holding that EK can open it, and only for the key with that name. The answer is the host's
//      "windows-hv-node/v1" document, verified with nonce = ours, transportKeySpki = document.transportKey,
//      expectedCredential = ours, mintedFor = the step-1 EK and aikName.
// The relay is trusted for nothing here: it can withhold or delay an answer, not forge one. The TLS of the request ends at
// the relay; the key the evidence binds is the host's transport key, which the facts name.
//
// What a pass is: at most "limited", never "verified". Enclave Shield keeps the host OS out of each app's VBS-isolated
// partition by Microsoft's hypervisor, which (with the paravisor and physical access) stays trusted; that the host cannot read
// a partition is not evidenced by us (HVNODE_SCOPE, hostExcluded false), and PCR 0 has no independent pin. Both are stated
// omissions on every verdict the checks reach.
import { sha256 as nobleSha256 } from "@noble/hashes/sha2";
import { ed25519 } from "@noble/curves/ed25519";
import { hvNodeChecks, runAsync, HVNODE_FORMAT, HVNODE_TECHNOLOGY } from "../../relay/hvnode-core.mjs";
import { tcgLogWith, parseTcgLog } from "../../relay/vbs-tcglog-core.mjs";
import { parseTpmtPublic, tpmNameWith, tpmManufacturerOf, AIK_REQUIRED_ATTRIBUTES, TPMA_DECRYPT, TPM_ALG_SHA256, TPM_ALG_RSASSA, TPM_MANUFACTURERS_ON_DIE,
         VBS_MAX_CERT_BYTES, VBS_MAX_CHAIN_CERTS, VBS_MAX_TPMT_PUBLIC_BYTES } from "../../relay/vbs-tpm.mjs";
import { parseTpmCertificate, loadTpmRootsWeb, verifyEkChainWeb, TPM_EK_ROOTS_PEM, TPM_EK_ROOT_PINS } from "./tpm-certs.mjs";
import { makeCredentialWeb } from "./tpm-credential.mjs";
import { base64ToBytes } from "./x509.mjs";

export { TPM_EK_ROOTS_PEM, TPM_EK_ROOT_PINS } from "./tpm-certs.mjs";
export { makeCredentialWeb } from "./tpm-credential.mjs";

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const asBuffer = (x) => (x instanceof Uint8Array && !Buffer.isBuffer(x) ? Buffer.from(x.buffer, x.byteOffset, x.byteLength) : x);
const sha256 = (...parts) => { const h = nobleSha256.create(); for (const p of parts) h.update(p); return Buffer.from(h.digest()); };
const ENV = Object.freeze({ sha256, tcg: tcgLogWith((b) => sha256(b)) });
const b64url = (b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unsigned = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); };
const subtle = () => { const s = globalThis.crypto && globalThis.crypto.subtle; if (!s) throw new Error("WebCrypto (crypto.subtle) is not available"); return s; };

// hvNodeChecks' crypto requests, answered in the browser (relay/hvnode-verify.mjs NODE_OPS answers them with node:crypto)
export const WEB_OPS = Object.freeze({
  cert: ({ der }) => parseTpmCertificate(new Uint8Array(der.buffer, der.byteOffset, der.byteLength)),
  chain: ({ leaf, extra, trust, now }) => verifyEkChainWeb(leaf, extra, trust, now),
  rsaKey: ({ modulus, exponent }) => {
    const e = unsigned(new Uint8Array([(exponent >>> 24) & 0xff, (exponent >>> 16) & 0xff, (exponent >>> 8) & 0xff, exponent & 0xff]));
    return subtle().importKey("jwk", { kty: "RSA", n: b64url(unsigned(modulus)), e: b64url(e) }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  },
  rsaPkcs1Sha256: ({ key, data, sig }) => subtle().verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, data),
  ed25519: ({ spki, data, sig }) => ed25519.verify(sig, data, spki.subarray(12), { zip215: false }),
});

// policy: { ekRoots: PEM bundle | [DER], ekRootPins?: [sha256], now? }, read exactly as relay/hvnode-verify.mjs reads it
async function normalizePolicyWeb(policy = {}) {
  const trust = policy.ekRoots ? await loadTpmRootsWeb(policy.ekRoots) : { roots: [], intermediates: [], pins: [] };
  if (Array.isArray(policy.ekRootPins) && policy.ekRootPins.length) { const pins = new Set(policy.ekRootPins.map((p) => String(p).toLowerCase())); trust.pins = trust.pins.filter((p) => pins.has(p)); }
  return { trust, now: policy.now || Date.now() };
}

// verifyHvNodeEvidenceWeb(input, policy) -> the result relay/hvnode-verify.mjs verifyHvNodeEvidence gives for the same input
// and policy (same checks, names, order and verdict); byte inputs may be Uint8Array or Buffer. `ops` overrides one answer
// (the flow below records the chain's root through it).
export async function verifyHvNodeEvidenceWeb({ evidence, nonce, transportKeySpki = null, expectedCredential = null, mintedFor = null, capture = null } = {}, policy = {}, ops = WEB_OPS) {
  const input = { evidence, nonce: asBuffer(nonce), transportKeySpki: asBuffer(transportKeySpki), expectedCredential: asBuffer(expectedCredential),
                  mintedFor: mintedFor ? { ekCert: asBuffer(mintedFor.ekCert), aikName: asBuffer(mintedFor.aikName) } : mintedFor,
                  capture: capture ? { quoteExtraData: asBuffer(capture.quoteExtraData) } : capture };
  return runAsync(hvNodeChecks(input, await normalizePolicyWeb(policy), ENV), ops);
}

// ---- the verdict the site renders ---------------------------------------------------------------------------------------
// Each key groups the relay's numbered checks (first pattern wins); its value is false when any of them failed, true when
// all of them ran and passed, undefined when none ran.
export const SHIELD_CHECKS = Object.freeze([
  ["ek-chain", /^1 ek: (certificate and chain parse|chains to a pinned TPM root)/, "TPM endorsement key certificate → AMD/Intel TPM root (pinned in this page's verifier)"],
  ["ek-on-die", /^1 ek: on-die/, "an on-die firmware TPM (the certificate names AMD or Intel as the TPM's manufacturer)"],
  ["aik", /^2 aik: (TPMT_PUBLIC|attributes)/, "the quoting key is a TPM-bound restricted signing key (fixedTPM, restricted, sign-only, RSASSA-SHA256) and the name the host gave is its name"],
  ["minted-for", /minted for$/, "the evidence uses the endorsement key and quoting key this page minted its credential for"],
  ["credential", /^3 credential/, "quoting key lives in that TPM (it recovered the credential this page minted)"],
  ["quote", /^4 quote: (TPMS_ATTEST|signature)/, "a TPM quote signed by that quoting key"],
  ["nonce", /^4 quote: extraData/, "the quote answers this page's nonce (and covers the host's transport key and statement)"],
  ["pcrs", /^4 quote: PCR/, "the measured-boot log is what the TPM measured (PCRs 7, 12, 13, 14 replayed, with PCR 0, to the quoted digest)"],
  ["log", /^5 log: (parses|every SIPA|PCR 12 SIPA)/, "the measured-boot log parses and every record read from it hashes to its recorded digest"],
  ["boot-state", /^5 log: /, "Secure Boot on, test signing off, VBS and HVCI running, no boot, kernel or hypervisor debugging (from the measured-boot log the TPM quoted)"],
  ["idks", /^6 idks/, "this boot's VSM identity key found in the quoted log and recorded (an app partition's report from this boot must verify under it)"],
  ["possession", /^8 /, "the host's transport key signed this page's transcript (Ed25519 over the nonce, the key and the statement)"],
].map(([key, re, label]) => Object.freeze({ key, re, label })));
export const SHIELD_CHECK_ORDER = Object.freeze(SHIELD_CHECKS.map((c) => c.key));
export const SHIELD_CHECK_LABELS = Object.freeze(Object.fromEntries(SHIELD_CHECKS.map((c) => [c.key, c.label])));
export const SHIELD_OMISSION_LABELS = Object.freeze({
  "platform-firmware-unpinned": "The platform firmware measurement (PCR 0) is quoted and shown, but nothing independent pins it: there is no published value for this machine's firmware to compare it with.",
  "host-exclusion-unevidenced": "Each app here runs in its own VBS-isolated partition, which Microsoft's hypervisor keeps the host OS out of. That hypervisor, the paravisor and anyone with physical access to the machine remain trusted (VBS does not encrypt memory in hardware), and this page has no evidence of its own that the host cannot read a partition's memory. This check covers the host's boot, not an app's partition.",
});
export const SHIELD_FRESH_PATH = (name) => `/v1/enclaves/${encodeURIComponent(name)}/attestation`;
export const SHIELD_CREDENTIAL_PATH = (name) => `${SHIELD_FRESH_PATH(name)}/credential`;
const NAME = /^[A-Za-z0-9_-]{1,64}$/, SESSION = /^[\x21-\x7e]{1,1024}$/;
const MAX_KEYS_ANSWER = 256 * 1024, MAX_DOCUMENT_ANSWER = 16 * 1024 * 1024;
const b64cap = (cap) => 4 * Math.ceil(cap / 3) + 4;
const b64field = (v, cap, what) => { if (typeof v !== "string" || !v.length || v.length > b64cap(cap)) throw new Error(`${what} missing or oversized`); const b = base64ToBytes(v); if (!b.length || b.length > cap) throw new Error(`${what} missing or oversized`); return b; };

export function groupChecks(engineChecks) {
  const out = Object.fromEntries(SHIELD_CHECK_ORDER.map((k) => [k, undefined]));
  const groups = new Map(SHIELD_CHECK_ORDER.map((k) => [k, []]));
  for (const c of engineChecks || []) { const g = SHIELD_CHECKS.find((x) => x.re.test(c.name)); if (g) groups.get(g.key).push(c); }
  for (const [k, cs] of groups) if (cs.some((c) => !c.ok && !c.skipped)) out[k] = false; else if (cs.length && cs.every((c) => c.ok)) out[k] = true;
  return out;
}

// deps: { fetchImpl, randomBytes(n) -> Uint8Array, now() -> Date, ekRoots? (default TPM_EK_ROOTS_PEM), ekRootPins? (default
// TPM_EK_ROOT_PINS) }. randomBytes is called three times, in order: the nonce, the credential, the MakeCredential seed.
export async function verifyShieldHostWith(deps, opts = {}) { return (await verifyShieldHostSessionWith(deps, opts)).verdict; }

// verifyShieldHostSessionWith(deps, opts) -> { verdict, session }: the same verdict, and on a "limited" pass (only then) what
// an app check of this boot needs from it (verifier/web/shield-app.mjs): session = { idks: { modulus, exponent, bits }, the
// VSM identity key read from the SAME log the checks above authenticated (its modulus' sha256 equal to the one they
// recorded), and boot: the verified boot record ({ ekCertSha256, pcr0, ... }) }. session is null on anything but a pass.
export async function verifyShieldHostSessionWith(deps, opts = {}) {
  const out = { verdict: null, session: null };
  out.verdict = await shieldHost(deps, opts, out);
  if (out.verdict.status !== "limited") out.session = null;
  return out;
}

async function shieldHost(deps, { apiBase = "https://api.enclave.host", name, timeoutMs = 45000 } = {}, out) {
  const checks = Object.fromEntries(SHIELD_CHECK_ORDER.map((k) => [k, undefined]));
  const facts = [["Box", typeof name === "string" ? name : "(none)"]];
  let omissions = [], reasons = [];
  const verdict = (status, summary) => ({ status, technology: HVNODE_TECHNOLOGY, name: name ?? null, checkOrder: [...SHIELD_CHECK_ORDER], checkLabels: { ...SHIELD_CHECK_LABELS },
                                          checks, omissions, omissionLabels: Object.fromEntries(omissions.map((o) => [o, SHIELD_OMISSION_LABELS[o] || o])), reasons, summary, facts });
  const error = (why) => { reasons = [...reasons, why]; return verdict("error", `This Enclave Shield host could not be verified (${why}); that is not a verdict on the host.`); };
  const refuse = (why) => { reasons = [...reasons, why]; return verdict("rejected", `This Enclave Shield host's evidence was refused (${why}); nothing about its boot state is established.`); };
  try {
    if (typeof name !== "string" || !NAME.test(name)) return error("no host name (an attached Enclave Shield host's name, e.g. nucbox-k11-4)");
    const deadline = Date.now() + timeoutMs;
    const fetchImpl = deps.fetchImpl;   // called unbound: a browser's fetch refuses any other `this` ("Illegal invocation")
    const post = async (url, payload, cap) => {
      const left = deadline - Date.now(); if (left <= 0) throw new Error(`no answer within ${timeoutMs} ms`);
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), left);
      try {
        let r;
        try { r = await fetchImpl(url, { method: "POST", body: JSON.stringify(payload), signal: ctrl.signal, redirect: "error", credentials: "omit", headers: { "content-type": "application/json", accept: "application/json" } }); }
        catch (e) { throw new Error(e && e.name === "AbortError" ? `no answer within ${timeoutMs} ms` : e.message); }
        const text = await r.text();
        if (text.length > cap) throw new Error(`the answer exceeds ${cap} bytes`);
        let body; try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}: the answer is not JSON`); }
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${body?.message || body?.error || "no answer"}`);
        if (!body || typeof body !== "object") throw new Error("the answer is not a JSON object");
        return body;
      } finally { clearTimeout(t); }
    };

    // ---- 1. the challenge: our nonce, the host's keys
    const nonce = Uint8Array.from(deps.randomBytes(32)), nonceHex = toHex(nonce);
    facts.push(["Nonce (drawn by this page)", `${nonceHex.slice(0, 32)}…`]);
    let one;
    try { one = await post(`${apiBase}${SHIELD_FRESH_PATH(name)}`, { nonce: nonceHex }, MAX_KEYS_ANSWER); }
    catch (e) { return error(`fresh attestation of ${name}: ${e.message}`); }
    if (one.mode !== "hv-node") return error(`${name} is not an Enclave Shield host (mode ${JSON.stringify(one.mode ?? null)})`);
    if (one.nonce !== nonceHex) return refuse("the relay answered for another nonce");
    if (typeof one.session !== "string" || !SESSION.test(one.session)) return error("the relay's answer carries no usable session");
    const keys = one.keys && typeof one.keys === "object" ? one.keys : {};

    // ---- 2. the keys, before anything is minted for them
    let ekDer, ek, aikName;
    try {
      ekDer = b64field(keys.ek, VBS_MAX_CERT_BYTES, "keys.ek");
      if (keys.ekChain != null && (!Array.isArray(keys.ekChain) || keys.ekChain.length > VBS_MAX_CHAIN_CERTS)) throw new Error("keys.ekChain malformed");
      for (const c of keys.ekChain || []) b64field(c, VBS_MAX_CERT_BYTES, "keys.ekChain entry");
      ek = parseTpmCertificate(ekDer);
    } catch (e) { checks["ek-chain"] = false; return refuse(`the host's EK certificate: ${e.message}`); }
    let mfr = null; try { mfr = tpmManufacturerOf(asBuffer(ekDer)); } catch { mfr = null; }
    facts.push(["TPM manufacturer", mfr ? `${TPM_MANUFACTURERS_ON_DIE[mfr] || "not an on-die AMD/Intel TPM"} (id:${mfr})` : "(not stated in the EK certificate)"],
               ["EK certificate subject", ek.subject || "(empty)"], ["EK certificate issuer", ek.issuer || "(empty)"], ["EK certificate serial", ek.serialHex], ["EK certificate sha256", ek.fp256]);
    if (ek.key.type !== "rsa") { checks.credential = false; return refuse(`the EK is not an RSA key (${ek.key.type}): no credential can be minted for it`); }
    try {
      const aikPub = asBuffer(b64field(keys.aikPub, VBS_MAX_TPMT_PUBLIC_BYTES, "keys.aikPub"));
      aikName = b64field(keys.aikName, 64, "keys.aikName");
      const aik = parseTpmtPublic(aikPub);
      if (aik.nameAlg !== TPM_ALG_SHA256) throw new Error("quoting key nameAlg is not SHA-256");
      if (aik.scheme.alg !== TPM_ALG_RSASSA || aik.scheme.hash !== TPM_ALG_SHA256) throw new Error("quoting key scheme is not RSASSA/SHA-256");
      if ((aik.attributes & AIK_REQUIRED_ATTRIBUTES) !== AIK_REQUIRED_ATTRIBUTES || (aik.attributes & TPMA_DECRYPT)) throw new Error(`quoting key attributes 0x${aik.attributes.toString(16).padStart(8, "0")} are not fixedTPM|fixedParent|sensitiveDataOrigin|restricted|sign without decrypt`);
      const want = tpmNameWith(sha256, aikPub);
      if (aikName.length !== want.length || !want.equals(asBuffer(aikName))) throw new Error("aikName is not 0x000B || sha256(aikPub)");
      facts.push(["Quoting key name", toHex(aikName)]);
    } catch (e) { checks.aik = false; return refuse(`the host's quoting key: ${e.message}`); }

    // ---- 3. our credential, minted here, relayed; the host's document back
    const credential = Uint8Array.from(deps.randomBytes(32)), seed = Uint8Array.from(deps.randomBytes(32));
    let blob;
    try { blob = await makeCredentialWeb(ek.spki, aikName, credential, seed); }
    catch (e) { checks.credential = false; return refuse(`MakeCredential for the host's EK: ${e.message}`); }
    const b64 = (u) => { let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
    let two;
    try { two = await post(`${apiBase}${SHIELD_CREDENTIAL_PATH(name)}`, { session: one.session, credentialBlob: b64(blob.credentialBlob), secret: b64(blob.secret) }, MAX_DOCUMENT_ANSWER); }
    catch (e) { return error(`credential round for ${name}: ${e.message}`); }
    if (two.nonce != null && two.nonce !== nonceHex) return refuse("the relay answered for another nonce");
    if (typeof two.fetchedAt === "string" && two.fetchedAt.length <= 64) facts.push(["Fetched at", two.fetchedAt]);
    const doc = two.document;
    if (!doc || typeof doc !== "object") return error(`${name} returned no document`);
    if (doc.format !== HVNODE_FORMAT) return refuse(`the host's document is ${JSON.stringify(doc.format ?? null)}, not ${HVNODE_FORMAT}`);
    let evidence, spki;
    try {
      if (typeof doc.body !== "string" || doc.body.length > MAX_DOCUMENT_ANSWER) throw new Error("document.body missing or oversized");
      evidence = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(doc.body)));
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("the evidence is not a JSON object");
      if (typeof doc.transportKey !== "string" || doc.transportKey.length > 128) throw new Error("document.transportKey missing or oversized");
      spki = base64ToBytes(doc.transportKey);
    } catch (e) { return refuse(`the host's document: ${e.message}`); }
    facts.push(["Transport key sha256", toHex(sha256(spki))]);

    // ---- 4. the relay's own rules, in this page
    let root = null;
    const ops = { ...WEB_OPS, chain: async (r) => { const v = await WEB_OPS.chain(r); if (v.ok) root = v.root; return v; } };
    const v = await verifyHvNodeEvidenceWeb({ evidence, nonce, transportKeySpki: spki, expectedCredential: credential, mintedFor: { ekCert: ekDer, aikName } },
                                            { ekRoots: deps.ekRoots ?? TPM_EK_ROOTS_PEM, ekRootPins: deps.ekRootPins ?? TPM_EK_ROOT_PINS, now: (deps.now ? deps.now() : new Date()).getTime() }, ops);
    Object.assign(checks, groupChecks(v.checks));
    omissions = [...v.omissions, "host-exclusion-unevidenced"];
    if (root) facts.push(["EK root (pinned)", `${root.subject.split(", ").filter((p) => p.startsWith("CN=")).join(", ") || root.subject} sha256:${root.fp256}`]);
    if (!v.ok) { reasons = [...v.reasons]; return verdict("rejected", `This Enclave Shield host's evidence was refused (${v.reasons[0]}); nothing about its boot state is established.`); }
    const b = v.boot;
    facts.push(["PCR 0 (platform firmware, unpinned)", b.pcr0 ?? "(none)"]);
    if (b.bootCounter != null) facts.push(["Boot counter (measured-boot log)", String(b.bootCounter)]);
    if (b.resetCount != null) facts.push(["TPM reset count (quote)", String(b.resetCount)]);
    facts.push(["IDKS modulus sha256", b.idksModulusSha256]);
    // the key itself, for an app check of this boot: from the log just authenticated, never from anything else
    try {
      const k = ENV.tcg.vsmKey(parseTcgLog(Buffer.from(evidence.log, "base64")).events, "IDKS");
      if (k && toHex(sha256(k.modulus)) === b.idksModulusSha256) out.session = { idks: { modulus: Buffer.from(k.modulus), exponent: Buffer.from(k.exponent), bits: k.bits }, boot: b };
    } catch { out.session = null; }
    reasons = [...omissions.map((o) => `OMITTED (${o}): ${SHIELD_OMISSION_LABELS[o] || o}`), ...v.warnings.map((w) => `WARNING: ${w}`)];
    return verdict("limited", "This Enclave Shield host's genuine on-die TPM (its endorsement key chained to a root pinned in this page) recovered the credential this page minted and quoted, "
      + "for this page's nonce, a measured boot with Secure Boot on, test signing off and VBS/HVCI running, and the host's transport key signed the same transcript; "
      + "apps here run in VBS-isolated partitions that Microsoft's hypervisor keeps the host OS out of, though that hypervisor and physical access stay trusted, "
      + "this page has no evidence of its own that the host cannot read them, and the firmware measurement (PCR 0) is not pinned.");
  } catch (e) { return error(`verifier: ${e && e.message ? e.message : String(e)}`); }
}
