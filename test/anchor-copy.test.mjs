// The pVM receivers copy exactly what was announced, or say why not (payload/anchor_copy.c).


import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const payload = join(here, "..", "shielded", "anchor", "avf", "payload");

test("anchor pins: exact stream copy under EINTR, early end, refused writes, fsync gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "anchor-copy-"));
  try {
    const bin = join(dir, "anchor-copy");
    const cc = spawnSync("cc", ["-O1", "-g", "-fsanitize=address,undefined", "-Wall", "-Wextra", "-I", payload,
      join(here, "fixtures", "anchor-copy.c"), join(payload, "anchor_copy.c"), "-pthread", "-o", bin], { encoding: "utf8" });
    assert.equal(cc.status, 0, cc.stderr);
    const run = spawnSync(bin, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /anchor-copy: ok/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
