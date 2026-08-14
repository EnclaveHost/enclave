// shielded-reference.test.mjs — drives the shielded-inference reference oracle.
//
// The oracle (shielded/reference/shielded_ref.py) is the executable form of the
// security argument in docs/shielded-inference.md. These assertions are the claims
// we are not allowed to silently regress: masked offload recovers exactly, a lying
// GPU is caught, a poisoned KV entry never reaches the cache, the adversary
// transcript is statistically independent of the secrets, and TwinShield's
// attention construction is recoverable at decode-sized m (which is WHY decode
// attention stays in the TEE).
//
// Python is driven the same way test/nn-arbiter.test.mjs drives wasm_manager.py:
// one JSON line out of a --selftest mode, parsed here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const ref = join(repo, "shielded", "reference", "shielded_ref.py");

let cached;
function run() {
  if (!cached) {
    const out = execFileSync("python3", [ref, "--selftest"], {
      encoding: "utf8",
      timeout: 900_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    cached = JSON.parse(out.trim().split("\n").pop());
  }
  return cached;
}

test("oracle passes its own gate", () => {
  assert.equal(run().ok, true);
});

test("fixed-point field round-trips within one quantum", () => {
  const f = run().field;
  assert.equal(f.roundtrip_within_quantum, true);
  assert.ok(f.matmul_max_err < 0.05, `matmul err ${f.matmul_max_err}`);
});

test("Slalom offload recovers bit-exactly and never exposes the input", () => {
  const s = run().slalom;
  assert.equal(s.recovery_bit_exact, true);
  assert.equal(s.gpu_ever_saw_plaintext_input, false);
});

test("mask bank never reuses a mask and stalls when dry", () => {
  // OTP reuse is a total confidentiality failure, not a degradation. Exhaustion
  // must block the request; a wraparound here would be catastrophic.
  const s = run().slalom;
  assert.equal(s.no_mask_reuse, true);
  assert.equal(s.exhaustion_stalls, true);
});

test("preprocessed Freivalds catches a single-element lie every time", () => {
  const f = run().freivalds;
  assert.equal(f.detection_rate, 1);
  assert.equal(f.no_false_positives, true);
  assert.ok(f.soundness_bits_per_check >= 40);
});

test("TwinShield attention is recoverable at decode-sized m", () => {
  // This is the measurement that pins decode attention inside the TEE. If a future
  // change makes these false, re-derive before offloading anything attention-shaped.
  const t = run().twinshield;
  assert.equal(t.m1_recovered, true, "m=1 (decode) must be shown recoverable");
  assert.equal(t.m4_recovered, true, "m=4 (a real GQA group) must be shown recoverable");
  assert.ok(t.search_bits.m512 > 256, "prefill-sized m must remain infeasible");
});

test("shielded decode matches the in-TEE reference exactly", () => {
  const d = run().decode;
  assert.equal(d.offload_matches_tee_reference, true);
  assert.ok(d.tensors_crossing_boundary > 0);
});

test("adversary transcript is independent of the secrets", () => {
  const d = run().decode;
  assert.equal(d.leak_any_exact_plaintext, false);
  assert.equal(d.leak_uniform_ok, true, `chi2 ${d.leak_chi2_uniform_64bin}`);
  assert.equal(d.leak_pooled_ok, true, `pooled corr ${d.leak_pooled_correlation}`);
  // Per-tensor correlations are small-sample noise; they must stay within the null.
  assert.ok(
    d.leak_max_per_tensor_correlation <= d.leak_per_tensor_null_max_expected,
    `per-tensor corr ${d.leak_max_per_tensor_correlation} exceeds null ${d.leak_per_tensor_null_max_expected}`,
  );
});

test("poisoned KV projection is caught before cache insertion", () => {
  // A bad activation costs one token; a bad CACHE entry poisons every future token
  // that attends to it. KV-producing matmuls verify strictly, with no deferral.
  const p = run().poisoning;
  assert.equal(p.kv_poisoning_caught, true);
  assert.equal(p.aborted_before_insertion, true);
});

test("field parameters hold at production width", () => {
  // Measured, against expectation: 1/sqrt(d) init is variance-preserving, so the
  // accumulator is flat in d. Width is not the risk; outlier magnitude is.
  const s = run().field_scaling;
  for (const k of ["d64", "d512", "d4096", "d14336"]) {
    assert.equal(s[k].fits_p24, true, `${k} overflows the field`);
    assert.ok(s[k].headroom_bits_p24 > 3, `${k} headroom ${s[k].headroom_bits_p24}`);
  }
  assert.ok(s.outlier_breaking_multiple >= 1000, "known LLM outliers must stay in range");
});

test("RNS escape hatch is exact and doubles dynamic range", () => {
  const r = run().rns;
  assert.equal(r.exact_at_d4096, true);
  assert.ok(r.dynamic_range_bits >= 47);
});

test("capacity model reflects the GQA catalog policy", () => {
  // GQA is what makes TEE-resident decode attention affordable. MHA at the same
  // context streams n_head/n_kv_head times more KV per token.
  const gqa = run().capacity_8k["llama-3-8b (GQA 4:1)"];
  const mha = run().capacity_8k["llama-2-7b (MHA 1:1)"];
  assert.ok(
    mha.kv_bytes_streamed_per_token > 3 * gqa.kv_bytes_streamed_per_token,
    "MHA should stream materially more KV than GQA",
  );
  assert.ok(gqa.kv_stream_ms_at_60GBps < 15, "GQA 8k attention must stay affordable");
});
