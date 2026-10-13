// The pVM ABI/2 app attestation: real Pixel capture lines (branch pvm-cpu/portable-runtime) judged by that
// branch's relay/pvm-app-attest.mjs through verifier/index.mjs verifyPvmAbi2. Skips on main, where the
// module is absent; then the harness reports "unsupported", never a verdict.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyPvmAbi2, loadOwnerModule, STRICT_INTEGRATION } from "../verifier/index.mjs";
const mod = await loadOwnerModule();
const F = new URL("./fixtures/verifier/pvm-abi2/", import.meta.url);
test("the pVM module absent: the harness says unsupported; present: empty evidence is rejected, never unsupported", async () => {
  const v = await verifyPvmAbi2({}, {});
  if (mod) { assert.equal(v.status, "rejected"); } else { assert.equal(v.status, "unsupported"); assert.match(v.reasons[0], /pvm-app-attest/); }
});
test("ap-case1: binding verified (owner nonce, not a relay); ap-baddigest: refused by app policy", { skip: !mod && !STRICT_INTEGRATION && "owner module absent (set ENCLAVE_PVM_MODULE via verifier/integration/resolve.mjs)" }, async () => {
  assert.ok(mod, "strict integration: the owner's module must be present");
  const parse = (f) => mod.abi2FromLog(fs.readFileSync(new URL(f, F), "utf8"));
  const ok = parse("ap-case1.log"); assert.equal(ok.chain.length, 5); assert.ok(ok.binding);
  // the log records the payload's own view of the binding; a verifier recomputes it from the identity it reads
  const rid = mod.runtimeId(JSON.parse(ok.identity)).toString("hex"); assert.equal(rid, ok.binding.runtimeId);
  const bad = parse("ap-baddigest.log"); assert.equal(bad.binding.app, "0".repeat(64));
});
