// Generates work/custody-final-source-inventory.json from the repository as it is (read-only: no writes in the repo).
// It never stages or writes the index: every git call runs with GIT_OPTIONAL_LOCKS=0 (so `git status` does not refresh and
// rewrite .git/index or take index.lock under another session), and the staged set is compared before and after.
const root = process.cwd();
const { build } = await import(root + "/node_modules/esbuild/lib/main.js");
const bc = await import(root + "/custody/v2/build-config.mjs");
const fs = await import("node:fs"), path = await import("node:path"), { execFileSync } = await import("node:child_process"), { createHash } = await import("node:crypto");
const git = (a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
const staged = () => git(["diff", "--cached", "--name-status"]).trim();
const stagedBefore = staged(), indexMtimeBefore = fs.statSync(path.join(root, ".git/index")).mtimeMs;
const sha = (f) => { const p = path.join(root, f); return fs.existsSync(p) ? createHash("sha256").update(fs.readFileSync(p)).digest("hex") : null; };
// porcelain XY kept as is: "??" untracked, " M" modified (unstaged), "M " staged, "MM" staged then modified again
const status = (f) => { const l = git(["status", "--porcelain", "--", f]).split("\n").find(Boolean); return l ? l.slice(0, 2) : "clean"; };
const COMPONENT = {
  production: ["custody/v2/custodian.mjs", "custody/v2/shield-evidence.mjs", "custody/v2/shield-rules.mjs", "custody/v2/shield-operator.mjs", "custody/v2/http.mjs",
    "custody/v2/host-config.mjs", "custody/v2/daemon.mjs", "custody/v2/build-config.mjs", "custody/v2/ingress.mjs", "scripts/build-custodian-v2.mjs",
    "relay/shield-host-session.mjs", "relay/dns-challenge-shield.mjs"],
  // shared modules commit A carries (the image needs shield-verdict; three commit-A tests need shield-sessions)
  shared: ["windows/node/shield-verdict.mjs", "windows/node/shield-sessions.mjs"],
  docs: ["docs/security/custodian-shield-recipients.md"],
  tests: ["test/shield-custody.test.mjs", "test/helpers/shield-custody-rig.mjs", "test/custody-v2-shield-daemon.test.mjs", "test/custody-v2-build.test.mjs",
    "test/shield-host-session.test.mjs", "test/helpers/malicious-ek.mjs", "test/custody-v2-ingress-ratekey.test.mjs", "test/shield-dns-challenge.test.mjs",
    "test/windows-shield-verifier.test.mjs"],
};
const mine = new Set(Object.values(COMPONENT).flat());
// COMMIT A (work/claude-custody-peer-review-result.md section 4): the custodian Shield recipients, self-contained. The DNS
// responder (commit B) and test/windows-shield-verifier.test.mjs (commit C, with the Windows change) are NOT in it.
const COMMIT_A = ["custody/v2/custodian.mjs", "custody/v2/daemon.mjs", "custody/v2/http.mjs", "custody/v2/host-config.mjs", "custody/v2/build-config.mjs",
  "custody/v2/shield-evidence.mjs", "custody/v2/shield-operator.mjs", "custody/v2/shield-rules.mjs", "custody/v2/ingress.mjs", "scripts/build-custodian-v2.mjs",
  "relay/shield-host-session.mjs", "windows/node/shield-verdict.mjs", "windows/node/shield-sessions.mjs", "docs/security/custodian-shield-recipients.md",
  "test/shield-custody.test.mjs", "test/custody-v2-shield-daemon.test.mjs", "test/custody-v2-build.test.mjs", "test/shield-host-session.test.mjs",
  "test/custody-v2-ingress-ratekey.test.mjs", "test/helpers/shield-custody-rig.mjs", "test/helpers/malicious-ek.mjs"];
const COMMIT_A_TESTS = COMMIT_A.filter((f) => f.endsWith(".test.mjs"));
const entry = (f) => ({ path: f, status: status(f), sha256: sha(f) });
// 1. the custodian image's JavaScript: exactly the build's bundles (default measured config; the opt-in adds no module)
const { measured } = bc.custodianMeasured({ vault: "0x" + "56".repeat(20), hostOwnership: "0x" + "f5".repeat(20) });
const opts = bc.bundleOptions(bc.measuredModule(measured), { root });
const d = await build({ ...opts, entryPoints: [path.join(root, "custody/v2/daemon.mjs")] }), g = await build({ ...opts, entryPoints: [path.join(root, "custody/v2/cvm-gsup.mjs")] });
const srcs = bc.bundleSources([d.metafile, g.metafile], { root });
const check = bc.sourceCheck(srcs, { git });
// 2. import closures (no node_modules): each component test, and the DNS responder's handler
const closure = async (f) => { const r = await build({ entryPoints: [path.join(root, f)], bundle: true, platform: "node", format: "esm", write: false, metafile: true, packages: "external", logLevel: "silent", absWorkingDir: root, outdir: "/nonexistent" });
  return Object.keys(r.metafile.inputs).filter((x) => !x.includes("node_modules")).sort(); };
const perTest = {};
for (const t of new Set([...COMPONENT.tests, "test/custody-v2-shield-daemon.test.mjs"])) perTest[t] = await closure(t);
const dnsClosure = await closure("relay/dns-challenge-shield.mjs");
// commit A's own closure: the image's bundle inputs and every commit-A test's imports; anything dirty in it must BE in commit A
const aSet = new Set(COMMIT_A), aClosure = new Set(srcs.repo);
for (const t of COMMIT_A_TESTS) for (const f of (perTest[t] || await closure(t))) aClosure.add(f);
const aMissing = [...aClosure].filter((f) => !aSet.has(f)).map(entry).filter((e) => e.status !== "clean");
const dirtyOutside = (list) => list.filter((f) => !mine.has(f)).map(entry).filter((e) => e.status !== "clean");
const staticDirty = bc.STATIC_IMAGE_SOURCES.map((p) => ({ path: p, porcelain: git(["status", "--porcelain", "--", p]).split("\n").filter(Boolean) }));
const out = {
  format: "enclave-custody-source-inventory/1",
  generatedAt: new Date().toISOString(),
  baselineHead: git(["rev-parse", "HEAD"]).trim(),
  scope: "custody v2 Shield recipient daemon integration + challenge-admission/rate hardening + DNS responder bounds (Claude); the Shield-direct GUEST candidate c7084346 is a separate artifact and not part of this inventory",
  component: Object.fromEntries(Object.entries(COMPONENT).map(([k, v]) => [k, v.map(entry)])),
  custodianImage: {
    bundleInputs: srcs.repo.map(entry), packages: srcs.packages, bundler: "esbuild@" + (await import(root + "/node_modules/esbuild/package.json", { with: { type: "json" } })).default.version,
    staticSources: staticDirty,
    buildSourceCheckToday: { untracked: check.untracked, dirty: check.dirty.split("\n").filter(Boolean) },
    dependsOnDirtyCodeOutsideComponent: dirtyOutside(srcs.repo),
  },
  commitA: { files: COMMIT_A.map(entry), closureDirtyOutsideCommitA: aMissing,
             note: "commit together; after it, buildSourceCheckToday must be empty for the image (re-run this generator)" },
  dnsResponder: { entry: "relay/dns-challenge-shield.mjs (wired by relay/dns-relay.js, not part of this component)", importClosure: dnsClosure.map(entry),
                  dependsOnDirtyCodeOutsideComponent: dirtyOutside(dnsClosure), wiredBy: entry("relay/dns-relay.js") },
  tests: Object.fromEntries(Object.entries(perTest).map(([t, deps]) => [t, { dependsOnDirtyCodeOutsideComponent: dirtyOutside(deps).map((e) => `${e.status} ${e.path}`) }])),
};
// the generator must not have staged anything: the staged set is what it was (another session's staging is left as found)
const stagedAfter = staged();
if (stagedAfter !== stagedBefore) throw new Error(`the index changed during inventory generation:\nbefore:\n${stagedBefore}\nafter:\n${stagedAfter}`);
out.index = { stagedAtGeneration: stagedBefore ? stagedBefore.split("\n") : [], unchangedByGenerator: true,
              indexFileRewritten: fs.statSync(path.join(root, ".git/index")).mtimeMs !== indexMtimeBefore };
fs.writeFileSync(path.resolve(root, "../custody-final-source-inventory.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ bundleInputs: srcs.repo.length, untracked: check.untracked.length, dirtyLines: out.custodianImage.buildSourceCheckToday.dirty.length,
  imageDirtyOutside: out.custodianImage.dependsOnDirtyCodeOutsideComponent, dnsDirtyOutside: out.dnsResponder.dependsOnDirtyCodeOutsideComponent,
  tests: Object.fromEntries(Object.entries(out.tests).map(([t, v]) => [t, v.dependsOnDirtyCodeOutsideComponent])),
  static: staticDirty.filter((s) => s.porcelain.length), commitAClosureDirtyOutside: aMissing, index: out.index }, null, 1));
