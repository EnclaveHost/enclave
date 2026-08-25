// shielded-tee.test.mjs — the trusted half, and the contract it shares with the GPU.
//
// shielded-reference.test.mjs proves the CONSTRUCTIONS at toy scale over a single
// 24-bit prime. This covers the production TEE side: the RNS basis the kernel
// actually uses, the per-tensor weight encoding a real GGUF forces, the mask
// bank's one-time invariant, and the integrity check that catches both halves of
// what can go wrong.
//
// None of it needs a GPU. The GPU-attached half is shielded-gpu.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const py = (mod) =>
  JSON.parse(execFileSync("python3", [join(repo, "shielded", mod)],
    { encoding: "utf8", timeout: 300_000 }).trim().split("\n").pop());

let teeCache, fieldCache;
const tee = () => (teeCache ??= py("tee.py"));
const fieldv = () => (fieldCache ??= py("field.py"));

test("tee selftest passes as a whole", () => {
  assert.equal(tee().ok, true);
});

test("weights fit the kernel's int8 lane, and the residue identity holds", () => {
  const r = tee();
  assert.equal(r.weight_fits_byte_lane, true);
  // The weight needs no RNS decomposition: at |w| <= min(prime)/2 the balanced
  // residue mod every prime IS w. That identity is what lets one int8 plane serve
  // all three channels on both sides -- 3x less CVM RAM for the largest resident.
  assert.equal(r.weight_residues_equal_weight, true);
  assert.equal(fieldv().residue_identity, true,
    "WEIGHT_BYTE_LIMIT must stay equal to min(prime)//2");
});

test("the weight exponent adapts per tensor, because a real GGUF forces it", () => {
  // The design fixes l = 8 for activations. It cannot also fix 8 for weights: a
  // real tensor has |w| up to ~0.5, and w * 2^8 = 128 wraps the int8 lane
  // silently, into a completely wrong product.
  assert.equal(tee().exponent_adapts, true);
  assert.equal(tee().weight_reconstruction_within_quantum, true);
});

test("mask bank issues once and stalls when dry", () => {
  const r = tee();
  assert.equal(r.mask_indices_unique, true);
  assert.equal(r.mask_indices_monotonic, true);
  // Wraparound is not a slowdown. It is pad reuse across two activations, which
  // hands the adversary their difference -- and successive decode activations
  // differ by very little.
  assert.equal(r.mask_exhaustion_stalls, true);
  assert.equal(r.mask_stream_is_deterministic, true);
  assert.equal(r.mask_differs_by_seed, true);
});

test("Slalom recovery is bit-exact, not approximate", () => {
  assert.equal(tee().slalom_recovers_bit_exactly, true);
});

test("the refill is exact (an inexact GEMM backend would be silent)", () => {
  // REPORT.md measures torch bf16 at 2419 G-MAC/s and NOT exact. Picking it for
  // speed would make every unmasked result wrong in a way that looks like a
  // masking bug, so exactness is probed rather than assumed.
  assert.equal(tee().refill_exact, true);
});

test("Freivalds catches a single-element lie every time", () => {
  const r = tee();
  assert.equal(r.freivalds_accepts_honest, true);
  assert.equal(r.freivalds_catches_single_element_lie, r.freivalds_lie_trials);
});

test("Freivalds also catches a field WRAP, which a mod-M check cannot", () => {
  const r = tee();
  // This is the half the oracle's mod-M version misses, and REPORT.md's open
  // risk #3: a wrapped product is still congruent to x*W mod M, so a mod-M
  // check passes it and the value decodes to garbage with no error signal.
  assert.equal(r.mod_m_check_would_miss_the_wrap, true,
    "the wrapped value must be indistinguishable mod M -- otherwise this test is vacuous");
  assert.equal(r.freivalds_catches_field_wrap, true);
});

test("the BLAS fast path is exact, not merely close", () => {
  assert.equal(tee().exact_matmul_matches_int64, true);
});

test("the guest's JS encoder agrees with Python bit for bit", async () => {
  // THE determinism requirement: the TEE computes u = r*W and the GPU computes
  // (x+r)*W, and the two must derive identical field elements from the same q8_0
  // bytes or the subtraction returns noise. metal/guest/shielded.mjs is a third
  // implementation of that rounding rule, in float32 via Math.fround. It gets a
  // test rather than a comment because a divergence here is silent.
  const { encodeWeightFixed } = await import(
    join(repo, "metal", "guest", "shielded.mjs"));
  const v = fieldv().vectors;
  let mismatches = 0, checked = 0;
  for (let i = 0; i < v.w_fixed.length; i++) {
    checked++;
    if (encodeWeightFixed(v.half_bits[i], v.quant[i]) !== v.w_fixed[i]) mismatches++;
  }
  assert.ok(checked >= 512, "vector set shrank");
  assert.equal(mismatches, 0,
    `${mismatches}/${checked} encodings differ between metal/guest/shielded.mjs and shielded/field.py`);
});

test("the guest's field constants match the kernel's", async () => {
  const js = await import(join(repo, "metal", "guest", "shielded.mjs"));
  const f = fieldv();
  assert.equal(js.M_MOD, f.M_MOD);
  assert.equal(js.HALF_M, f.HALF_M);
  assert.equal(js.QK, f.QK);
  assert.equal(js.FRAC, f.FRAC);
  assert.equal(js.WEIGHT_BYTE_LIMIT, f.WEIGHT_BYTE_LIMIT);
  assert.deepEqual(js.Q, f.primes);
});

// The Freivalds secret is the tier's whole integrity story: the worker is
// untrusted BY DESIGN and its honesty rests on not being able to predict s. A
// fixed default seed (which both halves once shipped) let a worker that had read
// the public source recover s, solve d.s == 0 (mod P2) over three outputs and
// return y + d -- accepted by the check, decoded as garbage. These two tests
// pin the fix on both sides; they fail the moment a default becomes reproducible.
test("the guest draws its Freivalds secret from a source it cannot repeat", async () => {
  const js = await import(join(repo, "metal", "guest", "shielded.mjs"));
  const K = 32, N = 8;
  const wFixed = new Float64Array(K * N);
  for (let i = 0; i < wFixed.length; i++) wFixed[i] = (i % 17) - 8;
  // Pinning Math.random is what makes this decisive rather than merely
  // suggestive: it fails for BOTH bad defaults -- a fixed seed (every secret
  // identical) and Math.random itself (identical once pinned) -- and passes only
  // for a generator the caller cannot influence.
  const realRandom = Math.random;
  Math.random = () => 0.42;
  try {
    const secrets = new Set();
    for (let t = 0; t < 8; t++) {
      const fv = new js.Freivalds(wFixed, K, N);        // no rnd argument
      secrets.add(Array.from(fv.s[0]).join(","));
    }
    assert.equal(secrets.size, 8,
      "the default Freivalds secret tracks Math.random or a fixed seed -- s is predictable");
  } finally {
    Math.random = realRandom;
  }
});

test("the TEE draws its Freivalds secret from a source it cannot repeat", () => {
  const out = execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(repo, "shielded"))})
import numpy as np
from tee import WorkerLink, Freivalds, PublicWeight, QK
K, N = 64, 32
rs = np.random.default_rng(7)
wq = rs.integers(-100, 100, size=(K, N)).astype(np.int8)
wd = np.full((K // QK, N), 0.002, dtype=np.float32)
w = PublicWeight("t", wq, wd)
seen = {Freivalds(w, WorkerLink().rng).s.tobytes() for _ in range(8)}
print(json.dumps({"distinct": len(seen)}))
`], { encoding: "utf8", timeout: 300_000 });
  assert.equal(JSON.parse(out.trim().split("\n").pop()).distinct, 8,
    "two default WorkerLink rngs produced the same Freivalds secret -- s is predictable");
});
