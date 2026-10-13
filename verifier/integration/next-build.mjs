#!/usr/bin/env node
// verifier/integration/next-build.mjs: build a "next" version of the REAL pinned client from the pinned SOURCE, reproducibly,
// for the activation cases that need an activated client able to commit policies (a canary cannot). In a detached temporary
// worktree of the artifact pin's commit, exactly one line of client/src/trust.js is replaced (CLIENT_VERSION), the pinned
// build script runs with the pinned esbuild, and dist/pvm-client.mjs is copied out under <dir>/next-<commit12>/<version>/.
// Every produced artifact's sha256 and size must equal verifier/integration/next-builds.json (the record under test), or
// nothing is kept and the exit is 2; the record is written only with --record, once, when first produced.
//   node verifier/integration/next-build.mjs [--dir .verifier-integration] [--record]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const ART = JSON.parse(fs.readFileSync(path.join(REPO, "verifier", "integration", "artifacts.json"), "utf8"))["pvm-client-artifact"];
const recPath = path.join(REPO, "verifier", "integration", "next-builds.json");
const FILE = JSON.parse(fs.readFileSync(recPath, "utf8"));
const REC = FILE.bases && FILE.bases[FILE.current] ? { base: FILE.current, ...FILE.bases[FILE.current] } : null;
if (!REC) { console.error("next-build: next-builds.json has no record for its current base"); process.exit(2); }
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
class Refusal extends Error {}
const die = (m) => { throw new Refusal(m); };
let wt = null;
const cleanup = () => { if (!wt) return; try { execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: REPO, stdio: "ignore" }); } catch {} fs.rmSync(wt, { recursive: true, force: true }); try { execFileSync("git", ["worktree", "prune"], { cwd: REPO, stdio: "ignore" }); } catch {} wt = null; };
if (REC.base !== ART.commit) { console.error(`next-build: the record's base ${REC.base.slice(0, 12)} is not the pinned artifact commit ${ART.commit.slice(0, 12)}: re-record after a re-pin`); process.exit(2); }
const tool = path.join(REPO, "node_modules", ".bin", ART.tool.name);
let ver = ""; try { ver = execFileSync(tool, ["--version"]).toString().trim(); } catch {}
if (ver !== ART.tool.version) { console.error(`next-build: ${ART.tool.name} ${ver || "missing"}, the pin requires ${ART.tool.version}`); process.exit(2); }
const outBase = path.resolve(REPO, opt("dir", ".verifier-integration"), `next-${ART.commit.slice(0, 12)}`);
const staging = `${outBase}.staging-${process.pid}`;
try {
  wt = fs.mkdtempSync(path.join(os.tmpdir(), "next-build-"));
  execFileSync("git", ["worktree", "add", "--detach", wt, ART.commit], { cwd: REPO, stdio: "ignore" });
  const dir = path.join(wt, ART.buildDir), trust = path.join(dir, "src", "trust.js");
  const original = fs.readFileSync(trust, "utf8");
  const line = `export const CLIENT_VERSION = ${JSON.stringify(REC.baseVersion)};`;
  if (original.split("\n").filter((l) => l.startsWith(line)).length !== 1) die(`src/trust.js at ${ART.commit.slice(0, 12)} does not carry exactly one line starting ${line}`);
  fs.rmSync(staging, { recursive: true, force: true }); fs.mkdirSync(staging, { recursive: true });
  const produced = {};
  for (const version of Object.keys(REC.builds)) {
    fs.writeFileSync(trust, original.replace(line, `export const CLIENT_VERSION = ${JSON.stringify(version)};`));
    const r = spawnSync("bash", [ART.buildScript], { cwd: dir, encoding: "utf8", env: { ...process.env, [ART.tool.env]: tool } });
    if (r.status !== 0) die(`the build of ${version} failed: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
    const bytes = fs.readFileSync(path.join(dir, ART.distDir, "pvm-client.mjs"));
    const first = bytes.subarray(0, 200).toString().split("\n")[0];
    if (!first.startsWith(`/*! enclave-pvm-client ${version} `)) die(`${version}: the built artifact's first line is ${JSON.stringify(first.slice(0, 60))}`);
    produced[version] = { sha256: sha256(bytes), size: bytes.length };
    fs.mkdirSync(path.join(staging, version), { recursive: true }); fs.writeFileSync(path.join(staging, version, "pvm-client.mjs"), bytes);
  }
  if (args.includes("--record")) {
    for (const [v, got] of Object.entries(produced)) { if (REC.builds[v].sha256 && REC.builds[v].sha256 !== got.sha256) die(`${v} already recorded as ${REC.builds[v].sha256.slice(0, 16)}..., built ${got.sha256.slice(0, 16)}...: not overwriting`); REC.builds[v] = { ...REC.builds[v], ...got }; }
    FILE.bases[FILE.current] = { baseVersion: REC.baseVersion, builds: REC.builds, derived: REC.derived, ...(FILE.bases[FILE.current].recordedWhenCurrent ? { recordedWhenCurrent: FILE.bases[FILE.current].recordedWhenCurrent } : { recordedWhenCurrent: new Date().toISOString().slice(0, 10) }) }; fs.writeFileSync(recPath, JSON.stringify(FILE, null, 2) + "\n");
  }
  for (const [v, got] of Object.entries(produced)) {
    const want = REC.builds[v];
    if (!want.sha256) die(`${v}: no recorded sha256 (run once with --record)`);
    if (got.sha256 !== want.sha256 || got.size !== want.size) die(`${v}: built ${got.sha256.slice(0, 16)}... (${got.size} bytes), recorded ${want.sha256.slice(0, 16)}... (${want.size}): NOT REPRODUCED`);
    console.log(`next-build: ${v} sha256 ${got.sha256} (${got.size} bytes) == record`);
  }
  // the owner's DERIVED recipe (their client/tools/lab-next.mjs, reimplemented here from its description): from the pinned DIST
  // bytes, line 1 becomes a marked banner naming the base and its sha256, and the single `var CLIENT_VERSION = "<base>";`
  // becomes the next version; nothing else changes. Its bytes are recorded, and they must equal this script's source
  // rebuild of the same version in every byte but the first line: that ties the device artifact to the pinned source.
  const distBytes = fs.readFileSync(path.join(dir, ART.distDir, "pvm-client.mjs"));   // the pinned dist (the last build above overwrote it: re-read from git)
  const pinnedDist = Buffer.from(execFileSync("git", ["cat-file", "blob", `${ART.commit}:${ART.buildDir}/${ART.distDir}/pvm-client.mjs`], { cwd: REPO, maxBuffer: 64 << 20 }));
  if (sha256(pinnedDist) !== ART.outputs["pvm-client.mjs"].sha256) die("the pinned dist read from git does not hash to the artifact pin");
  const derived = {};
  for (let [version, want] of Object.entries(REC.derived || {})) {
    const text = pinnedDist.toString("latin1"), nl = text.indexOf("\n");
    const banner = want.banner.replace("<baseSha256>", sha256(pinnedDist)).replace("<version>", version).replace("<baseVersion>", REC.baseVersion);
    const rest = text.slice(nl), needle = `var CLIENT_VERSION = ${JSON.stringify(REC.baseVersion)};`;
    if (rest.split(needle).length !== 2) die(`the pinned dist does not carry exactly one ${needle}`);
    const bytes = Buffer.from(banner + rest.replace(needle, `var CLIENT_VERSION = ${JSON.stringify(version)};`), "latin1");
    derived[version] = { sha256: sha256(bytes), size: bytes.length };
    const rebuilt = fs.readFileSync(path.join(staging, version, "pvm-client.mjs"));
    const body = (b) => b.subarray(b.indexOf(10));
    if (!body(bytes).equals(body(rebuilt))) die(`derived ${version} differs from the source rebuild beyond the first line`);
    fs.mkdirSync(path.join(staging, "derived", version), { recursive: true }); fs.writeFileSync(path.join(staging, "derived", version, "pvm-client.mjs"), bytes);
    if (args.includes("--record")) { if (want.sha256 && want.sha256 !== derived[version].sha256) die(`derived ${version} already recorded as ${want.sha256.slice(0, 16)}...: not overwriting`); REC.derived[version] = { ...want, ...derived[version] }; want = REC.derived[version]; FILE.bases[FILE.current].derived = REC.derived; fs.writeFileSync(recPath, JSON.stringify(FILE, null, 2) + "\n"); }
    if (!want.sha256) die(`derived ${version}: no recorded sha256 (run once with --record)`);
    if (want.sha256 !== derived[version].sha256 || want.size !== derived[version].size) die(`derived ${version}: ${derived[version].sha256.slice(0, 16)}... (${derived[version].size} bytes), recorded ${want.sha256.slice(0, 16)}... (${want.size}): NOT REPRODUCED`);
    console.log(`next-build: derived ${version} sha256 ${derived[version].sha256} (${derived[version].size} bytes) == record; equals the source rebuild beyond line 1`);
  }
  fs.writeFileSync(path.join(staging, "MANIFEST.json"), JSON.stringify({ base: ART.commit, baseVersion: REC.baseVersion, tool: `${ART.tool.name} ${ver}`, builds: produced, derived, at: new Date().toISOString() }, null, 2) + "\n");
  fs.rmSync(outBase, { recursive: true, force: true }); fs.renameSync(staging, outBase);
  console.log(outBase);
} catch (e) {
  fs.rmSync(staging, { recursive: true, force: true }); fs.rmSync(outBase, { recursive: true, force: true });
  console.error(`next-build: ${e instanceof Refusal ? e.message : `unexpected: ${e.message}`}`); process.exit(2);
} finally { cleanup(); }
