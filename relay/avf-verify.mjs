// relay/avf-verify.mjs — first-party verification of an Android AVF protected-VM
// attestation: the phone-anchored Shielded host's evidence (shielded/anchor/PLAN.md
// phase 2). Sibling of snp-verify.mjs, same shape of result, same rule: the root
// is PINNED, not merely self-consistent.
//
// What the phone presents: the X.509 chain that AVmPayload_requestAttestation
// returned inside the pVM, whose leaf key exists only in that VM, and which
// Google's RKP backend issued after the device proved its DICE chain. The leaf
// carries the AVF extension (OID 1.3.6.1.4.1.11129.2.1.29.1):
//
//   AttestationExtension ::= SEQUENCE {
//     attestationChallenge  OCTET STRING,        -- our nonce, bound at request time
//     isVmSecure            BOOLEAN,             -- every DICE cert in normal mode:
//                                                --   not debuggable, verified boot
//     vmComponents          SEQUENCE OF VmComponent }
//   VmComponent ::= SEQUENCE { name UTF8String, securityVersion INTEGER,
//                              codeHash OCTET STRING, authorityHash OCTET STRING }
//
// codeHash is the APK's v4 Merkle root (the payload's identity), authorityHash
// the SHA-512 of its signing certificate. Google is the root; this file is the
// policy: which code, signed by whom, behind which boundary.
//
// verifyAvfEvidence({ chain, challenge, signature, signedMessage },
//                   { allowedCodeHashes, allowedAuthorityHashes, rootPins, now })
//   -> { ok, measurement, reasons: [...], rootVerified, component }
import { createHash, createVerify, timingSafeEqual, X509Certificate } from "node:crypto";
import fs from "node:fs";

export const AVF_ATTESTATION_EXTENSION_OID = "1.3.6.1.4.1.11129.2.1.29.1";

// Google publishes its attestation roots as a JSON array at
// https://android.googleapis.com/attestation/root and as PEM on
// developer.android.com/privacy-and-security/security-key-attestation; the
// fixtures under test/fixtures/google/ are those bytes and the test asserts
// these pins against them. RKP-issued chains (the only kind on Android 16+)
// chain to these. A chain to any other root is refused, however well-formed.
export const GOOGLE_ATTESTATION_ROOT_SHA256 = new Map([
  ["google-hardware-attestation-root-2022", "cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc"],
  ["google-key-attestation-ca1-2025", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"],
]);
const fpHex = (cert) => String(cert.fingerprint256 || "").replace(/:/g, "").toLowerCase();
export function isPinnedGoogleRoot(cert, pins = GOOGLE_ATTESTATION_ROOT_SHA256.values()) {
  const fp = fpHex(cert);
  for (const p of pins) if (p === fp) return true;
  return false;
}

// ---- a DER walker, just enough for X.509 extensions and the AVF structure ----
function tlv(b, off) {
  if (off + 2 > b.length) throw new Error("DER truncated");
  const tag = b[off]; let len = b[off + 1]; let p = off + 2;
  if (len & 0x80) { const n = len & 0x7f; if (n > 4) throw new Error("DER length too long"); len = 0; for (let i = 0; i < n; i++) len = (len << 8) | b[p++]; }
  if (p + len > b.length) throw new Error("DER element overruns buffer");
  return { tag, start: p, end: p + len, next: p + len };
}
function children(b, node) { const out = []; let p = node.start; while (p < node.end) { const c = tlv(b, p); out.push(c); p = c.next; } return out; }
const body = (b, n) => b.subarray(n.start, n.end);
function oidOf(b, n) {
  const v = body(b, n); if (!v.length) return "";
  const parts = [Math.floor(v[0] / 40), v[0] % 40]; let acc = 0;
  for (let i = 1; i < v.length; i++) { acc = acc * 128 + (v[i] & 0x7f); if (!(v[i] & 0x80)) { parts.push(acc); acc = 0; } }
  return parts.join(".");
}
function intOf(b, n) { let v = 0n; for (const x of body(b, n)) v = (v << 8n) | BigInt(x); return v; }

// Pull one extension's value (the OCTET STRING contents) out of a certificate.
export function extensionValue(certDer, oid) {
  const b = Buffer.isBuffer(certDer) ? certDer : Buffer.from(certDer);
  const cert = tlv(b, 0); if (cert.tag !== 0x30) throw new Error("not a certificate");
  const [tbs] = children(b, cert);
  const fields = children(b, tbs);
  const exts = fields.find((f) => f.tag === 0xa3);          // [3] EXPLICIT Extensions
  if (!exts) return null;
  const [seq] = children(b, exts);
  for (const ext of children(b, seq)) {
    const parts = children(b, ext);
    if (parts[0].tag !== 0x06) continue;
    if (oidOf(b, parts[0]) !== oid) continue;
    const val = parts[parts.length - 1];
    if (val.tag !== 0x04) throw new Error("extension value is not an OCTET STRING");
    return body(b, val);
  }
  return null;
}

export function parseAvfExtension(certDer) {
  const v = extensionValue(certDer, AVF_ATTESTATION_EXTENSION_OID);
  if (!v) throw new Error("no AVF attestation extension");
  const top = tlv(v, 0); if (top.tag !== 0x30) throw new Error("AttestationExtension is not a SEQUENCE");
  const [chal, secure, comps] = children(v, top);
  if (!chal || chal.tag !== 0x04) throw new Error("attestationChallenge missing");
  if (!secure || secure.tag !== 0x01) throw new Error("isVmSecure missing");
  if (!comps || comps.tag !== 0x30) throw new Error("vmComponents missing");
  const components = children(v, comps).map((c) => {
    const [name, ver, code, auth] = children(v, c);
    if (!name || name.tag !== 0x0c || !ver || ver.tag !== 0x02 || !code || code.tag !== 0x04 || !auth || auth.tag !== 0x04)
      throw new Error("VmComponent malformed");
    return { name: body(v, name).toString("utf8"), securityVersion: intOf(v, ver),
             codeHash: Buffer.from(body(v, code)).toString("hex"), authorityHash: Buffer.from(body(v, auth)).toString("hex") };
  });
  return { challenge: Buffer.from(body(v, chal)), isVmSecure: body(v, secure)[0] !== 0, components };
}

// Leaf first, root last, whatever order the phone handed them over in.
export function orderChain(certs) {
  const issuerOf = (c) => certs.find((d) => d !== c && c.checkIssued(d));
  const leaves = certs.filter((c) => !certs.some((d) => d !== c && d.checkIssued(c)));
  if (leaves.length !== 1) throw new Error(`chain has ${leaves.length} leaves`);
  const out = [leaves[0]]; const seen = new Set(out);
  for (let c = issuerOf(leaves[0]); c && !seen.has(c); c = issuerOf(c)) { out.push(c); seen.add(c); }
  if (out.length !== certs.length) throw new Error("chain does not link up");
  return out;
}
const dateOf = (c, k) => (c[`${k}Date`] instanceof Date ? c[`${k}Date`] : new Date(Date.parse(c[k])));

export function verifyAvfEvidence({ chain, challenge, signature = null, signedMessage = null } = {},
                                  { allowedCodeHashes, allowedAuthorityHashes, rootPins = GOOGLE_ATTESTATION_ROOT_SHA256.values(),
                                    now = Date.now(), requireSecure = true } = {}) {
  const reasons = [];
  const fail = (m) => { reasons.push(m); return { ok: false, measurement: null, reasons, rootVerified: false, component: null }; };
  const pins = [...rootPins];
  if (!Array.isArray(chain) || chain.length < 2) return fail(`chain must hold at least a leaf and a root, got ${chain?.length ?? 0}`);
  let certs;
  try { certs = chain.map((d) => new X509Certificate(Buffer.isBuffer(d) ? d : Buffer.from(d, "base64"))); }
  catch (e) { return fail(`unparseable certificate: ${e.message}`); }
  let ordered; try { ordered = orderChain(certs); } catch (e) { return fail(e.message); }

  // 1. THE ROOT IS PINNED. Self-consistency proves the chain hangs together and
  //    nothing more; whoever gets to be the root gets to be the device.
  const root = ordered[ordered.length - 1];
  if (!root.checkIssued(root) || !root.verify(root.publicKey)) return fail("root is not self-signed");
  if (!isPinnedGoogleRoot(root, pins)) return fail(`root ${fpHex(root)} is not a pinned Google attestation root`);

  // 2. Every link: issued by the next, signature valid, within validity, CA where it must be.
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i], issuer = ordered[i + 1] || c;
    if (!c.checkIssued(issuer)) return fail(`cert ${i} not issued by cert ${i + 1}`);
    if (!c.verify(issuer.publicKey)) return fail(`cert ${i} signature does not verify`);
    const nb = dateOf(c, "validFrom"), na = dateOf(c, "validTo");
    if (!(nb <= now)) return fail(`cert ${i} not yet valid (${c.validFrom})`);
    if (!(now <= na)) return fail(`cert ${i} expired (${c.validTo}); RKP certificates are short-lived on purpose`);
    if (i > 0 && !c.ca) return fail(`cert ${i} is not a CA`);
  }

  // 3. The extension: our challenge, a secure VM, and the code we published.
  const leaf = ordered[0];
  let ext; try { ext = parseAvfExtension(leaf.raw); } catch (e) { return fail(`leaf extension: ${e.message}`); }
  const want = Buffer.isBuffer(challenge) ? challenge : Buffer.from(String(challenge || ""), "hex");
  if (!want.length || ext.challenge.length !== want.length || !timingSafeEqual(ext.challenge, want)) return fail("attestationChallenge does not match ours");
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

  // 4. The attested key signed what we asked (the transport key + nonce): the
  //    binding between this certificate and the session that follows.
  if (signature || signedMessage) {
    if (!signature || !signedMessage) return fail("signature and signedMessage go together");
    let okSig = false;
    try { okSig = createVerify("SHA256").update(signedMessage).verify(leaf.publicKey, signature); } catch (e) { return fail(`signature check: ${e.message}`); }
    if (!okSig) return fail("attested-key signature does not verify");
  }
  return { ok: true, measurement: anchor.codeHash, reasons, rootVerified: true, component: anchor, isVmSecure: ext.isVmSecure, components: ext.components };
}

// ---- CLI: verify a captured device log (anchor-host logcat or a vm console) ----
//   node relay/avf-verify.mjs --log run.log [--challenge hex] [--code-hash hex] [--authority hex] [--any-root]
// The log holds "CERT<i>[k] <hex>" chunks, "SIG[k] <hex>" chunks and, from the
// owner app, "CONTROL challenge=<hex>". --any-root prints the chain without
// pinning, for LOOKING at a chain from a new device generation; it never says ok.
export function evidenceFromLog(text) {
  const certs = new Map(), sig = [];
  let challenge = null;
  for (const line of text.split("\n")) {
    let m;
    if ((m = /CERT(\d+)\[(\d+)\] ([0-9a-f]+)/.exec(line))) { const i = +m[1]; if (!certs.has(i)) certs.set(i, []); certs.get(i)[+m[2]] = m[3]; }
    else if ((m = /SIG\[(\d+)\] ([0-9a-f]+)/.exec(line))) sig[+m[1]] = m[2];
    else if ((m = /challenge=([0-9a-f]{64})/.exec(line))) challenge = m[1];
  }
  const chain = [...certs.keys()].sort((a, b) => a - b).map((i) => Buffer.from(certs.get(i).join(""), "hex"));
  return { chain, challenge, signature: sig.length ? Buffer.from(sig.join(""), "hex") : null };
}

if (process.argv[1] && /avf-verify\.mjs$/.test(process.argv[1])) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const log = arg("--log"); if (!log) { console.error("usage: avf-verify.mjs --log FILE [--challenge hex] [--code-hash hex] [--authority hex] [--any-root]"); process.exit(2); }
  const ev = evidenceFromLog(fs.readFileSync(log, "utf8"));
  const challenge = arg("--challenge") || ev.challenge;
  console.log(`chain: ${ev.chain.length} certificates, challenge ${challenge ? challenge.slice(0, 16) + "…" : "NONE"}, signature ${ev.signature ? ev.signature.length + " bytes" : "none"}`);
  for (const [i, d] of ev.chain.entries()) {
    const c = new X509Certificate(d);
    console.log(`  [${i}] ${c.subject.replace(/\n/g, ", ")}  <- ${c.issuer.replace(/\n/g, ", ")}  ${c.validFrom} .. ${c.validTo}  sha256=${fpHex(c).slice(0, 16)}… ca=${c.ca}`);
    try { const e = parseAvfExtension(d); console.log(`      AVF extension: isVmSecure=${e.isVmSecure} challenge=${e.challenge.toString("hex").slice(0, 16)}…`); for (const k of e.components) console.log(`        ${k.name} v${k.securityVersion} code=${k.codeHash.slice(0, 16)}… authority=${k.authorityHash.slice(0, 16)}…`); } catch {}
  }
  const opts = { allowedCodeHashes: arg("--code-hash") ? [arg("--code-hash")] : [], allowedAuthorityHashes: arg("--authority") ? [arg("--authority")] : [] };
  if (process.argv.includes("--any-root") && ev.chain.length) { const c = new X509Certificate(ev.chain[ev.chain.length - 1]); console.log(`--any-root: NOT verifying against the pins (root ${fpHex(c)})`); }
  const res = verifyAvfEvidence({ chain: ev.chain, challenge, signature: ev.signature, signedMessage: ev.signature && challenge ? Buffer.from(challenge, "hex") : null }, opts);
  console.log(JSON.stringify({ ok: res.ok, measurement: res.measurement, reasons: res.reasons }, null, 1));
  process.exit(res.ok ? 0 : 1);
}
