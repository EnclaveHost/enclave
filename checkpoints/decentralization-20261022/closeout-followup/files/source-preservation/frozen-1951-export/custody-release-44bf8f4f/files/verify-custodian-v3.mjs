// v3 (custodian only), adapted from work/custody-release/verify-release-v2.mjs. Verifies a corrected-custodian RELEASE build
// against its committed source (read-only). v2's comparison of every bundle input with the integrated main working tree
// (../enclave) cannot hold here: the custodian's sources now intentionally carry the reviewed durability patches that main
// does not. That one check is replaced by LINEAGE against the previously verified release c635fd68 (whose inputs v2
// verified equal to main):
//   - HEAD descends from c635fd68 by exactly the five reviewed commits, and the three reviewed patch files reproduce
//     byte for byte from them (git format-patch, sha256 as frozen for root review);
//   - every bundle input either equals its c635fd68 blob, or is one of the reviewed custody files the patches change;
//   - the files changed since c635fd68 are exactly the reviewed list.
// Every other v2 check is kept:
//   - manifest.commit == HEAD; HEAD clean;
//   - every input tracked, with committed blob == disk;
//   - the builder's own sourceCheck;
//   - every bundled package pinned by its lockfile and the installed tree;
//   - the custodian embeds the committed host policy's mirrors.
// Added:
//   - the image's own files (extracted from the cpio) hash to the manifest;
//   - the bundle carries EXACTLY the MEASURED config recomputed with build-config.mjs from the release arguments
//     (original vault, book, host ownership, host policy);
//   - base kernel, initramfs, OVMF and cmdline equal the c635fd68 release's.
// The rewrap image is not rebuilt: its whole closure (bundle inputs, builder, build-config, lockfiles, host policy) is
// checked unchanged since c635fd68, so the frozen c635fd68 rewrap artifact stands.
//   node verify-custodian-v3.mjs <release checkout> <custodian dir> <frozen c635 release out dir> <reviewed patches dir> <out.json>
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpioEntries } from "./cpio-entries.mjs";
const [REPO, CDIR, FROZEN, PATCHES, OUT] = process.argv.slice(2).map((p) => path.resolve(p));
const env = { ...process.env, GIT_DIR: path.join(REPO, ".git"), GIT_OPTIONAL_LOCKS: "0" };
const git = (args, opts = {}) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20, env, ...opts });
const gitBuf = (args) => execFileSync("git", args, { cwd: REPO, maxBuffer: 64 << 20, env });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const fail = [];
const PREV = "c635fd68515b46c53935ef344e3b4c4779d8067c";
const VAULT = "0xe48699b8401564aace7a814ae4569b67a3f7eef5", BOOK = "0xab214342d5a490150a4a977063a2f88e21f80907", OWN = "0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7";
const REVIEWED_COMMITS = ["ed0c536d", "415483ff", "3ccd4333", "0a6b108e", "c95dcd3a"];
const REVIEWED_PATCHES = [   // [range, file, sha256 as frozen in the durability reports]
  [`${PREV}..415483ff`, "custody-v2-durability.patch", "59c8245703e1814e1124c580bd27a76f2ac9f171dbd8bb54e1286a8fcacd1f17"],
  ["415483ff..0a6b108e", "custody-v2-durability-followup.patch", "e7788e19acf2c9dfcd6e76a90461ac410c03b674dcb5dfe402b614ffad0dee09"],
  ["0a6b108e..c95dcd3a", "custody-v2-genesis-intent.patch", "c41252d7ac520025421f31267474380cdfdf759693032dc2a9408c195d760263"]];
const REVIEWED_CUSTODY_FILES = ["custody/v2/daemon.mjs", "custody/v2/member.mjs", "custody/v2/sealed-state.mjs"];
const REVIEWED_CHANGED = [...REVIEWED_CUSTODY_FILES, "docs/security/secret-custody-v2.md", "test/custody-v2-e2e.test.mjs", "test/custody-v2-genesis-intent.test.mjs",
  "test/custody-v2-persist-barrier.test.mjs", "test/fixtures/EnclaveRegistry.schema4.sol", "test/helpers/original-vault-rig.mjs"].sort();

const head = git(["rev-parse", "HEAD"]).trim();
const porcelain = git(["status", "--porcelain"]).trim();
if (porcelain) fail.push(`checkout is not clean:\n${porcelain}`);
const report = { releaseCommit: head, clean: !porcelain, lineage: {}, image: {} };

// ---- lineage from the verified release c635fd68 ----
try { git(["merge-base", "--is-ancestor", PREV, head]); } catch { fail.push(`HEAD does not descend from ${PREV}`); }
const commits = git(["rev-list", "--reverse", "--first-parent", `${PREV}..${head}`]).split("\n").filter(Boolean);
const merges = git(["rev-list", "--merges", `${PREV}..${head}`]).trim();
if (merges || commits.length !== REVIEWED_COMMITS.length || !commits.every((c, i) => c.startsWith(REVIEWED_COMMITS[i])))
  fail.push(`commits since ${PREV} are not exactly the reviewed ${REVIEWED_COMMITS.join(",")}: ${commits.map((c) => c.slice(0, 8)).join(",")}${merges ? " (with merges)" : ""}`);
const changed = git(["diff", "--name-only", PREV, head]).split("\n").filter(Boolean).sort();
if (JSON.stringify(changed) !== JSON.stringify(REVIEWED_CHANGED)) fail.push(`files changed since ${PREV} differ from the reviewed list: ${changed.join(" ")}`);
report.lineage = { from: PREV, commits, changed, patches: REVIEWED_PATCHES.map(([range, file, want]) => {
  const got = sha(gitBuf(["format-patch", "--stdout", range]));
  const frozen = fs.existsSync(path.join(PATCHES, file)) ? sha(fs.readFileSync(path.join(PATCHES, file))) : null;
  if (got !== want || frozen !== want) fail.push(`${file}: format-patch ${range} sha256 ${got}, frozen file ${frozen}, reviewed ${want}`);
  return { range, file, sha256: got, frozenFile: frozen, reviewed: want };
}) };

// ---- the custodian image ----
const m = JSON.parse(fs.readFileSync(path.join(CDIR, "manifest.json"), "utf8"));
const prev = JSON.parse(fs.readFileSync(path.join(FROZEN, "A-custodian/manifest.json"), "utf8"));
const r = report.image;
Object.assign(r, { commit: m.commit, measurement: m.measurement, measurementSha256: m.measurementSha256, initramfs: m.initramfs, files: m.files, base: m.base,
  kernelSha256: m.kernel?.sha256, ovmfSha256: m.ovmfSha256, cmdline: m.cmdline, vcpus: m.vcpus, bundler: m.bundler, role: m.role, vault: m.vault, hostOwnership: m.hostOwnership,
  transport: m.transport, dkgBuild: m.dkgBuild, independentPolicy: m.independentPolicy, shieldRecipients: m.shieldRecipients, trustedProxies: m.trustedProxies });
if (m.commit !== head) fail.push(`manifest commit ${m.commit} != HEAD ${head}`);
if (m.measurementError || !/^[0-9a-f]{96}$/.test(String(m.measurement))) fail.push("no measurement");
if (sha(fs.readFileSync(path.join(CDIR, "initramfs.cpio.gz"))) !== m.initramfs.sha256) fail.push("initramfs hash");
if (sha(fs.readFileSync(path.join(CDIR, "vmlinuz"))) !== m.kernel.sha256) fail.push("vmlinuz hash");
if (fs.readFileSync(path.join(CDIR, "cmdline"), "utf8").trim() !== m.cmdline) fail.push("cmdline file != manifest");
for (const k of ["base", "cmdline", "ovmfSha256", "vcpus", "bundler", "role", "vault", "hostOwnership", "transport", "dkgBuild", "independentPolicy", "independentOwners", "shieldRecipients", "trustedProxies"])
  if (JSON.stringify(m[k]) !== JSON.stringify(prev[k])) fail.push(`${k} differs from the ${PREV} release: ${JSON.stringify(m[k])} vs ${JSON.stringify(prev[k])}`);
if (m.kernel?.sha256 !== prev.kernel?.sha256) fail.push("kernel differs from the previous release");
if (m.vault !== VAULT || m.hostOwnership !== OWN || m.role !== "enclave-custodian-v2") fail.push("vault, host ownership or role is not the production original vault's");
const inputs = m.bundleInputs?.repo || [];
if (!inputs.length) fail.push("manifest lists no bundle inputs");
const tracked = new Set(git(["ls-files", "--", ...inputs]).split("\n").filter(Boolean));
r.inputs = inputs.map((f) => {
  const blob = gitBuf(["show", `HEAD:${f}`]), disk = fs.readFileSync(path.join(REPO, f));
  let prevBlob = null; try { prevBlob = gitBuf(["show", `${PREV}:${f}`]); } catch {}
  const equalsPrev = prevBlob !== null && sha(prevBlob) === sha(disk), reviewed = REVIEWED_CUSTODY_FILES.includes(f);
  if (!tracked.has(f) || sha(blob) !== sha(disk)) fail.push(`${f} not tracked or differs from the commit`);
  if (!equalsPrev && !reviewed) fail.push(`${f} changed since ${PREV} outside the reviewed patches`);
  return { path: f, sha256: sha(disk), tracked: tracked.has(f), equalsCommit: sha(blob) === sha(disk), equalsPrevRelease: equalsPrev, reviewedChange: !equalsPrev && reviewed };
});
r.inputsAddedSincePrev = inputs.filter((f) => !prev.bundleInputs.repo.includes(f));
r.inputsRemovedSincePrev = prev.bundleInputs.repo.filter((f) => !inputs.includes(f));
const B = await import(path.join(REPO, "custody/v2/build-config.mjs"));
const sc = B.sourceCheck({ repo: inputs }, { git });
r.sourceCheck = { untracked: sc.untracked, dirty: sc.dirty, paths: sc.paths.length };
if (sc.untracked.length || sc.dirty) fail.push("sourceCheck not clean");
// packages: pinned by a lockfile, and the installed tree agrees
const lock = (rel) => JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));
const locks = { "": lock("package-lock.json"), "relay/": lock("relay/package-lock.json") };
const hidden = { "": lock("node_modules/.package-lock.json"), "relay/": lock("relay/node_modules/.package-lock.json") };
r.packages = (m.bundleInputs?.packages || []).map((p) => {
  const at = p.lastIndexOf("@"), n = p.slice(0, at), v = p.slice(at + 1);
  const roots = Object.keys(locks).filter((root) => locks[root].packages[`node_modules/${n}`]?.version === v);
  const okHidden = roots.length > 0 && roots.every((root) => { const a = locks[root].packages[`node_modules/${n}`], h = hidden[root].packages[`node_modules/${n}`]; return h && h.version === a.version && h.integrity === a.integrity; });
  if (!roots.length) fail.push(`${p} pinned by no lockfile`);
  if (!okHidden) fail.push(`${p} installed tree disagrees with its lockfile`);
  return { package: p, lockfiles: roots.map((x) => `${x}package-lock.json`), integrity: roots.map((x) => locks[x].packages[`node_modules/${n}`].integrity) };
});
if (JSON.stringify(r.packages.map((p) => p.package)) !== JSON.stringify(prev.bundleInputs.packages)) fail.push("bundled packages differ from the previous release");
// the image's own files, and the MEASURED config they carry
const want = Object.keys(m.files).map((f) => f.replace(/^\//, ""));
const got = await cpioEntries(path.join(CDIR, "initramfs.cpio.gz"), want);
r.extracted = Object.fromEntries(want.map((f) => [`/${f}`, got[f] ? sha(got[f]) : null]));
for (const f of want) if (!got[f] || sha(got[f]) !== m.files[`/${f}`]) fail.push(`/${f} in the image does not hash to the manifest`);
const hp = JSON.parse(fs.readFileSync(path.join(REPO, "release/host-policy-production.json"), "utf8"));
const { measured } = B.custodianMeasured({ vault: VAULT, hostOwnership: OWN, transport: "direct", book: BOOK, hostPolicy: hp });
const lit = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(lit).join(", ")}]`
  : `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${lit(x)}`).join(", ")} }`);
const js = got["opt/custodian/custodian.mjs"]?.toString() || "";
const expect = `var MEASURED = Object.freeze(${lit(measured)});`;
const occurrences = js.split("var MEASURED = Object.freeze(").length - 1;
if (!js.includes(expect) || occurrences !== 1) fail.push(`the custodian bundle does not carry exactly the recomputed MEASURED config (${occurrences} MEASURED definitions)`);
if (measured.vaultKind !== "book" || measured.book !== BOOK || measured.vault !== VAULT || measured.hostOwnership !== OWN) fail.push("recomputed MEASURED is not the original vault's");
for (const u of hp.mirrors) if (!js.includes(u)) fail.push(`custodian bundle lacks mirror ${u}`);
r.measured = measured;
r.measuredText = { sha256: sha(expect), occurrences };
report.hostPolicy = { ...hp, sha256: sha(fs.readFileSync(path.join(REPO, "release/host-policy-production.json"))) };
report.lockfiles = { "package-lock.json": sha(fs.readFileSync(path.join(REPO, "package-lock.json"))), "relay/package-lock.json": sha(fs.readFileSync(path.join(REPO, "relay/package-lock.json"))) };

// ---- the rewrap image: reuse the frozen c635fd68 artifact only if its whole closure is unchanged ----
const rw = JSON.parse(fs.readFileSync(path.join(FROZEN, "A-rewrap/manifest.json"), "utf8"));
const rwClosure = [...rw.bundleInputs.repo, "scripts/build-custody-rewrap.mjs", "custody/v2/build-config.mjs", "package.json", "package-lock.json", "relay/package.json", "relay/package-lock.json",
  "release/host-policy-production.json"];   // the rewrap builder's content closure: its esbuild inputs, itself, its imports
                                            // (build-config; rewrap.mjs and host-policy-mirrors are inputs), npm locks, policy
const rwChanged = git(["diff", "--name-only", PREV, head, "--", ...rwClosure]).split("\n").filter(Boolean);
const rwInitramfs = sha(fs.readFileSync(path.join(FROZEN, "A-rewrap/initramfs.cpio.gz")));
if (rwChanged.length) fail.push(`rewrap closure changed since ${PREV}: ${rwChanged.join(" ")}`);
if (rw.commit !== PREV || rwInitramfs !== rw.initramfs.sha256) fail.push("the frozen rewrap artifact is not the verified c635fd68 build");
report.rewrap = { reused: !rwChanged.length, artifact: path.join(FROZEN, "A-rewrap"), commit: rw.commit, measurement: rw.measurement, measurementSha256: rw.measurementSha256,
  initramfsSha256: rwInitramfs, closurePaths: rwClosure.length, changedSincePrev: rwChanged, base: rw.base };
if (JSON.stringify(rw.base) !== JSON.stringify(m.base)) fail.push("the frozen rewrap and the new custodian use different bases");
report.failures = fail;
fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
console.log(JSON.stringify({ releaseCommit: head, clean: report.clean, failures: fail.length ? fail : "none", measurement: m.measurement, measurementSha256: m.measurementSha256,
  inputs: inputs.length, reviewedChanges: r.inputs.filter((x) => x.reviewedChange).map((x) => x.path), added: r.inputsAddedSincePrev, rewrapReused: report.rewrap.reused }, null, 1));
process.exit(fail.length ? 1 : 0);
