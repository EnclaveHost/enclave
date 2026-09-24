#!/usr/bin/env node
// verifier/integration/resolve.mjs: materialise a PINNED revision of another branch's module into an isolated,
// gitignored directory, so the acceptance suites run against exactly that code from a clean checkout.
//
//   node verifier/integration/resolve.mjs [--pin pvm-app-attest] [--dir .verifier-integration] [--no-fetch] [--json]
//
// The pin (verifier/integration/pins.json) names the branch, the FULL commit, the files and their blob sha256s.
// Every file is read from that commit's tree with git cat-file (never from a working tree), hash-checked against
// the pin, and written under <dir>/<pin>-<commit12>/<path>; a MANIFEST.json records what was resolved. Files the
// pin lists in mustMatchWorktree must ALSO equal this worktree's copy, because the adapter's own delegation uses
// the worktree's file (a run that mixed two versions of relay/avf-verify.mjs would test neither).
// Exit 0 on success (prints the entry module's absolute path), 2 on any mismatch or missing object. Nothing here
// touches a tracked file, and nothing is written outside <dir>.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes("--" + n);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const PINS = JSON.parse(fs.readFileSync(path.join(REPO, "verifier", "integration", "pins.json"), "utf8"));
const name = opt("pin", "pvm-app-attest"), pin = PINS[name];
const die = (m) => { console.error(`resolve: ${m}`); process.exit(2); };
if (!pin) die(`no pin named ${JSON.stringify(name)}`);
if (!/^[0-9a-f]{40}$/.test(pin.commit)) die("the pin's commit must be a full 40-hex hash");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const git = (...a) => execFileSync("git", a, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
const have = () => { try { git("cat-file", "-e", `${pin.commit}^{commit}`); return true; } catch { return false; } };
if (!have()) {
  if (flag("no-fetch")) die(`commit ${pin.commit} is not in this repository and --no-fetch was given`);
  try { git("fetch", "--quiet", "origin", pin.branch); } catch (e) { die(`fetch of ${pin.branch} failed: ${e.message}`); }
  if (!have()) die(`commit ${pin.commit} is not reachable from origin/${pin.branch}; the pin is stale or the branch was rewritten`);
}
const outDir = path.resolve(REPO, opt("dir", ".verifier-integration"), `${name}-${pin.commit.slice(0, 12)}`);
fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
const manifest = { pin: name, branch: pin.branch, commit: pin.commit, entry: null, files: {}, resolvedAt: new Date().toISOString() };
for (const [rel, want] of Object.entries(pin.files)) {
  let blob; try { blob = git("cat-file", "blob", `${pin.commit}:${rel}`); } catch { die(`${rel} does not exist at ${pin.commit.slice(0, 12)}`); }
  const got = sha256(blob);
  if (got !== want) die(`${rel} at ${pin.commit.slice(0, 12)} hashes to ${got.slice(0, 16)}..., the pin says ${want.slice(0, 16)}...: the pin and the commit disagree`);
  if ((pin.mustMatchWorktree || []).includes(rel)) {
    let local; try { local = sha256(fs.readFileSync(path.join(REPO, rel))); } catch { die(`${rel} must match the worktree but the worktree has no such file`); }
    if (local !== want) die(`${rel} differs between the pinned commit and this worktree (${local.slice(0, 16)}... vs ${want.slice(0, 16)}...); a mixed run tests neither`);
  }
  const dst = path.join(outDir, rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, blob);
  manifest.files[rel] = got;
}
manifest.entry = path.join(outDir, pin.entry);
fs.writeFileSync(path.join(outDir, "MANIFEST.json"), JSON.stringify(manifest, null, 1));
if (flag("json")) console.log(JSON.stringify(manifest)); else console.log(manifest.entry);
