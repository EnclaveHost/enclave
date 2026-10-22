// READ-ONLY provenance for the custodian candidate (claude, 2026-10-20). Writes only the JSON named by argv[3], outside the
// clone. Every git call uses GIT_OPTIONAL_LOCKS=0 (no index refresh or lock) and the staged set is checked unchanged.
//   node claude-provenance.mjs <clean clone> <out.json>
// It recomputes, FROM THE CLEAN CLONE'S OWN CODE, exactly what scripts/build-custodian-v2.mjs will bundle:
//   - the measured config for the operator's inputs, compared deep-equal with outputs/custodian-shield-build-preflight.json;
//   - both bundles in memory (the build's own bundleOptions), every metafile input hashed (repository AND node_modules files),
//     each bundled package checked against the root package-lock.json (version, resolved, integrity present);
//   - the build's own sourceCheck (tracked + clean), which must be empty;
//   - the sha256 of each bundle as the image will carry it (compared with the built manifest later).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const clone = path.resolve(process.argv[2]), outFile = path.resolve(process.argv[3]);
const WORK = "/home/steven/Documents/Codex/2026-10-18/wo";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const git = (a) => execFileSync("git", a, { cwd: clone, encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
const stagedBefore = git(["diff", "--cached", "--name-status"]);
const { build, version: esbuildVersion } = await import(path.join(clone, "node_modules/esbuild/lib/main.js"));
const bc = await import(path.join(clone, "custody/v2/build-config.mjs"));
const { validateShieldOperator } = await import(path.join(clone, "custody/v2/shield-operator.mjs"));

const preflight = JSON.parse(fs.readFileSync(path.join(WORK, "outputs/custodian-shield-build-preflight.json"), "utf8"));
const shieldFile = path.join(WORK, "work/custody-candidate-20261020/shield.json");
const shield = JSON.parse(fs.readFileSync(shieldFile, "utf8"));
const inputs = { vault: "0x56b81b3970a8ac2c52f9874bd2758ede30758228", hostOwnership: "0xf5e9e6c02449001f6e8e95e5d87413f2cb6790ea",
                 transport: "direct", admission: "owner-permits", shieldRecipients: shield, trustedProxies: ["10.0.2.2"] };
const { measured, policy, needsDkg } = bc.custodianMeasured(inputs);
const v = validateShieldOperator(shield);
const measuredText = bc.measuredModule(measured);
const opts = bc.bundleOptions(measuredText, { root: clone });
const d = await build({ ...opts, entryPoints: [path.join(clone, "custody/v2/daemon.mjs")] });
const g = await build({ ...opts, entryPoints: [path.join(clone, "custody/v2/cvm-gsup.mjs")] });
const srcs = bc.bundleSources([d.metafile, g.metafile], { root: clone });
const check = bc.sourceCheck(srcs, { git });

// every input file esbuild read, hashed; node_modules packages checked against the root lock
const lock = JSON.parse(fs.readFileSync(path.join(clone, "package-lock.json"), "utf8"));
const inputsAll = [...new Set([...Object.keys(d.metafile.inputs), ...Object.keys(g.metafile.inputs)])].sort();
const files = inputsAll.map((p) => { const abs = path.resolve(clone, p); return { path: path.relative(clone, abs), sha256: sha(fs.readFileSync(abs)), bytes: fs.statSync(abs).size }; });
const pkgDirs = new Map();
for (const f of files) {
  const i = f.path.lastIndexOf("node_modules/");
  if (i < 0) continue;
  const rest = f.path.slice(i + "node_modules/".length).split("/");
  const dir = f.path.slice(0, i) + "node_modules/" + (rest[0].startsWith("@") ? rest.slice(0, 2).join("/") : rest[0]);
  pkgDirs.set(dir, (pkgDirs.get(dir) || 0) + 1);
}
const packages = [...pkgDirs].map(([dir, n]) => {
  const pj = JSON.parse(fs.readFileSync(path.join(clone, dir, "package.json"), "utf8")), entry = lock.packages?.[dir] || null;
  return { dir, name: pj.name, version: pj.version, bundledFiles: n, lock: entry ? { version: entry.version, resolved: entry.resolved ?? null, integrity: entry.integrity ?? null } : null,
           matchesLock: !!entry && entry.version === pj.version && typeof entry.integrity === "string" };
}).sort((a, b) => a.dir.localeCompare(b.dir));
const nmTreeIsReal = !fs.lstatSync(path.join(clone, "node_modules")).isSymbolicLink();

const out = {
  format: "enclave-custodian-candidate-provenance/1", at: new Date().toISOString(),
  clone: { path: clone, head: git(["rev-parse", "HEAD"]).trim(), detached: git(["rev-parse", "--abbrev-ref", "HEAD"]).trim() === "HEAD",
           porcelain: git(["status", "--porcelain"]).split("\n").filter(Boolean), nodeModulesIsRealDirectory: nmTreeIsReal },
  lock: { file: "package-lock.json", sha256: sha(fs.readFileSync(path.join(clone, "package-lock.json"))), packageJsonSha256: sha(fs.readFileSync(path.join(clone, "package.json"))),
          parentLockSha256: sha(fs.readFileSync(path.join(WORK, "work/enclave/package-lock.json"))) },
  operatorInputs: { ...inputs, shieldRecipients: { file: shieldFile, sha256: sha(fs.readFileSync(shieldFile)), ekRootPins: v.ekRootPins, acceptTier: v.acceptTier, limits: v.limits } },
  measured: { policy, needsDkg, moduleSha256: sha(measuredText), equalsPreflight: isDeepStrictEqual(JSON.parse(JSON.stringify(measured)), preflight.measured),
              preflightBlock: preflight.observation?.blockNumber, preflightBlockHash: preflight.observation?.blockHash },
  bundles: { bundler: `esbuild@${esbuildVersion}`, daemonSha256: sha(Buffer.from(d.outputFiles[0].contents)), gsupSha256: sha(Buffer.from(g.outputFiles[0].contents)) },
  buildSourceCheck: { untracked: check.untracked, dirty: check.dirty.split("\n").filter(Boolean), clean: !check.untracked.length && !check.dirty.trim() },
  bundleInputs: { repo: srcs.repo.length, packages: srcs.packages, files },
  nodeModules: { packages, allMatchLock: packages.every((p) => p.matchesLock) },
};
if (git(["diff", "--cached", "--name-status"]) !== stagedBefore) throw new Error("the index changed during provenance");
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ head: out.clone.head, porcelain: out.clone.porcelain, nmReal: nmTreeIsReal, lockEqualsParent: out.lock.sha256 === out.lock.parentLockSha256,
  measuredEqualsPreflight: out.measured.equalsPreflight, policy, needsDkg, sourceCheckClean: out.buildSourceCheck.clean, repoInputs: srcs.repo.length,
  inputFiles: files.length, packages: packages.map((p) => `${p.name}@${p.version}${p.matchesLock ? "" : " LOCK-MISMATCH"}`), bundles: out.bundles, pins: v.ekRootPins }, null, 1));
