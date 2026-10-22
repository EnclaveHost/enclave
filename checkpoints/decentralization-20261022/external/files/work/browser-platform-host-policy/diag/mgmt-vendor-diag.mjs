// Read-only diagnosis of test/site-independent-management-unit "the vendored bundle is exactly a fresh build": in ROOT,
// rebuild site/vendor/management.js in memory (scripts/build-management-vendor.mjs, nothing written) and compare it, its
// manifest, every listed source's hash and the toolchain versions with what is committed.   node mgmt-vendor-diag.mjs ROOT
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const ROOT = path.resolve(process.argv[2]);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const { buildManagementVendor, OUT, MANIFEST } = await import(pathToFileURL(path.join(ROOT, "scripts/build-management-vendor.mjs")).href);
const committed = fs.readFileSync(OUT), cman = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const { js, manifest } = await buildManagementVendor();
console.log("root", ROOT, "| .git present:", fs.existsSync(path.join(ROOT, ".git")));
console.log("committed bundle sha256", sha(committed), committed.length, "| manifest says", cman.sha256, cman.bytes);
console.log("fresh build sha256     ", sha(js), js.length, "| bytes equal:", Buffer.compare(committed, js) === 0);
console.log("toolchain: manifest esbuild", cman.esbuild, "viem", cman.deps?.viem, "| installed esbuild", manifest.esbuild, "viem", manifest.deps?.viem);
const names = [...new Set([...Object.keys(cman.sources), ...Object.keys(manifest.sources)])].sort();
for (const n of names){
  const a = cman.sources[n], b = manifest.sources[n];
  console.log("source", n, "| manifest", a ? a.sha256.slice(0, 16) : "-", "| current", b ? b.sha256.slice(0, 16) : "-", a && b && a.sha256 === b.sha256 ? "same" : "CHANGED",
    "| provenance now", b ? JSON.stringify({ commit: b.commit && b.commit.slice(0, 10), committedClean: b.committedClean }) : "-");
}
// the manifest deepEqual half of the test: which top-level fields differ
for (const k of new Set([...Object.keys(cman), ...Object.keys(manifest)])) if (JSON.stringify(cman[k]) !== JSON.stringify(manifest[k])) console.log("manifest field differs:", k);
