#!/usr/bin/env node
// Additive composite site release: the exact, verified files of an existing immutable release (a root-provided local
// copy, checked file by file against its captured inventory and re-derived to its CID) plus exactly the five reviewed
// funding-addon files, imported with the repository's hash-pinned UnixFS/CAR code into a NEW CID. Nothing existing is
// rewritten: no ledger, installer, retention or metadata change (prepareRelease/deriveRelease are NOT used). Composite
// provenance is a sidecar OUTSIDE the CID payload. Every input is validated before the first write; a run that fails
// after writing leaves its output in place, marked NOT-QUALIFIED. No network, no shell, no activation.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// scripts/site-release/{unixfs,car}.mjs as reviewed (additive-release-approach.json "pins"); not overridable
export const SITE_RELEASE_PINS = Object.freeze({
  "unixfs.mjs": "9f6a15811abbbde6b99bcd496a8e811f3cecaeed3290c619b93f3ecd3068313c",
  "car.mjs": "41ef40923a0f3b13080bb8ee9bb805fb47bd99e213ccadf35936abae18b0886a",
});
export const ADDITION_COUNT = 5;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024, MAX_DEPTH = 32;
const ADDON_SCHEMA = "enclave-funding-addon-manifest-r2", PINS_SCHEMA = "enclave-funding-addon-pins-r2";
const ADDON_TOP = ["ADDITIONS.json", "ADDITIONS.sha256", "MANIFEST.json", "site-additions"];
const PIN_KEYS = ["config", "existingPaths", "liveInventory", "liveSessionsVendor"];
export const PROVENANCE = "composite-provenance.json", FAILED = "NOT-QUALIFIED.txt";
const HEX64 = /^[0-9a-f]{64}$/, CID = /^b[a-z2-7]{58}$/, COMMIT = /^[0-9a-f]{7,40}$/, ADDON_SEG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OPTIONS = ["baseTree", "inventory", "addon", "addonPins", "out", "siteReleaseDir", "baseCid", "expectFiles", "expectBytes",
  "expectInventorySha256", "expectAddonManifestSha256", "baseSourceCommit", "baseSourceDirty"];

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const fail = (m) => { throw new Error(m); };
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const byBytes = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
// the same name rule as unixfs.mjs importDirectory: what it would refuse is refused here first
const NAME_OK = (n) => n.length > 0 && n !== "." && n !== ".." && !/[\/\0]/.test(n) && Buffer.from(n, "utf8").toString("utf8") === n;
const relOk = (p) => typeof p === "string" && p.split("/").every(NAME_OK);
const ancestors = (p) => p.split("/").slice(0, -1).map((_, i, s) => s.slice(0, i + 1).join("/"));
const join = (root, rel) => path.join(root, ...rel.split("/"));

/** Python json.dumps(obj, sort_keys=True, separators=(",", ":")) (ensure_ascii) of capture-tree.py's {files, directories}. */
export function pyCanonical(files, directories) {
  const s = JSON.stringify({ directories, files: files.map((f) => ({ bytes: f.bytes, path: f.path, sha256: f.sha256 })) });
  return s.replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

// ---- paths: absolute, normalized, no symlink anywhere on the way ----
function absPath(p, what) {
  if (typeof p !== "string" || !path.isAbsolute(p) || path.resolve(p) !== p) fail(`${what} must be an absolute, normalized path: ${p}`);
  return p;
}
function noSymlinkAncestors(p, what) {
  let cur = path.parse(p).root;
  for (const seg of p.slice(cur.length).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    if (fs.lstatSync(cur).isSymbolicLink()) fail(`${what}: ${cur} is a symlink`);
  }
  if (fs.realpathSync(p) !== p) fail(`${what}: ${p} does not resolve to itself`);
}
function existing(p, what, kind) {
  absPath(p, what); noSymlinkAncestors(p, what);
  const st = fs.lstatSync(p);
  if (kind === "dir" ? !st.isDirectory() : !st.isFile()) fail(`${what}: ${p} is not a ${kind === "dir" ? "directory" : "regular file"}`);
  return p;
}

// ---- reads: O_NOFOLLOW, exact size, unchanged while read ----
function readFd(fd, size, what) {
  const buf = Buffer.alloc(size); let off = 0;
  while (off < size) { const n = fs.readSync(fd, buf, off, size - off, off); if (!n) fail(`${what}: truncated while reading`); off += n; }
  if (fs.readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) fail(`${what}: grew while reading`);
  return buf;
}
function openRegular(abs, what, fn) {
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) fail(`${what}: not a regular file`);
    const out = fn(fd, st), after = fs.fstatSync(fd, { bigint: true });
    if (after.size !== st.size || after.mtimeNs !== st.mtimeNs || after.ctimeNs !== st.ctimeNs) fail(`${what}: changed while reading`);
    return out;
  } finally { fs.closeSync(fd); }
}
function readSmall(abs, what) {
  return openRegular(abs, what, (fd, st) => {
    if (st.size > BigInt(MAX_JSON_BYTES)) fail(`${what}: larger than ${MAX_JSON_BYTES} bytes`);
    return readFd(fd, Number(st.size), what);
  });
}
function readExact(abs, bytes, ino, what) {
  return openRegular(abs, what, (fd, st) => {
    if (st.nlink !== 1n) fail(`${what}: refusing a hard-linked file (nlink ${st.nlink})`);
    if (ino !== undefined && st.ino !== ino) fail(`${what}: replaced since it was listed`);
    if (st.size !== BigInt(bytes)) fail(`${what}: ${st.size} bytes, expected ${bytes}`);
    return readFd(fd, bytes, what);
  });
}
function writeNew(file, buf) {
  const fd = fs.openSync(file, "wx", 0o644);
  try { let off = 0; while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

// ---- trees: metadata first (bounded by the expectation), hashing only after the listing matches ----
function walkMeta(root, { maxFiles, maxDirs, maxBytes, what }) {
  const rootSt = fs.lstatSync(root, { bigint: true });
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) fail(`${what}: ${root} is not a directory`);
  const files = new Map(), dirs = []; let total = 0;
  const visit = (abs, rel, depth) => {
    if (depth > MAX_DEPTH) fail(`${what}: deeper than ${MAX_DEPTH} levels at ${rel}`);
    for (const n of fs.readdirSync(abs).sort(byBytes)) {
      if (!NAME_OK(n)) fail(`${what}: unrepresentable name in ${rel || "."}: ${JSON.stringify(n)}`);
      const a = path.join(abs, n), r = rel ? rel + "/" + n : n, st = fs.lstatSync(a, { bigint: true });
      if (st.dev !== rootSt.dev) fail(`${what}: ${r} is on another filesystem`);
      if (st.isSymbolicLink()) fail(`${what}: refusing a symlink: ${r}`);
      if (st.isDirectory()) { if (dirs.push(r) > maxDirs) fail(`${what}: more than ${maxDirs} directories`); visit(a, r, depth + 1); continue; }
      if (!st.isFile()) fail(`${what}: refusing a special file: ${r}`);
      if (st.nlink !== 1n) fail(`${what}: refusing a hard-linked file (nlink ${st.nlink}): ${r}`);
      if (files.size >= maxFiles) fail(`${what}: more than ${maxFiles} files`);
      if ((total += Number(st.size)) > maxBytes) fail(`${what}: more than ${maxBytes} bytes`);
      files.set(r, { bytes: Number(st.size), ino: st.ino });
    }
  };
  visit(root, "", 0);
  return { files, dirs };
}
function compareTree(meta, files, dirs, what) {
  for (const p of meta.files.keys()) if (!files.has(p)) fail(`${what}: unlisted file ${p}`);
  for (const p of files.keys()) if (!meta.files.has(p)) fail(`${what}: missing file ${p}`);
  const have = new Set(meta.dirs);
  for (const d of have) if (!dirs.has(d)) fail(`${what}: unlisted directory ${d}`);
  for (const d of dirs) if (!have.has(d)) fail(`${what}: missing directory ${d}`);
  for (const [p, e] of files) if (meta.files.get(p).bytes !== e.bytes) fail(`${what}: ${p} is ${meta.files.get(p).bytes} bytes, listed ${e.bytes}`);
}
function hashTree(root, meta, files, what) {
  for (const [p, e] of files)
    if (sha256(readExact(join(root, p), e.bytes, meta.files.get(p).ino, `${what} ${p}`)) !== e.sha256) fail(`${what}: ${p} does not hash to its listed sha256`);
}
/** importDirectory/walkFiles rows must be exactly the expected path/bytes/sha256 set -> Map path -> UnixFS file CID. */
function filesAgree(rows, files, what) {
  if (rows.length !== files.size) fail(`${what}: ${rows.length} files, expected ${files.size}`);
  const cids = new Map();
  for (const r of rows) {
    const e = files.get(r.path);
    if (!e || cids.has(r.path)) fail(`${what}: unexpected file ${r.path}`);
    if (r.bytes !== e.bytes || r.sha256 !== e.sha256) fail(`${what}: ${r.path} differs from its listing`);
    cids.set(r.path, r.cid);
  }
  return cids;
}

/**
 * Load unixfs.mjs and car.mjs from `dir` only if their bytes hash to SITE_RELEASE_PINS, and execute exactly those
 * bytes (data: URLs, so nothing can change between the hash and the import). car.mjs's one relative import of
 * ./unixfs.mjs is pointed at the same pinned bytes; that single exact rewrite is recorded.
 */
export async function loadSiteRelease(dir) {
  existing(dir, "site-release dir", "dir");
  const src = {};
  for (const [name, pin] of Object.entries(SITE_RELEASE_PINS)) {
    const abs = existing(path.join(dir, name), name, "file"), buf = readSmall(abs, name), h = sha256(buf);
    if (h !== pin) fail(`${abs} is ${h}, not the pinned ${pin}`);
    if (!Buffer.from(buf.toString("utf8"), "utf8").equals(buf)) fail(`${name} is not valid UTF-8`);
    src[name] = buf.toString("utf8");
  }
  const NEEDLE = 'from "./unixfs.mjs";';
  if (src["car.mjs"].split(NEEDLE).length !== 2) fail("car.mjs must import ./unixfs.mjs exactly once");
  const dataUrl = (s) => "data:text/javascript;base64," + Buffer.from(s, "utf8").toString("base64");
  const unixfsUrl = dataUrl(src["unixfs.mjs"]), carSrc = src["car.mjs"].replace(NEEDLE, () => `from ${JSON.stringify(unixfsUrl)};`);
  const unixfs = await import(unixfsUrl), car = await import(dataUrl(carSrc));
  return { importDirectory: unixfs.importDirectory, writeCar: car.writeCar, readCar: car.readCar, walkFiles: car.walkFiles,
    identity: { dir, pins: { ...SITE_RELEASE_PINS }, carImportRewrite: { from: NEEDLE, to: "data: URL of the pinned unixfs.mjs bytes", carExecutedSha256: sha256(Buffer.from(carSrc, "utf8")) } } };
}

function checkOptions(opts) {
  if (!opts || typeof opts !== "object") fail("options are required");
  const extra = Object.keys(opts).filter((k) => !OPTIONS.includes(k));
  if (extra.length) fail(`unknown option(s): ${extra.join(", ")}`);
  for (const k of OPTIONS) if (opts[k] === undefined || opts[k] === null || opts[k] === "") fail(`${k} is required (no defaults)`);
  const o = { ...opts };
  if (!CID.test(o.baseCid)) fail("baseCid must be a base32 CIDv1");
  for (const k of ["expectFiles", "expectBytes"]) if (!Number.isSafeInteger(o[k]) || o[k] < 1) fail(`${k} must be a positive integer`);
  if (o.expectBytes > MAX_TOTAL_BYTES) fail(`expectBytes exceeds the ${MAX_TOTAL_BYTES}-byte (100 MiB) limit`);
  for (const k of ["expectInventorySha256", "expectAddonManifestSha256"]) if (!HEX64.test(o[k])) fail(`${k} must be a lowercase sha256`);
  if (!COMMIT.test(o.baseSourceCommit)) fail("baseSourceCommit must be a hex commit");
  if (typeof o.baseSourceDirty !== "boolean") fail("baseSourceDirty must be a boolean");
  existing(o.baseTree, "baseTree", "dir"); existing(o.inventory, "inventory", "file");
  existing(o.addon, "addon", "dir"); existing(o.addonPins, "addonPins", "file"); existing(o.siteReleaseDir, "siteReleaseDir", "dir");
  if (inside(o.baseTree, o.addon) || inside(o.addon, o.baseTree)) fail("baseTree and addon must not contain each other");
  absPath(o.out, "out");
  const parent = existing(path.dirname(o.out), "out parent", "dir");
  if (fs.lstatSync(o.out, { throwIfNoEntry: false })) fail(`out already exists: ${o.out}`);
  for (const k of ["baseTree", "addon", "siteReleaseDir"]) if (inside(o[k], o.out)) fail(`out must not be inside ${k} (${o[k]})`);
  // the output goes on the filesystem of the reviewed working tree (the addon), not a removable/other mount
  o.outDev = fs.statSync(parent, { bigint: true }).dev;
  if (o.outDev !== fs.statSync(o.addon, { bigint: true }).dev) fail("out is on a different filesystem from the addon working tree");
  return o;
}

function validateInventory(buf, o) {
  const inv = JSON.parse(buf.toString("utf8"));
  if (!inv || !Array.isArray(inv.files) || !Array.isArray(inv.directories)) fail("inventory: files and directories arrays are required");
  if (inv.claimedReleaseCID !== o.baseCid) fail(`inventory describes ${inv.claimedReleaseCID}, not the base ${o.baseCid}`);
  const files = new Map(), dirs = new Set(); let total = 0;
  for (const f of inv.files) {
    if (!f || typeof f !== "object" || Object.keys(f).sort().join() !== "bytes,path,sha256") fail("inventory: each file is exactly {path, bytes, sha256}");
    if (!relOk(f.path) || files.has(f.path)) fail(`inventory: bad or duplicate path ${JSON.stringify(f.path)}`);
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0 || !HEX64.test(f.sha256)) fail(`inventory: bad size/sha256 for ${f.path}`);
    files.set(f.path, { bytes: f.bytes, sha256: f.sha256 }); total += f.bytes;
  }
  for (const d of inv.directories) { if (!relOk(d) || dirs.has(d) || files.has(d)) fail(`inventory: bad or duplicate directory ${JSON.stringify(d)}`); dirs.add(d); }
  for (const p of [...files.keys(), ...dirs]) for (const a of ancestors(p)) if (!dirs.has(a)) fail(`inventory: ${p} lacks listed directory ${a}`);
  if (files.size !== o.expectFiles || inv.filesCount !== o.expectFiles) fail(`inventory: ${files.size} files (filesCount ${inv.filesCount}), expected ${o.expectFiles}`);
  if (total !== o.expectBytes || inv.bytes !== o.expectBytes) fail(`inventory: ${total} bytes (bytes ${inv.bytes}), expected ${o.expectBytes}`);
  const canonical = sha256(Buffer.from(pyCanonical(inv.files, inv.directories), "utf8"));
  if (canonical !== o.expectInventorySha256 || inv.inventorySha256 !== o.expectInventorySha256) fail(`inventory: canonical sha256 ${canonical} (stated ${inv.inventorySha256}), expected ${o.expectInventorySha256}`);
  return { files, dirs, canonical, fileSha256: sha256(buf), capturedAt: inv.capturedAt ?? null, root: inv.root ?? null };
}

function validateAddon(o, base) {
  const top = fs.readdirSync(o.addon).sort();
  if (top.join("\n") !== ADDON_TOP.join("\n")) fail(`addon: must contain exactly ${ADDON_TOP.join(", ")}; has ${top.join(", ")}`);
  const read = (n) => readSmall(existing(path.join(o.addon, n), `addon ${n}`, "file"), `addon ${n}`);
  const mBuf = read("MANIFEST.json");
  if (sha256(mBuf) !== o.expectAddonManifestSha256) fail(`addon: MANIFEST.json is ${sha256(mBuf)}, expected ${o.expectAddonManifestSha256}`);
  const m = JSON.parse(mBuf.toString("utf8"));
  if (m.schema !== ADDON_SCHEMA || m.mode !== "build") fail(`addon: manifest must be ${ADDON_SCHEMA} in build mode`);
  if (!Array.isArray(m.additions) || m.additions.length !== ADDITION_COUNT) fail(`addon: exactly ${ADDITION_COUNT} additions are required`);
  const files = new Map(), lower = new Set(), dirs = new Set(); let total = 0;
  for (const a of m.additions) {
    if (!a || typeof a !== "object" || Object.keys(a).sort().join() !== "bytes,path,sha256") fail("addon: each addition is exactly {path, sha256, bytes}");
    if (typeof a.path !== "string" || !a.path.split("/").every((s) => ADDON_SEG.test(s))) fail(`addon: unsafe addition path ${JSON.stringify(a.path)}`);
    if (!Number.isSafeInteger(a.bytes) || a.bytes < 0 || !HEX64.test(a.sha256)) fail(`addon: bad size/sha256 for ${a.path}`);
    if (lower.has(a.path.toLowerCase())) fail(`addon: duplicate addition ${a.path}`);
    lower.add(a.path.toLowerCase()); files.set(a.path, { bytes: a.bytes, sha256: a.sha256 }); total += a.bytes;
    for (const d of ancestors(a.path)) dirs.add(d);
  }
  if (JSON.stringify(JSON.parse(read("ADDITIONS.json").toString("utf8"))) !== JSON.stringify(m.additions)) fail("addon: ADDITIONS.json differs from the manifest");
  const sumsBuf = read("ADDITIONS.sha256");
  if (sumsBuf.toString("utf8") !== m.additions.map((a) => `${a.sha256}  ${a.path}`).join("\n") + "\n") fail("addon: ADDITIONS.sha256 differs from the manifest");

  // the builder's reviewed pins must be exactly what the manifest says it was built from
  const pBuf = readSmall(o.addonPins, "addonPins"), p = JSON.parse(pBuf.toString("utf8"));
  if (p.schema !== PINS_SCHEMA || p.reviewed !== true) fail(`addon pins: must be ${PINS_SCHEMA} with reviewed: true`);
  if (!m.pins || Object.keys(m.pins).sort().join() !== [...PIN_KEYS].sort().join()) fail("addon: manifest pins must be exactly " + PIN_KEYS.join(", "));
  for (const k of PIN_KEYS) if (!HEX64.test(p[k]) || m.pins[k] !== p[k]) fail(`addon: manifest pin ${k} differs from the reviewed pins`);
  if (typeof p.esbuildVersion !== "string" || p.esbuildVersion !== m.esbuildVersion) fail("addon: esbuildVersion differs from the reviewed pins");
  const entries = (x) => (x && typeof x === "object" ? Object.entries(x).sort(([a], [b]) => byBytes(a, b)) : []);
  if (!entries(m.inputs).length || entries(m.inputs).some(([, v]) => !HEX64.test(v)) || JSON.stringify(entries(m.inputs)) !== JSON.stringify(entries(p.inputs)))
    fail("addon: manifest inputs differ from the reviewed pins");
  if (!Array.isArray(m.moduleClosure) || !m.moduleClosure.length || m.moduleClosure.some((k) => !Object.hasOwn(m.inputs, k))) fail("addon: module closure has an unpinned input");

  // additions are new paths only: no file/directory collision, also case-insensitively
  const lowerFiles = new Set([...base.files.keys()].map((x) => x.toLowerCase())), lowerDirs = new Set([...base.dirs].map((x) => x.toLowerCase()));
  for (const a of files.keys()) {
    const lc = a.toLowerCase();
    if (lowerFiles.has(lc) || lowerDirs.has(lc)) fail(`addon: ${a} collides with an existing base entry`);
    for (const d of ancestors(a)) {
      if (lowerFiles.has(d.toLowerCase()) || lower.has(d.toLowerCase())) fail(`addon: ${a} needs directory ${d}, which is an existing file`);
      if (lowerDirs.has(d.toLowerCase()) && !base.dirs.has(d)) fail(`addon: ${a} differs only in case from an existing directory (${d})`);
    }
  }
  const root = existing(path.join(o.addon, "site-additions"), "addon site-additions", "dir");
  const meta = walkMeta(root, { maxFiles: ADDITION_COUNT, maxDirs: dirs.size, maxBytes: total, what: "addon" });
  compareTree(meta, files, dirs, "addon");
  hashTree(root, meta, files, "addon");
  return { root, files, dirs, meta, total, manifest: m, manifestSha256: sha256(mBuf), sumsSha256: sha256(sumsBuf), pinsSha256: sha256(pBuf) };
}

/** Build the composite into a new `out`. Every option is required; see README. */
export async function buildComposite(opts) {
  const o = checkOptions(opts);
  // ---- every validation before the first write ----
  const lib = await loadSiteRelease(o.siteReleaseDir);
  const inv = validateInventory(readSmall(o.inventory, "inventory"), o);
  const baseMeta = walkMeta(o.baseTree, { maxFiles: o.expectFiles, maxDirs: inv.dirs.size, maxBytes: o.expectBytes, what: "base" });
  compareTree(baseMeta, inv.files, inv.dirs, "base");
  hashTree(o.baseTree, baseMeta, inv.files, "base");
  const baseCids = (() => {   // scoped: the base DAG (~ the tree's size) is released before the composite is imported
    const imp = lib.importDirectory(o.baseTree);
    if (imp.cid !== o.baseCid) fail(`base tree imports to ${imp.cid}, not the expected base ${o.baseCid}`);
    return filesAgree(imp.files, inv.files, "base import");
  })();
  const add = validateAddon(o, inv);
  if (o.expectBytes + add.total > MAX_TOTAL_BYTES) fail("base + additions exceed 100 MiB");
  const comp = { files: new Map([...inv.files, ...add.files]), dirs: new Set([...inv.dirs, ...add.dirs]), bytes: o.expectBytes + add.total };
  if (comp.files.size !== o.expectFiles + ADDITION_COUNT) fail("composite file count is not base + additions");

  // ---- writes: only under the new out ----
  fs.mkdirSync(o.out, { mode: 0o755 });   // EEXIST (a racing creator) throws before anything is marked
  try { return stage(o, lib, inv, baseMeta, baseCids, add, comp); }
  catch (e) {
    try { writeNew(path.join(o.out, FAILED), Buffer.from(`NOT QUALIFIED: this composite build failed and must not be staged or activated.\n${new Date().toISOString()}\n${e.stack || e}\n`)); }
    catch { /* the thrown error below is the report */ }
    throw e;
  }
}

function stage(o, lib, inv, baseMeta, baseCids, add, comp) {
  const outSt = fs.lstatSync(o.out, { bigint: true });
  if (outSt.isSymbolicLink() || !outSt.isDirectory() || outSt.dev !== o.outDev) fail("out changed after it was created");
  const site = path.join(o.out, "site");
  fs.mkdirSync(site, { mode: 0o755 });
  for (const d of [...comp.dirs].sort()) fs.mkdirSync(join(site, d), { mode: 0o755 });   // a prefix sorts before its children
  const copy = (root, meta, files, what) => { for (const [p, e] of files) {
    const buf = readExact(join(root, p), e.bytes, meta.files.get(p).ino, `${what} ${p}`);
    if (sha256(buf) !== e.sha256) fail(`${what}: ${p} changed since validation`);
    writeNew(join(site, p), buf);
  } };
  copy(o.baseTree, baseMeta, inv.files, "base");
  copy(add.root, add.meta, add.files, "addon");

  // the staged tree is exactly base + additions, and its DAG keeps every old file's UnixFS identity
  compareTree(walkMeta(site, { maxFiles: comp.files.size, maxDirs: comp.dirs.size, maxBytes: comp.bytes, what: "staged" }), comp.files, comp.dirs, "staged");
  let imp = lib.importDirectory(site);
  const newCid = imp.cid, cids = filesAgree(imp.files, comp.files, "composite import");
  if (newCid === o.baseCid) fail("the composite CID equals the base CID");
  for (const [p, c] of baseCids) if (cids.get(p) !== c) fail(`old file ${p} changed UnixFS identity`);
  const car = lib.writeCar(path.join(o.out, "site.car"), newCid, imp.blocks);
  writeNew(path.join(o.out, "site-root.block"), imp.root);
  const blockCount = imp.blocks.size, rootBlock = { file: "site-root.block", sha256: sha256(imp.root), bytes: imp.root.length }, rows = JSON.stringify(imp.files);
  imp = null;

  // independent round trip from the CAR bytes alone
  const carBytes = readExact(path.join(o.out, "site.car"), car.bytes, undefined, "site.car");
  if (sha256(carBytes) !== car.sha256) fail("site.car on disk differs from what was written");
  const rt = lib.readCar(carBytes, { expectRoot: newCid });
  if (rt.root !== newCid || rt.blocks.size !== blockCount || JSON.stringify(rt.files) !== rows) fail("the CAR's DAG/files differ from the staged tree");
  if (sha256(rt.blocks.get(newCid)) !== rootBlock.sha256) fail("the CAR's root block differs from site-root.block");
  if (JSON.stringify(lib.walkFiles(newCid, rt.blocks)) !== rows) fail("walkFiles over the CAR differs from the staged tree");
  filesAgree(rt.files, comp.files, "CAR");

  // nothing here writes to the base; this shows it also did not change underneath the build
  const after = walkMeta(o.baseTree, { maxFiles: o.expectFiles, maxDirs: inv.dirs.size, maxBytes: o.expectBytes, what: "base (after)" });
  compareTree(after, inv.files, inv.dirs, "base (after)");
  hashTree(o.baseTree, after, inv.files, "base (after)");

  const row = (p) => ({ path: p, bytes: comp.files.get(p).bytes, sha256: comp.files.get(p).sha256, cid: cids.get(p) });
  const m = add.manifest;
  const provenance = {
    schema: "enclave-composite-site-release-provenance/1",
    status: "BUILT_LOCALLY_NOT_STAGED_NOT_ACTIVATED",
    statement: "Additive composite: the exact files of the base release plus exactly the listed additions. This sidecar is outside the CID payload and nothing in the payload refers to it or to the new CID. Inherited payload metadata (e.g. .well-known/enclave-site-release.json) is BASE metadata describing the base build only; it is not this composition's provenance. This is not a clean build from source.",
    compositeBuiltAt: new Date().toISOString(),
    tool: { script: path.basename(fileURLToPath(import.meta.url)), sha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))), node: process.version, siteRelease: lib.identity },
    base: { cid: o.baseCid, tree: o.baseTree, source: { commit: o.baseSourceCommit, dirty: o.baseSourceDirty, origin: "operator-supplied (--base-source-*), not re-derived by this tool" },
      inventory: { file: o.inventory, fileSha256: inv.fileSha256, canonicalSha256: inv.canonical, capturedAt: inv.capturedAt, capturedRoot: inv.root,
        files: inv.files.size, bytes: o.expectBytes, directories: inv.dirs.size } },
    addon: { dir: o.addon, manifest: { file: "MANIFEST.json", sha256: add.manifestSha256, schema: m.schema, version: m.version ?? null, mode: m.mode,
      esbuildVersion: m.esbuildVersion, pins: m.pins, inputs: m.inputs, moduleClosure: m.moduleClosure }, additionsSha256File: add.sumsSha256,
      reviewedPins: { file: o.addonPins, sha256: add.pinsSha256 } },
    composite: { cid: newCid, files: comp.files.size, bytes: comp.bytes, directories: comp.dirs.size,
      car: { file: "site.car", sha256: car.sha256, bytes: car.bytes, blocks: blockCount }, rootBlock },
    additions: [...add.files.keys()].sort().map(row),
    preservation: {
      method: "each base file listed in the inventory was read from the base tree, sha256-checked, copied byte-for-byte, re-imported, and has the identical UnixFS file CID in the base and composite DAGs; the CAR round trip (readCar + walkFiles) reproduced every path/size/sha256",
      baseFiles: baseCids.size, allIdentical: true, files: [...baseCids.keys()].sort().map(row) },
  };
  const pBuf = Buffer.from(JSON.stringify(provenance, null, 2) + "\n");
  writeNew(path.join(o.out, PROVENANCE), pBuf);   // last write: present only when every check above passed
  return { out: o.out, baseCid: o.baseCid, newCid, files: comp.files.size, bytes: comp.bytes, car: { sha256: car.sha256, bytes: car.bytes },
    provenance: path.join(o.out, PROVENANCE), provenanceSha256: sha256(pBuf) };
}

// ---- CLI: explicit flags only ----
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = { type: "string" };
  const flags = { "base-tree": s, inventory: s, addon: s, "addon-pins": s, out: s, "site-release-dir": s, "base-cid": s, "expect-files": s,
    "expect-bytes": s, "expect-inventory-sha256": s, "expect-addon-manifest-sha256": s, "base-source-commit": s, "base-source-dirty": s };
  (async () => {
    const { values: v } = parseArgs({ options: flags, strict: true, allowPositionals: false });
    const int = (k) => (/^[1-9][0-9]*$/.test(v[k] ?? "") ? Number(v[k]) : fail(`--${k} must be a positive integer`));
    const bool = (k) => (v[k] === "true" ? true : v[k] === "false" ? false : fail(`--${k} must be true or false`));
    const r = await buildComposite({ baseTree: v["base-tree"], inventory: v.inventory, addon: v.addon, addonPins: v["addon-pins"], out: v.out,
      siteReleaseDir: v["site-release-dir"], baseCid: v["base-cid"], expectFiles: int("expect-files"), expectBytes: int("expect-bytes"),
      expectInventorySha256: v["expect-inventory-sha256"], expectAddonManifestSha256: v["expect-addon-manifest-sha256"],
      baseSourceCommit: v["base-source-commit"], baseSourceDirty: bool("base-source-dirty") });
    console.log(JSON.stringify(r, null, 2));
  })().catch((e) => { console.error(`[composite] REFUSED/FAILED: ${e.message}`); process.exitCode = 1; });
}
