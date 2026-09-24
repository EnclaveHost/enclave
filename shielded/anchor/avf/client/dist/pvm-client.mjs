/*! enclave-pvm-client 0.5.0 (LAB, not production) -- built by client/build.sh with esbuild 0.28.1
Contains @hpke/core 1.9.0 and @hpke/common 1.10.1 (MIT):
@hpke/core 1.9.0:
MIT License

Copyright (c) 2023 Ajitomi Daisuke

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

@hpke/common 1.10.1:
MIT License

Copyright (c) 2024 Ajitomi Daisuke

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

// cli.mjs
import fs4 from "node:fs";
import os2 from "node:os";
import path4 from "node:path";
import { createHash as createHash3 } from "node:crypto";

// ../web/pvm-verify.js
var PVM_APP_EVIDENCE_FORMAT = "enclave-pvm-app-evidence/v1";
var PVM_APP_EVIDENCE_FORMAT_V2 = "enclave-pvm-app-evidence/v2";
var PVM_APP_EVIDENCE_FORMAT_V3 = "enclave-pvm-app-evidence/v3";
var APP_KEY_DOMAIN = "enclave-pvm-app-key-v1\n";
var APP_KEY_DOMAIN_V3 = "enclave-pvm-app-key-v2\n";
var BIND2_DOMAIN = "enclave-bind-v2\n";
var BIND3_DOMAIN = "enclave-bind-v3-instance\n";
var INSTANCE_SIG_DOMAIN = "enclave-pvm-instance-sig-v1\n";
var SEALED_WINDOW_SECONDS = 600;
var SEALED_MAX_REQUESTS = 256;
var AVF_ATTESTATION_EXTENSION_OID = "1.3.6.1.4.1.11129.2.1.29.1";
var GOOGLE_ATTESTATION_ROOT_SHA256 = [
  "cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc",
  // google-hardware-attestation-root-2022
  "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"
  // google-key-attestation-ca1-2025
];
var MAX_CERT = 64 * 1024;
var MAX_CHAIN = 8;
var MAX_COMPONENTS = 256;
var FIELDS = ["name", "version", "execution", "targetIsa", "hostIsa", "cpuFeatures", "wx", "cache"];
var KEYS_V1 = ["app", "chain", "format", "identity", "nonce", "selftest", "spki"];
var KEYS_V2 = ["app", "appKey", "appKeySig", "chain", "format", "identity", "nonce", "selftest", "spki"];
var KEYS_V3 = ["app", "appKey", "appKeySig", "chain", "format", "identity", "instanceKey", "instanceSig", "nonce", "selftest", "spki"];
var ED25519_SPKI = /^302a300506032b6570032100[0-9a-f]{64}$/;
var te = new TextEncoder();
var toHex = (u8) => Array.from(u8, (b2) => b2.toString(16).padStart(2, "0")).join("");
function fromHex(s) {
  if (typeof s !== "string" || s.length % 2 || !/^[0-9a-f]*$/.test(s)) throw new Error("not lowercase hex");
  const o = new Uint8Array(s.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return o;
}
var cat = (...a) => {
  const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let p = 0;
  for (const x of a) {
    o.set(x, p);
    p += x.length;
  }
  return o;
};
var same = (a, b2) => a.length === b2.length && a.every((x, i) => x === b2[i]);
function b64(s) {
  const bin = atob(s), o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}
function b64enc(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode(...u8.subarray(i, i + 32768));
  return btoa(s);
}
function subtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error("no SubtleCrypto here (a page must be a secure context: https, or http://127.0.0.1 in the lab)");
  return s;
}
var sha256 = async (d) => new Uint8Array(await subtle().digest("SHA-256", d));
var caps = null;
function requireCurves() {
  caps ||= (async () => {
    try {
      await subtle().importKey("raw", new Uint8Array(32).fill(9), { name: "X25519" }, false, []);
    } catch (e) {
      throw new Error(`this browser's SubtleCrypto has no X25519 (${e.name}): refusing, no fallback`);
    }
    try {
      await subtle().importKey("spki", fromHex("302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"), { name: "Ed25519" }, false, ["verify"]);
    } catch (e) {
      throw new Error(`this browser's SubtleCrypto has no Ed25519 (${e.name}): refusing, no fallback`);
    }
  })();
  return caps;
}
function tlv(b2, off, limit = b2.length) {
  if (!Number.isSafeInteger(off) || !Number.isSafeInteger(limit) || off < 0 || limit > b2.length || off > limit - 2) throw new Error("DER truncated");
  const tag = b2[off];
  let len = b2[off + 1], p = off + 2;
  if (!tag || (tag & 31) === 31) throw new Error("unsupported DER tag");
  if (len & 128) {
    const n = len & 127;
    if (!n || n > 4 || n > limit - p) throw new Error("invalid DER length");
    if (!b2[p]) throw new Error("nonminimal DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b2[p++];
    if (len < 128) throw new Error("nonminimal DER length");
  }
  if (len > limit - p) throw new Error("DER element overruns parent");
  return { tag, off, start: p, end: p + len, next: p + len };
}
function children(b2, node, cap = 2048) {
  if (!node || !(node.tag & 32)) throw new Error("DER parent is not constructed");
  const out2 = [];
  let p = node.start;
  while (p < node.end) {
    if (out2.length >= cap) throw new Error("too many DER children");
    const c = tlv(b2, p, node.end);
    out2.push(c);
    p = c.next;
  }
  return out2;
}
var body = (b2, n) => b2.subarray(n.start, n.end);
var whole = (b2, n) => b2.subarray(n.off, n.end);
function oidOf(b2, n) {
  if (n.tag !== 6) throw new Error("not a DER OID");
  const v = body(b2, n);
  if (!v.length || v.length > 64) throw new Error("invalid DER OID length");
  const parts = [];
  let acc = 0n, first = true;
  for (const o of v) {
    if (first && o === 128) throw new Error("nonminimal DER OID");
    acc = acc * 128n + BigInt(o & 127);
    first = false;
    if (!(o & 128)) {
      parts.push(acc);
      acc = 0n;
      first = true;
    }
  }
  if (!first) throw new Error("truncated DER OID");
  const c = parts.shift(), head = c < 40n ? 0n : c < 80n ? 1n : 2n;
  return [head, c - head * 40n, ...parts].join(".");
}
function boolOf(b2, n) {
  const v = body(b2, n);
  if (n.tag !== 1 || v.length !== 1 || v[0] !== 0 && v[0] !== 255) throw new Error("invalid DER BOOLEAN");
  return v[0] === 255;
}
function uintOf(b2, n, what) {
  const v = body(b2, n);
  if (n.tag !== 2 || !v.length || v.length > 32 || v[0] & 128 || v.length > 1 && v[0] === 0 && !(v[1] & 128))
    throw new Error(`${what} is not a bounded nonnegative DER INTEGER`);
  let x = 0n;
  for (const o of v) x = x << 8n | BigInt(o);
  return x;
}
function timeOf(b2, n) {
  const s = new TextDecoder().decode(body(b2, n));
  const m = n.tag === 23 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s) : n.tag === 24 ? /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s) : null;
  if (!m) throw new Error("certificate validity is not a UTCTime or GeneralizedTime in Z");
  let y = +m[1];
  if (n.tag === 23) y += y >= 50 ? 1900 : 2e3;
  return Date.UTC(y, +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
var SIG_ALGS = {
  "1.2.840.10045.4.3.2": { kind: "ECDSA", hash: "SHA-256" },
  "1.2.840.10045.4.3.3": { kind: "ECDSA", hash: "SHA-384" },
  "1.2.840.10045.4.3.4": { kind: "ECDSA", hash: "SHA-512" },
  "1.2.840.113549.1.1.11": { kind: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  "1.2.840.113549.1.1.12": { kind: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
  "1.2.840.113549.1.1.13": { kind: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }
};
var CURVES = { "1.2.840.10045.3.1.7": ["P-256", 32], "1.3.132.0.34": ["P-384", 48], "1.3.132.0.35": ["P-521", 66] };
function parseCert(der) {
  if (der.length > MAX_CERT) throw new Error("certificate exceeds size limit");
  const top = tlv(der, 0);
  if (top.tag !== 48 || top.end !== der.length) throw new Error("not an exact DER certificate");
  const f = children(der, top, 3);
  if (f.length !== 3 || f[0].tag !== 48 || f[1].tag !== 48 || f[2].tag !== 3) throw new Error("certificate fields malformed");
  const [tbs, alg, sigv] = f;
  const t = children(der, tbs);
  let i = 0;
  if (t[i]?.tag !== 160) throw new Error("not an X.509 v3 certificate");
  const ver = children(der, t[i++], 1)[0];
  if (!ver || uintOf(der, ver, "version") !== 2n) throw new Error("not an X.509 v3 certificate");
  if (t[i++]?.tag !== 2) throw new Error("serial number missing");
  const innerAlg = t[i++], issuer = t[i++], validity = t[i++], subject = t[i++], spki = t[i++];
  if (!innerAlg || innerAlg.tag !== 48 || !same(whole(der, innerAlg), whole(der, alg))) throw new Error("the signature algorithm inside and outside the certificate differ");
  if (!issuer || issuer.tag !== 48 || !subject || subject.tag !== 48 || !spki || spki.tag !== 48 || !validity || validity.tag !== 48) throw new Error("certificate body malformed");
  const [nb, na] = children(der, validity, 2);
  if (!nb || !na) throw new Error("certificate validity malformed");
  const algOid = oidOf(der, children(der, alg)[0]);
  const sigBits = body(der, sigv);
  if (!sigBits.length || sigBits[0] !== 0) throw new Error("signature BIT STRING has unused bits");
  const [kalg] = children(der, spki, 2), kparts = children(der, kalg, 2), koid = oidOf(der, kparts[0]);
  const key = koid === "1.2.840.10045.2.1" ? { kind: "EC", curve: CURVES[kparts[1] && kparts[1].tag === 6 ? oidOf(der, kparts[1]) : ""] } : koid === "1.2.840.113549.1.1.1" ? { kind: "RSA" } : koid === "1.3.101.112" ? { kind: "Ed25519" } : { kind: "unknown", oid: koid };
  const ext = /* @__PURE__ */ new Map();
  let ca = false, keyUsage = null;
  for (; i < t.length; i++) {
    if (t[i].tag !== 163) continue;
    if (ext.size) throw new Error("duplicate extension containers");
    const seq = children(der, t[i], 1)[0];
    if (!seq || seq.tag !== 48) throw new Error("extensions are not a SEQUENCE");
    for (const e of children(der, seq)) {
      if (e.tag !== 48) throw new Error("extension is not a SEQUENCE");
      const p = children(der, e, 3);
      if (p.length < 2 || p[0].tag !== 6) throw new Error("extension fields malformed");
      if (p.length === 3 && !boolOf(der, p[1])) throw new Error("DER default critical=false must be omitted");
      const id = oidOf(der, p[0]), val = p[p.length - 1];
      if (ext.has(id)) throw new Error("duplicate certificate extension");
      if (val.tag !== 4) throw new Error("extension value is not an OCTET STRING");
      ext.set(id, body(der, val));
    }
  }
  if (ext.has("2.5.29.19")) {
    const v = ext.get("2.5.29.19"), s = tlv(v, 0);
    if (s.tag !== 48 || s.end !== v.length) throw new Error("basicConstraints malformed");
    const c = children(v, s, 2);
    if (c[0] && c[0].tag === 1) ca = boolOf(v, c[0]);
  }
  if (ext.has("2.5.29.15")) {
    const v = ext.get("2.5.29.15"), s = tlv(v, 0);
    if (s.tag !== 3 || s.end !== v.length || s.end - s.start < 2) throw new Error("keyUsage malformed");
    keyUsage = v.subarray(s.start + 1, s.end);
  }
  return {
    der,
    tbs: whole(der, tbs),
    sigAlg: SIG_ALGS[algOid] || { kind: "unknown", oid: algOid },
    signature: sigBits.subarray(1),
    issuer: whole(der, issuer),
    subject: whole(der, subject),
    spki: whole(der, spki),
    key,
    notBefore: timeOf(der, nb),
    notAfter: timeOf(der, na),
    ca,
    keyUsage,
    ext
  };
}
function ecdsaRaw(sig, n) {
  const s = tlv(sig, 0);
  if (s.tag !== 48 || s.end !== sig.length) throw new Error("ECDSA signature malformed");
  const rs = children(sig, s, 2);
  if (rs.length !== 2 || rs.some((x) => x.tag !== 2)) throw new Error("ECDSA signature malformed");
  const out2 = new Uint8Array(2 * n);
  rs.forEach((x, k) => {
    let v = body(sig, x);
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > n) throw new Error("ECDSA signature component too long");
    out2.set(v, k * n + n - v.length);
  });
  return out2;
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
function parseAvfExtension(v) {
  const top = tlv(v, 0);
  if (top.tag !== 48 || top.end !== v.length) throw new Error("AttestationExtension is not an exact SEQUENCE");
  const f = children(v, top, 4);
  if (f.length !== 3 && f.length !== 4) throw new Error("AttestationExtension must have three fields (or four, the fourth an empty SEQUENCE)");
  if (f.length === 4 && (f[3].tag !== 48 || body(v, f[3]).length !== 0)) throw new Error("AttestationExtension's fourth field is not an empty SEQUENCE: unknown structure, refused");
  const [chal, secure, comps] = f;
  if (chal.tag !== 4) throw new Error("attestationChallenge missing");
  if (secure.tag !== 1) throw new Error("isVmSecure missing");
  if (comps.tag !== 48) throw new Error("vmComponents missing");
  const components = children(v, comps, MAX_COMPONENTS).map((c) => {
    if (c.tag !== 48) throw new Error("VmComponent is not a SEQUENCE");
    const g = children(v, c, 4);
    if (g.length !== 4) throw new Error("VmComponent must have four fields");
    const [name, ver, code, auth] = g;
    if (name.tag !== 12 || ver.tag !== 2 || code.tag !== 4 || auth.tag !== 4) throw new Error("VmComponent malformed");
    const nb = body(v, name);
    if (!nb.length || nb.length > 1024) throw new Error("invalid component name length");
    const nm = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(nb);
    if (/[\u0000-\u001f\u007f]/.test(nm)) throw new Error("component name contains control characters");
    return { name: nm, securityVersion: uintOf(v, ver, "securityVersion"), codeHash: toHex(body(v, code)), authorityHash: toHex(body(v, auth)) };
  });
  return { challenge: body(v, chal), isVmSecure: boolOf(v, secure), components };
}
async function verifyAvfChain(chain, challenge, { allowedCodeHashes, allowedAuthorityHashes, rootPins = GOOGLE_ATTESTATION_ROOT_SHA256, now = Date.now() }) {
  const fail = (m) => ({ ok: false, reasons: [m], measurement: null });
  if (!Array.isArray(chain) || chain.length < 2) return fail(`chain must hold at least a leaf and a root, got ${chain?.length ?? 0}`);
  if (chain.length > MAX_CHAIN) return fail("attestation chain exceeds certificate-count limit");
  let c;
  try {
    c = chain.map(parseCert);
  } catch (e2) {
    return fail(`unparseable certificate: ${e2.message}`);
  }
  const root = c[c.length - 1];
  if (!same(root.issuer, root.subject)) return fail("root is not self-signed");
  try {
    if (!await signedBy(root, root)) return fail("root is not self-signed");
  } catch (e2) {
    return fail(`root: ${e2.message}`);
  }
  const rootFp = toHex(await sha256(root.der));
  if (![...rootPins].map((p) => String(p).toLowerCase()).includes(rootFp)) return fail(`root ${rootFp} is not a pinned Google attestation root`);
  for (let i = 0; i < c.length; i++) {
    const x = c[i], up = c[i + 1] || x;
    if (!same(x.issuer, up.subject)) return fail(`cert ${i} not issued by cert ${i + 1} (the chain must arrive leaf first)`);
    if (up.keyUsage && !(up.keyUsage[0] & 4)) return fail(`cert ${i + 1} may not sign certificates (keyUsage)`);
    let ok;
    try {
      ok = await signedBy(x, up);
    } catch (e2) {
      return fail(`cert ${i}: ${e2.message}`);
    }
    if (!ok) return fail(`cert ${i} signature does not verify`);
    if (!(x.notBefore <= now)) return fail(`cert ${i} not yet valid (${new Date(x.notBefore).toISOString()})`);
    if (!(now <= x.notAfter)) return fail(`cert ${i} expired (${new Date(x.notAfter).toISOString()}); RKP certificates are short-lived on purpose`);
    if (i > 0 && !x.ca) return fail(`cert ${i} is not a CA`);
  }
  const extv = c[0].ext.get(AVF_ATTESTATION_EXTENSION_OID);
  if (!extv) return fail("leaf extension: no AVF attestation extension");
  let e;
  try {
    e = parseAvfExtension(extv);
  } catch (x) {
    return fail(`leaf extension: ${x.message}`);
  }
  if (!challenge.length || !same(e.challenge, challenge)) return fail("attestationChallenge does not match ours");
  if (!e.isVmSecure) return fail("isVmSecure=false: a DICE link is debuggable or unverified");
  const codes = new Set([...allowedCodeHashes || []].map((h) => String(h).toLowerCase()));
  const auths = new Set([...allowedAuthorityHashes || []].map((h) => String(h).toLowerCase()));
  if (!codes.size || !auths.size) return fail("no pinned code/authority hashes: refusing (fail closed)");
  const apks = e.components.filter((k) => /apk/i.test(k.name));
  if (!apks.length) return fail("no APK component in vmComponents");
  const stranger = apks.find((k) => !auths.has(k.authorityHash));
  if (stranger) return fail(`APK component "${stranger.name}" signed by an unpinned authority ${stranger.authorityHash.slice(0, 16)}…`);
  const anchor = apks.find((k) => codes.has(k.codeHash));
  if (!anchor) return fail(`no APK component with an allowlisted codeHash (saw ${apks.map((k) => k.codeHash.slice(0, 16) + "…").join(", ")})`);
  return { ok: true, reasons: [], measurement: anchor.codeHash };
}
function canonical(v) {
  const sort = (x) => Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x;
  return te.encode(JSON.stringify(sort(v)));
}
function validateRuntimeIdentity(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "the runtime identity is not an object";
  for (const k of Object.keys(r)) if (!FIELDS.includes(k)) return `the runtime identity carries an unknown field ${JSON.stringify(k)}`;
  for (const k of FIELDS) if (typeof r[k] !== "string") return `the runtime identity field ${k} is missing or not a string`;
  if (r.name === "" || r.version === "") return "runtime name and version are required";
  if (r.hostIsa !== "x86_64" && r.hostIsa !== "aarch64") return `host ISA ${JSON.stringify(r.hostIsa)} is not one of x86_64, aarch64`;
  if (r.execution === "jit") {
    if (r.targetIsa !== r.hostIsa) return `a JIT emits the host's own ISA: target ${JSON.stringify(r.targetIsa)} must equal host ${JSON.stringify(r.hostIsa)}`;
  } else if (r.execution === "interpreter") {
    if (r.targetIsa !== "pulley64") return `an interpreter runs pulley64 bytecode, not ${JSON.stringify(r.targetIsa)}`;
  } else return `execution ${JSON.stringify(r.execution)} is not one of jit, interpreter`;
  if (r.cpuFeatures === "") return 'the CPU-feature policy must be stated ("baseline" if none)';
  if (r.wx !== "enforced") return "a runtime that cannot state W^X as enforced is not admissible";
  if (r.cache !== "none" && r.cache !== "authenticated") return `cache mode ${JSON.stringify(r.cache)} is not one of none, authenticated`;
  return null;
}
function checkRuntimeSelfTest(selfTest, identity) {
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
  if (f.scope === "self") {
    if (maps !== 1) return no(`scope=self scanned maps=${maps}; the reporting process alone is exactly one`);
  } else if (f.scope !== "all-processes" && !f.scope.startsWith("cgroup:/")) return no(`scope=${JSON.stringify(f.scope)} is not one of all-processes, cgroup:/<path>, self`);
  if (identity.execution === "jit" && f.exec_pages !== "allowed") return no(`execution=jit but exec_pages=${f.exec_pages}: no JIT runs where an executable page is refused`);
  return { ok: true, reasons: [`exec_pages=${f.exec_pages}, wx=clean, scope=${f.scope}; the tuple is the measured payload's own word, not the hardware's`] };
}
var bind2 = async (spki, nonce, rid) => sha256(cat(te.encode(BIND2_DOMAIN), spki, nonce, rid));
var appKeyMessage = (nonce, appId, appKey) => cat(te.encode(APP_KEY_DOMAIN), nonce, appId, appKey);
var bind3 = async (spki, nonce, rid, instanceId) => sha256(cat(te.encode(BIND3_DOMAIN), spki, nonce, rid, instanceId));
var instanceIdOf = async (instanceSpki) => sha256(instanceSpki);
var instanceSigMessage = (challenge) => cat(te.encode(INSTANCE_SIG_DOMAIN), challenge);
var appKeyMessageV3 = (nonce, appId, instanceId, appKey) => cat(te.encode(APP_KEY_DOMAIN_V3), nonce, appId, instanceId, appKey);
function bytes32(v, what) {
  const b2 = v instanceof Uint8Array ? v : typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? fromHex(v) : null;
  if (!b2 || b2.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return b2;
}
async function verifyPvmAppEvidence(envelope, expect = {}) {
  const base = { transportSpki: null, runtimeId: null, measurement: null, freshness: "client-nonce", appId: null, appKey: null, sealedWindowSeconds: null, sealedMaxRequests: null, instanceId: null, instanceKey: null };
  const no = (m, reasons2 = []) => ({ ok: false, reasons: [...reasons2, m], ...base });
  try {
    await requireCurves();
  } catch (x) {
    return no(x.message);
  }
  const e = envelope;
  if (!e || typeof e !== "object" || Array.isArray(e)) return no("the evidence is not an object");
  let bound = null;
  if (expect.instanceIds !== void 0) {
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
  if (expect.rootPins !== void 0 && (!Array.isArray(expect.rootPins) || !expect.rootPins.length)) return no("an empty rootPins: refusing (fail closed)");
  let nonce, appId;
  try {
    nonce = bytes32(expect.nonce, "the caller's nonce");
    appId = bytes32(expect.appId, "the caller's expected app");
  } catch (x) {
    return no(x.message);
  }
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
  let r;
  try {
    r = JSON.parse(e.identity);
  } catch {
    return no("the runtime identity is not JSON");
  }
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
  const spki = fromHex(e.spki);
  const instanceId = v3 ? await instanceIdOf(fromHex(e.instanceKey)) : null;
  const challenge = cat(v3 ? await bind3(spki, nonce, rid, instanceId) : await bind2(spki, nonce, rid), appId);
  const avf = await verifyAvfChain(chain, challenge, {
    allowedCodeHashes: expect.allowedCodeHashes,
    allowedAuthorityHashes: expect.allowedAuthorityHashes,
    ...expect.rootPins ? { rootPins: expect.rootPins } : {},
    ...expect.now ? { now: expect.now } : {}
  });
  if (!avf.ok) return no(`attestation: ${avf.reasons.join("; ")}`, reasons);
  reasons.push(v3 ? `the AVF certificate's challenge is Bind3(transport key, nonce, runtime, instance ${toHex(instanceId).slice(0, 16)}…) || app ${toHex(appId).slice(0, 16)}…` : `the AVF certificate's challenge is Bind2(transport key, nonce, runtime) || app ${toHex(appId).slice(0, 16)}…`);
  if (v3) {
    const ik = await subtle().importKey("spki", fromHex(e.instanceKey), { name: "Ed25519" }, false, ["verify"]);
    if (!await subtle().verify({ name: "Ed25519" }, ik, fromHex(e.instanceSig), instanceSigMessage(challenge)))
      return no("the instanceSig is not the instance key's signature over this challenge", reasons);
    reasons.push(`the instance key signed this challenge: instance ${toHex(instanceId).slice(0, 16)}…`);
  }
  let appKey = null;
  if (v2) {
    const k = await subtle().importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
    const msg = v3 ? appKeyMessageV3(nonce, appId, instanceId, fromHex(e.appKey)) : appKeyMessage(nonce, appId, fromHex(e.appKey));
    if (!await subtle().verify({ name: "Ed25519" }, k, fromHex(e.appKeySig), msg))
      return no(`the appKey is not signed by the attested transport key for this nonce and app${v3 ? " and instance" : ""}`, reasons);
    appKey = e.appKey;
    reasons.push(`the app key ${appKey.slice(0, 16)}… is signed by the attested transport key for this nonce and app${v3 ? " and instance" : ""}`);
  }
  if (bound && !bound.has(toHex(instanceId)))
    return no(`instance ${toHex(instanceId).slice(0, 16)}… is a genuine instance of this app, but not one bound to the selected deployment: refused`, reasons);
  return {
    ok: true,
    reasons,
    transportSpki: e.spki,
    runtimeId: toHex(rid),
    measurement: avf.measurement,
    freshness: "client-nonce",
    appId: toHex(appId),
    appKey,
    sealedWindowSeconds: v2 ? SEALED_WINDOW_SECONDS : null,
    sealedMaxRequests: v2 ? SEALED_MAX_REQUESTS : null,
    instanceId: instanceId ? toHex(instanceId) : null,
    instanceKey: v3 ? e.instanceKey : null
  };
}

// src/trust.js
var CLIENT_VERSION = "0.5.0";
var POLICY_DOMAIN = "enclave-pvm-client-policy-v1\n";
var UPDATE_DOMAIN = "enclave-pvm-client-update-v1\n";
var UPDATE_COUNTERSIGN_DOMAIN = "enclave-pvm-client-update-countersign-v1\n";
var VERSION_MARKER = "/*! enclave-pvm-client ";
var te2 = new TextEncoder();
var td = new TextDecoder("utf-8", { fatal: true });
var HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
var subtle2 = () => globalThis.crypto.subtle;
var MAX_DOC = 64 * 1024;
var fingerprint = async (rawKeyHex) => toHex(await sha256(fromHex(rawKeyHex)));
function semver(v) {
  const m = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(String(v));
  return m ? [+m[1], +m[2], +m[3]] : null;
}
var semverCmp = (a, b2) => {
  const x = semver(a), y = semver(b2);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
function initialState({ policyKeyFp, serialFloor, releaseKeyFp }) {
  if (!HEX(64).test(policyKeyFp || "") || !HEX(64).test(releaseKeyFp || "") || !Number.isSafeInteger(serialFloor) || serialFloor < 1)
    throw new Error("the install anchor needs a policy key fingerprint, a serial floor >= 1 and a release key fingerprint");
  if (policyKeyFp === releaseKeyFp) throw new Error("the policy key and the release key must be distinct");
  return { policyFp: policyKeyFp, nextPolicyFp: null, serial: serialFloor, digest: null, releaseFp: releaseKeyFp, nextReleaseFp: null };
}
function signedBytes(b642, what) {
  if (typeof b642 !== "string" || b642.length > MAX_DOC * 4 / 3 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b642) || b642.length % 4) throw new Error(`the ${what} is not canonical base64`);
  const bin = atob(b642), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (!bytes.length || bytes.length > MAX_DOC) throw new Error(`the ${what} is not 1..${MAX_DOC} bytes`);
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  if (btoa(s) !== b642) throw new Error(`the ${what} is not canonical base64`);
  let text, body2;
  try {
    text = td.decode(bytes);
    body2 = JSON.parse(text);
  } catch {
    throw new Error(`the ${what} is not UTF-8 JSON`);
  }
  if (!body2 || typeof body2 !== "object" || Array.isArray(body2)) throw new Error(`the ${what} is not a JSON object`);
  if (JSON.stringify(body2) !== text) throw new Error(`the ${what} is not strict JSON (duplicate keys, padding or escapes that do not round-trip)`);
  return { bytes, body: body2 };
}
async function edVerify(keyHex, sigHex, domain, bytes) {
  const k = await subtle2().importKey("raw", fromHex(keyHex), { name: "Ed25519" }, false, ["verify"]);
  return subtle2().verify({ name: "Ed25519" }, k, fromHex(sigHex), new Uint8Array([...te2.encode(domain), ...bytes]));
}
var closed = (o, keys) => Object.keys(o).sort().join() === [...keys].sort().join();
var list = (v, re, max = 64) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every((x) => typeof x === "string" && re.test(x)) && new Set(v).size === v.length;
var time = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s) ? Date.parse(s) : NaN;
var POLICY_KEYS = [
  "appIds",
  "authorityHashes",
  "codeHashes",
  "formats",
  "googleRootPins",
  "key",
  "minClientVersion",
  "nextPolicyKey",
  "notAfter",
  "notBefore",
  "runtimeIds",
  "sealedModes",
  "sealedWindow",
  "serial",
  "type"
];
var DEPLOYMENT_ID = /^0x[0-9a-f]{64}$/;
var MAX_DEPLOYMENTS = 64;
var MAX_INSTANCES = 8;
var POLICY_TYPE = "enclave-pvm-client-policy";
var POLICY_TYPE_V2 = "enclave-pvm-client-policy/2";
var INSTANCE_ID = /^[0-9a-f]{64}$/;
async function verifyPolicy(env, { state, now = Date.now(), clientVersion = CLIENT_VERSION } = {}) {
  const no = (m) => ({ ok: false, reasons: [m], policy: null, pins: null, state });
  if (!state || !HEX(64).test(state.policyFp || "")) return no("no policy key was anchored at install: refusing (fail closed)");
  if (!env || typeof env !== "object" || Array.isArray(env) || !closed(env, ["policy", "sig"])) return no("the policy envelope must be exactly { policy, sig }");
  if (typeof env.sig !== "string" || !HEX(128).test(env.sig)) return no("the policy signature is not 64 bytes of lowercase hex");
  let bytes, b2;
  try {
    ({ bytes, body: b2 } = signedBytes(env.policy, "policy"));
  } catch (e) {
    return no(e.message);
  }
  if (typeof b2.key !== "string" || !HEX(64).test(b2.key)) return no("the policy's key is not 32 bytes of lowercase hex");
  const fp = await fingerprint(b2.key);
  if (fp !== state.policyFp && fp !== state.nextPolicyFp) return no("the policy is signed by a key this client's anchor does not name");
  let sigOk = false;
  try {
    sigOk = await edVerify(b2.key, env.sig, POLICY_DOMAIN, bytes);
  } catch (e) {
    return no(`the policy signature cannot be checked here (${e.name}): refusing, no fallback`);
  }
  if (!sigOk) return no("the policy signature does not verify over its exact bytes");
  if (!closed(b2, POLICY_KEYS) && !closed(b2, [...POLICY_KEYS, "deployments"])) return no(`the policy fields must be exactly ${POLICY_KEYS.join(",")}, optionally with deployments`);
  if (b2.type !== POLICY_TYPE && b2.type !== POLICY_TYPE_V2) return no("not a pVM client policy");
  const typeV2 = b2.type === POLICY_TYPE_V2;
  if (!Number.isSafeInteger(b2.serial) || b2.serial < 1) return no("the policy serial is not a positive integer");
  const nb = time(b2.notBefore), na = time(b2.notAfter);
  if (!(nb < na)) return no("the policy validity is not notBefore < notAfter (UTC seconds, Z)");
  if (now < nb) return no(`the policy is not valid before ${b2.notBefore}: no operation`);
  if (now > na) return no(`the policy expired at ${b2.notAfter}: no operation, never a stale fallback`);
  if (!list(b2.codeHashes, HEX(64)) || !list(b2.appIds, HEX(64)) || !list(b2.runtimeIds, HEX(64)) || !list(b2.authorityHashes, HEX(128)))
    return no("the policy's code hashes, app IDs, runtime IDs and authority hashes must be non-empty lists of lowercase hex (an empty list is never read as all)");
  if (!list(b2.googleRootPins, HEX(64), 8) || !b2.googleRootPins.every((p) => GOOGLE_ATTESTATION_ROOT_SHA256.includes(p)))
    return no("the policy's root pins may only narrow the Google attestation roots built into this client, never widen or empty them");
  if (!list(b2.formats, /./, 3) || !b2.formats.every((f) => f === PVM_APP_EVIDENCE_FORMAT_V3 || f === PVM_APP_EVIDENCE_FORMAT_V2 || f === PVM_APP_EVIDENCE_FORMAT)) return no("the policy's evidence formats are not known to this client");
  if (!list(b2.sealedModes, /./, 2) || !b2.sealedModes.every((m) => m === "whole" || m === "chunked")) return no("the policy's sealed modes are not known to this client");
  const w = b2.sealedWindow;
  if (!w || typeof w !== "object" || !closed(w, ["maxRequests", "seconds"]) || !Number.isSafeInteger(w.seconds) || !Number.isSafeInteger(w.maxRequests) || w.seconds < 1 || w.maxRequests < 1)
    return no("the policy's sealedWindow must be exactly { seconds, maxRequests }");
  if ("deployments" in b2) {
    const d = b2.deployments;
    if (!Array.isArray(d) || d.length < 1 || d.length > MAX_DEPLOYMENTS) return no(`the policy's deployments must be a list of 1..${MAX_DEPLOYMENTS} entries (an empty table is never read as all)`);
    const seen = /* @__PURE__ */ new Map();
    for (const e of d) {
      if (!e || typeof e !== "object" || Array.isArray(e)) return no(`each deployment must be exactly { id, app }${typeV2 ? " or { id, app, instances }" : ""}`);
      if (!typeV2 && "instances" in e) return no(`a deployment binds instances, which only a ${POLICY_TYPE_V2} policy may: this ${POLICY_TYPE} policy is refused, never read as unbound`);
      if (!closed(e, ["app", "id"]) && !(typeV2 && closed(e, ["app", "id", "instances"]))) return no(`each deployment must be exactly { id, app }${typeV2 ? " or { id, app, instances }" : ""}`);
      if (typeof e.id !== "string" || !DEPLOYMENT_ID.test(e.id)) return no(`deployment id ${JSON.stringify(e.id)} is not 0x + 64 lowercase hex (the ledger's bytes32)`);
      if (typeof e.app !== "string" || !HEX(64).test(e.app) || !b2.appIds.includes(e.app)) return no(`deployment ${e.id}'s app is not one of the policy's appIds`);
      if ("instances" in e) {
        if (!list(e.instances, INSTANCE_ID, MAX_INSTANCES)) return no(`deployment ${e.id}'s instances must be 1..${MAX_INSTANCES} unique InstanceIDs, 64 lowercase hex (an empty list is never read as any)`);
        for (const i of e.instances) {
          if (seen.has(i)) return no(`instance ${i.slice(0, 16)}... is bound to two deployments (${seen.get(i).slice(0, 18)}... and ${e.id.slice(0, 18)}...): an instance serving both could not tell them apart, refused`);
          seen.set(i, e.id);
        }
      }
    }
    if (new Set(d.map((e) => e.id)).size !== d.length) return no("the policy names a deployment id twice: ambiguous, refused");
    if (seen.size && !b2.formats.includes(PVM_APP_EVIDENCE_FORMAT_V3)) return no(`the policy binds instances but does not allow ${PVM_APP_EVIDENCE_FORMAT_V3}, the only format that names one: incoherent, refused`);
  }
  if (!semver(b2.minClientVersion)) return no("the policy's minClientVersion is not MAJOR.MINOR.PATCH");
  if (b2.nextPolicyKey !== null && (typeof b2.nextPolicyKey !== "string" || !HEX(64).test(b2.nextPolicyKey) || b2.nextPolicyKey === b2.key)) return no("the policy's nextPolicyKey is not null or another 32-byte key");
  if (b2.serial < state.serial) return no(`policy serial ${b2.serial} is below the ${state.serial} this client holds (its install floor or a newer policy it accepted): a rollback, refused`);
  const digest = toHex(await sha256(bytes));
  if (b2.serial === state.serial && state.digest && digest !== state.digest) return no(`a second, different policy with serial ${b2.serial}: equivocation, refused`);
  if (semverCmp(clientVersion, b2.minClientVersion) < 0) return no(`this client (${clientVersion}) is below the policy's minimum ${b2.minClientVersion}: disabled until updated`);
  const next = { ...state, policyFp: fp, nextPolicyFp: b2.nextPolicyKey ? await fingerprint(b2.nextPolicyKey) : null, serial: b2.serial, digest };
  const pins = { allowedCodeHashes: b2.codeHashes, allowedAuthorityHashes: b2.authorityHashes, allowedRuntimeIds: b2.runtimeIds, rootPins: b2.googleRootPins };
  return { ok: true, reasons: [`policy serial ${b2.serial}${fp === state.nextPolicyFp ? " (under the rotated key)" : ""}, valid to ${b2.notAfter}`], policy: b2, pins, state: next };
}
function selectDeployment(policy, { deployment = null, app = null } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (deployment === null) {
    if (!app) return no("no app or deployment selected");
    if (!policy.appIds.includes(app)) return no("the policy does not admit this app");
    return { ok: true, app, deployment: null, instances: null };
  }
  if (typeof deployment !== "string" || !DEPLOYMENT_ID.test(deployment)) return no(`deployment ${JSON.stringify(deployment)} is not 0x + 64 lowercase hex: not normalized, refused`);
  if (!Array.isArray(policy.deployments)) return no("the policy names no deployments: select an app, or get a policy that names this deployment");
  const hits = policy.deployments.filter((e) => e.id === deployment);
  if (hits.length !== 1) return no(hits.length ? "the policy names this deployment more than once: ambiguous" : `the policy does not name deployment ${deployment}`);
  if (app && app !== hits[0].app) return no(`the selected app ${app.slice(0, 16)}... is not the app the policy expects for deployment ${deployment.slice(0, 18)}... (${hits[0].app.slice(0, 16)}...)`);
  return { ok: true, app: hits[0].app, deployment, instances: hits[0].instances || null };
}
var UPDATE_KEYS = ["artifact", "artifactSha256", "nextReleaseKey", "notAfter", "policyKey", "releaseKey", "size", "sourceCommit", "type", "version"];
async function verifyUpdate(env, bytes, { state, now = Date.now(), currentVersion = CLIENT_VERSION, artifact } = {}) {
  const no = (m) => ({ ok: false, reasons: [m], manifest: null, state });
  if (!state || !HEX(64).test(state.releaseFp || "") || !HEX(64).test(state.policyFp || "")) return no("no release or policy key was anchored at install: refusing (fail closed)");
  if (!env || typeof env !== "object" || Array.isArray(env) || !closed(env, ["manifest", "policySig", "releaseSig"])) return no("the update envelope must be exactly { manifest, releaseSig, policySig }");
  if (!HEX(128).test(env.releaseSig || "") || !HEX(128).test(env.policySig || "")) return no("the update signatures are not 64 bytes of lowercase hex each");
  let mb, b2;
  try {
    ({ bytes: mb, body: b2 } = signedBytes(env.manifest, "update manifest"));
  } catch (e) {
    return no(e.message);
  }
  if (!HEX(64).test(b2.releaseKey || "") || !HEX(64).test(b2.policyKey || "")) return no("the manifest's release and policy keys are not 32 bytes of lowercase hex");
  const rfp = await fingerprint(b2.releaseKey), pfp = await fingerprint(b2.policyKey);
  if (rfp !== state.releaseFp && rfp !== state.nextReleaseFp) return no("the update is signed by a release key this client's anchor does not name");
  if (pfp !== state.policyFp) return no("the update is countersigned by a policy key this client's anchor does not name");
  try {
    if (!await edVerify(b2.releaseKey, env.releaseSig, UPDATE_DOMAIN, mb)) return no("the release signature does not verify over the manifest's exact bytes");
    if (!await edVerify(b2.policyKey, env.policySig, UPDATE_COUNTERSIGN_DOMAIN, mb)) return no("the policy countersignature does not verify: one key alone cannot ship code");
  } catch (e) {
    return no(`the update signatures cannot be checked here (${e.name}): refusing, no fallback`);
  }
  if (!closed(b2, UPDATE_KEYS)) return no(`the manifest fields must be exactly ${UPDATE_KEYS.join(",")}`);
  if (b2.type !== "enclave-pvm-client-update") return no("not a pVM client update manifest");
  if (artifact && b2.artifact !== artifact) return no(`the manifest is for ${JSON.stringify(b2.artifact)}, not ${JSON.stringify(artifact)}`);
  if (!semver(b2.version) || !HEX(64).test(b2.artifactSha256 || "") || !Number.isSafeInteger(b2.size) || b2.size < 1 || !HEX(40).test(b2.sourceCommit || ""))
    return no("the manifest's version, artifactSha256, size or sourceCommit is malformed");
  const na = time(b2.notAfter);
  if (!(now <= na)) return no(`the update manifest expired at ${b2.notAfter}`);
  if (b2.nextReleaseKey !== null && (!HEX(64).test(b2.nextReleaseKey || "") || b2.nextReleaseKey === b2.releaseKey)) return no("the manifest's nextReleaseKey is not null or another 32-byte key");
  if (semverCmp(b2.version, currentVersion) <= 0) return no(`update ${b2.version} is not newer than the installed ${currentVersion}: a downgrade or a replay, refused`);
  const x = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (x.length !== b2.size) return no(`the delivered artifact is ${x.length} bytes; the signed manifest says ${b2.size}`);
  if (toHex(await sha256(x)) !== b2.artifactSha256) return no("the delivered bytes are not the signed artifact (sha256 differs)");
  const first = new TextDecoder().decode(x.subarray(0, 200)).split("\n")[0];
  if (!first.startsWith(`${VERSION_MARKER}${b2.version} `)) return no(`the artifact's own version line is not ${b2.version}: a manifest cannot rename an artifact's version`);
  const next = { ...state, releaseFp: rfp, nextReleaseFp: b2.nextReleaseKey ? await fingerprint(b2.nextReleaseKey) : null };
  return { ok: true, reasons: [`update ${b2.version} (${b2.artifact}, source ${b2.sourceCommit.slice(0, 12)}) signed and countersigned; install for the next start`], manifest: b2, state: next };
}

// src/update.js
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
var sha2562 = (b2) => createHash("sha256").update(b2).digest("hex");
function publishArtifact(dir, name, bytes, sha) {
  const file = path.join(dir, name), tmp = path.join(dir, `.${name}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(tmp, "wx", 292);
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
    }
    return { ok: false, reason: `could not write the verified artifact (${e.code || e.message}): nothing staged` };
  }
  let created = true;
  try {
    fs.linkSync(tmp, file);
  } catch (e) {
    created = false;
    if (e.code !== "EEXIST") {
      fs.rmSync(tmp, { force: true });
      return { ok: false, reason: `could not publish the verified artifact (${e.code || e.message}): nothing staged` };
    }
  }
  fs.rmSync(tmp, { force: true });
  if (!created) {
    let have = null;
    try {
      have = sha2562(fs.readFileSync(file));
    } catch {
    }
    if (have !== sha) return { ok: false, reason: `${name} already exists with bytes other than its name says: refusing; it is left untouched and nothing is staged` };
  }
  try {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch (e) {
    return { ok: false, reason: `could not make the verified artifact durable (${e.code || e.message}): nothing staged` };
  }
  return { ok: true, file, created };
}
function decide(state, m, name) {
  const v = m.version, s = state.staged, a = state.active || null;
  if (s && s.version === v && s.sha256 === m.artifactSha256 && s.file === name && s.sourceCommit === m.sourceCommit) return { same: true };
  if (s && semverCmp(s.version, v) > 0) return { refuse: `update ${s.version} is already staged: ${v} cannot replace it` };
  if (s && semverCmp(s.version, v) === 0) return { refuse: `update ${s.version} is already staged: ${v} cannot replace it (a second signed artifact under the same version: refused, the staged one stands)` };
  if (a && semverCmp(a.version, v) >= 0) return { refuse: `update ${a.version} is active: ${v} cannot replace it` };
  return { stage: true };
}
async function stageUpdate(store, env, bytes, { dir, currentVersion = CLIENT_VERSION, hold: hold2 = null } = {}) {
  const cur = store.latest();
  if (!cur) return { ok: false, reason: "no client installed" };
  const first = await verifyUpdate(env, bytes, { state: cur.state, currentVersion, artifact: "pvm-client.mjs" });
  if (!first.ok) return { ok: false, reason: first.reasons[0] };
  const m = first.manifest, name = `pvm-client-${m.version}-${m.artifactSha256}.mjs`;
  const pre = decide(cur.state, m, name);
  if (pre.refuse) return { ok: false, reason: pre.refuse };
  const pub = publishArtifact(dir, name, bytes, m.artifactSha256);
  if (!pub.ok) return { ok: false, reason: pub.reason };
  let r;
  try {
    r = await store.update(async (state) => {
      if (hold2) await hold2(state);
      const u = await verifyUpdate(env, bytes, { state, currentVersion, artifact: "pvm-client.mjs" });
      if (!u.ok) return { refuse: u.reasons[0] };
      const d = decide(state, u.manifest, name);
      if (d.refuse) return { refuse: d.refuse };
      if (d.same) return { same: true };
      return { state: { ...u.state, staged: { version: u.manifest.version, sha256: u.manifest.artifactSha256, size: u.manifest.size, file: name, sourceCommit: u.manifest.sourceCommit } } };
    });
  } catch (e) {
    return { ok: false, reason: `could not record the staged update durably (${e.message}): nothing staged` };
  }
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, version: r.state.staged.version, file: path.join(dir, r.state.staged.file), gen: r.gen, ...r.same ? { already: true } : {} };
}

// src/activate.js
import fs2 from "node:fs";
import os from "node:os";
import path2 from "node:path";
import { spawn } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
var DELEGATED = "ENCLAVE_PVM_CLIENT_DELEGATED";
var START_TIMEOUT_MS = 3e4;
var START_OUTPUT_MAX = 65536;
var sha2563 = (b2) => createHash2("sha256").update(b2).digest("hex");
var recordOf = (s) => ({ version: s.version, sha256: s.sha256, size: s.size, file: s.file, sourceCommit: s.sourceCommit });
var sameRecord = (a, b2) => !!a && !!b2 && ["version", "sha256", "size", "file", "sourceCommit"].every((k) => a[k] === b2[k]);
function readRecorded(dir, rec) {
  let bytes;
  try {
    bytes = fs2.readFileSync(path2.join(dir, rec.file));
  } catch (e) {
    return { ok: false, found: "missing", reason: `${rec.file} cannot be read (${e.code || e.message})` };
  }
  const h = sha2563(bytes);
  if (h !== rec.sha256) return { ok: false, found: h, reason: `${rec.file} does not hold the recorded bytes (sha256 ${h}, recorded ${rec.sha256})` };
  if (rec.size !== void 0 && bytes.length !== rec.size) return { ok: false, found: h, reason: `${rec.file} is ${bytes.length} bytes, recorded ${rec.size}` };
  const first = bytes.subarray(0, 200).toString("utf8").split("\n")[0];
  if (!first.startsWith(`${VERSION_MARKER}${rec.version} `)) return { ok: false, found: h, reason: `${rec.file}'s own version line is not ${rec.version}` };
  return { ok: true, bytes };
}
function runBytes(bytes, args, { env, cwd, stdio = ["pipe", "inherit", "inherit"] } = {}) {
  const c = spawn(process.execPath, ["--input-type=module", "-", ...args], { env, cwd, stdio });
  c.stdin.on("error", () => {
  });
  c.stdin.end(bytes);
  return c;
}
var ended = (c) => new Promise((r) => {
  c.on("error", (e) => r({ error: e }));
  c.on("close", (code, sig) => r({ code, sig }));
});
var childEnv = (over = {}) => {
  const e = { ...process.env };
  delete e.NODE_OPTIONS;
  delete e[DELEGATED];
  return { ...e, ...over };
};
async function startCheck(bytes, version) {
  const scratch = fs2.mkdtempSync(path2.join(os.tmpdir(), "pvm-start-"));
  try {
    const c = runBytes(bytes, ["version"], { env: childEnv({ HOME: scratch, XDG_CONFIG_HOME: scratch }), cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
    let out2 = "", timedOut = false;
    c.stdout.on("data", (d) => {
      out2 += d;
      if (out2.length > START_OUTPUT_MAX) c.kill("SIGKILL");
    });
    c.stderr.on("data", () => {
    });
    const t = setTimeout(() => {
      timedOut = true;
      c.kill("SIGKILL");
    }, START_TIMEOUT_MS);
    const e = await ended(c);
    clearTimeout(t);
    if (e.error) return `it could not be started (${e.error.message})`;
    if (e.sig) return timedOut ? `it did not answer within ${START_TIMEOUT_MS / 1e3} s` : `it ended by signal ${e.sig}`;
    if (e.code !== 0) return `it exited ${e.code}`;
    const lines = out2.split("\n").filter(Boolean);
    let v = null;
    try {
      v = lines.length === 1 ? JSON.parse(lines[0]) : null;
    } catch {
    }
    if (!v || typeof v !== "object" || v.client !== "enclave-pvm-client" || v.version !== version)
      return `it answered ${JSON.stringify(out2.slice(0, 200))}, not exactly one line naming version ${version}`;
    return null;
  } finally {
    fs2.rmSync(scratch, { recursive: true, force: true });
  }
}
async function activateStaged(store, { dir, clientVersion = CLIENT_VERSION, hold: hold2 = null, afterVerify = null } = {}) {
  const no = (step2, reason, extra = {}) => ({ ok: false, step: step2, reasons: [reason], ...extra });
  const cur = store.latest();
  if (!cur) return no("nothing newer", "no client installed");
  const s = cur.state.staged, a = cur.state.active || null;
  if (!s) return no("nothing newer", "nothing is staged");
  const rec = recordOf(s);
  if (a && sameRecord(a, rec)) return { ok: true, version: a.version, sha256: a.sha256, gen: cur.gen, already: true };
  const floor = a && semverCmp(a.version, clientVersion) > 0 ? a.version : clientVersion;
  if (semverCmp(rec.version, floor) <= 0) return no("nothing newer", `staged ${rec.version} is not newer than ${a ? `the active ${a.version} or ` : ""}this client ${clientVersion}: nothing to activate`);
  const got = readRecorded(dir, rec);
  if (!got.ok) return no("file", `${got.reason}: nothing activated, nothing run`, { expected: { version: rec.version, sha256: rec.sha256, file: rec.file }, found: got.found });
  if (afterVerify) await afterVerify();
  const why = await startCheck(got.bytes, rec.version);
  if (why) return no("start check", `${rec.version} failed its start check: ${why}; nothing activated`);
  let r, step = null;
  try {
    r = await store.update(async (state) => {
      if (hold2) await hold2(state);
      step = null;
      const ns = state.staged ? recordOf(state.staged) : null, na = state.active || null;
      if (na && sameRecord(na, rec)) return { same: true };
      if (!sameRecord(ns, rec)) {
        step = "changed while activating";
        return { refuse: `the staged update changed while activating (staged is now ${ns ? `${ns.version} ${ns.sha256.slice(0, 12)}` : "nothing"}): nothing activated; run activate again` };
      }
      if (na && semverCmp(na.version, rec.version) >= 0) {
        step = "nothing newer";
        return { refuse: `${na.version} is already active: ${rec.version} cannot replace it` };
      }
      return { state: { ...state, active: rec } };
    });
  } catch (e) {
    return no("commit", `could not record the activation durably (${e.message}): nothing activated`);
  }
  if (!r.ok) return no(step || "nothing newer", r.reason);
  return { ok: true, version: rec.version, sha256: rec.sha256, gen: r.gen, ...r.same ? { already: true } : {} };
}
function withDirs(args, stateDir, installDir2) {
  const out2 = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--state" || args[i] === "--install-dir") {
      i++;
      continue;
    }
    out2.push(args[i]);
  }
  return [...out2, "--state", stateDir, "--install-dir", installDir2];
}
async function launchActive(active, { dir, stateDir, args, hold: hold2 = null }) {
  const got = readRecorded(dir, active);
  if (!got.ok) return { refused: {
    step: "launch",
    refused: `the active client ${active.version} cannot start: ${got.reason}; nothing was run (no fallback to an older client)`,
    sent: false,
    expected: { version: active.version, sha256: active.sha256, file: active.file },
    found: got.found
  } };
  if (hold2) await hold2();
  const e = await ended(runBytes(got.bytes, ["run", ...withDirs(args, stateDir, dir)], { env: childEnv({ [DELEGATED]: `${active.version}:${active.sha256}` }) }));
  if (e.error) return { error: `the active client ${active.version} could not be started (${e.error.message})` };
  return { code: e.code, sig: e.sig };
}

// src/store-file.js
import fs3 from "node:fs";
import path3 from "node:path";
import { randomBytes as randomBytes2 } from "node:crypto";
var GEN = /^([1-9]\d{0,14})\.json$/;
var canon = (v) => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x);
var KEEP = 16;
var StoreError = class extends Error {
};
var FileStore = class {
  constructor(dir) {
    this.dir = dir;
  }
  gens() {
    let names;
    try {
      names = fs3.readdirSync(this.dir);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw new StoreError(`the state directory is unreadable (${e.code})`);
    }
    return names.map((n) => GEN.exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b2) => a - b2);
  }
  /** The newest committed generation { gen, state }, or null before install. */
  latest() {
    const g = this.gens();
    if (!g.length) return null;
    const gen = g[g.length - 1];
    let doc;
    try {
      doc = JSON.parse(fs3.readFileSync(path3.join(this.dir, `${gen}.json`), "utf8"));
    } catch (e) {
      throw new StoreError(`the newest state generation ${gen} is unreadable (${e.code || e.message}): refusing -- an older generation would itself be a rollback`);
    }
    if (!doc || typeof doc !== "object" || doc.gen !== gen || !doc.state || typeof doc.state !== "object")
      throw new StoreError(`state generation ${gen} is inconsistent: refusing`);
    return doc;
  }
  /** Commit { gen, state } iff <gen>.json does not exist yet: true, false (lost the race), or StoreError (not durable). */
  commit(gen, state) {
    const tmp = path3.join(this.dir, `.tmp-${process.pid}-${randomBytes2(8).toString("hex")}`);
    try {
      fs3.mkdirSync(this.dir, { recursive: true, mode: 448 });
      const fd = fs3.openSync(tmp, "wx", 384);
      try {
        fs3.writeSync(fd, JSON.stringify({ gen, state }) + "\n");
        fs3.fsyncSync(fd);
      } finally {
        fs3.closeSync(fd);
      }
    } catch (e) {
      try {
        fs3.rmSync(tmp, { force: true });
      } catch {
      }
      throw new StoreError(`could not write state generation ${gen} (${e.code || e.message})`);
    }
    try {
      fs3.linkSync(tmp, path3.join(this.dir, `${gen}.json`));
    } catch (e) {
      fs3.rmSync(tmp, { force: true });
      if (e.code === "EEXIST") return false;
      throw new StoreError(`could not commit state generation ${gen} (${e.code || e.message})`);
    }
    fs3.rmSync(tmp, { force: true });
    try {
      const dfd = fs3.openSync(this.dir, "r");
      try {
        fs3.fsyncSync(dfd);
      } finally {
        fs3.closeSync(dfd);
      }
    } catch (e) {
      throw new StoreError(`could not make generation ${gen} durable (${e.code || e.message})`);
    }
    for (const g of this.gens()) if (g <= gen - KEEP) fs3.rmSync(path3.join(this.dir, `${g}.json`), { force: true });
    return true;
  }
  /** The first generation (install): refused if any generation exists, including one a concurrent install committed. */
  init(state) {
    if (this.latest()) return { ok: false, reason: "a client is already installed in this state directory: anchors are not replaced in place" };
    if (!this.commit(1, state)) return { ok: false, reason: "a concurrent install committed first: anchors are not replaced in place" };
    return { ok: true, gen: 1, state };
  }
  /**
   * Read-verify-commit, retried on a lost race. fn(state, gen) returns { state } (commit it), { same: true } (nothing to
   * record: already the committed state) or { refuse: reason }. Returns { ok, gen, state } or { ok: false, reason }.
   */
  async update(fn, { tries = 64 } = {}) {
    for (let i = 0; i < tries; i++) {
      const cur = this.latest();
      if (!cur) throw new StoreError("no client installed");
      const r = await fn(cur.state, cur.gen);
      if (r.refuse !== void 0) {
        const now = this.latest();
        if (now && now.gen === cur.gen) return { ok: false, reason: r.refuse, gen: cur.gen };
        continue;
      }
      if (r.same || canon(r.state) === canon(cur.state)) {
        const now = this.latest();
        if (now && now.gen === cur.gen) return { ok: true, gen: cur.gen, state: cur.state, same: true };
        continue;
      }
      if (this.commit(cur.gen + 1, r.state)) return { ok: true, gen: cur.gen + 1, state: r.state };
    }
    throw new StoreError("the state kept changing under this commit: refusing");
  }
};

// src/gate.js
var HEX2 = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
var V3 = "enclave-pvm-app-evidence/v3";
var hexOf = (v) => v && typeof v === "object" && typeof v.hex === "string" ? v.hex : v instanceof Uint8Array ? toHex(v) : typeof v === "string" ? v : null;
var hold = (reason) => ({ decision: "hold", reason: `HOLD: ${reason}`, pinned: null });
async function admit(verdict, expect = {}, { clientKind, observedPeerSpki = null, usedNonces = [] } = {}) {
  if (clientKind !== "native" && clientKind !== "browser") return hold(`unknown client kind ${JSON.stringify(clientKind)}`);
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) return hold("malformed verdict (not an object)");
  const c = verdict.claims || {};
  if (c.technology !== "android-avf" || c.family !== "pvm-app") return hold(`no admission rule in this client for technology ${JSON.stringify(c.technology)}`);
  if (verdict.status !== "verified") return hold(`the verdict is ${JSON.stringify(verdict.status)}, not verified`);
  if (verdict.admissionSafe !== true) return hold("the verdict is not admission-safe");
  if (!Array.isArray(verdict.omissions) || verdict.omissions.length) return hold("the verdict lists omissions");
  const checks = verdict.checks && typeof verdict.checks === "object" ? Object.entries(verdict.checks) : [];
  if (!checks.length || checks.some(([, v]) => v !== true)) return hold("a check is not true");
  for (const k of ["allowedRuntimeIds", "allowedCodeHashes", "allowedAuthorityHashes", "rootPins"])
    if (!Array.isArray(expect[k]) || !expect[k].length) return hold(`client supplied no ${k}`);
  const nonce = hexOf(expect.nonce), app = hexOf(expect.appId);
  if (!nonce || !HEX2(64).test(nonce) || c.freshness !== "client-nonce" || c.nonce !== nonce) return hold("the verifier compared a different challenge than the client's");
  if ((usedNonces || []).map(hexOf).includes(nonce)) return hold("the challenge was used before: a replayed exchange, whatever its verdict");
  if (!app || c.appId !== app) return hold("the verified app id is not the client's expected app");
  if (!expect.allowedRuntimeIds.includes(c.runtimeId)) return hold("the verified runtime id is not one the client admits");
  if (typeof c.transportSpki !== "string" || !/^302a300506032b6570032100[0-9a-f]{64}$/.test(c.transportSpki)) return hold("the verdict binds no transport key");
  if (expect.instanceIds !== void 0) {
    if (!Array.isArray(expect.instanceIds) || !expect.instanceIds.length || !expect.instanceIds.every((i) => typeof i === "string" && HEX2(64).test(i)))
      return hold("the client's instance expectation is malformed");
    if (c.format !== V3) return hold("the deployment is bound to instances, and the evidence format names none: a downgrade");
    if (typeof c.instanceId !== "string" || !expect.instanceIds.includes(c.instanceId)) return hold("the verified instance is not one bound to the selected deployment");
  }
  if (clientKind === "native") {
    const peer = hexOf(observedPeerSpki);
    if (!peer) return hold("native client: no peer key observed on this connection");
    if (peer !== c.transportSpki) return hold("the peer key this connection presented is not the key the evidence binds");
    return { decision: "release", reason: "RELEASE", pinned: { transportSpkiSha256: toHex(await sha256(fromHex(c.transportSpki))) } };
  }
  if (c.format !== "enclave-pvm-app-evidence/v2" && c.format !== V3 || typeof c.appKey !== "string" || !HEX2(64).test(c.appKey))
    return hold("browser client: the evidence binds no application-layer public key, and browser code cannot read the peer TLS certificate, so nothing can be pinned");
  const s = c.sealed;
  if (!s || !Number.isSafeInteger(s.windowSeconds) || !Number.isSafeInteger(s.maxRequests) || s.windowSeconds < 1 || s.maxRequests < 1)
    return hold("browser client: the evidence states no sealed window");
  return { decision: "release", reason: "RELEASE", pinned: { appKey: c.appKey, sealed: { windowSeconds: s.windowSeconds, maxRequests: s.maxRequests } } };
}
async function verdictOf(v, env, nonceHex) {
  return {
    status: v.ok ? "verified" : "rejected",
    admissionSafe: v.ok === true,
    omissions: [],
    checks: { "echo matches client": !!env && env.nonce === nonceHex, pvmEvidence: v.ok === true },
    claims: {
      technology: "android-avf",
      family: "pvm-app",
      format: env && env.format,
      freshness: v.freshness,
      nonce: env && env.nonce,
      appId: v.appId,
      runtimeId: v.runtimeId,
      transportSpki: v.transportSpki,
      transportSpkiSha256: v.transportSpki ? toHex(await sha256(fromHex(v.transportSpki))) : null,
      appKey: v.appKey,
      sealed: v.appKey ? { windowSeconds: v.sealedWindowSeconds, maxRequests: v.sealedMaxRequests } : null,
      instanceId: v.instanceId || null
    }
  };
}

// ../web/vendor/hpke-core-1.9.0.js
var HpkeError = class extends Error {
  constructor(e) {
    let message;
    if (e instanceof Error) {
      message = e.message;
    } else if (typeof e === "string") {
      message = e;
    } else {
      message = "";
    }
    super(message);
    this.name = this.constructor.name;
  }
};
var InvalidParamError = class extends HpkeError {
};
var SerializeError = class extends HpkeError {
};
var DeserializeError = class extends HpkeError {
};
var EncapError = class extends HpkeError {
};
var DecapError = class extends HpkeError {
};
var ExportError = class extends HpkeError {
};
var SealError = class extends HpkeError {
};
var OpenError = class extends HpkeError {
};
var MessageLimitReachedError = class extends HpkeError {
};
var DeriveKeyPairError = class extends HpkeError {
};
var NotSupportedError = class extends HpkeError {
};
var dntGlobals = {};
var dntGlobalThis = createMergeProxy(globalThis, dntGlobals);
function createMergeProxy(baseObj, extObj) {
  return new Proxy(baseObj, {
    get(_target, prop, _receiver) {
      if (prop in extObj) {
        return extObj[prop];
      } else {
        return baseObj[prop];
      }
    },
    set(_target, prop, value) {
      if (prop in extObj) {
        delete extObj[prop];
      }
      baseObj[prop] = value;
      return true;
    },
    deleteProperty(_target, prop) {
      let success = false;
      if (prop in extObj) {
        delete extObj[prop];
        success = true;
      }
      if (prop in baseObj) {
        delete baseObj[prop];
        success = true;
      }
      return success;
    },
    ownKeys(_target) {
      const baseKeys = Reflect.ownKeys(baseObj);
      const extKeys = Reflect.ownKeys(extObj);
      const extKeysSet = new Set(extKeys);
      return [...baseKeys.filter((k) => !extKeysSet.has(k)), ...extKeys];
    },
    defineProperty(_target, prop, desc) {
      if (prop in extObj) {
        delete extObj[prop];
      }
      Reflect.defineProperty(baseObj, prop, desc);
      return true;
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (prop in extObj) {
        return Reflect.getOwnPropertyDescriptor(extObj, prop);
      } else {
        return Reflect.getOwnPropertyDescriptor(baseObj, prop);
      }
    },
    has(_target, prop) {
      return prop in extObj || prop in baseObj;
    }
  });
}
async function loadSubtleCrypto() {
  if (dntGlobalThis !== void 0 && globalThis.crypto !== void 0) {
    return globalThis.crypto.subtle;
  }
  try {
    const { webcrypto } = await import("crypto");
    return webcrypto.subtle;
  } catch (e) {
    throw new NotSupportedError(e);
  }
}
var NativeAlgorithm = class {
  constructor() {
    Object.defineProperty(this, "_api", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
  }
  async _setup() {
    if (this._api !== void 0) {
      return;
    }
    this._api = await loadSubtleCrypto();
  }
};
var Mode = {
  Base: 0,
  Psk: 1,
  Auth: 2,
  AuthPsk: 3
};
var KemId = {
  NotAssigned: 0,
  DhkemP256HkdfSha256: 16,
  DhkemP384HkdfSha384: 17,
  DhkemP521HkdfSha512: 18,
  DhkemSecp256k1HkdfSha256: 19,
  DhkemX25519HkdfSha256: 32,
  DhkemX448HkdfSha512: 33,
  HybridkemX25519Kyber768: 48,
  MlKem512: 64,
  MlKem768: 65,
  MlKem1024: 66,
  XWing: 25722
};
var KdfId = {
  HkdfSha256: 1,
  HkdfSha384: 2,
  HkdfSha512: 3,
  Sha3256: 4,
  Sha3384: 5,
  Sha3512: 6,
  Shake128: 16,
  Shake256: 17,
  TurboShake128: 18,
  TurboShake256: 19
};
var AeadId = {
  Aes128Gcm: 1,
  Aes256Gcm: 2,
  Chacha20Poly1305: 3,
  ExportOnly: 65535
};
var INPUT_LENGTH_LIMIT = 8192;
var INFO_LENGTH_LIMIT = 268435456;
var MINIMUM_PSK_LENGTH = 32;
var EMPTY = /* @__PURE__ */ new Uint8Array(0);
var SUITE_ID_HEADER_KEM = /* @__PURE__ */ new Uint8Array([
  75,
  69,
  77,
  0,
  0
]);
var HPKE_VERSION = /* @__PURE__ */ new Uint8Array([
  72,
  80,
  75,
  69,
  45,
  118,
  49
]);
function toUint8Array(input) {
  return new Uint8Array(toArrayBuffer(input));
}
function toArrayBuffer(input) {
  if (input instanceof ArrayBuffer) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice().buffer;
  }
  return new Uint8Array(input).slice().buffer;
}
var HkdfNative = class extends NativeAlgorithm {
  constructor() {
    super();
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KdfId.HkdfSha256
    });
    Object.defineProperty(this, "hashSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "_suiteId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: EMPTY
    });
    Object.defineProperty(this, "algHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        name: "HMAC",
        hash: "SHA-256",
        length: 256
      }
    });
  }
  init(suiteId) {
    this._suiteId = suiteId;
  }
  buildLabeledIkm(label, ikm) {
    this._checkInit();
    const ret = new Uint8Array(7 + this._suiteId.byteLength + label.byteLength + ikm.byteLength);
    ret.set(HPKE_VERSION, 0);
    ret.set(this._suiteId, 7);
    ret.set(label, 7 + this._suiteId.byteLength);
    ret.set(ikm, 7 + this._suiteId.byteLength + label.byteLength);
    return ret;
  }
  buildLabeledInfo(label, info, len) {
    this._checkInit();
    const ret = new Uint8Array(9 + this._suiteId.byteLength + label.byteLength + info.byteLength);
    ret.set(new Uint8Array([0, len]), 0);
    ret.set(HPKE_VERSION, 2);
    ret.set(this._suiteId, 9);
    ret.set(label, 9 + this._suiteId.byteLength);
    ret.set(info, 9 + this._suiteId.byteLength + label.byteLength);
    return ret;
  }
  async extract(salt, ikm) {
    await this._setup();
    const saltBuf = salt.byteLength === 0 ? new ArrayBuffer(this.hashSize) : toArrayBuffer(salt);
    if (saltBuf.byteLength !== this.hashSize) {
      throw new InvalidParamError("The salt length must be the same as the hashSize");
    }
    const ikmBuf = toArrayBuffer(ikm);
    const key = await this._api.importKey("raw", saltBuf, this.algHash, false, [
      "sign"
    ]);
    return await this._api.sign("HMAC", key, ikmBuf);
  }
  async expand(prk, info, len) {
    await this._setup();
    const prkBuf = toArrayBuffer(prk);
    const key = await this._api.importKey("raw", prkBuf, this.algHash, false, [
      "sign"
    ]);
    const okm = new ArrayBuffer(len);
    const okmBytes = new Uint8Array(okm);
    let prev = EMPTY;
    const mid = toUint8Array(info);
    const tail = new Uint8Array(1);
    if (len > 255 * this.hashSize) {
      throw new Error("Entropy limit reached");
    }
    const tmp = new Uint8Array(this.hashSize + mid.length + 1);
    for (let i = 1, cur = 0; cur < okmBytes.length; i++) {
      tail[0] = i;
      tmp.set(prev, 0);
      tmp.set(mid, prev.length);
      tmp.set(tail, prev.length + mid.length);
      prev = new Uint8Array(await this._api.sign("HMAC", key, tmp.slice(0, prev.length + mid.length + 1)));
      if (okmBytes.length - cur >= prev.length) {
        okmBytes.set(prev, cur);
        cur += prev.length;
      } else {
        okmBytes.set(prev.slice(0, okmBytes.length - cur), cur);
        cur += okmBytes.length - cur;
      }
    }
    return okm;
  }
  async extractAndExpand(salt, ikm, info, len) {
    await this._setup();
    const ikmBuf = toArrayBuffer(ikm);
    const baseKey = await this._api.importKey("raw", ikmBuf, "HKDF", false, ["deriveBits"]);
    return await this._api.deriveBits({
      name: "HKDF",
      hash: this.algHash.hash,
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(info)
    }, baseKey, len * 8);
  }
  async labeledExtract(salt, label, ikm) {
    return await this.extract(salt, this.buildLabeledIkm(label, ikm));
  }
  async labeledExpand(prk, label, info, len) {
    return await this.expand(prk, this.buildLabeledInfo(label, info, len), len);
  }
  _checkInit() {
    if (this._suiteId === EMPTY) {
      throw new Error("Not initialized. Call init()");
    }
  }
};
var HkdfSha256Native = class extends HkdfNative {
  constructor() {
    super(...arguments);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KdfId.HkdfSha256
    });
    Object.defineProperty(this, "hashSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "algHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        name: "HMAC",
        hash: "SHA-256",
        length: 256
      }
    });
  }
};
var isCryptoKeyPair = (x) => typeof x === "object" && x !== null && typeof x.privateKey === "object" && typeof x.publicKey === "object";
function i2Osp(n, w) {
  if (w <= 0) {
    throw new Error("i2Osp: too small size");
  }
  if (n >= 256 ** w) {
    throw new Error("i2Osp: too large integer");
  }
  const ret = new Uint8Array(w);
  for (let i = 0; i < w && n; i++) {
    ret[w - (i + 1)] = n % 256;
    n = Math.floor(n / 256);
  }
  return ret;
}
function concat(a, b2) {
  const ret = new Uint8Array(a.length + b2.length);
  ret.set(a, 0);
  ret.set(b2, a.length);
  return ret;
}
function base64UrlToBytes(v) {
  const base64 = v.replace(/-/g, "+").replace(/_/g, "/");
  const byteString = atob(base64);
  const ret = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    ret[i] = byteString.charCodeAt(i);
  }
  return ret;
}
function xor(a, b2) {
  if (a.byteLength !== b2.byteLength) {
    throw new Error("xor: different length inputs");
  }
  const buf = new Uint8Array(a.byteLength);
  for (let i = 0; i < a.byteLength; i++) {
    buf[i] = a[i] ^ b2[i];
  }
  return buf;
}
var LABEL_EAE_PRK = /* @__PURE__ */ new Uint8Array([
  101,
  97,
  101,
  95,
  112,
  114,
  107
]);
var LABEL_SHARED_SECRET = /* @__PURE__ */ new Uint8Array([
  115,
  104,
  97,
  114,
  101,
  100,
  95,
  115,
  101,
  99,
  114,
  101,
  116
]);
function concat3(a, b2, c) {
  const ret = new Uint8Array(a.length + b2.length + c.length);
  ret.set(a, 0);
  ret.set(b2, a.length);
  ret.set(c, a.length + b2.length);
  return ret;
}
var Dhkem = class {
  constructor(id, prim, kdf) {
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "secretSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "encSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "publicKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "privateKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "_prim", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_kdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this.id = id;
    this._prim = prim;
    this._kdf = kdf;
    const suiteId = new Uint8Array(SUITE_ID_HEADER_KEM);
    suiteId.set(i2Osp(this.id, 2), 3);
    this._kdf.init(suiteId);
  }
  async serializePublicKey(key) {
    return await this._prim.serializePublicKey(key);
  }
  async deserializePublicKey(key) {
    return await this._prim.deserializePublicKey(toArrayBuffer(key));
  }
  async serializePrivateKey(key) {
    return await this._prim.serializePrivateKey(key);
  }
  async deserializePrivateKey(key) {
    return await this._prim.deserializePrivateKey(toArrayBuffer(key));
  }
  async importKey(format, key, isPublic = true) {
    return await this._prim.importKey(format, key, isPublic);
  }
  async generateKeyPair() {
    return await this._prim.generateKeyPair();
  }
  async deriveKeyPair(ikm) {
    const rawIkm = toArrayBuffer(ikm);
    if (rawIkm.byteLength > INPUT_LENGTH_LIMIT) {
      throw new InvalidParamError("Too long ikm");
    }
    return await this._prim.deriveKeyPair(rawIkm);
  }
  async encap(params) {
    let ke;
    if (params.ekm === void 0) {
      ke = await this.generateKeyPair();
    } else if (isCryptoKeyPair(params.ekm)) {
      ke = params.ekm;
    } else {
      ke = await this.deriveKeyPair(params.ekm);
    }
    const enc = await this._prim.serializePublicKey(ke.publicKey);
    const pkrm = await this._prim.serializePublicKey(params.recipientPublicKey);
    try {
      let dh;
      if (params.senderKey === void 0) {
        dh = new Uint8Array(await this._prim.dh(ke.privateKey, params.recipientPublicKey));
      } else {
        const sks = isCryptoKeyPair(params.senderKey) ? params.senderKey.privateKey : params.senderKey;
        const dh1 = new Uint8Array(await this._prim.dh(ke.privateKey, params.recipientPublicKey));
        const dh2 = new Uint8Array(await this._prim.dh(sks, params.recipientPublicKey));
        dh = concat(dh1, dh2);
      }
      let kemContext;
      if (params.senderKey === void 0) {
        kemContext = concat(new Uint8Array(enc), new Uint8Array(pkrm));
      } else {
        const pks = isCryptoKeyPair(params.senderKey) ? params.senderKey.publicKey : await this._prim.derivePublicKey(params.senderKey);
        const pksm = await this._prim.serializePublicKey(pks);
        kemContext = concat3(new Uint8Array(enc), new Uint8Array(pkrm), new Uint8Array(pksm));
      }
      const sharedSecret = await this._generateSharedSecret(dh, kemContext);
      return {
        enc,
        sharedSecret
      };
    } catch (e) {
      throw new EncapError(e);
    }
  }
  async decap(params) {
    const enc = toArrayBuffer(params.enc);
    const pke = await this._prim.deserializePublicKey(enc);
    const skr = isCryptoKeyPair(params.recipientKey) ? params.recipientKey.privateKey : params.recipientKey;
    const pkr = isCryptoKeyPair(params.recipientKey) ? params.recipientKey.publicKey : await this._prim.derivePublicKey(params.recipientKey);
    const pkrm = await this._prim.serializePublicKey(pkr);
    try {
      let dh;
      if (params.senderPublicKey === void 0) {
        dh = new Uint8Array(await this._prim.dh(skr, pke));
      } else {
        const dh1 = new Uint8Array(await this._prim.dh(skr, pke));
        const dh2 = new Uint8Array(await this._prim.dh(skr, params.senderPublicKey));
        dh = concat(dh1, dh2);
      }
      let kemContext;
      if (params.senderPublicKey === void 0) {
        kemContext = concat(new Uint8Array(enc), new Uint8Array(pkrm));
      } else {
        const pksm = await this._prim.serializePublicKey(params.senderPublicKey);
        kemContext = new Uint8Array(enc.byteLength + pkrm.byteLength + pksm.byteLength);
        kemContext.set(new Uint8Array(enc), 0);
        kemContext.set(new Uint8Array(pkrm), enc.byteLength);
        kemContext.set(new Uint8Array(pksm), enc.byteLength + pkrm.byteLength);
      }
      return await this._generateSharedSecret(dh, kemContext);
    } catch (e) {
      throw new DecapError(e);
    }
  }
  async _generateSharedSecret(dh, kemContext) {
    const labeledIkm = this._kdf.buildLabeledIkm(LABEL_EAE_PRK, dh);
    const labeledInfo = this._kdf.buildLabeledInfo(LABEL_SHARED_SECRET, kemContext, this.secretSize);
    return await this._kdf.extractAndExpand(EMPTY, labeledIkm, labeledInfo, this.secretSize);
  }
};
var KEM_USAGES = ["deriveBits"];
var LABEL_DKP_PRK = /* @__PURE__ */ new Uint8Array([
  100,
  107,
  112,
  95,
  112,
  114,
  107
]);
var LABEL_SK = /* @__PURE__ */ new Uint8Array([115, 107]);
var EC_P_521_PARAMS = {
  p: (1n << 521n) - 1n,
  b: 0x0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00n,
  gx: 0x00c6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66n,
  gy: 0x011839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650n,
  coordinateSize: 66
};
var AEAD_USAGES = ["encrypt", "decrypt"];
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n, title = "") {
  if (!Number.isSafeInteger(n) || n < 0) {
    const prefix = title && `"${title}" `;
    throw new Error(`${prefix}expected integer >0, got ${n}`);
  }
}
function abytes(value, length, title = "") {
  const bytes = isBytes(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished) {
    throw new Error("Hash#digest() has already been called");
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
var _endianTestBuffer = /* @__PURE__ */ new Uint32Array([287454020]);
var _endianTestBytes = /* @__PURE__ */ new Uint8Array(_endianTestBuffer.buffer);
var isLE = _endianTestBytes[0] === 68;
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function") {
    throw new Error("Hash must wrapped by utils.createHasher");
  }
  anumber(h.outputLen);
  anumber(h.blockLen);
}
var _HMAC = class {
  constructor(hash, key) {
    Object.defineProperty(this, "oHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "iHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "blockLen", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "outputLen", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "finished", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: false
    });
    Object.defineProperty(this, "destroyed", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: false
    });
    ahash(hash);
    abytes(key, void 0, "key");
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function") {
      throw new Error("Expected instance of class which extends utils.Hash");
    }
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean(pad);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out2) {
    aexists(this);
    abytes(out2, this.outputLen, "output");
    this.finished = true;
    this.iHash.digestInto(out2);
    this.oHash.update(out2);
    this.oHash.digestInto(out2);
    this.destroy();
  }
  digest() {
    const out2 = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out2);
    return out2;
  }
  _cloneInto(to) {
    to ||= Object.create(Object.getPrototypeOf(this), {});
    const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
var hmac = (hash, key, message) => new _HMAC(hash, key).update(message).digest();
hmac.create = (hash, key) => new _HMAC(hash, key);
var U32_MASK64 = 0xffffffffn;
var _32n = 32n;
function fromBig(n, le = false) {
  if (le) {
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  }
  return {
    h: Number(n >> _32n & U32_MASK64) | 0,
    l: Number(n & U32_MASK64) | 0
  };
}
function split(lst, le = false) {
  const len = lst.length;
  const Ah = new Uint32Array(len);
  const Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
var _0n = 0n;
var _1n = 1n;
var _2n = 2n;
var _7n = 7n;
var _256n = 256n;
var _0x71n = 0x71n;
var SHA3_PI = [];
var SHA3_ROTL = [];
var _SHA3_IOTA = [];
for (let round = 0, R = _1n, x = 1, y = 0; round < 24; round++) {
  [x, y] = [y, (2 * x + 3 * y) % 5];
  SHA3_PI.push(2 * (5 * y + x));
  SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
  let t = _0n;
  for (let j = 0; j < 7; j++) {
    R = (R << _1n ^ (R >> _7n) * _0x71n) % _256n;
    if (R & _2n)
      t ^= _1n << (_1n << BigInt(j)) - _1n;
  }
  _SHA3_IOTA.push(t);
}
var IOTAS = split(_SHA3_IOTA, true);
var SHA3_IOTA_H = IOTAS[0];
var SHA3_IOTA_L = IOTAS[1];
var AesGcmContext = class extends NativeAlgorithm {
  constructor(key) {
    super();
    Object.defineProperty(this, "_rawKey", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_key", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this._rawKey = toArrayBuffer(key);
  }
  async seal(iv, data, aad) {
    await this._setupKey();
    const alg = {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad)
    };
    const ct = await this._api.encrypt(alg, this._key, toArrayBuffer(data));
    return ct;
  }
  async open(iv, data, aad) {
    await this._setupKey();
    const alg = {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad)
    };
    const pt = await this._api.decrypt(alg, this._key, toArrayBuffer(data));
    return pt;
  }
  async _setupKey() {
    if (this._key !== void 0) {
      return;
    }
    await this._setup();
    const key = await this._importKey(this._rawKey);
    new Uint8Array(this._rawKey).fill(0);
    this._key = key;
    return;
  }
  async _importKey(key) {
    return await this._api.importKey("raw", key, { name: "AES-GCM" }, true, AEAD_USAGES);
  }
};
var Aes128Gcm = class {
  constructor() {
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: AeadId.Aes128Gcm
    });
    Object.defineProperty(this, "keySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 16
    });
    Object.defineProperty(this, "nonceSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 12
    });
    Object.defineProperty(this, "tagSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 16
    });
  }
  createEncryptionContext(key) {
    return new AesGcmContext(key);
  }
};
function emitNotSupported() {
  return new Promise((_resolve, reject) => {
    reject(new NotSupportedError("Not supported"));
  });
}
var LABEL_SEC = new Uint8Array([115, 101, 99]);
var ExporterContextImpl = class {
  constructor(api, kdf, exporterSecret) {
    Object.defineProperty(this, "_api", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "exporterSecret", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_kdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this._api = api;
    this._kdf = kdf;
    this.exporterSecret = exporterSecret;
  }
  async seal(_data, _aad) {
    return await emitNotSupported();
  }
  async open(_data, _aad) {
    return await emitNotSupported();
  }
  async export(exporterContext, len) {
    const rawExporterContext = toArrayBuffer(exporterContext);
    if (rawExporterContext.byteLength > INPUT_LENGTH_LIMIT) {
      throw new InvalidParamError("Too long exporter context");
    }
    try {
      return await this._kdf.labeledExpand(this.exporterSecret, LABEL_SEC, new Uint8Array(rawExporterContext), len);
    } catch (e) {
      throw new ExportError(e);
    }
  }
};
var RecipientExporterContextImpl = class extends ExporterContextImpl {
};
var SenderExporterContextImpl = class extends ExporterContextImpl {
  constructor(api, kdf, exporterSecret, enc) {
    super(api, kdf, exporterSecret);
    Object.defineProperty(this, "enc", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this.enc = enc;
    return;
  }
};
var EncryptionContextImpl = class extends ExporterContextImpl {
  constructor(api, kdf, params) {
    super(api, kdf, params.exporterSecret);
    Object.defineProperty(this, "_aead", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nK", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nN", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nT", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_ctx", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    if (params.key === void 0 || params.baseNonce === void 0 || params.seq === void 0) {
      throw new Error("Required parameters are missing");
    }
    this._aead = params.aead;
    this._nK = this._aead.keySize;
    this._nN = this._aead.nonceSize;
    this._nT = this._aead.tagSize;
    const key = this._aead.createEncryptionContext(params.key);
    this._ctx = {
      key,
      baseNonce: params.baseNonce,
      seq: params.seq
    };
  }
  computeNonce(k) {
    const seqBytes = i2Osp(k.seq, k.baseNonce.byteLength);
    return xor(k.baseNonce, seqBytes).buffer;
  }
  incrementSeq(k) {
    if (k.seq > Number.MAX_SAFE_INTEGER) {
      throw new MessageLimitReachedError("Message limit reached");
    }
    k.seq += 1;
    return;
  }
};
var __classPrivateFieldGet = function(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet = function(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _Mutex_locked;
var Mutex = class {
  constructor() {
    _Mutex_locked.set(this, Promise.resolve());
  }
  async lock() {
    let releaseLock;
    const nextLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const previousLock = __classPrivateFieldGet(this, _Mutex_locked, "f");
    __classPrivateFieldSet(this, _Mutex_locked, nextLock, "f");
    await previousLock;
    return releaseLock;
  }
};
_Mutex_locked = /* @__PURE__ */ new WeakMap();
var __classPrivateFieldGet2 = function(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet2 = function(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _RecipientContextImpl_mutex;
var RecipientContextImpl = class extends EncryptionContextImpl {
  constructor() {
    super(...arguments);
    _RecipientContextImpl_mutex.set(this, void 0);
  }
  async open(data, aad = EMPTY.buffer) {
    __classPrivateFieldSet2(this, _RecipientContextImpl_mutex, __classPrivateFieldGet2(this, _RecipientContextImpl_mutex, "f") ?? new Mutex(), "f");
    const release = await __classPrivateFieldGet2(this, _RecipientContextImpl_mutex, "f").lock();
    let pt;
    try {
      pt = await this._ctx.key.open(this.computeNonce(this._ctx), toArrayBuffer(data), toArrayBuffer(aad));
    } catch (e) {
      throw new OpenError(e);
    } finally {
      release();
    }
    this.incrementSeq(this._ctx);
    return pt;
  }
};
_RecipientContextImpl_mutex = /* @__PURE__ */ new WeakMap();
var __classPrivateFieldGet3 = function(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet3 = function(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _SenderContextImpl_mutex;
var SenderContextImpl = class extends EncryptionContextImpl {
  constructor(api, kdf, params, enc) {
    super(api, kdf, params);
    Object.defineProperty(this, "enc", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    _SenderContextImpl_mutex.set(this, void 0);
    this.enc = enc;
  }
  async seal(data, aad = EMPTY.buffer) {
    __classPrivateFieldSet3(this, _SenderContextImpl_mutex, __classPrivateFieldGet3(this, _SenderContextImpl_mutex, "f") ?? new Mutex(), "f");
    const release = await __classPrivateFieldGet3(this, _SenderContextImpl_mutex, "f").lock();
    let ct;
    try {
      ct = await this._ctx.key.seal(this.computeNonce(this._ctx), toArrayBuffer(data), toArrayBuffer(aad));
    } catch (e) {
      throw new SealError(e);
    } finally {
      release();
    }
    this.incrementSeq(this._ctx);
    return ct;
  }
};
_SenderContextImpl_mutex = /* @__PURE__ */ new WeakMap();
var LABEL_BASE_NONCE = new Uint8Array([
  98,
  97,
  115,
  101,
  95,
  110,
  111,
  110,
  99,
  101
]);
var LABEL_EXP = new Uint8Array([101, 120, 112]);
var LABEL_INFO_HASH = new Uint8Array([
  105,
  110,
  102,
  111,
  95,
  104,
  97,
  115,
  104
]);
var LABEL_KEY = new Uint8Array([107, 101, 121]);
var LABEL_PSK_ID_HASH = new Uint8Array([
  112,
  115,
  107,
  95,
  105,
  100,
  95,
  104,
  97,
  115,
  104
]);
var LABEL_SECRET = new Uint8Array([115, 101, 99, 114, 101, 116]);
var SUITE_ID_HEADER_HPKE = new Uint8Array([
  72,
  80,
  75,
  69,
  0,
  0,
  0,
  0,
  0,
  0
]);
var CipherSuiteNative = class extends NativeAlgorithm {
  /**
   * @param params A set of parameters for building a cipher suite.
   *
   * If the error occurred, throws {@link InvalidParamError}.
   *
   * @throws {@link InvalidParamError}
   */
  constructor(params) {
    super();
    Object.defineProperty(this, "_kem", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_kdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_aead", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_suiteId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    if (typeof params.kem === "number") {
      throw new InvalidParamError("KemId cannot be used");
    }
    this._kem = params.kem;
    if (typeof params.kdf === "number") {
      throw new InvalidParamError("KdfId cannot be used");
    }
    this._kdf = params.kdf;
    if (typeof params.aead === "number") {
      throw new InvalidParamError("AeadId cannot be used");
    }
    this._aead = params.aead;
    this._suiteId = new Uint8Array(SUITE_ID_HEADER_HPKE);
    this._suiteId.set(i2Osp(this._kem.id, 2), 4);
    this._suiteId.set(i2Osp(this._kdf.id, 2), 6);
    this._suiteId.set(i2Osp(this._aead.id, 2), 8);
    this._kdf.init(this._suiteId);
  }
  /**
   * Gets the KEM context of the ciphersuite.
   */
  get kem() {
    return this._kem;
  }
  /**
   * Gets the KDF context of the ciphersuite.
   */
  get kdf() {
    return this._kdf;
  }
  /**
   * Gets the AEAD context of the ciphersuite.
   */
  get aead() {
    return this._aead;
  }
  /**
   * Creates an encryption context for a sender.
   *
   * If the error occurred, throws {@link DecapError} | {@link ValidationError}.
   *
   * @param params A set of parameters for the sender encryption context.
   * @returns A sender encryption context.
   * @throws {@link EncapError}, {@link ValidationError}
   */
  async createSenderContext(params) {
    this._validateInputLength(params);
    await this._setup();
    const dh = await this._kem.encap(params);
    let mode;
    if (params.psk !== void 0) {
      mode = params.senderKey !== void 0 ? Mode.AuthPsk : Mode.Psk;
    } else {
      mode = params.senderKey !== void 0 ? Mode.Auth : Mode.Base;
    }
    return await this._keyScheduleS(mode, dh.sharedSecret, dh.enc, params);
  }
  /**
   * Creates an encryption context for a recipient.
   *
   * If the error occurred, throws {@link DecapError}
   * | {@link DeserializeError} | {@link ValidationError}.
   *
   * @param params A set of parameters for the recipient encryption context.
   * @returns A recipient encryption context.
   * @throws {@link DecapError}, {@link DeserializeError}, {@link ValidationError}
   */
  async createRecipientContext(params) {
    this._validateInputLength(params);
    await this._setup();
    const sharedSecret = await this._kem.decap(params);
    let mode;
    if (params.psk !== void 0) {
      mode = params.senderPublicKey !== void 0 ? Mode.AuthPsk : Mode.Psk;
    } else {
      mode = params.senderPublicKey !== void 0 ? Mode.Auth : Mode.Base;
    }
    return await this._keyScheduleR(mode, sharedSecret, params);
  }
  /**
   * Encrypts a message to a recipient.
   *
   * If the error occurred, throws `EncapError` | `MessageLimitReachedError` | `SealError` | `ValidationError`.
   *
   * @param params A set of parameters for building a sender encryption context.
   * @param pt A plain text as bytes to be encrypted.
   * @param aad Additional authenticated data as bytes fed by an application.
   * @returns A cipher text and an encapsulated key as bytes.
   * @throws {@link EncapError}, {@link MessageLimitReachedError}, {@link SealError}, {@link ValidationError}
   */
  async seal(params, pt, aad = EMPTY.buffer) {
    const ctx = await this.createSenderContext(params);
    return {
      ct: await ctx.seal(pt, aad),
      enc: ctx.enc
    };
  }
  /**
   * Decrypts a message from a sender.
   *
   * If the error occurred, throws `DecapError` | `DeserializeError` | `OpenError` | `ValidationError`.
   *
   * @param params A set of parameters for building a recipient encryption context.
   * @param ct An encrypted text as bytes to be decrypted.
   * @param aad Additional authenticated data as bytes fed by an application.
   * @returns A decrypted plain text as bytes.
   * @throws {@link DecapError}, {@link DeserializeError}, {@link OpenError}, {@link ValidationError}
   */
  async open(params, ct, aad = EMPTY.buffer) {
    const ctx = await this.createRecipientContext(params);
    return await ctx.open(ct, aad);
  }
  // private verifyPskInputs(mode: Mode, params: KeyScheduleParams) {
  //   const gotPsk = (params.psk !== undefined);
  //   const gotPskId = (params.psk !== undefined && params.psk.id.byteLength > 0);
  //   if (gotPsk !== gotPskId) {
  //     throw new Error('Inconsistent PSK inputs');
  //   }
  //   if (gotPsk && (mode === Mode.Base || mode === Mode.Auth)) {
  //     throw new Error('PSK input provided when not needed');
  //   }
  //   if (!gotPsk && (mode === Mode.Psk || mode === Mode.AuthPsk)) {
  //     throw new Error('Missing required PSK input');
  //   }
  //   return;
  // }
  async _keySchedule(mode, sharedSecret, params) {
    const pskId = params.psk === void 0 ? EMPTY : toUint8Array(params.psk.id);
    const pskIdHash = await this._kdf.labeledExtract(EMPTY, LABEL_PSK_ID_HASH, pskId);
    const info = params.info === void 0 ? EMPTY : toUint8Array(params.info);
    const infoHash = await this._kdf.labeledExtract(EMPTY, LABEL_INFO_HASH, info);
    const keyScheduleContext = new Uint8Array(1 + pskIdHash.byteLength + infoHash.byteLength);
    keyScheduleContext.set(new Uint8Array([mode]), 0);
    keyScheduleContext.set(new Uint8Array(pskIdHash), 1);
    keyScheduleContext.set(new Uint8Array(infoHash), 1 + pskIdHash.byteLength);
    const psk = params.psk === void 0 ? EMPTY : toUint8Array(params.psk.key);
    const ikm = this._kdf.buildLabeledIkm(LABEL_SECRET, psk);
    const exporterSecretInfo = this._kdf.buildLabeledInfo(LABEL_EXP, keyScheduleContext, this._kdf.hashSize);
    const exporterSecret = await this._kdf.extractAndExpand(sharedSecret, ikm, exporterSecretInfo, this._kdf.hashSize);
    if (this._aead.id === AeadId.ExportOnly) {
      return { aead: this._aead, exporterSecret };
    }
    const keyInfo = this._kdf.buildLabeledInfo(LABEL_KEY, keyScheduleContext, this._aead.keySize);
    const key = await this._kdf.extractAndExpand(sharedSecret, ikm, keyInfo, this._aead.keySize);
    const baseNonceInfo = this._kdf.buildLabeledInfo(LABEL_BASE_NONCE, keyScheduleContext, this._aead.nonceSize);
    const baseNonce = await this._kdf.extractAndExpand(sharedSecret, ikm, baseNonceInfo, this._aead.nonceSize);
    return {
      aead: this._aead,
      exporterSecret,
      key,
      baseNonce: new Uint8Array(baseNonce),
      seq: 0
    };
  }
  async _keyScheduleS(mode, sharedSecret, enc, params) {
    const res = await this._keySchedule(mode, sharedSecret, params);
    if (res.key === void 0) {
      return new SenderExporterContextImpl(this._api, this._kdf, res.exporterSecret, enc);
    }
    return new SenderContextImpl(this._api, this._kdf, res, enc);
  }
  async _keyScheduleR(mode, sharedSecret, params) {
    const res = await this._keySchedule(mode, sharedSecret, params);
    if (res.key === void 0) {
      return new RecipientExporterContextImpl(this._api, this._kdf, res.exporterSecret);
    }
    return new RecipientContextImpl(this._api, this._kdf, res);
  }
  _validateInputLength(params) {
    if (params.info !== void 0 && params.info.byteLength > INFO_LENGTH_LIMIT) {
      throw new InvalidParamError("Too long info");
    }
    if (params.psk !== void 0) {
      if (params.psk.key.byteLength < MINIMUM_PSK_LENGTH) {
        throw new InvalidParamError(`PSK must have at least ${MINIMUM_PSK_LENGTH} bytes`);
      }
      if (params.psk.key.byteLength > INPUT_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long psk.key");
      }
      if (params.psk.id.byteLength > INPUT_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long psk.id");
      }
    }
    return;
  }
};
var CipherSuite = class extends CipherSuiteNative {
};
var HkdfSha256 = class extends HkdfSha256Native {
};
var ALG_NAME = "X25519";
var PKCS8_ALG_ID_X25519 = new Uint8Array([
  48,
  46,
  2,
  1,
  0,
  48,
  5,
  6,
  3,
  43,
  101,
  110,
  4,
  34,
  4,
  32
]);
var BASE_POINT_X25519 = /* @__PURE__ */ (() => {
  const p = new Uint8Array(32);
  p[0] = 9;
  return p;
})();
var X25519 = class extends NativeAlgorithm {
  constructor(hkdf) {
    super();
    Object.defineProperty(this, "_hkdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_alg", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nPk", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nSk", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nDh", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_pkcs8AlgId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this._alg = { name: ALG_NAME };
    this._hkdf = hkdf;
    this._nPk = 32;
    this._nSk = 32;
    this._nDh = 32;
    this._pkcs8AlgId = PKCS8_ALG_ID_X25519;
  }
  async serializePublicKey(key) {
    await this._setup();
    try {
      return await this._api.exportKey("raw", key);
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async deserializePublicKey(key) {
    await this._setup();
    try {
      return await this._importRawKey(toArrayBuffer(key), true);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async serializePrivateKey(key) {
    await this._setup();
    try {
      const jwk = await this._api.exportKey("jwk", key);
      if (!("d" in jwk)) {
        throw new Error("Not private key");
      }
      return base64UrlToBytes(jwk["d"]).buffer;
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async deserializePrivateKey(key) {
    await this._setup();
    try {
      return await this._importRawKey(toArrayBuffer(key), false);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async importKey(format, key, isPublic) {
    await this._setup();
    try {
      if (format === "raw") {
        return await this._importRawKey(key, isPublic);
      }
      if (key instanceof ArrayBuffer) {
        throw new Error("Invalid jwk key format");
      }
      return await this._importJWK(key, isPublic);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async generateKeyPair() {
    await this._setup();
    try {
      return await this._api.generateKey(ALG_NAME, true, KEM_USAGES);
    } catch (e) {
      throw new NotSupportedError(e);
    }
  }
  async deriveKeyPair(ikm) {
    await this._setup();
    try {
      const rawIkm = toArrayBuffer(ikm);
      const dkpPrk = await this._hkdf.labeledExtract(EMPTY, LABEL_DKP_PRK, new Uint8Array(rawIkm));
      const rawSk = await this._hkdf.labeledExpand(dkpPrk, LABEL_SK, EMPTY, this._nSk);
      const rawSkBytes = new Uint8Array(rawSk);
      const sk = await this._deserializePkcs8Key(rawSkBytes);
      rawSkBytes.fill(0);
      return {
        privateKey: sk,
        publicKey: await this.derivePublicKey(sk)
      };
    } catch (e) {
      throw new DeriveKeyPairError(e);
    }
  }
  async derivePublicKey(key) {
    await this._setup();
    try {
      const jwk = await this._api.exportKey("jwk", key);
      delete jwk["d"];
      delete jwk["key_ops"];
      return await this._api.importKey("jwk", jwk, this._alg, true, []);
    } catch {
      try {
        const bp = await this._api.importKey("raw", BASE_POINT_X25519.buffer, this._alg, true, []);
        const bits = await this._api.deriveBits({
          name: ALG_NAME,
          public: bp
        }, key, this._nPk * 8);
        return await this._api.importKey("raw", bits, this._alg, true, []);
      } catch (e) {
        throw new DeserializeError(e);
      }
    }
  }
  async dh(sk, pk) {
    await this._setup();
    try {
      const bits = await this._api.deriveBits({
        name: ALG_NAME,
        public: pk
      }, sk, this._nDh * 8);
      return bits;
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async _importRawKey(key, isPublic) {
    if (isPublic && key.byteLength !== this._nPk) {
      throw new Error("Invalid public key for the ciphersuite");
    }
    if (!isPublic && key.byteLength !== this._nSk) {
      throw new Error("Invalid private key for the ciphersuite");
    }
    if (isPublic) {
      return await this._api.importKey("raw", key, this._alg, true, []);
    }
    return await this._deserializePkcs8Key(new Uint8Array(key));
  }
  async _importJWK(key, isPublic) {
    if (typeof key.kty === "undefined" || key.kty !== "OKP") {
      throw new Error(`Invalid kty: ${key.crv}`);
    }
    if (typeof key.crv === "undefined" || key.crv !== ALG_NAME) {
      throw new Error(`Invalid crv: ${key.crv}`);
    }
    if (isPublic) {
      if (typeof key.d !== "undefined") {
        throw new Error("Invalid key: `d` should not be set");
      }
      return await this._api.importKey("jwk", key, this._alg, true, []);
    }
    if (typeof key.d === "undefined") {
      throw new Error("Invalid key: `d` not found");
    }
    return await this._api.importKey("jwk", key, this._alg, true, KEM_USAGES);
  }
  async _deserializePkcs8Key(k) {
    const pkcs8Key = new Uint8Array(this._pkcs8AlgId.length + k.length);
    pkcs8Key.set(this._pkcs8AlgId, 0);
    pkcs8Key.set(k, this._pkcs8AlgId.length);
    return await this._api.importKey("pkcs8", pkcs8Key, this._alg, true, KEM_USAGES);
  }
};
var DhkemX25519HkdfSha256 = class extends Dhkem {
  constructor() {
    const kdf = new HkdfSha256Native();
    super(KemId.DhkemX25519HkdfSha256, new X25519(kdf), kdf);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KemId.DhkemX25519HkdfSha256
    });
    Object.defineProperty(this, "secretSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "encSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "publicKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "privateKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
  }
};
var PKCS8_ALG_ID_X448 = new Uint8Array([
  48,
  70,
  2,
  1,
  0,
  48,
  5,
  6,
  3,
  43,
  101,
  111,
  4,
  58,
  4,
  56
]);

// ../web/pvm-sealed.js
var LABEL = "enclave-pvm-sealed-http/v1";
var HDR = Uint8Array.of(0, 0, 32, 0, 1, 0, 1);
var HDR_CHUNKED = Uint8Array.of(1, 0, 32, 0, 1, 0, 1);
var CHUNK = { DATA: 0, FIN: 1, ABORT: 2 };
var CHUNK_AAD_LABEL = "enclave-pvm-sealed-chunk-v1";
var CHUNK_PLAINTEXT = 16384;
var MAX_CHUNK_CT = CHUNK_PLAINTEXT + 16;
var MAX_CHUNKS = 2 ** 20;
var MAX_STREAM_BYTES = 16 << 20;
var te3 = new TextEncoder();
var td2 = new TextDecoder();
var subtle3 = () => globalThis.crypto.subtle;
var suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
var b = (x) => typeof x === "string" ? fromHex(x) : x;
var requestInfo = (appId, runtimeId, chunked = false) => cat(te3.encode(`${LABEL}${chunked ? " chunked" : ""} request`), Uint8Array.of(0), chunked ? HDR_CHUNKED : HDR, b(appId), b(runtimeId));
async function sealRequest({ appKey, appId, runtimeId, nonce, request, chunked = false }, ekm = void 0) {
  const pkR = b(appKey), a = b(appId), r = b(runtimeId), n = b(nonce);
  if (pkR.length !== 32 || a.length !== 32 || r.length !== 32 || n.length !== 32) throw new Error("appKey, appId, runtimeId and nonce are 32 bytes each");
  const pt = typeof request === "string" ? te3.encode(request) : request;
  const recipientPublicKey = await suite.kem.deserializePublicKey(pkR);
  const sender = await suite.createSenderContext({ recipientPublicKey, info: requestInfo(a, r, chunked), ...ekm ? { ekm } : {} });
  const ct = new Uint8Array(await sender.seal(pt, n));
  const enc = new Uint8Array(sender.enc);
  const secret = new Uint8Array(await sender.export(te3.encode(`${LABEL}${chunked ? " chunked" : ""} response`), 16));
  const body2 = cat(n, chunked ? HDR_CHUNKED : HDR, enc, ct);
  const frame = cat(Uint8Array.of(body2.length >>> 24, body2.length >>> 16 & 255, body2.length >>> 8 & 255, body2.length & 255), body2);
  return { frame, ctx: { enc, secret, nonce: n, chunked } };
}
async function responseKeys(ctx, rn, usage = "decrypt") {
  const ikm = await subtle3().importKey("raw", ctx.secret, "HKDF", false, ["deriveBits"]);
  const salt = cat(ctx.enc, rn);
  const kb = new Uint8Array(await subtle3().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te3.encode("key") }, ikm, 128));
  const base = new Uint8Array(await subtle3().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te3.encode("nonce") }, ikm, 96));
  return { key: await subtle3().importKey("raw", kb, "AES-GCM", false, [usage]), base };
}
var gcm = async (op, key, iv, data, aad) => new Uint8Array(await subtle3()[op]({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, data));
async function openResponse(ctx, bytes) {
  const x = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (ctx.chunked) return { ok: false, refused: "a chunked request's answer is a stream: openStream" };
  if (!x.length) return { ok: false, refused: "no answer (the carrier gave nothing)" };
  if (x[0] === 1) return { ok: false, refused: `the VM refused (unauthenticated hint): ${td2.decode(x.subarray(1, 300))}` };
  if (x[0] !== 0 || x.length < 1 + 16 + 16) return { ok: false, refused: "the answer is not a sealed response" };
  const rn = x.subarray(1, 17), { key, base } = await responseKeys(ctx, rn);
  try {
    return { ok: true, response: await gcm("decrypt", key, base, x.subarray(17), new Uint8Array(0)) };
  } catch {
    return { ok: false, refused: "the answer does not open under this request's keys (tampered, or not from the VM)" };
  }
}
function chunkNonce(base, i) {
  const n = base.slice(), c = new DataView(new ArrayBuffer(8));
  c.setBigUint64(0, BigInt(i));
  for (let k = 0; k < 8; k++) n[4 + k] ^= c.getUint8(k);
  return n;
}
function chunkAad(nonce, rn, i, type) {
  const c = new DataView(new ArrayBuffer(8));
  c.setBigUint64(0, BigInt(i));
  return cat(te3.encode(CHUNK_AAD_LABEL), nonce, rn, new Uint8Array(c.buffer), Uint8Array.of(type));
}
async function openStream(ctx, source, { onData = () => {
}, signal } = {}) {
  let buf = new Uint8Array(0), state = "status", keys = null, rn = null, i = 0, bytes = 0, end = null;
  const out2 = (o) => ({ chunks: i, bytes, complete: false, ...o });
  const fail = (error, detail) => {
    end = out2({ ok: false, error, detail });
    return end;
  };
  const step = async () => {
    for (; ; ) {
      if (state === "status") {
        if (!buf.length) return null;
        if (buf[0] === 1) {
          state = "refusal";
          continue;
        }
        if (buf[0] !== 0) return fail("malformed", "the answer is not a sealed stream");
        buf = buf.subarray(1);
        state = "rn";
        continue;
      }
      if (state === "refusal") {
        if (buf.length > 300) return fail("refused", `the VM refused (unauthenticated hint): ${td2.decode(buf.subarray(1, 300))}`);
        return null;
      }
      if (state === "rn") {
        if (buf.length < 16) return null;
        rn = buf.slice(0, 16);
        buf = buf.subarray(16);
        keys = await responseKeys(ctx, rn);
        state = "chunk";
        continue;
      }
      if (state === "done" || state === "aborted") return buf.length ? fail("trailing", `${buf.length} bytes after the ${state === "done" ? "FIN" : "ABORT"}`) : null;
      if (signal && signal.aborted) return fail("cancelled", "the caller aborted");
      if (buf.length < 2) return null;
      const type = buf[0];
      if (type > 2) return fail("malformed", `chunk ${i} has an unknown type ${type}`);
      const vl = 1 << (buf[1] >> 6);
      if (buf.length < 1 + vl) return null;
      let len = buf[1] & 63;
      for (let k = 1; k < vl; k++) len = len * 256 + buf[1 + k];
      if (len > MAX_CHUNK_CT) return fail("oversize", `chunk ${i} claims ${len} bytes (at most ${MAX_CHUNK_CT}): refused, never truncated`);
      if (len < 16) return fail("malformed", `chunk ${i} is ${len} bytes: shorter than a tag`);
      if (type === CHUNK.DATA && len === 16) return fail("malformed", `chunk ${i} is an empty data chunk`);
      if (type === CHUNK.ABORT && len > 256 + 16) return fail("oversize", `abort chunk ${i} too long`);
      if (i >= MAX_CHUNKS) return fail("oversize", "too many chunks");
      if (buf.length < 1 + vl + len) return null;
      const ct = buf.slice(1 + vl, 1 + vl + len);
      buf = buf.subarray(1 + vl + len);
      let pt;
      try {
        pt = await gcm("decrypt", keys.key, chunkNonce(keys.base, i), ct, chunkAad(ctx.nonce, rn, i, type));
      } catch {
        return fail("tamper", `chunk ${i} does not open under this request's keys (altered, reordered, duplicated, dropped, spliced, replayed, or not the VM's)`);
      }
      i++;
      bytes += pt.length;
      if (bytes > MAX_STREAM_BYTES) return fail("oversize", "the stream exceeds 16 MiB");
      if (type === CHUNK.DATA) onData(pt);
      else if (type === CHUNK.FIN) {
        if (pt.length) onData(pt);
        state = "done";
      } else {
        state = "aborted";
        end = out2({ ok: false, error: "aborted", detail: `the VM aborted the answer (authenticated): ${td2.decode(pt)}` });
      }
    }
  };
  try {
    for await (const piece of source) {
      if (signal && signal.aborted) return fail("cancelled", "the caller aborted");
      if (buf.length + piece.length > MAX_CHUNK_CT + 9 + 300 + 64 * 1024) return fail("oversize", "the carrier sent more than one chunk ahead");
      buf = buf.length ? cat(buf, piece) : piece;
      const v2 = await step();
      if (v2 && v2.error !== "aborted") return v2;
    }
  } catch (e) {
    if (signal && signal.aborted || e.name === "AbortError") return fail("cancelled", "the caller aborted");
    return fail("truncated", `the carrier failed: ${e.message}`);
  }
  const v = await step();
  if (v && v.error !== "aborted") return v;
  if (state === "done") return out2({ ok: true, complete: true });
  if (state === "aborted") return end;
  if (state === "refusal") return fail("refused", `the VM refused (unauthenticated hint): ${td2.decode(buf.subarray(1, 300))}`);
  return fail("truncated", state === "chunk" && i > 0 ? `the stream ended after ${i} chunks with no FIN: INCOMPLETE` : "the stream ended before any chunk: INCOMPLETE");
}
function httpRequest(method, path5, body2 = null, headers = {}) {
  if (!/^\/[\x21-\x7e]*$/.test(path5)) throw new Error("path must be an origin-form path");
  const x = body2 == null ? null : typeof body2 === "string" ? te3.encode(body2) : body2;
  let h = `${method} ${path5} HTTP/1.1\r
host: pvm-app\r
connection: close\r
`;
  for (const [k, v] of Object.entries(headers)) {
    if (!/^[a-z0-9-]+$/i.test(k) || /[\r\n]/.test(v)) throw new Error("bad header");
    h += `${k}: ${v}\r
`;
  }
  if (x) h += `content-length: ${x.length}\r
`;
  return x ? cat(te3.encode(h + "\r\n"), x) : te3.encode(h + "\r\n");
}
var crlf = (x, from) => {
  for (let i = from; i + 1 < x.length; i++) if (x[i] === 13 && x[i + 1] === 10) return i;
  return -1;
};
function parseHttpResponse(bytes) {
  let i = -1;
  for (let p = 0; p + 3 < bytes.length; p++) if (bytes[p] === 13 && bytes[p + 1] === 10 && bytes[p + 2] === 13 && bytes[p + 3] === 10) {
    i = p;
    break;
  }
  if (i < 0) throw new Error("no HTTP header");
  const head = td2.decode(bytes.subarray(0, i)), m = /^HTTP\/1\.1 (\d{3})/.exec(head);
  if (!m) throw new Error("not an HTTP/1.1 response");
  let body2 = bytes.subarray(i + 4);
  if (/\r\ntransfer-encoding: *chunked/i.test(head)) {
    const parts = [];
    let p = 0;
    for (; ; ) {
      const j = crlf(body2, p);
      if (j < 0) throw new Error("truncated chunked body");
      const n = parseInt(td2.decode(body2.subarray(p, j)).split(";")[0], 16);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("bad chunk size");
      if (!n) break;
      if (j + 2 + n > body2.length) throw new Error("truncated chunk");
      parts.push(body2.subarray(j + 2, j + 2 + n));
      p = j + 2 + n + 2;
    }
    body2 = cat(...parts);
  } else {
    const cl = /\r\ncontent-length: *(\d+)/i.exec(head);
    if (cl) {
      if (body2.length < +cl[1]) throw new Error("truncated body");
      body2 = body2.subarray(0, +cl[1]);
    }
  }
  return { status: Number(m[1]), head, body: td2.decode(body2), bytes: body2 };
}
function httpStream({ onHead = () => {
}, onLine = () => {
} } = {}) {
  let head = null, raw = new Uint8Array(0), chunked = false, need = null, line = new Uint8Array(0), done = false, left = null;
  const body2 = (x) => {
    let s = 0;
    for (let k = 0; k < x.length; k++) if (x[k] === 10) {
      const l = cat(line, x.subarray(s, k));
      line = new Uint8Array(0);
      s = k + 1;
      onLine(td2.decode(l));
    }
    line = cat(line, x.subarray(s));
    if (line.length > 64 * 1024) throw new Error("a body line exceeds 64 KiB");
  };
  const pump = () => {
    for (; ; ) {
      if (done) {
        if (raw.length) throw new Error("bytes after the HTTP message");
        return;
      }
      if (!head) {
        let i = -1;
        for (let p = 0; p + 3 < raw.length; p++) if (raw[p] === 13 && raw[p + 1] === 10 && raw[p + 2] === 13 && raw[p + 3] === 10) {
          i = p;
          break;
        }
        if (i < 0) {
          if (raw.length > 16384) throw new Error("HTTP head exceeds 16 KiB");
          return;
        }
        const h = td2.decode(raw.subarray(0, i)), m = /^HTTP\/1\.1 (\d{3})/.exec(h);
        if (!m) throw new Error("not an HTTP/1.1 response");
        head = { status: Number(m[1]), head: h };
        raw = raw.subarray(i + 4);
        chunked = /\r\ntransfer-encoding: *chunked/i.test(h);
        const cl = /\r\ncontent-length: *(\d+)/i.exec(h);
        left = cl ? Number(cl[1]) : null;
        onHead(head);
        continue;
      }
      if (!chunked) {
        if (left == null) {
          body2(raw);
          raw = new Uint8Array(0);
          return;
        }
        const n = Math.min(left, raw.length);
        body2(raw.subarray(0, n));
        left -= n;
        raw = raw.subarray(n);
        if (!left) done = true;
        return;
      }
      if (need == null) {
        const j = crlf(raw, 0);
        if (j < 0) {
          if (raw.length > 64) throw new Error("bad chunk header");
          return;
        }
        const n = parseInt(td2.decode(raw.subarray(0, j)).split(";")[0], 16);
        if (!Number.isSafeInteger(n) || n < 0) throw new Error("bad chunk size");
        raw = raw.subarray(j + 2);
        if (!n) {
          if (raw.length < 2) {
            raw = cat(Uint8Array.of(48, 13, 10), raw);
            return;
          }
          raw = raw.subarray(2);
          done = true;
          continue;
        }
        need = n;
        continue;
      }
      if (raw.length < need + 2) {
        if (raw.length > need) return;
        body2(raw);
        need -= raw.length;
        raw = new Uint8Array(0);
        return;
      }
      body2(raw.subarray(0, need));
      raw = raw.subarray(need + 2);
      need = null;
    }
  };
  return {
    push(x) {
      raw = raw.length ? cat(raw, x) : x;
      pump();
    },
    end() {
      if (line.length) {
        onLine(td2.decode(line));
        line = new Uint8Array(0);
      }
      return { head, complete: done || !chunked && left == null && !!head };
    }
  };
}

// ../web/pvm-client.js
var expectOf = (pins, nonce, now) => ({
  nonce,
  appId: pins.app,
  allowedRuntimeIds: pins.allowedRuntimeIds || [pins.runtimeId],
  allowedCodeHashes: pins.allowedCodeHashes || [pins.codeHash],
  allowedAuthorityHashes: pins.allowedAuthorityHashes || [pins.authority],
  ...pins.rootPins ? { rootPins: pins.rootPins } : {},
  ...now ? { now } : {},
  ...pins.instanceIds ? { instanceIds: pins.instanceIds } : {}
});
var evidenceLine = (v3, nonce) => `${v3 ? "EVIDENCE3" : "EVIDENCE"} ${toHex(nonce)}
`;
async function post(url, body2, type) {
  const r = await fetch(url, { method: "POST", body: body2, headers: { "content-type": type }, cache: "no-store", credentials: "omit" });
  if (!r.ok) throw new Error(`the carrier answered ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function fetchVerified({ relay, pins, method = "GET", path: path5 = "/", body: body2 = null, label = "ok", now, gate, v3 = false }) {
  const t0 = performance.now();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const out2 = (o2) => ({ label, ...o2 });
  let env;
  try {
    const bytes = await post(`${relay}/evidence`, evidenceLine(v3, nonce), "text/plain");
    const line = new TextDecoder().decode(bytes).split("\n")[0];
    env = JSON.parse(line);
  } catch (e) {
    return out2({ step: "evidence", refused: `no evidence: ${e.message}`, sent: false });
  }
  const v = await verifyPvmAppEvidence(env, expectOf(pins, nonce, now));
  const verifyMs = Math.round(performance.now() - t0);
  if (!v.ok) return out2({ step: "verify", refused: v.reasons.at(-1), sent: false, verifyMs });
  if (!v.appKey) return out2({ step: "verify", refused: "the evidence carries no app key (v1): a page cannot pin a TLS key, so nothing is sent", sent: false, verifyMs });
  if (gate) {
    const why = await gate(v, env, toHex(nonce));
    if (why) return out2({ step: "gate", refused: why, sent: false, verifyMs });
  }
  const verified = { format: env.format, app: v.appId, runtime: v.runtimeId, codeHash: v.measurement, key: v.transportSpki.slice(-16), appKey: v.appKey.slice(0, 16), nonce: toHex(nonce).slice(0, 16), instance: v.instanceId };
  const { frame, ctx } = await sealRequest({ appKey: v.appKey, appId: v.appId, runtimeId: v.runtimeId, nonce, request: httpRequest(method, path5, body2) });
  let answer;
  try {
    answer = await post(`${relay}/sealed`, frame, "application/octet-stream");
  } catch (e) {
    return out2({ step: "sealed", refused: `no answer: ${e.message}`, sent: true, verified, verifyMs });
  }
  const o = await openResponse(ctx, answer);
  const ms = Math.round(performance.now() - t0);
  if (!o.ok) return out2({ step: "sealed", refused: o.refused, sent: true, verified, verifyMs, ms });
  try {
    const r = parseHttpResponse(o.response);
    return out2({ sent: true, verified, verifyMs, ms, status: r.status, body: r.body });
  } catch (e) {
    return out2({ step: "sealed", refused: `the opened answer is not HTTP: ${e.message}`, sent: true, verified, verifyMs, ms });
  }
}
async function fetchVerifiedStream({ relay, pins, path: path5 = "/", label = "ok", onLine = () => {
}, cancelAfter = 0, trace = false, now, gate, v3 = false }) {
  const t0 = performance.now();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const out2 = (o) => ({ label, mode: "stream", ...o });
  let env;
  try {
    env = JSON.parse(new TextDecoder().decode(await post(`${relay}/evidence`, evidenceLine(v3, nonce), "text/plain")).split("\n")[0]);
  } catch (e) {
    return out2({ step: "evidence", refused: `no evidence: ${e.message}`, sent: false });
  }
  const v = await verifyPvmAppEvidence(env, expectOf(pins, nonce, now));
  const verifyMs = Math.round(performance.now() - t0);
  if (!v.ok) return out2({ step: "verify", refused: v.reasons.at(-1), sent: false, verifyMs });
  if (!v.appKey) return out2({ step: "verify", refused: "the evidence carries no app key (v1): a page cannot pin a TLS key, so nothing is sent", sent: false, verifyMs });
  if (gate) {
    const why = await gate(v, env, toHex(nonce));
    if (why) return out2({ step: "gate", refused: why, sent: false, verifyMs });
  }
  const verified = { format: env.format, app: v.appId, runtime: v.runtimeId, codeHash: v.measurement, key: v.transportSpki.slice(-16), appKey: v.appKey.slice(0, 16), nonce: toHex(nonce).slice(0, 16), instance: v.instanceId };
  const { frame, ctx } = await sealRequest({ appKey: v.appKey, appId: v.appId, runtimeId: v.runtimeId, nonce, request: httpRequest("GET", path5), chunked: true });
  const traceCtx = trace ? { enc: toHex(ctx.enc), exported: toHex(ctx.secret), nonce: toHex(nonce) } : void 0;
  const ac = new AbortController();
  const lines = [], arrivals = [];
  let head = null, tokens = 0;
  const http = httpStream({ onHead: (h) => {
    head = h;
  }, onLine: (l) => {
    if (ac.signal.aborted) return;
    const text = l.trimEnd();
    if (!text) return;
    lines.push(text);
    arrivals.push(Math.round(performance.now() - t0));
    onLine(text);
    if (/"token":/.test(text)) {
      tokens++;
      if (cancelAfter && tokens >= cancelAfter) ac.abort();
    }
  } });
  let res;
  try {
    res = await fetch(`${relay}/sealed`, { method: "POST", body: frame, headers: { "content-type": "application/octet-stream" }, cache: "no-store", credentials: "omit", signal: ac.signal });
  } catch (e) {
    return out2({ step: "sealed", refused: `no answer: ${e.message}`, sent: true, verified, verifyMs, trace: traceCtx });
  }
  if (!res.ok) return out2({ step: "sealed", refused: `the carrier answered ${res.status}`, sent: true, verified, verifyMs, trace: traceCtx });
  const reader = res.body.getReader();
  const source = (async function* () {
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  })();
  let httpError = null;
  const r = await openStream(ctx, source, { signal: ac.signal, onData: (d) => {
    try {
      http.push(d);
    } catch (e) {
      httpError = e.message;
      ac.abort();
    }
  } });
  const httpEnd = http.end();
  const ms = Math.round(performance.now() - t0);
  const firstToken = arrivals[lines.findIndex((l) => /"token":/.test(l))] ?? null;
  const base = { sent: true, verified, verifyMs, ms, firstTokenMs: firstToken, arrivals, lines, tokens, status: head && head.status, trace: traceCtx };
  if (httpError) return out2({ ...base, step: "sealed", refused: `the opened answer is not a valid HTTP stream: ${httpError}`, complete: false });
  if (!r.ok) return out2({ ...base, step: "sealed", refused: r.detail, error: r.error, complete: false, chunks: r.chunks });
  return out2({ ...base, complete: r.complete && httpEnd.complete, chunks: r.chunks });
}

// src/client.js
async function acceptPolicy(store, policyEnv, { now = Date.now(), clientVersion = CLIENT_VERSION, hold: hold2 = null } = {}) {
  let accepted = null;
  let r;
  try {
    r = await store.update(async (state) => {
      if (hold2) await hold2(state);
      const v = await verifyPolicy(policyEnv, { state, now, clientVersion });
      if (!v.ok) {
        accepted = null;
        return { refuse: v.reasons[0] };
      }
      accepted = v;
      return { state: v.state };
    });
  } catch (e) {
    return { ok: false, commitFailed: true, reason: `the client could not record the policy durably (${e.message}): nothing is sent` };
  }
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, policy: accepted.policy, pins: accepted.pins, gen: r.gen, serial: r.state.serial };
}
async function connect({ relay, policyEnv, store, appId = null, deployment = null, path: path5 = "/", stream = true, cancelAfter = 0, onLine = () => {
}, onCommitted = () => {
}, usedNonces = /* @__PURE__ */ new Set(), now, label = "client" }) {
  const pol = await acceptPolicy(store, policyEnv, { now: now ?? Date.now() });
  if (!pol.ok) return { result: { label, step: pol.commitFailed ? "commit" : "policy", refused: pol.reason, sent: false } };
  await onCommitted({ serial: pol.serial, gen: pol.gen });
  const p = pol.policy;
  let instances = null;
  if (deployment !== null) {
    const sel = selectDeployment(p, { deployment, app: appId });
    if (!sel.ok) return { result: { label, step: "select", refused: sel.reason, sent: false, policySerial: p.serial } };
    appId = sel.app;
    instances = sel.instances;
  }
  if (!appId) return { result: { label, step: "select", refused: "no app or deployment selected", sent: false, policySerial: p.serial } };
  if (!p.appIds.includes(appId)) return { result: { label, step: "policy", refused: "the policy does not admit this app", sent: false, policySerial: p.serial } };
  const mode = stream ? "chunked" : "whole";
  if (!p.sealedModes.includes(mode)) return { result: { label, step: "policy", refused: `the policy does not allow ${mode} answers`, sent: false, policySerial: p.serial } };
  const v3 = instances !== null || !p.formats.includes("enclave-pvm-app-evidence/v2");
  const pins = { app: appId, ...pol.pins, ...instances ? { instanceIds: instances } : {} };
  const gate = async (v, env, nonceHex) => {
    if (!p.formats.includes(env.format)) return `the evidence format ${env.format} is not one the policy allows`;
    const d = await admit(
      await verdictOf(v, env, nonceHex),
      { nonce: nonceHex, appId, ...pol.pins, ...instances ? { instanceIds: instances } : {} },
      { clientKind: "browser", usedNonces: [...usedNonces] }
    );
    if (d.decision !== "release") return d.reason;
    if (d.pinned.sealed.windowSeconds !== p.sealedWindow.seconds || d.pinned.sealed.maxRequests !== p.sealedWindow.maxRequests)
      return `the VM's sealed window (${d.pinned.sealed.windowSeconds} s, ${d.pinned.sealed.maxRequests}) is not the policy's (${p.sealedWindow.seconds} s, ${p.sealedWindow.maxRequests})`;
    let cur;
    try {
      cur = await store.latest();
    } catch (e) {
      return `the committed state cannot be read (${e.message}): nothing is sent`;
    }
    if (!cur || cur.state.serial !== p.serial) return `policy serial ${p.serial} was superseded by serial ${cur && cur.state.serial} committed meanwhile: nothing is sent`;
    usedNonces.add(nonceHex);
    return null;
  };
  const args = { relay, pins, path: path5, label, gate, v3, ...now ? { now } : {} };
  const result = stream ? await fetchVerifiedStream({ ...args, onLine, cancelAfter }) : await fetchVerified(args);
  const instance = instances && result.verified ? result.verified.instance : null;
  return { result: {
    ...result,
    policySerial: p.serial,
    stateGen: pol.gen,
    clientVersion: CLIENT_VERSION,
    ...deployment !== null ? { deployment: { id: deployment, app: appId, instance, bound: instances !== null } } : {}
  } };
}

// src/carrier.js
var PLATFORM_RELAYS = ["https://api.enclave.host"];
var LAB_LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
function carrierFor({ relay = null, relayBase = null, deployment = null } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (relay && relayBase) return no("both a carrier URL and a relay base were given: ambiguous, nothing fetched or sent");
  if (relay) return { ok: true, url: relay };
  if (!relayBase) return no("no carrier: give a platform relay base or a carrier URL");
  if (!PLATFORM_RELAYS.includes(relayBase) && !LAB_LOOPBACK.test(relayBase))
    return no(`${JSON.stringify(relayBase)} is not a platform relay this client knows (${PLATFORM_RELAYS.join(", ")}; or the lab's http://127.0.0.1:<port>)`);
  if (typeof deployment !== "string" || !DEPLOYMENT_ID.test(deployment)) return no("a relay base routes by deployment: select one (0x + 64 lowercase hex)");
  return { ok: true, url: `${relayBase}/x/${deployment}/pvm` };
}

// src/enroll.js
async function enrollInstance({ relay, policyEnv, store, deployment, now }) {
  const pol = await acceptPolicy(store, policyEnv, { now: now ?? Date.now() });
  if (!pol.ok) return { ok: false, step: pol.commitFailed ? "commit" : "policy", refused: pol.reason };
  const p = pol.policy;
  const sel = selectDeployment(p, { deployment });
  if (!sel.ok) return { ok: false, step: "select", refused: sel.reason };
  if (!p.formats.includes(PVM_APP_EVIDENCE_FORMAT_V3))
    return { ok: false, step: "policy", refused: `the policy does not allow ${PVM_APP_EVIDENCE_FORMAT_V3}: an instance cannot be enrolled under it` };
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  let env;
  try {
    const r = await fetch(`${relay}/evidence`, { method: "POST", body: `EVIDENCE3 ${toHex(nonce)}
`, headers: { "content-type": "text/plain" }, cache: "no-store", credentials: "omit" });
    if (!r.ok) throw new Error(`the carrier answered ${r.status}`);
    env = JSON.parse(new TextDecoder().decode(new Uint8Array(await r.arrayBuffer())).split("\n")[0]);
  } catch (e) {
    return { ok: false, step: "evidence", refused: `no evidence: ${e.message}` };
  }
  if (!env || env.format !== PVM_APP_EVIDENCE_FORMAT_V3)
    return { ok: false, step: "verify", refused: `${JSON.stringify(env && env.format)} names no instance: only ${PVM_APP_EVIDENCE_FORMAT_V3} can be enrolled` };
  const v = await verifyPvmAppEvidence(env, { nonce, appId: sel.app, ...pol.pins, ...now ? { now } : {} });
  if (!v.ok) return { ok: false, step: "verify", refused: v.reasons.at(-1) };
  return { ok: true, record: {
    type: "enclave-pvm-instance-enrollment/1",
    deployment,
    app: sel.app,
    instanceId: v.instanceId,
    instanceKey: v.instanceKey,
    alreadyBound: !!(sel.instances && sel.instances.includes(v.instanceId)),
    runtimeId: v.runtimeId,
    codeHash: v.measurement,
    transportSpki: v.transportSpki,
    nonce: toHex(nonce),
    policySerial: p.serial,
    at: new Date(now ?? Date.now()).toISOString(),
    reasons: v.reasons,
    envelope: env
  } };
}

// cli.mjs
var argv = process.argv.slice(2);
var cmd = argv[0];
var arg = (k, d = null) => {
  const i = argv.indexOf(k);
  return i > 0 ? argv[i + 1] : d;
};
var out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
async function fetchBytes(src) {
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src, { cache: "no-store" });
    if (!r.ok) throw new Error(`${src}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  return new Uint8Array(fs4.readFileSync(src));
}
var fetchJson = async (src) => JSON.parse(new TextDecoder().decode(await fetchBytes(src)));
var fromFile = !!process.argv[1] && process.argv[1] !== "-";
var installDir = () => arg("--install-dir") || (fromFile ? path4.dirname(process.argv[1]) : null);
var NO_DIR = "--install-dir is required: this client was not started from a file";
var marker = !fromFile && process.env[DELEGATED] ? process.env[DELEGATED].split(":")[0] : null;
function openStore() {
  const given = arg("--state", path4.join(process.env.XDG_CONFIG_HOME || path4.join(os2.homedir(), ".config"), "enclave-pvm-client", "state.d"));
  let st = null;
  try {
    st = fs4.statSync(given);
  } catch {
  }
  if (st && st.isFile()) {
    const store = new FileStore(given + ".d");
    if (!store.latest()) {
      const legacy = JSON.parse(fs4.readFileSync(given, "utf8"));
      const r = store.init(legacy);
      out({ imported: given, into: store.dir, ok: r.ok || void 0 });
    }
    return store;
  }
  return new FileStore(given);
}
async function main() {
  if (marker !== null && marker !== CLIENT_VERSION) return out({ error: `delegated as ${marker}, but this client is ${CLIENT_VERSION}: refusing` }), 2;
  if (marker !== null && cmd !== "run") return out({ error: `a delegated client runs only \`run\`, not ${JSON.stringify(cmd)}` }), 2;
  if (cmd === "version") return out({ client: "enclave-pvm-client", version: CLIENT_VERSION, lab: "NOT PRODUCTION" }), 0;
  const store = openStore();
  if (cmd === "install") {
    const s = initialState({ policyKeyFp: arg("--policy-key-fp"), serialFloor: Number(arg("--serial-floor")), releaseKeyFp: arg("--release-key-fp") });
    const r = store.init({ ...s, staged: null, active: null });
    if (!r.ok) return out({ refused: r.reason }), 2;
    return out({ installed: store.dir, anchor: { policyKeyFp: s.policyFp, serialFloor: s.serial, releaseKeyFp: s.releaseFp } }), 0;
  }
  const cur = store.latest();
  if (!cur) return out({ refused: `no client installed at ${store.dir} (run install with the anchors you were given out of band)` }), 2;
  const active = cur.state.active || null;
  if (cmd === "run") {
    if (marker === null && active && semverCmp(active.version, CLIENT_VERSION) > 0) {
      const dir = installDir();
      if (!dir) return out({ result: { step: "launch", refused: NO_DIR, sent: false } }), 2;
      const r2 = await launchActive(active, { dir, stateDir: store.dir, args: argv.slice(1) });
      if (r2.refused) return out({ result: r2.refused }), 2;
      if (r2.error) return out({ error: r2.error }), 2;
      if (r2.sig) return out({ error: `the active client ${active.version} ended by signal ${r2.sig}` }), 2;
      return r2.code;
    }
    const twice = ["--deployment", "--app", "--relay", "--relay-base"].filter((k) => argv.filter((a) => a === k).length > 1);
    if (twice.length) return out({ result: { step: "select", refused: `${twice.join(" and ")} given more than once: ambiguous, nothing fetched or sent`, sent: false, clientVersion: CLIENT_VERSION } }), 2;
    const carrier = carrierFor({ relay: arg("--relay"), relayBase: arg("--relay-base"), deployment: arg("--deployment") });
    if (!carrier.ok) return out({ result: { step: "carrier", refused: carrier.reason, sent: false, clientVersion: CLIENT_VERSION } }), 2;
    let policyEnv;
    try {
      policyEnv = await fetchJson(arg("--policy"));
    } catch (e) {
      return out({ result: { step: "policy", refused: `no policy: ${e.message}`, sent: false, clientVersion: CLIENT_VERSION } }), 1;
    }
    const r = await connect({
      relay: carrier.url,
      policyEnv,
      store,
      appId: arg("--app"),
      deployment: arg("--deployment"),
      path: arg("--path", "/"),
      stream: !argv.includes("--whole"),
      cancelAfter: Number(arg("--cancel", "0")),
      label: arg("--label", "cli"),
      onLine: (line) => out({ line }),
      onCommitted: (c) => out({ committed: c })
    });
    out({ result: { ...r.result, lines: void 0, clientVersion: CLIENT_VERSION } });
    return r.result.complete === true || r.result.status === 200 && r.result.mode !== "stream" ? 0 : 1;
  }
  if (cmd === "update") {
    const dir = installDir();
    if (!dir) return out({ update: { ok: false, reasons: [NO_DIR] } }), 2;
    let env, bytes;
    try {
      env = await fetchJson(arg("--manifest"));
      bytes = await fetchBytes(arg("--artifact"));
    } catch (e) {
      return out({ update: { ok: false, reasons: [`not delivered: ${e.message}`] } }), 1;
    }
    const r = await stageUpdate(store, env, bytes, { dir });
    if (!r.ok) return out({ update: { ok: false, reasons: [r.reason] } }), 1;
    return out({ update: { ok: true, version: r.version, staged: r.file, gen: r.gen, ...r.already ? { already: true } : {} } }), 0;
  }
  if (cmd === "instance") {
    const twice = ["--deployment", "--relay", "--relay-base", "--out"].filter((k) => argv.filter((a) => a === k).length > 1);
    if (twice.length) return out({ enroll: { ok: false, step: "select", refused: `${twice.join(" and ")} given more than once: ambiguous` } }), 2;
    const carrier = carrierFor({ relay: arg("--relay"), relayBase: arg("--relay-base"), deployment: arg("--deployment") });
    if (!carrier.ok) return out({ enroll: { ok: false, step: "carrier", refused: carrier.reason } }), 2;
    let policyEnv;
    try {
      policyEnv = await fetchJson(arg("--policy"));
    } catch (e) {
      return out({ enroll: { ok: false, step: "policy", refused: `no policy: ${e.message}` } }), 1;
    }
    const r = await enrollInstance({ relay: carrier.url, policyEnv, store, deployment: arg("--deployment") });
    if (!r.ok) return out({ enroll: { ok: false, step: r.step, refused: r.refused } }), 1;
    if (arg("--out")) {
      try {
        fs4.writeFileSync(arg("--out"), JSON.stringify(r.record, null, 1) + "\n", { flag: "wx", mode: 420 });
      } catch (e) {
        return out({ enroll: { ok: false, step: "record", refused: `the record could not be written as a new file (${e.code || e.message})` } }), 1;
      }
    }
    const { envelope, reasons, ...summary } = r.record;
    return out({ enroll: { ok: true, ...summary, record: arg("--out") || null } }), 0;
  }
  if (cmd === "deployments") {
    let policyEnv;
    try {
      policyEnv = await fetchJson(arg("--policy"));
    } catch (e) {
      return out({ deployments: null, refused: `no policy: ${e.message}` }), 1;
    }
    const pol = await acceptPolicy(store, policyEnv);
    if (!pol.ok) return out({ deployments: null, refused: pol.reason }), pol.commitFailed ? 2 : 1;
    return out({ deployments: pol.policy.deployments || [], policySerial: pol.serial, gen: pol.gen, appIds: pol.policy.appIds }), 0;
  }
  if (cmd === "activate") {
    const dir = installDir();
    if (!dir) return out({ activate: { ok: false, step: "file", reasons: [NO_DIR] } }), 2;
    const r = await activateStaged(store, { dir });
    return out({ activate: r }), r.ok ? 0 : 1;
  }
  if (cmd === "state") {
    return out({ state: cur.state, gen: cur.gen, dir: store.dir }), 0;
  }
  if (cmd === "staged") {
    const dir = installDir();
    if (!dir) return out({ refused: NO_DIR }), 2;
    const check = (rec) => {
      if (!rec) return null;
      const f = path4.join(dir, rec.file);
      let ok = false;
      try {
        ok = createHash3("sha256").update(fs4.readFileSync(f)).digest("hex") === rec.sha256;
      } catch {
      }
      return { ...rec, path: f, bytesMatch: ok };
    };
    const s = check(cur.state.staged || null), a = check(active);
    return out({ staged: s, active: a }), s && !s.bytesMatch || a && !a.bytesMatch ? 1 : 0;
  }
  out({ refused: `unknown command ${JSON.stringify(cmd)}: install | run | deployments | instance | update | activate | staged | state | version` });
  return 2;
}
main().then((rc) => process.exit(rc), (e) => {
  out({ error: e instanceof StoreError ? `state: ${e.message}` : e.message });
  process.exit(2);
});
