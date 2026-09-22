// When the BYTES disagree with the catalog declaration, the bytes win — and the lease goes back.
//
// Found live rather than by reading: this box claimed risc-box 0.6.15, whose catalog config does
// not declare `set: true`, and whose artifact contains shared memories anyway. The claim gate reads
// the declaration; only the compiler reads the bytes. So the gate admitted it, the compile failed
// with "threads must be enabled for shared memories", and the deployment sat in "failed" WHILE THIS
// BOX HELD ITS LEASE — a tenant paying for an app that could never start here.
//
// The mirror case is the s3-ipfs-adapter, which declares set:true and threads:true and runs
// perfectly well without either. Declarations are what a publisher built with, not what an artifact
// needs, and they are wrong in both directions.
import { test } from "node:test";
import assert from "node:assert/strict";

/** Exactly host.mjs's test for "this failure is permanent". */
const permanent = (message) => /([a-z0-9_-]+) must be enabled/i.exec(String(message || ""));

test("a compile failure naming a missing wasm feature is permanent", () => {
  // The real message, from the real failure on the box.
  const real = 'bytecode: Command failed: ee-precompile.exe in.wasm out.cwasm 1\n'
    + 'Error: failed to parse WebAssembly module\n\nCaused by:\n'
    + '    threads must be enabled for shared memories (at offset 0x4613)\n';
  const m = permanent(real);
  assert.ok(m, "this must be recognised, or the box holds a lease it can never honour");
  assert.equal(m[1], "threads");
  // ...and the reason a tenant reads names the feature and says the bytes are the authority.
  const line = real.split("\n").filter((l) => /must be enabled/i.test(l))[0].trim();
  assert.equal(line, "threads must be enabled for shared memories (at offset 0x4613)");
});

test("the other features wasmtime names the same way are caught too", () => {
  for (const [msg, feature] of [
    ["memory64 must be enabled for 64-bit memories (at offset 0x21)", "memory64"],
    ["exceptions must be enabled for tag sections", "exceptions"],
    ["gc must be enabled for struct types", "gc"],
    ["tail-call must be enabled for return_call", "tail-call"],
  ]) {
    const m = permanent(msg);
    assert.ok(m, msg);
    assert.equal(m[1], feature);
  }
});

test("a TRANSIENT failure is not treated as permanent", () => {
  // These must keep the lease and retry: a missing compiler, a full disk, a killed process. Giving
  // the lease back for one of them would hand a tenant's app to another box over a local hiccup.
  for (const msg of [
    "bytecode: Command failed: ENOENT, no such file or directory",
    "bytecode: the compiler produced no bytecode",
    "bytecode: Command failed: ee-precompile.exe ... \nError: No space left on device",
    "bytecode: spawn ETIMEDOUT",
    "artifact: the gateway returned HTTP 502",
  ]) assert.equal(permanent(msg), null, `${JSON.stringify(msg)} must be retried, not released`);
});

test("the pattern does not fire on ordinary prose containing the words", () => {
  // It has to be "<feature> must be enabled", not any sentence with "enabled" in it.
  assert.equal(permanent("this feature is not enabled on this box"), null);
  assert.equal(permanent("enabled"), null);
  assert.equal(permanent("must be enabled"), null, "with no feature named, nothing can be said");
});
