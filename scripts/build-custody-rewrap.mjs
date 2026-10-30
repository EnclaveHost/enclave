#!/usr/bin/env node
// The measured CUSTODY REWRAP image (custody/v2/rewrap.mjs, docs/security/custody-owner-rewrap.md): the same digest-checked
// metal control image the custodian image is made from (its kernel, PID 1, Node and guest modules), with
//   - /opt/metal/gsup.mjs replaced by bundled custody/v2/rewrap-gsup.mjs (runs the rewrap guest once);
//   - /opt/rewrap/rewrap.mjs: custody/v2/rewrap-guest.mjs bundled, with the MEASURED chain configuration baked in
//     (role "enclave-custody-rewrap": chain, the original vault, its book, the RPC quorum).
// Every other cpio entry is copied byte for byte; the two new entries have mtime 0 and fixed modes, and gzip is level 9,
// so the same sources and base give the same bytes. The launch measurement is computed with sev-snp-measure exactly as
// scripts/build-custodian-v2.mjs does (2 vCPUs, the verifying OVMF), so it is comparable with the custodian's.
//
//   node scripts/build-custody-rewrap.mjs --base <metal dist dir> --out <new dir> --vault 0x… --book 0x… [--chain-id 8453]
//        [--rpcs url,url,...] [--min-agree <strict majority; default>] [--vcpus 2] [--host-policy FILE] [--allow-dirty]
// The image's sources (every input of the two bundles, esbuild's metafile, plus this script and the lockfile) must be
// tracked and clean in git unless --allow-dirty; a dirty build is recorded as such in the manifest and is not a release.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import zlib from "node:zlib";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { build, stop as stopEsbuild, version as ESBUILD_VERSION } from "esbuild";
import { measuredModule, bundleOptions as bundleOptionsFor, bundleSources, sourceCheck, MEASURED_RPCS } from "../custody/v2/build-config.mjs";
import { REWRAP_RUNTIME, REWRAP_RUNTIME_ID } from "../custody/v2/rewrap.mjs";
import { validateMirrors } from "../network/host-policy-mirrors.mjs";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const BASE = path.resolve(arg("base", "")), OUT = path.resolve(arg("out", ""));
const VCPUS = String(arg("vcpus", "2"));
const addr = (x, what) => { const a = String(x || "").toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a) || /^0x0{40}$/.test(a)) throw new Error(`--${what} must be a non-zero address`); return a; };
const rpcs = String(arg("rpcs", MEASURED_RPCS.join(","))).split(",").map((s) => s.trim()).filter(Boolean);
for (const u of rpcs) { const x = new URL(u); if (x.protocol !== "https:" || x.username || x.password || x.search || x.hash) throw new Error(`--rpcs: ${u} must be a plain https URL`); }
const MEASURED = { role: "enclave-custody-rewrap", chainId: Number(arg("chain-id", "8453")), vault: addr(arg("vault"), "vault"), book: addr(arg("book"), "book"),
  rpcs, minAgree: Number(arg("min-agree", String(Math.floor(rpcs.length / 2) + 1))), confirmations: 2, maxAgeSec: 120 };
// --host-policy FILE: { book, hostOwnership, mirrors[] } - the guest enforces the admin's platform host policy for its own
// lease host (the original custodian image cannot). Measured, like the custodian's: a changed mirror list is a new image.
if (arg("host-policy", null) !== null) {
  const hp = JSON.parse(fs.readFileSync(arg("host-policy", ""), "utf8"));
  const mirrors = validateMirrors(hp.mirrors);      // 1-8 distinct HTTPS origins, exactly as the guest's httpPolicyMirrors requires
  MEASURED.hostPolicy = { book: addr(hp.book, "host-policy book"), hostOwnership: addr(hp.hostOwnership, "host-policy hostOwnership"), mirrors };
  if (MEASURED.hostPolicy.book !== MEASURED.book) throw new Error("--host-policy book must be the vault's book");
}
if (!Number.isSafeInteger(MEASURED.chainId) || MEASURED.chainId <= 0) throw new Error("--chain-id");
if (!Number.isInteger(MEASURED.minAgree) || MEASURED.minAgree * 2 <= rpcs.length || MEASURED.minAgree > rpcs.length) throw new Error("--min-agree must be a strict majority of the RPCs (custody/v2/quorum.mjs)");
const sha = (b) => createHash("sha256").update(b).digest("hex");
if (!fs.existsSync(path.join(BASE, "manifest.json"))) throw new Error("--base must be a metal dist dir");
if (fs.existsSync(OUT)) throw new Error(`${OUT} exists: an image is built once`);
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 16 << 20 });
let commit = null; try { commit = git(["rev-parse", "HEAD"]).trim(); } catch {}

// the two bundles (in memory); their metafiles name every source the image's JavaScript is made of
const options = bundleOptionsFor(measuredModule(MEASURED), { root: ROOT });
const guest = await build({ ...options, entryPoints: [path.join(ROOT, "custody/v2/rewrap-guest.mjs")] });
const gsupB = await build({ ...options, entryPoints: [path.join(ROOT, "custody/v2/rewrap-gsup.mjs")] });
const SOURCES = bundleSources([guest.metafile, gsupB.metafile], { root: ROOT });
stopEsbuild();   // the bundles are in memory: release esbuild's resident service before the cpio and measurement steps
const STATIC = ["scripts/build-custody-rewrap.mjs", "package.json", "package-lock.json"];
let check = { untracked: [], dirty: "" }, gitOk = true;
try { check = sourceCheck({ repo: [...SOURCES.repo, ...STATIC] }, { git }); } catch (e) { gitOk = false; check = { untracked: [], dirty: `no git repository: ${e.message.split("\n")[0]}` }; }
const dirty = !gitOk || check.untracked.length || check.dirty;
if (dirty && !process.argv.includes("--allow-dirty"))
  throw new Error(`the image's sources are not all committed:${check.untracked.length ? `\nuntracked: ${check.untracked.join(" ")}` : ""}${check.dirty ? `\n${check.dirty}` : ""}`);

// 1+2. base, checked against its manifest, rewritten as a STREAM (the inflated base is ~780 MiB; at most one entry is held):
// gsup replaced, /opt/rewrap and its bundle appended before the trailer, every other entry copied byte for byte.
const m = JSON.parse(fs.readFileSync(path.join(BASE, "manifest.json"), "utf8"));
if (sha(fs.readFileSync(path.join(BASE, "vmlinuz"))) !== m.kernel.sha256) throw new Error("base kernel hash mismatch");
const guestJs = Buffer.from(guest.outputFiles[0].contents), gsup = Buffer.from(gsupB.outputFiles[0].contents);
const entry = (fields, name, data) => {
  const nm = Buffer.from(name + "\0");
  const head = Buffer.concat([Buffer.from("070701" + fields.map((n) => n.toString(16).padStart(8, "0")).join("")), nm]);
  return Buffer.concat([head, Buffer.alloc((4 - (head.length % 4)) % 4), data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
};
const inHash = createHash("sha256");
const gunzipped = fs.createReadStream(path.join(BASE, "initramfs.cpio.gz")).pipe(new Transform({ transform(c, _, cb) { inHash.update(c); cb(null, c); } })).pipe(zlib.createGunzip());
const it = gunzipped[Symbol.asyncIterator]();
let buf = Buffer.alloc(0);
const fill = async (n) => { while (buf.length < n) { const { value, done } = await it.next(); if (done) throw new Error("truncated cpio"); buf = buf.length ? Buffer.concat([buf, value]) : value; } };
const take = async (n) => { await fill(n); const o = buf.subarray(0, n); buf = buf.subarray(n); return o; };
async function* pass(n) { while (n > 0) { if (!buf.length) { const { value, done } = await it.next(); if (done) throw new Error("truncated cpio"); buf = value; } const k = Math.min(n, buf.length); yield Buffer.from(buf.subarray(0, k)); buf = buf.subarray(k); n -= k; } }
const state = { maxino: 0, prefix: null, replaced: false, trailer: false };
async function* rewritten() {
  for (;;) {
    const h = await take(110);
    if (h.subarray(0, 6).toString() !== "070701") throw new Error("only newc cpio is supported");
    const f = Array.from({ length: 13 }, (_, i) => parseInt(h.subarray(6 + i * 8, 14 + i * 8).toString(), 16));
    const size = f[6], ns = f[11];
    const nameRaw = await take(ns + ((4 - ((110 + ns) % 4)) % 4));
    const name = nameRaw.subarray(0, ns - 1).toString(), key = name.replace(/^\.\//, "");
    const dpad = (4 - (size % 4)) % 4;
    state.maxino = Math.max(state.maxino, f[0]);
    if (key === "opt/metal/gsup.mjs") state.prefix = name.slice(0, name.length - key.length);
    if (key === "opt/rewrap" || key.startsWith("opt/rewrap/")) throw new Error("the base already has /opt/rewrap");
    if (name === "TRAILER!!!") {
      if (state.prefix === null) throw new Error("the base image has no /opt/metal/gsup.mjs");
      const add = (mode, k, d) => { state.maxino++; return entry([state.maxino, mode, 0, 0, mode >> 12 === 4 ? 2 : 1, 0, d.length, 0, 0, 0, 0, (state.prefix + k).length + 1, 0], state.prefix + k, d); };
      yield add(0o040755, "opt/rewrap", Buffer.alloc(0));
      yield add(0o100644, "opt/rewrap/rewrap.mjs", guestJs);
      yield Buffer.concat([h, nameRaw, await take(size + dpad)]);
      state.trailer = true;
      for (;;) { const { done } = await it.next(); if (done) break; }      // as the custodian builder: nothing after the trailer
      return;
    }
    if (key === "opt/metal/gsup.mjs") {
      if (f[4] !== 1) throw new Error("gsup.mjs is hardlinked");
      await take(size + dpad); f[6] = gsup.length; yield entry(f, name, gsup); state.replaced = true;
    } else { yield Buffer.concat([h, nameRaw]); yield* pass(size + dpad); }
  }
}
fs.mkdirSync(OUT);
const outHash = createHash("sha256"); let outBytes = 0;
await pipeline(Readable.from(rewritten()), zlib.createGzip({ level: 9 }), new Transform({ transform(c, _, cb) { outHash.update(c); outBytes += c.length; cb(null, c); } }),
  fs.createWriteStream(path.join(OUT, "initramfs.cpio.gz"), { flags: "wx", mode: 0o644 }));
const baseInitramfsSha256 = inHash.digest("hex");
if (m.initramfs && baseInitramfsSha256 !== m.initramfs.sha256) { fs.rmSync(OUT, { recursive: true }); throw new Error("base initramfs hash mismatch"); }
if (!state.replaced || !state.trailer) { fs.rmSync(OUT, { recursive: true }); throw new Error("the base image has no /opt/metal/gsup.mjs or no trailer"); }
const out = { sha256: outHash.digest("hex"), bytes: outBytes };
fs.copyFileSync(path.join(BASE, "vmlinuz"), path.join(OUT, "vmlinuz"));
const cmdline = fs.readFileSync(path.join(BASE, "cmdline"), "utf8").trim().replace("${MODE}", "snp");
fs.writeFileSync(path.join(OUT, "cmdline"), cmdline + "\n");
const manifest = { role: "enclave-custody-rewrap", commit, sourcesCommitted: !dirty, ...(dirty ? { sourceCheck: check } : {}),
  measured: MEASURED, runtime: REWRAP_RUNTIME, runtimeId: REWRAP_RUNTIME_ID,
  base: { dir: path.basename(BASE), initramfsSha256: baseInitramfsSha256, kernelSha256: m.kernel.sha256 },
  bundleInputs: SOURCES, bundler: `esbuild@${ESBUILD_VERSION}`,
  files: { "/opt/metal/gsup.mjs": sha(gsup), "/opt/rewrap/rewrap.mjs": sha(guestJs) },
  kernel: { sha256: m.kernel.sha256 }, initramfs: { sha256: out.sha256, bytes: out.bytes }, cmdline, vcpus: Number(VCPUS) };
// 3. the launch measurement on the verifying OVMF, Turin (as the custodian image)
const OVMF = process.env.OVMF || path.join(process.env.HOME, ".cache/enclave-isolation/fwbuild/OVMF.amdsev.fd");
try {
  const meas = execFileSync(process.env.SEV_SNP_MEASURE || "sev-snp-measure", ["--mode", "snp", "--vcpus", VCPUS, "--vcpu-family", "26", "--vcpu-model", "2", "--vcpu-stepping", "1",
    "--ovmf", OVMF, "--kernel", path.join(OUT, "vmlinuz"), "--initrd", path.join(OUT, "initramfs.cpio.gz"), "--append", cmdline], { encoding: "utf8" }).trim().split("\n").pop();
  manifest.measurement = meas; manifest.measurementSha256 = "0x" + sha(Buffer.from(meas, "hex")); manifest.ovmfSha256 = sha(fs.readFileSync(OVMF));
  manifest.rulesImage = { platform: "sev-snp", measurement: meas, runtimeId: REWRAP_RUNTIME_ID };
} catch (e) { manifest.measurementError = e.message; }
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ out: OUT, initramfs: manifest.initramfs, files: manifest.files, measurement: manifest.measurement, measurementSha256: manifest.measurementSha256,
  sourcesCommitted: manifest.sourcesCommitted }, null, 1));
