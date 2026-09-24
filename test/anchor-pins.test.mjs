// The phone anchor's measured pins load fail-closed: protected mode needs every pin, a present-but-corrupt
// pin is an error in any mode, the mode itself is an explicit asset, and the model is compared with the
// pin from its actual bytes (shielded/anchor/avf/payload/anchor_pins.c).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const payload = join(here, "..", "shielded", "anchor", "avf", "payload");

function runPins(defines, expect) {
  const dir = mkdtempSync(join(tmpdir(), "anchor-pins-"));
  try {
    const bin = join(dir, "anchor-pins");
    const cc = spawnSync("cc", ["-O1", "-g", "-fsanitize=address,undefined", "-Wall", "-Wextra", ...defines, "-I", payload,
      join(here, "fixtures", "anchor-pins.c"), join(payload, "anchor_pins.c"), "-o", bin], { encoding: "utf8" });
    assert.equal(cc.status, 0, cc.stderr);
    const run = spawnSync(bin, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, expect);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("anchor pins: explicit mode, fail-closed protected pins, model digest compared from bytes", () => {
  runPins([], /anchor-pins: ok\n/);
});

// The pVM CPU build (ANCHOR_TIER_PVM_CPU, PVM-CPU.md): protected needs the model pin only; a split-engine pin is refused.
test("anchor pins, pvm-cpu tier: model pin only, split-engine pins refused", () => {
  runPins(["-DANCHOR_TIER_PVM_CPU"], /anchor-pins: ok \(pvm-cpu\)/);
});
