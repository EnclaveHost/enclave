// verifier/web/avf.mjs: an Android AVF protected-VM attestation chain judged in a browser, with relay/avf-verify.mjs's rules,
// order and words. relay/avf-verify.mjs cannot be bundled (it runs a CLI at import and reads node:fs) and must stay
// byte-identical to the integration pin (verifier/integration/pins.json, mustMatchWorktree), so its parts are RESTATED here:
// the root pins, the bounded DER walker and the AVF extension reader line for line on Uint8Array, and verifyAvfEvidence's
// steps in its order with its messages. test/verifier-web-pvm-host.test.mjs holds the two copies equal: the pins, the
// extension on every real leaf, every byte flip of one and a malformed-DER corpus, and whole verdicts on the real chains
// and their mutations.
//
// What differs, and why. The certificates are read by verifier/web/x509.mjs (verifier/der.mjs plus the reviewed reader)
// instead of OpenSSL; "issued by" is x509.mjs issuedError plus the signature algorithm's key type (OpenSSL X509_check_issued:
// names, AKID/SKID, keyCertSign, check_sig_alg_match); every signature is checked by WebCrypto - ECDSA P-256/P-384/P-521
// or RSASSA-PKCS1-v1_5 with SHA-256/384/512, the two AlgorithmIdentifiers equal, an ECDSA signature in strict DER - and
// nothing else is accepted. WebCrypto is asynchronous and the rules are not, so prepareAvfChain checks every signature a
// chain could need FIRST, and avfVerifier then runs the steps synchronously against those results
// (relay/pvm-evidence-core.mjs calls it inside the shared, synchronous rules).
// The attested-key signature (verifyAvfEvidence's `signature`/`signedMessage`) is not supported here: asked for, it refuses.
import { parseCertificate, issuedError } from "./x509.mjs";
import { tlv as derTlv, children as derChildren, bytes as derBytes, oid as derOid, toHex, equalBytes } from "../der.mjs";

export const AVF_ATTESTATION_EXTENSION_OID = "1.3.6.1.4.1.11129.2.1.29.1";
export const AVF_MAX_CERT_BYTES = 64 * 1024;
export const AVF_MAX_CHAIN_CERTS = 8;
export const AVF_MAX_COMPONENTS = 256;
// relay/avf-verify.mjs GOOGLE_ATTESTATION_ROOT_SHA256, restated (the parity test asserts the two maps are equal)
export const GOOGLE_ATTESTATION_ROOT_SHA256 = new Map([
  ["google-hardware-attestation-root-2022", "cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc"],
  ["google-key-attestation-ca1-2025", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"],
]);

// ---- relay/avf-verify.mjs's DER walker and AVF extension reader, line for line (Uint8Array for Buffer) ----
function tlv(b, off, limit = b.length) {
  if (!Number.isSafeInteger(off) || !Number.isSafeInteger(limit) || off < 0 || limit > b.length || off > limit - 2)
    throw new Error("DER truncated");
  const tag = b[off]; let len = b[off + 1]; let p = off + 2;
  if (!tag || (tag & 0x1f) === 0x1f) throw new Error("unsupported DER tag");
  if (len & 0x80) {
    const n = len & 0x7f;
    if (!n || n > 4 || n > limit - p) throw new Error("invalid DER length");
    if (!b[p]) throw new Error("nonminimal DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++]; // no signed-32-bit wrap
    if (len < 128) throw new Error("nonminimal DER length");
  }
  if (len > limit - p) throw new Error("DER element overruns parent");
  return { tag, start: p, end: p + len, next: p + len };
}
function children(b, node, cap = 2048) {
  if (!node || !(node.tag & 0x20)) throw new Error("DER parent is not constructed");
  const out = []; let p = node.start;
  while (p < node.end) {
    if (out.length >= cap) throw new Error("too many DER children");
    const c = tlv(b, p, node.end); out.push(c); p = c.next;
  }
  return out;
}
const body = (b, n) => b.subarray(n.start, n.end);
function oidOf(b, n) {
  const v = body(b, n);
  if (!v.length || v.length > 64) throw new Error("invalid DER OID length");
  const parts = []; let acc = 0n, first = true;
  for (const octet of v) {
    if (first && octet === 0x80) throw new Error("nonminimal DER OID");
    acc = acc * 128n + BigInt(octet & 0x7f); first = false;
    if (!(octet & 0x80)) { parts.push(acc); acc = 0n; first = true; }
  }
  if (!first) throw new Error("truncated DER OID");
  const combined = parts.shift(), head = combined < 40n ? 0n : combined < 80n ? 1n : 2n;
  return [head, combined - head * 40n, ...parts].join(".");
}
function intOf(b, n) {
  const bytes = body(b, n);
  if (!bytes.length || bytes.length > 32 || (bytes[0] & 0x80) ||
      (bytes.length > 1 && bytes[0] === 0 && !(bytes[1] & 0x80)))
    throw new Error("securityVersion is not a bounded nonnegative DER INTEGER");
  let v = 0n; for (const x of bytes) v = (v << 8n) | BigInt(x); return v;
}
function boolOf(b, n) {
  const bytes = body(b, n);
  if (n.tag !== 0x01 || bytes.length !== 1 || (bytes[0] !== 0 && bytes[0] !== 0xff))
    throw new Error("invalid DER BOOLEAN");
  return bytes[0] === 0xff;
}

// Pull one extension's value (the OCTET STRING contents) out of a certificate.
export function extensionValue(certDer, oid) {
  const b = certDer instanceof Uint8Array ? certDer : new Uint8Array(certDer);
  if (b.length > AVF_MAX_CERT_BYTES) throw new Error("certificate exceeds size limit");
  const cert = tlv(b, 0);
  if (cert.tag !== 0x30 || cert.end !== b.length) throw new Error("not an exact DER certificate");
  const certFields = children(b, cert, 3);
  if (certFields.length !== 3 || certFields[0].tag !== 0x30 || certFields[1].tag !== 0x30 || certFields[2].tag !== 0x03)
    throw new Error("certificate fields malformed");
  const [tbs] = certFields;
  const fields = children(b, tbs);
  const extensions = fields.filter((f) => f.tag === 0xa3); // [3] EXPLICIT Extensions
  if (!extensions.length) return null;
  if (extensions.length !== 1) throw new Error("duplicate extension containers");
  const wrapped = children(b, extensions[0], 1), seq = wrapped[0];
  if (!seq || seq.tag !== 0x30) throw new Error("extensions are not a SEQUENCE");
  let found = null;
  const seen = new Set();
  for (const ext of children(b, seq)) {
    if (ext.tag !== 0x30) throw new Error("extension is not a SEQUENCE");
    const parts = children(b, ext, 3);
    if (parts.length < 2 || parts[0].tag !== 0x06) throw new Error("extension fields malformed");
    if (parts.length === 3 && !boolOf(b, parts[1])) throw new Error("DER default critical=false must be omitted");
    const id = oidOf(b, parts[0]);
    if (seen.has(id)) throw new Error("duplicate certificate extension");
    seen.add(id);
    const val = parts[parts.length - 1];
    if (val.tag !== 0x04) throw new Error("extension value is not an OCTET STRING");
    if (id === oid) found = body(b, val);
  }
  return found;
}

export function parseAvfExtension(certDer) {
  const v = extensionValue(certDer, AVF_ATTESTATION_EXTENSION_OID);
  if (!v) throw new Error("no AVF attestation extension");
  const top = tlv(v, 0);
  if (top.tag !== 0x30 || top.end !== v.length) throw new Error("AttestationExtension is not an exact SEQUENCE");
  // three fields, or four with the fourth an EMPTY SEQUENCE (real Pixel 10 chains carry it; relay/avf-verify.mjs explains)
  const fields = children(v, top, 4);
  if (fields.length !== 3 && fields.length !== 4) throw new Error("AttestationExtension must have three fields (or four, the fourth an empty SEQUENCE)");
  if (fields.length === 4 && (fields[3].tag !== 0x30 || body(v, fields[3]).length !== 0))
    throw new Error("AttestationExtension's fourth field is not an empty SEQUENCE: unknown structure, refused");
  const [chal, secure, comps] = fields;
  if (!chal || chal.tag !== 0x04) throw new Error("attestationChallenge missing");
  if (!secure || secure.tag !== 0x01) throw new Error("isVmSecure missing");
  if (!comps || comps.tag !== 0x30) throw new Error("vmComponents missing");
  const isVmSecure = boolOf(v, secure);
  const components = children(v, comps, AVF_MAX_COMPONENTS).map((c) => {
    if (c.tag !== 0x30) throw new Error("VmComponent is not a SEQUENCE");
    const fields = children(v, c, 4);
    if (fields.length !== 4) throw new Error("VmComponent must have four fields");
    const [name, ver, code, auth] = fields;
    if (!name || name.tag !== 0x0c || !ver || ver.tag !== 0x02 || !code || code.tag !== 0x04 || !auth || auth.tag !== 0x04)
      throw new Error("VmComponent malformed");
    const nameBytes = body(v, name);
    if (!nameBytes.length || nameBytes.length > 1024) throw new Error("invalid component name length");
    const decodedName = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(nameBytes);
    if (/[\u0000-\u001f\u007f]/.test(decodedName)) throw new Error("component name contains control characters");
    return { name: decodedName, securityVersion: intOf(v, ver),
             codeHash: toHex(body(v, code)), authorityHash: toHex(body(v, auth)) };
  });
  return { challenge: Uint8Array.from(body(v, chal)), isVmSecure, components };
}

// ---- signatures, on WebCrypto, checked before the rules run ----
const subtle = () => { const s = globalThis.crypto && globalThis.crypto.subtle; if (!s) throw new Error("WebCrypto (crypto.subtle) is not available"); return s; };
const SIG_ALGS = Object.freeze({
  "1.2.840.10045.4.3.2": { kind: "ecdsa", hash: "SHA-256" }, "1.2.840.10045.4.3.3": { kind: "ecdsa", hash: "SHA-384" }, "1.2.840.10045.4.3.4": { kind: "ecdsa", hash: "SHA-512" },
  "1.2.840.113549.1.1.11": { kind: "rsa", hash: "SHA-256" }, "1.2.840.113549.1.1.12": { kind: "rsa", hash: "SHA-384" }, "1.2.840.113549.1.1.13": { kind: "rsa", hash: "SHA-512" },
});
const CURVE_BYTES = { "P-256": 32, "P-384": 48, "P-521": 66 };
// AlgorithmIdentifier -> SIG_ALGS entry, or null: ECDSA with parameters absent (RFC 5758 3.2), RSA with NULL or absent
function signatureAlgorithm(algDer) {
  const top = derTlv(algDer, 0); if (top.tag !== 0x30 || top.end !== algDer.length) return null;
  const [id, params, more] = derChildren(algDer, top, 3); if (!id || id.tag !== 0x06 || more) return null;
  const alg = SIG_ALGS[derOid(algDer, id)]; if (!alg) return null;
  if (alg.kind === "ecdsa" && params) return null;
  if (alg.kind === "rsa" && params && !(params.tag === 0x05 && params.end === params.start)) return null;
  return alg;
}
// Ecdsa-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER } in strict DER (OpenSSL re-encodes and refuses any other form) ->
// IEEE P1363 r || s, each left-padded to the curve's size
function ecdsaP1363(sig, size) {
  const top = derTlv(sig, 0); if (top.tag !== 0x30 || top.end !== sig.length) throw new Error("ECDSA signature is not one SEQUENCE");
  const parts = derChildren(sig, top, 3); if (parts.length !== 2 || parts.some((p) => p.tag !== 0x02)) throw new Error("ECDSA signature is not two INTEGERs");
  const out = new Uint8Array(2 * size);
  parts.forEach((p, i) => {
    let v = derBytes(sig, p);
    if (!v.length || (v[0] & 0x80) || (v.length > 1 && v[0] === 0 && !(v[1] & 0x80))) throw new Error("ECDSA INTEGER is negative or not minimal");
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error("ECDSA INTEGER is longer than the curve");
    out.set(v, i * size + size - v.length);
  });
  return out;
}
// OpenSSL's X509_check_issued also asks that the certificate's (TBS) signature algorithm be one for the issuer's key type
// (check_sig_alg_match): an unknown algorithm, or ECDSA under an RSA key, is "not issued by" that key
function sigAlgFitsKey(cert, issuer) {
  try {
    const top = derTlv(cert.tbsSigAlg, 0), [id] = derChildren(cert.tbsSigAlg, top, 3), alg = id && id.tag === 0x06 ? SIG_ALGS[derOid(cert.tbsSigAlg, id)] : null;
    return !!alg && (alg.kind === "ecdsa" ? issuer.key.type === "ec" : issuer.key.type === "rsa");
  } catch { return false; }
}
// cert's signature by issuer's key -> boolean (never throws: any doubt is false)
export async function certificateSignatureOk(cert, issuer) {
  try {
    if (!equalBytes(cert.sigAlg, cert.tbsSigAlg)) return false;   // RFC 5280 4.1.1.2; OpenSSL refuses a mismatch too
    const alg = signatureAlgorithm(cert.sigAlg); if (!alg) return false;
    if (alg.kind === "ecdsa") {
      const size = issuer.key.type === "ec" && CURVE_BYTES[issuer.key.curve]; if (!size) return false;
      const key = await subtle().importKey("spki", issuer.spki, { name: "ECDSA", namedCurve: issuer.key.curve }, false, ["verify"]);
      return await subtle().verify({ name: "ECDSA", hash: alg.hash }, key, ecdsaP1363(cert.signature, size), cert.tbs);
    }
    if (issuer.key.type !== "rsa") return false;
    const key = await subtle().importKey("spki", issuer.spki, { name: "RSASSA-PKCS1-v1_5", hash: alg.hash }, false, ["verify"]);
    return await subtle().verify({ name: "RSASSA-PKCS1-v1_5" }, key, cert.signature, cert.tbs);
  } catch { return false; }
}

const keyOf = (der) => toHex(der);
const asBytes = (d) => {
  if (d instanceof Uint8Array) return d;
  if (typeof d !== "string" || d.length > 4 * Math.ceil(AVF_MAX_CERT_BYTES / 3)) return null;
  try { const bin = atob(d); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; } catch { return null; }
};
// prepareAvfChain(entries: [DER bytes or base64]) -> { certs: Map(DER hex -> { cert } | { error }), sigs: Map("child|issuer" -> boolean) }.
// Every certificate is read, fingerprinted and, for every pair whose names link (and every certificate with itself), the
// signature is checked: at most 8 x 8 checks. An entry that does not decode is skipped (the rules refuse it themselves).
export async function prepareAvfChain(entries) {
  const certs = new Map(), sigs = new Map();
  if (!Array.isArray(entries) || entries.length > AVF_MAX_CHAIN_CERTS) return { certs, sigs };
  for (const e of entries) {
    const der = asBytes(e); if (!der || !der.length || der.length > AVF_MAX_CERT_BYTES) continue;
    const k = keyOf(der); if (certs.has(k)) continue;
    try { const cert = parseCertificate(der); cert.fp256 = toHex(new Uint8Array(await subtle().digest("SHA-256", der))); certs.set(k, { cert }); }
    catch (x) { certs.set(k, { error: x.message }); }
  }
  const parsed = [...certs].filter(([, v]) => v.cert);
  for (const [ck, { cert }] of parsed)
    for (const [ik, { cert: issuer }] of parsed)
      if (equalBytes(cert.issuerDer, issuer.subjectDer)) sigs.set(`${ck}|${ik}`, await certificateSignatureOk(cert, issuer));
  return { certs, sigs };
}

// avfVerifier(prepared) -> verifyAvfEvidence({ chain, challenge }, { allowedCodeHashes, allowedAuthorityHashes, rootPins, now,
// requireSecure }) with relay/avf-verify.mjs's result shape, synchronous; a certificate prepareAvfChain did not see is refused.
export function avfVerifier(prepared) {
  return function verifyAvfEvidence({ chain, challenge, signature = null, signedMessage = null } = {},
                                    { allowedCodeHashes, allowedAuthorityHashes, rootPins = GOOGLE_ATTESTATION_ROOT_SHA256.values(),
                                      now = Date.now(), requireSecure = true } = {}) {
    const reasons = [];
    const fail = (m) => { reasons.push(m); return { ok: false, measurement: null, reasons, rootVerified: false, component: null }; };
    const pins = [...rootPins];
    if (!Array.isArray(chain) || chain.length < 2) return fail(`chain must hold at least a leaf and a root, got ${chain?.length ?? 0}`);
    if (chain.length > AVF_MAX_CHAIN_CERTS) return fail("attestation chain exceeds certificate-count limit");
    let certs;
    try { certs = chain.map((d) => {
      const bytes = asBytes(d);
      if (!bytes || bytes.length > AVF_MAX_CERT_BYTES) throw new Error("certificate exceeds size/type limit");
      const p = prepared.certs.get(keyOf(bytes));
      if (!p) throw new Error("the certificate was not read before the rules ran");
      if (p.error) throw new Error(p.error);
      return { ...p.cert, key_: keyOf(bytes) };   // one object per position, as Node makes one X509Certificate per entry
    }); }
    catch (e) { return fail(`unparseable certificate: ${e.message}`); }
    const issued = (c, d) => issuedError(c, d) === null && sigAlgFitsKey(c, d);   // Node: c.checkIssued(d), "d issued c"
    const signedBy = (c, d) => prepared.sigs.get(`${c.key_}|${d.key_}`) === true;
    let ordered;
    try {   // relay/avf-verify.mjs orderChain: leaf first, root last, whatever order they came in
      const issuerOf = (c) => certs.find((d) => d !== c && issued(c, d));
      const leaves = certs.filter((c) => !certs.some((d) => d !== c && issued(d, c)));
      if (leaves.length !== 1) throw new Error(`chain has ${leaves.length} leaves`);
      const out = [leaves[0]]; const seen = new Set(out);
      for (let c = issuerOf(leaves[0]); c && !seen.has(c); c = issuerOf(c)) { out.push(c); seen.add(c); }
      if (out.length !== certs.length) throw new Error("chain does not link up");
      ordered = out;
    } catch (e) { return fail(e.message); }

    // 1. THE ROOT IS PINNED.
    const root = ordered[ordered.length - 1];
    if (!issued(root, root) || !signedBy(root, root)) return fail("root is not self-signed");
    if (!pins.includes(root.fp256)) return fail(`root ${root.fp256} is not a pinned Google attestation root`);

    // 2. Every link: issued by the next, signature valid, within validity, CA where it must be.
    for (let i = 0; i < ordered.length; i++) {
      const c = ordered[i], issuer = ordered[i + 1] || c;
      if (!issued(c, issuer)) return fail(`cert ${i} not issued by cert ${i + 1}`);
      if (!signedBy(c, issuer)) return fail(`cert ${i} signature does not verify`);
      if (!(c.notBefore <= now)) return fail(`cert ${i} not yet valid (${c.validFrom})`);
      if (!(now <= c.notAfter)) return fail(`cert ${i} expired (${c.validTo}); RKP certificates are short-lived on purpose`);
      if (i > 0 && !c.isCA) return fail(`cert ${i} is not a CA`);
    }

    // 3. The extension: our challenge, a secure VM, and the code we published.
    const leaf = ordered[0];
    let ext; try { ext = parseAvfExtension(leaf.raw); } catch (e) { return fail(`leaf extension: ${e.message}`); }
    const want = challenge instanceof Uint8Array ? challenge : typeof challenge === "string" && /^(?:[0-9a-fA-F]{2})*$/.test(challenge)
      ? Uint8Array.from(challenge.match(/../g) || [], (h) => parseInt(h, 16)) : new Uint8Array(0);
    if (!want.length || !equalBytes(ext.challenge, want)) return fail("attestationChallenge does not match ours");
    if (requireSecure && !ext.isVmSecure) return fail("isVmSecure=false: a DICE link is debuggable or unverified");
    const codes = new Set([...(allowedCodeHashes || [])].map((h) => String(h).toLowerCase()));
    const auths = new Set([...(allowedAuthorityHashes || [])].map((h) => String(h).toLowerCase()));
    if (!codes.size || !auths.size) return fail("no pinned code/authority hashes: refusing (fail closed)");
    const apks = ext.components.filter((c) => /apk/i.test(c.name));
    if (!apks.length) return fail("no APK component in vmComponents");
    const stranger = apks.find((c) => !auths.has(c.authorityHash));
    if (stranger) return fail(`APK component "${stranger.name}" signed by an unpinned authority ${stranger.authorityHash.slice(0, 16)}…`);
    const anchor = apks.find((c) => codes.has(c.codeHash));
    if (!anchor) return fail(`no APK component with an allowlisted codeHash (saw ${apks.map((c) => c.codeHash.slice(0, 16) + "…").join(", ")})`);

    // 4. The attested-key signature is not checked in this build: asked for, it is refused rather than skipped.
    if (signature || signedMessage) return fail("the attested-key signature is not checked by the browser build");
    return { ok: true, measurement: anchor.codeHash, reasons, rootVerified: true, component: anchor, isVmSecure: ext.isVmSecure, components: ext.components,
             root: { fp256: root.fp256, subjectCn: root.subjectCn } };
  };
}
