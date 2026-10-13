// The Node consumer bundle (verifier/node/build.mjs -> verifier/dist/enclave-verifier-node.mjs, vendored for the relay at
// relay/vendor/): it must reproduce byte for byte from this tree, give the same verdict as the source modules on the same
// bytes, keep @tinfoilsh/verifier external (the reference is a run-time import that reports installed:false where absent),
// and carry the pinned Sigstore root inside. The strict integration command runs the reproduction before any suite.
//   run: node --test test/verifier-node-bundle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { reproduceNode } from "../verifier/node/reproduce.mjs";
import { DIST, VENDOR, ARTIFACT, MANIFEST, OPTIONS } from "../verifier/node/build.mjs";
import { memoryCollateral } from "../verifier/collateral.mjs";
import { spkiOfCert } from "../verifier/tls-binding.mjs";
import { verifyHostedCapture as sourceVerify, releaseExpectationsFrom as sourceExpectations, reportOf } from "../verifier/consumer.mjs";

const REPO = new URL("..", import.meta.url).pathname, F = path.join(REPO, "test", "fixtures", "verifier");
const rd = (...p) => fs.readFileSync(path.join(F, ...p));
const CHAIN = path.join(REPO, "test", "fixtures", "amd", "Genoa-cert_chain.pem");   // AMD KDS cert_chain, the same file every other suite uses
const NOW = "2026-09-24T05:00:00Z";
const genoa = () => { const rad = JSON.parse(rd("genoa-tinfoil", "rad.json").toString()); const certPem = rd("genoa-tinfoil", "tls-cert.pem").toString(); return { host: "inference.tinfoil.sh", rad, certPem, spki: spkiOfCert(certPem).spki }; };
const collateral = () => memoryCollateral({ chains: { Genoa: fs.readFileSync(CHAIN, "utf8") }, vceks: { Genoa: rd("genoa-tinfoil", "vcek-kds-amd.der") }, crls: { Genoa: rd("amd", "Genoa-crl.der") } });
const candidate = (tag) => { const j = JSON.parse(rd("release", `${tag}.attestation.json`).toString()); return { tag, digest: rd("release", `${tag}.tinfoil.hash`).toString().trim(), bundle: j.attestations ? j.attestations[0]?.bundle : j }; };
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("the committed bundle reproduces from this tree, byte for byte, with its manifest, notices and the relay's vendored copy", async () => {
  const r = await reproduceNode();
  assert.equal(r.ok, true, r.problems.join("; ")); assert.ok(r.inputs > 10, `${r.inputs} inputs`);
});
test("the bundle gives the same verdict as the source modules on the Genoa capture under our releases' policy (rejected on the measurement alone), and verifies under a policy naming its measurement", async () => {
  const m = await import(pathToFileURL(path.join(DIST, ARTIFACT)).href);
  for (const name of ["releaseExpectationsFrom", "verifyHostedCapture", "captureHosted", "referenceVerify", "compareVerdicts", "verifyHost", "releaseExpectations", "reportOf"]) assert.equal(typeof m[name], "function", name);
  const cands = [candidate("v0.5.841"), candidate("v0.5.841-cpu")];
  const [eb, es] = await Promise.all([m.releaseExpectationsFrom(cands), sourceExpectations(cands)]);
  assert.deepEqual(eb.allowed, es.allowed);
  const cap = genoa();
  const [vb, vs] = await Promise.all([m.verifyHostedCapture(cap, { allowed: eb.allowed, collateral: collateral(), now: NOW }), sourceVerify(cap, { allowed: es.allowed, collateral: collateral(), now: NOW })]);
  assert.equal(vb.status, "rejected"); assert.deepEqual(vb.failedChecks, ["measurement"]); assert.deepEqual({ status: vb.status, checks: vb.checks, omissions: vb.omissions, measurement: vb.measurement }, { status: vs.status, checks: vs.checks, omissions: vs.omissions, measurement: vs.measurement });
  const ok = await m.verifyHostedCapture(cap, { allowed: [{ tag: "capture", measurement: m.reportOf(cap.rad).measurement }], minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, collateral: collateral(), now: NOW });
  assert.equal(ok.status, "verified", ok.reasons.join(" | "));
  assert.equal(m.TRUSTED_ROOT.certificateAuthorities?.length > 0, true, "the pinned Sigstore root is inside the bundle");
});
test("@tinfoilsh/verifier is external to the bundle: no static import of it, and a reference leg whose loader fails reports installed:false (never a pass)", async () => {
  const text = fs.readFileSync(path.join(DIST, ARTIFACT), "utf8");
  assert.equal(/^import .* from "@tinfoilsh\/verifier"/m.test(text), false, "no static import");
  assert.match(text, /import\("@tinfoilsh\/verifier"\)/, "the run-time import is kept verbatim");
  assert.deepEqual(OPTIONS.external, ["@tinfoilsh/verifier"]);
  const m = await import(pathToFileURL(path.join(DIST, ARTIFACT)).href);
  const r = await m.referenceVerify(genoa(), { collateral: collateral(), load: async () => { throw new Error("absent on this host"); } });
  assert.equal(r.installed, false); assert.equal(m.compareVerdicts({ ours: { status: "verified", checks: {}, claims: {} }, reference: r, allowed: [] }).agreement, "reference-missing");
});
test("the manifest names this tree's inputs (the consumer, the SNP verifier, the relay's report parser, the pinned root) with hashes that match the files now", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, MANIFEST), "utf8"));
  for (const p of ["verifier/consumer.mjs", "verifier/snp.mjs", "verifier/provenance.mjs", "relay/snp-verify.mjs", "verifier/roots/sigstore-trusted-root.json"]) {
    const i = manifest.inputs.find((x) => x.path === p); assert.ok(i, `${p} is an input`); assert.equal(i.sha256, sha(fs.readFileSync(path.join(REPO, p))), `${p} unchanged since the build`);
  }
  assert.equal(manifest.inputs.some((x) => /@tinfoilsh/.test(x.path)), false, "the Tinfoil library is not bundled");
  assert.equal(sha(fs.readFileSync(path.join(VENDOR, ARTIFACT))), manifest.artifact.sha256, "the relay's copy is the artifact");
});
