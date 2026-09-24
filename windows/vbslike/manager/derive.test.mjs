// The shared vectors are the arbiter. A third implementation of enclave-catalog-bundle/1 is only
// allowed to exist if the file that refuses the other two can refuse it too.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derive } from "./derive.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.join(HERE, "../../../isolation/contract/catalog/derive_vectors.json");
const v = JSON.parse(fs.readFileSync(VECTORS, "utf8"));
const component = Buffer.from(v.component_hex, "hex");

test("every ok vector derives the same AppID, record hash and bundle size - /1 AND /2", () => {
  assert.ok(v.ok.length, "vectors carry accepted cases");
  for (const c of v.ok) {
    const got = derive({ record: c.mapping.record, component });
    assert.equal(got.appId, c.mapping.appId, `${c.name}: appId`);
    assert.equal(got.appId, c.bundleSha256, `${c.name}: AppID is sha256 of the whole bundle`);
    assert.equal(got.recordSha256, c.mapping.recordSha256, `${c.name}: recordSha256`);
    assert.equal(got.bundleBytes, c.mapping.bundleBytes, `${c.name}: bundleBytes`);
    assert.equal(got.componentSha256, c.mapping.componentSha256, `${c.name}: componentSha256`);
    assert.equal(got.componentBytes, c.mapping.componentBytes, `${c.name}: componentBytes`);
  }
});

test("every refused vector is refused here too", () => {
  for (const c of v.refused || []) {
    assert.throws(() => derive({ record: c.record ?? c.mapping?.record, component:
      c.component_hex ? Buffer.from(c.component_hex, "hex") : component }), `${c.name}: must be refused`);
  }
});

test("the two rules are not interchangeable", async () => {
  const { derive, DERIVATION, DERIVATION_V2 } = await import("./derive.mjs");
  const v2 = v.ok.find((c) => c.mapping.record.derivation === DERIVATION_V2);
  assert.ok(v2, "the shared vectors carry /2");
  const rec = v2.mapping.record;
  // the same component and policy under /1 gives a DIFFERENT app: another world, another manifest
  const asV1 = derive({ record: { ...rec, derivation: DERIVATION, http: undefined }, component });
  assert.notEqual(asV1.appId, v2.mapping.appId, "a command server is not the same app as a proxy");
  // and the port is part of the identity
  const other = v.ok.find((c) => c.mapping.record.derivation === DERIVATION_V2 && c.mapping.record.http !== rec.http);
  if (other) assert.notEqual(other.mapping.appId, v2.mapping.appId, "another port, another AppID");
});
