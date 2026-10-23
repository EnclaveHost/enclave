// E source-only derivative: the recipe for E's 7 OMITTED compiled fixtures (rpc-transaction-independence fixtures/artifacts/*.json
// at a460c36c / 159fd148), from Git objects only. Per artifact: its blob, sha256 and size, the compiler and settings its own
// solc metadata records, every source path with its metadata keccak256 and whether a committed fixtures/sources file has exactly
// that keccak256, and the keccak256 of its creation and runtime bytecode (what a regenerated artifact must reproduce). Nothing
// is compiled here: a regeneration needs solc 0.8.35+commit.47b9dedd with these settings.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
const { keccak256 } = await import("/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-wallet-unknown/candidate/node_modules/viem/_esm/index.js");
const repo = process.argv[2], out = process.argv[3];
const git = (...a) => execFileSync("git", ["-C", repo, ...a]);
const COMMITS = { initial: "a460c36c88f41b95e6c2c8f27f7083a4415917c7", report: "159fd1480ddab9652043cce5163348ff4fa6996b" };
const sourcesAt = (c) => Object.fromEntries(git("ls-tree", "-r", "--name-only", c, "--", "fixtures/sources").toString().split("\n").filter(Boolean)
  .map((p) => [keccak256(git("show", `${c}:${p}`)), p]));
const res = { format: "enclave-e-artifact-recipe/v1", repo: "work/rpc-transaction-independence", commits: {}, compilerPin: null,
  note: "The artifacts are forge outputs E copied from work/app-lease-gas/forge/out (159fd148 RESULT.md: 'artifacts from work/app-lease-gas/forge/out, not rebuilt'). They are build outputs, so they are NOT archived; the exact original commit trees cannot be rebuilt from this export until they are regenerated with the pinned compiler and settings below and reproduce the bytecode hashes." };
for (const [label, c] of Object.entries(COMMITS)) {
  const tree = git("rev-parse", `${c}^{tree}`).toString().trim(), byKeccak = sourcesAt(c);
  const arts = git("ls-tree", "-r", "-l", c, "--", "fixtures/artifacts").toString().split("\n").filter(Boolean).map((l) => {
    const [mode, , blob, size, path] = l.split(/\s+/);
    const bytes = git("cat-file", "blob", blob), j = JSON.parse(bytes.toString());
    const md = typeof j.metadata === "string" ? JSON.parse(j.metadata) : j.metadata;
    const raw = typeof j.rawMetadata === "string" ? JSON.parse(j.rawMetadata) : null;
    const meta = raw || md;
    const sources = Object.entries(meta.sources || {}).map(([p, s]) => ({ path: p, keccak256: s.keccak256, license: s.license ?? null,
      committedFixtureSource: byKeccak[s.keccak256] || null }));
    const st = meta.settings || {};
    return { path, mode, blob, bytes: Number(size), sha256: createHash("sha256").update(bytes).digest("hex"),
      compiler: meta.compiler?.version || md?.compiler?.version, compilationTarget: st.compilationTarget,
      settings: { optimizer: st.optimizer, viaIR: st.viaIR ?? null, evmVersion: st.evmVersion, remappings: st.remappings, libraries: st.libraries, metadata: st.metadata },
      bytecodeKeccak256: keccak256(j.bytecode?.object || j.bytecode), deployedBytecodeKeccak256: keccak256(j.deployedBytecode?.object || j.deployedBytecode),
      sources, sourcesInFixtures: sources.filter((s) => s.committedFixtureSource).length, sourcesTotal: sources.length };
  });
  res.commits[label] = { commit: c, tree, artifacts: arts };
}
// sources the committed fixtures do not hold (the two test mocks and forge-std): matched by keccak256 against the forge project
// E compiled in (work/app-lease-gas/forge); ONLY exact matches are copied, as pinned recipe sources (they are sources, not outputs)
const FORGE = "/home/steven/Documents/Codex/2026-10-18/wo/work/app-lease-gas/forge", COPY = "frozen-0830-e-recipe-sources";
fs.rmSync(COPY, { recursive: true, force: true });
res.recipeSources = { project: "work/app-lease-gas/forge", copiedTo: "source-preservation/" + COPY, matched: [], missing: [] };
const need = new Map();
for (const a of res.commits.report.artifacts) for (const s of a.sources) if (!s.committedFixtureSource) need.set(s.path, s.keccak256);
for (const [p, k] of [...need].sort()) {
  const f = `${FORGE}/${p}`;
  const got = fs.existsSync(f) ? keccak256(fs.readFileSync(f)) : null;
  if (got === k) { fs.mkdirSync(`${COPY}/${p.slice(0, p.lastIndexOf("/"))}`, { recursive: true }); fs.copyFileSync(f, `${COPY}/${p}`); res.recipeSources.matched.push({ path: p, keccak256: k }); }
  else res.recipeSources.missing.push({ path: p, keccak256: k, found: got });
}
if (fs.existsSync(`${FORGE}/foundry.toml`)) { fs.copyFileSync(`${FORGE}/foundry.toml`, `${COPY}/foundry.toml`); res.recipeSources.foundryToml = createHash("sha256").update(fs.readFileSync(`${FORGE}/foundry.toml`)).digest("hex"); }
const comps = new Set(Object.values(res.commits).flatMap((x) => x.artifacts.map((a) => a.compiler)));
res.compilerPin = [...comps];
const same = JSON.stringify(res.commits.initial.artifacts.map((a) => [a.path, a.blob])) === JSON.stringify(res.commits.report.artifacts.map((a) => [a.path, a.blob]));
res.artifactsIdenticalInBothCommits = same;
fs.writeFileSync(out, JSON.stringify(res, null, 1) + "\n");
for (const a of res.commits.report.artifacts) console.log(a.path, a.sha256.slice(0, 12), a.compiler, `viaIR=${a.settings.viaIR}`, `runs=${a.settings.optimizer?.runs}`, `target=${JSON.stringify(a.compilationTarget)}`, `sources ${a.sourcesInFixtures}/${a.sourcesTotal} in fixtures/sources`);
console.log("compilers", res.compilerPin, "identical in both commits", same, "recipe sources matched", res.recipeSources.matched.length, "missing", JSON.stringify(res.recipeSources.missing));
