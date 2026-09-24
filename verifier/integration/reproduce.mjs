#!/usr/bin/env node
// verifier/integration/reproduce.mjs: reproduce a pinned BUILD ARTIFACT from its source commit and compare every output
// hash with the pin, in a detached temporary git worktree that is removed afterwards. The lab stand-in for a transparency
// log (docs/security/pvm-client-bootstrap-review.md): two parties building the same commit must get the same bytes.
//   node verifier/integration/reproduce.mjs [--pin pvm-client-artifact] [--keep]
// Exit 0 when every output reproduces byte for byte (prints the hashes); 2 on a missing commit, a wrong tool version, a
// build failure or any hash difference. Nothing here writes into a tracked tree: the build runs inside the temporary
// worktree and its outputs are hashed there.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const PINS = JSON.parse(fs.readFileSync(path.join(REPO, "verifier", "integration", "artifacts.json"), "utf8"));
const name = opt("pin", "pvm-client-artifact"), pin = PINS[name];
// a refusal never exits from inside the build: it throws, the temporary worktree is removed in `finally`, and only then
// does the process exit 2 (an exit inside the try block would skip the cleanup and leave the worktree behind)
class Refusal extends Error {}
const die = (m) => { throw new Refusal(m); };
let wt = null;
const cleanup = () => { if (!wt) return; try { execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: REPO, stdio: "ignore" }); } catch {} fs.rmSync(wt, { recursive: true, force: true }); try { execFileSync("git", ["worktree", "prune"], { cwd: REPO, stdio: "ignore" }); } catch {} wt = null; };
const early = (m) => { console.error(`reproduce: ${m}`); process.exit(2); };
if (!pin) early(`no artifact pin named ${JSON.stringify(name)}`);
if (!/^[0-9a-f]{40}$/.test(pin.commit)) early("the pin's commit must be a full 40-hex hash");
const git = (...a) => execFileSync("git", a, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] }).toString();
try { git("cat-file", "-e", `${pin.commit}^{commit}`); } catch { try { git("fetch", "--quiet", "origin", pin.branch); } catch {} }
try { git("cat-file", "-e", `${pin.commit}^{commit}`); } catch { early(`commit ${pin.commit} is not in this repository or reachable from origin/${pin.branch}`); }
// the pinned tool: exact version, from this worktree's node_modules (never downloaded here)
const tool = path.join(REPO, "node_modules", ".bin", pin.tool.name);
let ver = ""; try { ver = execFileSync(tool, ["--version"]).toString().trim(); } catch { early(`${pin.tool.name} is not installed under node_modules (need ${pin.tool.version})`); }
if (ver !== pin.tool.version) early(`${pin.tool.name} ${ver} is installed, the pin requires ${pin.tool.version}`);
try {
  wt = fs.mkdtempSync(path.join(os.tmpdir(), "reproduce-"));
  execFileSync("git", ["worktree", "add", "--detach", wt, pin.commit], { cwd: REPO, stdio: "ignore" });
  const dir = path.join(wt, pin.buildDir);
  // the committed outputs must equal the pin BEFORE building (the pin is the claim under test)
  for (const [out, want] of Object.entries(pin.outputs)) {
    const got = createHash("sha256").update(fs.readFileSync(path.join(dir, pin.distDir, out))).digest("hex");
    if (got !== want.sha256) die(`committed ${out} at ${pin.commit.slice(0, 12)} hashes to ${got.slice(0, 16)}..., the pin says ${want.sha256.slice(0, 16)}...`);
  }
  // a fresh build, compared by the recipe's own --check (byte for byte against the committed dist)
  const r = spawnSync("bash", [pin.buildScript, "--check"], { cwd: dir, encoding: "utf8", env: { ...process.env, [pin.tool.env]: tool } });
  if (r.status !== 0) die(`the build did not reproduce: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
  // and independently: hash the committed outputs again and every listed input
  const build = JSON.parse(fs.readFileSync(path.join(dir, pin.distDir, "BUILD.json"), "utf8"));
  for (const [inp, want] of Object.entries(build.inputs)) {
    const got = createHash("sha256").update(fs.readFileSync(path.join(dir, inp))).digest("hex");
    if (got !== want) die(`input ${inp} hashes to ${got.slice(0, 16)}..., BUILD.json says ${want.slice(0, 16)}...`);
  }
  if (build[pin.tool.name] !== pin.tool.version) die(`BUILD.json names ${pin.tool.name} ${build[pin.tool.name]}, the pin ${pin.tool.version}`);
  for (const [out, want] of Object.entries(pin.outputs)) {
    const b = fs.readFileSync(path.join(dir, pin.distDir, out)); const got = createHash("sha256").update(b).digest("hex");
    if (got !== want.sha256 || b.length !== want.size) die(`${out}: ${got.slice(0, 16)}... (${b.length} bytes) vs the pin ${want.sha256.slice(0, 16)}... (${want.size})`);
    console.log(`reproduce: ${out} sha256 ${got} (${b.length} bytes) == pin`);
  }
  // no code-loading construct that reaches a URL: the only import() must be the pinned allowlist
  for (const [out, rule] of Object.entries(pin.codeLoading || {})) {
    const src = fs.readFileSync(path.join(dir, pin.distDir, out)).toString("latin1");
    const dyn = [...src.matchAll(/import\(([^)]{0,80})\)/g)].map((m) => m[1].trim());
    const bad = dyn.filter((d) => !rule.allowedDynamicImports.includes(d));
    if (bad.length) die(`${out}: dynamic import(s) not on the pin's allowlist: ${bad.join(" | ")}`);
    if (/\beval\(|new Function\(|importScripts\(/.test(src)) die(`${out}: eval, new Function or importScripts present`);
    console.log(`reproduce: ${out}: ${dyn.length} dynamic import(s), all on the allowlist (${rule.allowedDynamicImports.join(", ")}); no eval / new Function / importScripts`);
  }
  console.log(`reproduce: ${name} @ ${pin.commit} REPRODUCED with ${pin.tool.name} ${ver}`);
} catch (e) {
  if (!args.includes("--keep")) cleanup();
  console.error(`reproduce: ${e instanceof Refusal ? e.message : `unexpected: ${e.message}`}`); process.exit(2);
} finally { if (!args.includes("--keep")) cleanup(); }
