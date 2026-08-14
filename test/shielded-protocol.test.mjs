// shielded-protocol.test.mjs — admission rules for the hardened worker.
//
// The shielded worker is a ggml-rpc derivative running on a host the operator
// controls. Stock ggml-rpc is a remote EXECUTION service: GRAPH_COMPUTE runs any
// op graph the peer serialises, GET_TENSOR reads any region of any live buffer,
// and tensor payloads get cached to disk. These tests pin the reductions that make
// that surface safe to expose, and they are the ones most likely to be quietly
// undone by a future port that "just adds back" a convenient command.
//
// Note what these do NOT test: confidentiality. That comes from the masks, not
// from the protocol -- the worker is assumed to see every byte it is sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = join(repo, "shielded", "protocol.py");

let cached;
function run() {
  if (!cached) {
    const out = execFileSync("python3", [mod], { encoding: "utf8", timeout: 120_000 });
    cached = JSON.parse(out.trim().split("\n").pop());
  }
  return cached;
}

test("protocol selftest passes as a whole", () => {
  assert.equal(run().ok, true);
});

test("fails closed on malformed framing", () => {
  // Every other patch in the wasmtime stack fails open. This one must not:
  // guessing at a malformed frame means running an attacker's graph.
  const r = run();
  assert.equal(r.bad_length_refused, true, "a lying length header must be fatal");
  assert.equal(r.unknown_cmd_refused, true);
  assert.equal(r.pre_hello_refused, true);
});

test("bounds-checks every buffer region", () => {
  // The ggml-rpc memory-safety bug class (GHSA-j8rj-fmpv-wcxw) was a tensor whose
  // buffer reference skipped validation. Unknown buffer and OOB region are fatal.
  assert.equal(run().oob_write_refused, true);
});

test("GRAPH_INSTALL enforces the op allowlist", () => {
  const r = run();
  assert.equal(r.denied_op_refused, true);
  assert.match(r.denied_op_reason, /SOFT_MAX/, "rejection should name the op");
  assert.match(r.denied_op_reason, /TEE-only/, "rejection should give the reason");
  // Plain MUL_MAT is the dangerous one: it would silently run on UNMASKED data.
  assert.equal(r.mul_mat_refused, true);
  assert.equal(r.good_graph_installed, true);
});

test("allowlist contains only masked-GEMM and metadata ops", () => {
  const allow = new Set(run().op_allowlist);
  assert.ok(allow.has("FIELD_GEMM"));
  for (const banned of ["SOFT_MAX", "RMS_NORM", "ROPE", "MUL_MAT", "FLASH_ATTN_EXT", "GET_ROWS"]) {
    assert.ok(!allow.has(banned), `${banned} must never be executable on the worker`);
  }
});

test("GET_TENSOR is restricted to declared graph outputs", () => {
  // Stock behaviour is arbitrary-region read = full activation exfiltration.
  const r = run();
  assert.equal(r.undeclared_read_refused, true);
  assert.equal(r.declared_read_ok, true);
});

test("compute is install-once, then recompute-only", () => {
  const r = run();
  assert.equal(r.recompute_ok, true);
  assert.equal(r.reinstall_refused, true);
});

test("dangerous stock commands stay deleted", () => {
  const removed = new Set(run().removed_commands);
  for (const c of ["GRAPH_COMPUTE", "SET_TENSOR_HASH", "COPY_TENSOR", "MEMSET_TENSOR", "BUFFER_CLEAR"]) {
    assert.ok(removed.has(c), `${c} must not be reintroduced`);
  }
});
