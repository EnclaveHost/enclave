// The repository's secret-scanning tooling, checked by running it (not by reading it):
//   .githooks/gitleaks-selftest.py: .gitleaks.toml finds private keys GENERATED for the run (labelled, env, constructor,
//     --private-key, WIF shape, keystore, a provider token) and tolerates the look-alikes (digests, hashes, signatures,
//     addresses, SPKI public keys, the allowlisted public test key); no global allowlist swallows a bare 64-hex secret.
//   .githooks/hook-selftest.py: the pre-push hook, through an ABSOLUTE core.hooksPath into the main checkout, judges a linked
//     worktree's push by the PUSHED commit's .gitleaks.toml, falls back to its own config when that one cannot load, and
//     refuses a generated key through the crypto scanner whatever the config says.
// Both need gitleaks (CI installs the pinned release in .github/workflows/secret-scan.yml, which runs both scripts too);
// without it this test is skipped here and says so. No key-shaped value is ever written inside the repository.
//   run: node --test test/secret-scan-tooling.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gitleaks = [process.env.GITLEAKS, ...String(process.env.PATH || "").split(path.delimiter).map((d) => path.join(d, "gitleaks")), path.join(os.homedir(), ".local", "bin", "gitleaks")]
  .find((c) => c && fs.existsSync(c));
const skip = !gitleaks && "gitleaks is not installed";
const run = (script) => spawnSync("python3", [path.join(REPO, ".githooks", script)], { cwd: REPO, encoding: "utf8", env: { ...process.env, GITLEAKS: gitleaks || "" }, timeout: 300000 });

test("the gitleaks config finds generated private keys and tolerates the look-alikes; no global allowlist swallows a bare 64-hex secret", { skip }, () => {
  const r = run("gitleaks-selftest.py");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /8 generated secrets found by their rules, \d+ look-alikes tolerated/);
});

test("the pre-push hook judges a linked worktree's push by the pushed commit's config, falls back when it cannot load, and always runs the crypto scanner", { skip, timeout: 360000 }, () => {
  const r = run("hook-selftest.py");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /5 real pushes/);
});

test("CI runs both self-tests with the pinned gitleaks, and the hook states which config it used", () => {
  const y = fs.readFileSync(path.join(REPO, ".github", "workflows", "secret-scan.yml"), "utf8");
  assert.match(y, /run: python3 \.githooks\/gitleaks-selftest\.py/); assert.match(y, /run: python3 \.githooks\/hook-selftest\.py/);
  assert.ok(y.indexOf("gitleaks-selftest.py") > y.indexOf("Install gitleaks"), "after the pinned install");
  const hook = fs.readFileSync(path.join(REPO, ".githooks", "pre-push"), "utf8");
  assert.match(hook, /git show "\$1:\.gitleaks\.toml"/, "the pushed commit's config first");
  assert.match(hook, /pre-push: gitleaks config: /, "and the push says which config judged it");
  assert.doesNotMatch(hook, /--no-verify\s*$/m);
});
