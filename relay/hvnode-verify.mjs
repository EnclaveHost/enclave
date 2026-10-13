// relay/hvnode-verify.mjs — the NucBox node's ATTACH evidence, tunnel format "windows-hv-node/v1" (enclave-5d's proposal
// of 2026-09-25, reviewed by the verifier lane; the contract is docs/security/nucbox-custom-vm-verifier.md). Steven's
// direction: the custom type-1 partition is the ONLY NucBox target, the ee-engine VBS-enclave backend is retired, test
// signing stays off, host_excluded=no until evidence supports admission.
//
// What this proves, and all it proves: the node's tunnel transport key is held by a process on a machine whose genuine
// on-die TPM measured an ACCEPTED boot state, in this boot, for this relay's nonce. The node IS the host: nothing here
// excludes the host, and there is no TEE claim. Every result says so (technology "windows-tpm-host", tier "hv-node",
// hostExcluded false, measurement null). The node's own /health summary rides along as `statement` and is kept as
// `hostStatement`, bound to this exchange and never read for a decision.
//
//   EK cert  --chains to-->  pinned AMD/Intel root                     (1) genuine on-die TPM
//   credential round trip (minted by the relay for EK + AK name)       (2, 3) the quoting key lives in THAT TPM
//   quote(sha256(bound), SHA-256 PCRs {0,7,12,13,14}) by that key      (4) the log is what the TPM measured
//   log --replays to--> quoted PCRs 7/12/13/14; records recomputed     (5) Secure Boot on, TESTSIGNING 0, VBS/HVCI, no debug
//   VSM_IDKS_INFO on PCR 12                                            (6) recorded: the key a same-boot VM report must verify under
//   Ed25519(transportKey) over bound                                    (8) possession of the key the quote names
//   bound = "enclave-hv-node-bind-v1\n" || spki(44) || nonce(32) || sha256(statementBytes)(32)
//
// The policy is PRODUCTION ONLY: there is no dev tier and no relaxation (METAL_VBS_ALLOW_TESTSIGNING and any
// allowTestSigning are ignored); a failed check refuses. PCR 0 is quoted and its value recorded, but there is no
// independent pin for this platform's firmware (a value read from the box is not a pin; enclave-d1), so every result
// carries the omission "platform-firmware-unpinned" rather than a pass.
//
// Capture mode ({ capture: { quoteExtraData } }) re-verifies a RECORDED session whose quote carried a raw nonce (the
// boot-68 tpmattest session, before this transcript existed): the TPM and boot checks run, possession is not exercised,
// and the result is never admissible.
import { createHash, createPublicKey, verify as cryptoVerify, timingSafeEqual, X509Certificate, constants } from "node:crypto";
import { parseTpmtPublic, tpmNameOf, rsaKeyFromModulus, parseTpmsAttest, verifyEkChain, loadTpmRoots, tpmManufacturerOf,
         AIK_REQUIRED_ATTRIBUTES, TPMA_DECRYPT, TPM_ALG_SHA256, TPM_ALG_RSASSA, TPM_MANUFACTURERS_ON_DIE, VBS_REQUIRED_PCR12, VBS_QUOTE_PCRS,
         VBS_REPLAYED_PCRS, VBS_MAX_LOG_BYTES, VBS_MAX_CERT_BYTES, VBS_MAX_CHAIN_CERTS, VBS_MAX_ATTEST_BYTES, VBS_MAX_SIG_BYTES,
         VBS_MAX_TPMT_PUBLIC_BYTES, VBS_FORMAT } from "./vbs-verify.mjs";
import { parseTcgLog, replayPcrs, unhashedEvents, countRecomputable, sipaFields, vsmKey, secureBootFromLog, bootCounterFromLog } from "./vbs-tcglog.mjs";

export const HVNODE_FORMAT = "windows-hv-node/v1";
export const HVNODE_BIND_DOMAIN = "enclave-hv-node-bind-v1\n";
export const HVNODE_TECHNOLOGY = "windows-tpm-host";
export const HVNODE_TIER = "hv-node";
export const HVNODE_MAX_STATEMENT_BYTES = 16 * 1024;
export const HVNODE_OMISSIONS = Object.freeze(["platform-firmware-unpinned"]);
// what an admissible result admits, and nothing more (enclave-d1, 2026-09-25: never app capacity, never an isolation badge)
export const HVNODE_SCOPE = "host attach only: a host-attested boot state; never tenant capacity, never an isolation or TEE label";
// formats the relay must refuse outright for this node class, with the reason it states
export const RETIRED_FORMATS = Object.freeze({
  [VBS_FORMAT]: "the Windows VBS-enclave backend (ee-engine) is retired (Steven, 2026-09-25): the custom type-1 partition is the only NucBox target, and a VBS-enclave report never stands in for a custom-VM report",
});
export const retiredFormat = (format) => (Object.prototype.hasOwnProperty.call(RETIRED_FORMATS, format) ? RETIRED_FORMATS[format] : null);

const sha256 = (...parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest(); };
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const hexOf = (b) => Buffer.from(b).toString("hex");
const eq = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b);
const b64cap = (cap) => 4 * Math.ceil(cap / 3) + 4;
const buf = (v, cap) => { if (typeof v !== "string" || !v.length || v.length > b64cap(cap)) return null; const b = Buffer.from(v, "base64"); return b.length && b.length <= cap ? b : null; };

// bound = domain || spki(44, Ed25519) || nonce(32) || sha256(statement)(32): every part fixed width
export function hvNodeBinding(spki, nonce, statementBytes) {
  if (!Buffer.isBuffer(spki) || spki.length !== 44 || !spki.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) throw new Error("hv-node transportKey must be an Ed25519 SPKI (44 bytes)");
  if (!Buffer.isBuffer(nonce) || nonce.length !== 32) throw new Error("hv-node nonce must be 32 bytes");
  if (!Buffer.isBuffer(statementBytes) || !statementBytes.length || statementBytes.length > HVNODE_MAX_STATEMENT_BYTES) throw new Error(`hv-node statement must be 1..${HVNODE_MAX_STATEMENT_BYTES} bytes`);
  return Buffer.concat([Buffer.from(HVNODE_BIND_DOMAIN), spki, nonce, sha256(statementBytes)]);
}

// policy: { ekRoots: PEM bundle, ekRootPins?: [sha256], now? }. Nothing else is read: no allow-lists that could relax.
function normalizePolicy(policy = {}) {
  const trust = policy.ekRoots ? loadTpmRoots(policy.ekRoots) : { roots: [], intermediates: [], pins: [] };
  if (Array.isArray(policy.ekRootPins) && policy.ekRootPins.length) { const pins = new Set(policy.ekRootPins.map((p) => String(p).toLowerCase())); trust.pins = trust.pins.filter((p) => pins.has(p)); }
  return { trust, now: policy.now || Date.now() };
}

export function verifyHvNodeEvidence({ evidence, nonce, transportKeySpki = null, expectedCredential = null, mintedFor = null, capture = null } = {}, policy = {}) {
  const checks = [], warnings = [];
  const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
  const skip = (name, why) => { checks.push({ name, ok: false, detail: `not checked: ${why}`, skipped: true }); return false; };
  const pol = normalizePolicy(policy);
  const ev = evidence && typeof evidence === "object" ? evidence : {};
  const statementBytes = buf(ev.statement, HVNODE_MAX_STATEMENT_BYTES);

  // ---- 8. the transcript, computed first: the challenge the quote must carry
  let bound = null, challenge = null;
  if (capture) {
    challenge = Buffer.isBuffer(capture.quoteExtraData) ? capture.quoteExtraData : null;
    check("8 binding: capture mode (a recorded session's raw nonce; possession not exercised; never admissible)", !!challenge);
  } else {
    try { bound = hvNodeBinding(transportKeySpki, nonce, statementBytes); challenge = sha256(bound); check("8 binding: Ed25519 transportKey, 32-byte nonce, a bounded statement", true); }
    catch (e) { check("8 binding: Ed25519 transportKey, 32-byte nonce, a bounded statement", false, e.message); }
  }

  // ---- 1. EK certificate: pinned root, on-die manufacturer, the one the credential was minted for
  let ekDer = null, ekLeaf = null;
  {
    ekDer = buf(ev.ek && ev.ek.cert, VBS_MAX_CERT_BYTES);
    const chainRaw = ev.ek && Array.isArray(ev.ek.chain) ? ev.ek.chain : [];
    let extra = [];
    try {
      if (!ekDer) throw new Error("ek.cert missing or oversized");
      if (chainRaw.length > VBS_MAX_CHAIN_CERTS) throw new Error("ek.chain exceeds certificate-count limit");
      ekLeaf = new X509Certificate(ekDer);
      extra = chainRaw.map((c) => { const d = buf(c, VBS_MAX_CERT_BYTES); if (!d) throw new Error("ek.chain entry missing or oversized"); return new X509Certificate(d); });
      check("1 ek: certificate and chain parse", true, `${extra.length} intermediate(s) supplied`);
    } catch (e) { ekLeaf = null; check("1 ek: certificate and chain parse", false, e.message); }
    if (ekLeaf) {
      if (!pol.trust.pins.length) check("1 ek: chains to a pinned TPM root", false, "no pinned TPM roots in policy: refusing (fail closed)");
      else { const r = verifyEkChain(ekLeaf, extra, pol.trust, pol.now); check("1 ek: chains to a pinned TPM root", r.ok, r.ok ? "" : r.reason); }
      let mfr = null; try { mfr = tpmManufacturerOf(ekDer); } catch (e) { warnings.push(`ek SAN: ${e.message}`); }
      check("1 ek: on-die firmware TPM (SAN tpmManufacturer AMD/Intel)", !!mfr && !!TPM_MANUFACTURERS_ON_DIE[mfr], mfr ? `id:${mfr}` : "no tcg-at-tpmManufacturer in the SAN");
      check("1 ek: the certificate the credential was minted for", !!(mintedFor && Buffer.isBuffer(mintedFor.ekCert)) && eq(mintedFor.ekCert, ekDer), mintedFor && mintedFor.ekCert ? "" : "no mint record: refusing (fail closed)");
    } else for (const n of ["1 ek: chains to a pinned TPM root", "1 ek: on-die firmware TPM (SAN tpmManufacturer AMD/Intel)", "1 ek: the certificate the credential was minted for"]) skip(n, "certificate did not parse");
  }

  // ---- 2. the quoting key
  let aikKey = null, aikName = null;
  {
    const raw = buf(ev.quote && ev.quote.aikPub, VBS_MAX_TPMT_PUBLIC_BYTES);
    let aik = null;
    try {
      if (!raw) throw new Error("quote.aikPub missing or oversized");
      aik = parseTpmtPublic(raw);
      if (aik.nameAlg !== TPM_ALG_SHA256) throw new Error("quoting key nameAlg is not SHA-256");
      if (aik.scheme.alg !== TPM_ALG_RSASSA || aik.scheme.hash !== TPM_ALG_SHA256) throw new Error("quoting key scheme is not RSASSA/SHA-256");
      aikKey = rsaKeyFromModulus(aik.modulus, aik.exponent); aikName = tpmNameOf(raw);
      check("2 aik: TPMT_PUBLIC parses (RSA, SHA-256 name, RSASSA-SHA256)", true, `RSA-${aik.keyBits}`);
    } catch (e) { aik = null; check("2 aik: TPMT_PUBLIC parses (RSA, SHA-256 name, RSASSA-SHA256)", false, e.message); }
    if (aik) {
      check("2 aik: attributes fixedTPM|fixedParent|sensitiveDataOrigin|restricted|sign, not decrypt", (aik.attributes & AIK_REQUIRED_ATTRIBUTES) === AIK_REQUIRED_ATTRIBUTES && !(aik.attributes & TPMA_DECRYPT), `attrs=0x${aik.attributes.toString(16).padStart(8, "0")}`);
      check("2 aik: name is the one the credential was minted for", !!(mintedFor && Buffer.isBuffer(mintedFor.aikName)) && eq(mintedFor.aikName, aikName), mintedFor && mintedFor.aikName ? `name ${hexOf(aikName).slice(0, 20)}...` : "no mint record: refusing (fail closed)");
    } else for (const n of ["2 aik: attributes fixedTPM|fixedParent|sensitiveDataOrigin|restricted|sign, not decrypt", "2 aik: name is the one the credential was minted for"]) skip(n, "TPMT_PUBLIC did not parse");
  }

  // ---- 3. the credential round trip
  {
    const got = buf(ev.credential, 64);
    check("3 credential: activated credential == the one minted for (EK, AK name)", Buffer.isBuffer(expectedCredential) && expectedCredential.length === 32 && got && eq(got, expectedCredential),
          !Buffer.isBuffer(expectedCredential) ? "no credential was minted for this attach" : !got ? "evidence.credential missing" : "");
  }

  // ---- 5. the log
  let events = null, pcrs = null, f12 = null;
  {
    const logRaw = buf(ev.log, VBS_MAX_LOG_BYTES);
    try {
      if (!logRaw) throw new Error("log missing or oversized");
      const parsed = parseTcgLog(logRaw, { maxBytes: VBS_MAX_LOG_BYTES });
      if (!parsed.algs.has(TPM_ALG_SHA256)) throw new Error("log carries no SHA-256 bank");
      events = parsed.events; pcrs = replayPcrs(events);
      check("5 log: parses (TCG 2.0 crypto-agile, SHA-256 bank)", true, `${events.length} events`);
    } catch (e) { events = null; check("5 log: parses (TCG 2.0 crypto-agile, SHA-256 bank)", false, e.message); }
    if (events) {
      const bad = unhashedEvents(events);
      check("5 log: every SIPA record and PCR 7 variable event hashes to its recorded digest", !bad.length, bad.length ? `edited events at ${JSON.stringify(bad.slice(0, 4))}` : `${countRecomputable(events)} records recomputed`);
      try { f12 = sipaFields(events, 12); } catch (e) { f12 = null; check("5 log: PCR 12 SIPA records decode", false, e.message); }
    } else skip("5 log: every SIPA record and PCR 7 variable event hashes to its recorded digest", "log did not parse");
  }

  // ---- 4. the quote
  let quote = null, pcr0Hex = null;
  {
    const attestRaw = buf(ev.quote && ev.quote.attest, VBS_MAX_ATTEST_BYTES), sigRaw = buf(ev.quote && ev.quote.sig, VBS_MAX_SIG_BYTES);
    try { if (!attestRaw) throw new Error("quote.attest missing or oversized"); quote = parseTpmsAttest(attestRaw); check("4 quote: TPMS_ATTEST parses (TPM_GENERATED, TPM_ST_ATTEST_QUOTE)", true); }
    catch (e) { quote = null; check("4 quote: TPMS_ATTEST parses (TPM_GENERATED, TPM_ST_ATTEST_QUOTE)", false, e.message); }
    if (quote && aikKey) {
      let ok = false; try { ok = !!sigRaw && cryptoVerify("sha256", quote.raw, { key: aikKey, padding: constants.RSA_PKCS1_PADDING }, sigRaw); } catch { ok = false; }
      check("4 quote: signature verifies with the quoting key (RSASSA-PKCS1v15-SHA256)", ok, sigRaw ? "" : "quote.sig missing or oversized");
    } else skip("4 quote: signature verifies with the quoting key (RSASSA-PKCS1v15-SHA256)", quote ? "quoting key did not parse" : "quote did not parse");
    if (quote) {
      check("4 quote: extraData == challenge", !!challenge && eq(quote.extraData, challenge), challenge ? "" : "no challenge (the transcript failed)");
      const sel = quote.pcrSelect.length === 1 && quote.pcrSelect[0].hash === TPM_ALG_SHA256 ? quote.pcrSelect[0].pcrs : null;
      const exact = !!sel && sel.length === VBS_QUOTE_PCRS.length && VBS_QUOTE_PCRS.every((p) => sel.includes(p));
      check("4 quote: PCR selection is exactly the SHA-256 bank over {0,7,12,13,14}", exact, `selected ${sel ? `{${sel.join(",")}}` : "(not a single SHA-256 selection)"}`);
      pcr0Hex = typeof ev.pcr0 === "string" && /^[0-9a-fA-F]{64}$/.test(ev.pcr0) ? ev.pcr0.toLowerCase() : null;
      if (pcrs && exact) {
        const parts = sel.map((p) => (p === 0 ? (pcr0Hex ? Buffer.from(pcr0Hex, "hex") : null) : pcrs.get(p) || null));
        check("4 quote: PCR digest == sha256(PCR0 || replayed PCR7 || PCR12 || PCR13 || PCR14)", parts.every(Boolean) && eq(sha256(...parts), quote.pcrDigest),
              parts.every(Boolean) ? "" : `missing PCR value for ${sel.filter((p, i) => !parts[i]).join(",")}`);
      } else skip("4 quote: PCR digest == sha256(PCR0 || replayed PCR7 || PCR12 || PCR13 || PCR14)", pcrs ? "selection unusable" : "log did not replay");
    } else for (const n of ["4 quote: extraData == challenge", "4 quote: PCR selection is exactly the SHA-256 bank over {0,7,12,13,14}", "4 quote: PCR digest == sha256(PCR0 || replayed PCR7 || PCR12 || PCR13 || PCR14)"]) skip(n, "quote did not parse");
  }

  // ---- 5. the boot state, PRODUCTION ONLY
  let secureBoot = null, testSigning = null;
  if (f12) {
    for (const [k, want] of Object.entries(VBS_REQUIRED_PCR12)) { const vals = f12.get(k) || []; check(`5 log: ${k} == ${want}`, vals.length && vals.every((v) => v === want), `log: [${vals.join(", ")}]`); }
    testSigning = f12.get("TESTSIGNING") || [];
    check("5 log: TESTSIGNING == 0 in every section (production signing; no dev tier)", testSigning.length && testSigning.every((v) => v === 0), `log: [${testSigning.join(", ")}]`);
    secureBoot = secureBootFromLog(events);
    check("5 log: Secure Boot on (PCR 7 SecureBoot variable; no dev tier)", secureBoot === 1, `log: ${secureBoot}`);
  } else {
    for (const [k, want] of Object.entries(VBS_REQUIRED_PCR12)) skip(`5 log: ${k} == ${want}`, "log unusable");
    skip("5 log: TESTSIGNING == 0 in every section (production signing; no dev tier)", "log unusable"); skip("5 log: Secure Boot on (PCR 7 SecureBoot variable; no dev tier)", "log unusable");
  }

  // ---- 6. the IDKS of this boot, recorded for a same-boot VM report (never used here to verify anything)
  let idksModulusSha256 = null;
  if (events) {
    try { const k = vsmKey(events, "IDKS"); if (!k) throw new Error("no VSM_IDKS_INFO record on PCR 12 (in a recomputed event)"); idksModulusSha256 = hexOf(sha256(k.modulus)); check("6 idks: VSM_IDKS_INFO RSA key on PCR 12 (recomputed), recorded", true, `RSA-${k.bits} modulus sha256=${idksModulusSha256.slice(0, 16)}...`); }
    catch (e) { check("6 idks: VSM_IDKS_INFO RSA key on PCR 12 (recomputed), recorded", false, e.message); }
  } else skip("6 idks: VSM_IDKS_INFO RSA key on PCR 12 (recomputed), recorded", "log unusable");

  // ---- 8. possession: the transport key signed OUR transcript
  if (!capture) {
    const sig = buf(ev.signature, 128);
    let ok = false;
    if (bound && sig && sig.length === 64) { try { ok = cryptoVerify(null, bound, createPublicKey({ key: transportKeySpki, format: "der", type: "spki" }), sig); } catch { ok = false; } }
    check("8 possession: Ed25519 signature over bound verifies with transportKey", ok, !bound ? "no transcript" : !sig ? "evidence.signature missing" : sig.length !== 64 ? `signature is ${sig.length} bytes` : "");
  }

  // ---- 9. freshness (warn only), as vbs-verify: the log's boot counter vs the quote's clock info
  let bootCounter = null;
  if (events) { try { bootCounter = bootCounterFromLog(events); } catch { bootCounter = null; } }
  if (bootCounter != null && quote && typeof bootCounter === "number" && bootCounter !== quote.clockInfo.resetCount) warnings.push(`log BOOTCOUNTER ${bootCounter} != quote resetCount ${quote.clockInfo.resetCount} (AMD fTPM clockInfo is known to decode oddly; warn only)`);

  // ---- the host's statement: bound (when not capture) and recorded, never read for a decision
  let hostStatement = null;
  if (statementBytes) { let json = null; try { json = JSON.parse(statementBytes.toString("utf8")); } catch { json = null; } hostStatement = { sha256: hexOf(sha256(statementBytes)), json, note: "the node's own statement: recorded, never read for admission" }; }

  const failed = checks.filter((c) => !c.ok);
  const reasons = failed.map((c) => (c.detail ? `${c.name}: ${c.detail}` : c.name));
  const ok = !reasons.length;
  return { ok, admissible: ok && !capture, scope: HVNODE_SCOPE, capture: !!capture, format: HVNODE_FORMAT, tier: ok ? HVNODE_TIER : null, technology: HVNODE_TECHNOLOGY, hostExcluded: false, teeCpu: null, measurement: null,
           omissions: [...HVNODE_OMISSIONS], reasons, checks, warnings,
           boot: ok ? { bootCounter: typeof bootCounter === "number" ? bootCounter : null, resetCount: quote ? quote.clockInfo.resetCount : null, idksModulusSha256, secureBoot, testSigning,
                        pcr0: pcr0Hex, pcrs: pcrs ? Object.fromEntries(VBS_REPLAYED_PCRS.map((p) => [p, pcrs.get(p) ? hexOf(pcrs.get(p)) : null])) : null,
                        ekCertSha256: ekDer ? hexOf(sha256(ekDer)) : null, akName: aikName ? hexOf(aikName) : null } : null,
           hostStatement };
}
