// pkg.test.mjs -- the package verifier (pkg.mjs) held to its claims: each mutation below breaks ONE claim, on a copy,
// and verify must FAIL at the check that covers it; the unmutated manifest and packed directory must PASS. Several
// mutations are CONSISTENT forgeries -- the edited entry re-pinned to the bytes it now has -- so they must fail at the
// claim, not merely at a hash. Needs this host's sources (~/enclave-bench/ownguest-pkg/sources); skips without them.
//   node --test windows/vbslike/pkg/pkg.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, "pkg.mjs");
const MANIFEST = path.join(HERE, "manifests/nucbox-ownguest-5.json");        // the latest; older ones are kept below as refusals
const V4 = path.join(HERE, "manifests/nucbox-ownguest-4.json");
const V1 = path.join(HERE, "manifests/nucbox-ownguest-1.json");
const V3 = path.join(HERE, "manifests/nucbox-ownguest-3.json");
const SOURCES = path.join(os.homedir(), "enclave-bench/ownguest-pkg/sources");
const WORK = path.join(os.homedir(), "enclave-bench/ownguest-pkg/test-work");   // the IGVM is 125 MB: not a tmpfs
const have = fs.existsSync(path.join(SOURCES, "guest/openhcl-ownguest-4610d594.bin"));
const haveWasmtime = spawnSync("wasmtime", ["--version"]).status === 0;
const skip = !have && "no local sources";
const base = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

const run = (args) => { const r = spawnSync(process.execPath, [PKG, ...args], { encoding: "utf8", timeout: 300000 }); return { code: r.status, out: r.stdout + r.stderr }; };
const fails = (out) => out.split("\n").filter((l) => l.startsWith("FAIL")).join("\n");
let n = 0;
function writeManifest(m) { const p = path.join(WORK, `m-${process.pid}-${n++}.json`); fs.writeFileSync(p, JSON.stringify(m, null, 1) + "\n"); return p; }
// re-pin the named entries to what their sources now give: a consistent forgery
function repin(m, ids) {
  const r = run(["pins", writeManifest(m)]);
  for (const l of r.out.split("\n").filter(Boolean)) {
    const [h, b, id] = l.trim().split(/\s+/);
    if (!ids.includes(id)) continue;
    const e = m.files.find((f) => f.path === id) || m.inputs.find((i) => i.name === id);
    e.sha256 = h; e.bytes = Number(b);
  }
  return m;
}
const file = (m, p) => m.files.find((f) => f.path === p);
const app = (m, name) => m.apps.find((a) => a.name === name);
const H = "apps/hello-world-1.0.4";

let packed = null;
before(() => {
  if (!have) return;
  fs.mkdirSync(WORK, { recursive: true });
  const root = fs.mkdtempSync(path.join(WORK, "pack-"));
  const r = run(["pack", MANIFEST, root]);
  assert.equal(r.code, 0, r.out);
  packed = path.join(root, fs.readdirSync(root)[0]);
});
after(() => { if (fs.existsSync(WORK)) fs.rmSync(WORK, { recursive: true, force: true }); });

test("control: the committed manifest verifies", { skip }, () => {
  const r = run(["verify", MANIFEST]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /^PASS package [0-9a-f]{64}$/m);
});
test("control: the packed directory verifies", { skip }, () => {
  const r = run(["verify", MANIFEST, "--out", packed]);
  assert.equal(r.code, 0, fails(r.out));
});

const MANIFEST_CASES = [
  ["another AppID for hello-world", (m) => { app(m, "hello-world").appId = "ab".repeat(32); }, /FAIL hello-world 1\.0\.4: the derived bundle hashes to the AppID/],
  ["hello-world named by hookbin's CID", (m) => { app(m, "hello-world").cid = app(m, "hookbin").cid; }, /FAIL hello-world 1\.0\.4: the component is the content its CID names/],
  ["the record edited but not re-pinned", (m) => { file(m, `${H}/record.json`).from.canonical.runtimeId = "cd".repeat(32); }, /FAIL source apps\/hello-world-1\.0\.4\/record\.json/],
  ["the record re-pinned to another runtime (consistent forgery)", (m) => {
     file(m, `${H}/record.json`).from.canonical.runtimeId = "cd".repeat(32); repin(m, [`${H}/record.json`, `${H}/app.bundle`]);
     app(m, "hello-world").recordSha256 = file(m, `${H}/record.json`).sha256; },
   /FAIL hello-world 1\.0\.4: the record names this CID, derivation, catalog version and the guest's runtime/],
  ["the spawn request re-pinned with another policy (consistent forgery)", (m) => {
     file(m, `${H}/spawn.json`).from.canonical.derive = { ...file(m, `${H}/spawn.json`).from.canonical.derive, policy: { cpuPercent: 100, memMiB: 256, vcpus: 1 } };
     repin(m, [`${H}/spawn.json`]); }, /FAIL hello-world 1\.0\.4: the spawn request carries exactly this record/],
  ["the runtime identity says another runtimeId", (m) => { m.runtime.runtimeId = "ef".repeat(32); }, /FAIL runtime identity recomputes to the runtimeId/],
  ["the IGVM pinned to other bytes", (m) => { file(m, "guest/openhcl-ownguest.bin").sha256 = "01".repeat(32); }, /FAIL source guest\/openhcl-ownguest\.bin/],
  ["the manager pinned to a commit without backend-hcs.mjs", (m) => {
     for (const f of m.files.filter((x) => x.role === "control.manager")) f.from.git.commit = "23ea4340868a2dc4ff2556bdbb179f8090dcf325"; },
   /FAIL source control\/windows\/vbslike\/manager\/backend-hcs\.mjs/],
  ["hookbin (/2) called servable", (m) => { app(m, "hookbin").servable = true; }, /FAIL hookbin 0\.1\.4: servable only on a derivation the pinned manager serves/],
  ["the tier claims host exclusion", (m) => { m.tier.hostExcluded = true; }, /FAIL tier states what this box is/],
  ["the tier claims SNP", (m) => { m.tier.snp = true; }, /FAIL tier states what this box is/],
  ["a path that leaves the package", (m) => { file(m, "win/check.ps1").path = "../check.ps1"; }, /FAIL manifest shape: .*not a plain relative path/],
  ["a path twice", (m) => { m.files.push({ ...file(m, "win/check.ps1") }); }, /FAIL manifest shape: .*appears twice/],
  ["the manager's wmi-launcher re-pinned to the stale 261e5f03 bytes (consistent forgery)", (m) => {
     file(m, "control/windows/vbslike/manager/wmi-launcher.mjs").from.git.commit = "261e5f033823f6de3cca5376d991e59965e110f5";
     repin(m, ["control/windows/vbslike/manager/wmi-launcher.mjs"]); },
   /FAIL the igvm manager creates its VM with a guest-state isolation type/],
  ["the igvm manager check not shipped", (m) => { m.profiles.igvm.manager.check = "win/manager-check-absent.mjs"; }, /FAIL profile igvm ships its manager check for the box/],
  ["the datapath slot called empty while a datapath is shipped", (m) => { m.slots[0].state = "empty"; }, /FAIL slot control\.datapath/],
  ["hcs-dev boots another initrd than the IGVM's", (m) => { m.profiles["hcs-dev"].initrd = "guest/wsl-kernel"; },
   /FAIL profile hcs-dev names a kernel, the monitor initrd|FAIL both profiles boot the SAME monitor image/],
  ["the IGVM recipe reads another initrd than hcs-dev boots", (m) => { m.rebuild.igvm.initrd = "guest/runtime.json"; }, /FAIL both profiles boot the SAME monitor image/],
  ["no VM worker grant for the IGVM", (m) => { m.vmWorkerRead = []; }, /FAIL vmWorkerRead names the IGVM/],
  ["a box-only file with nowhere to stage it from", (m) => { delete file(m, "control/vbslike-host.exe").boxReuse; }, /FAIL manifest shape: .*needs boxReuse/],
  ["an expected body whose sha256 is not its bytes", (m) => { app(m, "hello-world").expect.body = "Hello World!"; }, /FAIL hello-world 1\.0\.4: an expected answer, exact to the byte/],
  ["the guest's judge named as a file that is not a judge", (m) => { m.guest.judge = "win/judge-run.mjs"; }, /FAIL guest declares its ready and attestation paths, a judge and its runner/],
  ["judge-hv re-pinned to other bytes that export no judge (consistent forgery)", (m) => {
     file(m, "control/windows/vbslike/verify/judge-hv.mjs").from.git.path = "isolation/contract/runtime.mjs"; repin(m, ["control/windows/vbslike/verify/judge-hv.mjs"]); },
   /FAIL the pinned judge loads from the package's own files/],
  ["the datapath slot pinned with its file removed", (m) => { m.files = m.files.filter((f) => f.role !== "control.datapath"); }, /FAIL slot control\.datapath/],
];
for (const [name, mutate, want] of MANIFEST_CASES) {
  test(`manifest: ${name} -> FAIL at the check that covers it`, { skip }, () => {
    const m = structuredClone(base); mutate(m);
    const r = run(["verify", writeManifest(m)]);
    assert.equal(r.code, 1, `verify PASSED a manifest with ${name}`);
    assert.match(r.out, want, fails(r.out));
  });
}

test("serve: an answer pinned without being observed (v1's defect, re-pinned consistently) is refused by serving the app", { skip: skip || (!haveWasmtime && "no wasmtime") }, () => {
  const m = structuredClone(base), e = app(m, "hello-world").expect;
  e.body = "Hello World!"; e.bodySha256 = "7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069";   // sha256("Hello World!")
  const r = run(["verify", writeManifest(m), "--serve"]);
  assert.equal(r.code, 1, "a wrong expected answer passed --serve");
  assert.match(r.out, /FAIL serve: hello-world 1\.0\.4 answers exactly the pinned bytes/, fails(r.out));
  assert.match(r.out, /ok   hello-world 1\.0\.4: an expected answer, exact to the byte/, "the forgery must be self-consistent, so only serving catches it");
});
test("serve: the committed manifest's answer is what the pinned runtime serves", { skip: skip || (!haveWasmtime && "no wasmtime") }, () => {
  const r = run(["verify", MANIFEST, "--serve"]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   serve: hello-world 1\.0\.4 answers exactly the pinned bytes/);
});
test("v1 (committed, never edited) is refused by the current verifier at its unobserved answer", { skip }, () => {
  const r = run(["verify", V1]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL hello-world 1\.0\.4: an expected answer, exact to the byte/, fails(r.out));
});
// enclave-99's readiness test (review/nucbox-manager-tests f6e9a6e7) pinned against v4's manager: at f4f10c84 it gives
// 8 tests, 4 failing (3, 4, 5, 8 = defect 10). An expected result is exact in both directions.
const withReadiness = (expect) => { const m = JSON.parse(fs.readFileSync(V4, "utf8"));
  m.inputs.push({ name: "readiness-rule.test.mjs", role: "input.test", sha256: "", bytes: 0,
                  from: { git: { commit: "f6e9a6e78f9b2f68b11127e4adcb61aa07d4e046", path: "windows/vbslike/review/readiness-rule.test.mjs" } } });
  m.tests = [{ name: "readiness-rule", owner: "enclave-99", input: "readiness-rule.test.mjs", requires: ["openssl"],
               layout: "control/windows/vbslike/review/readiness-rule.test.mjs", expect }];
  return repin(m, ["readiness-rule.test.mjs"]); };
const haveOpenssl = spawnSync("sh", ["-c", "command -v openssl"]).status === 0;
test("tests: the committed manifest's pinned tests give exactly their stated results", { skip: skip || (!haveOpenssl && "no openssl") }, () => {
  const r = run(["verify", MANIFEST, "--tests"]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   test readiness-rule \(enclave-99\) gives exactly its expected result \(8 tests, 8 pass, 0 fail\)/);
  assert.match(r.out, /ok   test datapath \(enclave-99\) gives exactly its expected result \(5 tests, 5 pass, 0 fail\)/);
});
test("tests: a pinned test re-pinned to another commit's bytes (consistent forgery) no longer gives its stated result", { skip: skip || (!haveOpenssl && "no openssl") }, () => {
  const m = structuredClone(base), t = m.inputs.find((i) => i.name === "readiness-rule.test.mjs");
  const mgr = m.files.filter((f) => f.role === "control.manager" && f.path.endsWith("/ready.mjs"));
  mgr[0].from.git.commit = "f4f10c84a2596d998defa58d7dd312081287e721";           // v4's ready.mjs, with defect 10
  repin(m, [mgr[0].path]);
  const r = run(["verify", writeManifest(m), "--tests"]);
  assert.equal(r.code, 1, "the defect-10 ready.mjs passed the pinned 8/8");
  assert.match(r.out, /FAIL test readiness-rule \(enclave-99\) gives exactly its expected result: 8 tests, \d pass/, fails(r.out));
  assert.ok(t);
});
test("tests: the readiness test on v4's manager gives exactly its known result (4 of 8 fail: defect 10)", { skip: skip || (!haveOpenssl && "no openssl") }, () => {
  const r = run(["verify", writeManifest(withReadiness({ tests: 8, pass: 4, fail: 4, failing: [3, 4, 5, 8] })), "--tests"]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   test readiness-rule \(enclave-99\) gives exactly its expected result \(8 tests, 4 pass, 4 fail \(failing 3, 4, 5, 8\)\)/);
});
test("tests: claiming the readiness test passes on v4's manager is refused", { skip: skip || (!haveOpenssl && "no openssl") }, () => {
  const r = run(["verify", writeManifest(withReadiness({ tests: 8, pass: 8, fail: 0, failing: [] })), "--tests"]);
  assert.equal(r.code, 1, "a green claim for a manager with defect 10 passed");
  assert.match(r.out, /FAIL test readiness-rule \(enclave-99\) gives exactly its expected result: 8 tests, 4 pass, 4 fail/, fails(r.out));
});
test("v3 (committed, never edited) is refused by the current verifier at its stale manager", { skip }, () => {
  const r = run(["verify", V3]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL the igvm manager creates its VM with a guest-state isolation type/, fails(r.out));
});
test("the packed judge runner refuses evidence that is not evidence", { skip }, () => {
  const d = fs.mkdtempSync(path.join(WORK, "judge-"));
  const cases = [["{}", /judge-run:/], [JSON.stringify({ certB64: "AAAA", nonceHex: "00".repeat(32), docRaw: "{}", runtimeRaw: "{}" }), /judge-run:/]];
  for (const [ev, want] of cases) {
    const f = path.join(d, "ev.json"); fs.writeFileSync(f, ev);
    const r = spawnSync(process.execPath, [path.join(packed, "win/judge-run.mjs"), f], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout.trim().split("\n").at(-1));
    assert.equal(j.verdict, "reject"); assert.match(j.reasons.join(" "), want);
  }
});

const monOther = path.join(SOURCES, "test/mon-30d8e344.cpio.gz");
test("rebuild: another monitor initrd, re-pinned consistently, does not make the pinned IGVM", { skip: skip || (!fs.existsSync(monOther) && "no second initrd") }, () => {
  const m = structuredClone(base);
  file(m, "guest/mon.cpio.gz").from.file = monOther; repin(m, ["guest/mon.cpio.gz"]);
  const r = run(["verify", writeManifest(m), "--rebuild"]);
  assert.equal(r.code, 1, "an IGVM rebuilt on another initrd was accepted");
  assert.match(r.out, /FAIL rebuild: the IGVM from its pinned inputs/, fails(r.out));
  assert.match(r.out, /ok   rebuild: the VTL0 vmlinux/, "the kernel half must still rebuild");
});

// packed-directory mutations work on a hard-linked copy; a mutated file is REPLACED, never written through the link
function outCase(name, mutate, want) {
  test(`out: ${name} -> FAIL`, { skip }, () => {
    const d = fs.mkdtempSync(path.join(WORK, "out-"));
    const copy = path.join(d, path.basename(packed));
    assert.equal(spawnSync("cp", ["-al", packed, copy]).status, 0);
    const replace = (rel, f) => { const p = path.join(copy, rel), b = fs.readFileSync(p); fs.rmSync(p); fs.writeFileSync(p, f(b)); };
    mutate(copy, replace);
    const r = run(["verify", MANIFEST, "--out", copy]);
    assert.equal(r.code, 1, `verify PASSED a packed directory with ${name}`);
    assert.match(r.out, want, fails(r.out));
  });
}
outCase("one byte of the app bundle changed", (c, rep) => rep(`${H}/app.bundle`, (b) => { const x = Buffer.from(b); x[x.length - 1] ^= 1; return x; }), /FAIL out: apps\/hello-world-1\.0\.4\/app\.bundle/);
outCase("a script removed", (c) => fs.rmSync(path.join(c, "win/check.ps1")), /FAIL out: exactly the packable files: missing win\/check\.ps1/);
outCase("a file the manifest does not name", (c) => fs.writeFileSync(path.join(c, "win/extra.ps1"), "x"), /FAIL out: exactly the packable files: extra win\/extra\.ps1/);
outCase("MANIFEST.json edited", (c, rep) => rep("MANIFEST.json", (b) => Buffer.concat([b, Buffer.from(" ")])), /FAIL out: MANIFEST\.json is this manifest/);
