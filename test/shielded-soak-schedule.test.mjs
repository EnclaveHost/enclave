// shielded-soak's exact-check sampling must reach every exchange shape at both
// row counts. The first version counted exchanges across the A B C D cycle, and
// with its default period of 256 (a multiple of 4) every exact check landed on
// shape D. --schedule-selftest runs the soak's own selection with no worker.
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

test("the selftest fails when nothing is checked", () => {
  const r = spawnSync(path.join(dir, "shielded-soak"), ["--exact-every", "0", "--schedule-selftest"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL/);
});
