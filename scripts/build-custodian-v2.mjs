#!/usr/bin/env node
// The custody v2 CUSTODIAN image (docs/security/secret-custody-v2.md §8.1): a measured SEV-SNP guest made from a
// digest-checked metal control image (its kernel, PID 1, Node, guest modules and the fleet-tunnel agent), with:
//   - /opt/metal/gsup.mjs replaced by bundled custody/v2/cvm-gsup.mjs (direct custodian by default; explicit tunnel mode available);
//   - /opt/custodian/custodian.mjs: custody/v2/daemon.mjs bundled, with the MEASURED chain config (vault, RPCs) baked in;
//   - /opt/custodian/snpkey: the derived-key helper (isolation/m2/cmd/snpkey), static.
// Every other cpio entry is copied byte for byte. The launch measurement is printed (sev-snp-measure, 2 vCPUs).
//
//   node scripts/build-custodian-v2.mjs --base <metal dist dir> --out <new dir> --vault 0x… --host-ownership 0x… [--vcpus 2] [--transport direct|tunnel]
//     [--book 0x…]  the deployed book-bound vault (0xE486…): registry/ledger follow that EnclaveAddressBook at each agreed block
//     [--host-policy FILE]  {book, hostOwnership, mirrors[]}: enforce the admin's anchored platform host policy (network/platform-host-policy.mjs)
//        [--independent-owners owners.json | --independent-admission owner-permits]   (independent committees; see
//        docs/security/independent-custody-activation.md; either one bundles the static DKG helper)
//        [--shield-recipients shield.json]   (OPTIONAL Enclave Shield release recipients: this operator's TPM EK roots, their
//        pins and limits, measured into the bundle; docs/security/custodian-shield-recipients.md. Absent: SNP only)
//        [--trusted-proxy 10.0.2.2[,ip...]]   (the host forwarder(s) whose X-Forwarded-For keys per-client rate limits: up to
//        4 loopback/private literals. Absent: every client shares the TCP peer's bucket; custody/v2/http.mjs clientKeyFor)
//
// The image's sources are every input the two bundles actually read (esbuild's metafile) plus STATIC_IMAGE_SOURCES: each
// must be tracked and clean (or --allow-dirty), checked before any Go, cargo or cpio work; node_modules inputs are
// recorded by package@version in the manifest, pinned by the clean package-lock.json.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { build, stop as stopEsbuild, version as ESBUILD_VERSION } from "esbuild";
import zlib from "node:zlib";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { custodianMeasured, measuredModule, bundleOptions as bundleOptionsFor, bundleSources, sourceCheck } from "../custody/v2/build-config.mjs";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const BASE = path.resolve(arg("base", "")), OUT = path.resolve(arg("out", ""));
const VCPUS = String(arg("vcpus", "2"));
const ownerFile=arg("independent-owners",null);
const shieldFile = arg("shield-recipients", null);
// Every measured pin is validated (and interpreted by the daemon's own policy code) before any build work.
const { measured: MEASURED, policy: POLICY, needsDkg: NEEDS_DKG } = custodianMeasured({ vault: arg("vault", ""), hostOwnership: arg("host-ownership", ""),
  transport: arg('transport','direct'), ownerList: ownerFile ? JSON.parse(fs.readFileSync(ownerFile,'utf8')) : null, admission: arg("independent-admission", null),
  shieldRecipients: shieldFile ? JSON.parse(fs.readFileSync(shieldFile, "utf8")) : null,
  trustedProxies: arg("trusted-proxy", null) === null ? null : String(arg("trusted-proxy", "")).split(",").map((x) => x.trim()).filter(Boolean),
  book: arg("book", null),
  hostPolicy: arg("host-policy", null) === null ? null : JSON.parse(fs.readFileSync(arg("host-policy", ""), "utf8")) });
const { vault: VAULT, hostOwnership: HOST_OWNERSHIP, transport: TRANSPORT, independentOwners: INDEPENDENT_OWNERS } = MEASURED;
const INDEPENDENT_ADMISSION = MEASURED.independentAdmission || null;
const sha = (b) => createHash("sha256").update(b).digest("hex");
if (!fs.existsSync(path.join(BASE, "manifest.json"))) throw new Error("--base must be a metal dist dir");
if (fs.existsSync(OUT)) throw new Error(`${OUT} exists: an image is built once`);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();

// the two bundles first (in memory): their metafiles name every source the image's JavaScript is made of
const measured = measuredModule(MEASURED);
const bundleOptions = bundleOptionsFor(measured, { root: ROOT });
const bundled = await build({...bundleOptions,entryPoints:[path.join(ROOT,'custody/v2/daemon.mjs')]});
const gsupBundle = await build({...bundleOptions,entryPoints:[path.join(ROOT,'custody/v2/cvm-gsup.mjs')]});
const SOURCES = bundleSources([bundled.metafile, gsupBundle.metafile], { root: ROOT });
stopEsbuild();   // the bundles are in memory: release esbuild's resident service before the cpio and measurement steps
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 16 << 20 });
const { untracked, dirty } = sourceCheck(SOURCES, { git });
if ((untracked.length || dirty) && !process.argv.includes("--allow-dirty"))
  throw new Error(`the image's sources are not all committed:${untracked.length ? `\nuntracked: ${untracked.join(" ")}` : ""}${dirty ? `\n${dirty}` : ""}`);

// 1. base, checked against its manifest
const m = JSON.parse(fs.readFileSync(path.join(BASE, "manifest.json"), "utf8"));
if (sha(fs.readFileSync(path.join(BASE, "vmlinuz"))) !== m.kernel.sha256) throw new Error("base kernel hash mismatch");

// 2. the custodian bundle with the measured config (built above), and the helpers
const custodianJs = Buffer.from(bundled.outputFiles[0].contents);
const tmpKey = path.join(OUT + ".snpkey");
execFileSync("go", ["build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w -buildid=", "-o", tmpKey, "./cmd/snpkey"],
  { cwd: path.join(ROOT, "isolation/m2"), env: { ...process.env, GOFLAGS: "", CGO_ENABLED: "0", GOEXPERIMENT: "nodwarf5", GOTOOLCHAIN: "go1.27.0" }, stdio: "inherit" });
const snpkey = fs.readFileSync(tmpKey); fs.unlinkSync(tmpKey);
let dkg=null,dkgBuild=null;
if(NEEDS_DKG){
  execFileSync('cargo',['build','--locked','--release','--target','x86_64-unknown-linux-musl','--manifest-path',path.join(ROOT,'custody/dkg/Cargo.toml')],{cwd:ROOT,stdio:'inherit'});
  const binary=path.join(ROOT,'custody/dkg/target/x86_64-unknown-linux-musl/release/enclave-custody-dkg');
  if(/INTERP/.test(execFileSync('readelf',['-lW',binary],{encoding:'utf8'}))||/\(NEEDED\)/.test(execFileSync('readelf',['-dW',binary],{encoding:'utf8'})))throw Error('DKG helper must be static');
  dkg=fs.readFileSync(binary);
  dkgBuild={rustc:execFileSync('rustc',['--version'],{encoding:'utf8'}).trim(),cargo:execFileSync('cargo',['--version'],{encoding:'utf8'}).trim(),target:'x86_64-unknown-linux-musl',lockSha256:sha(fs.readFileSync(path.join(ROOT,'custody/dkg/Cargo.lock')))};
}
const gsup=Buffer.from(gsupBundle.outputFiles[0].contents);

// 3. rewrite the newc cpio as a STREAM (the inflated metal base is ~780 MiB; at most one entry is held): replace gsup,
//    append the custodian dir + files before the trailer, copy every other entry byte for byte. The output bytes are those
//    of the former whole-buffer rewrite (same entries, same order, same gzip level); the base's hash is checked as it is
//    read, and a mismatch deletes the output.
const entry = (fields, name, data) => {
  const nm = Buffer.from(name + "\0");
  const h = Buffer.from("070701" + fields.map((n) => n.toString(16).padStart(8, "0")).join(""));
  const head = Buffer.concat([h, nm]); const pad1 = Buffer.alloc((4 - (head.length % 4)) % 4);
  return Buffer.concat([head, pad1, data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
};
const inHash = createHash("sha256");
const it = fs.createReadStream(path.join(BASE, "initramfs.cpio.gz")).pipe(new Transform({ transform(c, _, cb) { inHash.update(c); cb(null, c); } })).pipe(zlib.createGunzip())[Symbol.asyncIterator]();
let buf = Buffer.alloc(0);
const fill = async (n) => { while (buf.length < n) { const { value, done } = await it.next(); if (done) throw new Error("truncated cpio"); buf = buf.length ? Buffer.concat([buf, value]) : value; } };
const take = async (n) => { await fill(n); const o = buf.subarray(0, n); buf = buf.subarray(n); return o; };
async function* pass(n) { while (n > 0) { if (!buf.length) { const { value, done } = await it.next(); if (done) throw new Error("truncated cpio"); buf = value; } const k = Math.min(n, buf.length); yield Buffer.from(buf.subarray(0, k)); buf = buf.subarray(k); n -= k; } }
let maxino = 0, prefix = null, replaced = false, trailer = false;
async function* rewritten() {
  for (;;) {
    const h = await take(110);
    if (h.subarray(0, 6).toString() !== "070701") throw new Error("only newc cpio is supported");
    const f = Array.from({ length: 13 }, (_, i) => parseInt(h.subarray(6 + i * 8, 14 + i * 8).toString(), 16));
    const size = f[6], ns = f[11];
    const nameRaw = await take(ns + ((4 - ((110 + ns) % 4)) % 4));
    const name = nameRaw.subarray(0, ns - 1).toString(), key = name.replace(/^\.\//, ""), dpad = (4 - (size % 4)) % 4;
    maxino = Math.max(maxino, f[0]);
    if (key === "opt/metal/gsup.mjs") prefix = name.slice(0, name.length - key.length);
    if (name === "TRAILER!!!") {
      if (prefix === null) throw new Error("the base image has no /opt/metal/gsup.mjs");
      const add = (mode, k, d) => { maxino++; return entry([maxino, mode, 0, 0, mode >> 12 === 4 ? 2 : 1, 0, d.length, 0, 0, 0, 0, (prefix + k).length + 1, 0], prefix + k, d); };
      yield add(0o040755, "opt/custodian", Buffer.alloc(0));
      yield add(0o100644, "opt/custodian/custodian.mjs", custodianJs);
      yield add(0o100755, "opt/custodian/snpkey", snpkey);
      if (dkg) yield add(0o100755, "opt/custodian/dkg", dkg);
      yield Buffer.concat([h, nameRaw, await take(size + dpad)]);
      trailer = true;
      for (;;) { const { done } = await it.next(); if (done) break; }       // nothing after the trailer, as before
      return;
    }
    if (key === "opt/metal/gsup.mjs") {
      if (f[4] !== 1) throw new Error("gsup.mjs is hardlinked");
      await take(size + dpad); f[6] = gsup.length; yield entry(f, name, gsup); replaced = true;
    } else { yield Buffer.concat([h, nameRaw]); yield* pass(size + dpad); }
  }
}
fs.mkdirSync(OUT);
const outHash = createHash("sha256"); let outBytes = 0;
await pipeline(Readable.from(rewritten()), zlib.createGzip({ level: 9 }), new Transform({ transform(c, _, cb) { outHash.update(c); outBytes += c.length; cb(null, c); } }),
  fs.createWriteStream(path.join(OUT, "initramfs.cpio.gz"), { flags: "wx", mode: 0o644 }));
const baseInitramfsSha256 = inHash.digest("hex");
if (m.initramfs && baseInitramfsSha256 !== m.initramfs.sha256) { fs.rmSync(OUT, { recursive: true }); throw new Error("base initramfs hash mismatch"); }
if (!replaced || !trailer) { fs.rmSync(OUT, { recursive: true }); throw new Error("the base image has no /opt/metal/gsup.mjs or no trailer"); }
const out = { sha256: outHash.digest("hex"), bytes: outBytes };
fs.copyFileSync(path.join(BASE, "vmlinuz"), path.join(OUT, "vmlinuz"));
const cmdline = fs.readFileSync(path.join(BASE, "cmdline"), "utf8").trim().replace("${MODE}", "snp");
fs.writeFileSync(path.join(OUT, "cmdline"), cmdline + "\n");
const manifest = { role: "enclave-custodian-v2", commit, vault: VAULT, hostOwnership: HOST_OWNERSHIP, base: { dir: path.basename(BASE), initramfsSha256: baseInitramfsSha256, kernelSha256: m.kernel.sha256 },
  independentOwners: INDEPENDENT_OWNERS,
  ...(INDEPENDENT_ADMISSION ? { independentAdmission: INDEPENDENT_ADMISSION } : {}),
  independentPolicy: POLICY,
  transport:TRANSPORT,
  // the operator's measured Shield opt-in (its full roots are in the bundle; the pins say which), or null: SNP only
  shieldRecipients: MEASURED.shieldRecipients ? { format: MEASURED.shieldRecipients.format, acceptTier: MEASURED.shieldRecipients.acceptTier,
                                                  ekRootPins: MEASURED.shieldRecipients.ekRootPins, limits: MEASURED.shieldRecipients.limits } : null,
  trustedProxies: MEASURED.trustedProxies || null,
  bundleInputs: SOURCES, bundler: `esbuild@${ESBUILD_VERSION}`,
  dkgBuild,
  files: { "/opt/metal/gsup.mjs": sha(gsup), "/opt/custodian/custodian.mjs": sha(custodianJs), "/opt/custodian/snpkey": sha(snpkey), ...(dkg?{'/opt/custodian/dkg':sha(dkg)}:{}) },
  kernel: { sha256: m.kernel.sha256 }, initramfs: { sha256: out.sha256, bytes: out.bytes }, cmdline, vcpus: Number(VCPUS) };
// 4. the launch measurement this image produces on this host's firmware (the verifying OVMF), Turin
const OVMF = process.env.OVMF || path.join(process.env.HOME, ".cache/enclave-isolation/fwbuild/OVMF.amdsev.fd");
try {
  const meas = execFileSync(process.env.SEV_SNP_MEASURE || "sev-snp-measure", ["--mode", "snp", "--vcpus", VCPUS, "--vcpu-family", "26", "--vcpu-model", "2", "--vcpu-stepping", "1",
    "--ovmf", OVMF, "--kernel", path.join(OUT, "vmlinuz"), "--initrd", path.join(OUT, "initramfs.cpio.gz"), "--append", cmdline], { encoding: "utf8" }).trim().split("\n").pop();
  manifest.measurement = meas; manifest.measurementSha256 = "0x" + sha(Buffer.from(meas, "hex")); manifest.ovmfSha256 = sha(fs.readFileSync(OVMF));
} catch (e) { manifest.measurementError = e.message; }
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ out: OUT, initramfs: manifest.initramfs, measurement: manifest.measurement, measurementSha256: manifest.measurementSha256 }, null, 1));
