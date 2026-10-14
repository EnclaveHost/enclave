// enclave-verifier-node: built by verifier/node/build.mjs from the inputs in MANIFEST.json; do not edit by hand

// verifier/consumer.mjs
import { createHash as createHash3, randomBytes } from "node:crypto";

// verifier/envelope.mjs
var TECH = { SNP: "amd-sev-snp", TDX: "intel-tdx", AVF: "android-avf", VBS: "windows-vbs-enclave", HYPERV: "hyperv-partition", WINHOST: "windows-tpm-host", NONE: "none" };
var b64 = (max, required = false) => ({ kind: "b64", max, required });
var hexF = (n, required = false) => ({ kind: "hex", n, required });
var str = (max, required = false) => ({ kind: "str", max, required });
var obj = (required = false) => ({ kind: "obj", required });
var oneOf = (values, required = false) => ({ kind: "oneOf", values, required });
var MAX_DOC_BYTES = 1024 * 1024;
var MAX_DOC_KEYS = 32;
var SHAPES = {
  metal: { body: "body", closed: false, fields: { transportKey: b64(4096), transportKeyFp: hexF(64), padKey: hexF(64), certs: b64(96 * 1024), name: str(128), manifest: obj(), volumes: obj() } },
  domain: { body: "report", closed: false, fields: { tier: str(16), transportKey: b64(4096), appSha256: hexF(64), nonce: hexF(64), abi: oneOf(["enclave-domain-abi/1", "enclave-domain-abi/2"]), runtime: obj(), runtimeSelfTest: str(4096), certs: b64(96 * 1024), boundary: obj(), reason: str(1024) } },
  avf1: { body: "body", closed: false, fields: { transportKey: b64(4096), padKey: hexF(64) } },
  avf2: { body: "body", closed: false, fields: { transportKey: b64(4096), padKey: hexF(64, true) } },
  vbs: { body: "body", closed: false, fields: { transportKey: b64(4096), padKey: hexF(64) } },
  hyperv: { body: "report", closed: false, fields: { tier: str(16), nonce: hexF(64), appSha256: hexF(64), transportKey: b64(4096), reason: str(1024) } }
};
var FORMATS = Object.freeze({
  "sev-snp-guest-metal-v1": { technology: TECH.SNP, family: "metal", binding: "spki", supported: true, shape: SHAPES.metal },
  "sev-snp-guest-domain-v1": { technology: TECH.SNP, family: "domain", binding: "domain", supported: true, shape: SHAPES.domain },
  "tdx-guest-metal-v1": { technology: TECH.TDX, family: "metal", binding: "spki", supported: false, why: "Intel TDX quote verification is not implemented (DCAP collateral, QE identity, TCB info)" },
  "android-avf-pvm/v1": { technology: TECH.AVF, family: "pvm", binding: "avf-transcript", supported: "delegate", shape: SHAPES.avf1 },
  "android-avf-pvm/v2": { technology: TECH.AVF, family: "pvm", binding: "avf-pad-transcript", supported: "delegate", shape: SHAPES.avf2 },
  // client-verified pVM app evidence (pVM owner's proposal, 2026-09-24): a JSON object, not a base64 body; routed
  // by verifier/index.mjs to verifier/pvm-evidence.mjs before parseEnvelope, which is why it has no body here
  "enclave-pvm-app-evidence/v1": { technology: TECH.AVF, family: "pvm-app", binding: "abi2-client-nonce", supported: "delegate", jsonObject: true },
  "enclave-pvm-app-evidence/v2": { technology: TECH.AVF, family: "pvm-app", binding: "abi2-client-nonce", supported: "delegate", jsonObject: true, appKey: true },
  // v3 (INSTANCE-BINDING.md, 2026-09-24): v2 plus the VM instance inside the challenge (Bind3) and an instance signature
  "enclave-pvm-app-evidence/v3": { technology: TECH.AVF, family: "pvm-app", binding: "abi3-client-nonce-instance", supported: "delegate", jsonObject: true, appKey: true, instance: true },
  "windows-vbs-enclave/v1": { technology: TECH.VBS, family: "consumer-node", binding: "vbs-transcript", supported: "delegate", shape: SHAPES.vbs },
  "hyperv-partition-domain/v1": { technology: TECH.HYPERV, family: "domain", binding: "domain", supported: "delegate", hostExcluded: false, shape: SHAPES.hyperv },
  // The NucBox node's attach evidence proposed by enclave-5d on 2026-09-25 for the custom type-1 path (Steven: the only NucBox
  // target): the node's own transport key bound to its TPM's measured boot state (EK chain, credential round trip, quote, log
  // replay, Secure Boot on, test signing off). The relay judges it; it is a HOST statement with no TEE claim and the host is
  // not excluded, so it is never a confidential-compute verdict here (docs/security/nucbox-custom-vm-verifier.md).
  "windows-hv-node/v1": {
    technology: TECH.WINHOST,
    family: "consumer-node",
    binding: "hv-node-transcript",
    supported: false,
    hostExcluded: false,
    why: "a host-attested boot state (TPM quote over the measured boot, judged by the relay's module): no TEE claim, the host is not excluded, never a confidential-compute verdict"
  },
  "dev-unattested-metal-v1": { technology: TECH.NONE, family: "dev", binding: null, supported: false, rejected: true, why: "development format: proves nothing about hardware by definition" },
  "none": { technology: TECH.NONE, family: "t0", binding: null, supported: false, rejected: true, why: "a T0 domain has no hardware report" }
});
var MAX_BODY_B64 = 64 * 1024;
var MAX_BODY_BYTES = 64 * 1024;
var EnvelopeError = class extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
};
var B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function checkBase64(s, max, what) {
  if (typeof s !== "string" || !s.length) throw new EnvelopeError("malformed", `${what}: missing`);
  if (s.length > max) throw new EnvelopeError("malformed", `${what}: ${s.length} chars exceeds the ${max}-char cap`);
  if (!B64.test(s)) throw new EnvelopeError("malformed", `${what}: not strict base64`);
  return s;
}
var utf8Length = (s) => typeof Buffer !== "undefined" ? Buffer.byteLength(s) : new TextEncoder().encode(s).length;
function validateEnvelope(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new EnvelopeError("malformed", "evidence is not an object");
  if (typeof doc.format !== "string" || !doc.format || doc.format.length > 200) throw new EnvelopeError("malformed", "evidence.format is not a short string");
  const spec = FORMATS[doc.format];
  if (!spec) throw new EnvelopeError("unsupported", `unknown evidence format ${JSON.stringify(doc.format)}: nothing is known about what it proves`);
  if (spec.rejected) throw new EnvelopeError("rejected", `${doc.format}: ${spec.why}`);
  if (spec.supported === false) throw new EnvelopeError("unsupported", `${doc.format}: ${spec.why}`);
  const shape = spec.shape || { body: "body", closed: false, fields: {} };
  const keys = Object.keys(doc);
  if (keys.length > MAX_DOC_KEYS) throw new EnvelopeError("malformed", `${doc.format}: ${keys.length} top-level fields exceeds the cap of ${MAX_DOC_KEYS}`);
  let size = 0;
  try {
    size = utf8Length(JSON.stringify(doc));
  } catch {
    throw new EnvelopeError("malformed", `${doc.format}: the document is not serialisable`);
  }
  if (size > MAX_DOC_BYTES) throw new EnvelopeError("malformed", `${doc.format}: ${size} bytes exceeds the document cap of ${MAX_DOC_BYTES}`);
  const other = shape.body === "body" ? "report" : "body";
  if (other in doc) throw new EnvelopeError("malformed", `${doc.format}: carries \`${other}\` but this format's body field is \`${shape.body}\` (no alias)`);
  if (!(shape.body in doc)) throw new EnvelopeError("malformed", `${doc.format} ${shape.body}: missing`);
  const allowed = /* @__PURE__ */ new Set(["format", shape.body, ...Object.keys(shape.fields)]);
  if (shape.closed) {
    for (const k of keys) if (!allowed.has(k)) throw new EnvelopeError("malformed", `${doc.format}: unexpected field \`${k}\` (the format's shape is closed: nothing outside it is bound or read)`);
  }
  for (const [name, f] of Object.entries(shape.fields)) {
    if (!(name in doc)) {
      if (f.required) throw new EnvelopeError("malformed", `${doc.format}: ${name} is required by this format`);
      continue;
    }
    const v = doc[name], bad = (why) => {
      throw new EnvelopeError("malformed", `${doc.format}: ${name} ${why}`);
    };
    if (f.kind === "b64") {
      if (typeof v !== "string" || !v.length) bad("must be a non-empty base64 string");
      if (v.length > f.max) bad(`exceeds ${f.max} chars`);
      if (!B64.test(v)) bad("is not strict base64");
    } else if (f.kind === "hex") {
      if (typeof v !== "string" || v.length !== f.n || !/^[0-9a-f]+$/.test(v)) bad(`must be ${f.n} lowercase hex chars`);
    } else if (f.kind === "str") {
      if (typeof v !== "string" || v.length > f.max) bad(`must be a string of at most ${f.max} chars`);
    } else if (f.kind === "obj") {
      if (!v || typeof v !== "object" || Array.isArray(v)) bad("must be a JSON object");
    } else if (f.kind === "oneOf") {
      if (!f.values.includes(v)) bad(`must be one of ${f.values.join(", ")}`);
    }
  }
  const bodyB64 = checkBase64(doc[shape.body], MAX_BODY_B64, `${doc.format} ${shape.body}`);
  return { format: doc.format, spec, shape, bodyB64 };
}
function parseEnvelope(doc) {
  const { spec, shape, bodyB64 } = validateEnvelope(doc);
  const body = Buffer.from(bodyB64, "base64");
  if (body.length > MAX_BODY_BYTES) throw new EnvelopeError("malformed", "body exceeds the byte cap");
  if (isGzip(body)) throw new EnvelopeError("malformed", `${doc.format}: body is gzip but the format is not`);
  return { format: doc.format, spec, body, doc, shape };
}
var isGzip = (b) => b.length >= 2 && b[0] === 31 && b[1] === 139;

// verifier/snp.mjs
import { X509Certificate as X509Certificate2, constants, verify as cryptoVerify } from "node:crypto";

// relay/snp-verify.mjs
var KDS = "https://kdsintf.amd.com";
var MAX_KDS_BYTES = 256 * 1024;
var AMD_ARK_SHA256 = /* @__PURE__ */ new Map([
  ["Milan", "69d063b45344d26a2e94e1f4210de49ef555308287d4c174445c95639a540bcd"],
  ["Genoa", "4c6598d19c18719c5dfd4a7d335f674e5bfe1d8f800cea2cf270c10d103db2f1"],
  ["Turin", "1f084161a44bb6d93778a904877d4819cafa5d05ef4193b2ded9dd9c73dd3f6a"]
]);
var TCB_FIELDS = {
  Milan: ["bootloader", "tee", "snp", "microcode"],
  Genoa: ["bootloader", "tee", "snp", "microcode"],
  Turin: ["fmc", "bootloader", "tee", "snp", "microcode"]
};
function decodeTcb(product, b) {
  if (product === "Turin") return { fmc: b[0], bootloader: b[1], tee: b[2], snp: b[3], microcode: b[7] };
  if (product === "Milan" || product === "Genoa") return { bootloader: b[0], tee: b[1], snp: b[6], microcode: b[7] };
  throw new Error(`no TCB layout for product line ${product}`);
}
var fmtTcb = (t) => Object.entries(t).map(([k, v]) => `${k} ${v}`).join(", ");
function snpProductHint(p) {
  if (p.version < 3) return null;
  const fam = p.cpuidFam, mod = p.cpuidMod;
  if (fam === 25 && mod < 16) return "Milan";
  if (fam === 25 && (mod >= 16 && mod < 32 || mod >= 160 && mod < 176)) return "Genoa";
  if (fam === 26 && mod < 32) return "Turin";
  return null;
}
function kdsVcekUrl(product, p) {
  const t = decodeTcb(product, p.reportedTcb);
  if (product === "Turin") {
    const d = (n) => String(n).padStart(2, "0");
    return `${KDS}/vcek/v1/Turin/${p.chipId.subarray(0, 8).toString("hex")}?fmcSPL=${d(t.fmc)}&blSPL=${d(t.bootloader)}&teeSPL=${d(t.tee)}&snpSPL=${d(t.snp)}&ucodeSPL=${d(t.microcode)}`;
  }
  return `${KDS}/vcek/v1/${product}/${p.chipId.toString("hex")}?blSPL=${t.bootloader}&teeSPL=${t.tee}&snpSPL=${t.snp}&ucodeSPL=${t.microcode}`;
}
function derAt(b, o) {
  if (o + 2 > b.length) throw new Error("DER truncated");
  let len = b[o + 1], p = o + 2;
  if (len & 128) {
    const n = len & 127;
    if (n < 1 || n > 4) throw new Error("DER length form");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  if (p + len > b.length) throw new Error("DER overrun");
  return { tag: b[o], start: p, end: p + len };
}
function derKids(b, t) {
  const out = [];
  for (let o = t.start; o < t.end; ) {
    const k = derAt(b, o);
    out.push(k);
    o = k.end;
  }
  return out;
}
function oidOf(b) {
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  for (let i = 1, v = 0; i < b.length; i++) {
    v = v * 128 + (b[i] & 127);
    if (!(b[i] & 128)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}
function certExtensions(der) {
  const tbs = derKids(der, derAt(der, 0))[0];
  const ext = derKids(der, tbs).find((k) => k.tag === 163);
  const out = /* @__PURE__ */ new Map();
  if (!ext) return out;
  for (const e of derKids(der, derKids(der, ext)[0])) {
    const kids = derKids(der, e), oid2 = kids[0], val = kids[kids.length - 1];
    if (oid2.tag === 6 && val.tag === 4) out.set(oidOf(der.subarray(oid2.start, oid2.end)), der.subarray(val.start, val.end));
  }
  return out;
}
function derUint(v) {
  const t = derAt(v, 0);
  if (t.tag !== 2 || t.end !== v.length || t.end === t.start || v[t.start] & 128) return null;
  let n = 0;
  for (let i = t.start; i < t.end; i++) n = n * 256 + v[i];
  return n;
}
var AMD = "1.3.6.1.4.1.3704.1";
var SPL_OID = { bootloader: `${AMD}.3.1`, tee: `${AMD}.3.2`, snp: `${AMD}.3.3`, microcode: `${AMD}.3.8`, fmc: `${AMD}.3.9` };
function vcekMatchesReport(vcekDer, product, p) {
  let ext;
  try {
    ext = certExtensions(vcekDer);
  } catch (e) {
    return `VCEK extensions unreadable: ${e.message}`;
  }
  const want = decodeTcb(product, p.reportedTcb);
  for (const field of TCB_FIELDS[product]) {
    const raw = ext.get(SPL_OID[field]);
    if (!raw) return `VCEK has no ${field} SPL extension (${SPL_OID[field]})`;
    const got = derUint(raw);
    if (got !== want[field]) return `VCEK ${field} SPL ${got} does not match the report's reported TCB ${want[field]}`;
  }
  const hwLen = product === "Turin" ? 8 : 64;
  let hw = ext.get(`${AMD}.4`);
  if (!hw) return `VCEK has no hardware-ID extension (${AMD}.4)`;
  if (hw.length !== hwLen && hw[0] === 4) {
    try {
      const t = derAt(hw, 0);
      hw = hw.subarray(t.start, t.end);
    } catch {
    }
  }
  if (hw.length !== hwLen) return `VCEK hardware ID is ${hw.length} bytes, ${product} uses ${hwLen}`;
  if (!hw.equals(p.chipId.subarray(0, hwLen))) return "VCEK hardware ID does not match the report's CHIP_ID";
  return null;
}
function checkMinTcb(minTcb, product, p) {
  const reported = product && TCB_FIELDS[product] ? decodeTcb(product, p.reportedTcb) : null;
  if (minTcb === void 0)
    return { ok: true, checked: false, reported, reason: "TCB: no minimum-TCB policy supplied, so the firmware level is NOT judged" };
  const bad = (why) => ({ ok: false, checked: false, reported, reason: why });
  if (!minTcb || typeof minTcb !== "object" || Array.isArray(minTcb)) return bad("minimum-TCB policy malformed: not an object keyed by product line");
  const lines = Object.keys(minTcb);
  if (!lines.length) return bad("minimum-TCB policy malformed: names no product line");
  for (const line of lines) {
    const f = minTcb[line], fields = TCB_FIELDS[line];
    if (!fields) return bad(`minimum-TCB policy malformed: unknown product line "${line}"`);
    if (!f || typeof f !== "object" || Array.isArray(f)) return bad(`minimum-TCB policy malformed: ${line} is not an object`);
    for (const k of Object.keys(f)) if (!fields.includes(k)) return bad(`minimum-TCB policy malformed: ${line} has unknown field "${k}"`);
    for (const k of fields)
      if (!Number.isInteger(f[k]) || f[k] < 0 || f[k] > 255) return bad(`minimum-TCB policy malformed: ${line}.${k} must be an integer 0-255`);
  }
  if (!product) return bad("cannot judge the TCB: the report's product line is unknown");
  const floor = minTcb[product];
  if (!floor) return bad(`the minimum-TCB policy has no floor for ${product}`);
  for (const k of TCB_FIELDS[product])
    if (reported[k] < floor[k]) return bad(`reported TCB below policy: ${product} ${k} ${reported[k]} < ${floor[k]}`);
  return { ok: true, checked: true, reported, reason: `reported TCB meets the supplied ${product} minimum (${fmtTcb(reported)})` };
}

// verifier/der.mjs
var toHex = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
};
var latin1 = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};
function tlv(b, off, limit = b.length) {
  if (!Number.isSafeInteger(off) || off < 0 || off + 2 > limit || limit > b.length) throw new Error("DER truncated");
  const tag = b[off];
  if ((tag & 31) === 31) throw new Error("DER long-form tag unsupported");
  let len = b[off + 1], p = off + 2;
  if (len === 128) throw new Error("DER indefinite length refused");
  if (len & 128) {
    const n = len & 127;
    if (n < 1 || n > 4 || p + n > limit) throw new Error("DER length form");
    if (b[p] === 0) throw new Error("DER non-minimal length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
    if (len < 128) throw new Error("DER non-minimal length");
  }
  if (p + len > limit) throw new Error("DER element overruns its parent");
  return { tag, start: p, end: p + len, hdr: off };
}
function children(b, node, cap = 4096) {
  if (!(node.tag & 32)) throw new Error("DER parent is not constructed");
  const out = [];
  let p = node.start;
  while (p < node.end) {
    if (out.length >= cap) throw new Error("DER: too many children");
    const c = tlv(b, p, node.end);
    out.push(c);
    p = c.end;
  }
  return out;
}
var bytes = (b, n) => b.subarray(n.start, n.end);
var whole = (b, n) => b.subarray(n.hdr, n.end);
function oid(b, n) {
  const v = bytes(b, n);
  if (!v.length) throw new Error("empty OID");
  const parts = [Math.floor(v[0] / 40), v[0] % 40];
  for (let i = 1, x = 0; i < v.length; i++) {
    x = x * 128 + (v[i] & 127);
    if (!(v[i] & 128)) {
      parts.push(x);
      x = 0;
    }
  }
  return parts.join(".");
}
function integer(b, n) {
  if (n.tag !== 2) throw new Error("DER: not an INTEGER");
  let v = bytes(b, n);
  if (!v.length) throw new Error("DER: empty INTEGER");
  if (v[0] & 128) throw new Error("DER: negative INTEGER where a serial was expected");
  while (v.length > 1 && v[0] === 0) v = v.subarray(1);
  return toHex(v);
}
function time(b, n) {
  const s = latin1(bytes(b, n));
  let m;
  if (n.tag === 23 && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    const yy = +m[1];
    return new Date(Date.UTC(yy >= 50 ? 1900 + yy : 2e3 + yy, +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }
  if (n.tag === 24 && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)))
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  throw new Error(`DER: unsupported time ${JSON.stringify(s)} (tag 0x${n.tag.toString(16)})`);
}
function parseCrl(der, { maxRevoked = 4096 } = {}) {
  if (!(der instanceof Uint8Array) || der.length < 8 || der.length > 1 << 20) throw new Error("CRL: not a bounded DER buffer");
  const top = tlv(der, 0);
  if (top.tag !== 48 || top.end !== der.length) throw new Error("CRL: not one SEQUENCE");
  const [tbs, sigAlg, sigVal] = children(der, top);
  if (!tbs || !sigAlg || !sigVal || sigVal.tag !== 3) throw new Error("CRL: shape");
  const k = children(der, tbs);
  let i = 0;
  const version = k[i].tag === 2 ? (i++, integer(der, k[i - 1])) : "00";
  const tbsSigAlg = k[i++], algOid = oid(der, children(der, tbsSigAlg)[0]);
  const issuer = k[i++];
  const thisUpdate = time(der, k[i++]);
  let nextUpdate = null;
  if (k[i] && (k[i].tag === 23 || k[i].tag === 24)) nextUpdate = time(der, k[i++]);
  const revoked = [];
  if (k[i] && k[i].tag === 48) {
    for (const e of children(der, k[i], maxRevoked)) {
      const [serial, date] = children(der, e);
      revoked.push({ serial: integer(der, serial), date: time(der, date) });
    }
    i++;
  }
  const sig = bytes(der, sigVal);
  if (sig[0] !== 0) throw new Error("CRL: BIT STRING with unused bits");
  return {
    version,
    algOid,
    issuerDer: whole(der, issuer),
    thisUpdate,
    nextUpdate,
    revoked,
    tbsDer: whole(der, tbs),
    signature: sig.subarray(1),
    sigAlgIsRsaPss: algOid === "1.2.840.113549.1.1.10",
    // the two AlgorithmIdentifiers as bytes (RFC 5280 5.1.1.2: they must be the same), for a profile that pins them
    sigAlgDer: whole(der, sigAlg),
    tbsSigAlgDer: whole(der, tbsSigAlg)
  };
}
function subjectNameDer(certDer) {
  const tbs = children(certDer, tlv(certDer, 0))[0];
  const k = children(certDer, tbs);
  let i = 0;
  if (k[0].tag === 160) i++;
  i++;
  i++;
  i++;
  i++;
  return whole(certDer, k[i]);
}

// verifier/tls-binding.mjs
import { createHash, X509Certificate } from "node:crypto";
var sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

// verifier/snp.mjs
var REPORT_SIZE = 1184;
var SIG_OFFSET = 672;
var MAX_REPORT_VERSION = 6;
var JUDGED_MAX_REPORT_VERSION = 5;
var verdictStatus = (omissions) => omissions.length ? "limited" : "verified";
var P384_N = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973");
var VCEK_GUID = "63da758de6644564adc5f4b93be8accd";
var hex = (b) => Buffer.from(b).toString("hex");
var fpHex = (cert) => String(cert.fingerprint256 || "").replace(/:/g, "").toLowerCase();
var cn = (dn) => (/(?:^|\n)CN=([^\n]+)/.exec(dn || "") || [])[1] || null;
var DEFAULT_SNP_POLICY = Object.freeze({
  allowedProducts: ["Milan", "Genoa", "Turin"],
  roots: AMD_ARK_SHA256,
  // product -> sha256 of the ARK (relay/snp-verify.mjs, corroborated against go-sev-guest)
  product: null,
  // required for report version 2 (no CPUID in the report); must agree with CPUID for v3+
  expectedVmpl: 0,
  guestPolicy: { debug: false, migrateMa: false, smt: "any", singleSocket: "any", cxlAllowed: "any", memAes256Xts: "any", raplDis: "any", ciphertextHidingDram: "any", pageSwapDisabled: "any" },
  minTcb: void 0,
  // { Product: { field: n } } per relay/snp-verify.mjs checkMinTcb; applied to reported AND committed TCB
  minFirmware: void 0,
  // { major, minor, build }: applied to current AND committed firmware version
  allowedMeasurements: [],
  // hex; empty = refuse (a verifier with no expected measurement has nothing to compare)
  crl: "required",
  // required | stale-ok | none
  crlMaxStaleDays: 0,
  researchAllowUnjudgedReportVersions: false
  // RESEARCH ONLY: run the checks on a report version whose new fields are unjudged; the result is at best "limited"
});
function parseReportStrict(r) {
  if (!Buffer.isBuffer(r)) throw new Error("report is not a byte buffer");
  if (r.length !== REPORT_SIZE) throw new Error(`report is ${r.length} bytes; the ABI fixes ATTESTATION_REPORT at ${REPORT_SIZE}`);
  const u32 = (o) => r.readUInt32LE(o), u64 = (o) => r.readBigUInt64LE(o);
  const p = {
    version: u32(0),
    guestSvn: u32(4),
    policy: u64(8),
    familyId: r.subarray(16, 32),
    imageId: r.subarray(32, 48),
    vmpl: u32(48),
    signatureAlgo: u32(52),
    currentTcb: r.subarray(56, 64),
    platformInfo: u64(64),
    signerInfo: u32(72),
    reportData: r.subarray(80, 144),
    measurement: r.subarray(144, 192),
    hostData: r.subarray(192, 224),
    idKeyDigest: r.subarray(224, 272),
    authorKeyDigest: r.subarray(272, 320),
    reportId: r.subarray(320, 352),
    reportIdMa: r.subarray(352, 384),
    reportedTcb: r.subarray(384, 392),
    cpuidFam: r[392],
    cpuidMod: r[393],
    cpuidStep: r[394],
    chipId: r.subarray(416, 480),
    committedTcb: r.subarray(480, 488),
    currentBuild: r[488],
    currentMinor: r[489],
    currentMajor: r[490],
    committedBuild: r[492],
    committedMinor: r[493],
    committedMajor: r[494],
    launchTcb: r.subarray(496, 504),
    launchMitVector: r.subarray(504, 512),
    currentMitVector: r.subarray(512, 520),
    // ABI Rev 1.59 (report version 6): extended TCB fields, parsed for display only, never judged here
    currentEtcb: r.subarray(544, 576),
    launchEtcb: r.subarray(576, 608),
    committedEtcb: r.subarray(608, 640),
    signature: r.subarray(SIG_OFFSET, SIG_OFFSET + 144),
    signedRegion: r.subarray(0, SIG_OFFSET)
  };
  if (p.version < 2) throw new Error(`report version ${p.version} < 2`);
  if (p.version > MAX_REPORT_VERSION) throw new Error(`report version ${p.version} is newer than this parser knows (ABI Rev 1.59 = version ${MAX_REPORT_VERSION})`);
  if (!(p.policy & 1n << 17n)) throw new Error("guest policy reserved bit 17 is not 1");
  if (p.policy >> 26n) throw new Error("guest policy bits 63:26 are not zero");
  if (p.signatureAlgo !== 1) throw new Error(`signature algorithm ${p.signatureAlgo} is not ECDSA P-384 with SHA-384 (1)`);
  if (p.signerInfo >>> 5) throw new Error("signer_info bits 31:5 are not zero");
  p.signingKey = p.signerInfo >>> 2 & 7;
  p.maskChipKey = !!(p.signerInfo & 2);
  p.authorKeyEn = !!(p.signerInfo & 1);
  if (p.signingKey !== 0) throw new Error(`report signed by key type ${p.signingKey} (1 = VLEK, 7 = none); only VCEK-signed reports chain to AMD's public roots here`);
  const mbz = (lo, hi, what) => {
    for (let i = lo; i < hi; i++) if (r[i]) throw new Error(`reserved bytes (${what}) are not zero`);
  };
  mbz(76, 80, "0x4c..0x50");
  mbz(p.version >= 3 ? 395 : 392, 416, "after CPUID");
  mbz(491, 492, "0x1eb");
  mbz(495, 496, "0x1ef");
  if (p.version <= 5) mbz(520, SIG_OFFSET, "0x208..0x2a0, version <= 5");
  mbz(SIG_OFFSET + 48, SIG_OFFSET + 72, "signature R zero-extension");
  mbz(SIG_OFFSET + 120, SIG_OFFSET + 144, "signature S zero-extension");
  mbz(SIG_OFFSET + 144, REPORT_SIZE, "signature tail");
  p.productHint = snpProductHint(p);
  p.policyBits = {
    abiMinor: Number(p.policy & 0xffn),
    abiMajor: Number(p.policy >> 8n & 0xffn),
    smt: !!(p.policy & 1n << 16n),
    migrateMa: !!(p.policy & 1n << 18n),
    debug: !!(p.policy & 1n << 19n),
    singleSocket: !!(p.policy & 1n << 20n),
    cxlAllowed: !!(p.policy & 1n << 21n),
    memAes256Xts: !!(p.policy & 1n << 22n),
    raplDis: !!(p.policy & 1n << 23n),
    ciphertextHidingDram: !!(p.policy & 1n << 24n),
    pageSwapDisabled: !!(p.policy & 1n << 25n)
  };
  p.platformBits = { smtEnabled: !!(p.platformInfo & 1n), tsmeEnabled: !!(p.platformInfo & 2n), eccEnabled: !!(p.platformInfo & 4n), raplDisabled: !!(p.platformInfo & 8n), ciphertextHidingDram: !!(p.platformInfo & 16n), aliasCheckComplete: !!(p.platformInfo & 32n), tioEnabled: !!(p.platformInfo & 128n) };
  return p;
}
function vcekFromAuxblob(aux) {
  if (!Buffer.isBuffer(aux) || aux.length > 64 * 1024) return null;
  for (let o = 0; o + 24 <= aux.length; o += 24) {
    const guid = hex(aux.subarray(o, o + 16));
    if (/^0+$/.test(guid)) break;
    const off = aux.readUInt32LE(o + 16), len = aux.readUInt32LE(o + 20);
    if (guid === VCEK_GUID) return off + len <= aux.length && len > 0 ? aux.subarray(off, off + len) : null;
  }
  return null;
}
function verifyReportSignature(p, vcekCert) {
  const rBE = Buffer.from(p.signature.subarray(0, 48)).reverse(), sBE = Buffer.from(p.signature.subarray(72, 72 + 48)).reverse();
  const R = BigInt("0x" + hex(rBE)), S = BigInt("0x" + hex(sBE));
  if (R === 0n || R >= P384_N || S === 0n || S >= P384_N) return { ok: false, why: "signature r or s is out of range for P-384" };
  const k = vcekCert.publicKey;
  if (k.asymmetricKeyType !== "ec" || k.asymmetricKeyDetails?.namedCurve !== "secp384r1") return { ok: false, why: "VCEK public key is not EC P-384" };
  let ok = false;
  try {
    ok = cryptoVerify("sha384", p.signedRegion, { key: k, dsaEncoding: "ieee-p1363" }, Buffer.concat([rBE, sBE]));
  } catch (e) {
    return { ok: false, why: `signature check error: ${e.message}` };
  }
  return { ok, why: ok ? null : "VCEK signature over the report is invalid" };
}
var pemCerts = (pem) => String(pem).split(/(?=-----BEGIN CERTIFICATE-----)/).filter((s) => s.includes("CERTIFICATE")).map((s) => new X509Certificate2(s));
var inWindow = (c, now) => now >= new Date(c.validFrom) && now <= new Date(c.validTo);
function parseAmdChain({ chainPem, product, now, roots = AMD_ARK_SHA256 }) {
  const fail = (why) => ({ ok: false, why });
  let chain;
  try {
    chain = pemCerts(chainPem);
  } catch (e) {
    return fail(`AMD chain unparseable: ${e.message}`);
  }
  if (chain.length !== 2) return fail(`AMD cert_chain must be exactly ASK then ARK (got ${chain.length} certificates)`);
  const [ask, ark] = chain;
  const want = roots.get(product);
  if (!want) return fail(`no pinned AMD root for product line ${JSON.stringify(product)} (fail closed)`);
  if (fpHex(ark) !== want) return fail(`the served ARK (${fpHex(ark).slice(0, 16)}...) is not AMD's pinned ${product} root`);
  if (cn(ark.subject) !== `ARK-${product}`) return fail(`ARK subject CN is ${cn(ark.subject)}, expected ARK-${product}`);
  if (cn(ask.subject) !== `SEV-${product}`) return fail(`ASK subject CN is ${cn(ask.subject)}, expected SEV-${product}`);
  for (const [c, what] of [[ark, "ARK"], [ask, "ASK"]]) if (!inWindow(c, now)) return fail(`${what} certificate is not valid at ${now.toISOString()} (${c.validFrom} .. ${c.validTo})`);
  for (const [c, what] of [[ark, "ARK"], [ask, "ASK"]]) if (c.publicKey.asymmetricKeyType !== "rsa" || c.publicKey.asymmetricKeyDetails?.modulusLength !== 4096) return fail(`${what} key is not RSA-4096`);
  if (!ark.verify(ark.publicKey)) return fail("ARK is not self-signed");
  if (!ask.checkIssued(ark) || !ask.verify(ark.publicKey)) return fail("ASK is not signed by the ARK");
  return { ok: true, why: null, ask, ark };
}
function checkChain({ vcekDer, chainPem, product, now, roots = AMD_ARK_SHA256 }) {
  const reasons = [], fail = (why) => ({ ok: false, why, reasons });
  let vcek;
  try {
    vcek = new X509Certificate2(vcekDer);
  } catch (e) {
    return fail(`VCEK unparseable: ${e.message}`);
  }
  const c = parseAmdChain({ chainPem, product, now, roots });
  if (!c.ok) return fail(c.why);
  const { ask, ark } = c;
  if (cn(vcek.subject) !== "SEV-VCEK") return fail(`VCEK subject CN is ${cn(vcek.subject)}, expected SEV-VCEK`);
  if (cn(vcek.issuer) !== `SEV-${product}`) return fail(`VCEK issuer CN is ${cn(vcek.issuer)}, expected SEV-${product}`);
  if (!inWindow(vcek, now)) return fail(`VCEK certificate is not valid at ${now.toISOString()} (${vcek.validFrom} .. ${vcek.validTo})`);
  if (!vcek.checkIssued(ask) || !vcek.verify(ask.publicKey)) return fail("VCEK is not signed by the ASK");
  reasons.push(`AMD chain verified: VCEK -> ASK (SEV-${product}) -> ARK-${product}, ARK pinned by sha256, all three valid at ${now.toISOString().slice(0, 10)}`);
  return { ok: true, why: null, reasons, vcek, ask, ark };
}
function checkCrlAuthentic({ crlDer, ark, now }) {
  let crl;
  try {
    crl = parseCrl(crlDer);
  } catch (e) {
    return { ok: false, why: `CRL unparseable: ${e.message}` };
  }
  if (!crl.sigAlgIsRsaPss) return { ok: false, why: `CRL signature algorithm ${crl.algOid} is not RSASSA-PSS` };
  if (!crl.issuerDer.equals(subjectNameDer(ark.raw))) return { ok: false, why: "CRL issuer is not the pinned ARK" };
  let sigOk = false;
  try {
    sigOk = cryptoVerify("sha384", crl.tbsDer, { key: ark.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, crl.signature);
  } catch (e) {
    return { ok: false, why: `CRL signature error: ${e.message}` };
  }
  if (!sigOk) return { ok: false, why: "CRL signature does not verify with the pinned ARK" };
  if (now < crl.thisUpdate) return { ok: false, why: `CRL thisUpdate ${crl.thisUpdate.toISOString()} is in the future` };
  return { ok: true, why: null, crl };
}
function checkCrl({ crlDer, ark, ask, now, mode = "required", maxStaleDays = 0 }) {
  const pre = crlPolicyPrelude({ crlDer, mode });
  if (pre) return pre;
  const a = checkCrlAuthentic({ crlDer, ark, now });
  if (!a.ok) return { ok: false, checked: false, reasons: [a.why] };
  return judgeCrl({ crl: a.crl, askSerialHex: ask.serialNumber, now, mode, maxStaleDays });
}
function crlPolicyPrelude({ crlDer, mode = "required" }) {
  if (mode === "none") return { ok: true, checked: false, reasons: ["CRL: policy 'none': revocation of the ASK was NOT checked"] };
  if (!crlDer) return mode === "required" ? { ok: false, checked: false, reasons: ["CRL: required by policy but none was supplied"] } : { ok: true, checked: false, reasons: ["CRL: none supplied; policy stale-ok continues WITHOUT a revocation check (say so to the user)"] };
  return null;
}
function judgeCrl({ crl, askSerialHex, now, mode = "required", maxStaleDays = 0 }) {
  const reasons = [];
  let stale = false;
  if (crl.nextUpdate && now > crl.nextUpdate) {
    const staleDays = (now - crl.nextUpdate) / 864e5;
    if (mode === "required" || staleDays > maxStaleDays) return { ok: false, checked: true, reasons: [`CRL is stale: nextUpdate ${crl.nextUpdate.toISOString()} is ${staleDays.toFixed(1)} days past (policy ${mode}${mode === "stale-ok" ? `, max ${maxStaleDays}` : ""})`] };
    reasons.push(`CRL is ${staleDays.toFixed(1)} days past nextUpdate; accepted under policy stale-ok (${maxStaleDays} days)`);
    stale = true;
  }
  const askSerial = String(askSerialHex).toLowerCase().replace(/^0+(?=.)/, "");
  const hit = crl.revoked.find((e) => e.serial.replace(/^0+(?=.)/, "") === askSerial);
  if (hit) return { ok: false, checked: true, reasons: [`the ASK (serial ${askSerialHex}) is REVOKED since ${hit.date.toISOString()}`] };
  reasons.push(`CRL verified (ARK-signed, ${crl.revoked.length} revoked serial(s), valid ${crl.thisUpdate.toISOString().slice(0, 10)} .. ${crl.nextUpdate ? crl.nextUpdate.toISOString().slice(0, 10) : "?"}); ASK serial ${askSerialHex} not revoked`);
  return { ok: true, checked: true, stale, reasons, nextUpdate: crl.nextUpdate };
}
var NODE_CRYPTO = Object.freeze({ checkChain, checkCrl, verifyReportSignature, sha256, certRaw: (c) => c.raw, certFp: fpHex });
var tcbHex = (b) => hex(b);
var fw = (maj, min, build) => `${maj}.${min} build ${build}`;
async function verifySnp(env, policy = {}, context = {}, collateral = null) {
  const pol = { ...DEFAULT_SNP_POLICY, ...policy, guestPolicy: { ...DEFAULT_SNP_POLICY.guestPolicy, ...policy.guestPolicy || {} } };
  const X = context.crypto || NODE_CRYPTO;
  const now = context.now ? new Date(context.now) : /* @__PURE__ */ new Date();
  const reasons = [], checks = {}, omissions = [], claims = { technology: "amd-sev-snp", format: env.format, family: env.spec.family };
  const out = (status) => ({ status, admissionSafe: status === "verified", omissions, reasons, checks, claims });
  const omit = (name, why) => {
    omissions.push(name);
    reasons.push(`OMITTED (${name}): ${why}`);
  };
  const fail = (name, why) => {
    checks[name] = false;
    reasons.push(`REJECT: ${why}`);
    return out("rejected");
  };
  const pass = (name, why) => {
    checks[name] = true;
    reasons.push(why);
  };
  let p;
  try {
    p = parseReportStrict(env.body);
  } catch (e) {
    return fail("report shape", e.message);
  }
  Object.assign(claims, {
    reportVersion: p.version,
    vmpl: p.vmpl,
    guestSvn: p.guestSvn,
    measurement: hex(p.measurement),
    reportData: hex(p.reportData),
    hostData: hex(p.hostData),
    chipId: hex(p.chipId),
    reportId: hex(p.reportId),
    guestPolicy: p.policyBits,
    platformInfo: p.platformBits,
    firmware: { current: fw(p.currentMajor, p.currentMinor, p.currentBuild), committed: fw(p.committedMajor, p.committedMinor, p.committedBuild) },
    idKeyDigest: hex(p.idKeyDigest),
    authorKeyDigest: hex(p.authorKeyDigest),
    authorKeyEn: p.authorKeyEn,
    maskChipKey: p.maskChipKey
  });
  pass("report shape", `report version ${p.version}, ${REPORT_SIZE} bytes, VCEK-signed, ECDSA P-384, reserved ranges zero`);
  if (p.version > JUDGED_MAX_REPORT_VERSION) {
    claims.unjudgedFields = { currentEtcb: hex(p.currentEtcb), launchEtcb: hex(p.launchEtcb), committedEtcb: hex(p.committedEtcb), reserved0x208: hex(env.body.subarray(520, 544)), reserved0x280: hex(env.body.subarray(640, SIG_OFFSET)) };
    const why = `report version ${p.version} (ABI Rev 1.59) carries CURRENT_ETCB, LAUNCH_ETCB and COMMITTED_ETCB (0x220..0x280) whose policy semantics and reserved ranges this verifier has not implemented or tested; the judged range is versions 2..${JUDGED_MAX_REPORT_VERSION}`;
    if (!pol.researchAllowUnjudgedReportVersions) {
      checks["report version"] = null;
      reasons.push(`UNSUPPORTED: ${why}`);
      return out("unsupported");
    }
    checks["report version"] = null;
    omit("report-version-unjudged", `${why} (researchAllowUnjudgedReportVersions: the verdict can be "limited" at best)`);
  } else checks["report version"] = true;
  let product = p.productHint;
  if (!product) {
    if (p.version >= 3) return fail("product line", `CPUID family 0x${p.cpuidFam.toString(16)} model 0x${p.cpuidMod.toString(16)} is not a known product line`);
    if (!pol.product) return fail("product line", "report version 2 carries no CPUID; policy.product must name the product line");
    product = pol.product;
  } else if (pol.product && pol.product !== product) return fail("product line", `policy expects ${pol.product} but the report's CPUID names ${product}`);
  if (!pol.allowedProducts.includes(product)) return fail("product line", `${product} is not an allowed product line (${pol.allowedProducts.join(", ")})`);
  claims.product = product;
  pass("product line", `product line ${product}${p.version >= 3 ? " (from the report's CPUID, confirmed below by the chain)" : " (from policy)"}`);
  if (p.policyBits.debug) return fail("guest policy", `guest policy 0x${p.policy.toString(16)} allows DEBUG: the host can read guest memory`);
  if (p.policyBits.migrateMa) return fail("guest policy", `guest policy 0x${p.policy.toString(16)} allows MIGRATE_MA`);
  for (const k of ["smt", "singleSocket", "cxlAllowed", "memAes256Xts", "raplDis", "ciphertextHidingDram", "pageSwapDisabled"]) {
    const want = pol.guestPolicy[k];
    if (want === "any" || want === void 0) continue;
    if (!!want !== p.policyBits[k]) return fail("guest policy", `guest policy ${k}=${p.policyBits[k]} but policy requires ${want}`);
  }
  pass("guest policy", `guest policy 0x${p.policy.toString(16)}: DEBUG off, MIGRATE_MA off, SMT ${p.policyBits.smt ? "allowed" : "off"}, ABI ${p.policyBits.abiMajor}.${p.policyBits.abiMinor}`);
  if (!Number.isInteger(pol.expectedVmpl) || pol.expectedVmpl < 0 || pol.expectedVmpl > 3) return fail("vmpl", `policy.expectedVmpl must be 0..3`);
  if (p.vmpl !== pol.expectedVmpl) return fail("vmpl", `report is from VMPL${p.vmpl}, policy expects VMPL${pol.expectedVmpl}`);
  pass("vmpl", p.vmpl === 0 ? "report is from VMPL0 (full privilege inside the guest)" : `report is from VMPL${p.vmpl} as expected (VMPL0..${p.vmpl - 1} of this guest are in its TCB)`);
  const tcb = decodeTcb(product, p.reportedTcb);
  const tcbHexStr = tcbHex(p.reportedTcb), chipHex = hex(p.chipId);
  const prov = (r) => r ? { source: r.source ?? null, fetchedAt: r.fetchedAt ?? null, cached: r.cached === true, ...r.stale !== void 0 ? { stale: r.stale === true } : {} } : null;
  claims.collateral = { vcek: null, chain: null, crl: null };
  let vcekDer = context.auxblob ? vcekFromAuxblob(context.auxblob) : null, vcekSource = vcekDer ? "the report's own certificate table" : null;
  if (vcekDer) claims.collateral.vcek = { source: vcekSource, fetchedAt: null, cached: false };
  if (!vcekDer && collateral) {
    try {
      const v = await collateral.vcek(product, chipHex, tcbHexStr, kdsVcekUrl(product, p).replace(/^https:\/\/[^/]+\//, ""));
      if (v) {
        vcekDer = v.der;
        vcekSource = v.source;
        claims.collateral.vcek = prov(v);
      }
    } catch (e) {
      return fail("vcek", `VCEK unavailable: ${e.message}`);
    }
  }
  if (!vcekDer) return fail("vcek", "no VCEK: not in the certificate table and no collateral source answered (the chain cannot be verified; nothing below is authenticated)");
  let chainPem;
  try {
    const c = await collateral?.chain(product);
    chainPem = c?.pem;
    claims.collateral.chain = prov(c);
  } catch (e) {
    return fail("chain", `AMD chain unavailable: ${e.message}`);
  }
  if (!chainPem) return fail("chain", `no AMD ASK/ARK chain for ${product} available`);
  const ch = await X.checkChain({ vcekDer, chainPem, product, now, roots: pol.roots });
  if (!ch.ok) return fail("chain", ch.why);
  checks.chain = true;
  reasons.push(...ch.reasons);
  claims.vcekSource = vcekSource;
  claims.vcekFingerprint = X.certFp(ch.vcek);
  claims.arkFingerprint = X.certFp(ch.ark);
  let crlDer = null;
  try {
    const c = await collateral?.crl?.(product);
    crlDer = c?.der ?? null;
    claims.collateral.crl = prov(c);
  } catch (e) {
    crlDer = null;
    claims.collateral.crl = { source: null, fetchedAt: null, cached: false, error: e.message };
  }
  const crl = await X.checkCrl({ crlDer, ark: ch.ark, ask: ch.ask, now, mode: pol.crl, maxStaleDays: pol.crlMaxStaleDays });
  reasons.push(...crl.reasons);
  if (!crl.ok) {
    checks.crl = false;
    return out("rejected");
  }
  checks.crl = crl.checked ? true : null;
  claims.crlChecked = crl.checked;
  if (crl.nextUpdate) claims.crlNextUpdate = crl.nextUpdate.toISOString();
  if (!crl.checked) omit("crl-revocation-unchecked", `ASK revocation was not checked (policy crl: ${pol.crl}${crlDer ? "" : ", no CRL supplied"})`);
  else if (crl.stale) omit("crl-stale-accepted", `the CRL is past nextUpdate and was accepted under policy stale-ok (${pol.crlMaxStaleDays} days)`);
  const sig = await X.verifyReportSignature(p, ch.vcek);
  if (!sig.ok) return fail("signature", sig.why);
  pass("signature", "PSP signature over bytes 0..0x2a0 verifies with the VCEK (r, s in range)");
  const mm = vcekMatchesReport(X.certRaw(ch.vcek), product, p);
  if (mm) return fail("vcek identity", mm);
  pass("vcek identity", `VCEK extensions name this chip (${chipHex.slice(0, 16)}...) and the reported TCB (${TCB_FIELDS[product].map((k) => `${k} ${tcb[k]}`).join(", ")})`);
  claims.tcb = { reported: tcb, current: decodeTcb(product, p.currentTcb), committed: decodeTcb(product, p.committedTcb), launch: decodeTcb(product, p.launchTcb) };
  const t = checkMinTcb(pol.minTcb, product, p);
  if (!t.ok) return fail("tcb policy", t.reason);
  if (t.checked) {
    const floor = pol.minTcb[product];
    const low = TCB_FIELDS[product].filter((k) => claims.tcb.committed[k] < floor[k]);
    if (low.length) return fail("tcb policy", `committed TCB below policy: ${low.map((k) => `${k} ${claims.tcb.committed[k]} < ${floor[k]}`).join(", ")} (the platform may roll back to it)`);
  }
  checks["tcb policy"] = t.checked ? true : null;
  if (t.checked) reasons.push(`${t.reason}; committed TCB meets it too`);
  else omit("tcb-floor-unjudged", `${t.reason}; the reported TCB is shown in the claims, not judged`);
  if (pol.minFirmware) {
    const { major, minor, build } = pol.minFirmware;
    const geq = (M, m, b) => M > major || M === major && (m > minor || m === minor && b >= build);
    if (!geq(p.currentMajor, p.currentMinor, p.currentBuild) || !geq(p.committedMajor, p.committedMinor, p.committedBuild)) return fail("firmware", `firmware current ${claims.firmware.current} / committed ${claims.firmware.committed} below policy ${fw(major, minor, build)}`);
    pass("firmware", `firmware ${claims.firmware.current} (committed ${claims.firmware.committed}) meets the floor`);
  }
  const allow = new Set((pol.allowedMeasurements || []).map((m) => String(m).toLowerCase()));
  if (!allow.size) return fail("measurement", "policy names no allowed measurement: a verifier with nothing expected has nothing to compare (fail closed)");
  if (!allow.has(claims.measurement)) return fail("measurement", `launch measurement ${claims.measurement.slice(0, 16)}... is not an allowed measurement`);
  pass("measurement", "launch measurement is one the policy allows (the caller's explicit expectation)");
  const rd0 = p.reportData.subarray(0, 32), rd1 = p.reportData.subarray(32, 64);
  const spki = context.transportKeySpki;
  if (!Buffer.isBuffer(spki) || spki.length < 44 || spki.length > 2048) return fail("binding", "no transport key SPKI from the verifier's own handshake: the binding cannot be checked (never skipped)");
  const spkiHash = Buffer.from(await X.sha256(spki));
  claims.transportSpkiSha256 = hex(spkiHash);
  if (env.spec.binding === "spki") {
    if (context.nonce && context.nonce.length !== 32) return fail("binding", "nonce must be 32 bytes");
    const want = Buffer.from(context.nonce ? await X.sha256(spki, context.nonce) : spkiHash);
    if (!want.equals(rd0)) return fail("binding", context.nonce ? "report_data[0:32] != sha256(SPKI || nonce): stale, replayed, or another key" : "report_data[0:32] != sha256(SPKI): another key");
    if (!rd1.equals(Buffer.alloc(32))) return fail("binding", "report_data[32:64] is not zero for the metal format");
    if (context.nonce) pass("binding", "report_data[0:32] binds the transport key and this verifier's fresh nonce");
    else {
      checks.binding = true;
      reasons.push("report_data[0:32] binds the transport key");
      omit("freshness-unbound", "no verifier nonce: the report proves key possession at attest time, not freshness (a replayed report is not excluded)");
    }
  } else if (env.spec.binding === "domain") {
    let want, abi;
    if (context.expectedBinding) {
      if (!Buffer.isBuffer(context.expectedBinding) || context.expectedBinding.length !== 32) return fail("binding", "expectedBinding must be 32 bytes");
      want = context.expectedBinding;
      abi = "ABI/2 (caller-derived Bind2 over key, nonce and runtime identity)";
    } else if (context.nonce) {
      if (context.nonce.length !== 32) return fail("binding", "nonce must be 32 bytes");
      want = Buffer.from(await X.sha256(spki, context.nonce));
      abi = "ABI/1 sha256(SPKI || nonce)";
    } else return fail("binding", "domain format needs a nonce (ABI/1) or an expectedBinding (ABI/2)");
    if (env.doc.abi === "enclave-domain-abi/2" !== !!context.expectedBinding) return fail("binding", `the document states abi ${env.doc.abi ?? "enclave-domain-abi/1"} but the verifier expected ${context.expectedBinding ? "ABI/2" : "ABI/1"}: no silent downgrade`);
    if (!want.equals(rd0)) return fail("binding", `report_data[0:32] does not equal the ${abi} binding`);
    if (!Buffer.isBuffer(context.expectedAppId) || context.expectedAppId.length !== 32) return fail("app id", "domain format needs the expected app id (32 bytes)");
    if (!rd1.equals(context.expectedAppId)) return fail("app id", `report_data[32:64] names app ${hex(rd1).slice(0, 16)}..., expected ${hex(context.expectedAppId).slice(0, 16)}...`);
    claims.appId = hex(rd1);
    claims.abi = env.doc.abi ?? "enclave-domain-abi/1";
    pass("binding", `report_data[0:32] equals the ${abi} binding`);
    pass("app id", "report_data[32:64] names the expected app");
  } else return fail("binding", `no binding rule for format ${env.format}`);
  if (context.expectedHostData !== void 0) {
    if (!Buffer.isBuffer(context.expectedHostData) || context.expectedHostData.length !== 32) return fail("host data", "expectedHostData must be exactly 32 bytes (the bytes32 deployment id)");
    if (p.hostData.equals(Buffer.alloc(32))) return fail("host data", "report HOST_DATA is all zero: this guest was launched without a deployment binding, refused when one is expected (never read as unbound)");
    if (!p.hostData.equals(context.expectedHostData)) return fail("host data", `report HOST_DATA names ${hex(p.hostData).slice(0, 16)}..., not the expected deployment ${hex(context.expectedHostData).slice(0, 16)}...`);
    pass("host data", "report HOST_DATA equals the expected deployment id (the host's launch-time binding, PSP-signed)");
  }
  claims.freshness = context.nonce || context.expectedBinding ? "verifier nonce" : "none (key possession only)";
  return out(verdictStatus(omissions));
}

// verifier/collateral.mjs
import fs from "node:fs";
import path from "node:path";
function fileCollateral(dir, { vceks = {}, chains = {}, crls = {} } = {}) {
  const read = (p) => {
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  };
  const stamp = (p) => {
    try {
      return fs.statSync(p).mtime.toISOString();
    } catch {
      return null;
    }
  };
  return {
    kind: "file",
    chain(product) {
      const p = chains[product] || path.join(dir, "amd", `${product}-cert_chain.pem`);
      const b = read(p);
      if (!b) throw new Error(`no AMD chain on file for ${product} (${p})`);
      return { pem: b.toString("utf8"), source: `file:${p}`, fetchedAt: stamp(p) };
    },
    vcek(product, chipIdHex, tcbHex2) {
      const key = `${product}-${chipIdHex}-${tcbHex2}`;
      const p = vceks[key] || vceks[product] || path.join(dir, "vcek", `${key}.der`);
      const b = read(p);
      return b ? { der: b, source: `file:${p}`, fetchedAt: stamp(p) } : null;
    },
    crl(product) {
      const p = crls[product] || path.join(dir, "amd", `${product}-crl.der`);
      const b = read(p);
      return b ? { der: b, source: `file:${p}`, fetchedAt: stamp(p) } : null;
    }
  };
}
function memoryCollateral({ chains = {}, vceks = {}, crls = {} } = {}) {
  return {
    kind: "memory",
    chain: (product) => {
      if (!chains[product]) throw new Error(`no AMD chain held for ${product}`);
      return { pem: chains[product], source: "memory" };
    },
    vcek: (product, chipIdHex, tcbHex2) => {
      const d = vceks[`${product}-${chipIdHex}-${tcbHex2}`] || vceks[product];
      return d ? { der: d, source: "memory" } : null;
    },
    crl: (product) => crls[product] ? { der: crls[product], source: "memory" } : null
  };
}
var AMD_KDS = "https://kdsintf.amd.com";
function httpCollateral({ base = AMD_KDS, timeoutMs = 8e3, maxBytes = 256 * 1024, fetchImpl = globalThis.fetch } = {}) {
  async function get(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      const chunks = [];
      let seen = 0;
      for await (const c of r.body ?? []) {
        seen += c.length;
        if (seen > maxBytes) {
          ctrl.abort();
          throw new Error(`${url}: body exceeds ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(c));
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(t);
    }
  }
  const now = () => (/* @__PURE__ */ new Date()).toISOString();
  return {
    kind: "http",
    base,
    async chain(product) {
      return { pem: (await get(`${base}/vcek/v1/${product}/cert_chain`)).toString("utf8"), source: `${base}/vcek/v1/${product}/cert_chain`, fetchedAt: now() };
    },
    async vcek(product, chipIdHex, tcbHex2, kdsPath) {
      const url = `${base}/${kdsPath}`;
      return { der: await get(url), source: url, fetchedAt: now() };
    },
    async crl(product) {
      const url = `${base}/vcek/v1/${product}/crl`;
      return { der: await get(url), source: url, fetchedAt: now() };
    }
  };
}
function layeredCollateral(...adapters) {
  const first = async (fn) => {
    let last = null;
    for (const a of adapters) {
      try {
        const r = await fn(a);
        if (r) return r;
      } catch (e) {
        last = e;
      }
    }
    if (last) throw last;
    return null;
  };
  return {
    kind: "layered",
    chain: (product) => first((a) => a.chain(product)),
    vcek: (product, chip, tcb, kdsPath) => first((a) => a.vcek(product, chip, tcb, kdsPath)),
    crl: (product) => first((a) => a.crl(product))
  };
}

// verifier/collateral-cache.mjs
import fs2 from "node:fs";
import path2 from "node:path";
import { createHash as createHash2, X509Certificate as X509Certificate3 } from "node:crypto";
var sha2562 = (b) => createHash2("sha256").update(b).digest("hex");
var cn2 = (dn) => (/(?:^|\n)CN=([^\n]+)/.exec(dn || "") || [])[1] || null;
var safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");
function cachedCollateral({ dir, upstream = null, now = () => /* @__PURE__ */ new Date(), roots = AMD_ARK_SHA256 } = {}) {
  if (!dir) throw new Error("cachedCollateral needs a directory");
  const events = [], stats = { hits: 0, misses: 0, fetches: 0, quarantined: 0, writeFailures: 0, staleServed: 0 };
  const note = (kind, key, why) => events.push({ kind, key, why });
  const file = (product, name) => path2.join(dir, safe(product), name);
  const read = (f) => {
    try {
      return fs2.readFileSync(f);
    } catch {
      return null;
    }
  };
  const meta = (f) => {
    try {
      return JSON.parse(fs2.readFileSync(`${f}.meta.json`, "utf8"));
    } catch {
      return null;
    }
  };
  const quarantine = (f, why) => {
    stats.quarantined++;
    note("quarantined", f, why);
    try {
      fs2.renameSync(f, `${f}.rejected-${Date.now()}`);
    } catch {
    }
    try {
      fs2.rmSync(`${f}.meta.json`, { force: true });
    } catch {
    }
  };
  const write = (f, bytes2, m) => {
    try {
      fs2.mkdirSync(path2.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
      fs2.writeFileSync(tmp, bytes2);
      fs2.renameSync(tmp, f);
      fs2.writeFileSync(`${f}.meta.json`, JSON.stringify({ sha256: sha2562(bytes2), ...m, validatedAt: now().toISOString() }) + "\n");
      return true;
    } catch (e) {
      stats.writeFailures++;
      note("cache-write-failed", f, e.message);
      return false;
    }
  };
  const chainMemo = /* @__PURE__ */ new Map();
  async function chain(product) {
    const f = file(product, "chain.pem");
    const cached = read(f);
    if (cached) {
      const m = meta(f), c2 = parseAmdChain({ chainPem: cached.toString("utf8"), product, now: now(), roots });
      if (c2.ok && m && m.sha256 === sha2562(cached)) {
        stats.hits++;
        chainMemo.set(product, c2);
        return { pem: cached.toString("utf8"), source: `cache:${f}`, fetchedAt: m.fetchedAt ?? null, cached: true };
      }
      quarantine(f, c2.ok ? "sidecar missing or its sha256 does not match the bytes" : c2.why);
    } else stats.misses++;
    if (!upstream) throw new Error(`no AMD chain for ${product}: not cached and no upstream source`);
    stats.fetches++;
    const r = await upstream.chain(product);
    if (!r || typeof r.pem !== "string") throw new Error(`no AMD chain for ${product} from ${upstream.kind || "upstream"}`);
    const c = parseAmdChain({ chainPem: r.pem, product, now: now(), roots });
    if (!c.ok) {
      note("upstream-refused", `${product} chain from ${r.source}`, c.why);
      throw new Error(`AMD chain from ${r.source} failed authentication: ${c.why}`);
    }
    chainMemo.set(product, c);
    write(f, Buffer.from(r.pem, "utf8"), { source: r.source ?? null, fetchedAt: r.fetchedAt ?? now().toISOString() });
    return { pem: r.pem, source: r.source ?? "upstream", fetchedAt: r.fetchedAt ?? null, cached: false };
  }
  async function askOf(product) {
    if (!chainMemo.has(product)) await chain(product);
    return chainMemo.get(product);
  }
  const vcekWhy = (der, product, ask, chipIdHex, tcbHex2) => {
    let v;
    try {
      v = new X509Certificate3(der);
    } catch (e) {
      return `VCEK unparseable: ${e.message}`;
    }
    if (cn2(v.subject) !== "SEV-VCEK") return `VCEK subject CN is ${cn2(v.subject)}`;
    if (cn2(v.issuer) !== `SEV-${product}`) return `VCEK issuer CN is ${cn2(v.issuer)}, expected SEV-${product}`;
    const t = now();
    if (t < new Date(v.validFrom) || t > new Date(v.validTo)) return `VCEK not valid at ${t.toISOString()}`;
    if (v.publicKey.asymmetricKeyType !== "ec" || v.publicKey.asymmetricKeyDetails?.namedCurve !== "secp384r1") return "VCEK key is not EC P-384";
    if (!v.checkIssued(ask) || !v.verify(ask.publicKey)) return "VCEK is not signed by the ASK";
    const mismatch = vcekMatchesReport(der, product, { chipId: Buffer.from(chipIdHex, "hex"), reportedTcb: Buffer.from(tcbHex2, "hex") });
    if (mismatch) return `${mismatch} (the slot ${chipIdHex.slice(0, 16)}.../${tcbHex2}: an authentic certificate for another chip or TCB is not this slot's)`;
    return null;
  };
  async function vcek(product, chipIdHex, tcbHex2, kdsPath) {
    if (!/^[0-9a-f]{128}$/.test(chipIdHex || "") || !/^[0-9a-f]{16}$/.test(tcbHex2 || "")) throw new Error(`VCEK slot key malformed (chip id ${JSON.stringify(chipIdHex)}, TCB ${JSON.stringify(tcbHex2)}): 64-byte and 8-byte lowercase hex are required`);
    const f = file(product, path2.join("vcek", `${safe(chipIdHex)}-${safe(tcbHex2)}.der`));
    const { ask } = await askOf(product);
    const cached = read(f);
    if (cached) {
      const m = meta(f), why2 = vcekWhy(cached, product, ask, chipIdHex, tcbHex2);
      if (!why2 && m && m.sha256 === sha2562(cached)) {
        stats.hits++;
        return { der: cached, source: `cache:${f}`, fetchedAt: m.fetchedAt ?? null, cached: true };
      }
      quarantine(f, why2 || "sidecar missing or its sha256 does not match the bytes");
    } else stats.misses++;
    if (!upstream) return null;
    stats.fetches++;
    const r = await upstream.vcek(product, chipIdHex, tcbHex2, kdsPath);
    if (!r) return null;
    if (!Buffer.isBuffer(r.der)) throw new Error(`VCEK from ${r.source} is not bytes`);
    const why = vcekWhy(r.der, product, ask, chipIdHex, tcbHex2);
    if (why) {
      note("upstream-refused", `${product} VCEK ${chipIdHex.slice(0, 16)} from ${r.source}`, why);
      throw new Error(`VCEK from ${r.source} failed authentication: ${why}`);
    }
    write(f, r.der, { source: r.source ?? null, fetchedAt: r.fetchedAt ?? now().toISOString(), chipId: chipIdHex, tcb: tcbHex2 });
    return { der: r.der, source: r.source ?? "upstream", fetchedAt: r.fetchedAt ?? null, cached: false };
  }
  async function crl(product) {
    const f = file(product, "crl.der");
    const { ark } = await askOf(product);
    const t = now();
    let staleCached = null;
    const cached = read(f);
    if (cached) {
      const m = meta(f), a = checkCrlAuthentic({ crlDer: cached, ark, now: t });
      if (a.ok && m && m.sha256 === sha2562(cached)) {
        const nextUpdate = a.crl.nextUpdate ? a.crl.nextUpdate.toISOString() : null;
        if (!a.crl.nextUpdate || t <= a.crl.nextUpdate) {
          stats.hits++;
          return { der: cached, source: `cache:${f}`, fetchedAt: m.fetchedAt ?? null, cached: true, stale: false, nextUpdate };
        }
        staleCached = { der: cached, source: `cache:${f}`, fetchedAt: m.fetchedAt ?? null, cached: true, stale: true, nextUpdate };
        note("stale", f, `CRL nextUpdate ${nextUpdate} is past; trying the upstream before serving it stale`);
      } else quarantine(f, a.ok ? "sidecar missing or its sha256 does not match the bytes" : a.why);
    } else stats.misses++;
    if (upstream) {
      stats.fetches++;
      let r = null, err = null;
      try {
        r = await upstream.crl(product);
      } catch (e) {
        err = e;
      }
      if (r && Buffer.isBuffer(r.der)) {
        const a = checkCrlAuthentic({ crlDer: r.der, ark, now: t });
        if (!a.ok) {
          note("upstream-refused", `${product} CRL from ${r.source}`, a.why);
          if (!staleCached) throw new Error(`CRL from ${r.source} failed authentication: ${a.why}`);
        } else {
          const nextUpdate = a.crl.nextUpdate ? a.crl.nextUpdate.toISOString() : null, stale = !!(a.crl.nextUpdate && t > a.crl.nextUpdate);
          write(f, r.der, { source: r.source ?? null, fetchedAt: r.fetchedAt ?? t.toISOString() });
          if (stale) stats.staleServed++;
          return { der: r.der, source: r.source ?? "upstream", fetchedAt: r.fetchedAt ?? null, cached: false, stale, nextUpdate };
        }
      } else if (err) note("upstream-failed", `${product} CRL`, err.message);
    }
    if (staleCached) {
      stats.staleServed++;
      note("stale-served", f, "no fresher CRL available; served stale for the policy to judge");
      return staleCached;
    }
    return null;
  }
  return { kind: "cache", dir, events, stats, chain, vcek, crl };
}

// verifier/metal-box.mjs
var TCB_FLOORS = Object.freeze({
  Genoa: Object.freeze({ bootloader: 10, tee: 0, snp: 23, microcode: 84 }),
  // metal0 (EPYC Turin), reported TCB 2026-10-14: fmc 1, bootloader 3, tee 2, snp 5, microcode 0x75
  Turin: Object.freeze({ fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 })
});
var FRESH_ATTESTATION_PATH = (name) => `/v1/enclaves/${encodeURIComponent(name)}/attestation`;
var OPERATOR_STATED = "expected-measurement-operator-stated";
var NAME = /^[A-Za-z0-9_-]{1,64}$/;
var HEX96 = /^[0-9a-f]{96}$/;
var toHex2 = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
var b64ToBytes = (s) => {
  const bin = atob(String(s));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
async function verifyMetalBoxWith(deps, { apiBase = "https://api.enclave.host", name, expected = null, minTcb = void 0, timeoutMs = 2e4 } = {}) {
  const at = (deps.now ? deps.now() : /* @__PURE__ */ new Date()).toISOString();
  const result = (fields) => ({ verifier: "enclave", subject: { kind: "metal-box", name: name ?? null, via: apiBase }, at, ...fields });
  const unavailable = (why) => result({ status: "unavailable", admissionSafe: false, omissions: [], failedChecks: [], checks: {}, reasons: [why], measurement: null });
  if (typeof name !== "string" || !NAME.test(name)) return unavailable("no box name (an attached box's name, e.g. metal0)");
  const pinned = expected && Array.isArray(expected.measurements) && expected.measurements.length ? expected.measurements.map((m) => String(m).toLowerCase()) : null;
  if (pinned && !pinned.every((m) => HEX96.test(m))) return unavailable("expected measurements must be 96 hex characters each");
  const nonce = deps.randomBytes(32);
  let body;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const fetchImpl = deps.fetchImpl;
      const r = await fetchImpl(`${apiBase}${FRESH_ATTESTATION_PATH(name)}?nonce=${toHex2(nonce)}`, { signal: ctrl.signal, redirect: "error", credentials: "omit", headers: { accept: "application/json" } });
      const text = await r.text();
      if (text.length > 512 * 1024) throw new Error("the answer exceeds 512 KiB");
      body = JSON.parse(text);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${body?.message || body?.error || "no document"}`);
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    return unavailable(`fresh attestation of ${name}: ${e && e.name === "AbortError" ? `no answer within ${timeoutMs} ms` : e.message}`);
  }
  const doc = body?.document;
  if (!doc || typeof doc !== "object" || doc.format !== "sev-snp-guest-metal-v1" || typeof doc.transportKey !== "string")
    return unavailable(`${name} did not return a metal SEV-SNP document (format ${doc?.format ?? "none"})`);
  if (body.nonce && body.nonce !== toHex2(nonce)) return unavailable("the relay answered for another nonce");
  const operator = (body.operatorAllowlist?.measurements || []).map((m) => String(m).toLowerCase()).filter((m) => HEX96.test(m));
  const allowed = pinned || operator;
  const source = pinned ? expected.source || "caller" : "operator allowlist (the relay's METAL_ALLOWED_MEASUREMENTS)";
  let spki;
  try {
    spki = b64ToBytes(doc.transportKey);
  } catch {
    return unavailable("the document's transport key is not base64");
  }
  const floor = minTcb ?? TCB_FLOORS;
  const policy = { snp: { allowedMeasurements: allowed, minTcb: floor } };
  const context = {
    transportKeySpki: deps.toBytes(spki),
    nonce: deps.toBytes(nonce),
    now: at,
    ...typeof doc.certs === "string" && doc.certs ? { auxblob: deps.toBytes(b64ToBytes(doc.certs)) } : {}
  };
  let v;
  try {
    v = await deps.verify(doc, { policy, context, collateral: deps.collateral });
  } catch (e) {
    return unavailable(`verifier: ${e.message}`);
  }
  const omissions = [...v.omissions || []], reasons = [...v.reasons || []];
  let status = v.status;
  if (!pinned && (status === "verified" || status === "limited")) {
    omissions.push(OPERATOR_STATED);
    reasons.push(`OMITTED (${OPERATOR_STATED}): the measurement matched the relay operator's own allowlist, not an expectation independent of the operator (pin one with expected.measurements / --expect)`);
    status = "limited";
  }
  const failedChecks = Object.entries(v.checks || {}).filter(([, x]) => x === false).map(([k]) => k);
  const keySha = toHex2(await deps.sha256(spki));
  return result({
    status,
    admissionSafe: status === "verified",
    omissions,
    failedChecks,
    checks: v.checks || {},
    reasons,
    measurement: v.claims?.measurement ?? null,
    product: v.claims?.product ?? null,
    tcb: v.claims?.tcb ?? null,
    nonce: toHex2(nonce),
    transportKeySha256: keySha,
    expected: { source, measurements: allowed, admittedAtAttach: body.operatorAllowlist?.admittedAtAttach ?? null },
    channel: `this request's TLS ends at the relay (${apiBase}); the report binds the box's transport key sha256:${keySha.slice(0, 16)}..., use that key for an end-to-end channel`,
    claims: v.claims || null,
    document: doc
  });
}

// verifier/consumer.mjs
async function verifyGuestDomainEvidence(doc, { policy = {}, context = {}, collateral = null } = {}) {
  let env;
  try {
    env = parseEnvelope(doc);
  } catch (e) {
    if (!(e instanceof EnvelopeError)) throw e;
    return {
      status: e.code === "unsupported" ? "unsupported" : "rejected",
      admissionSafe: false,
      omissions: [],
      technology: FORMATS[doc?.format]?.technology ?? null,
      reasons: [`${e.code.toUpperCase()}: ${e.message}`],
      checks: {},
      claims: null
    };
  }
  if (env.spec.technology !== TECH.SNP || env.format !== "sev-snp-guest-domain-v1")
    return { status: "unsupported", admissionSafe: false, omissions: [], technology: env.spec.technology, reasons: [`UNSUPPORTED: a release document is sev-snp-guest-domain-v1, not ${env.format}`], checks: {}, claims: null };
  return { technology: env.spec.technology, ...await verifySnp(env, policy.snp || {}, context, collateral) };
}
async function prewarmSnpCollateral(doc, collateral) {
  if (!collateral) return { ok: true, skipped: "no collateral adapter" };
  let p;
  try {
    p = parseReportStrict(parseEnvelope(doc).body);
  } catch {
    return { ok: true, skipped: "unparseable (the verifier refuses it)" };
  }
  const product = p.productHint;
  if (!product) return { ok: true, skipped: "the report names no product line (the verifier refuses it)" };
  const missing = [];
  try {
    const v = await collateral.vcek(product, hex2(p.chipId), hex2(p.reportedTcb), kdsVcekUrl(product, p).replace(/^https:\/\/[^/]+\//, ""));
    if (!v || !v.der) missing.push("vcek");
  } catch (e) {
    missing.push(`vcek (${e.message})`);
  }
  try {
    const c = await collateral.chain(product);
    if (!c || !c.pem) missing.push("chain");
  } catch (e) {
    missing.push(`chain (${e.message})`);
  }
  if (typeof collateral.crl === "function") {
    try {
      const c = await collateral.crl(product);
      if (!c || !c.der) missing.push("crl");
      else if (c.stale === true) missing.push("crl (stale)");
    } catch (e) {
      missing.push(`crl (${e.message})`);
    }
  }
  return missing.length ? { ok: false, product, missing } : { ok: true, product };
}
var hex2 = (b) => Buffer.from(b).toString("hex");
var unsupported = (technology, why) => ({ status: "unsupported", admissionSafe: false, omissions: [], technology, reasons: [`UNSUPPORTED: ${why}`], checks: {}, claims: null });
async function verifyMetalBox({ apiBase = "https://api.enclave.host", name, expected = null, minTcb = void 0, collateral = null, timeoutMs = 2e4, fetchImpl = globalThis.fetch, now = void 0 } = {}) {
  const verify = async (doc, { policy, context, collateral: c }) => {
    let env;
    try {
      env = parseEnvelope(doc);
    } catch (e) {
      if (!(e instanceof EnvelopeError)) throw e;
      return { status: e.code === "unsupported" ? "unsupported" : "rejected", admissionSafe: false, omissions: [], reasons: [`${e.code.toUpperCase()}: ${e.message}`], checks: {}, claims: null };
    }
    if (env.spec.technology !== TECH.SNP) return unsupported(env.spec.technology, `${env.format} is not SEV-SNP evidence`);
    return { technology: TECH.SNP, ...await verifySnp(env, policy.snp || {}, context, c) };
  };
  return verifyMetalBoxWith(
    {
      fetchImpl,
      verify,
      collateral: collateral ?? httpCollateral({ timeoutMs }),
      randomBytes: (n) => new Uint8Array(randomBytes(n)),
      sha256: async (b) => new Uint8Array(createHash3("sha256").update(b).digest()),
      toBytes: (u) => Buffer.from(u),
      now: now ? () => new Date(now) : void 0
    },
    { apiBase, name, expected, minTcb, timeoutMs }
  );
}
export {
  FRESH_ATTESTATION_PATH,
  OPERATOR_STATED,
  TCB_FLOORS,
  cachedCollateral,
  fileCollateral,
  httpCollateral,
  layeredCollateral,
  memoryCollateral,
  prewarmSnpCollateral,
  verifyGuestDomainEvidence,
  verifyMetalBox
};
