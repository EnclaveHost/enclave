// The Linux per-app SNP tier's FIRST production canary (hello-world:1.0.4 on metal-iso0, https://4e62e60d.app.enclave.host),
// from the isolation owner's capture pinned at test/fixtures/verifier/linux-canary-2026-09-24 (fixtures.json), judged by
// this verifier's domain-format path with the owner's runtime contract IMPORTED from its pinned commit (pins.json
// linux-domain-contract: RuntimeID, Bind2, the identity's rules), never restated. Proves, offline: the served certificate's
// key is the key the document binds and the key the owner's client saw; the report is a Turin v5 VMPL0 report whose ABI/2
// binding equals Bind2(served SPKI, the capture's nonce, RuntimeID(expected-runtime.json)); the AMD chain walks through the
// captured VCEK to the pinned Turin root with the CRL; the reported and committed TCB meet min-tcb.json; report_data[32:64]
// is the AppID; and every single-field forgery is refused on its own check. The browser build gives the same verdict.
// LIMITS, stated: the expected measurement and the expected AppID are the OWNER'S STATED values (README: recomputed by
// expected-measurement.sh from a release whose bytes are not published, and derived by derive_reference.py from the
// catalog); this suite does not reproduce either, so "verified" here means "against the owner's stated expectations".
// verifier/live-domain-check.mjs derives the AppID independently from the component by CID when run.
//   run: node --test test/verifier-linux-canary.test.mjs   (strict: ENCLAVE_DOMAIN_CONTRACT must point at the pinned contract)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { verifyEvidence, memoryCollateral, spkiOfCert } from "../verifier/index.mjs";
import { verifyEvidenceWeb } from "../verifier/web/index.mjs";

const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
const F = new URL("./fixtures/verifier/linux-canary-2026-09-24/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url), V = new URL("./fixtures/verifier/amd/", import.meta.url);
const read = (u) => fs.readFileSync(u), text = (u) => fs.readFileSync(u, "utf8"), json = (u) => JSON.parse(text(u));
const sha = (...b) => createHash("sha256").update(Buffer.concat(b)).digest();
// the owner's contract: the pinned materialisation (strict), else the tree's copy, else skip with the reason
const contractPath = process.env.ENCLAVE_DOMAIN_CONTRACT || (fs.existsSync(new URL("../isolation/contract/runtime.mjs", import.meta.url)) ? new URL("../isolation/contract/runtime.mjs", import.meta.url).pathname : null);
if (STRICT && !process.env.ENCLAVE_DOMAIN_CONTRACT) throw new Error("strict integration: ENCLAVE_DOMAIN_CONTRACT (the pinned isolation/contract/runtime.mjs) is not set");
const skip = !contractPath && "the isolation owner's runtime contract is not pinned here (ENCLAVE_DOMAIN_CONTRACT) and not in this tree";
const C = contractPath ? await import(pathToFileURL(contractPath).href) : null;
const asBuf = (x) => (Buffer.isBuffer(x) ? x : typeof x === "string" ? Buffer.from(x, "hex") : Buffer.from(x));

const saved = json(new URL("prod-doc.json", F)), doc = saved.doc, report = Buffer.from(doc.report, "base64");
const certPem = text(new URL("served-cert.pem", F)), { spki } = spkiOfCert(certPem);
const nonce = Buffer.from(saved.nonce, "hex"), identity = json(new URL("expected-runtime.json", F)), minTcb = json(new URL("min-tcb.json", F)), record = json(new URL("record.json", F));
// the owner's stated expectations, from the committed output of expected-measurement.sh (expected-measurement.txt): the
// measurement is not reproduced here (release bytes unpublished); the AppID is reproduced by verifier/live-domain-check.mjs
// --derive from the component by CID, and the value there equalled this one on 2026-09-24
const expectedTxt = text(new URL("expected-measurement.txt", F)), field = (k) => (new RegExp(`^${k}\\s+(\\S+)$`, "m").exec(expectedTxt) || [])[1];   // a template literal eats single backslashes
const OWNER_MEASUREMENT = field("measurement"), OWNER_APP_ID = field("app_id");
assert.match(OWNER_MEASUREMENT || "", /^[0-9a-f]{96}$/, "expected-measurement.txt states the full measurement"); assert.match(OWNER_APP_ID || "", /^[0-9a-f]{64}$/);
assert.equal(field("runtime_id"), json(new URL("record.json", F)).runtimeId, "the owner's runtime_id is the derivation record's");
const OWNER_SPKI_SHA256 = "b6230cb3948781c6c7fdf1f891f028c3a2fc99d59e726ef6462fe2bec06dbe91";
const NOW = "2026-09-24T19:00:00Z";   // after the served certificate's notBefore (18:15:27Z), the day of the capture
const col = (over = {}) => memoryCollateral({ chains: { Turin: text(new URL("Turin-cert_chain.pem", A)), Genoa: text(new URL("Genoa-cert_chain.pem", A)) }, vceks: { Turin: read(new URL("vcek.der", F)) }, crls: { Turin: read(new URL("Turin-crl.der", V)) }, ...over });
const rid = () => asBuf(C.runtimeId(identity)), bind2 = (n = nonce, k = spki, r = rid()) => asBuf(C.bind2(k, n, r));
const run = (d = doc, { policy = {}, context = {}, collateral = col() } = {}) =>
  verifyEvidence(d, { policy: { snp: { allowedMeasurements: [OWNER_MEASUREMENT], minTcb, ...policy } }, context: { transportKeySpki: spki, nonce, expectedBinding: bind2(), expectedAppId: Buffer.from(OWNER_APP_ID, "hex"), now: NOW, ...context }, collateral });
const rejectedAt = (v, check, re) => { assert.equal(v.status, "rejected", v.reasons.join("\n")); assert.equal(v.checks[check], false, v.reasons.at(-1)); if (re) assert.match(v.reasons.at(-1), re); };

test("the served certificate's key is the key the document binds and the key the owner's client saw", { skip }, () => {
  assert.equal(sha(spki).toString("hex"), OWNER_SPKI_SHA256);
  assert.ok(spki.equals(Buffer.from(doc.transportKey, "base64")), "doc.transportKey is the served SPKI"); assert.ok(spki.equals(Buffer.from(saved.spki, "base64")), "the client's handshake SPKI");
  assert.equal(doc.nonce, saved.nonce); assert.equal(doc.abi, "enclave-domain-abi/2"); assert.equal(doc.tier, "T1"); assert.equal(doc.format, "sev-snp-guest-domain-v1");
  assert.deepEqual(Object.keys(doc).sort(), ["abi", "appSha256", "format", "nonce", "report", "runtime", "runtimeSelfTest", "tier", "transportKey"], "exactly the keys the owner stated");
  assert.equal(doc.appSha256, OWNER_APP_ID, "the document's own appSha256 claim equals the expected AppID (a claim; report_data decides)");
  assert.equal(JSON.stringify(JSON.parse(field("runtime_identity_json") || "{}")), JSON.stringify(identity), "the owner's identity JSON is expected-runtime.json");
  assert.equal(C.validateRuntimeIdentity(identity), null); assert.deepEqual(doc.runtime, identity, "the document states the expected identity");
  assert.equal(rid().toString("hex"), record.runtimeId, "RuntimeID from the pinned contract equals the derivation record's");
});

test("the capture verifies through the domain path against the owner's stated expectations: Turin v5, VMPL0, ABI/2 Bind2 from the pinned contract, chain through the captured VCEK, CRL, TCB floor, AppID", { skip }, async () => {
  const v = await run();
  assert.equal(v.status, "verified", v.reasons.join("\n")); assert.equal(v.admissionSafe, true); assert.deepEqual(v.omissions, []);
  assert.equal(v.claims.product, "Turin"); assert.equal(v.claims.reportVersion, 5); assert.equal(v.claims.vmpl, 0); assert.equal(v.claims.abi, "enclave-domain-abi/2");
  assert.equal(v.claims.measurement, OWNER_MEASUREMENT); assert.equal(v.claims.appId, OWNER_APP_ID); assert.equal(v.claims.freshness, "verifier nonce");
  assert.deepEqual(v.claims.tcb.reported, minTcb.Turin, "the reported TCB is exactly the floor the owner set"); assert.deepEqual(v.claims.tcb.committed, minTcb.Turin);
  assert.equal(v.claims.guestPolicy.debug, false); assert.equal(v.claims.guestPolicy.migrateMa, false); assert.equal(v.checks.crl, true);
  // the owner's client's RESULT lines, cross-checked against this verdict's claims
  const client = text(new URL("prod-client.txt", F)), res = (k) => (new RegExp(`^RESULT ${k}=(.*)$`, "m").exec(client) || [])[1];
  assert.equal(res("measurement"), v.claims.measurement); assert.equal(res("report_data"), v.claims.reportData); assert.equal(res("report_vmpl"), String(v.claims.vmpl)); assert.equal(res("abi"), v.claims.abi);
  assert.equal(res("spki_sha256"), v.claims.transportSpkiSha256); assert.equal(v.claims.reportData.slice(64), OWNER_APP_ID);
  assert.equal(v.claims.reportData.slice(0, 64), bind2().toString("hex"), "report_data[0:32] IS Bind2 over the served key, the nonce and the runtime identity");
});

test("single-field forgeries: another nonce, another runtime identity, another app, ABI/1 in place of ABI/2, another product's chain, the wrong VCEK", { skip }, async () => {
  const other = Buffer.from(nonce); other[0] ^= 1;
  rejectedAt(await run(doc, { context: { nonce: other, expectedBinding: bind2(other) } }), "binding", /does not equal the ABI\/2/);
  rejectedAt(await run(doc, { context: { expectedBinding: bind2(nonce, spki, asBuf(C.runtimeId({ ...identity, version: "48.0.0" }))) } }), "binding", /does not equal the ABI\/2/);
  rejectedAt(await run(doc, { context: { expectedAppId: Buffer.from(OWNER_APP_ID.replace(/^9c/, "9d"), "hex") } }), "app id", /names app/);
  rejectedAt(await run(doc, { context: { expectedBinding: undefined } }), "binding", /no silent downgrade/);
  rejectedAt(await run(doc, { collateral: col({ chains: { Turin: text(new URL("Genoa-cert_chain.pem", A)) } }) }), "chain", /not AMD's pinned Turin root/);
  // a FINDING, not a forgery: the M4a lab fixture's VCEK (turin-m4a) verifies this production report too, because the
  // canary guest runs on the SAME Turin part as the lab capture (chip id fa11afcf54ae9c53); the Genoa VCEK is the wrong key
  const lab = await run(doc, { collateral: col({ vceks: { Turin: read(new URL("../turin-m4a/vcek-kds-amd.der", F)) } }) });
  assert.equal(lab.status, "verified", "the lab VCEK is this chip's VCEK (same part)"); assert.equal(lab.claims.chipId.slice(0, 16), "fa11afcf54ae9c53");
  rejectedAt(await run(doc, { collateral: col({ vceks: { Turin: read(new URL("../genoa-tinfoil/vcek-kds-amd.der", F)) } }) }), "chain", /VCEK issuer CN is SEV-Genoa/);
  rejectedAt(await run(doc, { policy: { allowedMeasurements: ["00".repeat(48)] } }), "measurement", /not an allowed measurement/);
  rejectedAt(await run(doc, { policy: { minTcb: { Turin: { ...minTcb.Turin, microcode: 118 } } } }), "tcb policy", /below policy/);
  rejectedAt(await run(doc, { collateral: col({ crls: {} }) }), "crl", /required by policy but none/);
  const flipped = Buffer.from(report); flipped[0x100] ^= 1;
  rejectedAt(await run({ ...doc, report: flipped.toString("base64") }), "signature", /invalid/);
});

test("deployment binding (F11 fix, HOST_DATA = deployment id): the capture's HOST_DATA is zero, so expecting the deployment REFUSES it today, in both builds; the owner's launcher change flips this", { skip }, async () => {
  const DEP = Buffer.from("4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e", "hex");
  assert.equal(report.subarray(0xc0, 0xe0).equals(Buffer.alloc(32)), true, "the canary guest was launched with all-zero HOST_DATA");
  rejectedAt(await run(doc, { context: { expectedHostData: DEP } }), "host data", /all zero/);
  const w = await verifyEvidenceWeb(doc, { policy: { snp: { allowedMeasurements: [OWNER_MEASUREMENT], minTcb } }, context: { transportKeySpki: spki, nonce, expectedBinding: bind2(), expectedAppId: Buffer.from(OWNER_APP_ID, "hex"), expectedHostData: DEP, now: NOW }, collateral: col() });
  assert.equal(w.status, "rejected"); assert.equal(w.checks["host data"], false);
  assert.equal((await run(doc)).checks["host data"], undefined, "without an expectation the check is not made (the verdict carries no such check)");
});

test("HOST_DATA live (owner's bc07f899, captures in host-data/): A and E verify under their own deployment ids with the host-data check true, E under A's is refused at that check naming E's id, and each served certificate's key is the bound key; measurement and AppID equal the first capture's", { skip }, async () => {
  const H = new URL("host-data/", F), DEP_A = Buffer.from("4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e", "hex"), DEP_E = Buffer.from("395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595", "hex");
  const NOW_HD = "2026-09-24T20:10:00Z";   // after the relaunch at 20:06:08Z, inside the new certificates' windows
  const load = (x) => { const saved = json(new URL(`doc-${x}.json`, H)), d = saved.doc, pem = text(new URL(`served-cert-${x}.pem`, H)), { spki: k } = spkiOfCert(pem);
    assert.ok(k.equals(Buffer.from(d.transportKey, "base64")) && k.equals(Buffer.from(saved.spki, "base64")), `${x}: the served key is the bound key and the client's handshake key`);
    return { d, k, n: Buffer.from(saved.nonce, "hex"), r: Buffer.from(d.report, "base64") }; };
  const A = load("A"), E = load("E");
  assert.ok(A.r.subarray(0xc0, 0xe0).equals(DEP_A) && E.r.subarray(0xc0, 0xe0).equals(DEP_E), "HOST_DATA is the raw deployment id in both reports");
  assert.ok(!A.k.equals(spki) && !A.k.equals(E.k), "new keys after the relaunch, one per guest");
  const runHd = (x, dep, extra = {}) => run(x.d, { context: { transportKeySpki: x.k, nonce: x.n, expectedBinding: bind2(x.n, x.k), expectedHostData: dep, now: NOW_HD, ...extra } });
  for (const [x, dep, name] of [[A, DEP_A, "A"], [E, DEP_E, "E"]]) {
    const v = await runHd(x, dep);
    assert.equal(v.status, "verified", `${name}: ${v.reasons.join("\n")}`); assert.equal(v.checks["host data"], true); assert.equal(v.claims.hostData, dep.toString("hex"));
    assert.equal(v.claims.measurement, OWNER_MEASUREMENT); assert.equal(v.claims.appId, OWNER_APP_ID);
  }
  const cross = await runHd(E, DEP_A);
  rejectedAt(cross, "host data", /names 395bed3e2e24efa0\.\.\., not the expected deployment 4e62e60da567ca6c/);
  assert.equal(cross.checks.binding, true, "everything before the host-data check passed: the misroute is caught by HOST_DATA alone");
  const w = await verifyEvidenceWeb(E.d, { policy: { snp: { allowedMeasurements: [OWNER_MEASUREMENT], minTcb } }, context: { transportKeySpki: E.k, nonce: E.n, expectedBinding: bind2(E.n, E.k), expectedAppId: Buffer.from(OWNER_APP_ID, "hex"), expectedHostData: DEP_A, now: NOW_HD }, collateral: col() });
  assert.equal(w.status, "rejected"); assert.equal(w.checks["host data"], false);
  const client = text(new URL("client-EasA.txt", H)); assert.match(client, /is not the expected deployment 0x4e62e60da567ca6c/, "the owner's client refused the same way");
});

test("F2 live (owner's 6757d139, captures in webpki/): each guest serves a WebPKI leaf for its OWN key over SNI whose SPKI is the bound key; the self-signed carrier by address (host side) is the same key; A and E verify under the new release's measurement with host data; the carrier chain is no trust input", { skip }, async () => {
  const W = new URL("webpki/", F), exp = text(new URL("expected-measurement.txt", W)), fld = (k) => (new RegExp(`^${k}\\s+(\\S+)$`, "m").exec(exp) || [])[1];
  const M2 = fld("measurement"), REL2 = fld("release"); assert.match(M2 || "", /^[0-9a-f]{96}$/); assert.match(REL2 || "", /^[0-9a-f]{64}$/); assert.notEqual(M2, OWNER_MEASUREMENT, "a new front: a new measurement");
  assert.equal(fld("app_id"), OWNER_APP_ID, "the AppID is unchanged");
  const NOW2 = "2026-09-24T20:45:00Z";
  for (const [x, dep] of [["A", "4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e"], ["E", "395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595"]]) {
    const saved = json(new URL(`doc-${x}.json`, W)), d = saved.doc, DEP = Buffer.from(dep, "hex");
    const chainPem = text(new URL(`served-chain-sni-${x}.pem`, W)), leafPem = chainPem.split(/(?=-----BEGIN CERTIFICATE-----)/).filter((c) => c.includes("CERTIFICATE"))[0], { spki: k, cert: leaf } = spkiOfCert(leafPem);
    const { spki: kAddr, cert: carrier } = spkiOfCert(text(new URL(`served-cert-by-address-${x}.pem`, W)));
    assert.ok(k.equals(Buffer.from(d.transportKey, "base64")) && k.equals(Buffer.from(saved.spki, "base64")), `${x}: the WebPKI leaf's key is the bound key`);
    assert.ok(kAddr.equals(k), `${x}: the self-signed carrier by address is the same key`); assert.match(carrier.subject, /CN=enclave-domain/); assert.match(leaf.subject, new RegExp(`CN=${x === "A" ? "4e62e60d" : "395bed3e"}\\.app\\.enclave\\.host`)); assert.match(leaf.issuer, /ZeroSSL/);
    assert.ok(Buffer.from(d.report, "base64").subarray(0xc0, 0xe0).equals(DEP), `${x}: HOST_DATA is the deployment id`);
    const n = Buffer.from(saved.nonce, "hex"), v = await verifyEvidence(d, { policy: { snp: { allowedMeasurements: [M2], minTcb } }, context: { transportKeySpki: k, nonce: n, expectedBinding: bind2(n, k), expectedAppId: Buffer.from(OWNER_APP_ID, "hex"), expectedHostData: DEP, now: NOW2 }, collateral: col() });
    assert.equal(v.status, "verified", `${x}: ${v.reasons.join("\n")}`); assert.equal(v.checks["host data"], true); assert.equal(v.claims.measurement, M2);
    const old = await verifyEvidence(d, { policy: { snp: { allowedMeasurements: [OWNER_MEASUREMENT], minTcb } }, context: { transportKeySpki: k, nonce: n, expectedBinding: bind2(n, k), expectedAppId: Buffer.from(OWNER_APP_ID, "hex"), expectedHostData: DEP, now: NOW2 }, collateral: col() });
    rejectedAt(old, "measurement", /not an allowed measurement/);   // the first release's measurement no longer matches: the front changed
    // the carrier chain is no trust input: the verdict is a function of the SPKI, and the same SPKI from the self-signed carrier gives the same verdict
    const viaCarrier = await verifyEvidence(d, { policy: { snp: { allowedMeasurements: [M2], minTcb } }, context: { transportKeySpki: kAddr, nonce: n, expectedBinding: bind2(n, kAddr), expectedAppId: Buffer.from(OWNER_APP_ID, "hex"), expectedHostData: DEP, now: NOW2 }, collateral: col() });
    assert.deepEqual(viaCarrier.checks, v.checks);
    assert.match(text(new URL(`client-${x}.txt`, W)), /attested/i, `${x}: the owner's trusted-mode run attested`);
  }
  assert.match(text(new URL("negative-install.txt", W)), /422/, "another key or name is refused at issuance (422)");
});

test("the browser build gives the same verdict on the capture and on a forgery", { skip }, async () => {
  const norm = (v) => JSON.parse(JSON.stringify(v));
  const inputs = (context = {}) => ({ policy: { snp: { allowedMeasurements: [OWNER_MEASUREMENT], minTcb } }, context: { transportKeySpki: spki, nonce, expectedBinding: bind2(), expectedAppId: Buffer.from(OWNER_APP_ID, "hex"), now: NOW, ...context }, collateral: col() });
  assert.deepEqual(norm(await verifyEvidenceWeb(doc, inputs())), norm(await verifyEvidence(doc, inputs())));
  const other = Buffer.from(nonce); other[0] ^= 1;
  const w = await verifyEvidenceWeb(doc, inputs({ nonce: other, expectedBinding: bind2(other) })), n = await verifyEvidence(doc, inputs({ nonce: other, expectedBinding: bind2(other) }));
  assert.equal(w.status, "rejected"); assert.deepEqual(norm(w), norm(n));
});
