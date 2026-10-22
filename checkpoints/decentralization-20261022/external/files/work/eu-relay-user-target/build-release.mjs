#!/usr/bin/env node
// build-release.mjs - freezes the USER-SERVICE release of main's lease-relay HOST ROLE for warden-host (the moved eu-central
// relay key), as one immutable directory plus a deterministic tar:
//   app/        the role supervisor's EXACT runtime closure from the repository, byte for byte, in its relative layout:
//               network/host-services/lease-relay-host.mjs and every module it imports statically or by literal dynamic
//               import (esbuild's metafile resolves them; nothing is bundled or rewritten, so every module keeps its own
//               import.meta.url and the role's CLI main-check is the source's), plus the locked npm packages they import
//               (package-lock.json versions, copied from the installed node_modules, version-checked)
//   packages/   the role's pinned relay child package (the repository's scripts/build-lease-relay-host-package.mjs)
//   gate/       the migration verifier (the repository's scripts/build-lease-relay-migration-check.mjs)
//   forwarder/  the fixed LAN forwarder for the minipc fallback (files/lan-forwarder.mjs)
//   units/      the two user-unit templates (files/*.service.in)
//   verify-release.mjs, RELEASE.json   every file's sha256 and size; the release id is sha256 of that list
// Bundled bytes are never secrets or private configuration: the configuration and the key live outside the release.
//   node build-release.mjs --repo <enclave checkout> --out <dir>     (dir must not exist; prints one JSON line)
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, "")] = args[i + 1];
if (!opt.repo || !opt.out) { console.error("usage: build-release.mjs --repo <enclave checkout> --out <new dir>"); process.exit(2); }
const REPO = path.resolve(opt.repo), OUT = path.resolve(opt.out);
const ENTRY = "network/host-services/lease-relay-host.mjs";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const die = (m) => { console.error(`build-release: ${m}`); process.exit(1); };
if (fs.existsSync(OUT)) die(`${OUT} exists (create-only)`);
const tmp = OUT + ".building";
if (fs.existsSync(tmp)) die(`${tmp} exists: remove the earlier partial build`);

// ---- 1. the closure, as esbuild resolves it (static and literal dynamic imports; npm packages external)
const { build } = await import(pathToFileURL(path.join(REPO, "node_modules/esbuild/lib/main.js")).href);
const r = await build({ absWorkingDir: REPO, entryPoints: [ENTRY], bundle: true, write: false, metafile: true, platform: "node", format: "esm",
  // preserveSymlinks: a module is recorded at the path its importer names (main's relay/net-guard.mjs is a symlink to
  // ../net-guard.mjs; its realpath would leave app/relay/net-guard.mjs missing). Its bytes are copied as a regular file.
  target: "node22", packages: "external", preserveSymlinks: true, logLevel: "silent" });
const sources = Object.keys(r.metafile.inputs).filter((p) => !p.startsWith("node_modules/")).sort();
const bare = new Set();
for (const inp of Object.values(r.metafile.inputs)) for (const im of inp.imports) if (im.external && !im.path.startsWith("node:"))
  bare.add(im.path.startsWith("@") ? im.path.split("/").slice(0, 2).join("/") : im.path.split("/")[0]);
if (!sources.includes(ENTRY)) die("the entry is not in its own closure");
// ---- 2. the locked npm packages those imports need, transitively (package-lock.json is the authority)
const lock = JSON.parse(fs.readFileSync(path.join(REPO, "package-lock.json"), "utf8")).packages;
const pkgs = new Map(), queue = [...bare];
while (queue.length) {
  const name = queue.shift(), key = `node_modules/${name}`;
  if (pkgs.has(key)) continue;
  const p = lock[key]; if (!p) die(`${name} is not in package-lock.json`);
  pkgs.set(key, p);
  for (const d of Object.keys({ ...(p.dependencies || {}), ...(p.peerDependencies || {}) })) {
    if (lock[`${key}/node_modules/${d}`]) die(`${name} has a nested ${d}: not supported by this freezer`);
    if ((p.peerDependenciesMeta || {})[d]?.optional) continue;
    queue.push(d);
  }
}
// ---- 3. copy: sources byte for byte, packages as installed (refusing symlinks and version drift)
fs.mkdirSync(tmp, { recursive: true });
const copyFile = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
for (const s of sources) copyFile(path.join(REPO, s), path.join(tmp, "app", s));   // copyFileSync follows a symlink: a regular file
const linked = sources.filter((s) => fs.lstatSync(path.join(REPO, s)).isSymbolicLink());
const packages = {};
for (const [key, p] of [...pkgs].sort(([a], [b]) => a.localeCompare(b))) {
  const src = path.join(REPO, key), pj = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
  if (pj.version !== p.version) die(`${key} is installed at ${pj.version}, the lock says ${p.version}`);
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name), rel = path.relative(REPO, f);
    if (e.isSymbolicLink()) die(`${rel} is a symlink: refused`);
    if (e.isDirectory()) { if (e.name === "node_modules" || e.name === ".bin") die(`${rel}: nested modules are not supported`); walk(f); }
    else if (e.isFile()) copyFile(f, path.join(tmp, "app", rel));
  } };
  walk(src);
  packages[key] = { version: p.version, integrity: p.integrity, resolved: p.resolved };
}
// ---- 4. the repository's own builders for the relay child package and the migration verifier
const pkgOut = JSON.parse(execFileSync(process.execPath, [path.join(REPO, "scripts/build-lease-relay-host-package.mjs"), path.join(tmp, "packages")], { encoding: "utf8" }).trim().split("\n").at(-1));
execFileSync(process.execPath, [path.join(REPO, "scripts/build-lease-relay-migration-check.mjs"), path.join(tmp, "gate")], { stdio: ["ignore", "ignore", "inherit"] });
for (const [f, to] of [["lan-forwarder.mjs", "forwarder/lan-forwarder.mjs"], ["verify-release.mjs", "verify-release.mjs"],
  ["enclave-host-relay-eu.service.in", "units/enclave-host-relay-eu.service.in"], ["enclave-host-relay-eu-lan.service.in", "units/enclave-host-relay-eu-lan.service.in"]])
  copyFile(path.join(HERE, "files", f), path.join(tmp, to));
// ---- 5. modes (owner only), the manifest, the id
const files = {};
const all = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  const f = path.join(d, e.name);
  if (e.isDirectory()) { fs.chmodSync(f, 0o700); all(f); } else { fs.chmodSync(f, 0o600); const b = fs.readFileSync(f); files[path.relative(tmp, f)] = { sha256: sha(b), bytes: b.length }; }
} };
fs.chmodSync(tmp, 0o700); all(tmp);
const head = (() => { try { return execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })();
const dirty = (() => { try { return execFileSync("git", ["-C", REPO, "status", "--porcelain", "--", ...sources, "package-lock.json", "scripts/build-lease-relay-host-package.mjs",
  "scripts/build-lease-relay-release.mjs", "scripts/build-lease-relay-migration-check.mjs"], { encoding: "utf8" }).split("\n").filter(Boolean).map((l) => l.slice(3)); } catch { return null; } })();
const body = { format: "enclave-host-relay-user-release/v1", entry: `app/${ENTRY}`, node: ">=22", files, packages,
  relayPackage: { pin: pkgOut.package, bundleSha256: pkgOut.bundleSha256 }, gateSha256: files["gate/lease-relay-migration-check.mjs"].sha256 };
const id = sha(JSON.stringify(body));
const manifest = { ...body, releaseId: id, builtFrom: { repo: REPO, head, sourcesNotCommitted: dirty, symlinkedInRepo: linked, sources: Object.fromEntries(sources.map((s) => [s, files[`app/${s}`].sha256])) } };
fs.writeFileSync(path.join(tmp, "RELEASE.json"), JSON.stringify(manifest, null, 1) + "\n", { mode: 0o600 });
fs.mkdirSync(OUT, { mode: 0o700 });
fs.renameSync(tmp, path.join(OUT, id));
// ---- 6. the deterministic archive (sorted names, fixed times, numeric ids, owner-only modes)
const tar = path.join(OUT, `${id}.tar`);
execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--format=gnu", "-C", OUT, "-cf", tar, id]);
console.log(JSON.stringify({ releaseId: id, dir: path.join(OUT, id), tar, tarSha256: sha(fs.readFileSync(tar)), files: Object.keys(files).length,
  sources: sources.length, packages: Object.fromEntries(Object.entries(packages).map(([k, v]) => [k.replace("node_modules/", ""), v.version])),
  relayPackage: pkgOut.package, gateSha256: body.gateSha256, head, sourcesNotCommitted: dirty?.length ?? null }));
