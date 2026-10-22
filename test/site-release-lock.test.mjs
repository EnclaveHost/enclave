import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { lockRoot, LockedError } from "../scripts/site-release/root-state.mjs";

const children = (pid) => fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);

test("a helper exit cannot release the root lock while its owning rollout is alive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "site-lock-owner-"));
  const release = await lockRoot(root);
  let second, killedLegacyChild = false;
  try {
    // Negative control: the old pipe-lifetime implementation leaves flock+cat alive. Kill only this root's cat.
    // The fixed implementation has already reaped its acquisition helper and keeps the descriptor itself.
    for (const pid of children(process.pid)) {
      let argv;
      try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { continue; }
      if (path.basename(argv[0] || "") !== "flock" || !argv.includes(path.join(root, ".site-release.lock"))) continue;
      for (const child of children(pid)) {
        if (fs.readFileSync(`/proc/${child}/comm`, "utf8").trim() === "cat") {
          process.kill(child, "SIGKILL"); killedLegacyChild = true;
        }
      }
    }
    if (killedLegacyChild) await sleep(100);
    try { second = await lockRoot(root); } catch (e) { assert.ok(e instanceof LockedError); }
    assert.equal(second, undefined, "another rollout must remain excluded until the owning process releases");
  } finally {
    if (second) await second();
    // The old release waits forever for an already-emitted helper-close event; do not hang its negative control.
    if (!killedLegacyChild) await release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
