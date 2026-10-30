import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { derive, DERIVATIONS, DERIVATION_V6, DERIVATION_V7 } from "./derive.mjs";
import { deriveDesktop, DESKTOP_DERIVATION } from "./desktop-derive.mjs";

const vectors = JSON.parse(fs.readFileSync(new URL("../../../isolation/contract/catalog/desktop_vectors.json", import.meta.url)));
const component = Buffer.from(vectors.component_hex, "hex");

test("desktop bundles and complete mappings match the independent Python reference", () => {
  assert.ok(vectors.ok.length >= 7);
  for (const c of vectors.ok) {
    const { bundle, ...got } = deriveDesktop({ record: c.record, component });
    assert.deepEqual(got, c.mapping, c.name);
    assert.equal(bundle.toString("hex"), c.bundle_hex, c.name);
  }
});

test("every independent rejection is enforced", () => {
  assert.ok(vectors.refused.length >= 25);
  for (const c of vectors.refused) {
    assert.throws(() => deriveDesktop({ record: c.record, component: Buffer.from(c.component_hex, "hex") }), c.name);
  }
});

test("unimplemented desktop runtime is not advertised or silently downgraded", () => {
  assert.ok(!DERIVATIONS.includes(DESKTOP_DERIVATION));
  const record = vectors.ok[0].record;
  assert.throws(() => derive({ record, component }));
  for (const derivation of DERIVATIONS) {
    assert.throws(() => derive({ record: { ...record, derivation }, component }), /desktop requires/);
  }
  // Existing secret profiles keep their CPU restriction; V8 adds a separate
  // masked companion contract rather than quietly widening V6 or V7.
  for (const derivation of [DERIVATION_V6, DERIVATION_V7]) {
    const { desktop, configBase64, ...legacy } = record;
    assert.throws(() => derive({ record: { ...legacy, derivation, config: "{}",
      inference: { model: "qwen2.5-0.5b-q8-gguf", gpuMilli: 500 } }, component }), /CPU HTTP/);
  }
});

test("mapping is not aliased to mutable caller inputs", () => {
  const record = structuredClone(vectors.ok[0].record);
  const result = deriveDesktop({ record, component });
  record.desktop.gpuMilli = 1000; record.policy.memMiB = 65536; record.ports[0] = "tcp:22";
  assert.deepEqual(result.record, vectors.ok[0].record);
});
