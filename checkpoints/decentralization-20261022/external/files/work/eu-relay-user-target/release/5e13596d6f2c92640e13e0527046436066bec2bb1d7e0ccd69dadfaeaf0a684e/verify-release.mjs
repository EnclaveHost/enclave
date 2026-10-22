#!/usr/bin/env node
// verify-release.mjs - run before EVERY start of the user-service host relay (ExecStartPre) and by the install script.
// The release directory (this file's own) must hold EXACTLY the files RELEASE.json lists, each with its sha256 and size,
// and nothing else; no symlink anywhere; every entry owned by the uid running this; no group/other permission bits; and
// the directory's name must be the release id (sha256 of the manifest body). Prints one line; exit 0 = verified, 1 = not.
// It reads only this release; it prints no file content.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const problems = [];
const uid = process.getuid();
let manifest;
try { manifest = JSON.parse(fs.readFileSync(path.join(DIR, "RELEASE.json"), "utf8")); } catch (e) { problems.push(`RELEASE.json unreadable: ${e.message}`); }
if (manifest) {
  const { releaseId, builtFrom, ...body } = manifest;
  if (sha(JSON.stringify(body)) !== releaseId) problems.push("RELEASE.json does not hash to its release id");
  if (path.basename(DIR) !== releaseId) problems.push(`the release directory is not named by its id ${String(releaseId).slice(0, 16)}...`);
  const seen = new Set();
  const own = (f, st, kind) => {
    if (st.uid !== uid) problems.push(`${kind} ${path.relative(DIR, f) || "."} is owned by uid ${st.uid}, not ${uid}`);
    if (st.mode & 0o077) problems.push(`${kind} ${path.relative(DIR, f) || "."} has group/other permissions (${(st.mode & 0o777).toString(8)})`);
  };
  const walk = (d) => {
    own(d, fs.lstatSync(d), "directory");
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name), rel = path.relative(DIR, f), st = fs.lstatSync(f);
      if (st.isSymbolicLink()) { problems.push(`${rel} is a symlink`); continue; }
      if (st.isDirectory()) { walk(f); continue; }
      if (!st.isFile()) { problems.push(`${rel} is not a regular file`); continue; }
      own(f, st, "file");
      if (rel === "RELEASE.json") continue;
      seen.add(rel);
      const want = body.files?.[rel];
      if (!want) { problems.push(`${rel} is not in the release`); continue; }
      if (st.size !== want.bytes || sha(fs.readFileSync(f)) !== want.sha256) problems.push(`${rel} is not the released bytes`);
    }
  };
  walk(DIR);
  for (const rel of Object.keys(body.files || {})) if (!seen.has(rel)) problems.push(`${rel} is missing`);
}
if (problems.length) { console.log(`release NOT verified (${problems.length}): ${problems.slice(0, 8).join("; ")}`); process.exit(1); }
console.log(`release ${manifest.releaseId} verified: ${Object.keys(manifest.files).length} files, owner uid ${uid}, no symlinks, owner-only modes`);
