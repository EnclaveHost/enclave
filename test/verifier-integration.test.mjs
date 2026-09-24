// verifier/integration: the pinned cross-branch dependency is resolved from git by full commit and blob hashes, and a
// missing or wrong dependency is a FAILURE under strict mode, never a silent skip. Every case here spawns the real
// scripts. Cases that need the pinned commit in this repository skip when it is absent and --no-fetch would fail
// (a clean clone without the owner's branch), and say so.
//   run: node --test test/verifier-integration.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PINS = JSON.parse(fs.readFileSync(path.join(REPO, "verifier/integration/pins.json"), "utf8"));
const pin = PINS["pvm-app-attest"];
// children must not inherit the parent test runner's context (NODE_TEST_CONTEXT makes a child emit the binary v8
// reporter stream instead of TAP), and test files are run with the TAP reporter so their output is greppable
const childEnv = (env) => { const e = { ...process.env, ...env }; delete e.NODE_TEST_CONTEXT; return e; };
const node = (script, args = [], env = {}) => {
  const isTest = /\.test\.mjs$/.test(script);
  return spawnSync(process.execPath, [...(isTest ? ["--test", "--test-reporter=tap"] : []), path.join(REPO, script), ...args], { cwd: REPO, encoding: "utf8", env: childEnv(env) });
};
const havePinned = (() => { try { execFileSync("git", ["cat-file", "-e", `${pin.commit}^{commit}`], { cwd: REPO, stdio: "ignore" }); return true; } catch { return false; } })();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vint-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("the pin is explicit: a full commit, an entry, blob hashes, and a worktree-match list", () => {
  assert.match(pin.commit, /^[0-9a-f]{40}$/); assert.equal(pin.entry, "relay/pvm-app-attest.mjs");
  for (const h of Object.values(pin.files)) assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(pin.mustMatchWorktree.includes("relay/avf-verify.mjs"));
});
test("resolve: the pinned commit materialises exactly the pinned bytes into an isolated directory with a manifest", { skip: !havePinned && "pinned commit not in this repository (fetch origin pvm-cpu/portable-runtime)" }, () => {
  const r = node("verifier/integration/resolve.mjs", ["--dir", tmp, "--no-fetch", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(m.commit, pin.commit); assert.ok(fs.existsSync(m.entry));
  for (const [rel, want] of Object.entries(pin.files)) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(path.dirname(m.entry), "..", rel))).digest("hex"), want, rel);
  assert.ok(m.entry.startsWith(path.join(tmp, "pvm-app-attest-" + pin.commit.slice(0, 12))), "isolated under the given dir, never in the tree");
  assert.equal(fs.existsSync(path.join(REPO, "relay/pvm-app-attest.mjs")), false, "nothing was written into the tracked tree");
});
test("resolve: a wrong commit, a tampered blob hash, and a worktree mismatch each fail with exit 2 and write no entry", { skip: !havePinned && "pinned commit not in this repository" }, () => {
  const withPins = (mut) => { const dir = fs.mkdtempSync(path.join(tmp, "pins-")); const p = JSON.parse(JSON.stringify(PINS)); mut(p["pvm-app-attest"]); fs.mkdirSync(path.join(dir, "verifier/integration"), { recursive: true });
    fs.writeFileSync(path.join(dir, "verifier/integration/pins.json"), JSON.stringify(p)); fs.copyFileSync(path.join(REPO, "verifier/integration/resolve.mjs"), path.join(dir, "verifier/integration/resolve.mjs"));
    // resolve.mjs reads pins relative to its own location and runs git in that root; point the copy's root at a git checkout by symlinking .git and the worktree file it must compare
    for (const f of [".git", "relay"]) fs.symlinkSync(path.join(REPO, f), path.join(dir, f)); return dir; };
  const wrong = withPins((q) => { q.commit = "0".repeat(40); });
  const r1 = spawnSync(process.execPath, [path.join(wrong, "verifier/integration/resolve.mjs"), "--dir", path.join(tmp, "o1"), "--no-fetch"], { encoding: "utf8" });
  assert.equal(r1.status, 2); assert.match(r1.stderr, /not in this repository|not reachable/);
  const tampered = withPins((q) => { q.files["relay/pvm-app-attest.mjs"] = "f".repeat(64); });
  const r2 = spawnSync(process.execPath, [path.join(tampered, "verifier/integration/resolve.mjs"), "--dir", path.join(tmp, "o2"), "--no-fetch"], { encoding: "utf8" });
  assert.equal(r2.status, 2); assert.match(r2.stderr, /the pin and the commit disagree/);
  assert.equal(fs.existsSync(path.join(tmp, "o2", `pvm-app-attest-${pin.commit.slice(0, 12)}`, "relay/pvm-app-attest.mjs")), false, "a mismatched pin leaves no usable entry");
  const mixed = withPins((q) => { q.files["relay/avf-verify.mjs"] = "e".repeat(64); });   // the pin says avf-verify is something the worktree is not
  const r3 = spawnSync(process.execPath, [path.join(mixed, "verifier/integration/resolve.mjs"), "--dir", path.join(tmp, "o3"), "--no-fetch"], { encoding: "utf8" });
  assert.equal(r3.status, 2); assert.match(r3.stderr, /disagree|differs between/);
});
test("strict mode: a missing or wrong module FAILS the acceptance suites instead of skipping them", () => {
  const missing = node("test/verifier-pvm-device.test.mjs", [], { ENCLAVE_PVM_MODULE: path.join(tmp, "nope.mjs"), ENCLAVE_STRICT_INTEGRATION: "1" });
  assert.notEqual(missing.status, 0); assert.match(missing.stdout + missing.stderr, /strict integration: the owner's module is missing or unusable/);
  const bogus = path.join(tmp, "bogus.mjs"); fs.writeFileSync(bogus, "export const somethingElse = 1;\n");
  const wrong = node("test/verifier-pvm-device.test.mjs", [], { ENCLAVE_PVM_MODULE: bogus, ENCLAVE_STRICT_INTEGRATION: "1" });
  assert.notEqual(wrong.status, 0); assert.match(wrong.stdout + wrong.stderr, /no verifyPvmAppEvidence export/);
  // and run.mjs refuses to run acceptance cases when the dependency cannot be resolved
  const r = node("verifier/integration/run.mjs", ["--pin", "no-such-pin", "--dir", tmp, "--no-fetch"]);
  assert.equal(r.status, 2); assert.match(r.stderr, /no pin named|NOT resolved/);
});
test("non-strict, module absent: the acceptance cases skip with a stated reason and the suite still passes", () => {
  const r = node("test/verifier-pvm-device.test.mjs", [], { ENCLAVE_PVM_MODULE: "", ENCLAVE_STRICT_INTEGRATION: "" });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /# SKIP owner module absent/);
});
test("the strict integration command passes end to end against the pinned revision, with zero skips", { skip: !havePinned && "pinned commit not in this repository" }, () => {
  const r = node("verifier/integration/run.mjs", ["--dir", tmp, "--no-fetch"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`integration: PASS against ${pin.commit.slice(0, 12)}`)); assert.match(r.stdout, /# skipped 0|skipped 0/);
});
