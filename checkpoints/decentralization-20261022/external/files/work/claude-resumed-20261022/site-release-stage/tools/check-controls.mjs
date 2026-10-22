#!/usr/bin/env node
// check-controls.mjs <release dir> <stage src> <base dir> <out dir>: runs release-check.mjs (r2) once on the real built dist (must
// pass) and on isolated ALTERED COPIES of that dist (each must fail with exactly the expected failures). The release, the stage
// source and the base are only read; every altered dist is a fresh copy under <out dir>/tmp, removed after its run.
//   old-chunk-current  an inherited base chunk that carries the old dashboard wording is made a CURRENT file (copied into the
//                      dist, as if the build had produced it): bytes in the release are identical, so only the wording fails
//   old-text-injected  the old wording appended to the current dashboard chunk: the wording AND the byte-identity fail
//   car-chunk-absent   the ipfs-car chunk (+ map) left out of the dist: the release's copies are unexplained, the reader's
//                      dynamic import no longer names a current chunk
//   deadline-absent    the config reader's deadline marker renamed in its chunk: marker, byte-identity and both import checks fail
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const [REL, SRC, BASE, OUT] = process.argv.slice(2).map((p) => path.resolve(p));
const CHECK = path.join(path.dirname(new URL(import.meta.url).pathname), "release-check.mjs"), DIST = path.join(SRC, "site/dist");
const TMP = path.join(OUT, "tmp");
if (fs.existsSync(TMP)) { console.error(`${TMP} exists`); process.exit(2); }
const run = (name, dist) => {
  const out = path.join(OUT, name), args = [CHECK, REL, SRC, BASE, out, ...(dist ? ["--dist", dist] : [])];
  const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 << 20 });
  fs.writeFileSync(path.join(out + ".out"), r.stdout + r.stderr);
  const rep = fs.existsSync(path.join(out, "release-check.json")) ? JSON.parse(fs.readFileSync(path.join(out, "release-check.json"), "utf8")) : null;
  return { status: r.status, rep };
};
const altered = (name, mutate) => {
  const d = path.join(TMP, name);
  fs.cpSync(DIST, d, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  const facts = mutate(d);
  try { return { ...run(name, d), facts }; } finally { fs.rmSync(d, { recursive: true, force: true }); }
};
const results = [], ok = [];
const expect = (name, r, want) => {
  const got = r.rep?.failures ?? null, pass = want === null ? r.status === 0 && got?.length === 0
    : r.status === 1 && JSON.stringify([...got].sort()) === JSON.stringify([...want].sort());
  results.push({ name, exit: r.status, expectedFailures: want, failures: got, facts: r.facts, pass }); ok.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: exit ${r.status}, ${got?.length ?? "no report"} failures`);
};
fs.mkdirSync(TMP, { recursive: true });
// positive: the real built dist
const real = run("real", null); expect("real", real, null);
const rep = real.rep;
const reader = rep.configRead.readers[0], car = rep.configRead.car[0], sp = rep.configRead.storagePlan[0];
const oldChunk = rep.oldWording.inheritedOnly.find((p) => p.endsWith(".js"));
const dashboard = fs.readdirSync(path.join(DIST, "js/chunks")).find((n) => /^dashboard-[A-Z0-9]+\.js$/.test(n));
expect("old-chunk-current", altered("old-chunk-current", (d) => { fs.copyFileSync(path.join(REL, "site", oldChunk), path.join(d, oldChunk), fs.constants.COPYFILE_EXCL); return { madeCurrent: oldChunk }; }),
  [`a current file carries the old dashboard wording: ${oldChunk}`]);
const dp = "js/chunks/" + dashboard;
expect("old-text-injected", altered("old-text-injected", (d) => { fs.appendFileSync(path.join(d, dp), ';" - retrying automatically";\n'); return { injectedInto: dp }; }),
  [`a current file carries the old dashboard wording: ${dp}`, `current built file ${dp} is not in the release byte-identical`]);
expect("car-chunk-absent", altered("car-chunk-absent", (d) => { fs.rmSync(path.join(d, car)); fs.rmSync(path.join(d, car + ".map")); return { removed: [car, car + ".map"] }; }),
  [`release file ${car} is neither built, prepare metadata, nor a base chunk byte-identical`, `release file ${car}.map is neither built, prepare metadata, nor a base chunk byte-identical`,
   `config reader imports ${car}, which is not a current chunk exporting verifyCar/carCap`]);
expect("deadline-absent", altered("deadline-absent", (d) => { const f = path.join(d, reader), t = fs.readFileSync(f, "utf8");
  if (!t.includes("config read deadline passed")) throw new Error("reader lacks the marker"); fs.writeFileSync(f, t.replace("config read deadline passed", "config read deadline PASSED")); return { renamedIn: reader }; }),
  ["not in the CURRENT build: verified config read: round deadline", `current built file ${reader} is not in the release byte-identical`,
   "the config reader has no dynamic import of an ipfs-car chunk", "the config reader has no dynamic import of a storage-plan chunk"]);
fs.rmdirSync(TMP);
const summary = { checker: CHECK, release: REL, dist: DIST, controls: results, storagePlanChunk: sp, allPass: ok.every(Boolean) };
fs.writeFileSync(path.join(OUT, "controls.json"), JSON.stringify(summary, null, 1) + "\n");
console.log(summary.allPass ? "CONTROLS-OK" : "CONTROLS-FAILED"); process.exit(summary.allPass ? 0 : 1);
