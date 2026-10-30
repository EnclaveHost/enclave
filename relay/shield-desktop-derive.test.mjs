import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveDesktop } from "./shield-desktop-derive.mjs";
import { deriveDesktop as managerDerive } from "../windows/vbslike/manager/desktop-derive.mjs";

const vectors = JSON.parse(readFileSync(new URL("../isolation/contract/catalog/desktop_vectors.json", import.meta.url)));

test("relay V8 derivation is the manager implementation with only the import renamed", () => {
  const source = name => readFileSync(new URL(name, import.meta.url), "utf8");
  assert.equal(source("./shield-desktop-derive.mjs"),
    source("../windows/vbslike/manager/desktop-derive.mjs").replace('"./derive.mjs"', '"./shield-derive.mjs"'));
});

test("relay and manager agree with all independent native vectors and refusals", () => {
  const component = Buffer.from(vectors.component_hex, "hex");
  for (const v of vectors.ok) {
    const { bundle, ...mapping } = deriveDesktop({ record: v.record, component });
    assert.deepEqual(mapping, v.mapping, v.name);
    assert.equal(bundle.toString("hex"), v.bundle_hex, v.name);
    assert.deepEqual(deriveDesktop({ record: v.record, component }), managerDerive({ record: v.record, component }));
  }
  for (const v of vectors.refused)
    assert.throws(() => deriveDesktop({ record: v.record, component: Buffer.from(v.component_hex, "hex") }), v.name);
});
