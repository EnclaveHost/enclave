// frozen-0931 ("0931" = this batch's start 2026-10-23T09:31Z, an identifier): the recipe for E's OMITTED compiled fixtures at its
// terminal report ca818b75 (rpc-transaction-independence fixtures/artifacts/*.json), from Git objects only, extending frozen-0830's.
// Per artifact: blob, sha256, size, whether it is byte-identical to one frozen-0830 already recorded (then that recipe applies), and
// otherwise the compiler and settings its own solc metadata records, every source path with its metadata keccak256 and where an
// EXACT-keccak copy is: E's committed fixtures/sources at ca818b75 (published in the derivative), frozen-0830's published recipe
// sources, or (copied here) work/app-lease-gas/forge or main 7752a423's tree in the checkpoint repo; and the keccak256 of creation
// and runtime bytecode (what a regenerated artifact must reproduce). Nothing is compiled. Also records E's own exports/ (format-patch
// files and a git bundle that EMBED the artifacts), which are omitted.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const { keccak256 } = await import("/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-wallet-unknown/candidate/node_modules/viem/_esm/index.js");
const W = "/home/steven/Documents/Codex/2026-10-18/wo/work", SP = `${W}/resume-after-checkpoint-20261022/source-preservation`;
const repo = `${W}/rpc-transaction-independence`, CKR = `${W}/source-checkpoint-20261022/main-repo`, MAIN = "7752a4239b3bec2cf452491cd1b95164a8c2bdb8";
const HEAD = "ca818b759172adc98c5089796784133f9310e597", BASE = "159fd1480ddab9652043cce5163348ff4fa6996b", CK = "cadf0ebb83338d847ef1cb5d3f14a64fe7560098";
const git = (r, ...a) => execFileSync("git", ["-C", r, ...a], { maxBuffer: 1 << 28 });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const prev = JSON.parse(fs.readFileSync(`${SP}/frozen-0830-e-artifact-recipe.json`, "utf8"));
const prevBlobs = new Map(prev.commits.report.artifacts.map((a) => [a.blob, a.path]));
const prevSources = new Map(prev.recipeSources.matched.map((s) => [s.keccak256, s.path]));
const fixtures = Object.fromEntries(git(repo, "ls-tree", "-r", "--name-only", HEAD, "--", "fixtures/sources").toString().split("\n").filter(Boolean)
  .map((p) => [keccak256(git(repo, "show", `${HEAD}:${p}`)), p]));
// candidate source pools for keccak matching (exact bytes only)
const FORGE = `${W}/app-lease-gas/forge`;
const mainFiles = git(CKR, "ls-tree", "-r", MAIN).toString().split("\n").filter((l) => /\.sol$/.test(l)).map((l) => { const [meta, p] = l.split("\t"); return [meta.split(" ")[2], p]; });
const res = { format: "enclave-e-artifact-recipe/v2", repo: "work/rpc-transaction-independence", head: HEAD, base: BASE, extends: "source-preservation/frozen-0830-e-artifact-recipe.json",
  note: "Compiled forge outputs E committed (RESULT-TRANSACTION-CLOSURE.md: 'Contracts are the existing compiled artifacts, not rebuilt'). Not archived; the exact original trees of 017b8aa/027ff549/ca818b75 cannot be rebuilt from the export until these are regenerated with the pinned compiler and settings and reproduce the recorded bytecode keccak256s." };
const arts = git(repo, "ls-tree", "-r", "-l", HEAD, "--", "fixtures/artifacts").toString().split("\n").filter(Boolean).map((l) => {
  const [mode, , blob, size, p] = l.split(/\s+/);
  const bytes = git(repo, "cat-file", "blob", blob);
  const base = { path: p, mode, blob, bytes: Number(size), sha256: sha(bytes) };
  if (prevBlobs.has(blob)) return { ...base, sameAsFrozen0830: prevBlobs.get(blob) };
  const j = JSON.parse(bytes.toString());
  const md = typeof j.metadata === "string" ? JSON.parse(j.metadata) : j.metadata;
  const raw = typeof j.rawMetadata === "string" ? JSON.parse(j.rawMetadata) : null;
  const meta = raw || md, st = meta.settings || {};
  const sources = Object.entries(meta.sources || {}).map(([sp, s]) => ({ path: sp, keccak256: s.keccak256, committedFixtureSource: fixtures[s.keccak256] || null,
    frozen0830RecipeSource: prevSources.get(s.keccak256) || null }));
  return { ...base, compiler: meta.compiler?.version, compilationTarget: st.compilationTarget,
    settings: { optimizer: st.optimizer, viaIR: st.viaIR ?? null, evmVersion: st.evmVersion, remappings: st.remappings, libraries: st.libraries, metadata: st.metadata },
    bytecodeKeccak256: keccak256(j.bytecode?.object || j.bytecode), deployedBytecodeKeccak256: keccak256(j.deployedBytecode?.object || j.deployedBytecode), sources };
});
res.artifacts = arts;
// the sources neither the fixtures nor frozen-0830's recipe hold: exact keccak matches from app-lease-gas/forge or main 7752a423
const COPY = `${SP}/frozen-0931-e-recipe-sources`;
fs.rmSync(COPY, { recursive: true, force: true });
res.recipeSources = { copiedTo: "source-preservation/frozen-0931-e-recipe-sources", matched: [], missing: [] };
const need = new Map();
for (const a of arts) for (const s of a.sources || []) if (!s.committedFixtureSource && !s.frozen0830RecipeSource) need.set(s.path, s.keccak256);
const mainByKeccak = new Map();
for (const [blob, p] of mainFiles) mainByKeccak.set(keccak256(git(CKR, "cat-file", "blob", blob)), p);
for (const [p, k] of [...need].sort()) {
  let from = null, data = null;
  const f = path.join(FORGE, p);
  if (fs.existsSync(f) && keccak256(fs.readFileSync(f)) === k) { from = `work/app-lease-gas/forge/${p}`; data = fs.readFileSync(f); }
  else if (mainByKeccak.has(k)) { from = `main ${MAIN.slice(0, 8)}:${mainByKeccak.get(k)}`; data = git(CKR, "show", `${MAIN}:${mainByKeccak.get(k)}`); }
  // already published: the same bytes at the same path in the checkpoint head's own tree -> referenced, not copied again
  const ckBlob = (() => { try { return git(CKR, "rev-parse", `${CK}:${p}`).toString().trim(); } catch { return null; } })();
  const blobOf = (b) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");
  if (data && ckBlob === blobOf(data)) res.recipeSources.matched.push({ path: p, keccak256: k, from, inCheckpointHead: `${CK.slice(0, 8)}:${p}`, gitBlob: ckBlob, copied: false });
  else if (data) { fs.mkdirSync(path.dirname(path.join(COPY, p)), { recursive: true }); fs.writeFileSync(path.join(COPY, p), data); res.recipeSources.matched.push({ path: p, keccak256: k, from, copied: true }); }
  else res.recipeSources.missing.push({ path: p, keccak256: k });
}
res.compilerPin = [...new Set(arts.filter((a) => a.compiler).map((a) => a.compiler).concat(prev.compilerPin))];
res.exportsOmitted = git(repo, "ls-tree", "-r", "-l", HEAD, "--", "exports").toString().split("\n").filter(Boolean).map((l) => {
  const [mode, , blob, size, p] = l.split(/\s+/); return { path: p, mode, blob, bytes: Number(size), sha256: sha(git(repo, "cat-file", "blob", blob)) }; });
res.exportsNote = "E's own export for D (format-patch --root files and a git bundle of 027ff549). They EMBED the compiled fixtures (patch text / pack), so they are omitted; the derivative's Git-object patches plus regenerated artifacts reproduce them in content.";
fs.writeFileSync(`${SP}/frozen-0931-e-artifact-recipe.json`, JSON.stringify(res, null, 1) + "\n");
for (const a of arts) console.log(a.path, a.sha256.slice(0, 12), a.sameAsFrozen0830 ? "= frozen-0830" : `${a.compiler} viaIR=${a.settings.viaIR} runs=${a.settings.optimizer?.runs} sources ${a.sources.length}`);
console.log("compilers", res.compilerPin, "recipe sources matched", res.recipeSources.matched.length, "missing", JSON.stringify(res.recipeSources.missing), "exports omitted", res.exportsOmitted.length);
