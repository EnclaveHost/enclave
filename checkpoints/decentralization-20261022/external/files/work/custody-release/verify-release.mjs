// Verify a RELEASE build against its committed source (read-only):
//   node verify-release.mjs <release checkout> <custodian dir> <rewrap dir> <main working tree> <out.json>
// For each image manifest:
//   - manifest.commit == the checkout's HEAD, and HEAD is clean (git status --porcelain empty, everything tracked);
//   - every bundleInputs.repo path is tracked at HEAD, its committed blob == the file on disk == main's integrated file;
//   - each builder's own sourceCheck (custody/v2/build-config.mjs) recomputed: no untracked, no dirty;
//   - every bundled package name@version == the version the governing lockfile pins for the node_modules root it came
//     from (package-lock.json, relay/package-lock.json), and npm's installed-tree record agrees (version + integrity);
//   - the rewrap manifest: sourcesCommitted === true, measured.hostPolicy == release/host-policy-production.json;
//   - the custodian image embeds exactly the committed host policy (custodian.mjs bundle text carries every mirror).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const [REPO, CDIR, RDIR, MAIN, OUT] = process.argv.slice(2).map((p) => path.resolve(p));
const git = (args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, GIT_DIR: path.join(REPO, ".git"), GIT_OPTIONAL_LOCKS: "0" } });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const fail = [];
const head = git(["rev-parse", "HEAD"]).trim();
const porcelain = git(["status", "--porcelain"]).trim();
if (porcelain) fail.push(`checkout is not clean:\n${porcelain}`);
const B = await import(path.join(REPO, "custody/v2/build-config.mjs"));
const hp = JSON.parse(fs.readFileSync(path.join(REPO, "release/host-policy-production.json"), "utf8"));
const lock = (rel) => JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));
const locks = { "": lock("package-lock.json"), "relay/": lock("relay/package-lock.json") };
const hidden = { "": lock("node_modules/.package-lock.json"), "relay/": lock("relay/node_modules/.package-lock.json") };
const report = { releaseCommit: head, parent: git(["rev-parse", "HEAD~1"]).trim(), clean: !porcelain, images: {} };
for (const [name, dir, staticList] of [["custodian", CDIR, B.STATIC_IMAGE_SOURCES], ["rewrap", RDIR, ["scripts/build-custody-rewrap.mjs", "package.json", "package-lock.json"]]]) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const r = { commit: m.commit, measurement: m.measurement, measurementSha256: m.measurementSha256, initramfs: m.initramfs, files: m.files, base: m.base,
              kernelSha256: m.kernel?.sha256, ovmfSha256: m.ovmfSha256, cmdline: m.cmdline, bundler: m.bundler, ...(name === "rewrap" ? { sourcesCommitted: m.sourcesCommitted, runtimeId: m.runtimeId } : {}) };
  if (m.commit !== head) fail.push(`${name}: manifest commit ${m.commit} != HEAD ${head}`);
  if (name === "rewrap" && m.sourcesCommitted !== true) fail.push("rewrap: sourcesCommitted is not true");
  if (m.measurementError || !/^[0-9a-f]{96}$/.test(String(m.measurement))) fail.push(`${name}: no measurement`);
  if (sha(fs.readFileSync(path.join(dir, "initramfs.cpio.gz"))) !== m.initramfs.sha256) fail.push(`${name}: initramfs hash`);
  const inputs = m.bundleInputs?.repo || [];
  if (!inputs.length) fail.push(`${name}: manifest lists no bundle inputs`);
  const tracked = new Set(git(["ls-files", "--", ...inputs]).split("\n").filter(Boolean));
  r.inputs = inputs.map((f) => {
    const blob = execFileSync("git", ["show", `HEAD:${f}`], { cwd: REPO, maxBuffer: 64 << 20, env: { ...process.env, GIT_DIR: path.join(REPO, ".git") } });
    const disk = fs.readFileSync(path.join(REPO, f)), mainFile = fs.readFileSync(path.join(MAIN, f));
    const ok = tracked.has(f) && sha(blob) === sha(disk) && sha(disk) === sha(mainFile);
    if (!ok) fail.push(`${name}: ${f} not tracked or differs (commit/disk/main)`);
    return { path: f, sha256: sha(disk), tracked: tracked.has(f), equalsCommit: sha(blob) === sha(disk), equalsMainIntegrated: sha(disk) === sha(mainFile) };
  });
  const sc = B.sourceCheck({ repo: [...inputs, ...staticList] }, { git });
  r.sourceCheck = { untracked: sc.untracked, dirty: sc.dirty, paths: sc.paths.length };
  if (sc.untracked.length || sc.dirty) fail.push(`${name}: sourceCheck not clean`);
  // packages: which node_modules root each came from is not in the manifest; check both roots that exist for the name
  r.packages = (m.bundleInputs?.packages || []).map((p) => {
    const at = p.lastIndexOf("@"), n = p.slice(0, at), v = p.slice(at + 1);
    const roots = Object.keys(locks).filter((root) => locks[root].packages[`node_modules/${n}`]?.version === v);
    const okHidden = roots.length > 0 && roots.every((root) => {
      const a = locks[root].packages[`node_modules/${n}`], h = hidden[root].packages[`node_modules/${n}`];
      return h && h.version === a.version && h.integrity === a.integrity;
    });
    if (!roots.length) fail.push(`${name}: ${p} pinned by no lockfile`);
    if (!okHidden) fail.push(`${name}: ${p} installed tree disagrees with its lockfile`);
    return { package: p, lockfiles: roots.map((x) => `${x}package-lock.json`), integrity: roots.map((x) => locks[x].packages[`node_modules/${n}`].integrity) };
  });
  report.images[name] = r;
}
// host policy actually measured
const rm = JSON.parse(fs.readFileSync(path.join(RDIR, "manifest.json"), "utf8"));
if (JSON.stringify(rm.measured?.hostPolicy) !== JSON.stringify(hp)) fail.push("rewrap: measured hostPolicy != release/host-policy-production.json");
let found = new Set(), tail = "";
for await (const ch of fs.createReadStream(path.join(CDIR, "initramfs.cpio.gz")).pipe(zlib.createGunzip())) {
  const s = tail + ch.toString("latin1"); for (const u of hp.mirrors) if (s.includes(u)) found.add(u); tail = s.slice(-200);
}
if (found.size !== hp.mirrors.length) fail.push(`custodian: embeds ${found.size}/${hp.mirrors.length} mirrors`);
report.hostPolicy = { ...hp, sha256: sha(fs.readFileSync(path.join(REPO, "release/host-policy-production.json"))), custodianMirrorsEmbedded: found.size };
report.lockfiles = { "package-lock.json": sha(fs.readFileSync(path.join(REPO, "package-lock.json"))), "relay/package-lock.json": sha(fs.readFileSync(path.join(REPO, "relay/package-lock.json"))) };
report.failures = fail;
fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
console.log(JSON.stringify({ releaseCommit: head, clean: report.clean, failures: fail.length ? fail : "none",
  custodian: [report.images.custodian.measurement, report.images.custodian.inputs.length + " inputs"], rewrap: [report.images.rewrap.measurement, report.images.rewrap.sourcesCommitted] }, null, 1));
process.exit(fail.length ? 1 : 0);
