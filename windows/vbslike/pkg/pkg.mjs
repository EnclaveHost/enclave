#!/usr/bin/env node
// pkg.mjs -- the NucBox own-guest package (README.md): every byte the box needs to boot our guest and serve one small
// app, pinned by sha256 in ONE manifest, with where each byte comes from and how to make it again.
//
//   node windows/vbslike/pkg/pkg.mjs verify <manifest> [--out DIR] [--rebuild] [--fetch GATEWAY] [--serve]
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
//     observed is how package v1 came to expect "Hello World!" from an app that says "Hello World!\n".
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
  "control.datapath", "control.judge", "tool.windows",
  "input.vtl0-kernel-bzimage", "input.vtl0-vmlinux", "input.vtl2", "input.igvmfilegen", "input.igvm-manifest",
  "input.recipe", "input.tree"]);
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
// resolve every entry's bytes; derive entries after the entries they name. Box-only entries have no bytes here.
function resolveAll(m) {
  const all = [...m.files, ...m.inputs], byPath = new Map(m.files.map((f) => [f.path, f]));
  const bytes = new Map(), errors = new Map();
  const one = (e) => {
    if (bytes.has(e) || errors.has(e)) return bytes.get(e);
    const k = kindOf(e.from), v = e.from?.[k];
    try {
      let b = null;
      if (k === "git") b = gitBytes(v.commit, v.path);
      else if (k === "repo") b = fs.readFileSync(path.join(REPO, v));
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
    const r2 = spawnSync(gscript, [home(tree.from.dir), path.join(d, "vmlinux"), initrd, out, man],
                         { encoding: "utf8", env: { ...process.env, IGVMFILEGEN: home(ref(g.igvmfilegen).from.file) } });
    const gh = fs.existsSync(out) ? sha(fs.readFileSync(out)) : null, want = ref(`file:${g.output}`).sha256;
    R.add(r2.status === 0 && gh === want, "rebuild: the IGVM from its pinned inputs, on the rebuilt vmlinux",
          gh === want ? gh.slice(0, 16) : `exit ${r2.status}, got ${gh}: ${(r2.stderr || "").trim().split("\n").at(-1)}`);
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

export async function verify(manifestPath, { out = null, rebuild: doRebuild = false, fetchGw = null, serve = false } = {}) {
  const R = reporter();
  const mbytes = fs.readFileSync(manifestPath);
  let m; try { m = JSON.parse(mbytes.toString("utf8")); } catch (e) { R.add(false, "manifest is JSON", e.message); return { R, m: null, id: sha(mbytes) }; }
  if (!checkShape(m, R)) return { R, m, id: sha(mbytes) };
  const { bytes, errors } = resolveAll(m);
  for (const e of [...m.files, ...m.inputs]) {
    const id = e.path || e.name, k = kindOf(e.from);
    if (k === "box") { R.add(true, `source ${id}`, `box-only, pinned by observation on the box (${e.boxReuse}); not reproducible here`); continue; }
    if (k === "dir") { R.add(fs.existsSync(home(e.from.dir)), `source ${id}`, fs.existsSync(home(e.from.dir)) ? `tree at ${home(e.from.dir)}` : `no tree at ${e.from.dir}`); continue; }
    const b = bytes.get(e);
    if (!b) { R.add(false, `source ${id}`, errors.get(e) || "no bytes"); continue; }
    R.add(sha(b) === e.sha256 && b.length === e.bytes, `source ${id}`, sha(b) === e.sha256 && b.length === e.bytes ? `${k}` : `${k} gives ${sha(b)} (${b.length} B), pinned ${e.sha256} (${e.bytes} B)`);
  }
  await checkClaims(m, bytes, R);
  if (out) checkOut(m, mbytes, out, bytes, R);
  if (doRebuild) rebuild(m, bytes, R);
  if (fetchGw) await fetchCheck(m, fetchGw, R);
  if (serve) await serveCheck(m, bytes, R);
  return { R, m, id: sha(mbytes), bytes };
}

async function main(argv) {
  const [cmd, manifest, ...rest] = argv;
  const flag = (n) => rest.includes(n), val = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };
  if (cmd === "verify" && manifest) {
    const { R, id } = await verify(manifest, { out: val("--out"), rebuild: flag("--rebuild"), fetchGw: val("--fetch"), serve: flag("--serve") });
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
    const { bytes, errors } = resolveAll(m);
    for (const e of [...m.files, ...m.inputs]) {
      const b = bytes.get(e);
      console.log(`${b ? sha(b) : "-".repeat(64)} ${String(b ? b.length : "").padStart(10)} ${e.path || e.name}${errors.has(e) ? `  (${errors.get(e)})` : ""}`);
    }
    return 0;
  }
  console.error("usage: pkg.mjs verify <manifest> [--out DIR] [--rebuild] [--fetch GATEWAY] [--serve] | pack <manifest> <outRoot> | pins <manifest>");
  return 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
