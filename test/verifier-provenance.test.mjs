// Release provenance against OUR policy, on the AUTHENTIC v0.5.841 and v0.5.841-cpu bundles with the Sigstore
// trusted root taken from Sigstore's TUF repository. Then each policy field and each bundle field is mutated
// on its own. Proves: a green release requires this repository, this workflow file, a tag of our pattern,
// GitHub's issuer, an accepted predicate, the exact subject digest, and a version at or above the floor.
//   run: node --test test/verifier-provenance.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyReleaseAttestation, DEFAULT_RELEASE_POLICY } from "../verifier/index.mjs";

const F = new URL("./fixtures/verifier/", import.meta.url);
const root = JSON.parse(fs.readFileSync(new URL("sigstore/trusted_root.json", F), "utf8"));
const load = (tag) => ({ bundle: JSON.parse(fs.readFileSync(new URL(`release/${tag}.attestation.json`, F), "utf8")).attestations[0].bundle, digest: fs.readFileSync(new URL(`release/${tag}.tinfoil.hash`, F), "utf8").trim() });
const gpu = load("v0.5.841"), cpu = load("v0.5.841-cpu");
const clone = (b) => JSON.parse(JSON.stringify(b));
const run = ({ bundle, digest } = gpu, policy = {}, trustedRoot = root) => verifyReleaseAttestation({ bundle, digestHex: digest, trustedRoot, policy });
const refused = async (args, re) => { const r = await run(...args); assert.equal(r.ok, false, r.reasons.join("\n")); assert.match(r.reasons.at(-1), re); };

test("both flavors verify and yield the signed measurement and the workflow identity", async () => {
  for (const [b, flavor] of [[gpu, "gpu"], [cpu, "cpu"]]) {
    const r = await run(b);
    assert.equal(r.ok, true, r.reasons.join("\n"));
    assert.equal(r.claims.flavor, flavor); assert.equal(r.claims.repository, "EnclaveHost/enclave");
    assert.equal(r.claims.workflow, `https://github.com/EnclaveHost/enclave/.github/workflows/tinfoil-release-publish.yml@${r.claims.ref}`);
    assert.match(r.claims.snpMeasurement, /^[0-9a-f]{96}$/); assert.ok(r.claims.integratedTime); assert.equal(r.claims.trigger, "workflow_dispatch");
  }
  const a = await run(gpu), b = await run(cpu); assert.notEqual(a.claims.snpMeasurement, b.claims.snpMeasurement, "the two flavors measure differently");
});
test("repo policy: a bundle for our repo does not satisfy a policy naming another, and vice versa", async () => {
  await refused([gpu, { repository: "EnclaveHost/other" }], /Sigstore verification failed/);
  await refused([gpu, { repository: "enclavehost/enclave" }], /Sigstore verification failed/);   // Sigstore compares verbatim
});
test("workflow policy: the signing workflow file is part of the identity", async () => {
  await refused([gpu, { workflowPath: ".github/workflows/deploy.yml" }], /Sigstore verification failed: workflow path/);
});
test("ref policy: tags only, and only our pattern", async () => {
  await refused([gpu, { refPattern: "^refs/tags/v\\d+\\.\\d+\\.\\d+-gpu8$" }], /tag ref/);
  await refused([gpu, { refPattern: "^refs/heads/main$" }], /tag ref/);
});
test("issuer, trigger and visibility policies", async () => {
  await refused([gpu, { issuer: "https://accounts.google.com" }], /Sigstore verification failed/);
  await refused([gpu, { allowedTriggers: ["push"] }], /trigger/);
  await refused([gpu, { requireVisibility: "private" }], /visibility/);
});
test("subject digest: the release digest must be the statement's subject", async () => {
  await refused([{ bundle: gpu.bundle, digest: cpu.digest }], /not the release digest/);
  await refused([{ bundle: gpu.bundle, digest: "zz" }], /64 hex/);
});
test("predicate policy and rollback floor", async () => {
  await refused([gpu, { predicateTypes: ["https://slsa.dev/provenance/v1"] }], /predicate type/);
  await refused([gpu, { minimumRelease: [0, 5, 842] }], /below the minimum release/);
  await refused([gpu, { minimumRelease: [1, 0, 0] }], /below the minimum release/);
  assert.equal((await run(gpu, { minimumRelease: [0, 5, 841] })).ok, true);
});
test("bundle tampering: payload, signature, certificate, log entry, legacy form, media type", async () => {
  const p = clone(gpu.bundle); p.dsseEnvelope.payload = Buffer.from(Buffer.from(p.dsseEnvelope.payload, "base64").toString("utf8").replace("snp_measurement", "snp_measuremenT")).toString("base64");
  await refused([{ bundle: p, digest: gpu.digest }], /Sigstore verification failed/);
  const s = clone(gpu.bundle); const sig = Buffer.from(s.dsseEnvelope.signatures[0].sig, "base64"); sig[10] ^= 1; s.dsseEnvelope.signatures[0].sig = sig.toString("base64");
  await refused([{ bundle: s, digest: gpu.digest }], /Sigstore verification failed/);
  const c = clone(gpu.bundle); c.verificationMaterial.certificate = clone(cpu.bundle.verificationMaterial.certificate);   // the -cpu signing cert on the gpu envelope
  await refused([{ bundle: c, digest: gpu.digest }], /Sigstore verification failed/);
  const t = clone(gpu.bundle); t.verificationMaterial.tlogEntries = [];
  await refused([{ bundle: t, digest: gpu.digest }], /no transparency-log entry/);
  const l = clone(gpu.bundle); l.verificationMaterial.x509CertificateChain = { certificates: [l.verificationMaterial.certificate] };
  await refused([{ bundle: l, digest: gpu.digest }], /legacy form/);
  const m = clone(gpu.bundle); m.mediaType = "application/vnd.dev.sigstore.bundle+json;version=0.2";
  await refused([{ bundle: m, digest: gpu.digest }], /not v0\.3/);
  const two = clone(gpu.bundle); two.dsseEnvelope.signatures.push(two.dsseEnvelope.signatures[0]);
  await refused([{ bundle: two, digest: gpu.digest }], /exactly one signature/);
});
test("trusted root: a root without Sigstore's Fulcio CA, or none at all, verifies nothing", async () => {
  const noCa = clone(root); noCa.certificateAuthorities = [];
  await refused([gpu, {}, noCa], /Sigstore verification failed|trusted root/);
  const otherCa = clone(root); otherCa.certificateAuthorities = [otherCa.certificateAuthorities[0]];   // only the 2021 CA (expired 2022)
  await refused([gpu, {}, otherCa], /Sigstore verification failed/);
  await refused([gpu, {}, null], /no Sigstore trusted root/);
  const noLogs = clone(root); noLogs.tlogs = [];
  await refused([gpu, {}, noLogs], /Sigstore verification failed/);
});
test("the default policy is the one the plan states", () => {
  assert.equal(DEFAULT_RELEASE_POLICY.repository, "EnclaveHost/enclave");
  assert.equal(DEFAULT_RELEASE_POLICY.workflowPath, ".github/workflows/tinfoil-release-publish.yml");
  assert.deepEqual(DEFAULT_RELEASE_POLICY.predicateTypes, ["https://tinfoil.sh/predicate/snp-tdx-multiplatform/v1"]);
});
