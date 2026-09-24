#!/usr/bin/env node
// verifier/integration/fixture-check.mjs: FIXTURE PINS. A device-run fixture is a directory copied verbatim from another
// branch's commit; verifier/integration/fixtures.json records, per fixture, the full commit, the path in that commit, the
// directory here and the sha256 of every file. This script re-hashes the directory against the record (every listed
// file present and equal, no unlisted files but SOURCES.json) and, when the commit is in this repository, checks every
// file against the commit's tree with git cat-file, so the fixture is exactly what the owner committed. Exit 0 or 2.
//   node verifier/integration/fixture-check.mjs [--only <name>] [--record <name>]  (--record writes the hashes once)
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : null; };
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const recPath = path.join(REPO, "verifier", "integration", "fixtures.json");
const REC = JSON.parse(fs.readFileSync(recPath, "utf8"));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const git = (...a) => execFileSync("git", a, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
let bad = 0;
const die = (m) => { console.error(`fixture-check: ${m}`); bad++; };
for (const [name, fx] of Object.entries(REC)) {
  if (opt("only") && opt("only") !== name) continue;
  const dir = path.join(REPO, fx.dir);
  if (!/^[0-9a-f]{40}$/.test(fx.commit)) { die(`${name}: the commit must be a full 40-hex hash`); continue; }
  const walk = (d, rel = "") => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name), path.join(rel, e.name)) : [path.join(rel, e.name)]);
  const present = walk(dir).filter((f) => f !== "SOURCES.json").sort();
  if (opt("record") === name) { fx.files = Object.fromEntries(present.map((f) => [f, sha256(fs.readFileSync(path.join(dir, f)))])); fs.writeFileSync(recPath, JSON.stringify(REC, null, 2) + "\n"); console.log(`fixture-check: ${name}: recorded ${present.length} files`); }
  const listed = Object.keys(fx.files || {}).sort();
  if (!listed.length) { die(`${name}: no files recorded (run once with --record ${name})`); continue; }
  for (const f of listed) { let got; try { got = sha256(fs.readFileSync(path.join(dir, f))); } catch { die(`${name}: ${f} missing`); continue; } if (got !== fx.files[f]) die(`${name}: ${f} hashes to ${got.slice(0, 16)}..., recorded ${fx.files[f].slice(0, 16)}...`); }
  for (const f of present) if (!(f in fx.files)) die(`${name}: unlisted file ${f}`);
  let inRepo = true; try { git("cat-file", "-e", `${fx.commit}^{commit}`); } catch { inRepo = false; try { git("fetch", "--quiet", "origin", fx.branch); git("cat-file", "-e", `${fx.commit}^{commit}`); inRepo = true; } catch {} }
  if (inRepo) {
    const tree = git("ls-tree", "-r", "--name-only", fx.commit, fx.path).toString().trim().split("\n").filter(Boolean).map((p) => p.slice(fx.path.length + 1)).sort();
    for (const f of listed) { if (!tree.includes(f)) { die(`${name}: ${f} is not in ${fx.commit.slice(0, 12)}:${fx.path}`); continue; } const blob = git("cat-file", "blob", `${fx.commit}:${fx.path}/${f}`); if (sha256(blob) !== fx.files[f]) die(`${name}: ${f} differs from the commit's blob`); }
    for (const f of tree) if (!(f in fx.files)) die(`${name}: the commit's tree has ${f}, which the fixture lacks`);
    console.log(`fixture-check: ${name}: ${listed.length} files == record == ${fx.commit.slice(0, 12)}:${fx.path}`);
  } else console.log(`fixture-check: ${name}: ${listed.length} files == record (commit ${fx.commit.slice(0, 12)} not reachable here: tree not compared)`);
}
process.exit(bad ? 2 : 0);
