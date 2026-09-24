// pvm-verify.js -- a BROWSER's verification of a pVM app's evidence (PVM-CPU.md, "The browser channel"; LAB, not
// production). The same checks as relay/pvm-app-attest.mjs verifyPvmAppEvidence, written against WebCrypto alone (no
// node:crypto, no Buffer, no dependency), so a page verifies the VM itself before it encrypts a request to it:
//   - a closed envelope (enclave-pvm-app-evidence/v1 or /v2), every field at its exact form, an unknown field refused;
//   - the envelope's nonce and app are COMPARED with the caller's, never used: the challenge is recomputed from the
//     caller's nonce, the caller's expected app, the stated runtime identity and the stated transport key;
//   - the AVF chain: leaf first (as the VM sends it; stricter than the node verifier, which reorders), each link issued
//     by the next (names byte-equal, signature, validity, CA and keyCertSign where they apply), the root pinned by the
//     caller's SHA-256 pins -- by default Google's two attestation roots;
//   - the leaf's AVF extension: the challenge equals Bind2(spki, nonce, RuntimeID) || AppID, a secure VM, the pinned
//     code hash signed by the pinned authority;
//   - the runtime identity and self-test tuple under the isolation contract's rules;
//   - v2: appKey (X25519) is vouched for by an Ed25519 signature of the ATTESTED transport key over
//     "enclave-pvm-app-key-v1\n" || nonce || AppID || appKey; only then is appKey returned.
//   - v3 (INSTANCE-BINDING.md, agreed with the verifier session): the VM INSTANCE is inside the attested challenge,
//     Bind3(spki, nonce, RuntimeID, InstanceID) || AppID with InstanceID = SHA-256(instanceKey); instanceSig is the instance
//     key's signature over that challenge; appKeySig covers the InstanceID under "enclave-pvm-app-key-v2\n". With
//     expect.instanceIds (a deployment bound to instances by the signed policy), only v3 evidence for a listed instance
//     verifies: v1/v2 are refused as a downgrade by name, before any certificate.
// A browser without Ed25519 or X25519 in SubtleCrypto is refused, never served a fallback.
//   verifyPvmAppEvidence(envelope, { nonce, appId, allowedRuntimeIds, allowedCodeHashes, allowedAuthorityHashes,
//                                    rootPins?, now?, instanceIds? }) -> Promise<{ ok, reasons, transportSpki, runtimeId,
//                                    measurement, freshness, appId, appKey, sealedWindowSeconds, sealedMaxRequests,
//                                    instanceId, instanceKey }>

export const PVM_APP_EVIDENCE_FORMAT = "enclave-pvm-app-evidence/v1";
export const PVM_APP_EVIDENCE_FORMAT_V2 = "enclave-pvm-app-evidence/v2";
export const PVM_APP_EVIDENCE_FORMAT_V3 = "enclave-pvm-app-evidence/v3";
export const APP_KEY_DOMAIN = "enclave-pvm-app-key-v1\n";
export const APP_KEY_DOMAIN_V3 = "enclave-pvm-app-key-v2\n";
export const BIND2_DOMAIN = "enclave-bind-v2\n";
export const BIND3_DOMAIN = "enclave-bind-v3-instance\n";
export const INSTANCE_SIG_DOMAIN = "enclave-pvm-instance-sig-v1\n";
// v2's sealed-request window, a constant of the format (the VM enforces it; payload/anchor_payload.c + pvm-rt sealed.rs)
export const SEALED_WINDOW_SECONDS = 600, SEALED_MAX_REQUESTS = 256;
export const AVF_ATTESTATION_EXTENSION_OID = "1.3.6.1.4.1.11129.2.1.29.1";
// the same pins as relay/avf-verify.mjs GOOGLE_ATTESTATION_ROOT_SHA256 (test/pvm-web-verify.test.mjs asserts they agree)
export const GOOGLE_ATTESTATION_ROOT_SHA256 = [
  "cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", // google-hardware-attestation-root-2022
  "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0", // google-key-attestation-ca1-2025
];
const MAX_CERT = 64 * 1024, MAX_CHAIN = 8, MAX_COMPONENTS = 256;
const FIELDS = ["name", "version", "execution", "targetIsa", "hostIsa", "cpuFeatures", "wx", "cache"];
const KEYS_V1 = ["app", "chain", "format", "identity", "nonce", "selftest", "spki"];
const KEYS_V2 = ["app", "appKey", "appKeySig", "chain", "format", "identity", "nonce", "selftest", "spki"];
const KEYS_V3 = ["app", "appKey", "appKeySig", "chain", "format", "identity", "instanceKey", "instanceSig", "nonce", "selftest", "spki"];
const ED25519_SPKI = /^302a300506032b6570032100[0-9a-f]{64}$/;

const te = new TextEncoder();
export const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
export function fromHex(s) {
  if (typeof s !== "string" || s.length % 2 || !/^[0-9a-f]*$/.test(s)) throw new Error("not lowercase hex");
  const o = new Uint8Array(s.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return o;
}
export const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function b64(s) {   // canonical base64 only (the caller already held it to the grammar)
  const bin = atob(s), o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}
function b64enc(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }
function subtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error("no SubtleCrypto here (a page must be a secure context: https, or http://127.0.0.1 in the lab)");
  return s;
}
export const sha256 = async (d) => new Uint8Array(await subtle().digest("SHA-256", d));

/** Resolves when this browser has Ed25519 and X25519 in SubtleCrypto; rejects otherwise (no fallback). */
let caps = null;
export function requireCurves() {
  caps ||= (async () => {
    try { await subtle().importKey("raw", new Uint8Array(32).fill(9), { name: "X25519" }, false, []); }
    catch (e) { throw new Error(`this browser's SubtleCrypto has no X25519 (${e.name}): refusing, no fallback`); }
    try { await subtle().importKey("spki", fromHex("302a300506032b6570032100" + "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"), { name: "Ed25519" }, false, ["verify"]); }
    catch (e) { throw new Error(`this browser's SubtleCrypto has no Ed25519 (${e.name}): refusing, no fallback`); }
  })();
  return caps;
}

// ---- DER, the same walker and caps as relay/avf-verify.mjs (ITU-T X.690) ----
function tlv(b, off, limit = b.length) {
  if (!Number.isSafeInteger(off) || !Number.isSafeInteger(limit) || off < 0 || limit > b.length || off > limit - 2) throw new Error("DER truncated");
  const tag = b[off]; let len = b[off + 1], p = off + 2;
  if (!tag || (tag & 0x1f) === 0x1f) throw new Error("unsupported DER tag");
  if (len & 0x80) {
    const n = len & 0x7f;
    if (!n || n > 4 || n > limit - p) throw new Error("invalid DER length");
    if (!b[p]) throw new Error("nonminimal DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
    if (len < 128) throw new Error("nonminimal DER length");
  }
  if (len > limit - p) throw new Error("DER element overruns parent");
  return { tag, off, start: p, end: p + len, next: p + len };
}
function children(b, node, cap = 2048) {
  if (!node || !(node.tag & 0x20)) throw new Error("DER parent is not constructed");
  const out = []; let p = node.start;
  while (p < node.end) { if (out.length >= cap) throw new Error("too many DER children"); const c = tlv(b, p, node.end); out.push(c); p = c.next; }
  return out;
}
const body = (b, n) => b.subarray(n.start, n.end);
const whole = (b, n) => b.subarray(n.off, n.end);
function oidOf(b, n) {
  if (n.tag !== 0x06) throw new Error("not a DER OID");
  const v = body(b, n);
  if (!v.length || v.length > 64) throw new Error("invalid DER OID length");
  const parts = []; let acc = 0n, first = true;
  for (const o of v) {
    if (first && o === 0x80) throw new Error("nonminimal DER OID");
    acc = acc * 128n + BigInt(o & 0x7f); first = false;
    if (!(o & 0x80)) { parts.push(acc); acc = 0n; first = true; }
  }
  if (!first) throw new Error("truncated DER OID");
  const c = parts.shift(), head = c < 40n ? 0n : c < 80n ? 1n : 2n;
  return [head, c - head * 40n, ...parts].join(".");
}
function boolOf(b, n) {
  const v = body(b, n);
  if (n.tag !== 0x01 || v.length !== 1 || (v[0] !== 0 && v[0] !== 0xff)) throw new Error("invalid DER BOOLEAN");
  return v[0] === 0xff;
}
function uintOf(b, n, what) {
  const v = body(b, n);
  if (n.tag !== 0x02 || !v.length || v.length > 32 || (v[0] & 0x80) || (v.length > 1 && v[0] === 0 && !(v[1] & 0x80)))
    throw new Error(`${what} is not a bounded nonnegative DER INTEGER`);
  let x = 0n; for (const o of v) x = (x << 8n) | BigInt(o); return x;
}
function timeOf(b, n) {   // UTCTime YYMMDDHHMMSSZ / GeneralizedTime YYYYMMDDHHMMSSZ (RFC 5280 4.1.2.5)
  const s = new TextDecoder().decode(body(b, n));
  const m = n.tag === 0x17 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s) : n.tag === 0x18 ? /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s) : null;
  if (!m) throw new Error("certificate validity is not a UTCTime or GeneralizedTime in Z");
  let y = +m[1]; if (n.tag === 0x17) y += y >= 50 ? 1900 : 2000;
  return Date.UTC(y, +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// ---- X.509, just what a chain check needs ----
const SIG_ALGS = {
  "1.2.840.10045.4.3.2": { kind: "ECDSA", hash: "SHA-256" }, "1.2.840.10045.4.3.3": { kind: "ECDSA", hash: "SHA-384" },
  "1.2.840.10045.4.3.4": { kind: "ECDSA", hash: "SHA-512" },
  "1.2.840.113549.1.1.11": { kind: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, "1.2.840.113549.1.1.12": { kind: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
  "1.2.840.113549.1.1.13": { kind: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
};
const CURVES = { "1.2.840.10045.3.1.7": ["P-256", 32], "1.3.132.0.34": ["P-384", 48], "1.3.132.0.35": ["P-521", 66] };
export function parseCert(der) {
  if (der.length > MAX_CERT) throw new Error("certificate exceeds size limit");
  const top = tlv(der, 0);
  if (top.tag !== 0x30 || top.end !== der.length) throw new Error("not an exact DER certificate");
  const f = children(der, top, 3);
  if (f.length !== 3 || f[0].tag !== 0x30 || f[1].tag !== 0x30 || f[2].tag !== 0x03) throw new Error("certificate fields malformed");
  const [tbs, alg, sigv] = f;
  const t = children(der, tbs); let i = 0;
  if (t[i]?.tag !== 0xa0) throw new Error("not an X.509 v3 certificate");
  const ver = children(der, t[i++], 1)[0];
  if (!ver || uintOf(der, ver, "version") !== 2n) throw new Error("not an X.509 v3 certificate");
  if (t[i++]?.tag !== 0x02) throw new Error("serial number missing");
  const innerAlg = t[i++], issuer = t[i++], validity = t[i++], subject = t[i++], spki = t[i++];
  if (!innerAlg || innerAlg.tag !== 0x30 || !same(whole(der, innerAlg), whole(der, alg))) throw new Error("the signature algorithm inside and outside the certificate differ");
  if (!issuer || issuer.tag !== 0x30 || !subject || subject.tag !== 0x30 || !spki || spki.tag !== 0x30 || !validity || validity.tag !== 0x30) throw new Error("certificate body malformed");
  const [nb, na] = children(der, validity, 2);
  if (!nb || !na) throw new Error("certificate validity malformed");
  const algOid = oidOf(der, children(der, alg)[0]);
  const sigBits = body(der, sigv);
  if (!sigBits.length || sigBits[0] !== 0) throw new Error("signature BIT STRING has unused bits");
  // the key: its algorithm and, for EC, its curve
  const [kalg] = children(der, spki, 2), kparts = children(der, kalg, 2), koid = oidOf(der, kparts[0]);
  const key = koid === "1.2.840.10045.2.1" ? { kind: "EC", curve: CURVES[kparts[1] && kparts[1].tag === 0x06 ? oidOf(der, kparts[1]) : ""] }
    : koid === "1.2.840.113549.1.1.1" ? { kind: "RSA" } : koid === "1.3.101.112" ? { kind: "Ed25519" } : { kind: "unknown", oid: koid };
  // extensions: basicConstraints (CA), keyUsage (keyCertSign), and the raw values by OID
  const ext = new Map(); let ca = false, keyUsage = null;
  for (; i < t.length; i++) {
    if (t[i].tag !== 0xa3) continue;
    if (ext.size) throw new Error("duplicate extension containers");
    const seq = children(der, t[i], 1)[0];
    if (!seq || seq.tag !== 0x30) throw new Error("extensions are not a SEQUENCE");
    for (const e of children(der, seq)) {
      if (e.tag !== 0x30) throw new Error("extension is not a SEQUENCE");
      const p = children(der, e, 3);
      if (p.length < 2 || p[0].tag !== 0x06) throw new Error("extension fields malformed");
      if (p.length === 3 && !boolOf(der, p[1])) throw new Error("DER default critical=false must be omitted");
      const id = oidOf(der, p[0]), val = p[p.length - 1];
      if (ext.has(id)) throw new Error("duplicate certificate extension");
      if (val.tag !== 0x04) throw new Error("extension value is not an OCTET STRING");
      ext.set(id, body(der, val));
    }
  }
  if (ext.has("2.5.29.19")) {
    const v = ext.get("2.5.29.19"), s = tlv(v, 0);
    if (s.tag !== 0x30 || s.end !== v.length) throw new Error("basicConstraints malformed");
    const c = children(v, s, 2);
    if (c[0] && c[0].tag === 0x01) ca = boolOf(v, c[0]);
  }
  if (ext.has("2.5.29.15")) {
    const v = ext.get("2.5.29.15"), s = tlv(v, 0);
    if (s.tag !== 0x03 || s.end !== v.length || s.end - s.start < 2) throw new Error("keyUsage malformed");
    keyUsage = v.subarray(s.start + 1, s.end);
  }
  return { der, tbs: whole(der, tbs), sigAlg: SIG_ALGS[algOid] || { kind: "unknown", oid: algOid }, signature: sigBits.subarray(1),
           issuer: whole(der, issuer), subject: whole(der, subject), spki: whole(der, spki), key,
           notBefore: timeOf(der, nb), notAfter: timeOf(der, na), ca, keyUsage, ext };
}
function ecdsaRaw(sig, n) {   // DER ECDSA-Sig-Value -> r || s, each n bytes (WebCrypto's form)
  const s = tlv(sig, 0);
  if (s.tag !== 0x30 || s.end !== sig.length) throw new Error("ECDSA signature malformed");
  const rs = children(sig, s, 2);
  if (rs.length !== 2 || rs.some((x) => x.tag !== 0x02)) throw new Error("ECDSA signature malformed");
  const out = new Uint8Array(2 * n);
  rs.forEach((x, k) => {
    let v = body(sig, x); while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > n) throw new Error("ECDSA signature component too long");
    out.set(v, k * n + n - v.length);
  });
  return out;
}
async function signedBy(cert, issuer) {
  const a = cert.sigAlg, k = issuer.key;
  if (a.kind === "ECDSA" && k.kind === "EC" && k.curve) {
    const key = await subtle().importKey("spki", issuer.spki, { name: "ECDSA", namedCurve: k.curve[0] }, false, ["verify"]);
    return subtle().verify({ name: "ECDSA", hash: a.hash }, key, ecdsaRaw(cert.signature, k.curve[1]), cert.tbs);
  }
  if (a.kind === "RSASSA-PKCS1-v1_5" && k.kind === "RSA") {
    const key = await subtle().importKey("spki", issuer.spki, { name: a.kind, hash: a.hash }, false, ["verify"]);
    return subtle().verify(a.kind, key, cert.signature, cert.tbs);
  }
  throw new Error(`unsupported signature: ${a.kind}${a.oid ? " " + a.oid : ""} by a ${k.kind} key`);
}

// ---- the AVF extension (relay/avf-verify.mjs parseAvfExtension, the same accepted shapes) ----
export function parseAvfExtension(v) {
  const top = tlv(v, 0);
  if (top.tag !== 0x30 || top.end !== v.length) throw new Error("AttestationExtension is not an exact SEQUENCE");
  const f = children(v, top, 4);
  if (f.length !== 3 && f.length !== 4) throw new Error("AttestationExtension must have three fields (or four, the fourth an empty SEQUENCE)");
  if (f.length === 4 && (f[3].tag !== 0x30 || body(v, f[3]).length !== 0)) throw new Error("AttestationExtension's fourth field is not an empty SEQUENCE: unknown structure, refused");
  const [chal, secure, comps] = f;
  if (chal.tag !== 0x04) throw new Error("attestationChallenge missing");
  if (secure.tag !== 0x01) throw new Error("isVmSecure missing");
  if (comps.tag !== 0x30) throw new Error("vmComponents missing");
  const components = children(v, comps, MAX_COMPONENTS).map((c) => {
    if (c.tag !== 0x30) throw new Error("VmComponent is not a SEQUENCE");
    const g = children(v, c, 4);
    if (g.length !== 4) throw new Error("VmComponent must have four fields");
    const [name, ver, code, auth] = g;
    if (name.tag !== 0x0c || ver.tag !== 0x02 || code.tag !== 0x04 || auth.tag !== 0x04) throw new Error("VmComponent malformed");
    const nb = body(v, name);
    if (!nb.length || nb.length > 1024) throw new Error("invalid component name length");
    const nm = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(nb);
    if (/[\u0000-\u001f\u007f]/.test(nm)) throw new Error("component name contains control characters");
    return { name: nm, securityVersion: uintOf(v, ver, "securityVersion"), codeHash: toHex(body(v, code)), authorityHash: toHex(body(v, auth)) };
  });
  return { challenge: body(v, chal), isVmSecure: boolOf(v, secure), components };
}

/** The AVF chain (relay/avf-verify.mjs verifyAvfEvidence's rules, leaf first). Returns { ok, reasons, measurement }. */
export async function verifyAvfChain(chain, challenge, { allowedCodeHashes, allowedAuthorityHashes, rootPins = GOOGLE_ATTESTATION_ROOT_SHA256, now = Date.now() }) {
  const fail = (m) => ({ ok: false, reasons: [m], measurement: null });
  if (!Array.isArray(chain) || chain.length < 2) return fail(`chain must hold at least a leaf and a root, got ${chain?.length ?? 0}`);
  if (chain.length > MAX_CHAIN) return fail("attestation chain exceeds certificate-count limit");
  let c;
  try { c = chain.map(parseCert); } catch (e) { return fail(`unparseable certificate: ${e.message}`); }
  const root = c[c.length - 1];
  if (!same(root.issuer, root.subject)) return fail("root is not self-signed");
  try { if (!(await signedBy(root, root))) return fail("root is not self-signed"); } catch (e) { return fail(`root: ${e.message}`); }
  const rootFp = toHex(await sha256(root.der));
  if (![...rootPins].map((p) => String(p).toLowerCase()).includes(rootFp)) return fail(`root ${rootFp} is not a pinned Google attestation root`);
  for (let i = 0; i < c.length; i++) {
    const x = c[i], up = c[i + 1] || x;
    if (!same(x.issuer, up.subject)) return fail(`cert ${i} not issued by cert ${i + 1} (the chain must arrive leaf first)`);
    if (up.keyUsage && !(up.keyUsage[0] & 0x04)) return fail(`cert ${i + 1} may not sign certificates (keyUsage)`);
    let ok; try { ok = await signedBy(x, up); } catch (e) { return fail(`cert ${i}: ${e.message}`); }
    if (!ok) return fail(`cert ${i} signature does not verify`);
    if (!(x.notBefore <= now)) return fail(`cert ${i} not yet valid (${new Date(x.notBefore).toISOString()})`);
    if (!(now <= x.notAfter)) return fail(`cert ${i} expired (${new Date(x.notAfter).toISOString()}); RKP certificates are short-lived on purpose`);
    if (i > 0 && !x.ca) return fail(`cert ${i} is not a CA`);
  }
  const extv = c[0].ext.get(AVF_ATTESTATION_EXTENSION_OID);
  if (!extv) return fail("leaf extension: no AVF attestation extension");
  let e; try { e = parseAvfExtension(extv); } catch (x) { return fail(`leaf extension: ${x.message}`); }
  if (!challenge.length || !same(e.challenge, challenge)) return fail("attestationChallenge does not match ours");
  if (!e.isVmSecure) return fail("isVmSecure=false: a DICE link is debuggable or unverified");
  const codes = new Set([...(allowedCodeHashes || [])].map((h) => String(h).toLowerCase()));
  const auths = new Set([...(allowedAuthorityHashes || [])].map((h) => String(h).toLowerCase()));
  if (!codes.size || !auths.size) return fail("no pinned code/authority hashes: refusing (fail closed)");
  const apks = e.components.filter((k) => /apk/i.test(k.name));
  if (!apks.length) return fail("no APK component in vmComponents");
  const stranger = apks.find((k) => !auths.has(k.authorityHash));
  if (stranger) return fail(`APK component "${stranger.name}" signed by an unpinned authority ${stranger.authorityHash.slice(0, 16)}…`);
  const anchor = apks.find((k) => codes.has(k.codeHash));
  if (!anchor) return fail(`no APK component with an allowlisted codeHash (saw ${apks.map((k) => k.codeHash.slice(0, 16) + "…").join(", ")})`);
  return { ok: true, reasons: [], measurement: anchor.codeHash };
}

// ---- the runtime identity and self-test (relay/pvm-app-attest.mjs; the isolation contract's rules) ----
export function canonical(v) {
  const sort = (x) => Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x;
  return te.encode(JSON.stringify(sort(v)));
}
export function validateRuntimeIdentity(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "the runtime identity is not an object";
  for (const k of Object.keys(r)) if (!FIELDS.includes(k)) return `the runtime identity carries an unknown field ${JSON.stringify(k)}`;
  for (const k of FIELDS) if (typeof r[k] !== "string") return `the runtime identity field ${k} is missing or not a string`;
  if (r.name === "" || r.version === "") return "runtime name and version are required";
  if (r.hostIsa !== "x86_64" && r.hostIsa !== "aarch64") return `host ISA ${JSON.stringify(r.hostIsa)} is not one of x86_64, aarch64`;
  if (r.execution === "jit") { if (r.targetIsa !== r.hostIsa) return `a JIT emits the host's own ISA: target ${JSON.stringify(r.targetIsa)} must equal host ${JSON.stringify(r.hostIsa)}`; }
  else if (r.execution === "interpreter") { if (r.targetIsa !== "pulley64") return `an interpreter runs pulley64 bytecode, not ${JSON.stringify(r.targetIsa)}`; }
  else return `execution ${JSON.stringify(r.execution)} is not one of jit, interpreter`;
  if (r.cpuFeatures === "") return 'the CPU-feature policy must be stated ("baseline" if none)';
  if (r.wx !== "enforced") return "a runtime that cannot state W^X as enforced is not admissible";
  if (r.cache !== "none" && r.cache !== "authenticated") return `cache mode ${JSON.stringify(r.cache)} is not one of none, authenticated`;
  return null;
}
export function checkRuntimeSelfTest(selfTest, identity) {
  const no = (m) => ({ ok: false, reasons: [m] });
  if (typeof selfTest !== "string" || selfTest === "") return no("no runtime self-test: nothing says this domain checked W^X");
  if (selfTest.length > 300) return no("the runtime self-test is not a short string");
  const f = {};
  for (const part of selfTest.trim().split(/\s+/)) {
    const i = part.indexOf("=");
    if (i <= 0) return no(`malformed runtime self-test ${JSON.stringify(selfTest)}`);
    const k = part.slice(0, i);
    if (k in f) return no(`the runtime self-test names ${k} more than once`);
    f[k] = part.slice(i + 1);
  }
  for (const k of Object.keys(f)) if (!["exec_pages", "wx", "maps", "scope"].includes(k)) return no(`the runtime self-test carries an unknown key ${k}`);
  for (const k of ["exec_pages", "wx", "maps", "scope"]) if (!(k in f)) return no(`the runtime self-test is missing ${k}`);
  if (!/^(allowed|refused:[A-Za-z0-9]{1,16}|no-mapping:[A-Za-z0-9]{1,16})$/.test(f.exec_pages)) return no(`exec_pages=${JSON.stringify(f.exec_pages)} is not allowed | refused:<errno> | no-mapping:<errno>`);
  if (f.wx !== "clean") return no(`wx=${JSON.stringify(f.wx)}: W^X holds only when no writable-and-executable mapping was found`);
  if (!/^[1-9][0-9]{0,6}$/.test(f.maps)) return no(`maps=${JSON.stringify(f.maps)}: a scan that saw nothing is not a clean scan`);
  const maps = Number(f.maps);
  if (f.scope === "self") { if (maps !== 1) return no(`scope=self scanned maps=${maps}; the reporting process alone is exactly one`); }
  else if (f.scope !== "all-processes" && !f.scope.startsWith("cgroup:/")) return no(`scope=${JSON.stringify(f.scope)} is not one of all-processes, cgroup:/<path>, self`);
  if (identity.execution === "jit" && f.exec_pages !== "allowed") return no(`execution=jit but exec_pages=${f.exec_pages}: no JIT runs where an executable page is refused`);
  return { ok: true, reasons: [`exec_pages=${f.exec_pages}, wx=clean, scope=${f.scope}; the tuple is the measured payload's own word, not the hardware's`] };
}
export const bind2 = async (spki, nonce, rid) => sha256(cat(te.encode(BIND2_DOMAIN), spki, nonce, rid));
export const appKeyMessage = (nonce, appId, appKey) => cat(te.encode(APP_KEY_DOMAIN), nonce, appId, appKey);
// v3: the instance inside Bind3; InstanceID = SHA-256(instance SPKI); instanceSig over the 64-byte challenge
export const bind3 = async (spki, nonce, rid, instanceId) => sha256(cat(te.encode(BIND3_DOMAIN), spki, nonce, rid, instanceId));
export const instanceIdOf = async (instanceSpki) => sha256(instanceSpki);
export const instanceSigMessage = (challenge) => cat(te.encode(INSTANCE_SIG_DOMAIN), challenge);
export const appKeyMessageV3 = (nonce, appId, instanceId, appKey) => cat(te.encode(APP_KEY_DOMAIN_V3), nonce, appId, instanceId, appKey);

function bytes32(v, what) {
  const b = v instanceof Uint8Array ? v : typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? fromHex(v) : null;
  if (!b || b.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return b;
}

export async function verifyPvmAppEvidence(envelope, expect = {}) {
  const base = { transportSpki: null, runtimeId: null, measurement: null, freshness: "client-nonce", appId: null, appKey: null, sealedWindowSeconds: null, sealedMaxRequests: null, instanceId: null, instanceKey: null };
  const no = (m, reasons = []) => ({ ok: false, reasons: [...reasons, m], ...base });
  try { await requireCurves(); } catch (x) { return no(x.message); }
  const e = envelope;
  if (!e || typeof e !== "object" || Array.isArray(e)) return no("the evidence is not an object");
  // a deployment bound to instances takes v3 only: an unbound format is a downgrade, refused by name before anything else
  let bound = null;
  if (expect.instanceIds !== undefined) {
    if (!Array.isArray(expect.instanceIds) || !expect.instanceIds.length || !expect.instanceIds.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)))
      return no("the caller's instanceIds are not a non-empty list of 64 lowercase hex: refusing (fail closed)");
    bound = new Set(expect.instanceIds);
    if (e.format !== PVM_APP_EVIDENCE_FORMAT_V3)
      return no(`${JSON.stringify(e.format)} is an unbound evidence format for a deployment bound to instances: refused as a downgrade (v3 required)`);
  }
  const v3 = e.format === PVM_APP_EVIDENCE_FORMAT_V3, v2 = e.format === PVM_APP_EVIDENCE_FORMAT_V2 || v3;
  const KEYS = v3 ? KEYS_V3 : v2 ? KEYS_V2 : KEYS_V1;
  if (Object.keys(e).sort().join() !== KEYS.join()) return no(`the evidence fields must be exactly ${KEYS.join(",")} (got ${Object.keys(e).sort().join(",")})`);
  if (!v2 && e.format !== PVM_APP_EVIDENCE_FORMAT) return no(`the evidence format is not ${PVM_APP_EVIDENCE_FORMAT}, ${PVM_APP_EVIDENCE_FORMAT_V2} or ${PVM_APP_EVIDENCE_FORMAT_V3}`);
  for (const k of ["allowedRuntimeIds", "allowedCodeHashes", "allowedAuthorityHashes"])
    if (!Array.isArray(expect[k]) || !expect[k].length) return no(`no ${k}: refusing (fail closed)`);
  if (expect.rootPins !== undefined && (!Array.isArray(expect.rootPins) || !expect.rootPins.length)) return no("an empty rootPins: refusing (fail closed)");
  let nonce, appId;
  try { nonce = bytes32(expect.nonce, "the caller's nonce"); appId = bytes32(expect.appId, "the caller's expected app"); } catch (x) { return no(x.message); }
  if (typeof e.nonce !== "string" || !/^[0-9a-f]{64}$/.test(e.nonce)) return no("the evidence nonce is not 64 lowercase hex");
  if (e.nonce !== toHex(nonce)) return no("the evidence answers another nonce (stale or replayed)");
  if (typeof e.app !== "string" || !/^[0-9a-f]{64}$/.test(e.app)) return no("the evidence app is not 64 lowercase hex");
  if (e.app !== toHex(appId)) return no("the evidence names another app");
  if (typeof e.spki !== "string" || !ED25519_SPKI.test(e.spki)) return no("the evidence's transport key is not a 44-byte Ed25519 SPKI");
  if (typeof e.identity !== "string" || e.identity.length > 1024) return no("the evidence identity is not a string of at most 1024 bytes");
  if (typeof e.selftest !== "string" || e.selftest.length > 300) return no("the evidence self-test is not a string of at most 300 bytes");
  if (v2 && (typeof e.appKey !== "string" || !/^[0-9a-f]{64}$/.test(e.appKey))) return no("the evidence appKey is not 64 lowercase hex (an X25519 key)");
  if (v2 && (typeof e.appKeySig !== "string" || !/^[0-9a-f]{128}$/.test(e.appKeySig))) return no("the evidence appKeySig is not 128 lowercase hex (an Ed25519 signature)");
  if (v3 && (typeof e.instanceKey !== "string" || !ED25519_SPKI.test(e.instanceKey))) return no("the evidence's instance key is not a 44-byte Ed25519 SPKI");
  if (v3 && e.instanceKey === e.spki) return no("the evidence's instance key is its transport key: an instance key is its own, never the boot's");
  if (v3 && (typeof e.instanceSig !== "string" || !/^[0-9a-f]{128}$/.test(e.instanceSig))) return no("the evidence instanceSig is not 128 lowercase hex (an Ed25519 signature)");
  if (!Array.isArray(e.chain) || e.chain.length < 2 || e.chain.length > 8) return no("the evidence chain is not 2..8 certificates");
  const chain = [];
  for (const c of e.chain) {
    if (typeof c !== "string" || c.length > 87384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(c) || c.length % 4) return no("a chain entry is not canonical base64");
    const der = b64(c);
    if (!der.length || der.length > 65536 || b64enc(der) !== c) return no("a chain entry is not 1..65536 bytes of canonical base64 DER");
    chain.push(der);
  }
  // the runtime: admissible, canonical, pinned by the caller, and its self-test
  let r; try { r = JSON.parse(e.identity); } catch { return no("the runtime identity is not JSON"); }
  const why = validateRuntimeIdentity(r);
  if (why) return no(`the runtime identity is not admissible: ${why}`);
  if (!same(canonical(r), te.encode(e.identity))) return no("the runtime identity is not in canonical form (the VM hashes exactly what it prints)");
  const rid = await sha256(canonical(Object.fromEntries(FIELDS.map((k) => [k, r[k]]))));
  const allowed = new Set([...expect.allowedRuntimeIds].map((h) => String(h).toLowerCase()));
  if (!allowed.has(toHex(rid))) return no(`runtime ${toHex(rid).slice(0, 16)}… (${r.name}/${r.version} ${r.execution} ${r.targetIsa}) is not an admitted runtime`);
  const reasons = [`runtime ${r.name}/${r.version} execution=${r.execution} target=${r.targetIsa} host=${r.hostIsa} features=${r.cpuFeatures} cache=${r.cache}`];
  const st = checkRuntimeSelfTest(e.selftest, r);
  if (!st.ok) return no(st.reasons[0], reasons);
  reasons.push(...st.reasons);
  // the chain, over the challenge recomputed from the caller's nonce and app (v3: and the stated instance, inside Bind3)
  const spki = fromHex(e.spki);
  const instanceId = v3 ? await instanceIdOf(fromHex(e.instanceKey)) : null;
  const challenge = cat(v3 ? await bind3(spki, nonce, rid, instanceId) : await bind2(spki, nonce, rid), appId);
  const avf = await verifyAvfChain(chain, challenge, { allowedCodeHashes: expect.allowedCodeHashes, allowedAuthorityHashes: expect.allowedAuthorityHashes,
    ...(expect.rootPins ? { rootPins: expect.rootPins } : {}), ...(expect.now ? { now: expect.now } : {}) });
  if (!avf.ok) return no(`attestation: ${avf.reasons.join("; ")}`, reasons);
  reasons.push(v3 ? `the AVF certificate's challenge is Bind3(transport key, nonce, runtime, instance ${toHex(instanceId).slice(0, 16)}…) || app ${toHex(appId).slice(0, 16)}…`
                  : `the AVF certificate's challenge is Bind2(transport key, nonce, runtime) || app ${toHex(appId).slice(0, 16)}…`);
  // v3: the instance key endorses exactly this challenge
  if (v3) {
    const ik = await subtle().importKey("spki", fromHex(e.instanceKey), { name: "Ed25519" }, false, ["verify"]);
    if (!(await subtle().verify({ name: "Ed25519" }, ik, fromHex(e.instanceSig), instanceSigMessage(challenge))))
      return no("the instanceSig is not the instance key's signature over this challenge", reasons);
    reasons.push(`the instance key signed this challenge: instance ${toHex(instanceId).slice(0, 16)}…`);
  }
  // v2/v3: the attested transport key vouches for the app key, under this nonce and this app (v3: and this instance)
  let appKey = null;
  if (v2) {
    const k = await subtle().importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
    const msg = v3 ? appKeyMessageV3(nonce, appId, instanceId, fromHex(e.appKey)) : appKeyMessage(nonce, appId, fromHex(e.appKey));
    if (!(await subtle().verify({ name: "Ed25519" }, k, fromHex(e.appKeySig), msg)))
      return no(`the appKey is not signed by the attested transport key for this nonce and app${v3 ? " and instance" : ""}`, reasons);
    appKey = e.appKey;
    reasons.push(`the app key ${appKey.slice(0, 16)}… is signed by the attested transport key for this nonce and app${v3 ? " and instance" : ""}`);
  }
  // a bound deployment: the attested instance must be one the signed policy lists for it (the check the relay cannot pass
  // by routing to another genuine instance of the same app)
  if (bound && !bound.has(toHex(instanceId)))
    return no(`instance ${toHex(instanceId).slice(0, 16)}… is a genuine instance of this app, but not one bound to the selected deployment: refused`, reasons);
  return { ok: true, reasons, transportSpki: e.spki, runtimeId: toHex(rid), measurement: avf.measurement, freshness: "client-nonce", appId: toHex(appId),
           appKey, sealedWindowSeconds: v2 ? SEALED_WINDOW_SECONDS : null, sealedMaxRequests: v2 ? SEALED_MAX_REQUESTS : null,
           instanceId: instanceId ? toHex(instanceId) : null, instanceKey: v3 ? e.instanceKey : null };
}
