// Platform certificates for the platform's OWN zones: an enclave that holds a
// deployment's lease sends the relay a CSR for <label>.APP_ZONE and gets back
// a CA-issued certificate. The private key never leaves the CVM — the relay
// sees a CSR and hands back a certificate, and signs nothing itself.
//
// WHY THIS EXISTS. Until 2026-07-11 Caddy on the relay minted app-zone certs
// (on-demand TLS gated by /internal/tls-ask) and was retired because the relay
// then HELD app TLS keys. Since then every enclave has run its own ACME client
// (supervisor.js acmeIssue), which needs the platform's ZeroSSL EAB pair on
// every box — as a Tinfoil fleet secret, and on metal boxes as an fw_cfg
// config file outside the CVM. That pair is a platform credential: whoever
// holds it can register accounts and order certificates for any name they can
// answer dns-01 for. Putting it on N boxes was the price of keeping keys in
// the CVM. This route keeps the key in the CVM AND keeps the CA account on the
// relay: the enclave generates the pair, builds the CSR, and asks here; the
// relay owns the CA accounts, the EAB pair, the pacing against shared CA rate
// limits, and the dns-01 answer (it already runs the DNS daemon the TXT goes
// to). Caddy's /internal/tls-ask stays for CUSTOMER domains, which still take
// the in-enclave ACME path (docs/custom-domains.md).
//
// WHAT THE RELAY HOLDS: CA account keys (encrypted at rest), the EAB pair, the
// issued certificates (public), and the derived CERTS_KEY. Never a private key
// for any certificate, never the fleet SECRET. WHAT IT REFUSES: any name that
// is not <canonical label>.<APP_ZONE|TCP_ZONE> — a customer domain, an apex,
// api./www./mcp., a second-level label — and any CSR that is not exactly
// {CN==name, SAN==[name]} on a P-256 or RSA>=2048 key. The service may only
// ever issue for names in the zones it owns; that is the operator constraint
// and it is enforced before a CA is contacted, not by the CA.
//
// THE ROUTE (relay-owned, like /v1/secrets/*):
//   POST /v1/certs/issue  { name, csr, endpoint, ts, sig, opSig }
//     sig   = HMAC-SHA256(CERTS_KEY, "<name>:<endpoint>:<ts>") hex — OPTIONAL
//             (first-party boxes send it; a seller box without a fleet SECRET
//             cannot, and opSig + the lease are the authorization anyway)
//             CERTS_KEY = HMAC-SHA256(fleet SECRET, "enclave certs v1") hex —
//             the dns-relay / secrets.js derived-key pattern: the relay env
//             holds only the derived key, never the SECRET.
//     opSig = EIP-191 personal_sign by the endpoint's EnclaveRegistry operator
//             of "enclave-certs-issue:<name>:<endpoint>:<ts>" — the secrets.js
//             rule: the fleet key alone proves "a holder of the fleet key";
//             naming another box's endpoint needs THAT box's key.
//     Authorization: the deployment the label names must have a live lease
//     held by `endpoint` (runner = keccak256(endpoint)), read from the ledger
//     exactly as secrets.js reads it for a fetch.
//   200 { name, certPem, notBefore, notAfter, ca, cached }
//   202 { name, retryAfterSec }         order in flight / CAs cooling / paced
//   4xx { error, message }              refusals (fail closed, nothing issued)
//   503 { error: "certs_disabled" }     not configured
//
// CACHE: (name, sha256(SPKI)) -> cert, kept until 2/3 of lifetime, so a box
// that re-asks with the same key (a restart, a lease that bounced back) pays
// no issuance. PACING: a per-endpoint bucket and a global per-CA bucket. Let's
// Encrypt's 50 certs/registered-domain/week is shared by EVERY seller in the
// zone; this service is the one place that can see and pace that.
//
// Config (env): CERTS_KEY, DNS_API, DNS_TXT_KEY, APP_ZONE are REQUIRED (plus
// the AUTH_DATA_DIR activation switch); TCP_ZONE optional; ACME_EAB_KID +
// ACME_EAB_HMAC (the platform pair; without them the ZeroSSL slot is skipped
// and Let's Encrypt is the only CA); ACME_CONTACT; ACME_DIRECTORY /
// ACME_DIRECTORY_2 override the two CA directories (tests point them at mocks).

import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, createPrivateKey,
         generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify,
         timingSafeEqual, X509Certificate } from "node:crypto";
import { JsonStore, dataDir, dataFile, makeRateLimiter } from "./store.js";
import { endpointOperator, recoverOp, makeReplayCache, holdsLease } from "./fleet-auth.js";
import { isReservedHostname } from "./domains.js";

const env = (k) => (process.env[k] || "").trim();
const zone = (k) => env(k).toLowerCase().replace(/^\*?\./, "").replace(/^\.+|\.+$/g, "");

const CERTS_KEY   = env("CERTS_KEY");
const DNS_API     = env("DNS_API").replace(/\/+$/, "");
const DNS_TXT_KEY = env("DNS_TXT_KEY");
const APP_ZONE    = zone("APP_ZONE");
const TCP_ZONE    = zone("TCP_ZONE");
const _contactRaw = env("ACME_CONTACT");
const ACME_CONTACT = _contactRaw && (_contactRaw.includes(":") ? _contactRaw : `mailto:${_contactRaw}`);

// Timing knobs — production defaults mirror supervisor.js; tests shrink them.
const HTTP_MS        = parseInt(env("CERTS_HTTP_TIMEOUT_MS") || "20000", 10);
const CA_COOLDOWN_MS = parseInt(env("CERTS_CA_COOLDOWN_MS") || "120000", 10);   // 2 min, see supervisor.js
const DNS_SETTLE_MS  = parseInt(env("CERTS_DNS_SETTLE_MS") || "5000", 10);
const POLL_MS        = parseInt(env("CERTS_POLL_MS") || "2000", 10);
const POLL_TIMEOUT_MS = parseInt(env("CERTS_POLL_TIMEOUT_MS") || "90000", 10);
// How long one request waits for its order before answering 202 and leaving
// the order running; the enclave's retry finds the cache.
const SYNC_WAIT_MS   = parseInt(env("CERTS_SYNC_WAIT_MS") || "120000", 10);
const TS_SKEW_SEC    = 600;

export const issueSig = (keyHex, name, endpoint, ts) =>
  createHmac("sha256", Buffer.from(keyHex, "hex")).update(`${name}:${endpoint}:${ts}`).digest("hex");
export const issueMessage = (name, endpoint, ts) => `enclave-certs-issue:${name}:${endpoint}:${ts}`;

// ---------------------------------------------------------------------------
// Name authorization. The relay's canonical app label (api-relay depFromHost /
// supervisor appCertLabel): an on-chain id's first 8+ hex chars. depFromHost
// also still parses retired-era dep_<x> labels; those deployments no longer
// exist on any ledger (ids are bytes32), so here a non-hex label is simply
// not a deployment — "api", "www", "box" can never name one.
// ---------------------------------------------------------------------------
export const zonesOf = () => [APP_ZONE, TCP_ZONE].filter(Boolean);
export function labelToId(label) {
  const l = String(label || "").toLowerCase();
  const hex = l.startsWith("0x") ? l.slice(2) : l;
  return /^[0-9a-f]{8,64}$/.test(hex) ? "0x" + hex : null;
}
// name -> { zone, label, id } or a refusal string. Every path that is not
// exactly one canonical label directly under one of our zones is refused
// here, before any key or ledger work — this is the operator constraint.
export function authorizeName(name, zones = zonesOf()) {
  const n = String(name || "").toLowerCase().replace(/\.+$/, "");
  if (!n || n.length > 253 || !/^[a-z0-9.-]+$/.test(n)) return { error: "bad_name", message: "name must be a DNS hostname." };
  // Everything in our zones is "reserved" to domains.js (a tenant may not
  // attach it as a custom domain); a name it does NOT consider reserved is by
  // definition somebody else's, and this service never issues for those.
  if (!isReservedHostname(n)) return { error: "not_platform_zone", message: "This service issues only for the platform's own app zones." };
  const z = zones.find((zz) => n.endsWith("." + zz));
  if (!z) return { error: "not_platform_zone", message: `name must be <label>.${zones.join(" or <label>.")}.` };
  const label = n.slice(0, -(z.length + 1));
  if (!label || label.includes(".")) return { error: "bad_label", message: "name must be exactly one label under the zone." };
  const id = labelToId(label);
  if (!id) return { error: "bad_label", message: "The label is not a deployment label." };
  return { name: n, zone: z, label, id };
}
// The ledger row a label names: exact id, or the unique row whose bytes32 id
// starts with the hex prefix (depFromHost's rule). Ambiguity = no row.
function rowForLabel(rows, id) {
  const want = id.toLowerCase();
  const hits = rows.filter((d) => String(d.id).toLowerCase().startsWith(want));
  return hits.length === 1 ? hits[0] : null;
}

// ---------------------------------------------------------------------------
// Minimal DER reader + PKCS#10 validation. The supervisor WRITES a CSR with a
// DER writer of the same size; this is its mirror, reading just enough to
// prove the request is exactly {CN==name, SAN==[name]} on an acceptable key
// with a valid self-signature. Anything else is refused: an extra SAN, a
// second RDN, a challengePassword, a basicConstraints request, a key we would
// not want a CA to certify.
// ---------------------------------------------------------------------------
function tlv(buf, off) {
  if (off + 2 > buf.length) throw new Error("truncated DER");
  const tag = buf[off];
  let len = buf[off + 1], hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || off + 2 + n > buf.length) throw new Error("bad DER length");
    len = 0; for (let i = 0; i < n; i++) len = (len << 8) | buf[off + 2 + i];
    hdr = 2 + n;
  }
  const start = off + hdr, end = start + len;
  if (end > buf.length) throw new Error("truncated DER");
  return { tag, start, end, body: buf.subarray(start, end), raw: buf.subarray(off, end) };
}
function kids(buf, t) {
  const out = []; let off = t.start;
  while (off < t.end) { const c = tlv(buf, off); off = c.end; out.push(c); }
  return out;
}
function oidOf(body) {
  const first = body[0];
  const parts = [Math.floor(first / 40), first % 40];
  let v = 0;
  for (let i = 1; i < body.length; i++) {
    v = v * 128 + (body[i] & 0x7f);
    if (!(body[i] & 0x80)) { parts.push(v); v = 0; }
  }
  return parts.join(".");
}
const OID = {
  cn: "2.5.4.3", extReq: "1.2.840.113549.1.9.14", san: "2.5.29.17",
  ecdsaSha256: "1.2.840.10045.4.3.2", ecdsaSha384: "1.2.840.10045.4.3.3",
  rsaSha256: "1.2.840.113549.1.1.11", rsaSha384: "1.2.840.113549.1.1.12",
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

// PEM CSR -> { spkiDer, spkiHash, keyType, cn, sans } after every check, or
// throws with the reason (surfaced verbatim as 400 bad_csr).
export function parseCsr(pem, name) {
  const m = String(pem || "").match(/-----BEGIN (NEW )?CERTIFICATE REQUEST-----([\s\S]*?)-----END (NEW )?CERTIFICATE REQUEST-----/);
  expect(m, "csr must be a PEM CERTIFICATE REQUEST");
  const der = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  expect(der.length > 0 && der.length <= 8192, "csr is empty or oversized");
  const top = tlv(der, 0);
  expect(top.tag === 0x30 && top.end === der.length, "csr is not one DER SEQUENCE");
  const [cri, sigAlg, sigBits] = kids(der, top);
  expect(cri && sigAlg && sigBits && cri.tag === 0x30 && sigAlg.tag === 0x30 && sigBits.tag === 0x03, "csr is not a CertificationRequest");
  const criParts = kids(der, cri);
  expect(criParts.length === 4, "CertificationRequestInfo must be version, subject, key, attributes");
  const [ver, subject, spki, attrs] = criParts;
  expect(ver.tag === 0x02 && ver.body.length === 1 && ver.body[0] === 0, "csr version must be 0");

  // subject: exactly one RDN, exactly one AVA, CN == name
  expect(subject.tag === 0x30, "bad subject");
  const rdns = kids(der, subject);
  expect(rdns.length === 1 && rdns[0].tag === 0x31, "subject must be exactly CN=<name>");
  const avas = kids(der, rdns[0]);
  expect(avas.length === 1 && avas[0].tag === 0x30, "subject must be exactly CN=<name>");
  const [atype, aval] = kids(der, avas[0]);
  expect(atype && aval && atype.tag === 0x06 && oidOf(atype.body) === OID.cn, "subject must be exactly CN=<name>");
  expect([0x0c, 0x13, 0x16].includes(aval.tag), "CN must be a UTF8/Printable/IA5 string");
  const cn = aval.body.toString("utf8");
  expect(cn.toLowerCase() === name, `CN is "${cn}", not ${name}`);

  // key: let node parse the SubjectPublicKeyInfo and tell us what it is
  expect(spki.tag === 0x30, "bad SubjectPublicKeyInfo");
  let key; try { key = createPublicKey({ key: spki.raw, format: "der", type: "spki" }); }
  catch (e) { throw new Error("unreadable public key: " + e.message); }
  const det = key.asymmetricKeyDetails || {};
  let keyType;
  if (key.asymmetricKeyType === "ec") { expect(det.namedCurve === "prime256v1", "EC key must be P-256"); keyType = "ec-p256"; }
  else if (key.asymmetricKeyType === "rsa") { expect(det.modulusLength >= 2048, "RSA key must be at least 2048 bits"); keyType = `rsa-${det.modulusLength}`; }
  else throw new Error(`key type ${key.asymmetricKeyType} is not accepted (EC P-256 or RSA>=2048)`);

  // attributes: [0] holding exactly one extensionRequest, holding exactly one
  // extension, subjectAltName, holding exactly one dNSName == name
  expect(attrs.tag === 0xa0, "attributes must be [0]");
  const attrList = kids(der, attrs);
  expect(attrList.length === 1 && attrList[0].tag === 0x30, "csr must carry exactly one attribute: extensionRequest");
  const [aOid, aSet] = kids(der, attrList[0]);
  expect(aOid && aSet && aOid.tag === 0x06 && oidOf(aOid.body) === OID.extReq && aSet.tag === 0x31, "the only attribute must be extensionRequest");
  const extsList = kids(der, aSet);
  expect(extsList.length === 1 && extsList[0].tag === 0x30, "extensionRequest must hold one Extensions sequence");
  const exts = kids(der, extsList[0]);
  expect(exts.length === 1 && exts[0].tag === 0x30, "csr must request exactly one extension: subjectAltName");
  const extParts = kids(der, exts[0]);
  expect(extParts[0]?.tag === 0x06 && oidOf(extParts[0].body) === OID.san, "the only extension must be subjectAltName");
  const extVal = extParts[extParts.length - 1];
  expect(extVal.tag === 0x04 && extParts.length <= 3, "bad subjectAltName extension");
  if (extParts.length === 3) expect(extParts[1].tag === 0x01, "bad subjectAltName extension");
  const gn = tlv(extVal.body, 0);
  expect(gn.tag === 0x30 && gn.end === extVal.body.length, "bad GeneralNames");
  const names = kids(extVal.body, gn);
  expect(names.length === 1 && names[0].tag === 0x82, "subjectAltName must be exactly one dNSName");
  const san = names[0].body.toString("ascii");
  expect(san.toLowerCase() === name, `SAN is "${san}", not ${name}`);

  // self-signature: proves the requester holds the key (the CA checks too,
  // but a forged CSR must not spend an issuance or pollute the cache)
  const [algOid] = kids(der, sigAlg);
  const alg = algOid?.tag === 0x06 ? oidOf(algOid.body) : "";
  expect(sigBits.body[0] === 0, "bad signature BIT STRING");
  const sig = sigBits.body.subarray(1);
  let ok = false;
  try {
    if (alg === OID.ecdsaSha256 || alg === OID.ecdsaSha384) {
      expect(key.asymmetricKeyType === "ec", "ECDSA signature on a non-EC key");
      ok = cryptoVerify(alg === OID.ecdsaSha256 ? "sha256" : "sha384", cri.raw, { key, dsaEncoding: "der" }, sig);
    } else if (alg === OID.rsaSha256 || alg === OID.rsaSha384) {
      expect(key.asymmetricKeyType === "rsa", "RSA signature on a non-RSA key");
      ok = cryptoVerify(alg === OID.rsaSha256 ? "sha256" : "sha384", cri.raw, key, sig);
    } else throw new Error(`signature algorithm ${alg || "?"} is not accepted`);
  } catch (e) { throw new Error("csr signature: " + e.message); }
  expect(ok, "csr self-signature does not verify");

  return { der, spkiDer: Buffer.from(spki.raw), spkiHash: createHash("sha256").update(spki.raw).digest("hex"), keyType, cn, sans: [san] };
}

// ---------------------------------------------------------------------------
// ACME (RFC 8555) client — supervisor.js acmeIssue ported to the relay, with
// two differences: the CSR comes from the caller, and accounts persist.
// ---------------------------------------------------------------------------
const b64u     = (b) => Buffer.from(b).toString("base64url");
const b64uJson = (o) => b64u(JSON.stringify(o));
export const jwkThumbprint = (jwk) =>
  b64u(createHash("sha256").update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`).digest());
export const dns01TxtValue = (token, thumbprint) => b64u(createHash("sha256").update(`${token}.${thumbprint}`).digest());
function jwsSignEs256(protectedHeader, payload, privateKey) {
  const prot = b64uJson(protectedHeader);
  const body = payload === null ? "" : b64uJson(payload);
  const sig  = cryptoSign("sha256", Buffer.from(`${prot}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return { protected: prot, payload: body, signature: b64u(sig) };
}
function eabJws(kid, hmacB64u, accountJwk, newAccountUrl) {
  const prot    = b64uJson({ alg: "HS256", kid, url: newAccountUrl });
  const payload = b64uJson(accountJwk);
  const sig     = createHmac("sha256", Buffer.from(hmacB64u, "base64url")).update(`${prot}.${payload}`).digest();
  return { protected: prot, payload, signature: b64u(sig) };
}
const sleepMs = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const caErr = (msg) => Object.assign(new Error(msg), { caLevel: true });
const acmeFetch = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_MS) });

// Ordered CA slots. Slot 1 is ZeroSSL with the PLATFORM EAB pair (skipped
// without one: ZeroSSL refuses EAB-less accounts, and a slot that can never
// register is noise); slot 2 is Let's Encrypt, no EAB. The reply's `ca` field
// is the slot name.
const CAS = [];
function buildSlots() {
  CAS.length = 0;
  const kid = env("ACME_EAB_KID"), hmac = env("ACME_EAB_HMAC");
  if (!!kid !== !!hmac) console.warn("[certs] ACME_EAB_KID/ACME_EAB_HMAC: half an EAB pair — ZeroSSL slot skipped");
  else if (!kid) console.warn("[certs] no ACME_EAB_KID/ACME_EAB_HMAC — ZeroSSL slot skipped, Let's Encrypt only");
  else CAS.push({ name: "zerossl", directory: env("ACME_DIRECTORY") || "https://acme.zerossl.com/v2/DV90", eabKid: kid, eabHmac: hmac });
  const kid2 = env("ACME_EAB_KID_2"), hmac2 = env("ACME_EAB_HMAC_2");
  if (!!kid2 !== !!hmac2) console.warn("[certs] ACME_EAB_KID_2/ACME_EAB_HMAC_2: half a pair — ignored");
  CAS.push({ name: "letsencrypt", directory: env("ACME_DIRECTORY_2") || "https://acme-v02.api.letsencrypt.org/directory",
             eabKid: kid2 && hmac2 ? kid2 : "", eabHmac: kid2 && hmac2 ? hmac2 : "" });
  for (const ca of CAS) Object.assign(ca, { dir: null, account: null, nonce: null, downUntil: 0,
    // GLOBAL per-CA pacing. Let's Encrypt: 50 certs per registered domain per
    // week, shared by every label in the zone — hold a burst of 25 and refill
    // 40/week so a renewal wave never spends the whole allowance at once.
    // ZeroSSL has no published per-domain cap; 60/hour is politeness.
    pace: ca.name === "letsencrypt" ? makeRateLimiter({ capacity: 25, refillPerSec: 40 / 604800 })
                                    : makeRateLimiter({ capacity: 60, refillPerSec: 60 / 3600 }) });
}

async function acmeDir(ca) {
  if (!ca.dir) {
    let r; try { r = await acmeFetch(ca.directory); } catch (e) { throw caErr(`directory: ${e.message}`); }
    if (!r.ok) throw caErr(`directory fetch ${r.status}`);
    ca.dir = await r.json().catch(() => { throw caErr("directory is not JSON (an outage page?)"); });
  }
  return ca.dir;
}
async function takeNonce(ca) {
  if (ca.nonce) { const n = ca.nonce; ca.nonce = null; return n; }
  let r; try { r = await acmeFetch((await acmeDir(ca)).newNonce, { method: "HEAD" }); }
  catch (e) { throw e.caLevel ? e : caErr(`newNonce: ${e.message}`); }
  const n = r.headers.get("replay-nonce");
  if (!n) throw caErr("newNonce returned no replay-nonce");
  return n;
}
async function acmePost(ca, url, payload, { useJwk = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const nonce = await takeNonce(ca);
    const prot  = { alg: "ES256", nonce, url, ...(useJwk ? { jwk: ca.account.jwk } : { kid: ca.account.kid }) };
    let r; try {
      r = await acmeFetch(url, { method: "POST", headers: { "content-type": "application/jose+json" },
                                 body: JSON.stringify(jwsSignEs256(prot, payload, ca.account.key)) });
    } catch (e) { throw caErr(`POST ${url}: ${e.message}`); }
    ca.nonce = r.headers.get("replay-nonce") || ca.nonce;
    const isJson = /json/.test(r.headers.get("content-type") || "");
    const data = isJson ? await r.json().catch(() => null) : await r.text();
    if (r.status >= 400) {
      if (attempt === 0 && data && /badNonce/.test(data.type || "")) continue;
      const e = new Error(`ACME ${r.status} at ${url}: ${isJson ? `${data?.type || "?"} ${data?.detail || ""}`.trim() : String(data).slice(0, 200)}`);
      if (r.status >= 500 || !isJson) e.caLevel = true;
      throw e;
    }
    return { status: r.status, headers: r.headers, data };
  }
}

// Account persistence. One account per CA, registered ONCE and kept in the
// store: { accounts: { <directory>: blob } }, blob = AES-256-GCM over
// {kid, jwk, pkcs8} under a subkey of CERTS_KEY with the directory URL as AAD.
// (secrets.js's seal/open shape; a blob moved to another CA's slot fails to
// open.) Certificates are public and stored in the clear.
const sub = (label) => createHmac("sha256", Buffer.from(CERTS_KEY, "hex")).update(label).digest();
function seal(aad, obj) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sub("acme-account at-rest v1"), iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function open(aad, blob) {
  const raw = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", sub("acme-account at-rest v1"), raw.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
}
function loadAccount(ca) {
  const blob = store.data.accounts[ca.directory];
  if (!blob) return null;
  try {
    const { kid, jwk, pkcs8 } = open(ca.directory, blob);
    return { key: createPrivateKey({ key: pkcs8, format: "pem" }), jwk, thumbprint: jwkThumbprint(jwk), kid };
  } catch (e) {
    console.error(`[certs] stored account for ${ca.directory} does not open (${e.message}) — re-registering`);
    return null;
  }
}
async function acmeAccount(ca) {
  if (ca.account?.kid) return ca.account;
  ca.account = loadAccount(ca);
  if (ca.account) return ca.account;
  const dir = await acmeDir(ca);
  if (dir.meta?.externalAccountRequired && !ca.eabKid)
    throw caErr("CA requires External Account Binding but this slot has no EAB pair");
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = publicKey.export({ format: "jwk" });
  ca.account = { key: privateKey, jwk: { crv: j.crv, kty: j.kty, x: j.x, y: j.y }, thumbprint: jwkThumbprint(j), kid: null };
  try {
    const r = await acmePost(ca, dir.newAccount,
      { termsOfServiceAgreed: true,
        ...(ACME_CONTACT ? { contact: [ACME_CONTACT] } : {}),
        ...(ca.eabKid ? { externalAccountBinding: eabJws(ca.eabKid, ca.eabHmac, ca.account.jwk, dir.newAccount) } : {}) },
      { useJwk: true });
    ca.account.kid = r.headers.get("location");
    if (!ca.account.kid) throw new Error("newAccount returned no Location (account kid)");
    store.data.accounts[ca.directory] = seal(ca.directory,
      { kid: ca.account.kid, jwk: ca.account.jwk, pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }) });
    store.saveSoon();
    console.log(`[certs] ${ca.name}: account registered at ${ca.account.kid}`);
  } catch (e) { ca.account = null; e.caLevel = true; throw e; }
  return ca.account;
}

// dns-01 through the platform DNS daemon's authenticated API (the same call
// supervisor.js makes): body HMAC with the DERIVED DNS_TXT_KEY.
async function dnsTxt(method, name, value) {
  const body = JSON.stringify({ name, value, ttlSec: 300, ts: Math.floor(Date.now() / 1000) });
  const headers = { "content-type": "application/json",
                    "x-relay-sig": createHmac("sha256", DNS_TXT_KEY).update(body).digest("hex") };
  const r = await acmeFetch(`${DNS_API}/v1/txt`, { method, headers, body });
  if (!r.ok) throw new Error(`DNS_API ${method} ${name}: HTTP ${r.status}`);
}
async function acmePoll(ca, url, what, isOk, isBad) {
  const t0 = Date.now();
  for (let delay = POLL_MS; ; delay = Math.min(Math.round(delay * 1.5), 10_000)) {
    const { data } = await acmePost(ca, url, null);
    if (isOk(data)) return data;
    if (isBad(data)) {
      const errs = data.error || (data.challenges || []).map((c) => c.error).filter(Boolean);
      throw new Error(`${what} became ${data.status}: ${JSON.stringify(errs).slice(0, 300)}`);
    }
    if (Date.now() - t0 > POLL_TIMEOUT_MS) throw caErr(`${what} still ${data.status} after ${Math.round(POLL_TIMEOUT_MS / 1000)}s`);
    await sleepMs(delay);
  }
}
// order -> TXT -> challenge -> finalize with the CALLER's CSR -> download.
async function acmeIssueVia(ca, name, csrDer) {
  const acct = await acmeAccount(ca);
  const dir  = await acmeDir(ca);
  const order = await acmePost(ca, dir.newOrder, { identifiers: [{ type: "dns", value: name }] });
  const orderUrl = order.headers.get("location");
  const authzUrl = order.data.authorizations[0];
  const authz = await acmePost(ca, authzUrl, null);
  let txtName = null, txtValue = null;
  if (authz.data.status !== "valid") {
    const chal = (authz.data.challenges || []).find((c) => c.type === "dns-01");
    if (!chal) throw new Error(`no dns-01 challenge offered for ${name}`);
    txtName  = `_acme-challenge.${name}`;
    txtValue = dns01TxtValue(chal.token, acct.thumbprint);
    await dnsTxt("POST", txtName, txtValue);
  }
  try {
    if (txtName) {
      const chal = authz.data.challenges.find((c) => c.type === "dns-01");
      await sleepMs(DNS_SETTLE_MS);
      await acmePost(ca, chal.url, {});
      await acmePoll(ca, authzUrl, `authz for ${name}`, (a) => a.status === "valid",
                     (a) => ["invalid", "revoked", "deactivated", "expired"].includes(a.status));
    }
    await acmePost(ca, order.data.finalize, { csr: b64u(csrDer) });
    const done = await acmePoll(ca, orderUrl, `order for ${name}`, (o) => o.status === "valid" && o.certificate,
                                (o) => o.status === "invalid");
    const cert = await acmePost(ca, done.certificate, null);
    const certPem = String(cert.data);
    const leaf = new X509Certificate(certPem);
    return { certPem, notBefore: new Date(leaf.validFrom).toISOString(), notAfter: new Date(leaf.validTo).toISOString(), ca: ca.name };
  } finally {
    if (txtName) dnsTxt("DELETE", txtName, txtValue).catch((e) => console.warn(`[certs] TXT cleanup failed for ${txtName}: ${e.message}`));
  }
}
// Walk the slots in order (supervisor.js acmeIssue): CA-level failures cool a
// slot off and fall over; name-level refusals move on; a CA that timed out
// while a later one proved the network gets one immediate second chance.
// A paced-out slot is skipped like a cooling one. Throws { paced:true,
// retryAfterSec } when no slot may be tried right now.
async function acmeIssue(name, csrDer) {
  const now = Date.now();
  const usable = CAS.filter((ca) => !(ca.downUntil > now));
  let lastErr = null;
  const cooledNow = [];
  let networkProven = false, tried = 0;
  for (const ca of usable) {
    if (!ca.pace(ca.name)) { console.warn(`[certs] ${ca.name}: global pace reached — skipping for ${name}`); continue; }
    tried++;
    try {
      const issued = await acmeIssueVia(ca, name, csrDer);
      ca.downUntil = 0;
      return issued;
    } catch (e) {
      lastErr = e;
      if (e.caLevel) {
        ca.downUntil = Date.now() + CA_COOLDOWN_MS;
        cooledNow.push(ca);
        console.warn(`[certs] ${ca.name}: ${e.message} — cooling this CA off ${Math.round(CA_COOLDOWN_MS / 1000)}s`);
      } else networkProven = true;
    }
  }
  if (networkProven && cooledNow.length) {
    for (const ca of cooledNow) {
      try {
        const issued = await acmeIssueVia(ca, name, csrDer);
        ca.downUntil = 0;
        console.log(`[certs] ${ca.name}: second chance succeeded for ${name}`);
        return issued;
      } catch (e) {
        lastErr = e;
        if (e.caLevel) ca.downUntil = Date.now() + CA_COOLDOWN_MS;
      }
    }
  }
  if (!tried) {
    const soonest = Math.min(...CAS.map((ca) => ca.downUntil > Date.now() ? ca.downUntil : Date.now() + 60_000));
    throw Object.assign(new Error("every CA is cooling off or paced"), { paced: true, retryAfterSec: Math.max(15, Math.ceil((soonest - Date.now()) / 1000)) });
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Store, cache, pacing, route.
// ---------------------------------------------------------------------------
let store = null;        // JsonStore { accounts: { <dir>: blob }, certs: { "<name>|<spkiHash>": rec }, failures: { <name>: {at, n} } }
let enabled = false;
export const certsEnabled = () => enabled;
const inflight = new Map();          // cache key -> Promise<rec>
const sigFresh = makeReplayCache();
const rlIp = makeRateLimiter({ capacity: 120, refillPerSec: 10 });          // per source ip (fleet traffic)
// per-endpoint pacing: a box gets a burst of 20 issuances and 20 more per
// hour — a renewal wave on one big box fits, a runaway loop does not.
const rlEndpoint = makeRateLimiter({ capacity: 20, refillPerSec: 20 / 3600 });
const cacheKey = (name, spkiHash) => `${name}|${spkiHash}`;

export async function initCerts() {
  const dir = dataDir();
  const missing = [["CERTS_KEY", CERTS_KEY], ["DNS_API", DNS_API], ["DNS_TXT_KEY", DNS_TXT_KEY], ["APP_ZONE", APP_ZONE]]
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length || !dir) {
    console.log(`[certs] disabled (${missing.length ? missing.join(", ") + " unset" : "no writable AUTH_DATA_DIR"}) — /v1/certs/issue 503`);
    return;
  }
  if (!/^[0-9a-f]{64}$/i.test(CERTS_KEY)) { console.error("[certs] CERTS_KEY must be 64 hex chars (HMAC(SECRET, \"enclave certs v1\")) — disabled"); return; }
  if (!/^[0-9a-f]{64}$/i.test(DNS_TXT_KEY)) { console.error("[certs] DNS_TXT_KEY must be the 64-hex DERIVED key — disabled"); return; }
  buildSlots();
  store = new JsonStore(dataFile(dir, "certs.json"), { accounts: {}, certs: {}, failures: {} }, { durable: true });
  enabled = true;
  sweep();
  setInterval(sweep, 3600_000).unref?.();
  console.log(`[certs] enabled — zones ${zonesOf().join(", ")}; CAs ${CAS.map((c) => c.name).join(" -> ")}; `
    + `${Object.keys(store.data.certs).length} cached cert(s), ${Object.keys(store.data.accounts).length} account(s)`);
}
// expired certificates and stale failure marks leave the store
function sweep() {
  let dirty = false;
  const now = Date.now();
  for (const [k, r] of Object.entries(store.data.certs))
    if (new Date(r.notAfter).getTime() < now) { delete store.data.certs[k]; dirty = true; }
  for (const [n, f] of Object.entries(store.data.failures))
    if (now - f.at > 86400_000) { delete store.data.failures[n]; dirty = true; }
  if (dirty) store.saveSoon();
}
// a cached cert is served until 2/3 of its lifetime; past that the next ask
// issues afresh (and the old record is replaced)
const cacheFresh = (r) => {
  const nb = new Date(r.notBefore).getTime(), na = new Date(r.notAfter).getTime();
  return Date.now() < nb + (na - nb) * 2 / 3;
};
// per-name failure backoff: 1 min doubling to 1 h, so a name a CA keeps
// refusing does not spend a request per retry
const backoffSec = (n) => Math.min(3600, 60 * 2 ** Math.max(0, n - 1));

const bad = (ctx, res, req, code, error, message) => ctx.json(res, code, { error, message }, req);
const view = (r, cached) => ({ name: r.name, certPem: r.certPem, notBefore: r.notBefore, notAfter: r.notAfter, ca: r.ca, cached });

export async function handleCerts(req, res, u, ctx) {
  if (!enabled)
    return bad(ctx, res, req, 503, "certs_disabled", "Platform certificate issuance is not configured on this relay.");
  if (u.pathname !== "/v1/certs/issue")
    return bad(ctx, res, req, 404, "not_found", "POST /v1/certs/issue.");
  if (req.method !== "POST")
    return bad(ctx, res, req, 405, "method_not_allowed", "POST only.");
  if (!rlIp(ctx.clientIp(req)))
    return bad(ctx, res, req, 429, "rate_limited", "Too many certificate requests; retry shortly.");
  let raw; try { raw = await ctx.readBody(req, 32768); } catch (e) { return bad(ctx, res, req, 413, "too_large", e.message); }
  let b; try { b = JSON.parse(raw.toString() || "{}"); } catch { return bad(ctx, res, req, 400, "bad_json", "Body must be JSON."); }

  // 1. shape
  const endpoint = String(b.endpoint || "").replace(/\/+$/, "");
  const ts = parseInt(b.ts, 10);
  const sig = String(b.sig || "");
  if (!/^https?:\/\//.test(endpoint)) return bad(ctx, res, req, 422, "bad_endpoint", "endpoint must be the enclave's registered origin.");
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TS_SKEW_SEC)
    return bad(ctx, res, req, 422, "bad_ts", `ts must be a unix time within ±${TS_SKEW_SEC}s.`);
  if (typeof b.csr !== "string") return bad(ctx, res, req, 422, "bad_csr", "csr must be a PEM string.");

  // 2. the name: our zones only, one canonical label (fail closed before any
  //    signature or ledger work — a refused name never costs a CA call)
  const auth = authorizeName(b.name);
  if (auth.error) return bad(ctx, res, req, 403, auth.error, auth.message);
  const { name, id } = auth;

  // 3. the fleet key over the canonical tuple, WHEN PRESENT. It is optional:
  //    a permissionless seller's box (a metal box registered with only its
  //    operator key, no fleet SECRET) cannot derive CERTS_KEY, and the
  //    authorization below rests on the operator signature + the on-chain
  //    lease anyway — the same rule the DNS relay applies to TXT pushes. A
  //    sig that IS sent must verify; a wrong one is refused, never ignored.
  if (sig) {
    const want = Buffer.from(issueSig(CERTS_KEY, name, endpoint, ts), "hex");
    const got = /^[0-9a-f]{64}$/i.test(sig) ? Buffer.from(sig, "hex") : Buffer.alloc(32);
    if (!timingSafeEqual(want, got)) return bad(ctx, res, req, 401, "bad_sig", "The request HMAC does not verify.");
  }
  // single-use: the signature that carries the request (opSig when there is no
  // fleet factor) is spent once — a captured request cannot be replayed
  const replayToken = sig || String(b.opSig || "");
  if (!replayToken) return bad(ctx, res, req, 403, "no_operator_sig", "opSig must be a personal_sign by this endpoint's registered operator.");
  if (!sigFresh(replayToken, ts + TS_SKEW_SEC)) return bad(ctx, res, req, 409, "sig_replayed", "This signature was already used; sign a fresh request.");

  // 4. the endpoint's OWN key (secrets.js rule): the registered operator must
  //    have signed the same tuple. No registry entry = nobody to authorize it.
  const owner = await endpointOperator(ctx, endpoint);
  if (!owner) return bad(ctx, res, req, 403, "unregistered_endpoint", `${endpoint} has no active EnclaveRegistry entry.`);
  const signer = await recoverOp(issueMessage(name, endpoint, ts), b.opSig);
  if (!signer || signer !== owner) {
    console.error(`[certs] ${endpoint} REFUSED for ${name}: opSig ${signer ? `by ${signer}` : "missing/invalid"}, endpoint registered to ${owner}`);
    return bad(ctx, res, req, 403, signer ? "wrong_operator" : "no_operator_sig",
      signer ? `The request is signed by ${signer}, but ${endpoint} is registered to ${owner}.`
             : "opSig must be a personal_sign by this endpoint's registered operator.");
  }

  // 5. the lease: the chain says who runs the deployment the label names
  const epId = String(await ctx.endpointIdOf(endpoint)).toLowerCase();
  const lookup = async (fresh) => {
    if (fresh) ctx.ledgerExpire();
    let rows; try { rows = await ctx.ledgerRows(); } catch { return null; }
    return rowForLabel(rows, id);
  };
  let d = await lookup(false);
  if (!holdsLease(d, epId)) d = await lookup(true);
  if (!d) return bad(ctx, res, req, 403, "not_found", `No deployment on the ledger for label ${auth.label}.`);
  if (!holdsLease(d, epId)) {
    console.error(`[certs] ${endpoint} REFUSED for ${name}: not the live lease holder (runner ${d.runner}, leaseUntil ${d.leaseUntil})`);
    return bad(ctx, res, req, 403, "not_lease_holder", "This endpoint does not hold the deployment's live lease.");
  }

  // 6. the CSR: exactly this name, an acceptable key, a valid self-signature
  let csr; try { csr = parseCsr(b.csr, name); }
  catch (e) { return bad(ctx, res, req, 400, "bad_csr", e.message); }

  // 7. cache
  const key = cacheKey(name, csr.spkiHash);
  const hit = store.data.certs[key];
  if (hit && cacheFresh(hit)) return ctx.json(res, 200, view(hit, true), req);

  // 8. pacing + in-flight + backoff -> 202
  const retry = (sec, why) => { console.log(`[certs] ${endpoint} ${name}: 202 (${why}, retry in ${sec}s)`); return ctx.json(res, 202, { name, retryAfterSec: sec }, req); };
  if (inflight.has(key)) {
    // a duplicate ask joins the running order for the sync window, then 202s
    const rec = await Promise.race([inflight.get(key).catch(() => null), sleepMs(SYNC_WAIT_MS).then(() => undefined)]);
    return rec ? ctx.json(res, 200, view(rec, true), req) : retry(30, "order in flight");
  }
  const f = store.data.failures[name];
  if (f && Date.now() - f.at < backoffSec(f.n) * 1000)
    return retry(Math.ceil((f.at + backoffSec(f.n) * 1000 - Date.now()) / 1000), `backoff after ${f.n} failure(s)`);
  if (!rlEndpoint(endpoint)) return retry(300, "endpoint paced");

  // 9. issue. The order keeps running past the sync window; the enclave's
  //    retry finds it in flight (202) or done (cached:true).
  const p = (async () => {
    const issued = await acmeIssue(name, csr.der);
    const rec = { name, spkiHash: csr.spkiHash, keyType: csr.keyType, endpoint, issuedAt: new Date().toISOString(), ...issued };
    for (const [k, r] of Object.entries(store.data.certs)) if (r.name === name && k !== key) delete store.data.certs[k];
    store.data.certs[key] = rec;
    delete store.data.failures[name];
    store.saveSoon();
    console.log(`[certs] ${endpoint} issued ${name} via ${rec.ca} (${csr.keyType}), valid to ${rec.notAfter}`);
    return rec;
  })();
  inflight.set(key, p);
  p.catch(() => {}).finally(() => inflight.delete(key));
  let rec, err;
  try { rec = await Promise.race([p, sleepMs(SYNC_WAIT_MS).then(() => undefined)]); }
  catch (e) { err = e; }
  if (rec) return ctx.json(res, 200, view(rec, false), req);
  if (rec === undefined && !err) return retry(30, "order still running");
  if (err.paced) return retry(err.retryAfterSec, "CAs cooling/paced");
  const n = (store.data.failures[name]?.n || 0) + 1;
  store.data.failures[name] = { at: Date.now(), n, error: String(err.message).slice(0, 300) };
  store.saveSoon();
  console.error(`[certs] ${endpoint} ${name}: issuance failed (${n}): ${err.message}`);
  return bad(ctx, res, req, 502, "issue_failed", `No CA issued ${name}: ${err.message}`);
}

// TESTS only
export const _internals = { parseCsr, authorizeName, rowForLabel, seal, open, CAS, store: () => store };
