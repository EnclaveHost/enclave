// relay/snp-verify.mjs — first-party SEV-SNP quote verification for the fleet
// tunnel's attestation-gated attach (the permissionless-seller path). No Tinfoil,
// no third party: AMD KDS direct for the VCEK→ARK chain, a measurement allowlist
// of published Metal releases, and a per-attach freshness challenge.
//
// verifyQuote(report, { challenge, transportKeySpki, allowedMeasurements, requireVcek, minTcb, expectedVmpl })
//   -> { ok, measurement, reasons: [...], vcekVerified, vmpl, tcb: { product, reported, checked } }
// minTcb is the CALLER's minimum-TCB policy (see checkMinTcb). Nothing here chooses a firmware floor:
// omitted, the TCB is reported and left unjudged (tcb.checked false); supplied, it must be well formed
// and evaluable, or the quote fails.
import { createHash, X509Certificate, createVerify } from "node:crypto";

const KDS = "https://kdsintf.amd.com";
const VCEK_GUID = "63da758de6644564adc5f4b93be8accd";

export function parseSnpReport(r) {
  if (r.length < 0x2a0 + 0x90) throw new Error(`report too short: ${r.length}`);
  return {
    version: r.readUInt32LE(0x00),
    policy: r.readBigUInt64LE(0x08),
    vmpl: r.readUInt32LE(0x30),
    reportData: r.subarray(0x50, 0x50 + 64),
    measurement: r.subarray(0x90, 0x90 + 48),
    reportedTcb: r.subarray(0x180, 0x188),
    cpuidFam: r[0x188], cpuidMod: r[0x189], cpuidStep: r[0x18a],   // report version 3 and later
    chipId: r.subarray(0x1a0, 0x1a0 + 64),
    signature: r.subarray(0x2a0, 0x2a0 + 0x90),
    signedRegion: r.subarray(0x0, 0x2a0),
  };
}

function rawSigToDer(sig) {
  const r = Buffer.from(sig.subarray(0, 48)).reverse(), s = Buffer.from(sig.subarray(0x48, 0x48 + 48)).reverse();
  const trim = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; };
  const R = trim(r), S = trim(s), seq = Buffer.concat([Buffer.from([0x02, R.length]), R, Buffer.from([0x02, S.length]), S]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}

// KDS is a third party on the attach path: bound every call so a hung or
// black-holed fetch can't hold an attestation handshake open indefinitely —
// and bound the BODY too. A VCEK is ~1.3 KB and a cert_chain ~5 KB, so anything
// approaching this cap is a broken or hostile endpoint, and reading it into
// memory unbounded would be the cheapest possible attack on the relay from a
// position (answering for KDS) the ARK pin below already assumes is reachable.
const MAX_KDS_BYTES = 256 * 1024;
async function fetchBuf(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    const len = Number(r.headers.get("content-length") || 0);
    if (len > MAX_KDS_BYTES) throw new Error(`${url}: ${len} bytes exceeds the ${MAX_KDS_BYTES}-byte cap`);
    const chunks = []; let seen = 0;
    for await (const c of r.body ?? []) {                 // count as it arrives: a lying/absent length proves nothing
      seen += c.length;
      if (seen > MAX_KDS_BYTES) { ctrl.abort(); throw new Error(`${url}: body exceeds the ${MAX_KDS_BYTES}-byte cap`); }
      chunks.push(c);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  } finally { clearTimeout(t); }
}

// AMD's ROOT KEYS, pinned. The chain check below ends at "the ARK is
// self-signed", which proves the chain is internally consistent and nothing
// more: whoever serves the cert_chain gets to BE the root. That made the whole
// hardware-attestation argument rest on TLS to one host — a KDS the attacker
// controls (a mis-issued cert, a hijacked route, a rogue CA in the local trust
// store) can serve a fabricated ARK+ASK and sign a VCEK for a report it wrote,
// and every step here would pass. Pinning turns that into "compromise KDS AND
// this repo".
//
// PROVENANCE, because a pin nobody can re-derive is just a different kind of
// trust: ALL THREE were captured from KDS and then CONFIRMED byte-for-byte
// against google/go-sev-guest's embedded copies — a different host, a different
// TLS chain, a different party. The files are verify/trust/ask_ark_milan.pem,
// ask_ark_genoa.pem and ask_ark_turin_vcek.pem (Turin's is named for the VCEK
// line; the VLEK chain beside it is a different root and NOT what a guest
// report chains to). Re-check the same way if a product line is ever added.
//
// A NEW AMD product line fails CLOSED here (unknown root -> refused), which is
// the correct direction: the alternative, accepting an unpinned root with a
// warning, hands the attacker exactly the bypass this closes (the product name
// is read out of the peer's own VCEK issuer).
export const AMD_ARK_SHA256 = new Map([
  ["Milan", "69d063b45344d26a2e94e1f4210de49ef555308287d4c174445c95639a540bcd"],
  ["Genoa", "4c6598d19c18719c5dfd4a7d335f674e5bfe1d8f800cea2cf270c10d103db2f1"],
  ["Turin", "1f084161a44bb6d93778a904877d4819cafa5d05ef4193b2ded9dd9c73dd3f6a"],
]);
const fpHex = (cert) => String(cert.fingerprint256 || "").replace(/:/g, "").toLowerCase();
// Is this the AMD root for `product`? Exported so the buyer-side verifier and
// the tests check the same predicate rather than a second copy of it.
export function isPinnedArk(cert, product) {
  const want = AMD_ARK_SHA256.get(product);
  return !!want && fpHex(cert) === want;
}

// AMD's per-product ARK/ASK chain never changes; KDS rate-limits, so cache it.
// Exported so the test can drive the REAL fetch+pin path (with fetch stubbed)
// rather than a re-implementation of it.
const _chainCache = new Map();   // product -> [ASK, ARK] X509Certificates
export async function certChain(product, { kds = true } = {}) {
  if (_chainCache.has(product)) return _chainCache.get(product);
  if (!kds) throw new Error(`no AMD chain held for ${product} and KDS lookups are off`);
  return seedCertChain(product, (await fetchBuf(`${KDS}/vcek/v1/${product}/cert_chain`)).toString("utf8"));
}
// The same parse-and-pin, for a chain the caller already holds (a copy of KDS's cert_chain): a file is
// exactly as trustworthy as the network here, because nothing is cached unless its ARK is the pin.
export function seedCertChain(product, pem) {
  const chain = pem.split(/(?=-----BEGIN CERTIFICATE-----)/)
    .filter((s) => s.includes("CERTIFICATE")).map((s) => new X509Certificate(s));
  // Pin BEFORE caching: a refused chain must not be remembered as this
  // product's, and every later call re-asks rather than serving a bad hit.
  const ark = chain[chain.length - 1];
  if (!ark || !isPinnedArk(ark, product))
    throw new Error(`${product}: the served ARK is not AMD's pinned root `
      + `(${ark ? fpHex(ark).slice(0, 16) + "…" : "no root in chain"})`);
  _chainCache.set(product, chain);
  return chain;
}

// VCEKs fetched from KDS, by URL. A VCEK never changes for a (chip, TCB), and KDS answers 429 after a
// couple of requests, so one per box is enough. Only a VCEK that went on to chain to the pinned root
// is remembered: whoever answers for KDS cannot park a bad one here.
const _vcekCache = new Map();
const VCEK_CACHE_MAX = 256;

function vcekFromAuxblob(aux) {
  try {
    for (let o = 0; o + 24 <= aux.length; o += 24) {
      const guid = aux.subarray(o, o + 16).toString("hex");
      if (/^0+$/.test(guid)) break;
      const off = aux.readUInt32LE(o + 16), len = aux.readUInt32LE(o + 20);
      if (guid === VCEK_GUID && off + len <= aux.length) return aux.subarray(off, off + len);
    }
  } catch {}
  return null;
}

// --- product lines: TCB layout, KDS lookup, VCEK extensions ---------------------------------------
// The 8-byte TCB_VERSION is laid out differently per product line (SEV-SNP ABI specs):
//   Milan, Genoa: [0] boot loader, [1] TEE, [2..5] reserved, [6] SNP, [7] microcode
//   Turin:        [0] FMC, [1] boot loader, [2] TEE, [3] SNP, [4..6] reserved, [7] microcode
// Reading a Turin TCB with the Milan layout asks KDS for the wrong SPLs, and Turin's KDS hwID is the
// first 8 bytes of CHIP_ID, not all 64. Both verifiers did exactly that, so every Turin box looked like
// "KDS has no VCEK for this chip" (warden-host included) when KDS had one all along.
export const TCB_FIELDS = {
  Milan: ["bootloader", "tee", "snp", "microcode"],
  Genoa: ["bootloader", "tee", "snp", "microcode"],
  Turin: ["fmc", "bootloader", "tee", "snp", "microcode"],
};
export function decodeTcb(product, b) {
  if (product === "Turin") return { fmc: b[0], bootloader: b[1], tee: b[2], snp: b[3], microcode: b[7] };
  if (product === "Milan" || product === "Genoa") return { bootloader: b[0], tee: b[1], snp: b[6], microcode: b[7] };
  throw new Error(`no TCB layout for product line ${product}`);
}
const fmtTcb = (t) => Object.entries(t).map(([k, v]) => `${k} ${v}`).join(", ");

// Which product line the report says it came from (CPUID family/model, report version 3 and later).
// The PSP writes these, but before the chain verifies they are only the host's word: this picks which
// KDS URL to try, and a wrong answer simply fails at the pinned chain.
export function snpProductHint(p) {
  if (p.version < 3) return null;
  const fam = p.cpuidFam, mod = p.cpuidMod;
  if (fam === 0x19 && mod < 0x10) return "Milan";
  if (fam === 0x19 && ((mod >= 0x10 && mod < 0x20) || (mod >= 0xa0 && mod < 0xb0))) return "Genoa";
  if (fam === 0x1a && mod < 0x20) return "Turin";
  return null;
}

export function kdsVcekUrl(product, p) {
  const t = decodeTcb(product, p.reportedTcb);
  if (product === "Turin") {
    const d = (n) => String(n).padStart(2, "0");
    return `${KDS}/vcek/v1/Turin/${p.chipId.subarray(0, 8).toString("hex")}`
      + `?fmcSPL=${d(t.fmc)}&blSPL=${d(t.bootloader)}&teeSPL=${d(t.tee)}&snpSPL=${d(t.snp)}&ucodeSPL=${d(t.microcode)}`;
  }
  return `${KDS}/vcek/v1/${product}/${p.chipId.toString("hex")}`
    + `?blSPL=${t.bootloader}&teeSPL=${t.tee}&snpSPL=${t.snp}&ucodeSPL=${t.microcode}`;
}

// Minimal DER reading, enough for the VCEK's AMD extensions (1.3.6.1.4.1.3704.1.*).
function derAt(b, o) {
  if (o + 2 > b.length) throw new Error("DER truncated");
  let len = b[o + 1], p = o + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new Error("DER length form");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  if (p + len > b.length) throw new Error("DER overrun");
  return { tag: b[o], start: p, end: p + len };
}
function derKids(b, t) { const out = []; for (let o = t.start; o < t.end;) { const k = derAt(b, o); out.push(k); o = k.end; } return out; }
function oidOf(b) {
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  for (let i = 1, v = 0; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join(".");
}
// extension OID -> the bytes inside its extnValue OCTET STRING
export function certExtensions(der) {
  const tbs = derKids(der, derAt(der, 0))[0];
  const ext = derKids(der, tbs).find((k) => k.tag === 0xa3);
  const out = new Map();
  if (!ext) return out;
  for (const e of derKids(der, derKids(der, ext)[0])) {
    const kids = derKids(der, e), oid = kids[0], val = kids[kids.length - 1];
    if (oid.tag === 0x06 && val.tag === 0x04) out.set(oidOf(der.subarray(oid.start, oid.end)), der.subarray(val.start, val.end));
  }
  return out;
}
function derUint(v) {
  const t = derAt(v, 0);
  if (t.tag !== 0x02 || t.end !== v.length || t.end === t.start || (v[t.start] & 0x80)) return null;
  let n = 0;
  for (let i = t.start; i < t.end; i++) n = n * 256 + v[i];
  return n;
}
const AMD = "1.3.6.1.4.1.3704.1";
const SPL_OID = { bootloader: `${AMD}.3.1`, tee: `${AMD}.3.2`, snp: `${AMD}.3.3`, microcode: `${AMD}.3.8`, fmc: `${AMD}.3.9` };

// A VCEK is issued for ONE chip at ONE TCB. Its extensions must name the report's chip and the
// report's REPORTED_TCB exactly; a VCEK for another chip or another TCB is not this report's key.
// Returns null when they match, else why not. Missing extensions are a mismatch, never a pass.
export function vcekMatchesReport(vcekDer, product, p) {
  let ext;
  try { ext = certExtensions(vcekDer); } catch (e) { return `VCEK extensions unreadable: ${e.message}`; }
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
  if (hw.length !== hwLen && hw[0] === 0x04) { try { const t = derAt(hw, 0); hw = hw.subarray(t.start, t.end); } catch {} }
  if (hw.length !== hwLen) return `VCEK hardware ID is ${hw.length} bytes, ${product} uses ${hwLen}`;
  if (!hw.equals(p.chipId.subarray(0, hwLen))) return "VCEK hardware ID does not match the report's CHIP_ID";
  return null;
}

// The caller's minimum-TCB policy: { <product line>: { <every field of TCB_FIELDS[product]>: 0..255 } }.
// Every field is required, so no floor is ever filled in here. The floor applies to REPORTED_TCB, the TCB
// the VCEK signing key is derived from (and which the VCEK's extensions must equal).
export function checkMinTcb(minTcb, product, p) {
  const reported = product && TCB_FIELDS[product] ? decodeTcb(product, p.reportedTcb) : null;
  if (minTcb === undefined)
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

// kds: false never contacts AMD KDS: the VCEK must arrive in the auxblob and the chain must already be
// held (seedCertChain). For callers that fetch once and verify many times; KDS answers 429 quickly.
// The CHIP_ID a verified report PROVES, or null: only when the verdict checked the report's signature against the chip's
// own VCEK (vcekVerified), the report says it is VCEK-signed (SIGNING_KEY = 0), and the CHIP_ID is not masked (zero). A
// measurement-only verdict never checked the signature against the chip, so its CHIP_ID proves nothing.
export function provenSnpChip(report, verdict) {
  const r = Buffer.from(report || []);
  if (!verdict || verdict.ok !== true || verdict.vcekVerified !== true || r.length < 0x1e0) return null;
  const chip = r.subarray(0x1a0, 0x1e0), signingKey = (r.readUInt32LE(0x48) >> 2) & 0x7;
  return signingKey === 0 && chip.some((x) => x !== 0) ? chip.toString("hex") : null;
}

export async function verifyQuote(report, { challenge, transportKeySpki, allowedMeasurements, auxblob = null, requireVcek = true, minTcb, kds = true, expectedVmpl = 0 } = {}) {
  const reasons = [];
  const fail = (m) => { reasons.push(m); return { ok: false, measurement: null, reasons }; };
  let p;
  try { p = parseSnpReport(report); } catch (e) { return fail(`unparseable report: ${e.message}`); }

  if (p.version < 2) return fail(`report version ${p.version} < 2`);

  // VMPL. The report records which privilege level ASKED for it (Linux writes it through configfs-tsm
  // `privlevel`, whose floor is the guest's own VMPL). The launch measurement is the same at every level,
  // because it covers the CVM's initial memory as a whole, so this field is the ONLY thing that
  // distinguishes a report fetched by a VMPL0 component from one fetched by a lower-privilege plane in
  // the same guest. It therefore has to be pinned rather than merely recorded.
  //
  // The default is 0: full privilege inside the CVM, which is what every enclave the platform runs today
  // reports, and what metal0's attach path has always required. A caller that expects a lower plane
  // (isolation/DESIGN.md section 12: a monitor at VMPL0 with app domains beneath it) must say which level
  // it expects. Accepting a lower level silently would be the real hazard: a report from VMPL3 proves the
  // launch image, but whatever runs at VMPL0..2 of that guest is more privileged than the reporter and
  // is inside its TCB, so the verifier must not treat the two as interchangeable.
  if (!Number.isInteger(expectedVmpl) || expectedVmpl < 0 || expectedVmpl > 3)
    return fail(`expectedVmpl must be an integer 0-3 (got ${JSON.stringify(expectedVmpl)})`);
  if (p.vmpl !== expectedVmpl) return fail(`VMPL ${p.vmpl} != expected ${expectedVmpl}`);
  reasons.push(expectedVmpl === 0 ? "report is from VMPL0 (full privilege inside the CVM)"
    : `report is from VMPL${expectedVmpl}, as the caller expected (VMPL0-${expectedVmpl - 1} of this guest are more privileged and in its TCB)`);

  // 0. GUEST POLICY. The launch measurement covers the guest's initial memory —
  //    it does NOT cover the policy the hypervisor launched it under, which is
  //    reported separately here. An allowlisted image booted with DEBUG enabled
  //    is a transparent box: the host may read and write guest memory at will
  //    (transport private key included) while still producing a report whose
  //    measurement matches bit-for-bit. MIGRATE_MA is the same hole one step
  //    removed — it lets a migration agent move the guest's state off this
  //    platform. Both must be off before anything else about the quote matters.
  const POLICY_DEBUG = 1n << 19n, POLICY_MIGRATE_MA = 1n << 18n;
  if (p.policy & POLICY_DEBUG) return fail(`guest policy 0x${p.policy.toString(16)} allows DEBUG (host can read guest memory)`);
  if (p.policy & POLICY_MIGRATE_MA) return fail(`guest policy 0x${p.policy.toString(16)} allows MIGRATE_MA`);
  reasons.push(`guest policy 0x${p.policy.toString(16)}: DEBUG off, MIGRATE_MA off`);

  const measurement = p.measurement.toString("hex");

  // 1. measurement ∈ allowlist of published Metal releases
  const allow = new Set((allowedMeasurements || []).map((m) => m.toLowerCase()));
  if (!allow.has(measurement)) return fail(`measurement ${measurement.slice(0, 16)}… not on the Metal release allowlist`);
  reasons.push("measurement on Metal release allowlist");

  // 2. freshness + key binding: report_data == sha256(transportKeySpki || challenge)
  if (transportKeySpki && challenge) {
    const want = createHash("sha256").update(Buffer.concat([transportKeySpki, challenge])).digest();
    if (Buffer.compare(want, p.reportData.subarray(0, 32)) !== 0) return fail("report_data does not bind (transport key || challenge)");
    reasons.push("report_data binds transport key + fresh challenge");
  } else return fail("missing challenge or transport key for freshness check");

  // 3. AMD hardware-signature chain (VCEK → ASK → ARK). Required in production;
  // on unprovisioned parts (no KDS VCEK) it is inconclusive.
  const hint = snpProductHint(p);
  let vcek = auxblob ? vcekFromAuxblob(auxblob) : null;
  let src = vcek ? "auxblob" : null;
  let kdsUrl = null;
  if (!vcek && kds) for (const prod of hint ? [hint] : ["Turin", "Genoa", "Milan"]) {
    const url = kdsVcekUrl(prod, p);
    try { vcek = _vcekCache.get(url) || await fetchBuf(url); src = `KDS/${prod}`; kdsUrl = url; var product = prod; break; } catch {}
  }
  if (!vcek) {
    if (requireVcek) return fail(`no VCEK available (${auxblob ? "the auxblob holds none" : "no auxblob"}; `
      + `${kds ? "KDS returned none for this chip/TCB, or refused the request" : "KDS not consulted"}) — cannot verify the AMD signature chain`);
    reasons.push("WARN: AMD signature chain inconclusive (no VCEK); measurement+binding only");
    // A policy the caller supplied is still applied, to the report's own (unauthenticated) TCB field;
    // it never becomes a pass because the data to judge it was missing.
    const t = checkMinTcb(minTcb, hint, p);
    if (!t.ok) return fail(t.reason);
    reasons.push(t.checked ? `${t.reason} (unauthenticated: no VCEK)` : t.reason);
    return { ok: true, measurement, reasons, vcekVerified: false, vmpl: p.vmpl, tcb: { product: hint, reported: t.reported, checked: t.checked } };
  }
  try {
    const vcekCert = new X509Certificate(vcek);
    const v = createVerify("sha384"); v.update(p.signedRegion); v.end();
    // vcekCert.publicKey is already a public KeyObject. createPublicKey() refuses one
    // (ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE), which used to fail EVERY VCEK-bearing report here as a
    // "cert-chain verification error" before its signature was ever checked.
    if (!v.verify({ key: vcekCert.publicKey, dsaEncoding: "der" }, rawSigToDer(p.signature)))
      return fail("VCEK signature over the report is invalid");
    // Which product line's ARK/ASK to chain to. A KDS-fetched VCEK already
    // named it; one supplied in the auxblob does not, so read the product out
    // of the cert's own issuer (CN=SEV-Milan / SEV-Genoa / SEV-Turin …) and
    // only then fall back to trying the known lines. Hardcoding "Milan" here
    // silently rejected every Genoa/Turin box that shipped its own VCEK.
    const fromIssuer = (/SEV-([A-Za-z0-9]+)/.exec(vcekCert.issuer || "") || [])[1] || null;
    const candidates = [...new Set([src.startsWith("KDS/") ? src.slice(4) : null, fromIssuer, product,
                                    "Milan", "Genoa", "Turin"].filter(Boolean))];
    let chained = null, lastWhy = "no AMD product line matched";
    for (const which of candidates) {
      let ask, ark;
      try { [ask, ark] = await certChain(which, { kds }); } catch (e) { lastWhy = `${which}: ${e.message}`; continue; }
      if (!(ask && ark)) { lastWhy = `${which}: incomplete cert chain`; continue; }
      if (!vcekCert.verify(ask.publicKey)) { lastWhy = "VCEK does not chain to ASK"; continue; }
      if (!ask.verify(ark.publicKey)) return fail("ASK does not chain to ARK");
      if (!ark.verify(ark.publicKey)) return fail("ARK not self-signed");
      chained = which; break;
    }
    if (!chained) return fail(lastWhy);
    reasons.push(`AMD signature chain verified (VCEK ${src} → ASK → ARK, ${chained})`);
    if (kdsUrl && !_vcekCache.has(kdsUrl)) {
      if (_vcekCache.size >= VCEK_CACHE_MAX) _vcekCache.delete(_vcekCache.keys().next().value);
      _vcekCache.set(kdsUrl, vcek);
    }
    // 4. the VCEK is THIS report's key: same chip, same reported TCB, and the product line the
    //    report's CPUID names (when it names one) is the one the chain proved
    if (hint && hint !== chained) return fail(`the report's CPUID names ${hint} but its VCEK chains to ${chained}`);
    const mismatch = vcekMatchesReport(vcekCert.raw, chained, p);
    if (mismatch) return fail(mismatch);
    reasons.push("VCEK chip ID and TCB extensions match the report");
    // 5. the caller's minimum-TCB policy, judged on the now-authenticated reported TCB
    const t = checkMinTcb(minTcb, chained, p);
    if (!t.ok) return fail(t.reason);
    reasons.push(t.reason);
    return { ok: true, measurement, reasons, vcekVerified: true, vmpl: p.vmpl, tcb: { product: chained, reported: t.reported, checked: t.checked } };
  } catch (e) { return fail(`cert-chain verification error: ${e.message}`); }
}
