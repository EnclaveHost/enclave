#!/usr/bin/env node
// pkg.mjs -- the NucBox own-guest package (README.md): every byte the box needs to boot our guest and serve one small
// app, pinned by sha256 in ONE manifest, with where each byte comes from and how to make it again.
//
//   node windows/vbslike/pkg/pkg.mjs verify <manifest> [--out DIR] [--rebuild] [--fetch GATEWAY] [--serve] [--tests]
//   node windows/vbslike/pkg/pkg.mjs pack   <manifest> <outRoot>          writes <outRoot>/<id16>/, prints the id
//   node windows/vbslike/pkg/pkg.mjs pins   <manifest>                    prints what each source hashes to NOW
//
// The package id is the sha256 of the manifest file's bytes; the box stages into pkg\<first 16 hex>\ and every
// Windows script is handed the FULL id by the operator, taken from the commit, never from the box.
//
// verify is fail-closed and names each check. It proves, from the sources and not from the manifest's say-so:
//   - every pinned file and build input hashes to its pin (git objects at their commits, files on this host,
//     canonical JSON written from the manifest itself, bundles DERIVED from their record and component);
//   - each component is the content its CID names; each record hashes to its recordSha256 and names that CID and the
//     guest's runtime; each bundle is derived by TWO implementations (the Python reference and the manager module
//     that will run on the box) and hashes to the AppID; the runtime identity recomputes to the runtimeId;
//   - the tier says what this box is (T0-hv, host NOT excluded, no SNP, no VMPL), and an app is called servable
//     only on the derivation the pinned manager serves;
//   - with --out, the packed directory holds EXACTLY the shippable files, each with its hash;
//   - with --rebuild, the VTL0 vmlinux and the IGVM are made again here and equal their pins (seconds, no compiler);
//   - with --fetch, each component is fetched by CID from that gateway and equals its pin;
//   - with --serve, each servable wasi:http app is served HERE by the pinned runtime (wasmtime serve, the version the
//     runtime identity names) and its answer must be the manifest's expected bytes. A pinned answer that was never
//     observed is how package v1 came to expect "Hello World!" from an app that says "Hello World!\n";
//   - with --tests, each functional test the manifest pins (another lane's, by commit) runs INSIDE the package's own
//     control/ tree, as shipped, and must give exactly the result the manifest states -- which cases fail included.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const { canonical, runtimeId, validateRuntimeIdentity } = await import(path.join(REPO, "isolation/contract/runtime.mjs"));
const DERIVE_REF = path.join(REPO, "isolation/contract/catalog/derive_reference.py");

export const TYPE = "enclave-vbslike-package/1";
const HEX64 = /^[0-9a-f]{64}$/, HEX40 = /^[0-9a-f]{40}$/;
const ROLES = new Set(["guest.igvm", "guest.igvm-map", "guest.kernel", "guest.initrd", "guest.runtime",
  "app.component", "app.record", "app.bundle", "app.spawn", "control.manager", "control.fetcher", "control.launcher",
  "control.datapath", "control.judge", "control.node-client", "tool.windows",
  "input.vtl0-kernel-bzimage", "input.vtl0-vmlinux", "input.vtl2", "input.igvmfilegen", "input.igvm-manifest",
  "input.recipe", "input.tree", "input.test", "input.test-support", "guest.uefi-firmware", "guest.uefi-medium", "guest.uefi-fallback",
  "input.efi-stub", "input.tool-source", "input.initrd", "control.node", "control.relay", "control.npm", "control.acceptance",
  "probe.uefi-medium", "probe.module", "probe.firmware", "input.firmware-config", "candidate.igvm"]);
const FROM = ["git", "repo", "file", "dir", "canonical", "derive", "box"];
const SERVED_BY_PINNED_MANAGER = ["enclave-catalog-bundle/1"];   // windows/vbslike/manager/server.mjs SERVES
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const home = (p) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
const kindOf = (from) => { const k = Object.keys(from || {}); return k.length === 1 && FROM.includes(k[0]) ? k[0] : null; };

// ---- results -------------------------------------------------------------------------------------------------------
function reporter() {
  const rows = [];
  const add = (ok, name, detail = "") => { rows.push({ ok, name, detail }); return ok; };
  return { rows, add, ok: () => rows.every((r) => r.ok),
           print: (out = process.stdout) => { for (const r of rows) out.write(r.ok ? `ok   ${r.name}${r.detail ? ` (${r.detail})` : ""}\n` : `FAIL ${r.name}: ${r.detail}\n`); } };
}

// ---- CID: CIDv1, raw codec, sha2-256, base32 -- the only shape the catalog's components use -------------------------
export function cidDigest(cid) {
  if (!/^b[a-z2-7]+$/.test(cid)) return null;
  const A = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, val = 0; const out = [];
  for (const ch of cid.slice(1)) { val = (val << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; } }
  const b = Buffer.from(out);
  if (b.length !== 36 || b[0] !== 0x01 || b[1] !== 0x55 || b[2] !== 0x12 || b[3] !== 0x20) return null;   // v1, raw, sha2-256, 32
  return b.subarray(4).toString("hex");
}

// ---- sources -------------------------------------------------------------------------------------------------------
function gitBytes(commit, p) {
  const r = spawnSync("git", ["-C", REPO, "show", `${commit}:${p}`], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git has no ${commit.slice(0, 12)}:${p} (${String(r.stderr).trim().split("\n")[0]})`);
  return r.stdout;
}
function deriveRef(recordBytes, componentBytes) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vbspkg-"));
  try {
    fs.writeFileSync(path.join(d, "r.json"), recordBytes); fs.writeFileSync(path.join(d, "c.wasm"), componentBytes);
    const r = spawnSync("python3", [DERIVE_REF, "bundle", path.join(d, "r.json"), path.join(d, "c.wasm"), path.join(d, "b")], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`derive_reference.py refused: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`);
    return fs.readFileSync(path.join(d, "b"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
// A `repo` source is a path IN THE SAME COMMIT AS THE MANIFEST: a manifest is committed together with its scripts, so
// that commit holds exactly the bytes it pins, and a committed manifest keeps verifying after the scripts move on. A
// manifest being authored (not committed, or modified since) reads the working tree.
export function manifestCommit(manifestPath) {
  const abs = path.resolve(manifestPath), rel = path.relative(REPO, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const c = spawnSync("git", ["-C", REPO, "log", "-1", "--format=%H", "--", rel], { encoding: "utf8" }).stdout.trim();
  if (!c) return null;
  return spawnSync("git", ["-C", REPO, "diff", "--quiet", c, "--", rel]).status === 0 ? c : null;
}
// resolve every entry's bytes; derive entries after the entries they name. Box-only entries have no bytes here.
function resolveAll(m, atCommit = null) {
  const all = [...m.files, ...m.inputs], byPath = new Map(m.files.map((f) => [f.path, f]));
  const bytes = new Map(), errors = new Map();
  const one = (e) => {
    if (bytes.has(e) || errors.has(e)) return bytes.get(e);
    const k = kindOf(e.from), v = e.from?.[k];
    try {
      let b = null;
      if (k === "git") b = gitBytes(v.commit, v.path);
      else if (k === "repo") b = atCommit ? gitBytes(atCommit, v) : fs.readFileSync(path.join(REPO, v));
      else if (k === "file") b = fs.readFileSync(home(v));
      else if (k === "canonical") b = canonical(v);
      else if (k === "derive") {
        const rec = byPath.get(v.record), comp = byPath.get(v.component);
        if (!rec || !comp) throw new Error(`derive names ${v.record} / ${v.component}, which are not files of this package`);
        const rb = one(rec), cb = one(comp);
        if (!rb || !cb) throw new Error("a derive input has no bytes");
        b = deriveRef(rb, cb);
      }
      if (b) bytes.set(e, b);
      return b;
    } catch (err) { errors.set(e, err.message); return null; }
  };
  for (const e of all) one(e);
  return { bytes, errors };
}

// ---- the manifest's own shape --------------------------------------------------------------------------------------
function checkShape(m, R) {
  if (m.type !== TYPE) return R.add(false, "manifest type", `is ${JSON.stringify(m.type)}, not ${TYPE}`);
  const t = m.tier || {};
  R.add(t.name === "T0-hv" && t.hostExcluded === false && t.snp === false && t.vmpl === "n/a" && t.attested === false,
        "tier states what this box is", t.name === "T0-hv" && t.hostExcluded === false && t.snp === false && t.vmpl === "n/a" && t.attested === false
          ? "T0-hv, host NOT excluded, no SNP, no VMPL, not attested" : `tier is ${JSON.stringify(t)}: this box has no SNP and does not exclude its host`);
  const seen = new Set(); let bad = [];
  for (const [list, needPath] of [[m.files, true], [m.inputs, false]]) {
    if (!Array.isArray(list)) { bad.push(`${needPath ? "files" : "inputs"} is not a list`); continue; }
    for (const e of list) {
      const id = needPath ? e.path : e.name;
      if (needPath && (typeof e.path !== "string" || !/^[a-z0-9][a-z0-9._/-]*$/i.test(e.path) || e.path.split("/").some((s) => s === ".." || s === "." || s === "") || e.path === "MANIFEST.json"))
        bad.push(`path ${JSON.stringify(e.path)} is not a plain relative path`);
      if (!needPath && typeof e.name !== "string") bad.push("an input has no name");
      if (seen.has(id)) bad.push(`${id} appears twice`); seen.add(id);
      if (!ROLES.has(e.role)) bad.push(`${id}: role ${JSON.stringify(e.role)} is not one of the package's roles`);
      const k = kindOf(e.from);
      if (!k) bad.push(`${id}: from must name exactly one of ${FROM.join("|")}`);
      if (k === "git" && (!HEX40.test(e.from.git.commit || "") || typeof e.from.git.path !== "string")) bad.push(`${id}: a git source needs a full commit and a path`);
      if (k !== "dir" && (!HEX64.test(e.sha256 || "") || !Number.isInteger(e.bytes))) bad.push(`${id}: needs sha256 (64 lowercase hex) and bytes`);
      if (k === "dir" && !HEX40.test(e.commit || "")) bad.push(`${id}: a tree source needs the commit it must be at`);
      if (k === "box" && !e.boxReuse) bad.push(`${id}: a box-only file needs boxReuse, the box path it is staged from`);
      if (needPath && k === "dir") bad.push(`${id}: a directory cannot be shipped`);
    }
  }
  return R.add(bad.length === 0, "manifest shape", bad.join("; "));
}

// ---- the claims the package makes ----------------------------------------------------------------------------------
async function checkClaims(m, bytes, R) {
  const file = (p) => m.files.find((f) => f.path === p);
  const B = (p) => { const f = file(p); return f ? bytes.get(f) : null; };
  // the runtime identity the guest states, recomputed
  const rt = B(m.runtime?.file);
  let rtId = null;
  if (!rt) R.add(false, "runtime identity", `no bytes for ${m.runtime?.file}`);
  else {
    const o = JSON.parse(rt.toString("utf8")), why = validateRuntimeIdentity(o);
    rtId = why ? null : Buffer.from(runtimeId(o)).toString("hex");
    R.add(!why && rtId === m.runtime.runtimeId, "runtime identity recomputes to the runtimeId",
          why || (rtId === m.runtime.runtimeId ? `${o.name} ${o.version} ${o.execution}, ${rtId.slice(0, 16)}` : `recomputes to ${rtId}, the manifest says ${m.runtime.runtimeId}`));
  }
  // the manager module that will derive on the box, from its pinned bytes
  let managerDerive = null;
  const dm = m.files.find((f) => f.role === "control.manager" && f.path.endsWith("/derive.mjs"));
  if (dm && bytes.get(dm)) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vbspkg-mgr-"));
    fs.writeFileSync(path.join(d, "derive.mjs"), bytes.get(dm));
    try { managerDerive = (await import(pathToFileURL(path.join(d, "derive.mjs")).href)).derive; }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
  R.add(typeof managerDerive === "function", "the pinned manager's derive.mjs loads", managerDerive ? "" : "no control.manager derive.mjs with bytes");
  for (const a of m.apps || []) {
    const n = `${a.name} ${a.version}`, dir = a.dir;
    const comp = B(`${dir}/component.wasm`), rec = B(`${dir}/record.json`), bun = B(`${dir}/app.bundle`);
    if (!comp || !rec || !bun) { R.add(false, `${n}: files`, `needs ${dir}/component.wasm, record.json and app.bundle with bytes`); continue; }
    R.add(sha(comp) === a.componentSha256 && cidDigest(a.cid) === a.componentSha256, `${n}: the component is the content its CID names`,
          cidDigest(a.cid) === null ? `${a.cid} is not a CIDv1 raw sha2-256` : sha(comp) === a.componentSha256 && cidDigest(a.cid) === a.componentSha256
            ? `${a.cid.slice(0, 16)}… = ${a.componentSha256.slice(0, 16)}` : `component ${sha(comp).slice(0, 16)}, CID names ${cidDigest(a.cid).slice(0, 16)}, pinned ${a.componentSha256.slice(0, 16)}`);
    let r = null; try { r = JSON.parse(rec.toString("utf8")); } catch {}
    const recOk = r && sha(rec) === a.recordSha256 && r.cid === a.cid && r.runtimeId === m.runtime.runtimeId && r.derivation === a.derivation
      && JSON.stringify(r.catalog) === JSON.stringify(a.catalog);
    R.add(!!recOk, `${n}: the record names this CID, derivation, catalog version and the guest's runtime`,
          recOk ? `record ${a.recordSha256.slice(0, 16)}` : !r ? "record is not JSON"
            : `record ${sha(rec).slice(0, 16)} (pinned ${a.recordSha256.slice(0, 16)}), cid ${r.cid === a.cid}, runtime ${r.runtimeId === m.runtime.runtimeId}, derivation ${r.derivation === a.derivation}, catalog ${JSON.stringify(r.catalog) === JSON.stringify(a.catalog)}`);
    const bf = file(`${dir}/app.bundle`), from = bf.from?.derive;
    R.add(!!from && from.record === `${dir}/record.json` && from.component === `${dir}/component.wasm`, `${n}: the bundle is derived from this app's record and component`,
          from ? "" : "the bundle's source is not a derivation");
    R.add(sha(bun) === a.appId, `${n}: the derived bundle hashes to the AppID (reference rule)`, sha(bun) === a.appId ? a.appId.slice(0, 16) : `${sha(bun)} != ${a.appId}`);
    if (managerDerive && r) {
      let mb = null, why = "";
      try { const x = managerDerive({ record: r, component: comp }); mb = x.bundle; if (x.appId !== sha(mb)) why = "the module's appId is not its bundle's hash"; }
      catch (e) { why = e.message; }
      R.add(!!mb && !why && sha(mb) === a.appId, `${n}: the pinned manager derives the same AppID`, mb && !why ? (sha(mb) === a.appId ? "" : `it derives ${sha(mb)}`) : why);
    }
    const servableOk = a.servable === SERVED_BY_PINNED_MANAGER.includes(a.derivation);
    R.add(servableOk, `${n}: servable only on a derivation the pinned manager serves`,
          servableOk ? (a.servable ? "servable" : `not servable: ${a.blockedOn || "(no reason given)"}`) : `servable=${a.servable} for ${a.derivation}`);
    if (a.servable) {
      const e = a.expect || {}, ok = Number.isInteger(e.status) && typeof e.body === "string" && e.bodySha256 === sha(Buffer.from(e.body, "utf8"));
      R.add(ok, `${n}: an expected answer, exact to the byte`, ok ? `${e.status} ${JSON.stringify(e.body)} (${e.bodySha256.slice(0, 16)})`
            : "expect needs status, body and bodySha256 = sha256 of the body's UTF-8 bytes");
    }
    const sp = B(`${dir}/spawn.json`);
    if (sp) {
      const s = JSON.parse(sp.toString("utf8"));
      const ok = JSON.stringify(s.derive) === JSON.stringify(r) && s.isPublic === true && s.hasSecrets === false;
      R.add(ok, `${n}: the spawn request carries exactly this record`, ok ? "" : "spawn.json's derive is not the record, or it is not public/secret-free");
    }
  }
  // the guest: one monitor image behind both profiles
  const P = m.profiles || {}, hcs = P["hcs-dev"], ig = P.igvm;
  const has = (p, role) => { const f = file(p); return !!f && f.role === role; };
  R.add(!!hcs && has(hcs.kernel, "guest.kernel") && has(hcs.initrd, "guest.initrd") && has(hcs.launcher, "control.launcher"),
        "profile hcs-dev names a kernel, the monitor initrd and the launcher of this package", hcs ? "" : "no hcs-dev profile");
  R.add(!!ig && has(ig.image, "guest.igvm"), "profile igvm names the image of this package", ig ? ig.image : "no igvm profile");
  R.add(!!ig && m.rebuild?.igvm?.initrd === hcs?.initrd, "both profiles boot the SAME monitor image",
        m.rebuild?.igvm?.initrd === hcs?.initrd ? `${hcs.initrd} is the IGVM's VTL0 initrd` : "the IGVM's VTL0 initrd is not the hcs-dev initrd");
  // what the Windows scripts read from the manifest: present and pointing at files of this package
  const c = m.control || {}, wr = m.vmWorkerRead || [];
  R.add(has(c.manager, "control.manager") && has(c.fetcher, "control.fetcher"), "control names the manager entry and the fetcher of this package",
        `${c.manager}, ${c.fetcher}`);
  R.add(wr.length > 0 && wr.every((p) => !!file(p)) && wr.includes(ig?.image), "vmWorkerRead names the IGVM", wr.join(", "));
  R.add(["hcs-dev", "igvm"].every((p) => m.hostChecks?.[p] && typeof P[p]?.status === "string"), "each profile states its host checks and status");
  // the guest's own HTTP surface and the judge that reads its document (isolation/m3/HV-GUEST.md), when declared
  const G = m.guest;
  if (G) {
    const jf = file(G.judge);
    const jr = file(G.judgeRun);
    R.add(typeof G.readyPath === "string" && typeof G.attestationPath === "string" && !!jf && jf.role === "control.judge" && !!jr && jr.role === "tool.windows",
          "guest declares its ready and attestation paths, a judge and its runner of this package", `${G.readyPath}, ${G.attestationPath}, ${G.judge}, ${G.judgeRun}`);
    let judgeFn = null, why = "";
    const judges = m.files.filter((f) => f.role === "control.judge");
    if (judges.every((f) => bytes.get(f))) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "vbspkg-judge-"));
      try {
        for (const f of judges) { const p = path.join(d, ...f.path.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes.get(f)); }
        judgeFn = (await import(pathToFileURL(path.join(d, ...G.judge.split("/"))).href)).judge;
      } catch (e) { why = e.message; } finally { fs.rmSync(d, { recursive: true, force: true }); }
    } else why = "a judge file has no bytes";
    R.add(typeof judgeFn === "function", "the pinned judge loads from the package's own files, laid out as shipped", why);
    if (typeof judgeFn === "function") {
      const v = judgeFn({ doc: {}, spki: Buffer.alloc(0), nonce: Buffer.alloc(32), expectedAppSha256: "00".repeat(32), launcherKey: "" });
      R.add(v && v.verdict === "reject", "the pinned judge rejects a document that is not one", v ? v.verdict : "no answer");
    }
  }
  // The igvm profile's manager must create its VM WITH a guest-state isolation type, or Hyper-V accepts the FirmwareFile
  // pin and silently never loads it (measured, enclave-d1, 2026-09-24). Every file of a stale manager still hashes to
  // its pin, so this asks the pinned manager's own start() on a recording host: win/manager-check.mjs, the verifier's
  // copy, which the package also ships for the box.
  if (ig?.manager) R.add(has(ig.manager.check, "tool.windows"), "profile igvm ships its manager check for the box", ig.manager.check);
  if (ig) {
    const mf = m.files.filter((f) => f.role === "control.manager");
    const app = (m.apps || []).find((a) => a.servable);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vbspkg-mgr-"));
    let res = null;
    try {
      for (const f of mf) { const p = path.join(d, ...f.path.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); if (bytes.get(f)) fs.writeFileSync(p, bytes.get(f)); }
      // the servable app's record and component, from their pinned bytes: the manager derives its own mapping from them
      fs.writeFileSync(path.join(d, "record.json"), (app && bytes.get(file(`${app.dir}/record.json`))) || "");
      fs.writeFileSync(path.join(d, "component.wasm"), (app && bytes.get(file(`${app.dir}/component.wasm`))) || "");
      const mdir = path.join(d, ...(c.manager || "").split("/").slice(0, -1));
      const ue = m.profiles?.uefi, mediumSha = ue && file(ue.medium)?.sha256;
      const r = spawnSync(process.execPath, [path.join(HERE, "win/manager-check.mjs"), mdir,
        "--record", path.join(d, "record.json"), "--component", path.join(d, "component.wasm"), "--image-sha256", file(ig.image)?.sha256 || "",
        ...(mediumSha ? ["--medium-sha256", mediumSha] : [])],
        { encoding: "utf8", timeout: 60000 });
      try { res = JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch { res = { ok: false, reason: (r.stderr || r.stdout || "").trim().split("\n").at(-1) }; }
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
    R.add(!!res?.ok, "the igvm manager creates its VM with a guest-state isolation type (its own start(), on a recording host)",
          res?.ok ? `New-VM -GuestStateIsolationType ${res.isolation}${res.secureBootOff ? ", Secure Boot off" : ""}` : res?.reason || "no answer");
    // The manager's UEFI SERVING path, pinned as MEASURED: what start() does about the medium and the hv_sock exchange.
    // Red today; the pin must move when the manager gains them, so a change never passes unnoticed.
    const ms = m.profiles?.uefi?.managerServing;
    if (ms && ms.expect) {
      const got = res?.serving || null, keys = Object.keys(ms.expect);
      const diff = got ? keys.filter((k) => JSON.stringify(got[k]) !== JSON.stringify(ms.expect[k])).map((k) => `${k}: ${JSON.stringify(got[k])} (pinned ${JSON.stringify(ms.expect[k])})`) : ["no measurement"];
      R.add(diff.length === 0, "the manager's UEFI serving path is exactly as pinned (medium attach, boot device, read-back, image, launcher key, relay)",
            diff.length ? diff.join("; ") : keys.map((k) => `${k}=${JSON.stringify(ms.expect[k])}`).join(" "));
    }
  }
  // Media roles are structural, not textual: every profile's `medium` is a guest.uefi-medium, every `probeMedium` is a
  // probe.uefi-medium whose path says PROBE, and no profile boots a probe.* file as its medium: a probe medium carries a
  // kernel module that reports on the VM, and must never be the medium an app is served from.
  {
    const probes = m.files.filter((f) => /^probe\./.test(f.role)), bad = [];
    for (const [name, p] of Object.entries(m.profiles || {})) {
      if (p.medium && file(p.medium)?.role !== "guest.uefi-medium") bad.push(`${name}.medium ${p.medium} is ${file(p.medium)?.role || "not a file"}`);
      if (p.fallbackMedium && file(p.fallbackMedium)?.role !== "guest.uefi-fallback") bad.push(`${name}.fallbackMedium ${p.fallbackMedium} is ${file(p.fallbackMedium)?.role || "not a file"}`);
      if (p.probeMedium && (file(p.probeMedium)?.role !== "probe.uefi-medium" || !/PROBE/.test(p.probeMedium))) bad.push(`${name}.probeMedium ${p.probeMedium} is ${file(p.probeMedium)?.role || "not a file"}${/PROBE/.test(p.probeMedium) ? "" : " and is not named PROBE"}`);
      // firmware: a probe.* file (a debug image that trusts the host command line, or its control) is never ANY profile's firmware or image
      for (const k of ["firmware", "image"]) if (p[k] && /^probe\./.test(file(p[k])?.role || "")) bad.push(`${name}.${k} ${p[k]} is ${file(p[k]).role}: a probe firmware is never a profile's firmware`);
    }
    for (const f of probes) if (!/PROBE/.test(f.path)) bad.push(`${f.path} (${f.role}) is not named PROBE on disk`);
    if (probes.length || bad.length) R.add(bad.length === 0, "no profile boots a PROBE medium as its medium or a probe firmware as its firmware, and every probe file is named PROBE on disk", bad.length ? bad.join("; ") : `${probes.length} probe file(s)`);
  }
  // A quoted guest console line is evidence of what the guest STATED. While the tier says the host is not excluded, every
  // 'MON boundary' line quoted anywhere in the profiles must say host_excluded=no: a package cannot carry a line that
  // contradicts its own tier, and (enclave-d1) a rule that merely forbade such lines under an experimental profile would
  // fail on true evidence the day a guest really boots there.
  {
    // a quoted line is one that carries the tuple (MON boundary tier=... with a host_excluded= value); prose that mentions
    // "the MON boundary line" and the bare expectation prefix "MON boundary tier=t0-hv" carry no value and are not evidence
    const lines = (JSON.stringify(m.profiles || {}).match(/MON boundary tier=[^'"\\]*/g) || []).filter((l) => /host_excluded=/.test(l)), bad = lines.filter((l) => !/host_excluded=no\b/.test(l));
    if (!m.tier?.hostExcluded && lines.length) R.add(bad.length === 0, "every quoted 'MON boundary' line says host_excluded=no while the tier says the host is not excluded", bad.length ? bad.map((l) => l.slice(0, 120)).join("; ") : `${lines.length} line(s)`);
  }
  // The node's own record builder against the catalog. The manifest records each app's catalog version as READ FROM THE
  // CHAIN (catalogFacts, with the block, address book and catalog it came from); the shipped node-bridge.mjs's
  // isolationPlan builds the derivation record from those facts exactly as the node will at spawn time, and it must be
  // the pinned record BYTE FOR BYTE (canonical JSON, not field by field). A node-side builder that took its policy or
  // catalog id from somewhere else -- enclave-d1's hand-built record used the node's cpuFallback floor for memMiB and a
  // label for catalog.app: every field present and well-formed, two wrong -- derives another AppID than the Linux tier.
  if (m.catalogFacts) {
    const nb = m.files.find((f) => f.path.endsWith("/node-bridge.mjs"));
    let plan = null, why = "", backendName = null;
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vbspkg-plan-"));
    try {
      for (const f of m.files.filter((x) => x.path.startsWith("control/") && bytes.get(x))) {
        const p = path.join(d, ...f.path.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes.get(f));
      }
      if (!nb) throw new Error("no node-bridge.mjs in the package");
      const mod = await import(pathToFileURL(path.join(d, ...nb.path.split("/"))).href);
      plan = mod.isolationPlan; backendName = mod.BACKEND || "hyperv-partition-per-app";
      if (typeof plan !== "function") throw new Error("node-bridge.mjs exports no isolationPlan");
    } catch (e) { why = e.message; } finally { fs.rmSync(d, { recursive: true, force: true }); }
    const src = m.catalogFacts.source || {};
    R.add(typeof plan === "function" && Number.isInteger(src.block) && /^0x[0-9a-fA-F]{40}$/.test(src.catalog || ""),
          "catalog facts name their chain read, and the shipped node-bridge exports isolationPlan", why || `chain ${src.chainId}, block ${src.block}, catalog ${src.catalog}`);
    for (const a of m.apps || []) {
      const n = `${a.name} ${a.version}`, key = `${a.catalog.app}/${a.catalog.version}`, v = (m.catalogFacts.versions || {})[key];
      if (!v) { R.add(false, `${n}: catalog facts`, `none recorded for ${key}`); continue; }
      R.add(v.cid === a.cid && v.yanked === false && v.approval === 1, `${n}: the catalog version names this CID, approved and not yanked`,
            `cid ${v.cid === a.cid}, yanked ${v.yanked}, approval ${v.approval}`);
      if (typeof plan !== "function") continue;
      let got = null, err = "";
      try {
        const p = plan({ deploymentId: "0x" + "11".repeat(32), deployment: { cpuMilli: 250, gpuMilli: 0, isPublic: true, appPort: 8080 },
          version: { appId: a.catalog.app, index: a.catalog.version, cid: v.cid, memMb: v.memMb, ports: v.ports, config: v.config, configCid: v.configCid || "", yanked: v.yanked },
          appConfig: v.config ? JSON.parse(v.config) : null, hasSecrets: false, waf: {}, volumes: [], runtimeId: m.runtime.runtimeId,
          // the gate inputs (2a43239a on), stated as a correctly configured node states them: the tenant asked for this
          // backend, the manager IS this backend and serves both derivations, no deployment config override. Older
          // bridges ignore them (and took `derivations` directly).
          require: backendName, manager: { backend: backendName, catalog: { derivations: ["enclave-catalog-bundle/1", "enclave-catalog-bundle/2"] } },
          appConfigCid: "", derivations: ["enclave-catalog-bundle/1", "enclave-catalog-bundle/2"] });
        got = p && p.spawn ? p.spawn : null;
        if (!got) err = `the plan refused: ${JSON.stringify(p).slice(0, 200)}`;
      } catch (e) { err = e.message; }
      const rec = B(`${a.dir}/record.json`), ok = !!got && !!rec && canonical(got.derive).equals(rec) && got.isPublic === true && got.hasSecrets === false;
      R.add(ok, `${n}: the node's isolationPlan builds exactly the pinned record from the on-chain version`,
            ok ? `record ${a.recordSha256.slice(0, 16)}, memMb ${v.memMb}${v.ports ? `, ports ${v.ports}` : ""}`
               : err || `it builds ${got ? sha(canonical(got.derive)).slice(0, 16) : "nothing"}, pinned ${a.recordSha256.slice(0, 16)}`);
    }
  }
  // slots the package does not fill yet, and must not pretend to
  for (const s of m.slots || []) {
    const filled = m.files.filter((f) => f.role === s.role);
    const ok = (s.state === "empty" && filled.length === 0) || (s.state === "pinned" && filled.length > 0);
    R.add(ok, `slot ${s.role} (${s.owner})`, ok ? s.state : `state ${s.state} with ${filled.length} file(s)`);
  }
}

// ---- rebuild: the VTL0 vmlinux from the box's bzImage, and the IGVM from its inputs ---------------------------------
// The VTL2 pieces are inputs whose `file` lies inside the openvmm tree, so their source checks above already pin
// the bytes build-ownguest.sh will read from it; the IGVM's hash then proves nothing else was picked up.
function rebuild(m, bytes, R) {
  // a reference is "file:<package path>" or the name of a build input
  const ref = (x) => (String(x).startsWith("file:") ? m.files.find((f) => f.path === x.slice(5)) : m.inputs.find((i) => i.name === x));
  const rb = m.rebuild || {}, v = rb.vmlinux, g = rb.igvm;
  if (!v || !g) return R.add(false, "rebuild", "the manifest has no rebuild.vmlinux / rebuild.igvm recipe");
  const d = fs.mkdtempSync(path.join(os.homedir(), ".vbspkg-rebuild-"));   // the IGVM is 125 MB: not in a tmpfs
  try {
    const wr = (name, b, mode) => { const p = path.join(d, name); fs.writeFileSync(p, b); if (mode) fs.chmodSync(p, mode); return p; };
    const vscript = wr("vtl0-vmlinux.sh", bytes.get(ref(v.script)), 0o755);
    const bz = wr("bzImage", bytes.get(ref(v.bzImage)));
    const r1 = spawnSync(vscript, [bz, path.join(d, "vmlinux")], { encoding: "utf8" });
    const vh = fs.existsSync(path.join(d, "vmlinux")) ? sha(fs.readFileSync(path.join(d, "vmlinux"))) : null, vwant = ref(v.output).sha256;
    R.add(r1.status === 0 && vh === vwant, "rebuild: the VTL0 vmlinux from the WSL bzImage",
          vh === vwant ? vh.slice(0, 16) : `exit ${r1.status}, got ${vh}: ${(r1.stderr || "").trim().split("\n").at(-1)}`);
    const tree = ref(g.tree), head = spawnSync("git", ["-C", home(tree.from.dir), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    R.add(head === tree.commit, "rebuild: the openvmm tree is at its pinned commit", head === tree.commit ? head.slice(0, 12) : `at ${head || "(none)"}`);
    const gscript = wr("build-ownguest.sh", bytes.get(ref(g.script)), 0o755);
    const man = wr("manifest-ownguest.json", bytes.get(ref(g.manifest)));
    const initrd = wr("mon.cpio.gz", bytes.get(ref(`file:${g.initrd}`)));
    const out = path.join(d, "igvm.bin");
    // A SHADOW TREE for d1's script, built from the PINNED input bytes at the four paths it reads (ship/openhcl_boot,
    // ship/sidecar, the kernel package's vmlinux, .work/.../openhcl.cpio.gz), so the rebuild depends on the pins and
    // not on whatever a later flowey run left in the real tree. Measured 2026-09-25: two CVM builds in the real tree
    // left a second extracted kernel package that sorts first for the script's `ls ... | head -1`, and the rebuild
    // silently used the CVM kernel while every pin was right. The real tree is still checked at its commit above.
    const vt = g.vtl2 || { openhcl_boot: "openhcl_boot", sidecar: "sidecar", kernel: "underhill-vmlinux", initrd: "openhcl.cpio.gz" };
    const shadow = path.join(d, "tree"), ship = path.join(shadow, "flowey-out/artifacts/build-igvm/ship/x64-test-linux-direct");
    const kdir = path.join(shadow, "flowey-persist/flowey_lib_hvlite__resolve_openhcl_kernel_package/extracted/pinned"), wdir = path.join(shadow, "flowey-out/.work/flowey_lib_hvlite__build_openhcl_initrd_0");
    for (const [dir, name, input] of [[ship, "openhcl_boot", vt.openhcl_boot], [ship, "sidecar", vt.sidecar], [kdir, "vmlinux", vt.kernel], [wdir, "openhcl.cpio.gz", vt.initrd]]) {
      const e = ref(input); if (!e || !bytes.get(e)) return R.add(false, "rebuild: the IGVM from its pinned inputs, on the rebuilt vmlinux", `VTL2 input ${input} is not a pinned input of this manifest`);
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), bytes.get(e));
    }
    const r2 = spawnSync(gscript, [shadow, path.join(d, "vmlinux"), initrd, out, man],
                         { encoding: "utf8", env: { ...process.env, IGVMFILEGEN: home(ref(g.igvmfilegen).from.file) } });
    const gh = fs.existsSync(out) ? sha(fs.readFileSync(out)) : null, want = ref(`file:${g.output}`).sha256;
    R.add(r2.status === 0 && gh === want, "rebuild: the IGVM from its pinned inputs, on the rebuilt vmlinux (a shadow tree of the pinned VTL2 bytes)",
          gh === want ? gh.slice(0, 16) : `exit ${r2.status}, got ${gh}: ${(r2.stderr || "").trim().split("\n").at(-1)}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

// An IGVM that igvmfilegen makes from pinned inputs alone: a manifest, a resource map naming pinned inputs, the pinned
// igvmfilegen, all written to a scratch directory (nothing is read from any build tree). The output and its VBS identity
// document must be the pinned bytes. A `twin` builds the same components under another manifest and must reproduce a
// pinned VBS launch digest: that is how the components are shown to be the ones a booted image was built from.
function rebuildIgvmfilegen(m, bytes, R) {
  const ref = (x) => (String(x).startsWith("file:") ? m.files.find((f) => f.path === x.slice(5)) : m.inputs.find((i) => i.name === x));
  const digest = (b) => { try { return JSON.parse(String(b)).series[0].reference.vbs_boot_digest; } catch { return null; } };
  for (const [key, u] of Object.entries(m.rebuild || {})) {
    if (!u || u.kind !== "igvmfilegen") continue;
    const d = fs.mkdtempSync(path.join(os.homedir(), ".vbspkg-igvm-"));
    try {
      const put = (name, e) => { const p = path.join(d, name); fs.writeFileSync(p, bytes.get(e)); return p; };
      const igp = put("igvmfilegen", ref(u.igvmfilegen)); fs.chmodSync(igp, 0o755);
      const build = (tag, man, res) => {
        const rmap = {};
        for (const [t, n] of Object.entries(res)) { const e = ref(n); if (!e || !bytes.get(e)) return { err: `resource ${t} = ${n} is not a pinned input` }; rmap[t] = put(`${tag}-${t}`, e); }
        const rp = path.join(d, `${tag}-resources.json`); fs.writeFileSync(rp, JSON.stringify({ resources: rmap }));
        const out = path.join(d, `${tag}.bin`), vj = path.join(d, `${tag}-vbs.json`);
        const r = spawnSync(igp, ["manifest", "-m", put(`${tag}-manifest.json`, ref(man)), "-r", rp, "-o", out], { encoding: "utf8" });
        return { r, bin: fs.existsSync(out) ? sha(fs.readFileSync(out)) : null, vbs: fs.existsSync(vj) ? fs.readFileSync(vj) : null };
      };
      if (u.twin) {
        const t = build("twin", u.twin.manifest, u.twin.resources), want = digest(bytes.get(ref(u.twin.expectVbsJson)));
        const got = t.vbs ? digest(t.vbs) : null;
        R.add(!!want && got === want, `rebuild ${key}: its components reproduce the booted image's VBS launch digest (a twin under the booted image's own manifest)`,
              t.err || (got === want ? got : `twin gives ${got}, the booted image states ${want}`));
      }
      const c = build("out", u.manifest, u.resources), want = ref(u.output)?.sha256;
      R.add(!c.err && c.r.status === 0 && c.bin === want, `rebuild ${key}: the IGVM from its pinned inputs with the pinned igvmfilegen`,
            c.err || (c.bin === want ? c.bin.slice(0, 16) : `exit ${c.r.status}, got ${c.bin}: ${(c.r.stderr || "").trim().split("\n").at(-1)}`));
      if (u.vbsJson) R.add(!!c.vbs && sha(c.vbs) === ref(u.vbsJson)?.sha256, `rebuild ${key}: its VBS identity document (the launch digest igvmfilegen computes)`, c.vbs ? digest(c.vbs) : "none produced");
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
}
// Byte rules on a pinned IGVM that hold with or without --rebuild: strings it must carry and strings it must never carry
// (the confidential-debug flag makes OpenHCL trust the host's command line, so a non-debug candidate must not carry it).
function checkIgvmStrings(m, bytes, R) {
  const ref = (x) => m.inputs.find((i) => i.name === x) || m.files.find((f) => f.path === x);
  for (const [key, u] of Object.entries(m.rebuild || {})) {
    if (!u || u.kind !== "igvmfilegen") continue;
    const b = bytes.get(ref(u.output)); if (!b) { R.add(false, `${key}: the pinned IGVM's bytes`, "not resolved"); continue; }
    const bad = [...(u.mustNotContain || []).filter((x) => b.includes(Buffer.from(x))).map((x) => `carries '${x}'`),
                 ...(u.mustContain || []).filter((x) => !b.includes(Buffer.from(x))).map((x) => `lacks '${x}'`)];
    R.add(bad.length === 0, `${key}: the pinned IGVM carries exactly the required strings and none of the forbidden ones`, bad.length ? bad.join("; ") : `must: ${(u.mustContain || []).length}, never: ${(u.mustNotContain || []).join(", ")}`);
  }
}

// Rebuild the UEFI boot medium from its pinned inputs with the pinned builder (pkg/uefi/build-uefi-image.sh), and
// require the ISO and disk.raw to be the pinned bytes, and the shipped VHDX's payload to be that disk.raw.
function rebuildUefi(m, bytes, R) {
  // every builder-backed medium: rebuild.uefi is the boot medium; any other builder entry is a probe medium
  for (const [key, u] of Object.entries(m.rebuild || {})) if (u && u.builder)
    rebuildOne(m, bytes, R, u, key === "uefi" ? "the UEFI boot medium" : key === "probe" ? "the PROBE medium (never an app's medium)" : `the ${key} medium (never an app's medium)`);
}
function rebuildOne(m, bytes, R, u, label) {
  if (!u) return;
  const ref = (x) => (String(x).startsWith("file:") ? m.files.find((f) => f.path === x.slice(5)) : m.inputs.find((i) => i.name === x));
  const d = fs.mkdtempSync(path.join(os.homedir(), ".vbspkg-uefi-"));
  try {
    const wr = (name, e, mode) => { const p = path.join(d, name); fs.writeFileSync(p, bytes.get(ref(e))); if (mode) fs.chmodSync(p, mode); return p; };
    const builder = wr("build-uefi-image.sh", u.builder, 0o755), recipe = wr("build-uki.sh", u.ukiRecipe);
    const kernel = wr("kernel", u.kernel), initrd = wr("initrd", u.initrd), stub = wr("stub.efi", u.stub);
    const mt = u.mtoolsDir ? home(u.mtoolsDir) : null;
    const r = spawnSync(builder, ["--kernel", kernel, "--initrd", initrd, "--cmdline", u.cmdline, "--stub", stub, "--uki-recipe", recipe,
      "--esp-mib", String(u.espMiB), "--disk-mib", String(u.diskMiB), "--epoch", String(u.epoch), "--out", path.join(d, "out"), ...(mt ? ["--mtools", mt] : [])], { encoding: "utf8" });
    const o = (f) => (fs.existsSync(path.join(d, "out", f)) ? sha(fs.readFileSync(path.join(d, "out", f))) : null);
    const want = (p) => m.files.find((f) => f.path === p)?.sha256;
    R.add(r.status === 0 && o("guest.iso") === want(u.iso), `rebuild: ${label} (ISO) from its pinned inputs, and 5d's recipe agrees on the UKI`,
          o("guest.iso") === want(u.iso) ? o("guest.iso").slice(0, 16) : `exit ${r.status}: ${(r.stderr || "").trim().split("\n").at(-1)}; got ${o("guest.iso")}`);
    R.add(o("disk.raw") === u.diskRawSha256, `rebuild: ${label}'s disk.raw (the fallback's payload) from the same inputs`, `${o("disk.raw")}`);
    const vh = m.files.find((f) => f.path === u.fallback);
    if (vh && bytes.get(vh)) {
      fs.writeFileSync(path.join(d, "fb.vhdx"), bytes.get(vh));
      const c = spawnSync("qemu-img", ["convert", "-q", "-f", "vhdx", "-O", "raw", path.join(d, "fb.vhdx"), path.join(d, "fb.raw")], { encoding: "utf8" });
      const got = c.status === 0 ? sha(fs.readFileSync(path.join(d, "fb.raw"))) : null;
      R.add(got === u.diskRawSha256, "the shipped fallback VHDX carries exactly disk.raw", got ? got.slice(0, 16) : c.stderr);
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

async function fetchCheck(m, gw, R) {
  for (const a of m.apps || []) {
    try {
      const res = await fetch(`${gw.replace(/\/$/, "")}/ipfs/${a.cid}?format=raw`, { headers: { accept: "application/vnd.ipld.raw", "user-agent": "enclave-vbspkg/1" } });
      const b = Buffer.from(await res.arrayBuffer());
      R.add(res.status === 200 && sha(b) === a.componentSha256, `fetch: ${a.name} ${a.version} by CID from ${gw}`, res.status === 200 ? (sha(b) === a.componentSha256 ? `${b.length} bytes` : `got ${sha(b)}`) : `HTTP ${res.status}`);
    } catch (e) { R.add(false, `fetch: ${a.name} ${a.version} by CID from ${gw}`, e.message); }
  }
}

// Serve each servable wasi:http app HERE with the pinned runtime and compare its answer with the pin. The runtime on
// this host must be the version the runtime identity names, or the comparison says nothing.
async function serveCheck(m, bytes, R) {
  const rt = JSON.parse(bytes.get(m.files.find((f) => f.path === m.runtime.file)).toString("utf8"));
  const v = spawnSync("wasmtime", ["--version"], { encoding: "utf8" });
  const have = (v.stdout || "").split(/\s+/)[1];
  if (!R.add(v.status === 0 && have === rt.version, "serve: this host's wasmtime is the pinned runtime", v.status === 0 ? `wasmtime ${have}, pinned ${rt.version}` : "no wasmtime")) return;
  for (const a of (m.apps || []).filter((x) => x.servable)) {
    const comp = bytes.get(m.files.find((f) => f.path === `${a.dir}/component.wasm`));
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vbspkg-serve-")), wasm = path.join(d, "c.wasm");
    fs.writeFileSync(wasm, comp);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const { spawn } = await import("node:child_process");
    const child = spawn("wasmtime", ["serve", "-S", "cli", "--addr", `127.0.0.1:${port}`, wasm], { stdio: "ignore" });
    let got = null, err = "";
    try {
      const until = Date.now() + 30000;
      while (Date.now() < until && !got) {
        try { const res = await fetch(`http://127.0.0.1:${port}/`); got = { status: res.status, body: Buffer.from(await res.arrayBuffer()) }; }
        catch (e) { err = e.message; await new Promise((r) => setTimeout(r, 200)); }
      }
    } finally { child.kill("SIGKILL"); fs.rmSync(d, { recursive: true, force: true }); }
    const ok = !!got && got.status === a.expect?.status && sha(got.body) === a.expect?.bodySha256;
    R.add(ok, `serve: ${a.name} ${a.version} answers exactly the pinned bytes under wasmtime ${have}`,
          got ? `${got.status} ${JSON.stringify(got.body.toString("utf8"))}${ok ? "" : `, pinned ${a.expect?.status} ${JSON.stringify(a.expect?.body)}`}` : `no answer: ${err}`);
  }
}

// Run each pinned functional test inside the package's own tree: its control/ files, laid out as shipped, with the test
// placed at its declared path so its relative imports resolve to the PACKAGE's bytes. The expected result is exact:
// the number of tests, passes and failures, which cases fail, and which cases SKIP and why -- a known result, never
// "whatever is green". A skip not declared is a failure of the pin: a case that silently stops running reads as a pass
// in the counts alone. todo and cancelled must be zero unless declared.
// The error text of each failing top-level case in TAP: `error: '...'` (YAML single-quoted) or an `error: |-` block.
function failureMessages(o) {
  const lines = o.split("\n"), out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^not ok (\d+) /.exec(lines[i]); if (!m) continue;
    for (let j = i + 1; j < lines.length && !/^(ok|not ok) \d+ |^# Subtest/.test(lines[j]); j++) {
      const e = /^  error: (.*)$/.exec(lines[j]); if (!e) continue;
      let v = e[1];
      if (v === "|-" || v === "|") { const buf = []; for (let k = j + 1; k < lines.length && /^    /.test(lines[k]); k++) buf.push(lines[k].slice(4)); v = buf.join("\n"); }
      else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
      else if (/^".*"$/.test(v)) v = JSON.parse(v);
      out.set(Number(m[1]), v); break;
    }
  }
  return out;
}
function testsCheck(m, bytes, R) {
  for (const t of m.tests || []) {
    const inp = m.inputs.find((i) => i.name === t.input);
    const need = (t.requires || []).filter((c) => spawnSync("sh", ["-c", `command -v ${c}`]).status !== 0);
    if (!inp || !bytes.get(inp) || need.length) { R.add(false, `test ${t.name} (${t.owner})`, !inp ? `no input ${t.input}` : need.length ? `needs ${need.join(", ")}` : "no bytes"); continue; }
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vbspkg-test-"));
    try {
      for (const f of m.files.filter((x) => x.path.startsWith("control/") && bytes.get(x))) {
        const p = path.join(d, ...f.path.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes.get(f));
      }
      const tp = path.join(d, ...t.layout.split("/")); fs.mkdirSync(path.dirname(tp), { recursive: true }); fs.writeFileSync(tp, bytes.get(inp));
      if (m.npmTree && t.npmTree) { const pr = assembleNpmTree(m, bytes, d); if (pr.length) throw new Error(`npm tree: ${pr.join("; ")}`); }
      // data a test reads from the repository (contract sources, vectors): pinned inputs, placed for the run, never shipped
      for (const sp of t.support || []) {
        const si = m.inputs.find((i) => i.name === sp.input), p = path.join(d, ...sp.layout.split("/"));
        if (!si || !bytes.get(si)) throw new Error(`test ${t.name}: no bytes for support input ${sp.input}`);
        if (sp.unpack === "npm-tgz") {
          // an npm tarball (pinned by sha256 and by npm's own sha512 integrity): its package/ directory becomes `layout`
          const tgz = path.join(d, `.support-${sp.input}`); fs.writeFileSync(tgz, bytes.get(si)); fs.mkdirSync(p, { recursive: true });
          const x = spawnSync("tar", ["-xzf", tgz, "-C", p, "--strip-components=1"], { encoding: "utf8" });
          fs.rmSync(tgz, { force: true });
          if (x.status !== 0) throw new Error(`test ${t.name}: could not unpack ${sp.input}: ${x.stderr.trim()}`);
        } else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes.get(si)); }
      }
      // a run under another test runner inherits NODE_TEST_CONTEXT, which switches the child's output to the runner's binary
      // protocol and leaves no counts to read: strip it, and ask for TAP by name
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", tp], { cwd: d, encoding: "utf8", timeout: 300000, env });
      const o = r.stdout + r.stderr, n = (k) => Number((new RegExp(`^# ${k} (\\d+)$`, "m").exec(o) || [])[1]);
      const failing = [...o.matchAll(/^not ok (\d+) /gm)].map((x) => Number(x[1])), msgs = failureMessages(o);
      const skipped = [...o.matchAll(/^ok (\d+) - .* # SKIP (.*)$/gm)].map((x) => ({ case: Number(x[1]), reason: x[2].trim() }));
      const e = t.expect || {};
      // a failing entry is a case number, or {case, message}: then the case's error text must be EXACTLY that message
      const want = (e.failing || []).map((x) => (typeof x === "number" ? { case: x } : x));
      const badMsg = want.filter((w) => w.message !== undefined && msgs.get(w.case) !== w.message)
                         .map((w) => `case ${w.case} said ${JSON.stringify(msgs.get(w.case) ?? null)}`);
      const ok = n("tests") === e.tests && n("pass") === e.pass && n("fail") === e.fail && JSON.stringify(failing) === JSON.stringify(want.map((w) => w.case))
        && badMsg.length === 0
        && n("skipped") === (e.skipped || []).length && JSON.stringify(skipped) === JSON.stringify(e.skipped || [])
        && n("todo") === (e.todo || 0) && n("cancelled") === (e.cancelled || 0);
      const said = (x) => `${x.tests} tests, ${x.pass} pass, ${x.fail} fail${(x.failing || []).length ? ` (failing ${x.failing.map((f) => (typeof f === "number" ? f : f.case)).join(", ")})` : ""}`
        + `${(x.skipped || []).length ? `, skipped ${x.skipped.map((k) => `${k.case} "${k.reason}"`).join(", ")}` : ""}${x.todo ? `, todo ${x.todo}` : ""}${x.cancelled ? `, cancelled ${x.cancelled}` : ""}`;
      const got = { tests: n("tests"), pass: n("pass"), fail: n("fail"), failing, skipped, todo: n("todo"), cancelled: n("cancelled") };
      R.add(ok, `test ${t.name} (${t.owner}) gives exactly its expected result`, said(got) + (ok ? "" : `; expected ${said(e)}${badMsg.length ? `; ${badMsg.join("; ")}` : ""}`));
    } catch (err) { R.add(false, `test ${t.name} (${t.owner})`, err.message);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
}

// The node tree the box acceptance harness imports (manifest.npmTree): the package's control/ files laid out as the
// repository, plus node_modules assembled from the pinned npm tarballs (each in its lockfile position, nested where npm
// nests it). Assembled in a temp dir here, and every entry module the harness imports must LOAD from it: that proves the
// tree is complete (a missing relative import, or a viem that cannot resolve, fails here rather than on the box).
// unpack each pinned npm tarball into its lockfile position under `d`; returns the problems (empty = every one placed)
function assembleNpmTree(m, bytes, d) {
  const t = m.npmTree, problems = [];
  if (!t) return problems;
  for (const pkg of t.packages) {
    const f = m.files.find((x) => x.path === pkg.file), dir = path.join(d, ...t.root.split("/"), ...pkg.dir.replace(/^node_modules\//, "").split("/"));
    if (!f || !bytes.get(f)) { problems.push(`${pkg.name}@${pkg.version}: no bytes for ${pkg.file}`); continue; }
    const tgz = path.join(d, ".npm.tgz"); fs.writeFileSync(tgz, bytes.get(f)); fs.mkdirSync(dir, { recursive: true });
    const x = spawnSync("tar", ["-xzf", tgz, "-C", dir, "--strip-components=1"], { encoding: "utf8" });
    if (x.status !== 0) { problems.push(`${pkg.name}@${pkg.version}: ${x.stderr.trim()}`); continue; }
    let v = null; try { v = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch {}
    if (!v || v.name !== pkg.name || v.version !== pkg.version) problems.push(`${pkg.name}@${pkg.version}: the tarball unpacks as ${v ? `${v.name}@${v.version}` : "no package.json"}`);
  }
  fs.rmSync(path.join(d, ".npm.tgz"), { force: true });
  return problems;
}
async function nodeTreeCheck(m, bytes, R) {
  const t = m.npmTree; if (!t) return;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vbspkg-tree-"));
  try {
    for (const f of m.files.filter((x) => x.path.startsWith("control/") && bytes.get(x))) {
      const p = path.join(d, ...f.path.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes.get(f));
    }
    const problems = assembleNpmTree(m, bytes, d);
    R.add(problems.length === 0, "npm tree: every pinned tarball unpacks to its lockfile position with its name and version", problems.length ? problems.join("; ") : `${t.packages.length}/${t.packages.length}`);
    const tree = path.join(d, ...t.root.split("/").slice(0, -1));   // the tree is the parent of node_modules
    const probe = path.join(d, ".load-check.mjs");
    fs.writeFileSync(probe, `import { pathToFileURL } from "node:url"; import path from "node:path";
      const T = ${JSON.stringify(tree)}; const out = [];
      for (const rel of ${JSON.stringify(t.mustLoad)}) { try { await import(pathToFileURL(path.join(T, ...rel.split("/"))).href); out.push("ok " + rel); } catch (e) { out.push("FAIL " + rel + ": " + String(e.message).split("\\n")[0]); } }
      console.log(out.join("\\n"));`);
    const r = spawnSync(process.execPath, [probe], { encoding: "utf8", cwd: d, timeout: 120000 });
    const lines = (r.stdout + r.stderr).trim().split("\n").filter(Boolean), bad = lines.filter((l) => !l.startsWith("ok "));
    R.add(r.status === 0 && bad.length === 0 && lines.length === t.mustLoad.length, "npm tree: every module the acceptance harness imports LOADS from the assembled tree",
          bad.length ? bad.join("; ").slice(0, 400) : `${lines.length} modules`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

// the files that exist on this host and are packed; box-only files are staged on the box from boxReuse
const packable = (m) => m.files.filter((f) => kindOf(f.from) !== "box");

function checkOut(m, mbytes, dir, bytes, R) {
  const want = new Map(packable(m).map((f) => [f.path, f])); want.set("MANIFEST.json", null);
  const have = [];
  const walk = (d, rel = "") => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else have.push(r); } };
  walk(dir);
  const extra = have.filter((p) => !want.has(p)), missing = [...want.keys()].filter((p) => !have.includes(p));
  R.add(extra.length === 0 && missing.length === 0, "out: exactly the packable files", [extra.length ? `extra ${extra.join(", ")}` : "", missing.length ? `missing ${missing.join(", ")}` : ""].filter(Boolean).join("; ") || `${have.length} files`);
  R.add(fs.existsSync(path.join(dir, "MANIFEST.json")) && fs.readFileSync(path.join(dir, "MANIFEST.json")).equals(mbytes), "out: MANIFEST.json is this manifest");
  for (const [p, f] of want) {
    if (!f || !have.includes(p)) continue;
    const h = sha(fs.readFileSync(path.join(dir, p)));
    R.add(h === f.sha256, `out: ${p}`, h === f.sha256 ? "" : `hashes to ${h}, pinned ${f.sha256}`);
  }
}

export async function verify(manifestPath, { out = null, rebuild: doRebuild = false, fetchGw = null, serve = false, tests = false } = {}) {
  const R = reporter();
  const mbytes = fs.readFileSync(manifestPath);
  let m; try { m = JSON.parse(mbytes.toString("utf8")); } catch (e) { R.add(false, "manifest is JSON", e.message); return { R, m: null, id: sha(mbytes) }; }
  if (!checkShape(m, R)) return { R, m, id: sha(mbytes) };
  const at = manifestCommit(manifestPath);
  const { bytes, errors } = resolveAll(m, at);
  for (const e of [...m.files, ...m.inputs]) {
    const id = e.path || e.name, k = kindOf(e.from);
    if (k === "repo" && at && bytes.get(e)) { R.add(sha(bytes.get(e)) === e.sha256 && bytes.get(e).length === e.bytes, `source ${id}`, sha(bytes.get(e)) === e.sha256 ? `repo at the manifest's commit ${at.slice(0, 12)}` : `repo at ${at.slice(0, 12)} gives ${sha(bytes.get(e))}, pinned ${e.sha256}`); continue; }
    if (k === "box") { R.add(true, `source ${id}`, `box-only, pinned by observation on the box (${e.boxReuse}); not reproducible here`); continue; }
    if (k === "dir") { R.add(fs.existsSync(home(e.from.dir)), `source ${id}`, fs.existsSync(home(e.from.dir)) ? `tree at ${home(e.from.dir)}` : `no tree at ${e.from.dir}`); continue; }
    const b = bytes.get(e);
    if (!b) { R.add(false, `source ${id}`, errors.get(e) || "no bytes"); continue; }
    R.add(sha(b) === e.sha256 && b.length === e.bytes, `source ${id}`, sha(b) === e.sha256 && b.length === e.bytes ? `${k}` : `${k} gives ${sha(b)} (${b.length} B), pinned ${e.sha256} (${e.bytes} B)`);
    if (e.integrity) {   // npm's own pin (the lockfile's "integrity"), checked as well as ours
      const want = /^sha512-(.+)$/.exec(e.integrity), got = crypto.createHash("sha512").update(b).digest("base64");
      R.add(!!want && want[1] === got, `source ${id}: npm integrity`, want && want[1] === got ? e.integrity.slice(0, 24) + "…" : `gives sha512-${got}, pinned ${e.integrity}`);
    }
  }
  await checkClaims(m, bytes, R);
  if (out) checkOut(m, mbytes, out, bytes, R);
  checkIgvmStrings(m, bytes, R);
  if (doRebuild) { rebuild(m, bytes, R); rebuildUefi(m, bytes, R); rebuildIgvmfilegen(m, bytes, R); }
  if (fetchGw) await fetchCheck(m, fetchGw, R);
  if (serve) await serveCheck(m, bytes, R);
  if (tests) testsCheck(m, bytes, R);
  if (m.npmTree) await nodeTreeCheck(m, bytes, R);
  return { R, m, id: sha(mbytes), bytes };
}

async function main(argv) {
  const [cmd, manifest, ...rest] = argv;
  const flag = (n) => rest.includes(n), val = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };
  if (cmd === "verify" && manifest) {
    const { R, id } = await verify(manifest, { out: val("--out"), rebuild: flag("--rebuild"), fetchGw: val("--fetch"), serve: flag("--serve"), tests: flag("--tests") });
    R.print();
    console.log(R.ok() ? `PASS package ${id}` : `FAIL package ${id}`);
    return R.ok() ? 0 : 1;
  }
  if (cmd === "pack" && manifest && rest[0]) {
    const { R, m, id, bytes } = await verify(manifest);
    if (!R.ok()) { R.print(); console.log(`FAIL package ${id}: not packed`); return 1; }
    const dir = path.join(home(rest[0]), id.slice(0, 16));
    if (fs.existsSync(dir)) { console.log(`refusing: ${dir} exists (a package directory is written once)`); return 1; }
    for (const f of packable(m)) {
      const p = path.join(dir, ...f.path.split("/"));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, bytes.get(f));
    }
    fs.copyFileSync(manifest, path.join(dir, "MANIFEST.json"));
    const C = reporter(); checkOut(m, fs.readFileSync(manifest), dir, bytes, C);
    if (!C.ok()) { C.print(); console.log(`FAIL packed directory ${dir} does not verify`); return 1; }
    console.log(`packed ${id}\n  -> ${dir}  (${packable(m).length} files + MANIFEST.json)`);
    return 0;
  }
  if (cmd === "pins" && manifest) {
    const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const { bytes, errors } = resolveAll(m, manifestCommit(manifest));
    for (const e of [...m.files, ...m.inputs]) {
      const b = bytes.get(e);
      console.log(`${b ? sha(b) : "-".repeat(64)} ${String(b ? b.length : "").padStart(10)} ${e.path || e.name}${errors.has(e) ? `  (${errors.get(e)})` : ""}`);
    }
    return 0;
  }
  console.error("usage: pkg.mjs verify <manifest> [--out DIR] [--rebuild] [--fetch GATEWAY] [--serve] [--tests] | pack <manifest> <outRoot> | pins <manifest>");
  return 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
