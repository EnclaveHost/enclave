// shielded-soak's exact-check sampling must reach every INSTANCE -- every layer
// of every shape -- at every row count. Two versions aliased: a global count over
// the A B C D cycle put every check on D (period 256 is a multiple of 4), and a
// per-(shape, m) count put every check on the last of 64 layers (256 is a
// multiple of 64). --schedule-selftest runs the soak's own pass generator and
// selection with no worker and fails unless every (instance, m) pair is checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = "wasm/ggml-shielded";

test("every (shape, m) cell is exact-checked, at the default period and at a multiple of the cycle", () => {
  execFileSync("make", ["-s", "-C", dir, "shielded-soak"], { stdio: "pipe" });
  for (const every of ["256", "4", "8", "1024"]) {
    const r = spawnSync(path.join(dir, "shielded-soak"), ["--exact-every", every, "--schedule-selftest"], { encoding: "utf8" });
    assert.equal(r.status, 0, `period ${every}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /schedule-selftest: PASS/);
    for (const cell of ["qkv\\|gate\\|a\\|b/m1", "qkv\\|gate\\|a\\|b/m2", "ssm_out/m1", "ssm_out/m2", "gate\\|up/m1", "gate\\|up/m2", "down/m1", "down/m2"])
      assert.match(r.stdout, new RegExp(`${cell}=[1-9]\\d* of`), `period ${every}: cell ${cell} unchecked`);
  }
});

test("with every production condition on, every (shape, m) cell including lm_head and m=17 is checked", () => {
  const r = spawnSync(path.join(dir, "shielded-soak"), ["--layers", "64", "--lm-head", "--prefill-every", "50", "--schedule-selftest"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all 771 \(instance, m\) pairs are exact-checked/);
  for (const shape of ["qkv\\|gate\\|a\\|b", "ssm_out", "gate\\|up", "down"])
    for (const m of ["m1", "m2", "m17"])
      assert.match(r.stdout, new RegExp(`${shape}/${m}=[1-9]\\d* of \\d+ \\[64 of 64 layers\\]`), `${shape}/${m} misses layers`);
  assert.match(r.stdout, /lm_head\/m17=[1-9]\d* of \d+ \[1 of 1 layers\]/);
});

test("periods that are multiples of the layer count still reach every layer", () => {
  for (const every of ["64", "128", "256", "512"]) {
    const r = spawnSync(path.join(dir, "shielded-soak"), ["--layers", "64", "--exact-every", every, "--schedule-selftest"], { encoding: "utf8" });
    assert.equal(r.status, 0, `period ${every}: ${r.stdout}`);
    assert.match(r.stdout, /all 512 \(instance, m\) pairs are exact-checked/, `period ${every}`);
  }
});

test("the selftest fails when nothing is checked", () => {
  const r = spawnSync(path.join(dir, "shielded-soak"), ["--exact-every", "0", "--schedule-selftest"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL/);
});
