// The launch measurement an attested release admits, PREDICTED by the relay from inputs neither the lease holder nor
// its guest supplies (docs/security/attested-release.md, "Measurements: predicted"). Nothing the host or the guest
// states is ever its own allowlist: the report's measurement is compared against this prediction, never added to it.
//
//   the deployment's catalog version, read from the chain here (cid, memMb, ports, approval, yanked, active)
//   -> the derivation record, by the supervisor's own rule (isolationPolicyFor / isolationHttpPortOf /
//      isolationDerivation), its runtimeId the PINNED release's own runtime.json
//   -> the component, fetched by CID and verified against it (guestd's fetcher: the platform's CAR verifier)
//   -> the bundle, by the catalog contract's reference implementation (derive_reference.py); AppID = sha256(bundle)
//   -> per ADMITTED domain release: expected-measurement.sh --pin <release id>, which verifies the release against
//      that id and reconstructs the guest image and its measurement
//
// The toolchain is ONE git commit, extracted from the object store into a private directory (git archive), so no
// working tree, untracked file or later edit is ever executed. The host tools it drives (python3, node, go, cpio,
// gzip, sev-snp-measure) are checked by a KNOWN-ANSWER test - the measurements of real M4a guests, VCEK-signed - before
// the first prediction and again every katEveryMs; a failing test disables prediction (every release refused) until a
// later test passes. A prediction that cannot be made is a refusal ({ ok: false }), never a pass.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
export const CATALOG_REF_RE = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d{1,9})$/;   // supervisor.js CATALOG_REF_RE

// ---- the supervisor's rule, at the toolchain commit (supervisor.js isolationPolicyFor / isolationHttpPortOf /
// isolationDerivation). Kept byte-compatible: a different policy or port is a different AppID and measurement. ----
export function isolationPolicyFor(version) {
  const mem = Math.max(128, Math.ceil(Number(version && version.memMb) || 0));
  return { cpuPercent: 100, memMiB: mem, vcpus: 1 };
}
export function isolationHttpPortOf(ports) {
  const list = (Array.isArray(ports) ? ports : String(ports || "").split(","))
    .map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return 0;
  const m = list.length === 1 ? /^http:(\d{1,5})$/.exec(list[0]) : null;
  const n = m ? Number(m[1]) : 0;
  if (!m || n < 1 || n > 49999)
    throw new Error(`the per-app guest tier serves at most one declared HTTP port (http:N); ${list.join(", ")} is not offered`);
  return n;
}
export function derivationRecord(catalogRef, version, runtimeId) {
  const m = CATALOG_REF_RE.exec(String(catalogRef || ""));
  if (!m) throw new Error("not a catalog://<app>/<index> reference");
  if (!/^[A-Za-z0-9]+$/.test(String(version.cid || ""))) throw new Error("the catalog version names no CID");
  if (!HEX(64).test(String(runtimeId || ""))) throw new Error("no runtime identity");
  const http = isolationHttpPortOf(version.ports);
  return { derivation: http ? "enclave-catalog-bundle/2" : "enclave-catalog-bundle/1",
           catalog: { app: m[1].toLowerCase(), version: Number(m[2]) }, cid: String(version.cid),
           policy: isolationPolicyFor(version), runtimeId, ...(http ? { http } : {}) };
}
// the supervisor's approvalVerdict: an approved, unyanked version of a listed app; a PENDING one only for a private
// deployment (forPrivate = !isPublic, as the supervisor runs it); a rejected one never
export function versionRefusal(app, v, forPrivate = false) {
  if (!app || !app.active) return "the app is not listed in the catalog";
  if (!v) return "the catalog has no such version";
  if (v.yanked) return "the version was yanked by its publisher";
  if (Number(v.approval) === 2) return "the version was rejected by the catalog owner";
  if (Number(v.approval) !== 1 && forPrivate !== true) return "the version is not approved (a pending version is released only to a private deployment)";
  return null;
}
// sha256 of the supervisor's three rule functions' source (isolationPolicyFor, isolationHttpPortOf, isolationDerivation),
// identical at 0181bce3 and c42612c0. test/measurement-predict.test.mjs fails when a supervisor this repository holds (or
// the working tree's) carries another rule, so the predictor is changed with it.
export const SUPERVISOR_RULE_SHA256 = "2ad995d42e42988151b95f0c1dd70c57130ed9f245d49da7167b6a076664796a";
export function supervisorRuleSha256(src) {
  const parts = ["isolationPolicyFor", "isolationHttpPortOf", "isolationDerivation"].map((n) => {
    const i = src.indexOf(`function ${n}(`);
    if (i < 0) return null;
    return src.slice(i, src.indexOf("\n}\n", i) + 2);
  });
  return parts.some((p) => p === null) ? null : sha256hex(parts.join("\n"));
}
// canonical JSON (keys sorted at every level, no whitespace): contract.Canonical / the record digest
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
// RuntimeID = sha256(canonical JSON of the runtime identity) (isolation/contract/runtime.go RuntimeID)
export const runtimeIdOfJson = (text) => sha256hex(canonical(JSON.parse(text)));

// ---- KNOWN ANSWERS: real M4a guests on the isolation host, their measurement and AppID read from chip-signed reports
// (docs/security/measurement-prediction/). Each names the release it was built from and the full derivation record. ----
export const KNOWN_ANSWERS = Object.freeze([
  { what: "guest gdb677d751, deployment 0x0ddbd824…2e76 (VCEK-signed report 2026-09-24)",
    release: "5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2",
    record: { derivation: "enclave-catalog-bundle/2", catalog: { app: "0xf7e65a8fdae1dd9f8c2a897f2f372cdb7f6150d1e20526fa06d10a682cc2e9e3", version: 4 },
              cid: "bafkreidocbixnql7lroykdtwx4r2fmi5n6sra4lj7b7vhscsfqn4gctlee", http: 8000,
              policy: { cpuPercent: 100, memMiB: 256, vcpus: 1 }, runtimeId: "ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8" },
    appId: "d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24",
    measurement: "be6b8644384eee12396881e3e4cbca4259ae1a16a1e198d2c48d577ff7b3c6d355971eccebe8353749439adca718da4d" },
  { what: "guests gd6e734a97 and gdebc9c709, deployments 0x395bed3e…1595 and 0x4e62e60d…6c1e (VCEK-signed reports 2026-09-24)",
    release: "6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb",
    record: { derivation: "enclave-catalog-bundle/1", catalog: { app: "0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed", version: 4 },
              cid: "bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza",
              policy: { cpuPercent: 100, memMiB: 128, vcpus: 1 }, runtimeId: "ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8" },
    appId: "9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45",
    measurement: "c068f423578cda6316fd9462db6b5e9047bd34d6e2c0ae3b0819828e8db78831bd76bdb27092efefe380713662815f9e" },
]);

// the sha256 a raw-codec CIDv1 (bafkrei…) names, or null for any other CID (those are fetched and CAR-verified every time)
export function rawCidDigest(cid) {
  const m = /^b([a-z2-7]+)$/.exec(String(cid || ""));
  if (!m) return null;
  const A = "abcdefghijklmnopqrstuvwxyz234567"; let bits = 0, v = 0; const out = [];
  for (const ch of m[1]) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 0xff); bits -= 8; } }
  const b = Buffer.from(out);
  return b.length === 36 && b[0] === 0x01 && b[1] === 0x55 && b[2] === 0x12 && b[3] === 0x20 ? b.subarray(4).toString("hex") : null;
}

// the toolchain paths a prediction executes or imports, extracted from the pinned commit and nothing else
export const TOOLCHAIN_PATHS = ["isolation/m4/expected-measurement.sh", "isolation/m4/release-manifest.py",
  "isolation/m4/verifying-firmware.txt", "isolation/m4/assemble-app-image.sh", "isolation/m4/pack-initrd.sh",
  "isolation/m4/guestd/fetch-cid.py", "isolation/contract", "wasm/ipfs_fetch.py"];

// the digest a pinned sev-snp-measure is checked against: its entry script and every file of the sevsnpmeasure package
// it imports (found by the entry script's own interpreter), as sha256 over "relpath NUL sha256 LF" lines, sorted
export async function sevSnpMeasureDigest(exe, run = runBounded) {
  const entry = fs.realpathSync(exe), text = fs.readFileSync(entry);
  const m = /^#!\s*(\S+)/.exec(text.toString("utf8", 0, 512));
  if (!m) throw new Error(`${exe} is not a script with an interpreter line`);
  const r = await run(m[1], ["-c", "import os, sevsnpmeasure; print(os.path.dirname(os.path.realpath(sevsnpmeasure.__file__)))"],
    { env: { PATH: process.env.PATH || "/usr/bin:/bin" }, timeoutMs: 30_000 });
  const dir = r.out.trim();
  if (r.code !== 0 || !dir) throw new Error(`the sevsnpmeasure package of ${exe} is not importable`);
  const lines = [`entry\0${sha256hex(text)}\n`];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name === "__pycache__") continue;
    const p = path.join(d, e.name), q = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(p, q); else if (e.isFile()) lines.push(`${q}\0${sha256hex(fs.readFileSync(p))}\n`);
  } };
  walk(dir, "");
  return sha256hex(lines.join(""));
}

// one child process: bounded time (the whole process group is killed), bounded output, a minimal environment
export function runBounded(cmd, args, { env, cwd, timeoutMs, input }) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    const cap = 1 << 16;
    const p = spawn(cmd, args, { env, cwd, detached: true, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const kill = () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { if (!done) { err += `\n[timed out after ${timeoutMs} ms]`; kill(); } }, timeoutMs);
    p.stdout.on("data", (d) => { if (out.length < cap) out += d; });
    p.stderr.on("data", (d) => { if (err.length < cap) err += d; });
    if (input) p.stdin.end(input);
    p.on("error", (e) => { err += String(e.message); });
    p.on("close", (code) => { done = true; clearTimeout(timer); kill(); resolve({ code: code ?? -1, out, err }); });
  });
}

// makePredictor: the relay's side. Every option is explicit except the bounds.
//   repo, commit         the toolchain: a git repository holding the 40-hex `commit`
//   releases             [{ id, dir }]: every installed domain release (the known answers' included)
//   admit                [id]: the releases whose images a release admits (a subset of `releases`)
//   readCatalog          async (app, index) -> { app: { active }, version: { cid, memMb, ports, approval, yanked } }
//   gateway              the trustless gateway the CAR is fetched from (availability only: every block is verified)
//   sevSnpMeasure        the pinned sev-snp-measure executable (expected-measurement.sh runs ~/.local/bin/sev-snp-measure)
//   sevSnpMeasureSha256  its sevSnpMeasureDigest, checked before the toolchain is used
//   work                 a private directory (created 0700)
//   components           (optional) where verified raw-CID components are kept; each is re-verified against its CID on read
export function makePredictor(o) {
  const { repo, commit, readCatalog, gateway, sevSnpMeasure, sevSnpMeasureSha256 } = o;
  const digestTool = o.digestTool || ((exe) => sevSnpMeasureDigest(exe, run));
  const work = o.work ? path.resolve(o.work) : "";
  const run = o.run || runBounded, now = o.now || Date.now;
  const knownAnswers = o.knownAnswers || KNOWN_ANSWERS;
  const concurrency = o.concurrency ?? 1, maxQueue = o.maxQueue ?? 4, timeoutMs = o.timeoutMs ?? 240_000;
  const cacheMax = o.cacheMax ?? 256, negativeTtlMs = o.negativeTtlMs ?? 60_000, katEveryMs = o.katEveryMs ?? 6 * 3600_000;
  const inconclusiveMaxMs = o.inconclusiveMaxMs ?? 24 * 3600_000;   // how long a pass survives inconclusive re-tests
  const maxComponentBytes = o.maxComponentBytes ?? 256 << 20;
  const components = o.components || (work && path.join(work, "components"));
  const releases = new Map((o.releases || []).map((r) => [String(r.id).toLowerCase(), r.dir]));
  const admit = [...new Set((o.admit || []).map((s) => String(s).toLowerCase()))];
  // the releases a guest CERTIFICATE may be judged against (GET /v1/expected-guest): the release's set plus the legacy
  // images deployments still run; never used by the release itself
  const certAdmit = [...new Set([...admit, ...(o.certAdmit || []).map((s) => String(s).toLowerCase())])];
  const problems = [
    !HEX(40).test(String(commit || "")) && "the toolchain commit (40 hex)",
    !repo && "the toolchain repository", typeof readCatalog !== "function" && "the catalog reader",
    !/^https:\/\//.test(String(gateway || "")) && "an https gateway", !sevSnpMeasure && "sev-snp-measure",
    !HEX(64).test(String(sevSnpMeasureSha256 || "")) && "sev-snp-measure's pinned digest", !work && "a work directory",
    !admit.length && "at least one admitted release",
    ...certAdmit.filter((id) => !HEX(64).test(id) || !releases.has(id)).map((id) => `admitted release ${id.slice(0, 12)} installed`),
  ].filter(Boolean);

  const cache = new Map();          // key -> { at, value } (LRU by insertion order)
  const inflight = new Map();       // key -> Promise
  let active = 0; const queue = [];
  let toolchain = null;             // { dir, env } once extracted
  let kat = { ok: false, at: 0, tried: 0, reason: "the known-answer test has not run", running: null };
  const stats = { predictions: 0, cacheHits: 0, refusals: 0, busy: 0 };

  // a slot: `concurrency` reconstructions at once, at most `maxQueue` waiting; the known-answer test always queues
  const slot = (always = false) => new Promise((resolve, reject) => {
    if (active < concurrency) { active++; return resolve(); }
    if (!always && queue.length >= maxQueue) return reject(Object.assign(new Error("the predictor is busy"), { busy: true }));
    queue.push(resolve);
  });
  const unslot = () => { const next = queue.shift(); if (next) next(); else active--; };

  async function prepare() {
    // the pinned sev-snp-measure, every time the toolchain MEASURES: the known-answer test catches a broken tool, this a changed one
    let got;
    try { got = await digestTool(sevSnpMeasure); } catch (e) { throw new Error(`sev-snp-measure: ${e.message}`); }
    if (got !== sevSnpMeasureSha256) throw new Error(`sev-snp-measure's digest ${String(got).slice(0, 12)} is not the pinned ${String(sevSnpMeasureSha256).slice(0, 12)}`);
    return extract();
  }
  async function extract() {
    if (toolchain) return toolchain;
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    fs.chmodSync(work, 0o700);
    const dir = path.join(work, `toolchain-${commit}`), tmp = `${dir}.${randomBytes(6).toString("hex")}`;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(tmp, { mode: 0o700 });
      // the commit's own objects, never the working tree: `git archive <commit> <paths>` | tar -x
      const got = await new Promise((resolve) => execFile("git", ["-C", repo, "archive", "--format=tar", commit, "--", ...TOOLCHAIN_PATHS],
        { encoding: "buffer", maxBuffer: 64 << 20, timeout: 60_000 }, (e, stdout) => resolve(e ? { e } : { tar: stdout })));
      if (got.e) throw new Error(`the toolchain commit ${commit.slice(0, 12)} is not extractable from ${repo}: ${String(got.e.message).split("\n")[0]}`);
      const x = await run("tar", ["-x", "-C", tmp], { env: { PATH: process.env.PATH }, timeoutMs: 60_000, input: got.tar });
      if (x.code !== 0) throw new Error(`extracting the toolchain: ${x.err.trim().slice(-200)}`);
      fs.renameSync(tmp, dir);
    }
    const home = path.join(work, "home");
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true, mode: 0o700 });
    const link = path.join(home, ".local", "bin", "sev-snp-measure");
    try { fs.unlinkSync(link); } catch {}
    fs.symlinkSync(path.resolve(sevSnpMeasure), link);
    for (const d of ["tmp", "gocache", "gopath"]) fs.mkdirSync(path.join(work, d), { recursive: true, mode: 0o700 });
    const env = { PATH: `${path.dirname(process.execPath)}:${process.env.PATH || "/usr/bin:/bin"}`, HOME: home,
                  TMPDIR: path.join(work, "tmp"), GOCACHE: path.join(work, "gocache"), GOPATH: path.join(work, "gopath"),
                  GOTOOLCHAIN: "local", GOPROXY: "off", GOFLAGS: "-mod=readonly", LC_ALL: "C" };
    toolchain = { dir, env };
    return toolchain;
  }

  // one reconstruction: the component (fetched ONCE, verified by its CID) -> per record, the bundle -> per release, the
  // measurement. `records` are one catalog version's, one per admitted runtime: [{ record, ids: [release id] }].
  async function reconstruct(records) {
    const tc = await prepare();
    const job = fs.mkdtempSync(path.join(work, "tmp", "job-"));
    try {
      const cid = records[0].record.cid, comp = path.join(job, "component");
      if (records.some((r) => r.record.cid !== cid)) return { ok: false, code: "prediction_failed", reason: "records of one version name two CIDs" };
      // a raw-CID component already held is used only if it still hashes to its CID; anything else is fetched and verified
      const digest = rawCidDigest(cid), kept = digest && path.join(components, cid);
      let held = null;
      try { const b = fs.readFileSync(kept); if (b.length <= maxComponentBytes && sha256hex(b) === digest) held = b; } catch {}
      if (held) fs.writeFileSync(comp, held);
      else {
        const f = await run("python3", [path.join(tc.dir, "isolation/m4/guestd/fetch-cid.py"), tc.dir, cid, comp, String(maxComponentBytes), gateway],
          { env: tc.env, cwd: job, timeoutMs });
        if (f.code !== 0) return { ok: false, code: "component_unavailable", reason: `the component ${cid} did not fetch and verify: ${lastLine(f.err)}` };
        if (digest) {
          try {
            const b = fs.readFileSync(comp);
            if (sha256hex(b) === digest) {
              fs.mkdirSync(components, { recursive: true, mode: 0o700 });
              const tmp = `${kept}.${randomBytes(6).toString("hex")}`; fs.writeFileSync(tmp, b, { mode: 0o600 }); fs.renameSync(tmp, kept);
            }
          } catch {}
        }
      }
      const images = []; let appId = null;
      for (const [n, { record, ids }] of records.entries()) {
        const recFile = path.join(job, `record-${n}.json`), bundle = path.join(job, `app-${n}.bundle`);
        fs.writeFileSync(recFile, JSON.stringify(record));
        const d = await run("python3", [path.join(tc.dir, "isolation/contract/catalog/derive_reference.py"), "bundle", recFile, comp, bundle],
          { env: tc.env, cwd: job, timeoutMs });
        if (d.code !== 0) return { ok: false, code: "underivable", reason: `the catalog version derives no bundle: ${lastLine(d.err)}` };
        const got = sha256hex(fs.readFileSync(bundle));
        let stated = null; try { stated = JSON.parse(d.out).appId; } catch {}
        if (stated !== got) return { ok: false, code: "prediction_failed", reason: "the derivation's stated AppID is not sha256(bundle)" };
        if (appId && appId !== got) return { ok: false, code: "prediction_failed", reason: "two runtimes derived two AppIDs" };
        appId = got;
        const r = await measure(tc, job, record, bundle, appId, ids);
        if (!r.ok) return r;
        images.push(...r.images);
      }
      return { ok: true, appId, images };
    } finally { fs.rmSync(job, { recursive: true, force: true }); }
  }
  async function measure(tc, job, record, bundle, appId, releaseIds) {
    const images = [];
    for (const id of releaseIds) {
      // an owner-writable snapshot of the release in the private job directory: an installed release may be read-only, and
      // expected-measurement.sh copies it with `cp -a` and removes its copy on exit (a read-only copy fails that and the
      // run). The manifest pins contents, not modes, and the script verifies the snapshot against the pinned id.
      const snap = path.join(job, `release-${id.slice(0, 16)}`);
      try { snapshotRelease(releases.get(id), snap); }
      catch (e) { return { ok: false, code: "prediction_unavailable", reason: `release ${id.slice(0, 12)} could not be read: ${e.message}` }; }
      const e = await run("sh", [path.join(tc.dir, "isolation/m4/expected-measurement.sh"), "--pin", id, snap, bundle, String(record.policy.vcpus)],
        { env: tc.env, cwd: job, timeoutMs });
      const kv = Object.fromEntries(e.out.split("\n").map((l) => [l.slice(0, l.indexOf(" ")), l.slice(l.indexOf(" ") + 1).trim()]));
      if (e.code !== 0 || kv.release !== id || !HEX(96).test(kv.measurement || "")) {
        return { ok: false, code: "prediction_failed", reason: `release ${id.slice(0, 12)}: ${lastLine(e.err) || "no measurement"}` };
      }
      if (kv.app_id !== appId) return { ok: false, code: "prediction_failed", reason: `release ${id.slice(0, 12)} assembled another AppID` };
      // the VERIFIED release's runtime is the one the record was derived for (read before the release was verified)
      if (kv.runtime_id !== record.runtimeId) return { ok: false, code: "prediction_failed", reason: `release ${id.slice(0, 12)}'s verified runtime is not the record's` };
      images.push({ release: id, runtimeId: kv.runtime_id, measurement: kv.measurement });
    }
    return { ok: true, images };
  }

  // the known-answer test: every vector whose release is installed must reproduce exactly, and at least one must run.
  // A component the gateway cannot serve makes the test INCONCLUSIVE: the previous verdict stands (never a first pass).
  async function selfTest() {
    if (kat.running) return kat.running;
    kat.running = (async () => {
      let ran = 0, why = null, inconclusive = null;
      try {
        await slot(true);
        try {
          for (const k of knownAnswers) {
            if (!releases.has(k.release)) continue;
            ran++;
            const r = await reconstruct([{ record: k.record, ids: [k.release] }]);
            if (!r.ok && r.code === "component_unavailable") { inconclusive = r.reason; break; }
            if (!r.ok) { why = `known answer (${k.what}): ${r.reason}`; break; }
            if (r.appId !== k.appId) { why = `known answer (${k.what}): AppID ${r.appId.slice(0, 12)} is not ${k.appId.slice(0, 12)}`; break; }
            if (r.images[0].measurement !== k.measurement) { why = `known answer (${k.what}): measurement ${r.images[0].measurement.slice(0, 12)} is not ${k.measurement.slice(0, 12)}`; break; }
          }
        } finally { unslot(); }
        if (!why && !inconclusive && !ran) why = "no known answer's release is installed, so the toolchain is unchecked";
      } catch (e) { why = `the known-answer test did not run: ${e.message}`; }
      if (inconclusive && !why) {
        if (!kat.ok || now() - kat.at <= inconclusiveMaxMs) {
          kat = { ...kat, at: kat.ok ? kat.at : now(), tried: now(), reason: kat.ok ? kat.reason : `the known-answer test was inconclusive: ${inconclusive}`, running: null };
          return kat;
        }
        why = `the last passing known-answer test is older than ${Math.round(inconclusiveMaxMs / 3600_000)} h and re-tests are inconclusive: ${inconclusive}`;
      }
      kat = { ok: !why, at: now(), tried: now(), reason: why || `${ran} known answer(s) reproduced exactly`, running: null };
      if (!kat.ok) { cache.clear(); console.error(`[measurement-predict] DISABLED: ${kat.reason}`); }
      return kat;
    })();
    return kat.running;
  }

  function cacheGet(key) {
    const e = cache.get(key);
    if (!e) return null;
    if (!e.value.ok && now() - e.at > negativeTtlMs) { cache.delete(key); return null; }
    cache.delete(key); cache.set(key, e);   // refresh LRU position
    return e.value;
  }
  function cachePut(key, value) {
    if (value.code === "busy") return;       // availability, not an answer
    cache.set(key, { at: now(), value });
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value);
  }

  // the expected guest for a deployment's catalog reference: { ok, appId, images: [{ release, runtimeId, measurement }] }
  // or { ok: false, code, reason }. Never throws. `forPrivate`: the deployment is private (a pending version is allowed).
  // `waitMs`: answer { ok: false, code: "warming" } rather than wait longer; the prediction continues and is cached.
  async function expectedFor(catalogRef, { forPrivate = false, waitMs, set = "release" } = {}) {
    const ids = set === "cert" ? certAdmit : set === "release" ? admit : null;
    if (!ids) return { ok: false, code: "predictor_unconfigured", reason: `no admitted set named ${set}` };
    const p = predict(catalogRef, forPrivate, ids);
    if (!(waitMs >= 0)) return p;
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, code: "warming", reason: "the prediction is still being computed; retry shortly" }), waitMs); });
    try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
  }
  async function predict(catalogRef, forPrivate, admitIds) {
    const refuse = (code, reason) => { stats.refusals++; return { ok: false, code, reason }; };
    if (problems.length) return refuse("predictor_unconfigured", `measurement prediction is not configured (missing: ${problems.join(", ")})`);
    const m = CATALOG_REF_RE.exec(String(catalogRef || ""));
    if (!m) return refuse("not_catalog", "the deployment does not run a catalog://<app>/<index> version");
    // a passing test that has aged re-runs in the background; a failing one re-runs at most every negativeTtlMs
    if (kat.ok && now() - kat.at > katEveryMs && now() - (kat.tried || 0) > negativeTtlMs) selfTest();
    else if (!kat.ok && (!kat.tried || now() - kat.tried > negativeTtlMs)) await selfTest();
    if (!kat.ok) return refuse("prediction_unavailable", `measurement prediction is disabled: ${kat.reason}`);
    let cat;
    try { cat = await readCatalog(m[1].toLowerCase(), Number(m[2])); }
    catch (e) { return refuse("catalog_unreachable", `the catalog version could not be read: ${e.shortMessage || e.message}`); }
    const vr = versionRefusal(cat && cat.app, cat && cat.version, forPrivate);
    if (vr) return refuse("version_not_admitted", vr);
    // one record per distinct runtime among the admitted releases (the AppID excludes the runtime; the record does not)
    const byRuntime = new Map();
    for (const id of admitIds) {
      let rid;
      try { rid = runtimeIdOfJson(fs.readFileSync(path.join(releases.get(id), "template/rt/runtime.json"), "utf8")); }
      catch (e) { return refuse("prediction_unavailable", `release ${id.slice(0, 12)} states no readable runtime identity`); }
      if (!byRuntime.has(rid)) byRuntime.set(rid, []);
      byRuntime.get(rid).push(id);
    }
    let records;
    try { records = [...byRuntime].map(([rid, ids]) => ({ record: derivationRecord(catalogRef, cat.version, rid), ids })); }
    catch (e) { return refuse("version_not_admitted", `the version is not derivable for a per-app guest: ${e.message}`); }
    const key = sha256hex(canonical({ commit, records: records.map((r) => ({ record: r.record, releases: [...r.ids].sort() })) }));
    const hit = cacheGet(key);
    if (hit) { stats.cacheHits++; return hit.ok ? hit : refuse(hit.code, hit.reason); }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try { await slot(); } catch { stats.busy++; return refuse("busy", "the measurement predictor is busy; retry shortly"); }
      let value;
      try {
        const got = await reconstruct(records);
        value = got.ok ? { ok: true, appId: got.appId, images: got.images, catalogRef: catalogRef.toLowerCase() } : got;
      } catch (e) { value = { ok: false, code: "prediction_failed", reason: e.message }; }
      finally { unslot(); }
      stats.predictions++;
      cachePut(key, value);
      return value.ok ? value : refuse(value.code, value.reason);
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // the bytes a CID names, fetched and VERIFIED against it by the platform's own fetcher (guestd's fetch-cid.py ->
  // wasm/ipfs_fetch.py, from the pinned toolchain), or a refusal. For a config CID (the release's resolveConfigCid); raw-CID
  // answers are kept like components (re-verified on every read). Not gated on the known-answer test: it measures nothing.
  async function fetchVerified(cid, maxBytes = 1 << 20) {
    if (!/^[A-Za-z0-9]{10,100}$/.test(String(cid || ""))) return { ok: false, code: "bad_cid", reason: "not a CID" };
    const digest = rawCidDigest(cid), kept = digest && components && path.join(components, cid);
    try { const b = fs.readFileSync(kept); if (b.length <= maxBytes && sha256hex(b) === digest) return { ok: true, bytes: b }; } catch {}
    let tc;
    try { tc = await extract(); } catch (e) { return { ok: false, code: "unavailable", reason: e.message }; }
    fs.mkdirSync(path.join(work, "tmp"), { recursive: true, mode: 0o700 });
    const job = fs.mkdtempSync(path.join(work, "tmp", "cid-"));
    try {
      const out = path.join(job, "bytes");
      const f = await run("python3", [path.join(tc.dir, "isolation/m4/guestd/fetch-cid.py"), tc.dir, cid, out, String(maxBytes), gateway], { env: tc.env, cwd: job, timeoutMs });
      if (f.code !== 0) return { ok: false, code: "unavailable", reason: `${cid} did not fetch and verify: ${lastLine(f.err)}` };
      const b = fs.readFileSync(out);
      if (digest && sha256hex(b) === digest) {
        try { fs.mkdirSync(components, { recursive: true, mode: 0o700 }); const tmp = `${kept}.${randomBytes(6).toString("hex")}`; fs.writeFileSync(tmp, b, { mode: 0o600 }); fs.renameSync(tmp, kept); } catch {}
      }
      return { ok: true, bytes: b };
    } finally { fs.rmSync(job, { recursive: true, force: true }); }
  }

  return { expectedFor, selfTest, fetchVerified, problems, sets: { release: admit, cert: certAdmit }, state: () => ({ kat: { ok: kat.ok, at: kat.at, reason: kat.reason }, toolchain: toolchain && toolchain.dir,
                                                         active, queued: queue.length, cached: cache.size, ...stats }) };
}

// copy a release directory tree (regular files and directories only; anything else is left for the manifest check to refuse)
// with the owner's write bit added, so every copy made from it can be removed again
function snapshotRelease(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { mode: (st.mode & 0o777) | 0o700 });
    for (const e of fs.readdirSync(src)) snapshotRelease(path.join(src, e), path.join(dst, e));
  } else if (st.isFile()) {
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, (st.mode & 0o777) | 0o200);
  } else if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dst);   // copied as a link: release-manifest.py refuses it, as for the original
  }
}

const lastLine = (s) => String(s || "").trim().split("\n").filter(Boolean).slice(-1)[0] || "";

// the catalog reader over a viem public client: the address book's appCatalog, getApp + getVersion (supervisor.js
// CATALOG_ABI). A version record is immutable except approval / yanked / the app's listing, which are read live.
const APP_T = [["appId", "bytes32"], ["publisher", "address"], ["slug", "string"], ["name", "string"], ["description", "string"],
  ["versionCount", "uint32"], ["createdAt", "uint64"], ["updatedAt", "uint64"], ["active", "bool"]];
const VER_T = [["cid", "string"], ["version", "string"], ["vramMb", "uint32"], ["gpuGflops", "uint32"], ["memMb", "uint32"],
  ["cpuGflops", "uint32"], ["createdAt", "uint64"], ["verified", "bool"], ["yanked", "bool"], ["ports", "string"],
  ["approval", "uint8"], ["config", "string"]];
const tuple = (t) => ({ type: "tuple", components: t.map(([name, type]) => ({ name, type })) });
export const CATALOG_READ_ABI = [
  { type: "function", name: "getApp", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }], outputs: [tuple(APP_T)] },
  { type: "function", name: "getVersion", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }, { name: "index", type: "uint256" }], outputs: [tuple(VER_T)] },
];
// `clients`: one client, or several INDEPENDENT ones (enclave-d1): every one is read and all must agree, so one lying RPC
// cannot make the relay predict another app; a disagreement is an unreachable catalog (503), never a pick.
export function catalogReader(clients, catalogAddress) {
  const list = Array.isArray(clients) ? clients : [clients];
  const readOne = async (client, address, app, index) => {
    const a = await client.readContract({ address, abi: CATALOG_READ_ABI, functionName: "getApp", args: [app] });
    if (!a || /^0x0{64}$/.test(a.appId) || index >= Number(a.versionCount)) return { app: a && { active: !!a.active }, version: null };
    const v = await client.readContract({ address, abi: CATALOG_READ_ABI, functionName: "getVersion", args: [app, BigInt(index)] });
    return { app: { active: !!a.active }, version: { cid: v.cid, memMb: Number(v.memMb), ports: v.ports, approval: Number(v.approval), yanked: !!v.yanked } };
  };
  const read = async (app, index) => {
    const address = typeof catalogAddress === "function" ? await catalogAddress() : catalogAddress;
    // each provider gets one retry for a transient failure; a provider that still fails fails the read (all must answer)
    const once = async (c) => { try { return await readOne(c, address, app, index); } catch { await new Promise((r) => setTimeout(r, 500)); return readOne(c, address, app, index); } };
    const got = await Promise.all(list.map(once));
    if (got.some((g) => canonical(g) !== canonical(got[0]))) throw new Error(`the ${list.length} catalog RPCs disagree about ${app}/${index}`);
    return got[0];
  };
  read.sources = list.length;
  return read;
}

// the catalog VERSION's config as the chain states it, through the same agreeing clients: the inline `config` field and, on
// catalog rev >= 7, versionConfigCid (a revert there means "no such field on this catalog", i.e. ""). { config, configCid }.
const CONFIG_CID_ABI = [{ type: "function", name: "versionConfigCid", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [{ type: "string" }] }];
export function versionConfigReader(clients, catalogAddress) {
  const list = Array.isArray(clients) ? clients : [clients];
  const readOne = async (client, address, app, index) => {
    const v = await client.readContract({ address, abi: CATALOG_READ_ABI, functionName: "getVersion", args: [app, BigInt(index)] });
    let configCid = "";
    try { configCid = await client.readContract({ address, abi: CONFIG_CID_ABI, functionName: "versionConfigCid", args: [app, BigInt(index)] }) || ""; }
    catch (e) { if (!/revert/i.test(e && (e.shortMessage || e.message) || "")) throw e; }
    return { config: String(v.config || ""), configCid: String(configCid) };
  };
  return async (app, index) => {
    const address = typeof catalogAddress === "function" ? await catalogAddress() : catalogAddress;
    const got = await Promise.all(list.map((c) => readOne(c, address, app, index)));
    if (got.some((g) => canonical(g) !== canonical(got[0]))) throw new Error(`the ${list.length} catalog RPCs disagree about ${app}/${index}'s config`);
    return got[0];
  };
}

// configuration from the environment (all required when attested release is on; see attested-release.md)
//   SECRETS_RELEASE_PREDICT_REPO       a git repository holding the toolchain commit (a clone of the public repo)
//   SECRETS_RELEASE_PREDICT_COMMIT     the toolchain commit, 40 hex
//   SECRETS_RELEASE_PREDICT_RELEASES   id=dir,id=dir: every installed domain release (the known answers' included)
//   SECRETS_RELEASE_DOMAIN_RELEASES    id,id: the releases whose images a release admits
//   SECRETS_RELEASE_CERT_RELEASES      id,id: ADDITIONAL releases a guest certificate may be judged against (legacy images
//                                      deployments still run); /v1/expected-guest predicts over both sets
//   SECRETS_RELEASE_PREDICT_GATEWAY    https trustless gateway
//   SECRETS_RELEASE_SEV_SNP_MEASURE    the pinned sev-snp-measure executable
//   SECRETS_RELEASE_SEV_SNP_MEASURE_SHA256  its sevSnpMeasureDigest (node relay/measurement-predict.mjs digest <exe> prints it)
//   SECRETS_RELEASE_CATALOG_RPCS       two or more independent Base RPC URLs for the catalog read (api-relay.js)
//   SECRETS_RELEASE_PREDICT_WORK       private work directory
export function predictorEnv(env = process.env) {
  const releases = String(env.SECRETS_RELEASE_PREDICT_RELEASES || "").split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => { const i = s.indexOf("="); return { id: s.slice(0, i).toLowerCase(), dir: s.slice(i + 1) }; })
    .filter((r) => HEX(64).test(r.id) && r.dir);
  return { repo: env.SECRETS_RELEASE_PREDICT_REPO || "", commit: String(env.SECRETS_RELEASE_PREDICT_COMMIT || "").toLowerCase(),
           releases, admit: String(env.SECRETS_RELEASE_DOMAIN_RELEASES || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
           certAdmit: String(env.SECRETS_RELEASE_CERT_RELEASES || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
           gateway: env.SECRETS_RELEASE_PREDICT_GATEWAY || "", sevSnpMeasure: env.SECRETS_RELEASE_SEV_SNP_MEASURE || "",
           sevSnpMeasureSha256: String(env.SECRETS_RELEASE_SEV_SNP_MEASURE_SHA256 || "").toLowerCase(),
           work: env.SECRETS_RELEASE_PREDICT_WORK || "" };
}

// node relay/measurement-predict.mjs digest <sev-snp-measure>: the value SECRETS_RELEASE_SEV_SNP_MEASURE_SHA256 pins
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname && process.argv[2] === "digest") {
  sevSnpMeasureDigest(process.argv[3]).then((d) => console.log(d), (e) => { console.error(e.message); process.exit(1); });
}
