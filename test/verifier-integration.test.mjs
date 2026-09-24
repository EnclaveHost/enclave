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
// An isolated root that resolve.mjs treats as the repository: its own copy of the script and pins, .git pointing at
// this repository (so the pinned commit is readable), and a REAL relay/ directory whose avf-verify.mjs bytes are
// whatever the case needs. This is how a genuine worktree mismatch is produced, rather than a pin-hash mismatch.
function isolatedRoot({ avfVerifyBytes = fs.readFileSync(path.join(REPO, "relay/avf-verify.mjs")), mutatePins = null } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "root-"));
  const p = JSON.parse(JSON.stringify(PINS)); if (mutatePins) mutatePins(p["pvm-app-attest"]);
  fs.mkdirSync(path.join(dir, "verifier/integration"), { recursive: true });
  fs.writeFileSync(path.join(dir, "verifier/integration/pins.json"), JSON.stringify(p));
  fs.copyFileSync(path.join(REPO, "verifier/integration/resolve.mjs"), path.join(dir, "verifier/integration/resolve.mjs"));
  fs.symlinkSync(path.join(REPO, ".git"), path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, "relay")); fs.writeFileSync(path.join(dir, "relay/avf-verify.mjs"), avfVerifyBytes);
  return dir;
}
const resolveIn = (root, out) => spawnSync(process.execPath, [path.join(root, "verifier/integration/resolve.mjs"), "--dir", out, "--no-fetch"], { encoding: "utf8", env: childEnv({}) });
const leftovers = (out) => { try { return fs.readdirSync(out); } catch { return []; } };
const entryOf = (out) => path.join(out, `pvm-app-attest-${pin.commit.slice(0, 12)}`, "relay/pvm-app-attest.mjs");
const nothingLeft = (out, what) => { assert.deepEqual(leftovers(out), [], `${what}: the output directory must be empty (no entry, no manifest, no staging), got ${leftovers(out).join(", ")}`); };

test("resolve: a wrong commit fails with exit 2 and leaves nothing", { skip: !havePinned && "pinned commit not in this repository" }, () => {
  const out = path.join(tmp, "o-wrong"); const r = resolveIn(isolatedRoot({ mutatePins: (q) => { q.commit = "0".repeat(40); } }), out);
  assert.equal(r.status, 2); assert.match(r.stderr, /not in this repository|not reachable/); nothingLeft(out, "wrong commit");
});
test("resolve: a REAL worktree mismatch (second file) fails after the first blob validated, and the first blob is NOT left behind", { skip: !havePinned && "pinned commit not in this repository" }, () => {
  const real = fs.readFileSync(path.join(REPO, "relay/avf-verify.mjs"));
  const out = path.join(tmp, "o-mismatch");
  const r = resolveIn(isolatedRoot({ avfVerifyBytes: Buffer.concat([real, Buffer.from("\n// local edit: not the pinned bytes\n")]) }), out);
  assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /avf-verify\.mjs differs between the pinned commit and this worktree/);
  assert.equal(fs.existsSync(entryOf(out)), false, "the first blob (pvm-app-attest.mjs) must not have been written"); nothingLeft(out, "worktree mismatch");
  // the same with the worktree file missing altogether
  const gone = isolatedRoot(); fs.rmSync(path.join(gone, "relay/avf-verify.mjs"));
  const r2 = resolveIn(gone, path.join(tmp, "o-missing")); assert.equal(r2.status, 2); assert.match(r2.stderr, /worktree has no such file/); nothingLeft(path.join(tmp, "o-missing"), "worktree file missing");
});
test("resolve: a tampered hash on the SECOND file leaves no entry for the first", { skip: !havePinned && "pinned commit not in this repository" }, () => {
  const out = path.join(tmp, "o-second"); const r = resolveIn(isolatedRoot({ mutatePins: (q) => { q.files["relay/avf-verify.mjs"] = "f".repeat(64); } }), out);
  assert.equal(r.status, 2); assert.match(r.stderr, /the pin and the commit disagree/); assert.equal(fs.existsSync(entryOf(out)), false); nothingLeft(out, "second-file hash");
  const out1 = path.join(tmp, "o-first"); const r1 = resolveIn(isolatedRoot({ mutatePins: (q) => { q.files["relay/pvm-app-attest.mjs"] = "e".repeat(64); } }), out1);
  assert.equal(r1.status, 2); nothingLeft(out1, "first-file hash");
});
test("resolve: a stale prior success does not survive a later refusal", { skip: !havePinned && "pinned commit not in this repository" }, () => {
  const out = path.join(tmp, "o-stale");
  const ok = resolveIn(isolatedRoot(), out); assert.equal(ok.status, 0, ok.stderr); assert.ok(fs.existsSync(entryOf(out))); assert.ok(fs.existsSync(path.join(path.dirname(entryOf(out)), "..", "MANIFEST.json")));
  const real = fs.readFileSync(path.join(REPO, "relay/avf-verify.mjs"));
  const bad = resolveIn(isolatedRoot({ avfVerifyBytes: Buffer.concat([real, Buffer.from("\n// drift\n")]) }), out);
  assert.equal(bad.status, 2); nothingLeft(out, "stale prior success after a refusal");
  // and a crashed run's staging directory is swept by the next successful run
  fs.mkdirSync(path.join(out, `pvm-app-attest-${pin.commit.slice(0, 12)}.staging-99999`, "relay"), { recursive: true });
  const again = resolveIn(isolatedRoot(), out); assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(leftovers(out), [`pvm-app-attest-${pin.commit.slice(0, 12)}`]);
});
test("strict mode: a missing or wrong module FAILS the acceptance suites instead of skipping them", () => {
  const missing = node("test/verifier-pvm-device.test.mjs", [], { ENCLAVE_PVM_MODULE: path.join(tmp, "nope.mjs"), ENCLAVE_STRICT_INTEGRATION: "1" });
  assert.notEqual(missing.status, 0); assert.match(missing.stdout + missing.stderr, /strict integration: the owner's module is missing or unusable/);
  const bogus = path.join(tmp, "bogus.mjs"); fs.writeFileSync(bogus, "export const somethingElse = 1;\n");
  const wrong = node("test/verifier-pvm-device.test.mjs", [], { ENCLAVE_PVM_MODULE: bogus, ENCLAVE_STRICT_INTEGRATION: "1" });
  assert.notEqual(wrong.status, 0); assert.match(wrong.stdout + wrong.stderr, /no verifyPvmAppEvidence export/);
  // and run.mjs refuses to run acceptance cases when a dependency cannot be resolved (here: the output path is blocked by a file)
  const blocked = path.join(tmp, "blocked"); fs.writeFileSync(blocked, "not a directory");
  const r = node("verifier/integration/run.mjs", ["--dir", path.join(blocked, "out"), "--no-fetch"]);
  assert.equal(r.status, 2); assert.match(r.stderr, /could not materialise|NOT resolved/);
});
test("non-strict, module absent: the acceptance cases skip with a stated reason and the suite still passes", () => {
  const r = node("test/verifier-pvm-device.test.mjs", [], { ENCLAVE_PVM_MODULE: "", ENCLAVE_STRICT_INTEGRATION: "" });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /# SKIP owner module absent/);
});
// over a minute end to end (it runs every acceptance suite): behind an explicit switch so a plain `node --test` run of the
// whole tree stays under the per-file limit; the strict command itself is the acceptance path and runs every suite anyway
const E2E = process.env.ENCLAVE_INTEGRATION_E2E === "1";
test("the strict integration command passes end to end against the pinned revision, with zero skips", { skip: !havePinned ? "pinned commit not in this repository" : !E2E && "ENCLAVE_INTEGRATION_E2E=1 runs it (over a minute; the strict command is the acceptance path)" }, () => {
  const r = node("verifier/integration/run.mjs", ["--dir", tmp, "--no-fetch"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`integration: PASS against ${pin.commit.slice(0, 12)}`)); assert.match(r.stdout, /# skipped 0|skipped 0/);
});

// ---- build-artifact reproduction (verifier/integration/reproduce.mjs) ----------------------------------------------------
const ART = JSON.parse(fs.readFileSync(path.join(REPO, "verifier/integration/artifacts.json"), "utf8"));
const art = ART["pvm-client-artifact"];
const haveArt = (() => { try { execFileSync("git", ["cat-file", "-e", `${art.commit}^{commit}`], { cwd: REPO, stdio: "ignore" }); return true; } catch { return false; } })();
const haveTool = (() => { try { return execFileSync(path.join(REPO, "node_modules/.bin", art.tool.name), ["--version"]).toString().trim() === art.tool.version; } catch { return false; } })();
test("the artifact pin is explicit: full commit, the build tool's exact version, every output's sha256 and size, the dynamic-import allowlist", () => {
  assert.match(art.commit, /^[0-9a-f]{40}$/); assert.equal(art.tool.version, "0.28.1");
  for (const o of Object.values(art.outputs)) { assert.match(o.sha256, /^[0-9a-f]{64}$/); assert.ok(Number.isInteger(o.size) && o.size > 0); }
  assert.deepEqual(art.codeLoading["pvm-client.mjs"].allowedDynamicImports, ['"crypto"']);
});
test("reproduce: the pinned client artifact rebuilds byte for byte in a detached worktree that is removed afterwards", { skip: (!haveArt && "pinned commit not in this repository") || (!haveTool && `${art.tool.name} ${art.tool.version} not installed`) }, () => {
  const before = execFileSync("git", ["worktree", "list"], { cwd: REPO }).toString();
  const r = node("verifier/integration/reproduce.mjs", []);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const [out, want] of Object.entries(art.outputs)) assert.match(r.stdout, new RegExp(`${out} sha256 ${want.sha256} \\(${want.size} bytes\\) == pin`));
  assert.match(r.stdout, /REPRODUCED/); assert.match(r.stdout, /no eval \/ new Function \/ importScripts/);
  assert.equal(execFileSync("git", ["worktree", "list"], { cwd: REPO }).toString(), before, "the temporary worktree was removed");
});
test("reproduce: a pin whose output hash is wrong, or whose commit is unknown, fails with exit 2 and leaves no worktree", { skip: (!haveArt && "pinned commit not in this repository") || (!haveTool && `${art.tool.name} ${art.tool.version} not installed`) }, () => {
  const withArt = (mut) => { const dir = fs.mkdtempSync(path.join(tmp, "art-")); const p = JSON.parse(JSON.stringify(ART)); mut(p["pvm-client-artifact"]);
    fs.mkdirSync(path.join(dir, "verifier/integration"), { recursive: true }); fs.writeFileSync(path.join(dir, "verifier/integration/artifacts.json"), JSON.stringify(p));
    fs.copyFileSync(path.join(REPO, "verifier/integration/reproduce.mjs"), path.join(dir, "verifier/integration/reproduce.mjs"));
    for (const f of [".git", "node_modules"]) fs.symlinkSync(path.join(REPO, f), path.join(dir, f)); return dir; };
  const before = execFileSync("git", ["worktree", "list"], { cwd: REPO }).toString();
  const wrongHash = withArt((q) => { q.outputs["pvm-client.mjs"].sha256 = "0".repeat(64); });
  const r1 = spawnSync(process.execPath, [path.join(wrongHash, "verifier/integration/reproduce.mjs")], { encoding: "utf8", env: childEnv({}) });
  assert.equal(r1.status, 2); assert.match(r1.stderr, /hashes to .* the pin says/);
  const wrongCommit = withArt((q) => { q.commit = "0".repeat(40); });
  const r2 = spawnSync(process.execPath, [path.join(wrongCommit, "verifier/integration/reproduce.mjs")], { encoding: "utf8", env: childEnv({}) });
  assert.equal(r2.status, 2); assert.match(r2.stderr, /not in this repository/);
  const wrongTool = withArt((q) => { q.tool.version = "0.0.1"; });
  const r3 = spawnSync(process.execPath, [path.join(wrongTool, "verifier/integration/reproduce.mjs")], { encoding: "utf8", env: childEnv({}) });
  assert.equal(r3.status, 2); assert.match(r3.stderr, /the pin requires 0\.0\.1/);
  const badImport = withArt((q) => { q.codeLoading["pvm-client.mjs"].allowedDynamicImports = []; });
  const r4 = spawnSync(process.execPath, [path.join(badImport, "verifier/integration/reproduce.mjs")], { encoding: "utf8", env: childEnv({}) });
  assert.equal(r4.status, 2); assert.match(r4.stderr, /not on the pin's allowlist/);
  assert.equal(execFileSync("git", ["worktree", "list"], { cwd: REPO }).toString(), before, "no temporary worktree survives a refusal");
});
