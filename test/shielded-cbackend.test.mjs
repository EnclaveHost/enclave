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
