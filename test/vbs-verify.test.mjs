// relay/vbs-verify.mjs against (a) boot 64 of the VBS test box — the real log,
// quote, EK chain and enclave report from windows/vbs/evidence, verified in
// CAPTURE mode because the spike tools used raw nonces before the binding
// transcript existed — and (b) a synthetic node with generated keys, which
// exercises the transcript, the credential round trip and the transport
// binding the fixture cannot. Every tamper the Python verifier's negative
// tests covered (REPORT.md section 3) fails here with a named reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { verifyVbsEvidence, vbsBinding, parseTpmtPublic, tpmNameOf, parseTpmsAttest, parseEnclaveReport, loadTpmRoots, tpmManufacturerOf,
         enclaveMeasurementKey, AMD_FTPM_ROOT_SHA256, VBS_FORMAT } from "../relay/vbs-verify.mjs";
import { vbsPolicyFromEnv, VBS_DEFAULT_EK_ROOTS } from "../relay/vbs-policy.mjs";
import { parseTcgLog, replayPcrs, unhashedEvents, sipaFields, vsmKey, secureBootFromLog } from "../relay/vbs-tcglog.mjs";
import { makeCredential, activateCredential } from "../relay/vbs-credential.mjs";
import { haveOpenssl, tmpdir, makeVbsWorld, evidenceFor, policyFor, issueEk, tpmtPublicOf, nameOf } from "./fixtures/vbs-synthetic.mjs";

const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/vbs/boot64-evidence.json", import.meta.url), "utf8"));
const ROOTS = fs.readFileSync(VBS_DEFAULT_EK_ROOTS, "utf8");
const CAPTURE = { reportData: Buffer.from(FIX.capture.reportData, "hex"), quoteExtraData: Buffer.from(FIX.capture.quoteExtraData, "hex") };
const fixPolicy = (extra = {}) => ({ measurements: [FIX.expect.measurementKey], minSvn: 1, pcr0: [FIX.expect.pcr0], ekRoots: ROOTS, allowTestSigning: true, ...extra });
const clone = (o) => JSON.parse(JSON.stringify(o));
const verifyFix = (mutate = (b) => b, policy = fixPolicy(), input = {}) => verifyVbsEvidence({ evidence: mutate(clone(FIX.body)), capture: CAPTURE, ...input }, policy);
const failedNames = (res) => res.checks.filter((c) => !c.ok && !c.skipped).map((c) => c.name);
const flipB64 = (b64, at) => { const b = Buffer.from(b64, "base64"); b[at] ^= 0x01; return b.toString("base64"); };
const sha256 = (...p) => { const h = createHash("sha256"); for (const x of p) h.update(x); return h.digest(); };

// Edit the VSM_LAUNCH_TYPE value inside the log's PCR 12 SIPA event, keeping
// the recorded digest (the tamper the recompute rule exists for) or fixing it
// (which the quote then catches).
function tamperVsmLaunchType(logB64, { fixDigest = false } = {}) {
  const log = Buffer.from(logB64, "base64");
  const { events } = parseTcgLog(log);
  const id = Buffer.from([0x12, 0x00, 0x05, 0x00]);                            // SIPA 0x50012, little-endian
  const e = events.find((x) => x.pcr === 12 && x.type === 6 && x.data.indexOf(id) >= 0);
  const dataAt = e.data.byteOffset - log.byteOffset, rec = e.data.indexOf(id);
  log[dataAt + rec + 8] ^= 0x01;                                                // the value's low byte: 1 -> 0
  if (fixDigest) sha256(log.subarray(dataAt, dataAt + e.data.length)).copy(log, dataAt - 4 - 32);
  return log.toString("base64");
}

test("vbs: the pinned roots bundle is AMD's fTPM chain, and the fixture's EK chains to it", () => {
  const t = loadTpmRoots(ROOTS);
  assert.deepEqual(t.pins, [AMD_FTPM_ROOT_SHA256]);
  assert.equal(t.intermediates.length, 1, "the PRG-HPT intermediate rides along for nodes that omit it");
  assert.equal(tpmManufacturerOf(Buffer.from(FIX.body.ek.cert, "base64")), "414D4400");
});

test("vbs: the port decodes boot 64 exactly as tools/tcglog.py does", () => {
  const { events } = parseTcgLog(Buffer.from(FIX.body.log, "base64"));
  assert.equal(events.length, 43);
  assert.equal(replayPcrs(events).get(12).toString("hex"), FIX.expect.pcr12);
  assert.deepEqual(unhashedEvents(events), []);
  const f = sipaFields(events, 12);
  assert.deepEqual(f.get("TESTSIGNING"), [0, 1]); assert.deepEqual(f.get("CODEINTEGRITY"), [1, 1]); assert.deepEqual(f.get("BOOTCOUNTER"), [228]);
  assert.equal(f.get("SYSTEMROOT")[0], "\\WINDOWS");
  assert.equal(secureBootFromLog(events), 0);
  const k = vsmKey(events, "IDKS");
  assert.equal(k.bits, 2048); assert.equal(sha256(k.modulus).toString("hex").slice(0, 16), FIX.expect.idksModulusSha256Prefix);
  const aik = parseTpmtPublic(Buffer.from(FIX.body.quote.aikPub, "base64"));
  assert.equal(aik.attributes, 0x00050072); assert.equal(aik.keyBits, 2048); assert.equal(aik.exponent, 65537);
  const q = parseTpmsAttest(Buffer.from(FIX.body.quote.attest, "base64"));
  assert.deepEqual(q.pcrSelect, [{ hash: 0x0b, pcrs: [0, 7, 12, 13, 14] }]);
  assert.ok(q.extraData.equals(CAPTURE.quoteExtraData));
  const r = parseEnclaveReport(Buffer.from(FIX.body.report, "base64"));
  assert.deepEqual(r.modules.map((m) => m.name), ["rawenclave.dll", "ucrtbase_enclave.dll", "vertdll.dll"]);
  assert.equal(r.identity.enclaveSvn, FIX.expect.svn); assert.equal(r.identity.enclaveType, 0x10);
  assert.equal(enclaveMeasurementKey(r.identity), FIX.expect.measurementKey);
  assert.ok(r.enclaveData.subarray(0, 32).equals(CAPTURE.reportData));
});

test("vbs: boot 64 verifies end to end in capture mode, as tier vbs-dev (test signing on, Secure Boot off)", () => {
  const res = verifyFix();
  assert.equal(res.ok, true, res.reasons.join("; "));
  assert.equal(res.tier, "vbs-dev"); assert.equal(res.capture, true);
  assert.deepEqual(failedNames(res), ["5 log: TESTSIGNING == 0 (production signing)", "5 log: Secure Boot on (PCR 7 SecureBoot variable)"]);
  assert.ok(res.checks.length >= 32, `${res.checks.length} checks`);
  assert.equal(res.measurement, FIX.expect.imageId + FIX.expect.authorId + "07000000");
  assert.equal(res.identity.measurementKey, FIX.expect.measurementKey);
  assert.ok(res.warnings.some((w) => /BOOTCOUNTER 228/.test(w)), "the fTPM's odd clockInfo is a warning, never a failure");
  assert.ok(res.warnings.some((w) => /VBS_IOMMU_REQUIRED/.test(w)));
});

test("vbs: the same evidence is refused under production policy, naming the dev-only facts", () => {
  const res = verifyFix((b) => b, fixPolicy({ allowTestSigning: false }));
  assert.equal(res.ok, false); assert.equal(res.tier, null); assert.equal(res.measurement, null);
  assert.equal(res.reasons.length, 2);
  assert.match(res.reasons[0], /TESTSIGNING == 0.*METAL_VBS_ALLOW_TESTSIGNING not set/);
  assert.match(res.reasons[1], /Secure Boot on.*METAL_VBS_ALLOW_TESTSIGNING not set/);
});

test("vbs: tamper — a flipped byte in the report (statement, EnclaveData or signature) fails the IDKS signature; a wrong report nonce fails the binding", () => {
  for (const at of [24 + 100, 24 + 40, 24 + 700]) {
    const res = verifyFix((b) => ({ ...b, report: flipB64(b.report, at) }));
    assert.equal(res.ok, false, `byte ${at}`);
    assert.ok(failedNames(res).includes("7 report: signed by the IDKS of this boot (RSA-PSS SHA-256, salt 32)"), `byte ${at}: ${failedNames(res)}`);
  }
  const res = verifyVbsEvidence({ evidence: clone(FIX.body), capture: { ...CAPTURE, reportData: Buffer.alloc(32, 1) } }, fixPolicy());
  assert.equal(res.ok, false);
  assert.deepEqual(failedNames(res).filter((n) => n.startsWith("7")), ["7 report: EnclaveData[0:32] == challenge"]);
});

test("vbs: tamper — an edited SIPA field is caught by digest recomputation, and by the quote once the digest is fixed up", () => {
  const kept = verifyFix((b) => ({ ...b, log: tamperVsmLaunchType(b.log) }));
  assert.equal(kept.ok, false);
  const k = failedNames(kept);
  assert.ok(k.includes("5 log: every SIPA record and PCR 7 variable event hashes to its recorded digest"), k.join("; "));
  assert.ok(k.includes("5 log: VSM_LAUNCH_TYPE == 1"), "the field reader skips the unrecomputable event, so the field is missing, not 0");
  assert.ok(!k.includes("4 quote: PCR digest == sha256(PCR0 || replayed PCR7 || PCR12 || PCR13 || PCR14)"), "with the digest kept the replay still matches the quote: exactly the tamper the recompute rule exists for");
  const fixed = verifyFix((b) => ({ ...b, log: tamperVsmLaunchType(b.log, { fixDigest: true }) }));
  assert.equal(fixed.ok, false);
  const f = failedNames(fixed);
  assert.ok(f.includes("4 quote: PCR digest == sha256(PCR0 || replayed PCR7 || PCR12 || PCR13 || PCR14)"), f.join("; "));
  assert.ok(f.includes("5 log: VSM_LAUNCH_TYPE == 1"));
  assert.ok(!f.includes("5 log: every SIPA record and PCR 7 variable event hashes to its recorded digest"));
});

test("vbs: tamper — quote bytes, quote signature, wrong quote nonce, wrong PCR 0, wrong quoting key", () => {
  let res = verifyFix((b) => ({ ...b, quote: { ...b.quote, attest: flipB64(b.quote.attest, 140) } }));   // inside pcrDigest
  assert.equal(res.ok, false); assert.ok(failedNames(res).includes("4 quote: signature verifies with the quoting key (RSASSA-PKCS1v15-SHA256)"));
  res = verifyFix((b) => ({ ...b, quote: { ...b.quote, sig: flipB64(b.quote.sig, 10) } }));
  assert.equal(res.ok, false); assert.ok(failedNames(res).includes("4 quote: signature verifies with the quoting key (RSASSA-PKCS1v15-SHA256)"));
  res = verifyVbsEvidence({ evidence: clone(FIX.body), capture: { ...CAPTURE, quoteExtraData: Buffer.alloc(32, 2) } }, fixPolicy());
  assert.equal(res.ok, false); assert.deepEqual(failedNames(res).filter((n) => n.startsWith("4")), ["4 quote: extraData == challenge"]);
  res = verifyFix((b) => ({ ...b, pcr0: "00".repeat(32) }));
  assert.equal(res.ok, false);
  assert.ok(failedNames(res).includes("4 quote: PCR digest == sha256(PCR0 || replayed PCR7 || PCR12 || PCR13 || PCR14)"), "a PCR 0 the TPM did not quote breaks the digest");
  assert.ok(failedNames(res).includes("4 quote: PCR 0 on the policy pin list (METAL_VBS_PCR0)"));
  res = verifyFix((b) => b, fixPolicy({ pcr0: [] }));
  assert.equal(res.ok, true, "dev tier: an unpinned PCR 0 is a demotion, not a refusal");
  assert.ok(failedNames(res).includes("4 quote: PCR 0 on the policy pin list (METAL_VBS_PCR0)"));
  res = verifyFix((b) => b, fixPolicy({ pcr0: [], allowTestSigning: false }));
  assert.equal(res.ok, false); assert.ok(res.reasons.some((r) => /PCR 0 on the policy pin list/.test(r)));
  const other = tpmtPublicOf(generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey);
  res = verifyFix((b) => ({ ...b, quote: { ...b.quote, aikPub: other.toString("base64") } }));
  assert.equal(res.ok, false); assert.ok(failedNames(res).includes("4 quote: signature verifies with the quoting key (RSASSA-PKCS1v15-SHA256)"));
});

test("vbs: tamper — the EK must chain to a pinned root and name an on-die manufacturer", () => {
  let res = verifyFix((b) => b, fixPolicy({ ekRoots: "" }));
  assert.equal(res.ok, false); assert.ok(res.reasons.some((r) => /no pinned TPM roots/.test(r)));
  const { roots, intermediates } = loadTpmRoots(ROOTS);
  res = verifyFix((b) => b, fixPolicy({ ekRoots: intermediates }));                 // no self-signed cert: nothing is pinned
  assert.equal(res.ok, false); assert.ok(res.reasons.some((r) => /no pinned TPM roots/.test(r)));
  res = verifyFix((b) => ({ ...b, ek: { ...b.ek, chain: [] } }), fixPolicy({ ekRoots: roots }));   // root only, intermediate omitted
  assert.equal(res.ok, false); assert.ok(res.reasons.some((r) => /EK chain breaks/.test(r)), res.reasons.join("; "));
  res = verifyFix((b) => b, fixPolicy({ ekRoots: roots }));                       // root only, the node supplied the intermediate
  assert.equal(res.ok, true, res.reasons.join("; "));
  res = verifyFix((b) => b, fixPolicy({ ekRootPins: ["11".repeat(32)] }));         // an explicit pin list that excludes AMD
  assert.equal(res.ok, false); assert.ok(res.reasons.some((r) => /no pinned TPM roots/.test(r)));
  // the SAN edited to another vendor id: the chain signature breaks AND the manufacturer check fails on its own
  res = verifyFix((b) => { const c = Buffer.from(b.ek.cert, "base64"); const i = c.indexOf(Buffer.from("id:414D4400")); c.write("id:51434F4D", i); return { ...b, ek: { ...b.ek, cert: c.toString("base64") } }; });
  assert.equal(res.ok, false);
  assert.ok(failedNames(res).includes("1 ek: on-die firmware TPM (SAN tpmManufacturer AMD/Intel)"));
  assert.ok(failedNames(res).includes("1 ek: chains to a pinned TPM root"));
});

test("vbs: the enclave allowlist, SVN floor and debug flags gate admission", () => {
  let res = verifyFix((b) => b, fixPolicy({ measurements: [] }));
  assert.equal(res.ok, false); assert.ok(res.reasons.some((r) => /allowlist.*no allowlist configured/.test(r)), res.reasons.join("; "));
  res = verifyFix((b) => b, fixPolicy({ measurements: ["ab".repeat(32)] }));
  assert.equal(res.ok, false); assert.ok(res.reasons.some((r) => /allowlist/.test(r)));
  res = verifyFix((b) => b, fixPolicy({ minSvn: 8 }));
  assert.equal(res.ok, false); assert.ok(res.reasons.some((r) => /SVN >= 8/.test(r)));
  assert.equal(verifyFix((b) => b, fixPolicy({ minSvn: 7 })).ok, true);
});

test("vbs: bounded inputs — oversized or missing fields are refused before parsing, never thrown", () => {
  const big = "A".repeat(6 * 1024 * 1024);
  let res = verifyFix((b) => ({ ...b, log: big }));
  assert.equal(res.ok, false); assert.ok(res.reasons.some((r) => /log missing or oversized/.test(r)));
  res = verifyFix((b) => ({ ...b, report: "A".repeat(100 * 1024) }));
  assert.equal(res.ok, false); assert.ok(res.reasons.some((r) => /report missing or oversized/.test(r)));
  res = verifyFix((b) => ({ ...b, ek: { cert: "A".repeat(100 * 1024) } }));
  assert.equal(res.ok, false); assert.ok(res.reasons.some((r) => /ek\.cert missing or oversized/.test(r)));
  res = verifyFix((b) => ({ ...b, quote: { ...b.quote, aikPub: "AAAA" } }));
  assert.equal(res.ok, false); assert.ok(res.reasons.some((r) => /TPMT_PUBLIC/.test(r)));
  for (const junk of [null, 42, "x", [], { report: 1, log: {}, quote: "q", ek: 7 }]) {
    const r = verifyVbsEvidence({ evidence: junk, capture: CAPTURE }, fixPolicy());
    assert.equal(r.ok, false); assert.ok(r.reasons.length >= 3);
  }
  // no capture, no transcript: the live path with a malformed transport key
  res = verifyVbsEvidence({ evidence: clone(FIX.body), nonce: Buffer.alloc(32, 1), transportKeySpki: Buffer.from("30599999", "hex"), padKeyHex: "31".repeat(32) }, fixPolicy());
  assert.equal(res.ok, false); assert.ok(res.reasons.some((r) => /Ed25519 SPKI/.test(r)));
  assert.equal(res.capture, false);
});

test("vbs: policy from the METAL_VBS_* env", () => {
  assert.equal(vbsPolicyFromEnv({}), null, "no allowed enclave build = mode vbs off");
  const key = "ab".repeat(32);
  const p = vbsPolicyFromEnv({ METAL_VBS_ENCLAVE_MEASUREMENTS: ` ${key.toUpperCase()}, ` });
  assert.deepEqual(p.measurements, [key]); assert.equal(p.minSvn, 1); assert.deepEqual(p.pcr0, []); assert.equal(p.allowTestSigning, false);
  assert.equal(p.ekRootsPath, VBS_DEFAULT_EK_ROOTS); assert.deepEqual(loadTpmRoots(p.ekRoots).pins, [AMD_FTPM_ROOT_SHA256]);
  const q = vbsPolicyFromEnv({ METAL_VBS_ENCLAVE_MEASUREMENTS: key, METAL_VBS_MIN_SVN: "3", METAL_VBS_PCR0: `${FIX.expect.pcr0},${"cd".repeat(32)}`,
                               METAL_VBS_EK_ROOTS: "/x/roots.pem", METAL_VBS_ALLOW_TESTSIGNING: "yes" }, { readFile: (f) => { assert.equal(f, "/x/roots.pem"); return ROOTS; } });
  assert.equal(q.minSvn, 3); assert.deepEqual(q.pcr0, [FIX.expect.pcr0, "cd".repeat(32)]); assert.equal(q.allowTestSigning, true); assert.equal(q.ekRootsPath, "/x/roots.pem");
  assert.throws(() => vbsPolicyFromEnv({ METAL_VBS_ENCLAVE_MEASUREMENTS: "nothex" }), /not 32 bytes of hex/);
  assert.throws(() => vbsPolicyFromEnv({ METAL_VBS_ENCLAVE_MEASUREMENTS: key, METAL_VBS_PCR0: "12" }), /METAL_VBS_PCR0/);
  assert.throws(() => vbsPolicyFromEnv({ METAL_VBS_ENCLAVE_MEASUREMENTS: key, METAL_VBS_MIN_SVN: "one" }), /METAL_VBS_MIN_SVN/);
  assert.throws(() => vbsPolicyFromEnv({ METAL_VBS_ENCLAVE_MEASUREMENTS: key, METAL_VBS_EK_ROOTS: "/nonexistent/roots.pem" }), /cannot read/);
  assert.throws(() => vbsPolicyFromEnv({ METAL_VBS_ENCLAVE_MEASUREMENTS: key }, { readFile: () => "not a pem" }), /no PEM certificate/);
  // the fixture verifies under an env-built policy too
  const env = vbsPolicyFromEnv({ METAL_VBS_ENCLAVE_MEASUREMENTS: FIX.expect.measurementKey, METAL_VBS_PCR0: FIX.expect.pcr0, METAL_VBS_ALLOW_TESTSIGNING: "1" });
  assert.equal(verifyFix((b) => b, env).ok, true);
});

// The fixture cannot exercise the transcript (it predates it) or the credential
// (it predates MakeCredential). A node built from generated keys can: the hub's
// nonce, both enclave keys in the signed transcript, a credential minted for
// (EK, AIK name) and recovered with the EK's private key, and every tamper.
test("vbs: a synthetic node with generated keys passes the full transcript, credential round trip and transport binding; each tamper fails by name",
     { skip: !haveOpenssl && "openssl not installed" }, () => {
  const dir = tmpdir("vbs-verify-");
  try {
    const w = makeVbsWorld(dir);
    const nonce = randomBytes(32), minted = randomBytes(32);
    const { credentialBlob, secret } = makeCredential(w.ek.cert, w.aik.name, minted);
    const credential = activateCredential(w.ek.privateKey, w.aik.name, credentialBlob, secret);
    assert.ok(credential.equals(minted), "software ActivateCredential with the EK's private key recovers the credential");
    const ev = evidenceFor(w, { nonce, credential });
    const input = (body, extra = {}) => ({ evidence: body, nonce, transportKeySpki: w.transport.spki, padKeyHex: w.padKey, expectedCredential: minted,
                                          mintedFor: { ekCert: w.ek.cert, aikName: w.aik.name }, ...extra });
    const verify = (body, extra, policy = policyFor(w)) => verifyVbsEvidence(input(body, extra), policy);

    const res = verify(ev.body);
    assert.equal(res.ok, true, res.reasons.join("; "));
    assert.equal(res.tier, "vbs"); assert.equal(res.capture, false);
    assert.ok(res.checks.every((c) => c.ok), failedNames(res).join("; "));
    assert.equal(res.measurement, w.identity.imageId.toString("hex") + w.identity.authorId.toString("hex") + "03000000");
    assert.equal(res.identity.measurementKey, w.measurementKey);
    assert.deepEqual(res.identity.modules, ["enclave-engine.dll", "vertdll.dll", "ucrtbase_enclave.dll"]);
    assert.deepEqual(res.warnings, []);

    // stale nonce: the enclave signed a transcript for another challenge
    const stale = verify(evidenceFor(w, { nonce: Buffer.alloc(32, 9), credential }).body);
    assert.equal(stale.ok, false);
    for (const n of ["8 binding: Ed25519 signature over bound verifies with transportKey", "7 report: EnclaveData[0:32] == challenge", "4 quote: extraData == challenge"])
      assert.ok(failedNames(stale).includes(n), `${n}: ${failedNames(stale)}`);
    // the pad key in the rad is not the one inside the signed transcript
    const pad = verify(ev.body, { padKeyHex: "31".repeat(32) });
    assert.equal(pad.ok, false); assert.ok(failedNames(pad).includes("8 binding: Ed25519 signature over bound verifies with transportKey"));
    // a transcript signed by some other Ed25519 key
    const otherTransport = generateKeyPairSync("ed25519");
    const forged = verify(ev.body, { transportKeySpki: otherTransport.publicKey.export({ type: "spki", format: "der" }) });
    assert.equal(forged.ok, false); assert.ok(failedNames(forged).includes("8 binding: Ed25519 signature over bound verifies with transportKey"));
    // the TPM handed back the wrong credential
    const wrongCred = verify({ ...ev.body, credential: randomBytes(32).toString("base64") });
    assert.equal(wrongCred.ok, false); assert.deepEqual(failedNames(wrongCred), ["3 credential: activated credential == the one minted for (EK, AIK name)"]);
    const noCred = verify(ev.body, { expectedCredential: null });
    assert.equal(noCred.ok, false); assert.ok(noCred.reasons.some((r) => /no credential was minted/.test(r)));
    // the credential was minted for another quoting key / another EK than the ones that attested
    const otherAik = tpmtPublicOf(generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey);
    const swappedAik = verify(ev.body, { mintedFor: { ekCert: w.ek.cert, aikName: nameOf(otherAik) } });
    assert.equal(swappedAik.ok, false); assert.ok(failedNames(swappedAik).some((n) => /minted for$/.test(n)), failedNames(swappedAik).join("; "));
    const ek2 = issueEk(dir);
    const swappedEk = verify(ev.body, { mintedFor: { ekCert: ek2.cert, aikName: w.aik.name } });
    assert.equal(swappedEk.ok, false); assert.ok(failedNames(swappedEk).includes("3 credential: EK certificate is the one the credential was minted for"));
    // a debuggable enclave, a test-signed boot, Secure Boot off: dev tier under lab policy, refused in production
    for (const [what, opts, name] of [["debug flags", { report: { identity: { flags: 0x2 } } }, "7 report: enclave not debuggable (FULL_DEBUG / DYNAMIC_DEBUG clear)"],
                                      ["TESTSIGNING=1", { log: { fields: { TESTSIGNING: 1 } } }, "5 log: TESTSIGNING == 0 (production signing)"],
                                      ["Secure Boot off", { log: { secureBoot: 0 } }, "5 log: Secure Boot on (PCR 7 SecureBoot variable)"],
                                      ["quote without PCR 0", { quote: { select: [7, 12, 13, 14] } }, "4 quote: PCR selection is the SHA-256 bank over {0,7,12,13,14}"]]) {
      const body = evidenceFor(w, { nonce, credential, ...opts }).body;
      const prod = verify(body);
      assert.equal(prod.ok, false, what); assert.ok(prod.reasons.some((r) => r.includes(name) && /ALLOW_TESTSIGNING not set/.test(r)), `${what}: ${prod.reasons}`);
      const dev = verify(body, {}, policyFor(w, { allowTestSigning: true }));
      assert.equal(dev.ok, true, `${what}: ${dev.reasons}`); assert.equal(dev.tier, "vbs-dev");
      assert.ok(failedNames(dev).includes(name));
    }
    // a required PCR 12 fact that is simply wrong is never a dev matter
    const noHvci = verify(evidenceFor(w, { nonce, credential, log: { fields: { VBS_HVCI_POLICY: 0 } } }).body, {}, policyFor(w, { allowTestSigning: true }));
    assert.equal(noHvci.ok, false); assert.deepEqual(failedNames(noHvci), ["5 log: VBS_HVCI_POLICY == 1"]);
    // wrong SVN, wrong build
    assert.ok(verify(evidenceFor(w, { nonce, credential, report: { identity: { svn: 0 } } }).body).reasons.some((r) => /SVN >= 1/.test(r)));
    assert.ok(verify(evidenceFor(w, { nonce, credential, report: { identity: { imageId: Buffer.alloc(16, 0xee) } } }).body).reasons.some((r) => /allowlist/.test(r)));
    // a report signed by a key that is not this boot's IDKS
    const otherIdks = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wrongIdks = verify(evidenceFor({ ...w, idks: { ...w.idks, privateKey: otherIdks.privateKey } }, { nonce, credential }).body);
    assert.equal(wrongIdks.ok, false); assert.deepEqual(failedNames(wrongIdks), ["7 report: signed by the IDKS of this boot (RSA-PSS SHA-256, salt 32)"]);
    // an EK from a vendor that is not an on-die firmware TPM: the chain is fine, the manufacturer is not
    const ekQ = issueEk(dir, { manufacturer: "51434F4D" });
    const wq = { ...w, ek: ekQ };
    const q = verifyVbsEvidence(input(evidenceFor(wq, { nonce, credential }).body, { mintedFor: { ekCert: ekQ.cert, aikName: w.aik.name } }), policyFor(w));
    assert.equal(q.ok, false); assert.deepEqual(failedNames(q), ["1 ek: on-die firmware TPM (SAN tpmManufacturer AMD/Intel)"]);
    // the SIPA tamper, on a synthetic log: caught by recompute, then by the quote
    const kept = verify({ ...ev.body, log: tamperVsmLaunchType(ev.body.log) });
    assert.ok(failedNames(kept).includes("5 log: every SIPA record and PCR 7 variable event hashes to its recorded digest"));
    const fixed = verify({ ...ev.body, log: tamperVsmLaunchType(ev.body.log, { fixDigest: true }) });
    assert.ok(failedNames(fixed).includes("4 quote: PCR digest == sha256(PCR0 || replayed PCR7 || PCR12 || PCR13 || PCR14)"));
    assert.ok(failedNames(fixed).includes("5 log: VSM_LAUNCH_TYPE == 1"));
    // the bundle carries the root only: the node's chain must supply the intermediate
    assert.equal(verify(ev.body, {}, policyFor(w, { ekRoots: w.ca.rootPem })).ok, true);
    assert.ok(verify({ ...ev.body, ek: { cert: ev.body.ek.cert, chain: [] } }, {}, policyFor(w, { ekRoots: w.ca.rootPem })).reasons.some((r) => /EK chain breaks/.test(r)));
    // and the real AMD pins never admit the synthetic root
    assert.ok(verify(ev.body, {}, policyFor(w, { ekRoots: ROOTS })).reasons.some((r) => /EK chain breaks|not a pinned TPM root/.test(r)));
    // the binding transcript is the documented one
    assert.ok(ev.bound.equals(Buffer.concat([Buffer.from("enclave-vbs-bind-v1\n"), w.transport.spki, Buffer.from(w.padKey, "hex"), nonce])));
    assert.equal(VBS_FORMAT, "windows-vbs-enclave/v1");
    assert.throws(() => vbsBinding(w.transport.spki, w.padKey.slice(2), nonce), /padKey/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
