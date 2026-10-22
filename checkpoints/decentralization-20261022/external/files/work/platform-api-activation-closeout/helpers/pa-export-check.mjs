#!/usr/bin/env node
// pa-export-check.mjs -- OPAQUE check and frozen copy of the old API's state for the genesis import. ROOT RUNS IT, on the
// box that holds it, AFTER the old API is fenced (stopped, autostart disabled). Not run by the worker.
//
//   node pa-export-check.mjs --data-dir <old AUTH_DATA_DIR> [--imports imports.json] --manifest-out M.json [--copy-to <new 0700 dir>]
//   node pa-export-check.mjs --verify <dir> --manifest M.json          (re-hash a copy, or a rollback materialization)
//
// imports.json comes from pa-credentials-assemble.mjs: relay state the old box keeps OUTSIDE AUTH_DATA_DIR (route-state by
// default) imported at the relative path the guest's relayEnv points at, so it is replicated there.
// Refuses (exit 2) anything the replica would silently drop or refuse: symlinks, special files, unsafe path names, *.tmp or
// .replica* entries (a *.tmp also means a relay write was still in flight: the fence did not hold), an import colliding with a
// data-directory file or with the role's own platform-credentials.json, and state whose sealed genesis package would exceed
// the 64 MiB caps. Output: counts, bytes, the size estimate and an opaque tree digest. Never a file name or content.
import fs from "node:fs";
import path from "node:path";
import { walk, collect, treeManifest, packageEstimate, args, writeNew, mkdirNew, die, ROLE_FILE, MIB } from "./common.mjs";

const o = args(process.argv.slice(2));
if (o.verify) {
  if (!o.manifest) die("--verify <dir> needs --manifest M.json");
  const want = JSON.parse(fs.readFileSync(o.manifest, "utf8"));
  const got = treeManifest(walk(o.verify).files, { exclude: [ROLE_FILE] });
  const same = got.treeSha256 === want.treeSha256 && got.files === want.files && got.bytes === want.bytes;
  console.log(JSON.stringify({ verify: same ? "EQUAL" : "DIFFERENT", files: got.files, bytes: got.bytes, treeSha256: got.treeSha256, want: want.treeSha256 }));
  process.exit(same ? 0 : 1);
}
const dir = o["data-dir"];
if (!dir || !o["manifest-out"]) die("usage: --data-dir D [--imports imports.json] --manifest-out M.json [--copy-to O]  |  --verify O --manifest M.json");
const imports = o.imports ? JSON.parse(fs.readFileSync(o.imports, "utf8")).filter((x) => fs.existsSync(x.src)) : [];
const w = collect(dir, imports), refusals = [];
if (w.symlinks) refusals.push(`${w.symlinks} symlink(s): the replica skips them`);
if (w.special) refusals.push(`${w.special} special file(s): the replica skips them`);
if (w.unsafe) refusals.push(`${w.unsafe} path(s) outside the replica's SAFE_REL rule`);
if (w.skippedNames) refusals.push(`${w.skippedNames} *.tmp / .replica* entr(y/ies): never replicated; a *.tmp means a write was in flight (fence first)`);
if (w.collisions) refusals.push(`${w.collisions} imported path(s) collide with data-directory files`);
if (w.files.some((f) => f.rel === ROLE_FILE)) refusals.push(`a file named ${ROLE_FILE} collides with the role's credentials file`);
const est = packageEstimate(w.files, 16 * 1024);
if (est.packageBodyBytes > 0.9 * est.capBytes) refusals.push(`estimated genesis package ${(est.packageBodyBytes / MIB).toFixed(1)} MiB exceeds 90% of the 64 MiB cap`);
const m = treeManifest(w.files);
const summary = { format: "enclave-platform-api-export-manifest/v1", at: new Date().toISOString(), files: m.files, dirs: w.dirs, bytes: m.bytes,
  imported: imports.map((x) => x.rel), treeSha256: m.treeSha256,
  estimate: { archiveMiB: +(est.archiveBytes / MIB).toFixed(2), packageBodyMiB: +(est.packageBodyBytes / MIB).toFixed(2), capMiB: 64 }, refusals };
if (refusals.length) { console.log(JSON.stringify(summary, null, 1)); die("REFUSED: fix the state (or the fence) and re-run"); }
writeNew(o["manifest-out"], JSON.stringify({ ...summary, entries: m.entries }, null, 1));
if (o["copy-to"]) {
  mkdirNew(o["copy-to"]);
  for (const f of w.files) {
    const dst = path.join(o["copy-to"], f.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.copyFileSync(f.abs, dst, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dst, 0o600);
  }
  if (treeManifest(walk(o["copy-to"]).files).treeSha256 !== m.treeSha256) die("the copy does not hash to the source: the state changed during the copy (fence not held)");
  summary.copy = "EQUAL";
}
console.log(JSON.stringify(summary, null, 1));
