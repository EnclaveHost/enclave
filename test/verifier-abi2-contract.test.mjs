// When isolation/contract/runtime.mjs is in the tree (branch isolation/portable-runtime-jit), the ABI/2 test
// vector used by test/verifier-snp-turin.test.mjs must equal what the contract computes. Skips on main.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
let contract = null; try { contract = await import("../isolation/contract/runtime.mjs"); } catch {}
test("Bind2 over the M4a document equals report_data[0:32] via the contract's own runtime.mjs", { skip: !contract && "isolation/contract/runtime.mjs not in this tree" }, () => {
  const saved = JSON.parse(fs.readFileSync(new URL("./fixtures/verifier/turin-m4a/doc.json", import.meta.url), "utf8")); const d = saved.doc ?? saved;
  const report = Buffer.from(d.report, "base64");
  const b = contract.bind2(Buffer.from(d.transportKey, "base64"), Buffer.from(d.nonce, "hex"), contract.runtimeId(d.runtime));
  assert.equal(b.toString("hex"), report.subarray(0x50, 0x70).toString("hex"));
});
