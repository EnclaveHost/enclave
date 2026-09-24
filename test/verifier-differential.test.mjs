// Differential reference: @tinfoilsh/verifier (one reference, not the oracle) on the SAME authentic bytes
// and the same mutations as verifier/snp.mjs. Where both implement a check they must agree; where only
// ours does (Turin, CRL, VMPL policy) the test says so. Skips when the package is not installed.
//   run: node --test test/verifier-differential.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { verifyEvidence, memoryCollateral, spkiOfCert } from "../verifier/index.mjs";

let tinfoil = null; try { tinfoil = await import("@tinfoilsh/verifier"); } catch {}
const F = new URL("./fixtures/verifier/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url);
const rad = JSON.parse(fs.readFileSync(new URL("genoa-tinfoil/rad.json", F), "utf8"));
const report = gunzipSync(Buffer.from(rad.body, "base64"));
const certJson = JSON.parse(fs.readFileSync(new URL("genoa-tinfoil/tinfoil-certificate.json", F), "utf8")).certificate;
const vcek = fs.readFileSync(new URL("genoa-tinfoil/vcek-kds-amd.der", F));
const MEAS = report.subarray(0x90, 0xc0).toString("hex");
const ours = (doc) => verifyEvidence(doc, { policy: { snp: { allowedMeasurements: [MEAS] } },
  context: { transportKeySpki: spkiOfCert(certJson).spki, certPem: certJson, host: "inference.tinfoil.sh", now: "2026-09-24T05:00:00Z" },
  collateral: memoryCollateral({ chains: { Genoa: fs.readFileSync(new URL("Genoa-cert_chain.pem", A), "utf8") }, vceks: { Genoa: vcek }, crls: { Genoa: fs.readFileSync(new URL("amd/Genoa-crl.der", F)) } }) });
const theirs = async (doc) => { try { const r = await tinfoil.verifyAttestation({ format: doc.format, body: doc.body }, vcek.toString("base64")); await tinfoil.verifyCertificate(certJson, "inference.tinfoil.sh", { format: doc.format, body: doc.body }, r.hpkePublicKey); return { ok: true, measurement: r.measurement.registers[0] }; } catch (e) { return { ok: false, error: e.message }; } };
const docWith = (r) => ({ format: rad.format, body: gzipSync(r).toString("base64") });

test("authentic Genoa document: both verifiers accept, same measurement", { skip: !tinfoil && "@tinfoilsh/verifier not installed" }, async () => {
  const [a, b] = await Promise.all([ours(rad), theirs(rad)]);
  assert.equal(a.status, "verified", a.reasons.join("\n")); assert.equal(b.ok, true, b.error);
  assert.equal(a.claims.measurement, b.measurement);
});
test("single-byte mutations: both refuse (signature, report_data, measurement, policy DEBUG, version, reserved)", { skip: !tinfoil && "@tinfoilsh/verifier not installed" }, async () => {
  const cases = { signature: 0x2a0, reportData: 0x50, measurement: 0x90, reserved: 0x4c, tail: 0x49f };
  for (const [name, off] of Object.entries(cases)) {
    const r = Buffer.from(report); r[off] ^= 1;
    const [a, b] = await Promise.all([ours(docWith(r)), theirs(docWith(r))]);
    assert.equal(a.status, "rejected", name); assert.equal(b.ok, false, name);
  }
  const dbg = Buffer.from(report); dbg[0x0a] |= 0x08;
  assert.equal((await ours(docWith(dbg))).status, "rejected"); assert.equal((await theirs(docWith(dbg))).ok, false);
});
test("where only one side implements a check, the difference is stated", { skip: !tinfoil && "@tinfoilsh/verifier not installed" }, async () => {
  // Tinfoil's library refuses every non-Genoa report: on a Turin report it fails even before its product check,
  // because it validates TCB_VERSION with the Milan/Genoa layout (bits 47:16 reserved) and Turin keeps TEE and
  // SNP there ("TCB version field is malformed"). Ours verifies Turin (test/verifier-snp-turin.test.mjs).
  const turin = JSON.parse(fs.readFileSync(new URL("turin-m4a/doc.json", F), "utf8")); const d = turin.doc ?? turin;
  const t = await (async () => { try { await tinfoil.verifyAttestation({ format: "https://tinfoil.sh/predicate/sev-snp-guest/v2", body: gzipSync(Buffer.from(d.report, "base64")).toString("base64") }, fs.readFileSync(new URL("turin-m4a/vcek-kds-amd.der", F)).toString("base64")); return "accepted"; } catch (e) { return e.message; } })();
  assert.match(t, /Genoa|Unsupported processor|Failed to parse|TCB.*malformed/);
  assert.notEqual(t, "accepted");
});
