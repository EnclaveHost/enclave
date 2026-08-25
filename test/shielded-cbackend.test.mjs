/*
 * The C half of the shielded tier: the field encoding all three implementations
 * must agree on, and -- when a worker is reachable -- one real masked GEMM.
 *
 * The encoding test is the load-bearing one and runs anywhere gcc does. Python is
 * the reference, metal/guest/shielded.mjs mirrors it in float32, and this mirrors
 * it again for the engine. A divergence between any two does not fail loudly at
 * run time: the unmasking subtraction just returns noise. So it gets a test that
 * fails loudly here, over vectors that deliberately include fp16 subnormals,
 * which real GGUF scales hit and a naive converter gets wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import net from "node:net";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(repo, "wasm", "ggml-shielded");

let built = null;
function build() {
  if (built !== null) return built;
  const r = spawnSync("make", ["-s"], { cwd: dir, encoding: "utf8", timeout: 300_000 });
  built = r.status === 0;
  if (!built) console.error("[shielded-c] make failed:", r.stderr || r.stdout);
  return built;
}

test("the C field encoding matches Python, subnormals included", (t) => {
  if (!build()) return t.skip("no toolchain for the C backend");
  const py = JSON.parse(execFileSync("python3", [join(repo, "shielded", "field.py")],
    { encoding: "utf8", timeout: 300_000 }).trim().split("\n").pop());

  const consts = JSON.parse(execFileSync(join(dir, "field-selftest"), ["--constants"],
    { encoding: "utf8", timeout: 60_000 }).trim());
  assert.equal(consts.M_MOD, py.M_MOD);
  assert.equal(consts.HALF_M, py.HALF_M);
  assert.deepEqual(consts.primes, py.primes);
  assert.equal(consts.QK, py.QK);
  assert.equal(consts.FRAC, py.FRAC);
  assert.equal(consts.WEIGHT_BYTE_LIMIT, py.WEIGHT_BYTE_LIMIT);

  const v = py.vectors;
  const stdin = v.half_bits.map((h, i) => `${h} ${v.quant[i]}`).join("\n") + "\n";
  const got = execFileSync(join(dir, "field-selftest"), {
    input: stdin, encoding: "utf8", timeout: 60_000 }).trim().split("\n").map(Number);

  assert.ok(v.w_fixed.length >= 512, "vector set shrank");
  assert.equal(got.length, v.w_fixed.length);
  const bad = got.reduce((n, x, i) => n + (x === v.w_fixed[i] ? 0 : 1), 0);
  assert.equal(bad, 0,
    `${bad}/${got.length} encodings differ between wasm/ggml-shielded and shielded/field.py`);
});

// The scales are half of THE encoding, so their fp32->fp16 conversion is part of
// the contract too. Truncating instead of rounding to nearest-even lands one ulp
// low on about half of all blocks and fails NOWHERE -- the two sides simply derive
// different weights and unmasking returns noise. Caught exactly once, here.
test("the C fp16 conversion rounds like numpy, subnormals and overflow included", (t) => {
  if (!build()) return t.skip("no toolchain for the C backend");
  const out = execFileSync("python3", ["-c", `
import json, subprocess, sys
import numpy as np
rng = np.random.default_rng(3)
vals = np.concatenate([
    rng.uniform(-0.05, 0.05, 20000),
    rng.uniform(-1e-6, 1e-6, 20000),          # subnormal in fp16
    rng.uniform(-70000, 70000, 4000),         # overflows fp16
    np.array([0.0, -0.0, 6e-8, 5.96e-8, 6.104e-5, 0.00390625, 65504.0, 65520.0]),
]).astype(np.float64)
p = subprocess.run([${JSON.stringify(join(dir, "half-selftest"))}],
                   input=chr(10).join(repr(float(v)) for v in vals),
                   capture_output=True, text=True, timeout=600)
c = np.array([int(x) for x in p.stdout.split()], dtype=np.uint16)
with np.errstate(over="ignore"):
    ref = vals.astype(np.float32).astype(np.float16).view(np.uint16)
print(json.dumps({"checked": int(c.size), "mismatch": int((c != ref).sum())}))
`], { encoding: "utf8", timeout: 900_000 }).trim().split("\n").pop();
  const v = JSON.parse(out);
  assert.ok(v.checked > 40000, "sample shrank");
  assert.equal(v.mismatch, 0, `${v.mismatch}/${v.checked} fp16 conversions differ from numpy`);
});

// Picking the per-tensor exponent is where "it compiles" and "it is the same
// arithmetic" diverge: sh_encode_weight_fixed multiplies by 256, so it is only THE
// encoding when the scales already carry f_w. Hand it raw GGUF scales and every
// tensor silently encodes at f_w = 8.
test("the C picks the same weight exponent and encodes the same bytes as tee.py", (t) => {
  if (!build()) return t.skip("no toolchain for the C backend");
  const out = execFileSync("python3", ["-c", `
import json, subprocess, sys
sys.path.insert(0, ${JSON.stringify(join(repo, "shielded"))})
import numpy as np
from tee import PublicWeight, QK
rng = np.random.default_rng(11)
bad = []
for trial, (K, N) in enumerate([(64, 32), (128, 64), (256, 48), (512, 16)]):
    wd = (rng.uniform(1e-6, 0.02, size=(K // QK, N))
          * (10.0 ** rng.integers(-2, 1, size=(K // QK, N)))).astype(np.float16)
    wq = rng.integers(-127, 128, size=(K, N)).astype(np.int8)
    pw = PublicWeight("t%d" % trial, wq, wd)
    nl = chr(10)
    inp = ("%d %d" % (K, N) + nl
           + " ".join(str(int(x)) for x in wd.view(np.uint16).ravel()) + nl
           + " ".join(str(int(x)) for x in wq.ravel()) + nl)
    p = subprocess.run([${JSON.stringify(join(dir, "prepare-selftest"))}],
                       input=inp, capture_output=True, text=True, timeout=600)
    tok = p.stdout.split()
    c_fw = int(tok[0])
    c_w = np.array([int(x) for x in tok[1:]], dtype=np.int64).reshape(K, N)
    if c_fw != pw.f_w or not np.array_equal(c_w, pw.w_fixed_i8.astype(np.int64)):
        bad.append({"K": K, "N": N, "py_fw": int(pw.f_w), "c_fw": c_fw})
print(json.dumps({"bad": bad}))
`], { encoding: "utf8", timeout: 900_000 }).trim().split("\n").pop();
  assert.deepEqual(JSON.parse(out).bad, [],
    "the C and tee.py disagree on the weight exponent or the encoded weights");
});

const reachable = (host, port) => new Promise((res) => {
  const s = net.connect({ host, port });
  const done = (v) => { s.destroy(); res(v); };
  s.setTimeout(1500);
  s.on("connect", () => done(true));
  s.on("error", () => done(false));
  s.on("timeout", () => done(false));
});

test("one real masked GEMM through the C stack, asserted four ways", async (t) => {
  if (!build()) return t.skip("no toolchain for the C backend");
  const host = process.env.SHIELDED_HOST || "127.0.0.1";
  const port = Number(process.env.SHIELDED_PORT || 9500);
  if (!(await reachable(host, port)))
    return t.skip(`no shielded worker at ${host}:${port} (needs a CUDA box)`);

  const out = execFileSync(join(dir, "shielded-probe"),
    ["--host", host, "--port", String(port)],
    { encoding: "utf8", timeout: 300_000 }).trim().split("\n").pop();
  const v = JSON.parse(out);
  // Every claim, not a subset: a product that came back exact from a worker that
  // also accepts a denylisted op is not one to trust.
  assert.equal(v.exact, true, "unmasked product diverged from the int64 reference");
  assert.equal(v.verified, true, "Freivalds rejected an honest product");
  assert.equal(v.lie_rejected, true, "Freivalds ACCEPTED a single-element lie");
  assert.equal(v.denylist_refused, true, "the worker ran a denylisted op");
  assert.equal(v.verify_fail, 0);
  assert.ok(v.field_headroom > 1, `field wrapped: peak |y| ${v.peak_abs_y}`);
});
