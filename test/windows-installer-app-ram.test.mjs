// install-host.ps1's apps' RAM pool (NODE_APP_RAM_GB): the owner's value in node-config.local.cmd reaches the node AND the
// Shield manager unchanged, or setup stops before anything is stopped. It used to clamp the manager's copy to
// floor(physical GiB) - 16 in silence (95 on a 111 GiB NucBox) while the node read the owner's 96 unclamped.
// This Linux environment has no PowerShell, so these checks are STRUCTURAL (as test/windows-installer-independence.test.mjs):
// the installer's own Select-String and validation patterns are applied to sample lines, and the script is held to where
// and how the figure is written. A Windows run is still required.
//   run: node --test test/windows-installer-app-ram.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const INSTALL = fs.readFileSync(new URL("../windows/installer/install-host.ps1", import.meta.url), "utf8");
const code = INSTALL.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");     // without comment lines

test("the owner's line is read as cmd sets it, and only a whole number of GiB from 4 to this PC's physical GiB is accepted", () => {
  const read = code.match(/Select-String -Path \$localRam -Pattern '([^']+)' \| Select-Object -Last 1/);
  assert.ok(read, "the local file is read with one Select-String, the last match winning (as cmd runs it)");
  const line = new RegExp(read[1], "i");                                // Select-String matches case-insensitively
  const value = (l) => { const m = line.exec(l); return m ? m[2].trim() : null; };
  assert.equal(value("set NODE_APP_RAM_GB=96"), "96");
  assert.equal(value('set "NODE_APP_RAM_GB=96"'), "96");
  assert.equal(value("  SET node_app_ram_gb=96   "), "96");
  assert.equal(value("rem set NODE_APP_RAM_GB=8"), null);
  assert.equal(value("set NODE_APP_RAM_GB=95.5"), "95.5", "read, then refused below: never silently dropped");
  const digits = code.match(/\$ownerRam -notmatch '([^']+)'/);
  assert.ok(digits);
  const whole = new RegExp(digits[1]);
  for (const ok of ["4", "96", "111"]) assert.ok(whole.test(ok), ok);
  for (const bad of ["95.5", "", "-1", "96GB", "1e2", "0x60"]) assert.ok(!whole.test(bad), bad);
  assert.match(code, /\[int\]\$ownerRam -lt 4 -or \[int\]\$ownerRam -gt \$ramGb\) \{\s*\n\s*Fail "checks"/, "out of range stops setup");
});

test("the validated value is carried unchanged into node-config.cmd and shield-config.cmd; no silent clamp remains", () => {
  assert.doesNotMatch(code, /\$ramGb - 16,/, "no Min(RAM - 16, owner value) clamp");
  assert.deepEqual(code.match(/\$appRamGb = [^\n;]+/g), ["$appRamGb = [math]::Max(4, [math]::Floor($ramGb / 2))", "$appRamGb = [int]$ownerRam"],
                   "the default half, or the owner's value as read: nothing else assigns it");
  assert.equal(code.match(/^set NODE_APP_RAM_GB=\$appRamGb$/gm)?.length, 2, "shield-config.cmd and node-config.cmd");
  // node-config.cmd calls the owner's file after its own lines, so the node reads the same figure the manager is given
  const nodeCfg = code.indexOf("rem The Enclave host node.");
  assert.ok(nodeCfg > 0 && code.indexOf("set NODE_APP_RAM_GB=$appRamGb", nodeCfg) < code.indexOf('call "$PD\\node-config.local.cmd"', nodeCfg));
});

test("a refused value stops setup in the machine checks, before any Enclave task or process is stopped", () => {
  const refuse = code.indexOf('Fail "checks" "NODE_APP_RAM_GB=');
  assert.ok(refuse > 0);
  assert.ok(refuse < code.indexOf("\nStop-ForInstall\n"), "before the services are stopped");
  assert.ok(refuse < code.indexOf('if ($CheckOnly)'), "and -CheckOnly (setup's first page) reports it");
  // a pool that leaves the host less than the 16 GiB setup used to keep is SAID on the checks line, never refused
  assert.match(code, /Emit "checks" \$\(if \(\$ramNote\) \{ "warn" \} else \{ "ok" \}\)/);
});
