// hvnode-install.ps1 -NodeOnly -DryRun is PROVEN inert with stubs, never against a box (enclave-87's hard rule, 09-26):
// runs windows/node/ops/hv-node-rollout/tests/nodeonly-dryrun.tests.ps1 under pwsh, which executes the script's real
// `if ($NodeOnly)` block with recording stubs for every stop/start/rewrite cmdlet, a positive control (the real path records
// them) and two mutants (the DryRun exit removed; moved below the first stop), each of which must be caught.
// Skipped when no pwsh is available (ENCLAVE_PWSH, or ~/enclave-bench/tools/pwsh-*/pwsh), as test/hvnode-install-ps1.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = path.join(ROOT, "windows/node/ops/hv-node-rollout/tests/nodeonly-dryrun.tests.ps1");
const pwsh = process.env.ENCLAVE_PWSH || (() => {
  const tools = path.join(os.homedir(), "enclave-bench/tools");
  try { const d = fs.readdirSync(tools).filter((x) => x.startsWith("pwsh-")).sort().pop(); return d ? path.join(tools, d, "pwsh") : null; }
  catch { return null; }
})();

test("hvnode-install.ps1 -NodeOnly -DryRun reaches no stop, start or rewrite (stubbed; positive control + 2 mutants)",
  { skip: !pwsh || !fs.existsSync(pwsh) ? "no pwsh here" : false, timeout: 180_000 }, () => {
  let out;
  try { out = execFileSync(pwsh, ["-NoProfile", "-NonInteractive", "-File", TESTS], { encoding: "utf8" }); }
  catch (e) { assert.fail(`nodeonly-dryrun.tests.ps1 failed:\n${e.stdout || ""}${e.stderr || ""}`); }
  assert.match(out, /nodeonly-dryrun tests: ALL OK/, out);
  assert.doesNotMatch(out, /^FAIL /m, out);
});
