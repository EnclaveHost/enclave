// Dependency comparison for the rewrap image (read-only, local files only): every node_modules package the guest bundle
// actually contains (esbuild metafile, final-build-result.json bundleInputs.packages) against
//   - the candidate tree's installed copy (what was bundled),
//   - main's package-lock.json (version + integrity) and main's installed copy,
//   - the original custodian commit's package-lock.json (9d43e63; what the running image was locked to).
// A mismatch is reported, never resolved here.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const W = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const result = JSON.parse(fs.readFileSync(path.join(W, "build/final-build-result.json"), "utf8"));
const mainLock = JSON.parse(fs.readFileSync(path.join(W, "../enclave/package-lock.json"), "utf8"));
const oldLock = JSON.parse(execFileSync("git", ["-C", "/home/steven/Projects/enclave", "show", "9d43e63e84e1799467a0202c0cf1cdc5a8aabca5:package-lock.json"], { encoding: "utf8", maxBuffer: 64 << 20 }));
const installed = (root, name) => { try { return JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version; } catch { return null; } };
const rows = result.bundleInputs.packages.map((p) => {
  const at = p.lastIndexOf("@"), name = p.slice(0, at), bundled = p.slice(at + 1);
  const lm = mainLock.packages[`node_modules/${name}`] || null, lo = oldLock.packages[`node_modules/${name}`] || null;
  const row = { name, bundled, treeInstalled: installed(path.join(W, "tree"), name), mainLock: lm?.version || null, mainIntegrity: lm?.integrity || null,
    mainInstalled: installed(path.join(W, "../enclave"), name), originalCommitLock: lo?.version || null, originalCommitIntegrity: lo?.integrity || null };
  row.matchesMain = row.bundled === row.treeInstalled && row.bundled === row.mainLock && row.bundled === row.mainInstalled;
  row.matchesOriginalImageLock = row.originalCommitLock === null ? "not in the original lock" : row.bundled === row.originalCommitLock && row.mainIntegrity === row.originalCommitIntegrity;
  return row;
});
const out = { checkedAt: new Date().toISOString(), packages: rows, allMatchMain: rows.every((r) => r.matchesMain),
  differFromOriginalImageLock: rows.filter((r) => r.matchesOriginalImageLock === false).map((r) => `${r.name} ${r.originalCommitLock} -> ${r.bundled}`),
  repoInputs: result.bundleInputs.repo };
fs.writeFileSync(path.join(W, "inventory/dependency-check.json"), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ packages: rows.length, allMatchMain: out.allMatchMain, differFromOriginalImageLock: out.differFromOriginalImageLock, repoInputs: out.repoInputs.length }, null, 1));
if (!out.allMatchMain) process.exit(1);
