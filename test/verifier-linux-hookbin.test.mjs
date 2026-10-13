// test/verifier-linux-hookbin.test.mjs: the Linux per-app SNP tier's first enclave-catalog-bundle/2 deployment (hookbin 0.1.4,
// a wasi:cli command serving HTTP on 8000 in its own guest, deployment 0x0ddbd824...), judged OFFLINE from the verifier
// session's own public-side capture (test/fixtures/verifier/linux-hookbin-2026-09-24: prod-doc.json and served-cert.pem taken by
// verifier/live-domain-check.mjs --save after the owner's 8ed6231f node restart) through the domain path with the owner's
// PINNED contract (ENCLAVE_DOMAIN_CONTRACT: RuntimeID, Bind2, derive_reference.py), never restated. Proves: the served leaf
// carries the bound key; the AppID the report names is DERIVED here from the component bytes (by CID, CID-checked) and the
// chain's v2 record, and the same record read as v1 is another AppID the report refuses; HOST_DATA is the deployment; the
// measurement is accepted as the OWNER'S word (their pinned-release reconstruction; the release bytes are not published) and
// the suite says so; the forgeries are refused by name; the browser build agrees.
//   run: node --test test/verifier-linux-hookbin.test.mjs   (strict: ENCLAVE_DOMAIN_CONTRACT must point at the pinned contract)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { verifyEvidence, memoryCollateral, spkiOfCert } from "../verifier/index.mjs";
import { verifyEvidenceWeb } from "../verifier/web/index.mjs";

const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
const H = new URL("./fixtures/verifier/linux-hookbin-2026-09-24/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url), V = new URL("./fixtures/verifier/amd/", import.meta.url);
const read = (u) => fs.readFileSync(u), text = (u) => fs.readFileSync(u, "utf8"), json = (u) => JSON.parse(text(u));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const contractPath = process.env.ENCLAVE_DOMAIN_CONTRACT || (fs.existsSync(new URL("../isolation/contract/runtime.mjs", import.meta.url)) ? new URL("../isolation/contract/runtime.mjs", import.meta.url).pathname : null);
if (STRICT && !process.env.ENCLAVE_DOMAIN_CONTRACT) throw new Error("strict integration: ENCLAVE_DOMAIN_CONTRACT (the pinned isolation/contract/runtime.mjs) is not set");
const skip = !contractPath && "the isolation owner's runtime contract is not pinned here (ENCLAVE_DOMAIN_CONTRACT) and not in this tree";
const C = contractPath ? await import(pathToFileURL(contractPath).href) : null;
const REF = contractPath && path.join(path.dirname(contractPath), "catalog", "derive_reference.py");
const asBuf = (x) => (Buffer.isBuffer(x) ? x : typeof x === "string" ? Buffer.from(x, "hex") : Buffer.from(x));

const saved = json(new URL("prod-doc.json", H)), doc = saved.doc, report = Buffer.from(doc.report, "base64"), nonce = Buffer.from(saved.nonce, "hex");
const certPem = text(new URL("served-cert.pem", H)), { spki, cert } = spkiOfCert(certPem);
const identity = json(new URL("expected-runtime.json", H)), minTcb = json(new URL("min-tcb.json", H)), record = json(new URL("record.json", H)), sources = json(new URL("SOURCES.json", H));
const component = read(new URL("component.wasm", H));
const DEP = "0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76", DEP_E = "395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595";
const CANARY_MEASUREMENT = "c068f423578cda6316fd9462db6b5e9047bd34d6e2c0ae3b0819828e8db78831bd76bdb27092efefe380713662815f9e";
// the owner's stated values (owner-expected-measurement.txt): the measurement is THEIR word; the AppID is derived below and only compared
const ownerTxt = text(new URL("owner-expected-measurement.txt", H)), field = (k) => (new RegExp(`^${k}\\s+(\\S+)$`, "m").exec(ownerTxt) || [])[1];
const OWNER_MEASUREMENT = field("measurement"), OWNER_APP_ID = field("app_id");
assert.match(OWNER_MEASUREMENT || "", /^[0-9a-f]{96}$/); assert.match(OWNER_APP_ID || "", /^[0-9a-f]{64}$/);
const NOW = saved.at;   // the capture's own time (after the served leaf's notBefore, before the CRL's nextUpdate)
const col = () => memoryCollateral({ chains: { Turin: text(new URL("Turin-cert_chain.pem", A)), Genoa: text(new URL("Genoa-cert_chain.pem", A)) }, vceks: { Turin: read(new URL("vcek.der", H)) }, crls: { Turin: read(new URL("Turin-crl.der", V)) } });
const rid = () => asBuf(C.runtimeId(identity)), bind2 = (n = nonce, k = spki) => asBuf(C.bind2(k, n, rid()));
// the AppID, derived by the owner's pinned reference from the component bytes and a record (the fixture's v2 record by default)
function derive(rec = record) {
  const scratch = new URL("../.verifier-integration/", import.meta.url).pathname;   // gitignored: absent on a fresh checkout (CI)
  fs.mkdirSync(scratch, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(scratch, "hookbin-derive-"));
  try {
    const r = path.join(tmp, "record.json"), c = path.join(tmp, "component.wasm"), o = path.join(tmp, "out.bundle");
    fs.writeFileSync(r, JSON.stringify(rec)); fs.writeFileSync(c, component);
    const m = JSON.parse(execFileSync("python3", [REF, "bundle", r, c, o], { encoding: "utf8" }));
    assert.equal(m.appId, sha(fs.readFileSync(o)), "the reference's appId is sha256(bundle)");
    return m;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
const APP_ID = skip ? null : derive().appId;
const inputs = ({ policy = {}, context = {} } = {}) => ({ policy: { snp: { allowedMeasurements: [OWNER_MEASUREMENT], minTcb, ...policy } }, context: { transportKeySpki: spki, nonce, expectedBinding: bind2(), expectedAppId: Buffer.from(APP_ID, "hex"), expectedHostData: Buffer.from(DEP, "hex"), now: NOW, ...context }, collateral: col() });
const run = (d = doc, over = {}) => verifyEvidence(d, inputs(over));
const rejectedAt = (v, check, re) => { assert.equal(v.status, "rejected", v.reasons.join("\n")); assert.equal(v.checks[check], false, v.reasons.at(-1)); if (re) assert.match(v.reasons.at(-1), re); };

test("the served leaf (ZeroSSL, for the guest's own name) carries the key the document binds; the document has exactly the stated keys; the runtime identity is the chain record's", { skip }, () => {
  assert.ok(spki.equals(Buffer.from(doc.transportKey, "base64")), "doc.transportKey is the served SPKI");
  assert.equal(sha(Buffer.from(certPem.replace(/-----[^-]+-----|\s/g, ""), "base64")), saved.servedCertSha256, "served-cert.pem is the leaf of the captured handshake");
  assert.match(cert.subject, /CN=0ddbd824\.app\.enclave\.host/); assert.match(cert.issuer, /ZeroSSL/);
  assert.equal(String(cert.serialNumber || cert.serial || "").toLowerCase(), "3636639abf417f4b384a95a6468d5d3f", "the serial the owner's node logged as 'already serves a valid certificate' after 8ed6231f");
  assert.equal(doc.nonce, saved.nonce); assert.equal(doc.abi, "enclave-domain-abi/2"); assert.equal(doc.format, "sev-snp-guest-domain-v1");
  assert.deepEqual(Object.keys(doc).sort(), ["abi", "appSha256", "format", "nonce", "report", "runtime", "runtimeSelfTest", "tier", "transportKey"]);
  assert.equal(C.validateRuntimeIdentity(identity), null); assert.deepEqual(doc.runtime, identity);
  assert.equal(rid().toString("hex"), record.runtimeId, "RuntimeID from the pinned contract equals the derivation record's");
  assert.equal(record.derivation, "enclave-catalog-bundle/2"); assert.equal(record.http, 8000);
  assert.ok(report.subarray(0xc0, 0xe0).equals(Buffer.from(DEP, "hex")), "HOST_DATA is the deployment id");
});

test("the AppID is derived here from the component bytes (CID-checked) and the v2 record; the same record as v1 is another AppID; the document's claim and the owner's statement equal the derivation", { skip }, () => {
  assert.equal(sha(component), sources.component.sha256); assert.equal(component.length, sources.component.bytes);
  const m = derive();
  assert.equal(m.appId, OWNER_APP_ID, "the owner's stated AppID is the derivation's"); assert.equal(doc.appSha256, m.appId, "the document's own claim (report_data decides below)");
  assert.equal(m.record.http, 8000); assert.equal(m.record.derivation, "enclave-catalog-bundle/2");
  const { http, ...v1 } = { ...record, derivation: "enclave-catalog-bundle/1" };
  const asV1 = derive(v1);
  assert.notEqual(asV1.appId, m.appId, "the port is in the identity"); assert.equal(asV1.appId, "9add8960b2cf2a2480df3b93eb2733cda1dbe493e06092594b1437b9951dcb5c", "the value the live negative saw");
});

test("the capture verifies through the domain path: the derived AppID in report_data, HOST_DATA = the deployment, Bind2 over the served key, the TCB floor, the measurement as the owner's word", { skip }, async () => {
  const v = await run();
  assert.equal(v.status, "verified", v.reasons.join("\n")); assert.equal(v.admissionSafe, true); assert.deepEqual(v.omissions, []);
  assert.equal(v.claims.product, "Turin"); assert.equal(v.claims.reportVersion, 5); assert.equal(v.claims.vmpl, 0); assert.equal(v.claims.abi, "enclave-domain-abi/2");
  assert.equal(v.claims.appId, APP_ID); assert.equal(v.claims.reportData.slice(64), APP_ID, "report_data[32:64] IS the derived AppID");
  assert.equal(v.claims.reportData.slice(0, 64), bind2().toString("hex"), "report_data[0:32] IS Bind2 over the served key, the nonce and the runtime identity");
  assert.equal(v.claims.hostData, DEP); assert.equal(v.checks["host data"], true);
  assert.equal(v.claims.measurement, OWNER_MEASUREMENT, "accepted as the caller's explicit expectation: the owner's word, not reproduced here");
  assert.deepEqual(v.claims.tcb.reported, minTcb.Turin, "the reported TCB is exactly the floor"); assert.equal(v.checks.crl, true);
  assert.notEqual(v.claims.measurement, CANARY_MEASUREMENT, "a new initrd (dominit run mode): a new measurement");
  // the owner's trusted-mode run on the public route attested the same measurement and AppID
  const client = text(new URL("owner-client-public.txt", H));
  assert.match(client, /attested/i); assert.ok(client.includes(OWNER_MEASUREMENT.slice(0, 16)) && client.includes(APP_ID.slice(0, 16)), "the owner's client run names the same measurement and AppID");
});

test("forgeries and misroutes: the v1 AppID, another deployment's HOST_DATA, the canary's measurement, another nonce, ABI/1 in place of ABI/2", { skip }, async () => {
  rejectedAt(await run(doc, { context: { expectedAppId: Buffer.from("9add8960b2cf2a2480df3b93eb2733cda1dbe493e06092594b1437b9951dcb5c", "hex") } }), "app id", /names app d2c4dfc0ec475910/);
  rejectedAt(await run(doc, { context: { expectedHostData: Buffer.from(DEP_E, "hex") } }), "host data", /names 0ddbd82423a22883\.\.\., not the expected deployment 395bed3e2e24efa0/);
  rejectedAt(await run(doc, { policy: { allowedMeasurements: [CANARY_MEASUREMENT] } }), "measurement", /not an allowed measurement/);
  const other = Buffer.from(nonce); other[0] ^= 1;
  rejectedAt(await run(doc, { context: { nonce: other, expectedBinding: bind2(other) } }), "binding");
  rejectedAt(await run({ ...doc, abi: "enclave-domain-abi/1" }), "binding");
  rejectedAt(await run(doc, { context: { expectedHostData: Buffer.alloc(32) } }), "host data", /all zero|expectedHostData|not the expected/);
});

test("the browser build gives the same verdict on the capture and on the v1-AppID forgery", { skip }, async () => {
  const norm = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(norm(await verifyEvidenceWeb(doc, inputs())), norm(await run()));
  const forged = { context: { expectedAppId: Buffer.from("9add8960b2cf2a2480df3b93eb2733cda1dbe493e06092594b1437b9951dcb5c", "hex") } };
  const w = await verifyEvidenceWeb(doc, inputs(forged)), n = await run(doc, forged);
  assert.equal(w.status, "rejected"); assert.deepEqual(norm(w), norm(n));
});
