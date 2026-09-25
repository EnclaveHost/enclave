#!/usr/bin/env node
// verifier/node/reproduce.mjs: does the committed Node consumer bundle come from THIS tree? The same rule as
// verifier/web/reproduce.mjs: rebuild with the pinned esbuild into a temporary directory and compare byte for byte: the
// artifact against dist/ and against the manifest; every manifest input's sha256 against the file in the tree now; the
// build tool's version and options; the notices against a fresh generation; and the relay's vendored copy against the
// artifact. Any difference: exit 1 with the difference named. The strict integration command runs this before any suite.
//   node verifier/node/reproduce.mjs [--dist DIR] [--vendor DIR]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildNode, manifestFor, noticesOf, DIST, VENDOR, ARTIFACT, MANIFEST, NOTICES, VENDOR_MANIFEST } from "./build.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
export async function reproduceNode({ dist = DIST, vendor = VENDOR } = {}) {
  const problems = [];
  let manifest; try { manifest = JSON.parse(fs.readFileSync(path.join(dist, MANIFEST), "utf8")); } catch (e) { return { ok: false, problems: [`manifest unreadable: ${e.message}`] }; }
  let committed; try { committed = fs.readFileSync(path.join(dist, ARTIFACT)); } catch (e) { return { ok: false, problems: [`artifact unreadable: ${e.message}`] }; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "node-reproduce-"));
  try {
    const b = await buildNode({ outfile: path.join(tmp, ARTIFACT) });
    if (sha(committed) !== manifest.artifact?.sha256) problems.push(`artifact on disk (${sha(committed).slice(0, 16)}) is not what the manifest records (${String(manifest.artifact?.sha256).slice(0, 16)})`);
    if (b.sha256 !== manifest.artifact?.sha256) problems.push(`artifact rebuilt from the tree (${b.sha256.slice(0, 16)}) differs from the manifest's (${String(manifest.artifact?.sha256).slice(0, 16)})`);
    if (b.bytes !== manifest.artifact?.bytes) problems.push(`artifact size ${b.bytes} differs from the manifest's ${manifest.artifact?.bytes}`);
    const fresh = manifestFor(b);
    if (JSON.stringify(fresh.build) !== JSON.stringify(manifest.build)) problems.push(`build tool or options differ: tree ${JSON.stringify(fresh.build)} vs manifest ${JSON.stringify(manifest.build)}`);
    const want = new Map((manifest.inputs || []).map((i) => [i.path, i]));
    for (const i of b.inputs) { const m = want.get(i.path); if (!m) problems.push(`input ${i.path} is bundled but not in the manifest`); else if (m.sha256 !== i.sha256) problems.push(`input ${i.path} changed since the manifest (${m.sha256.slice(0, 16)} -> ${i.sha256.slice(0, 16)})`); }
    for (const p of want.keys()) if (!b.inputs.some((i) => i.path === p)) problems.push(`manifest input ${p} is no longer bundled`);
    let notices = null; try { notices = fs.readFileSync(path.join(dist, NOTICES), "utf8"); } catch { problems.push("notices file missing"); }
    if (notices !== null && notices !== noticesOf(b)) problems.push("notices differ from a fresh generation (a dependency changed, or the file was edited by hand)");
    if (vendor) {
      let copy = null; try { copy = fs.readFileSync(path.join(vendor, ARTIFACT)); } catch { problems.push(`the relay's vendored copy ${path.join(vendor, ARTIFACT)} is missing`); }
      if (copy && !copy.equals(committed)) problems.push("the relay's vendored copy differs from the artifact (rebuild with verifier/node/build.mjs; never edit either by hand)");
      let vm = null; try { vm = JSON.parse(fs.readFileSync(path.join(vendor, VENDOR_MANIFEST), "utf8")); } catch { problems.push("the relay's vendored manifest is missing"); }
      if (vm && vm.artifact?.sha256 !== manifest.artifact?.sha256) problems.push("the relay's vendored manifest names another artifact");
    }
    return { ok: problems.length === 0, problems, sha256: b.sha256, bytes: b.bytes, inputs: b.inputs.length, esbuild: b.esbuild };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), dist = a.includes("--dist") ? path.resolve(a[a.indexOf("--dist") + 1]) : DIST, vendor = a.includes("--vendor") ? path.resolve(a[a.indexOf("--vendor") + 1]) : VENDOR;
  const r = await reproduceNode({ dist, vendor });
  if (!r.ok) { for (const p of r.problems) console.error(`node artifact: ${p}`); console.error("node artifact: NOT reproduced"); process.exit(1); }
  console.log(`node artifact: ${ARTIFACT} REPRODUCED with esbuild ${r.esbuild}: ${r.bytes} bytes, sha256 ${r.sha256}, ${r.inputs} inputs verified, notices current, relay copy identical`);
}
