// shielded-kernel.test.mjs — the fused field-GEMM kernel.
//
// Requires a CUDA GPU with Triton. Skips cleanly without one, because most
// contributors and CI runners will not have a card and a red suite they cannot
// fix teaches them to ignore the suite.
//
// What matters here is not speed, it is that the kernel is EXACT and that the
// TEE and GPU derive bit-identical field elements from the same weight bytes.
// A fast kernel that disagrees with the TEE's `u = r*W` by one ULP returns noise
// after unmasking, and it would look like a masking bug rather than a rounding
// bug.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = join(repo, "shielded", "kernels", "fused_field_gemm.py");

function cudaAvailable() {
  try {
    const out = execFileSync("python3", ["-c",
      "import torch,triton;print(torch.cuda.is_available())"],
      { encoding: "utf8", timeout: 60_000 });
    return out.trim().endsWith("True");
  } catch {
    return false;
  }
}

const HAVE_CUDA = cudaAvailable();
let cached;
function run() {
  if (!cached) {
    const out = execFileSync("python3", [mod], {
      encoding: "utf8", timeout: 900_000, maxBuffer: 32 * 1024 * 1024,
    });
    cached = JSON.parse(out.trim().split("\n").filter(l => l.startsWith("{")).pop());
  }
  return cached;
}

test("fused field GEMM: masked round-trip is exact", { skip: !HAVE_CUDA && "no CUDA/Triton" }, () => {
  // End to end: mask -> in-kernel dequantise -> RNS accumulate -> fused CRT ->
  // TEE subtracts u. Must reproduce the plaintext product exactly, or the whole
  // construction is decorative.
  const r = run();
  assert.equal(r.masked_roundtrip_gemv_exact, true);
  assert.equal(r.masked_roundtrip_gemm_exact, true);
  assert.equal(r.in_range, true, "product must stay inside the RNS dynamic range");
});

test("kernel weight encoding matches the host bit-for-bit", { skip: !HAVE_CUDA && "no CUDA/Triton" }, () => {
  // The determinism tripwire. TEE computes u = r*W on the host; the GPU derives W
  // from the same GGUF bytes in-kernel. Any divergence in fp operation order or
  // rounding silently corrupts every unmasked result.
  assert.equal(run().kernel_encoding_matches_host, true);
});

test("in-kernel dequantisation avoids materialising field weights", { skip: !HAVE_CUDA && "no CUDA/Triton" }, () => {
  const v = run().vram_8B_model_GB;
  assert.ok(v.q8_0_in_kernel < v.materialised_rns3 / 2,
    `in-kernel ${v.q8_0_in_kernel} GB should be far below materialised ${v.materialised_rns3} GB`);
  assert.equal(run().bytes_per_weight.q8_0_in_kernel, 1.0625);
});

test("oracle-level gate passes", { skip: !HAVE_CUDA && "no CUDA/Triton" }, () => {
  assert.equal(run().ok, true);
});
