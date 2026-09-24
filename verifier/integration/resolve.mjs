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
// Materialisation is TRANSACTIONAL: every blob is read and hash-checked, and every worktree match verified, before a
// single byte is written; the files then go into a staging directory beside the target, the manifest is written last,
// and the staging directory is renamed into place. On ANY failure nothing is left behind: no partial entry, no
// manifest, and no stale prior materialisation of the same pin (a prior success is removed rather than served next to
// a refusal). Exit 0 on success (prints the entry module's absolute path), 2 on any mismatch or missing object.
// Nothing here touches a tracked file, and nothing is written outside <dir>.
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
const baseDir = path.resolve(REPO, opt("dir", ".verifier-integration"));
const outDir = path.join(baseDir, `${name}-${pin.commit.slice(0, 12)}`);
const staging = `${outDir}.staging-${process.pid}`;
// a refusal leaves nothing: no staging (this run's or a crashed one's) and no prior materialisation of this pin
const cleanAll = () => { for (const d of safeList(baseDir)) if (d === path.basename(outDir) || d.startsWith(`${path.basename(outDir)}.staging-`)) fs.rmSync(path.join(baseDir, d), { recursive: true, force: true }); };
function safeList(d) { try { return fs.readdirSync(d); } catch { return []; } }
const refuse = (m) => { cleanAll(); die(m); };

// 1. validate EVERYTHING in memory first
const blobs = new Map();
for (const [rel, want] of Object.entries(pin.files)) {
  let blob; try { blob = git("cat-file", "blob", `${pin.commit}:${rel}`); } catch { refuse(`${rel} does not exist at ${pin.commit.slice(0, 12)}`); }
  const got = sha256(blob);
  if (got !== want) refuse(`${rel} at ${pin.commit.slice(0, 12)} hashes to ${got.slice(0, 16)}..., the pin says ${want.slice(0, 16)}...: the pin and the commit disagree`);
  if ((pin.mustMatchWorktree || []).includes(rel)) {
    let local; try { local = sha256(fs.readFileSync(path.join(REPO, rel))); } catch { refuse(`${rel} must match the worktree but the worktree has no such file`); }
    if (local !== want) refuse(`${rel} differs between the pinned commit and this worktree (${local.slice(0, 16)}... vs ${want.slice(0, 16)}...); a mixed run tests neither`);
  }
  blobs.set(rel, { blob, got });
}
if (!blobs.has(pin.entry)) refuse(`the pin's entry ${pin.entry} is not among its files`);

// 2. stage, manifest last, then rename into place
const manifest = { pin: name, branch: pin.branch, commit: pin.commit, dir: outDir, entry: path.join(outDir, pin.entry), files: {}, resolvedAt: new Date().toISOString() };
try {
  cleanAll(); fs.mkdirSync(staging, { recursive: true });
  for (const [rel, { blob, got }] of blobs) { const dst = path.join(staging, rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, blob); manifest.files[rel] = got; }
  fs.writeFileSync(path.join(staging, "MANIFEST.json"), JSON.stringify(manifest, null, 1));
  fs.renameSync(staging, outDir);
} catch (e) { refuse(`could not materialise: ${e.message}`); }
if (flag("json")) console.log(JSON.stringify(manifest)); else console.log(manifest.entry);
