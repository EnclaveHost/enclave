// The Node consumer bundle (verifier/node/build.mjs -> verifier/dist/enclave-verifier-node.mjs, vendored for the relay at
// relay/vendor/): it must reproduce byte for byte from this tree, carry exactly the consumer's live entry points, and give the
// same verdict as the source modules on the same bytes. The strict integration command runs the reproduction before any suite.
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
import * as source from "../verifier/consumer.mjs";
import { MEAS, doc, context, chains, vcekAmd, crl, FLOOR } from "./helpers/genoa-capture.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const NOW = "2026-09-24T05:00:00Z";
const collateral = () => memoryCollateral({ chains, vceks: { Genoa: vcekAmd }, crls: { Genoa: crl } });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const policy = { snp: { allowedMeasurements: [MEAS], minTcb: FLOOR } };

test("the committed bundle reproduces from this tree, byte for byte, with its manifest, notices and the relay's vendored copy", async () => {
  const r = await reproduceNode();
  assert.equal(r.ok, true, r.problems.join("; ")); assert.ok(r.inputs >= 8, `${r.inputs} inputs`);
});
test("the bundle exports the consumer's live entry points and gives the source's verdict on the same bytes", async () => {
  const m = await import(pathToFileURL(path.join(DIST, ARTIFACT)).href);
  for (const name of ["verifyGuestDomainEvidence", "prewarmSnpCollateral", "verifyMetalBox", "httpCollateral", "fileCollateral", "memoryCollateral", "layeredCollateral", "cachedCollateral"]) assert.equal(typeof m[name], "function", name);
  assert.deepEqual(Object.keys(m).sort(), Object.keys(source).sort(), "the bundle's exports are the source module's");
  const [vb, vs] = await Promise.all([m.verifyGuestDomainEvidence(doc, { policy, context: context({ now: NOW }), collateral: collateral() }), source.verifyGuestDomainEvidence(doc, { policy, context: context({ now: NOW }), collateral: collateral() })]);
  assert.equal(vb.status, "verified", vb.reasons.join(" | ")); assert.deepEqual(vb, vs);
  const metal = { format: "sev-snp-guest-metal-v1", body: doc.report };
  assert.equal((await m.verifyGuestDomainEvidence(metal, { policy, context: context({ now: NOW }), collateral: collateral() })).status, "unsupported", "a release document is the domain format only");
  assert.equal((await m.verifyGuestDomainEvidence({ format: "https://Cloud Provider.sh/predicate/sev-snp-guest/v2", body: doc.report })).status, "unsupported");
  assert.deepEqual(await m.prewarmSnpCollateral(doc, collateral()), { ok: true, product: "Genoa" });
  assert.deepEqual(await m.prewarmSnpCollateral(doc, memoryCollateral({ chains })), { ok: false, product: "Genoa", missing: ["vcek", "crl"] });
});
test("nothing is external, and no third-party verifier is bundled", () => {
  assert.deepEqual(OPTIONS.external, []);
  const text = fs.readFileSync(path.join(DIST, ARTIFACT), "utf8");
  assert.equal(/Cloud Provider/i.test(text), false, "no Cloud Provider code or name in the bundle");
  assert.equal(/^import .* from "(?!node:)/m.test(text), false, "only node: built-ins are imported");
});
test("the manifest names this tree's inputs (the consumer, the SNP verifier, the metal-box rules, the relay's report parser) with hashes that match the files now", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, MANIFEST), "utf8"));
  for (const p of ["verifier/consumer.mjs", "verifier/snp.mjs", "verifier/metal-box.mjs", "verifier/envelope.mjs", "relay/snp-verify.mjs"]) {
    const i = manifest.inputs.find((x) => x.path === p); assert.ok(i, `${p} is an input`); assert.equal(i.sha256, sha(fs.readFileSync(path.join(REPO, p))), `${p} unchanged since the build`);
  }
  assert.equal(sha(fs.readFileSync(path.join(VENDOR, ARTIFACT))), manifest.artifact.sha256, "the relay's copy is the artifact");
});
