// Read-only generator for work/windows-final-source-inventory.json. Run from work/enclave: node ../claude-windows-inventory.gen.mjs
const root = process.cwd();
const { build } = await import(root + "/node_modules/esbuild/lib/main.js");
const fs = await import("node:fs"), path = await import("node:path"), { execFileSync } = await import("node:child_process"), { createHash } = await import("node:crypto");
const git = (a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
const sha = (f) => { const p = path.join(root, f); return fs.existsSync(p) && fs.statSync(p).isFile() ? createHash("sha256").update(fs.readFileSync(p)).digest("hex") : null; };
const statusOf = (f) => { const l = git(["status", "--porcelain", "--", f]).split("\n").find(Boolean); return l ? l.slice(0, 2) : "clean"; };
const lsDir = (d) => fs.readdirSync(path.join(root, d)).map((x) => `${d}/${x}`);
// THE PROPOSED WINDOWS COMMIT SET: every dirty or untracked file the Windows integration needs (no README/site files)
const SET = {
  "windows/installer": ["windows/installer/EnclaveSetup.cs", "windows/installer/install-host.ps1", "windows/installer/update-host.ps1"],
  "windows/node": ["agent", "apptls", "domains", "host-onchain", "host", "isolation-client", "keys", "secrets", "shield-secrets", "host-ownership", "shield-custody", "shield-startup"].map((n) => `windows/node/${n}.mjs`),
  "windows/vbslike/datapath": ["windows/vbslike/datapath/node-bridge.mjs"],
  "windows/vbslike/manager": ["main", "server", "shield-profile", "wmi-launcher", "bridge-auth", "custody-key-file", "custody-transport", "package-transport"].map((n) => `windows/vbslike/manager/${n}.mjs`).concat(["windows/vbslike/manager/testdata/fake-custody-bridge.py"]),
  "windows/vbslike/host (native bridge)": ["windows/vbslike/host/src/bin/shielded-bridge.rs", "windows/vbslike/host/src/bin/bridge-auth-check.rs"],
  "relay (Shield market verifier, shared hunk)": ["relay/shield-independent-verifier.mjs", "relay/shield-market-evidence.mjs", "relay/shield-marketplace.mjs"],
  "scripts": ["scripts/network/shield-verifier.mjs", "scripts/publish-windows-host.sh"],
  "docs": ["docs/network/independent-windows.md"],
  "tests": ["windows-host-identity", "windows-installer-independence", "windows-publish-host", "windows-shield-custody-transport", "windows-shield-image-selection",
            "windows-shield-local-auth", "windows-shield-package-transport", "windows-manager-vm-scope", "windows-shield-startup", "windows-shield-verifier"].map((n) => `test/${n}.test.mjs`)
            .concat(lsDir("test/windows-native")),
};
const inSet = new Set(Object.values(SET).flat());
// owners of what is NOT in the set (from the coordinator's assignment)
const ownerOf = (f) => /^relay\/(dns-relay\.js|dns-challenge-(attested|shield)\.mjs)$/.test(f) || /^test\/(dns-relay-attested|shield-dns-challenge)\.test\.mjs$/.test(f) ? "DNS responder (16942)"
  : /^(cli\/|network\/management-|test\/(cli|custody-cli|management|move|sessions)|test\/helpers\/(cli-|move-|fork-)|test\/fixtures\/registry-schema4)/.test(f) ? "supervisor/CLI/management (10514)"
  : /^(site\/|sdk\/|scripts\/(build-vendor|build-aa-vendor|build-management-vendor|site-release|vendor|network\/browser-profile)|test\/(site-|browser-))/.test(f) ? "browser (83383)"
  : "unassigned";
const closure = async (f) => {
  const r = await build({ entryPoints: [path.join(root, f)], bundle: true, platform: "node", format: "esm", write: false, metafile: true, packages: "external",
    logLevel: "silent", absWorkingDir: root, outdir: "/nonexistent", loader: { ".node": "empty" } });
  return Object.keys(r.metafile.inputs).filter((x) => !x.includes("node_modules"));
};
const entries = ["windows/vbslike/manager/main.mjs", "windows/node/agent.mjs", "windows/node/keys.mjs", "windows/node/host-onchain.mjs", "relay/shield-independent-verifier.mjs", "relay/shield-marketplace.mjs",
  "scripts/network/shield-verifier.mjs", ...SET.tests.filter((f) => f.endsWith(".test.mjs")), "test/windows-native/make-fixtures.mjs",
  ...fs.readdirSync(path.join(root, "windows/vbslike/manager")).filter((x) => x.endsWith(".test.mjs")).map((x) => `windows/vbslike/manager/${x}`)];
const deps = new Map();                                  // file -> [entries]
const errors = {};
for (const e of entries) {
  try { for (const f of await closure(e)) { if (!deps.has(f)) deps.set(f, []); deps.get(f).push(e); } }
  catch (x) { errors[e] = String(x.message).split("\n").slice(0, 3).join(" | "); }
}
const entry = (f) => ({ path: f, status: statusOf(f), sha256: sha(f) });
const outside = [...deps.keys()].filter((f) => !inSet.has(f)).map((f) => ({ ...entry(f), owner: ownerOf(f), neededBy: [...new Set(deps.get(f))].slice(0, 6) }))
  .filter((e) => e.status !== "clean");
const unusedInSet = [...inSet].filter((f) => !deps.has(f) && /\.(mjs|js)$/.test(f));
const out = {
  format: "enclave-windows-source-inventory/1",
  generatedAt: new Date().toISOString(),
  baselineHead: git(["rev-parse", "HEAD"]).trim(),
  note: "Proposed Windows commit closure (NOT staged or committed). Custody Shield (custody/v2, relay/shield-host-session, windows/node/shield-sessions+shield-verdict) is already committed in ee8beb38; a5493f60 is HEAD.",
  commitSet: Object.fromEntries(Object.entries(SET).map(([k, v]) => [k, v.map(entry)])),
  dirtyDependenciesOutsideSet: outside,
  setFilesNotReachedByEntries: unusedInSet,
  // references esbuild cannot see (PowerShell, shell, C#, processes): checked by hand
  nonJsReferences: [
    { from: "test/windows-native/run.ps1", to: "cli/host.ps1", how: "loads its functions from its syntax tree (release-channel parity)", ...entry("cli/host.ps1"), owner: ownerOf("cli/host.ps1") },
    { from: "windows/installer/install-host.ps1", to: "windows/node/keys.mjs", how: "runs it as a process", ...entry("windows/node/keys.mjs"), owner: "in set" },
    { from: "windows/installer/install-host.ps1", to: "network/contract-pins.mjs", how: "named in comments/paths of the installed control tree", ...entry("network/contract-pins.mjs"), owner: "committed" },
    { from: "windows/installer/install-host.ps1", to: "relay/referrals.mjs", how: "named in the installed control tree", ...entry("relay/referrals.mjs"), owner: "committed" },
  ],
  closureErrors: errors,
  entries,
};
fs.writeFileSync(path.resolve(root, "../windows-final-source-inventory.json"), JSON.stringify(out, null, 2) + "\n");
const flat = Object.values(out.commitSet).flat();
console.log(JSON.stringify({ setFiles: flat.length, statuses: flat.reduce((m, e) => (m[e.status] = (m[e.status] || 0) + 1, m), {}), missing: flat.filter((e) => !e.sha256).map((e) => e.path),
  outside: outside.map((e) => `${e.status} ${e.path} [${e.owner}] <- ${e.neededBy.join(", ").slice(0, 160)}`), unusedInSet, errors }, null, 1));
