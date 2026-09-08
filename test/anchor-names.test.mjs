// The pVM pads port takes only canonical shipments (judged, acknowledged) and the exact prefix assets
// (stored, verified at use); every other name is refused before a byte is stored (payload/anchor_names.c).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const payload = join(here, "..", "shielded", "anchor", "avf", "payload");

test("anchor pins: shipment vs prefix asset vs refused names", () => {
  const dir = mkdtempSync(join(tmpdir(), "anchor-names-"));
  try {
    const bin = join(dir, "anchor-names");
    const cc = spawnSync("cc", ["-O1", "-g", "-fsanitize=address,undefined", "-Wall", "-Wextra", "-I", payload,
      join(here, "fixtures", "anchor-names.c"), join(payload, "anchor_names.c"), "-o", bin], { encoding: "utf8" });
    assert.equal(cc.status, 0, cc.stderr);
    const run = spawnSync(bin, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /anchor-names: ok/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
