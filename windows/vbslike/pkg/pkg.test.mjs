// pkg.test.mjs -- the package verifier (pkg.mjs) held to its claims: each mutation below breaks ONE claim, on a copy,
// and verify must FAIL at the check that covers it; the unmutated manifest and packed directory must PASS. Several
// mutations are CONSISTENT forgeries -- the edited entry re-pinned to the bytes it now has -- so they must fail at the
// claim, not merely at a hash. Needs this host's sources (~/enclave-bench/ownguest-pkg/sources); skips without them.
//   node --test windows/vbslike/pkg/pkg.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, "pkg.mjs");
const MANIFEST = path.join(HERE, "manifests/nucbox-ownguest-7.json");        // the latest; older ones are kept below as refusals
const V4 = path.join(HERE, "manifests/nucbox-ownguest-4.json");
const V5 = path.join(HERE, "manifests/nucbox-ownguest-5.json");
// a manifest derived from a committed one keeps that one's scripts: its `repo` sources become git pins at its commit
const commitOf = (p) => spawnSync("git", ["-C", path.join(HERE, "../../.."), "log", "-1", "--format=%H", "--", path.relative(path.join(HERE, "../../.."), p)], { encoding: "utf8" }).stdout.trim();
const committed = (p) => { const m = JSON.parse(fs.readFileSync(p, "utf8")), c = commitOf(p);
  for (const e of [...m.files, ...m.inputs]) if (e.from && e.from.repo) e.from = { git: { commit: c, path: e.from.repo } };
  return m; };
const v5 = () => committed(V5);
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
// The reference file AS A DRAFT PINS IT, resolved the way pkg.mjs resolves a `repo` source: at the draft's own commit when
// the draft is committed and unchanged since, else the working tree. A test about an older draft must never read the
// live file: a later version's rollover rewrites it (v31 moved c567e432 to superseded).
const REF_REL = "windows/vbslike/pkg/reference/nucbox-vbs-reference.json";
function refRawFor(draft) {
  const top = spawnSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim(), rel = path.relative(top, draft);
  const c = spawnSync("git", ["-C", top, "log", "-1", "--format=%H", "--", rel], { encoding: "utf8" }).stdout.trim();
  const clean = !!c && spawnSync("git", ["-C", top, "diff", "--quiet", c, "--", rel]).status === 0;
  return clean ? spawnSync("git", ["-C", top, "show", `${c}:${REF_REL}`], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout : fs.readFileSync(path.join(top, REF_REL), "utf8");
}
const refFor = (draft) => JSON.parse(refRawFor(draft));
// A mutated manifest is written outside the repository, where a `repo` source reads the working tree: pin its reference
// to exact bytes instead.
function pinRef(m, raw) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vbsref-")), "ref.json"); fs.writeFileSync(p, raw);
  const f = m.files.find((x) => x.role === "reference.values"); f.from = { file: p };
  f.sha256 = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); f.bytes = fs.statSync(p).size; return m;
}
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
const withReadiness = (expect) => { const m = committed(V4);
  m.inputs.push({ name: "readiness-rule.test.mjs", role: "input.test", sha256: "", bytes: 0,
                  from: { git: { commit: "f6e9a6e78f9b2f68b11127e4adcb61aa07d4e046", path: "windows/vbslike/review/readiness-rule.test.mjs" } } });
  m.tests = [{ name: "readiness-rule", owner: "enclave-99", input: "readiness-rule.test.mjs", requires: ["openssl"],
               layout: "control/windows/vbslike/review/readiness-rule.test.mjs", expect }];
  return repin(m, ["readiness-rule.test.mjs"]); };
const haveOpenssl = spawnSync("sh", ["-c", "command -v openssl"]).status === 0;
// the three gate inputs isolationPlan lacks, each failing with exactly this message (measured at eb1fd883 on b1483afa)
const NB_FAIL = ["with no stated requirement the plan must refuse (unknown is not no)\n\ntrue !== false\n",
                 "another backend's manager, even one that serves the derivation, is refused\n\ntrue !== false\n",
                 "a deployment carrying a config override by CID is not delivered into a partition\n\ntrue !== false\n"];
test("tests: the committed manifest's pinned tests give exactly their stated results", { skip: skip || (!haveOpenssl && "no openssl") }, () => {
  const r = run(["verify", MANIFEST, "--tests"]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   test readiness-rule \(enclave-99\) gives exactly its expected result \(8 tests, 8 pass, 0 fail\)/);
  assert.match(r.out, /ok   test datapath \(enclave-99\) gives exactly its expected result \(5 tests, 5 pass, 0 fail\)/);
  assert.match(r.out, /ok   test record-to-route \(enclave-99\) gives exactly its expected result \(4 tests, 4 pass, 0 fail\)/);
  // 5d's interop case RUNS against the shipped splice client: 5 pass, no skip (v6 pinned it as a named skip)
  assert.match(r.out, /ok   test datapath-5d \(enclave-5d\) gives exactly its expected result \(5 tests, 5 pass, 0 fail\)/);
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
// enclave-5d's own datapath suite (7f36992c) in the package tree: its interop case imports the node-side splice client,
// which the package does not carry, so it SKIPS by name. The pin says so exactly: 4 pass + that one named skip.
const DP_SKIP = { case: 5, reason: "the supervisor's splice client is not importable here (ERR_MODULE_NOT_FOUND)" };
const with5dDatapath = (expect) => { const m = v5();
  m.inputs.push({ name: "datapath-5d.test.mjs", role: "input.test", sha256: "", bytes: 0,
                  from: { git: { commit: "7f36992cac3004076ccce840dff8b58463f39a52", path: "windows/vbslike/datapath/datapath.test.mjs" } } });
  m.tests = [...m.tests, { name: "datapath-5d", owner: "enclave-5d", input: "datapath-5d.test.mjs", requires: [],
                            layout: "control/windows/vbslike/datapath/datapath.test.mjs", expect }];
  return repin(m, ["datapath-5d.test.mjs"]); };
test("tests: a named skip is part of the exact result (5d's datapath suite: 4 pass + 1 named skip)", { skip: skip || (!haveOpenssl && "no openssl") }, () => {
  const r = run(["verify", writeManifest(with5dDatapath({ tests: 5, pass: 4, fail: 0, failing: [], skipped: [DP_SKIP] })), "--tests"]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   test datapath-5d \(enclave-5d\) gives exactly its expected result \(5 tests, 4 pass, 0 fail, skipped 5 "the supervisor's splice client/);
});
test("tests: a skip the pin does not declare is refused, and so is a skip for another reason", { skip: skip || (!haveOpenssl && "no openssl") }, () => {
  for (const expect of [{ tests: 5, pass: 4, fail: 0, failing: [] },
                        { tests: 5, pass: 4, fail: 0, failing: [], skipped: [{ case: 5, reason: "some other reason" }] }]) {
    const r = run(["verify", writeManifest(with5dDatapath(expect)), "--tests"]);
    assert.equal(r.code, 1, `a pin of ${JSON.stringify(expect)} passed`);
    assert.match(r.out, /FAIL test datapath-5d \(enclave-5d\) gives exactly its expected result/, fails(r.out));
  }
});
// enclave-99's record-to-route suite (193c2338): the manager's /vms record, read through the node's client, fed to the
// datapath's admit(). On v5's manager (6d6c289e) both cases fail, and the pin names each failure's EXACT message.
// The suite reads the contract vectors from the repository: a support input, placed for the run, never shipped.
const R2R_MSG = {
  1: "image = the launcher's initrdSha256 from its ready line, carried by the manager\n+ actual - expected\n\n+ null\n- '44abb52b1486dd2aae344e021a0d8049dfb2015d137c22a6e336051c4db5a0cf'\n",
  2: "NOT WIRED YET (expected until the spawn path calls judgeRunning): status=starting, transportKeySha256=null -> refused:not-running: the instance is starting" };
const withRecordToRoute = (failing) => { const m = v5(), REV = "193c2338c90e700cd551402efebcc4414ccfc247";
  m.files.push({ path: "control/windows/node/isolation-client.mjs", role: "control.manager", sha256: "", bytes: 0,
                 from: { git: { commit: "6d6c289eb594c7d337c066961de59134bdbad13b", path: "windows/node/isolation-client.mjs" } } });
  m.inputs.push({ name: "derive_vectors.json", role: "input.test-support", sha256: "", bytes: 0, from: { git: { commit: REV, path: "isolation/contract/catalog/derive_vectors.json" } } },
                { name: "record-to-route.test.mjs", role: "input.test", sha256: "", bytes: 0, from: { git: { commit: REV, path: "windows/vbslike/review/record-to-route.test.mjs" } } });
  m.tests = [...m.tests, { name: "record-to-route", owner: "enclave-99", input: "record-to-route.test.mjs", requires: [],
                           layout: "control/windows/vbslike/review/record-to-route.test.mjs",
                           support: [{ input: "derive_vectors.json", layout: "control/isolation/contract/catalog/derive_vectors.json" }],
                           expect: { tests: 2, pass: 0, fail: 2, failing } }];
  return repin(m, ["control/windows/node/isolation-client.mjs", "derive_vectors.json", "record-to-route.test.mjs"]); };
test("tests: a failure is pinned with its exact message (record-to-route on v5's manager: 0 of 2, both named)", { skip: skip || (!haveOpenssl && "no openssl") }, () => {
  const r = run(["verify", writeManifest(withRecordToRoute([{ case: 1, message: R2R_MSG[1] }, { case: 2, message: R2R_MSG[2] }])), "--tests"]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   test record-to-route \(enclave-99\) gives exactly its expected result \(2 tests, 0 pass, 2 fail \(failing 1, 2\)\)/);
});
test("tests: the same failure pinned with another message is refused, naming what the case said", { skip: skip || (!haveOpenssl && "no openssl") }, () => {
  const r = run(["verify", writeManifest(withRecordToRoute([{ case: 1, message: R2R_MSG[1] }, { case: 2, message: "refused:not-running" }])), "--tests"]);
  assert.equal(r.code, 1, "a failure pinned with the wrong message passed");
  assert.match(r.out, /FAIL test record-to-route \(enclave-99\) gives exactly its expected result: .*case 2 said "NOT WIRED YET/, fails(r.out));
});
test("committed manifests keep verifying after their scripts move on: v4 and v5 read win/* at their own commits", { skip }, () => {
  for (const v of [V4, V5]) {
    const r = run(["verify", v]);
    assert.equal(r.code, 0, `${path.basename(v)}: ${fails(r.out)}`);
    assert.match(r.out, /ok   source win\/check\.ps1 \(repo at the manifest's commit [0-9a-f]{12}\)/);
  }
});
// the node's record builder against the catalog, on v7's pinned node-bridge.mjs: the on-chain facts (Base block
// 51751542, catalog 0x18419CA2..., schema 9) build exactly the pinned records; d1's defect class is refused.
const V7 = path.join(HERE, "manifests/nucbox-ownguest-7.json");
const FACTS = { source: { chainId: 8453, block: 51751542, addressBook: "0xab214342d5A490150A4A977063A2f88E21F80907", catalog: "0x18419CA2b502D423A8de6269AEeE171a378626e3", catalogSchema: 9 },
  versions: {
    "0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4": { cid: "bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza", version: "1.0.4", memMb: 128, ports: "",
      config: "{\"_media\":{\"thumbnail\":\"bafkreifwbdhx3sp7juo4fy3g47zmvik5lakqvte3okdnoij6gv5v5lnoue\",\"thumbnailSvg\":true,\"banner\":\"bafkreicr4ejprdyuwzise2oehjjy52in6zawoa2j6hwve2yad7nxejtaau\",\"bannerSvg\":true}}", yanked: false, approval: 1 },
    "0xf7e65a8fdae1dd9f8c2a897f2f372cdb7f6150d1e20526fa06d10a682cc2e9e3/4": { cid: "bafkreidocbixnql7lroykdtwx4r2fmi5n6sra4lj7b7vhscsfqn4gctlee", version: "0.1.4", memMb: 256, ports: "http:8000",
      config: "{\"_media\":{\"thumbnail\":\"bafkreifzvpy3jk67jklyi3war6zzlz62hmj3dd7nblpllxcckwf6eoijzq\",\"thumbnailSvg\":true,\"banner\":\"bafkreiet6ftvptcqexzkn5657wivim7xeeodxruo3f7qoy52uf5wib2uxu\"}}", yanked: false, approval: 1 } } };
const withFacts = (mut) => { const m = committed(V7); m.catalogFacts = structuredClone(FACTS); if (mut) mut(m.catalogFacts); return m; };
test("catalog: isolationPlan builds exactly the pinned records from the on-chain versions (v7's node-bridge)", { skip }, () => {
  const r = run(["verify", writeManifest(withFacts())]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   hello-world 1\.0\.4: the node's isolationPlan builds exactly the pinned record from the on-chain version \(record bff33b951aade0a9, memMb 128\)/);
  assert.match(r.out, /ok   hookbin 0\.1\.4: the node's isolationPlan builds exactly the pinned record from the on-chain version \(record 1fb9360ddfd50a25, memMb 256, ports http:8000\)/);
});
test("catalog: a record built from another memMb (d1's defect class: the node's floor, not the version's) is refused", { skip }, () => {
  const r = run(["verify", writeManifest(withFacts((f) => { f.versions["0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4"].memMb = 256; }))]);
  assert.equal(r.code, 1, "a record built from the wrong memMb passed");
  assert.match(r.out, /FAIL hello-world 1\.0\.4: the node's isolationPlan builds exactly the pinned record from the on-chain version: it builds [0-9a-f]{16}, pinned bff33b951aade0a9/, fails(r.out));
});
test("catalog: facts naming another CID, or a yanked version, are refused", { skip }, () => {
  for (const mut of [(f) => { f.versions["0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4"].cid = FACTS.versions["0xf7e65a8fdae1dd9f8c2a897f2f372cdb7f6150d1e20526fa06d10a682cc2e9e3/4"].cid; },
                     (f) => { f.versions["0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4"].yanked = true; }]) {
    const r = run(["verify", writeManifest(withFacts(mut))]);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL hello-world 1\.0\.4: the catalog version names this CID, approved and not yanked/, fails(r.out));
  }
});
// enclave-99's node-bridge suite (review eb1fd883) on v7's shipped bridge: it needs npm `ws`, pinned the way npm pins it
// (the lockfile's tarball, sha512 integrity) and unpacked into the test tree for the run; never shipped.
const withNodeBridge = (failing) => { const m = committed(V7);
  m.inputs.push({ name: "ws-8.21.1.tgz", role: "input.test-support", sha256: "bb0f7e58ba1f64746672734d36175fe185f226491e336abc0743e2a8f4472ec1", bytes: 34995,
                  integrity: "sha512-+0NTnW77fFN/DjQi6k/Sq/Yvk4Sgajw7urW8V+asjXnRgDs9gyGkdb7EzgfhA4goXsRIZKE28fzIXBHEzhuiWw==",
                  from: { file: "~/enclave-bench/ownguest-pkg/sources/npm/ws-8.21.1.tgz" } },
                { name: "node-bridge.test.mjs", role: "input.test", sha256: "", bytes: 0,
                  from: { git: { commit: "eb1fd883d930c5cca3e488afe7261e2f526c9b40", path: "windows/vbslike/review/node-bridge.test.mjs" } } });
  m.tests = [{ name: "node-bridge", owner: "enclave-99", input: "node-bridge.test.mjs", requires: ["openssl"],
               layout: "control/windows/vbslike/review/node-bridge.test.mjs",
               support: [{ input: "ws-8.21.1.tgz", layout: "node_modules/ws", unpack: "npm-tgz" }],
               expect: { tests: 6, pass: 3, fail: 3, failing } }];
  return repin(m, ["node-bridge.test.mjs"]); };
test("tests: 99's node-bridge suite on v7's bridge: 3 pass, the 3 missing gate inputs fail by name", { skip: skip || (!haveOpenssl && "no openssl") }, () => {
  const r = run(["verify", writeManifest(withNodeBridge(NB_FAIL.map((message, i) => ({ case: i + 2, message })))), "--tests"]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   source ws-8\.21\.1\.tgz: npm integrity/);
  assert.match(r.out, /ok   test node-bridge \(enclave-99\) gives exactly its expected result \(6 tests, 3 pass, 3 fail \(failing 2, 3, 4\)\)/);
});
// the HELD v8 draft (drafts/, not a release): it verifies with every pin, and says it is held
// the drafts (drafts/, not releases): each verifies with every pin, and its status says what it is and is not
for (const [n, statusRe] of [[8, /^HELD DRAFT: not a release, not staged/], [9, /^DRAFT staged for enclave-d1's UEFI DEV boot/], [10, /^DRAFT\. The UEFI DEV boot reached 'MON ready control_port=9000' on the NucBox/],
                            [11, /^DRAFT staged for enclave-d1's transport=hv_sock confirmation: the NEXT medium \(7b9b04d6.*NOT yet been booted on the NucBox/],
                            [12, /^DRAFT, HELD with v11 .*NODE TREE.*The harness has NOT run on the box/]]) {
  test(`draft v${n} verifies with its pins, and its status says it is not a release`, { skip: skip || (!haveOpenssl && "no openssl") }, () => {
    const D = path.join(HERE, `drafts/nucbox-ownguest-${n}.json`), d = JSON.parse(fs.readFileSync(D, "utf8"));
    assert.match(d.status, statusRe);
    assert.match(d.status, /[Nn]ot a release/);
    const r = run(["verify", D, "--tests"]);
    assert.equal(r.code, 0, fails(r.out));
    assert.match(r.out, /ok   test node-bridge \(enclave-99\) gives exactly its expected result \(6 tests, 6 pass, 0 fail\)/);
    assert.match(r.out, /ok   hello-world 1\.0\.4: the node's isolationPlan builds exactly the pinned record from the on-chain version/);
    if (n >= 9) assert.match(r.out, /ok   test appzone-hook \(enclave-99\) gives exactly its expected result \(3 tests, 3 pass, 0 fail\)/);
  });
}
test("draft v12 carries the node tree and the acceptance harness, pins host-activation 6/6, and says the harness has not run on the box", { skip: skip || (!haveOpenssl && "no openssl") }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-12.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.equal(d.npmTree.packages.length, 15);
  assert.ok(d.npmTree.packages.some((p) => p.name === "viem" && p.version === "2.56.8" && p.dir === "node_modules/viem"));
  assert.ok(d.npmTree.packages.some((p) => p.name === "ws" && p.version === "8.21.0" && p.dir === "node_modules/viem/node_modules/ws"), "viem's nested ws keeps its lockfile position");
  assert.equal(d.acceptance.status, "NOT run on the box");
  assert.deepEqual(d.tests.find((t) => t.name === "host-activation").expect, { tests: 6, pass: 6, fail: 0, failing: [] });
  const r = run(["verify", D, "--tests"]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   test host-activation \(enclave-99\) gives exactly its expected result \(6 tests, 6 pass, 0 fail\)/);
  assert.match(r.out, /ok   npm tree: every module the acceptance harness imports LOADS from the assembled tree \(11 modules\)/);
});
test("the manager's UEFI serving gaps are pinned as measured: claiming the medium is attached is refused", { skip }, () => {
  const m = JSON.parse(fs.readFileSync(path.join(HERE, "drafts/nucbox-ownguest-12.json"), "utf8"));
  m.profiles.uefi.managerServing.expect.attachesMedium = true;
  const r = run(["verify", writeManifest(m)]);
  assert.equal(r.code, 1, "a pin claiming the manager attaches a medium passed");
  assert.match(r.out, /FAIL the manager's UEFI serving path is exactly as pinned .*attachesMedium: false \(pinned true\)/, fails(r.out));
});
test("a pinned npm tarball with other bytes is refused at npm's own integrity, not only at the sha256", { skip }, () => {
  const m = JSON.parse(fs.readFileSync(path.join(HERE, "drafts/nucbox-ownguest-12.json"), "utf8"));
  const f = m.files.find((x) => x.path === "npm/isows-1.0.7.tgz"), g = m.files.find((x) => x.path === "npm/eventemitter3-5.0.1.tgz");
  f.from = g.from; f.sha256 = g.sha256; f.bytes = g.bytes;                       // consistent sha256, wrong package
  const r = run(["verify", writeManifest(m)]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL source npm\/isows-1\.0\.7\.tgz: npm integrity/, fails(r.out));
});
test("draft v11 pins the NEXT medium and says it has not been booted on the NucBox", { skip }, () => {
  const d = JSON.parse(fs.readFileSync(path.join(HERE, "drafts/nucbox-ownguest-11.json"), "utf8"));
  assert.equal(d.files.find((f) => f.path === "guest/uefi/guest.iso").sha256, "7b9b04d699da2e5915df7c51c2464ba2bb18122380b197e1cbea2f24aa9a2ddd");
  assert.equal(d.profiles.uefi.uki.sha256, "20a0e18e51a02ed78465b1234b979177e9aab2d74ba198dd6ccc3d1a8a241a33");
  // on the box since the first v11 staging (515de1fa, which hashed it to the pin), but NOT booted there: reuse is a copy, not a boot
  assert.equal(d.files.find((f) => f.path === "guest/uefi/guest.iso").boxReuse, "C:\\Users\\claude\\vbs-like\\pkg\\515de1fa8596cafc\\guest\\uefi\\guest.iso");
  assert.match(d.status, /NOT yet been booted on the NucBox/);
  assert.ok(d.profiles.uefi.measured.some((m) => /MON ERROR no vsock transport/.test(m)), "the KVM refusal is recorded as the guard, not a boot");
  assert.equal(d.files.find((f) => f.path === "control/vbslike-host.exe").sha256, "c2cb0c10945a35f8664368ee9fafcae7b4a1fceb315d7bca11a84b4f650a1f29", "the launcher the box runs (hvdial + wmiserve)");
  assert.ok(d.profiles.uefi.measured.some((m) => /APP ANSWERED: Hello World!/.test(m) && /curl -k/.test(m) && /type 16/.test(m)), "d1's served run is recorded with its limits");
  assert.equal(d.profiles.uefi.managerServing.expect.imageType, "object", "the manager's serving gaps are pinned red");
});
test("draft v10 pins the launcher the box runs and the UEFI medium d1 booted, and says nothing is served", { skip }, () => {
  const d = JSON.parse(fs.readFileSync(path.join(HERE, "drafts/nucbox-ownguest-10.json"), "utf8"));
  assert.equal(d.files.find((f) => f.path === "control/vbslike-host.exe").sha256, "cddb70fdc927c7743bf1a8ea43f7526762d669b450e32d36fa935b8486cb5c31");
  assert.equal(d.files.find((f) => f.path === "guest/uefi/guest.iso").sha256, "4c387086d204c7064bf77a48c6e076b844ba5b429f2219c5e29cd988e23cdcb0");
  assert.match(d.status, /Nothing is loaded into or served/);
  assert.match(d.profiles.uefi.vm.vTpm, /^ABSENT/);
  assert.ok(d.profiles.uefi.measured.some((m) => /MON ready control_port=9000 snp=false/.test(m) && /host_excluded=no/.test(m)), "the boot is recorded from the log, with host_excluded=no");
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

test("draft v13 pins the type-1 material as an EXPERIMENT: the production medium ca245eae, the cvm firmware, a PROBE medium named so, the manager's image as a string, the harness at 484903f7", { skip: skip || (!haveOpenssl && "no openssl") }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-13.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  const f = (p) => d.files.find((x) => x.path === p);
  assert.equal(f("guest/uefi/guest.iso").sha256, "ca245eaee1e9d5cadd046ca2ca0a0d3d572d2099d68fdf73906d5804e580732b");
  assert.equal(d.profiles.uefi.uki.sha256, "7af57aabbe5d8b5533892734a6cb8947085bad13dfdd89b918e2436cccd66f4a");
  assert.equal(f("guest/uefi/openhcl-cvm.bin").sha256, "cfd40ce2affb17e7663351de82afcb5f7bfbb2b3174bbc206a6ddd8de3b128df");
  assert.equal(f(d.profiles.vbs.probeMedium).sha256, "8d1fea1fb5195046adc3c0839cefbfe8443680810aa2f4ed11ee776471d87fa1");
  assert.equal(f(d.profiles.vbs.probeMedium).role, "probe.uefi-medium");
  assert.match(d.profiles.vbs.probeMedium, /PROBE-NOT-PRODUCTION/);
  assert.match(d.profiles.vbs.status, /^EXPERIMENT/);
  assert.match(d.profiles.vbs.measured[0], /^CREATED AND STARTED, NOT BOOTED/, "no type-1 boot is claimed");
  assert.ok(!/MON (ready|boundary|hv)/.test(d.profiles.vbs.measured.join(" ")), "no type-1 console line is quoted before one was seen");
  assert.match(d.profiles.vbs.vm.vTpm, /^PRESENT/, "the type-1 vTPM is stated, not hidden");
  assert.match(d.profiles.vbs.vm.guestState.statelessUnsupported, /^UNSUPPORTED ON THIS HOST/);
  assert.equal(d.files.find((x) => x.path === "control/windows/vbslike/ops/uefi-dev-boot.ps1").from.git.commit, "714c4709a3701ec04bfcdfccb2ed088541abef87", "d1's type-1 sequence at 714c4709");
  assert.match(d.profiles.vbs.expect.type16, /^NOT PINNED/, "5d's type-16 prediction is not a pin");
  assert.deepEqual(d.profiles.uefi.managerServing.expect, { attachesMedium: false, setsBootDevice: false, readsBackBoot: false, imageIsMediumHash: true, imageType: "string", hasLauncherKey: false, hasRelay: false });
  assert.equal(f("control/isolation/m3/hvlab-accept.mjs").sha256, "feae013ea649dfcaac38841093a0c29b4220a77d32a598c3dde6211f06079fab", "5d's harness at 484903f7");
  assert.equal(d.acceptance.status, "NOT run on the box");
  assert.match(d.status, /a created and started VM is not a boot of our guest/);
  const r = run(["verify", D, "--tests"]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   no profile boots a PROBE medium as its medium or a probe firmware as its firmware, and every probe file is named PROBE on disk \(2 probe file\(s\)\)/);
  assert.match(r.out, /ok   the manager's UEFI serving path is exactly as pinned .*imageIsMediumHash=true imageType="string"/);
});
test("a profile that boots the PROBE medium as its medium is refused, whatever its text says", { skip }, () => {
  const m = JSON.parse(fs.readFileSync(path.join(HERE, "drafts/nucbox-ownguest-13.json"), "utf8"));
  m.profiles.vbs.medium = m.profiles.vbs.probeMedium;
  const r = run(["verify", writeManifest(m)]);
  assert.equal(r.code, 1, "a profile booting the probe medium passed");
  assert.match(r.out, /FAIL no profile boots a PROBE medium as its medium or a probe firmware as its firmware.*vbs\.medium guest\/uefi\/PROBE-NOT-PRODUCTION\/PROBE-vbsreport\.iso is probe\.uefi-medium/, fails(r.out));
});
test("the stale manager pin (image as an object, pre-c067b446) is refused against the c067b446 manager", { skip }, () => {
  const m = JSON.parse(fs.readFileSync(path.join(HERE, "drafts/nucbox-ownguest-13.json"), "utf8"));
  m.profiles.uefi.managerServing.expect.imageType = "object"; m.profiles.uefi.managerServing.expect.imageIsMediumHash = false;
  const r = run(["verify", writeManifest(m)]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL the manager's UEFI serving path is exactly as pinned .*imageIsMediumHash: true \(pinned false\); imageType: "string" \(pinned "object"\)/, fails(r.out));
});

test("draft v14 is held, not staged, and records 5d's source reading: the type-1 VMGS is host-key-protected or unencrypted with no tenant key, and vTPM binding is not available here", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-14.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, HELD, NOT STAGED \(v13 cfa1249c is the staged package/);
  assert.match(d.profiles.vbs.vm.guestState.vmgsProtection, /^host-key-protected \(GSP\) or unencrypted; NO tenant key/);
  assert.match(d.profiles.vbs.vm.guestState.vmgsProtection, /NOT measured/, "a source reading is not a measurement");
  assert.match(d.profiles.vbs.vm.guestState.vTpmBinding, /^NOT AVAILABLE on this host/);
  assert.match(d.profiles.vbs.vm.diagnosticGap, /ohcldiag-dev <VM name> kmsg/);
  assert.match(d.profiles.vbs.measured[0], /^CREATED AND STARTED, NOT BOOTED/, "v14 claims no more than v13 did");
  assert.ok(d.inputs.some((i) => i.name === "VBS-ISOLATION-1e9fe97b.md" && i.from.git.commit.startsWith("1e9fe97b")), "5d's review at 1e9fe97b is pinned beside fa8b0ec2's");
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
});

test("draft v15 pins d1's measured type-16 lines on ca245eae (n/a, not the predicted none/yes) and type 1 as REFUSED-TO-START under d1's recipe, with the scripts at f140bd56", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-15.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, STAGED: the production medium ca245eae is BOOTED on the NucBox under type 16/);
  assert.deepEqual(d.console.uefi.measuredType16, [
    "MON hv hyperv=true max_leaf=0x4000000b priv_high=0x3b8030 isolation_priv=false config_a=0x0 config_b=0x0 (stated by the hypervisor, CPUID)",
    "MON boundary tier=t0-hv vmpl=n/a vmpl_floor=n/a vmpl0=n/a host_excluded=no hv_isolation=n/a paravisor=n/a",
    "MON ready control_port=9000 snp=false transport=hv_sock"]);
  assert.match(d.profiles.uefi.measured[0], /^ON THE NUCBOX, type 16, THIS medium .*hv_isolation=n\/a paravisor=n\/a.*host is NOT excluded/);
  assert.match(d.profiles.vbs.expect.type16, /^MEASURED on ca245eae/);
  assert.match(d.profiles.vbs.status, /^EXPERIMENT, REFUSED-TO-START under enclave-d1's recipe/);
  assert.match(d.profiles.vbs.measured[0], /^REFUSED-TO-START on 26200 .*cvm \+ type 1 at GuestFeatureSet 0x400 STARTS and then TRIPLE-FAULTS/);
  assert.match(d.profiles.vbs.measured[1], /^NOT A VERDICT ON TYPE 1 .*E2\/E3 are NOT RUN, not failed/);
  assert.ok(!/MON (ready|boundary|hv)/.test(d.profiles.vbs.measured.join(" ")), "no type-1 console line is quoted: none has ever been seen");
  for (const f of ["uefi-dev-boot.ps1", "host-read-guest.ps1"]) assert.equal(d.files.find((x) => x.path === `control/windows/vbslike/ops/${f}`).from.git.commit, "f140bd56bdcfb4c00226e8ec79bf3534ce618bc9", `${f} at f140bd56`);
  assert.ok(d.inputs.some((i) => i.name === "VBS-ISOLATION-10145554.md" && i.from.git.commit.startsWith("10145554")));
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
});

test("draft v16 withdraws v15's type-1 pin: STARTS, THEN FAILS WITHIN SECONDS, reason not yet readable; pins ohcldiag-dev with its first run and d1's host facts; scripts at 3dbe444e", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-16.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, STAGED \(supersedes v15, whose type-1 pin REFUSED-TO-START is WITHDRAWN\)/);
  assert.match(d.profiles.vbs.status, /^EXPERIMENT: STARTS, THEN FAILS WITHIN SECONDS; REASON NOT YET READABLE/);
  assert.ok(!/REFUSED-TO-START on 26200/.test(d.profiles.vbs.status), "the withdrawn conclusion is not restated as a status");
  assert.match(d.profiles.vbs.measured[0], /^STARTS, THEN FAILS WITHIN SECONDS; REASON NOT YET READABLE .*GuestStateIsolationType=1 enabled=True GuestFeatureSet=0x201 Vtl2Mode=0 Vtl2Range=0.*exactly 120 s.*Zero bytes on COM1/);
  assert.match(d.profiles.vbs.measured[1], /^WITHDRAWN \(v15's pin\)/);
  assert.match(d.profiles.vbs.measured[2], /^HOST FACTS .*0x80070570.*GUESTRTS.*no CompleteStartVtl0 entry/);
  assert.match(d.profiles.vbs.measured[3], /^NOISE, not failure evidence .*Loading IGVM file from default location.*0xC0370103/);
  assert.ok(!/MON (ready|boundary|hv)/.test(d.profiles.vbs.measured.join(" ")), "no type-1 console line is quoted: none has ever been seen");
  assert.equal(d.files.find((x) => x.path === "control/ohcldiag-dev.exe").sha256, "5f25f2e7ffff169bd82b500b16257ad4bea6e40a6fc38e2d1aea274989ccb585");
  assert.match(d.profiles.vbs.ohcldiag.firstRun, /^MEASURED .*--help` exits 0/);
  assert.match(d.profiles.vbs.ohcldiag.expected.by, /UNMEASURED until d1's first run/);
  for (const f of ["uefi-dev-boot.ps1", "host-read-guest.ps1"]) assert.equal(d.files.find((x) => x.path === `control/windows/vbslike/ops/${f}`).from.git.commit, "3dbe444e9351120cdf4a7905aaafee032e04e768", `${f} at 3dbe444e`);
  assert.ok(d.inputs.some((i) => i.name === "type1-isolation-2026-09-25.md"));
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
});

test("draft v17 is held and pins 5d's type-1 failure-point inference under its own label, never as a measurement", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-17.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, HELD, NOT STAGED \(v16 e554ad25 is the staged package/);
  assert.match(d.profiles.vbs.inference.label, /^INFERENCE PENDING KMSG/);
  assert.match(d.profiles.vbs.inference.claim, /validate_isolated_configuration \(underhill_core worker\.rs:2230\)/);
  assert.equal(d.profiles.vbs.inference.reasons.length, 3);
  assert.match(d.profiles.vbs.inference.discriminators.preCheck, /inspect -r vm\/init_data\/dps/);
  assert.match(d.profiles.vbs.measured[2], /PRISTINE .*0x6d2eed28.*encryption NONE, no key protector, no files/);
  assert.match(d.profiles.vbs.status, /^EXPERIMENT: STARTS, THEN FAILS WITHIN SECONDS; REASON NOT YET READABLE/, "v17 claims no more than v16");
  assert.ok(!/MON (ready|boundary|hv)/.test(d.profiles.vbs.measured.join(" ")));
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
});

test("draft v18 is held: the 03:26 ohcldiag runs as relayed (type-1 'unknown service' = CVM-mode reply from a running server), the VMGS premise superseded, the memmarker PROBE medium rebuilt and refused as any medium", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-18.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, HELD, NOT STAGED \(v16 e554ad25 is the staged package; v18 supersedes v17/);
  assert.match(d.profiles.vbs.ohcldiag.firstRun, /354 lines.*the tool is MEASURED working.*generated by a RUNNING mesh_rpc server.*POSITIVE evidence.*localises NOTHING, because run_control starts the diag server before launch_workers/);
  assert.match(d.profiles.vbs.ohcldiag.firstRun, /Linux version 6\.12\.52-microsoft-hcl\+ \(runner@runnervmrw5os\).*ENTIRE output \(stdout 0 bytes; this on stderr\): 'Error: unknown service diag\.UnderhillDiag'.*scm_revision 29e15ab83bcecf0acd8bd14de2229690453c1d76/, "d1's verbatim lines and the inspect baseline");
  assert.match(d.profiles.vbs.measured[2], /\(1\) CORRECTED .*NO VHD FOOTER.*WITHDRAWN/, "the all-zero VMGS refusal is a footer refusal");
  assert.ok(d.inputs.find((i) => i.name === "openhcl.cpio.gz").from.file.endsWith("/sources/vtl2/openhcl.cpio.gz"), "VTL2 inputs come from durable copies");
  assert.equal(d.inputs.find((i) => i.name === "openhcl.cpio.gz").sha256, "0cc13ad34c9e1fa4a3187f7e15c834d752c60d64dbcf4253d1f125facf7a418a", "the restored initrd is the pinned bytes");
  assert.match(d.profiles.vbs.measured[2], /\(2\) CORRECTED .*NO GUESTRTS.*SUPERSEDED.*file 18, PROVISIONING_MARKER/);
  assert.match(d.profiles.vbs.inference.reasons[0], /^WITHDRAWN \(cc7ca28c\)/);
  assert.match(d.profiles.vbs.inference.label, /^INFERENCE PENDING KMSG/);
  const mm = d.files.find((x) => x.path === "guest/uefi/PROBE-NOT-PRODUCTION/PROBE-memmarker.iso");
  assert.equal(mm.sha256, "f173f15c0537da6cc021befa5f8c6a6c6000ad3b0a1fecd54e8665ccee981ce9"); assert.equal(mm.role, "probe.uefi-medium");
  assert.equal(d.files.find((x) => x.path === "guest/uefi/PROBE-NOT-PRODUCTION/PROBE-memmarker.ko").sha256, "567661aa0dc6309f739e2918721b92c3e58de72acc33408c888dc8de46345080");
  assert.equal(d.inputs.find((i) => i.name === "PROBE-memmarker-mon-6dd5deeb.cpio.gz").sha256, "6dd5deeb993d19d7bd916359b7e17817275142054f6674322f0677551cac9f0a");
  assert.ok(!/MON (ready|boundary|hv)/.test(d.profiles.vbs.measured.join(" ")));
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   no profile boots a PROBE medium as its medium or a probe firmware as its firmware, and every probe file is named PROBE on disk \(4 probe file\(s\)\)/);
  const m = structuredClone(d); m.profiles.uefi.medium = "guest/uefi/PROBE-NOT-PRODUCTION/PROBE-memmarker.iso";
  const f = run(["verify", writeManifest(m)]);
  assert.equal(f.code, 1); assert.match(f.out, /FAIL no profile boots a PROBE medium as its medium or a probe firmware as its firmware.*uefi\.medium guest\/uefi\/PROBE-NOT-PRODUCTION\/PROBE-memmarker\.iso is probe\.uefi-medium/, fails(f.out));
});

test("draft v19 (staged) pins both probe firmwares under probe.firmware, the named type-1 failure as measured on the a7b0bd4 debug build and a hypothesis for stock, and refuses a probe firmware as any profile's firmware", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-19.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, STAGED \(supersedes v16 as the staged package/);
  const f = (p) => d.files.find((x) => x.path === p);
  assert.equal(f(d.profiles.vbs.probeFirmware.debug).sha256, "81e163ee76228c7aa63a2f0f15ab4d584f79b458ed4ce346bc89ab930f1856b5"); assert.equal(f(d.profiles.vbs.probeFirmware.debug).role, "probe.firmware");
  assert.equal(f(d.profiles.vbs.probeFirmware.control).sha256, "32d464cc0650d67f9efc82b9d1d68acf26602ef7a762a53678d9aeb788c47749"); assert.equal(f(d.profiles.vbs.probeFirmware.control).role, "probe.firmware");
  assert.match(f(d.profiles.vbs.probeFirmware.debug).note, /^THIS FIRMWARE TRUSTS THE HOST COMMAND LINE/);
  assert.match(d.profiles.vbs.failure.named, /^MEASURED on the a7b0bd4 DEBUG image .*cannot safely support VTL 1 without using the alias map' at 0\.126 s/);
  assert.match(d.profiles.vbs.failure.stock, /strongest HYPOTHESIS, not measured/);
  assert.match(d.profiles.vbs.failure.next, /PREDICTION/);
  assert.match(d.profiles.vbs.inference.label, /^RESOLVED BY KMSG/);
  assert.match(d.profiles.vbs.status, /^EXPERIMENT: STARTS, THEN FAILS WITHIN SECONDS/, "type 1 is still an experiment");
  assert.ok(!/MON (ready|boundary|hv)/.test(d.profiles.vbs.measured.join(" ")), "no type-1 console line: none has been seen");
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   no profile boots a PROBE medium as its medium or a probe firmware as its firmware, and every probe file is named PROBE on disk \(6 probe file\(s\)\)/);
  for (const [prof, key] of [["vbs", "firmware"], ["uefi", "firmware"], ["igvm", "image"]]) {
    const m = structuredClone(d); m.profiles[prof][key] = d.profiles.vbs.probeFirmware.debug;
    const x = run(["verify", writeManifest(m)]);
    assert.equal(x.code, 1, `${prof}.${key} = the debug firmware passed`);
    assert.match(x.out, new RegExp(`FAIL no profile boots a PROBE medium as its medium or a probe firmware as its firmware.*${prof}\\.${key} .*is probe\\.firmware: a probe firmware is never a profile's firmware`), fails(x.out));
  }
});

test("draft v20 is held and corrects v19's next-steps order (the DEBUG run had already happened), adding 5d's two no-boot log checks", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-20.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, HELD, NOT STAGED \(v19 9aa75761 is the staged package/);
  assert.match(d.profiles.vbs.probeFirmware.order[0], /^\(enclave-5d's recommendation .* 1\. DEBUG image \+ `Set-VMSecurity -VirtualizationBasedSecurityOptOut \$true`/);
  assert.match(d.profiles.vbs.probeFirmware.order[1], /^2\. If it boots: STOCK image/);
  assert.match(d.profiles.vbs.probeFirmware.order[2], /^3\. The CONTROL image .* does not gate 1-2/);
  assert.equal(d.profiles.vbs.probeFirmware.logChecks.length, 2);
  assert.match(d.profiles.vbs.failure.next, /PREDICTION/);
  assert.ok(!/MON (ready|boundary|hv)/.test(d.profiles.vbs.measured.join(" ")));
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
});

test("draft v21 (staged) pins d1's type-1 BOOT AND SERVE on the a7b0bd4 control image verbatim, with host_excluded=no, the stock decision and the opt-out reason; a quoted boundary line without host_excluded=no is refused", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-21.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, STAGED \(supersedes v19 as the staged package\): A TYPE-1 PARTITION BOOTS AND SERVES on the a7b0bd4 CONTROL image/);
  assert.match(d.profiles.vbs.status, /^EXPERIMENT: BOOTS AND SERVES .*NO isolation claim; E2\/E3 NOT RUN/);
  assert.match(d.profiles.vbs.measured[0], /^BOOTS AND SERVES .*'MON boundary tier=t0-hv vmpl=n\/a vmpl_floor=n\/a vmpl0=n\/a host_excluded=no hv_isolation=vbs paravisor=no'.*'MON ready control_port=9000 snp=false transport=hv_sock'.*sha256 03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340/);
  assert.match(d.profiles.vbs.measured[1], /^DECIDED BY THE CONTROL IMAGE .*MEASURED, no longer a hypothesis.*DIFFERENT, UNNAMED error/);
  assert.equal(d.profiles.vbs.firmware, "guest/uefi/openhcl-cvm.bin", "the profile's firmware stays the stock image; the booting image stays a probe.firmware");
  assert.equal(d.files.find((x) => x.path === d.profiles.vbs.probeFirmware.control).role, "probe.firmware");
  assert.match(d.profiles.vbs.vm.security.virtualizationBasedSecurityOptOut, /^REQUIRED for type 1 .*ReadOnly property.*Guest VSM is VTL1 INSIDE the guest.*untouched by the opt-out/);
  assert.match(d.profiles.vbs.vm.security.saveVm, /^REFUSED BY HOST .*NOT evidence of protection/);
  assert.match(d.profiles.vbs.expect.type1, /^MEASURED .*paravisor=NO/);
  assert.deepEqual(d.console.uefi.measuredType1.slice(2), ["MON boundary tier=t0-hv vmpl=n/a vmpl_floor=n/a vmpl0=n/a host_excluded=no hv_isolation=vbs paravisor=no", "MON ready control_port=9000 snp=false transport=hv_sock"]);
  assert.equal(d.tier.hostExcluded, false);
  for (const f of ["uefi-dev-boot.ps1", "host-read-guest.ps1"]) assert.equal(d.files.find((x) => x.path === `control/windows/vbslike/ops/${f}`).from.git.commit, "c9c8cdccd70f39b780ad9320949ae60fa5564080");
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   every quoted 'MON boundary' line says host_excluded=no while the tier says the host is not excluded/);
  // the rule d1 asked for: not "no MON line under vbs" but "a quoted boundary line must carry host_excluded=no"
  const m = structuredClone(d); m.profiles.vbs.measured[0] = m.profiles.vbs.measured[0].replace("host_excluded=no hv_isolation=vbs", "host_excluded=yes hv_isolation=vbs");
  const x = run(["verify", writeManifest(m)]);
  assert.equal(x.code, 1, "a quoted boundary line claiming host_excluded=yes passed under a T0-hv tier");
  assert.match(x.out, /FAIL every quoted 'MON boundary' line says host_excluded=no .*host_excluded=yes/, fails(x.out));
});

test("draft v22 (staged) pins E2 as run and deciding nothing: VBSREPORT status=0x71 with no report body, neither go nor no-go; E3 not run; still host_excluded=no", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-22.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, STAGED \(supersedes v21 as the staged package\): E2 HAS RUN and decides NOTHING/);
  const e2 = d.profiles.vbs.measured.find((m) => /^E2 RUN, DECIDES NOTHING/.test(m));
  assert.ok(e2, "E2 is pinned as a measured entry");
  assert.match(e2, /'VBSREPORT status=0x71 \(\.\.\.\)' then 'MON PROBE finished: No such device', with NO report body.*HV_STATUS_OPERATION_FAILED.*NEITHER GO nor NO-GO.*'VTL0 refused \/ vTPM only' does NOT follow.*E3 NOT RUN/);
  assert.match(d.profiles.vbs.status, /E2 RUN and decides nothing .*E3 NOT RUN/);
  assert.match(d.profiles.vbs.runs.E2, /NEITHER go nor no-go/);
  assert.equal(d.tier.hostExcluded, false); assert.equal(d.tier.attested, false);
  assert.ok(d.inputs.some((i) => i.name === "VBS-ISOLATION-26eac9c2.md"));
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
});

test("draft v23 (staged) pins E2 verbatim from d1 with the interleaving note, and its resolution by the debug kmsg: VTL2 obtains the report, VTL0 is turned away, a client-verifiable binding is a design change; still no isolation claim", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-23.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, STAGED \(supersedes v22 as the staged package\): E2 RUN \(enclave-d1, verbatim/);
  const e2 = d.profiles.vbs.measured.find((m) => /^E2 RUN \(enclave-d1, verbatim/.test(m)), res = d.profiles.vbs.measured.find((m) => /^E2 RESOLVED/.test(m));
  assert.ok(e2 && res);
  assert.match(e2, /hashed AT ATTACH.*'\[    0\.335899\] VBSREPORT status=0x71 \(low 16 bits: 0 = success, 2 = invalid hypercall code, 3 = invalid input, 6 = access denied\)'.*INTERLEAVED.*not an edit.*tcglog-20260925-042300-0000000067-0000000000\.log \(90,554 bytes/);
  assert.match(res, /the size of the attestation response 0 is too small to parse.*No VMGS encryption used\..*WAS obtained.*TO VTL2 and turns VTL0 away.*DESIGN CHANGE rather than a guest patch.*NOT an isolation claim: host_excluded=no/);
  assert.ok(!d.profiles.vbs.measured.some((m) => /^E2 RUN, DECIDES NOTHING/.test(m)), "the superseded verdict is gone from the live list");
  assert.equal(d.tier.hostExcluded, false); assert.equal(d.tier.attested, false);
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
});

test("draft v24 (staged) pins 5d's reading beside d1's E2 conclusion (finding not inference, the pairing caveat, VTL2's report binds OpenHCL's claims not our key) and carries d1's b0f20482 evidence", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-24.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, STAGED \(supersedes v23 as the staged package\): enclave-5d's reading AGREES/);
  const ms = d.profiles.vbs.measured, iRes = ms.findIndex((m) => /^E2 RESOLVED/.test(m)), iBes = ms.findIndex((m) => /^E2 READING BESIDE d1's CONCLUSION/.test(m));
  assert.ok(iRes >= 0 && iBes === iRes + 1, "5d's reading sits beside (right after) d1's conclusion, not over it");
  assert.match(ms[iBes], /the VTL2 report call SUCCEEDED.*PAIRING CAVEAT.*ONE partition.*NOT our guest's key.*UNTESTED, because no report has been in our hands/);
  assert.match(ms[iRes], /DESIGN CHANGE rather than a guest patch/, "d1's conclusion is unchanged");
  const ev = d.inputs.find((i) => i.name === "type1-isolation-b0f20482.md");
  assert.ok(ev && ev.from.git.commit.startsWith("b0f20482") && ev.from.git.path === "windows/vbslike/evidence/type1-isolation-2026-09-25.md");
  assert.ok(d.inputs.some((i) => i.name === "VBS-ISOLATION-c8529534.md" && i.from.git.commit.startsWith("c8529534")));
  assert.equal(d.tier.hostExcluded, false); assert.equal(d.tier.attested, false);
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
});

test("draft v25 (staged) corrects E2: NOT complete, VTL2's report an inference on the debug image only, no report bytes, chain NOT established; no live field keeps the overstated wording", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-25.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, STAGED \(supersedes v24 as the staged package; staged after enclave-d1 released the box\)\. CORRECTS v23\/v24's E2 wording/);
  assert.match(d.profiles.vbs.measured.find((m) => /^NEXT MILESTONE/.test(m)), /FOUND BY SOURCE TRACE.*NOT run.*0x01400002.*0x01400001.*2900-byte blob.*CAPTURE ONLY.*PAUSED by enclave-5d.*NOT our DVD medium.*AK carries no trust here/);
  assert.match(d.files.find((x) => x.path === "control/vbslike-host.exe").source.checked, /RAN against a VM .*RUN OK.*A tooling result: not an isolation or attestation result/);
  assert.match(d.files.find((x) => x.path === "control/windows/vbslike/ops/uefi-dev-boot.ps1").note, /RAN for real .*NOT exercised: the kill path/);
  const all = JSON.stringify({ status: d.status, profiles: d.profiles, about: d.about });
  for (const bad of ["E2 RESOLVED", "WAS obtained", "VTL2 obtains the report", "VTL2 gets the report", "E2 RUN and RESOLVED", "RESOLVED by the debug kmsg"]) assert.ok(!all.includes(bad), `the overstated wording '${bad}' is still live`);
  const e2 = d.profiles.vbs.measured.find((m) => /^E2 NOT COMPLETE \(CORRECTED per enclave-d1 91f24619/.test(m));
  assert.ok(e2, "the corrected E2 entry is present");
  assert.match(e2, /the size of the attestation response 0 is too small to parse.*STRONGLY SUPPORTED BY INFERENCE.*DEBUG image 81e163ee ONLY.*No report bytes were captured.*No signature, signing key or root was identified or verified.*not access-denied.*E2 is NOT complete\. The customer chain is NOT established/);
  assert.match(d.profiles.vbs.measured.find((m) => /^E2 SOURCE READING BESIDE/.test(m)), /CLASSIFIED.*STRONGLY SUPPORTED BY INFERENCE.*DECIDED \(enclave-d1, 91f24619\): no boot for it now/);
  assert.match(d.profiles.vbs.measured.find((m) => /^NEXT MILESTONE/.test(m)), /CONFIG_TCG_TPM=y.*CONFIG_TCG_TIS=y, CONFIG_TCG_CRB=y.*NOT measured/);
  for (const f of ["uefi-dev-boot.ps1", "host-read-guest.ps1"]) assert.equal(d.files.find((x) => x.path === `control/windows/vbslike/ops/${f}`).from.git.commit.slice(0, 8), "29ea63e5");
  const l = d.files.find((x) => x.path === "control/vbslike-host.exe");
  assert.equal(l.sha256, "da16c20f6b16fb411293ae258ee4a7e6c37fa8dd2702c13e3cfa3b79f0fd157a", "the launcher is d1's post-build binary");
  assert.equal(l.bytes, 1117184); assert.ok(l.source.commit.startsWith("daa61749"));
  assert.match(l.note, /REQUIRED for coherence: the dev-boot script pinned at 29ea63e5 passes --isolation-type/);
  assert.ok(d.inputs.some((i) => i.name === "type1-isolation-91f24619.md" && i.from.git.commit.startsWith("91f24619")));
  assert.ok(d.inputs.some((i) => i.name === "PARAVISOR-ATTESTATION-CONTRACT-dd31cada.md" && /DESIGN ONLY.*Establishes nothing/.test(i.note)), "5d's contract is an input and says it is design only");
  assert.equal(d.tier.hostExcluded, false); assert.equal(d.tier.attested, false);
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
});

test("draft v26 (staged) pins d1's trust root at its stated strength and a BUILD-ONLY measured-VTL0 VBS candidate that never carries the confidential-debug flag and is never shipped", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-26.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, STAGED \(supersedes v25 as the staged package\)\. NEW IN v26/);
  const tr = d.tier.hostTrustRoot;
  assert.match(tr.verified[0], /replays to its TPM PCRs 0-14\. The PCRs were read LOCALLY, NOT in a signed quote/);
  assert.match(tr.verifiedGap.join(" "), /Secure Boot is OFF.*Test signing is ON.*CN=EnclaveTestSigning.*UNKNOWN/);
  assert.ok(tr.untested.some((x) => /HYPOTHESIS until real report bytes verify/.test(x)) && tr.untested.some((x) => /TPM quote/.test(x)));
  assert.match(tr.ruling, /REJECTION condition.*rejects its reports/);
  assert.equal(d.tier.hostExcluded, false); assert.equal(d.tier.attested, false);
  const c = d.profiles.vbs.measuredVtl0Candidate;
  assert.match(c.status, /^BUILD ONLY\. NOT BOOTED\. NOT ON THE BOX/);
  assert.match(c.components, /reproduces the control image's VBS launch digest 77C66160/);
  assert.ok(d.inputs.some((i) => i.name === "vbs-linux-candidate.bin" && i.role === "candidate.igvm" && i.sha256.startsWith("5562e71d")));
  assert.ok(!d.files.some((f) => f.role === "candidate.igvm" || f.sha256 === "5562e71d9ef5c0a4d3b577c943388900de4fc6352ef6a59905afe3ac6ef345ce"), "the candidate is a build input, never a shipped file");
  for (const f of ["windows/vbslike/verify/tcglog/tcglog.py", "windows/vbslike/ops/tpm-pcr-read.ps1"]) assert.ok(d.files.find((x) => x.path === `control/${f}`)?.from.git.commit.startsWith("6d4adb19"));
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   vbsLinux: the pinned IGVM carries exactly the required strings and none of the forbidden ones/);
  // the flag must never be accepted into the candidate's rules as allowed, and a candidate that carried it is refused
  const m = structuredClone(d); m.rebuild.vbsLinux.mustNotContain = ["OPENHCL_FORCE_LOAD_VTL0_IMAGE=linux"];
  const x = run(["verify", writeManifest(m)]);
  assert.equal(x.code, 1); assert.match(x.out, /FAIL vbsLinux: the pinned IGVM carries exactly the required strings and none of the forbidden ones: carries 'OPENHCL_FORCE_LOAD_VTL0_IMAGE=linux'/, fails(x.out));
});

test("draft v27 (staged) records the host change: boot 68 with Secure Boot ON, v26's trust root scoped to boot 67 and void for combination, every boot result marked pre-Secure-Boot", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-27.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, STAGED \(supersedes v26 as the staged package.*BOOT 68.*VOID for any same-boot combination/);
  assert.match(d.tier.hostTrustRoot.boot, /^67 .*VOID for any same-boot combination with boot 68/);
  const cur = d.tier.hostTrustRootCurrent;
  assert.match(cur.boot, /^68: the NucBox rebooted at 2026-09-25T05:32:35Z with Secure Boot ON/);
  assert.match(cur.verified.join(" "), /SecureBoot=01 in PCR 7, and TESTSIGNING=00.*read LOCALLY, NOT a signed quote/);
  assert.match(cur.reading, /conditions, not a verdict.*UNTESTED.*host_excluded=no/);
  assert.match(cur.customPathUnderSecureBoot, /^MEASURED .*WITH AllowFirmwareLoadFromFile set.*INVERSE CONTROL .*REFUSED: Worker-Admin 5142.*GATES loading our firmware/);
  assert.match(d.profiles.vbs.measured[1], /^UNDER SECURE BOOT, BOOT 68 .*FIRST OBSERVABLE: Start-VM ACCEPTED.*INVERSE CONTROL, canary 054616 .*REFUSED.*recorded, not relaxed/);
  assert.match(d.legacy.nodePackageNotes, /node-transport\.key .*NEVER packaged/);
  assert.equal(d.files.find((f) => f.path === "control/windows/vbslike/ops/uefi-dev-boot.ps1").from.git.commit.slice(0, 8), "a891dfae");
  for (const n of ["DIRECTION.md", "quote-20260925-053931/verdict.json", "quote-20260925-053931/quote.txt"]) assert.ok(d.inputs.some((i) => i.name === n && i.from.git.commit.startsWith("e97c967b")), n);
  for (const n of ["boot68-2026-09-25.md", "PROOF-CHECKLIST-a891dfae.md"]) assert.ok(d.inputs.some((i) => i.name === n && i.from.git.commit.startsWith("a891dfae")), n);
  assert.match(cur.serviceImpact, /ee-engine\.dll cannot load .*DOWN/);
  assert.match(d.tier.hostTrustRoot.ruling, /BOOT 67 failed it/);
  assert.match(d.profiles.vbs.measured[0], /^HOST CHANGED SINCE EVERY RESULT BELOW/);
  assert.equal(d.direction.words, "We should only be using Our new isolation implementation.");
  assert.match(d.legacy.status, /^LEGACY \/ UNSUPPORTED\. NOT A RECOVERY TARGET/);
  assert.match(d.files.find((f) => f.path === "control/windows/node/apprun.mjs").note, /^LEGACY \/ UNSUPPORTED, NOT A RECOVERY TARGET/);
  assert.match(cur.verified[0], /QUOTE with our own credential and nonce passes every relay TPM\/boot check, and 7\/7 negative controls are refused/);
  const dbg = d.inputs.find((i) => i.name === "vbs-linux-candidate-DEBUG-TRUSTS-HOST.bin");
  assert.ok(dbg && dbg.role === "probe.firmware" && dbg.sha256.startsWith("726d3cb5") && /^THIS FIRMWARE TRUSTS THE HOST COMMAND LINE/.test(dbg.note));
  assert.ok(!d.files.some((f) => f.sha256 === dbg.sha256), "the debug twin is never shipped");
  assert.deepEqual(d.rebuild.vbsLinuxDebug.args, ["--confidential-debug"]);
  assert.match(d.profiles.vbs.measuredVtl0Candidate.debugBuildFlagFinding, /debug_build=false for the confidential-debug images too.*cannot use debug_build/);
  assert.equal(d.tier.hostExcluded, false); assert.equal(d.tier.attested, false);
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   vbsLinuxDebug: the pinned IGVM carries exactly the required strings/);
  assert.match(r.out, /ok   vbsLinux: the pinned IGVM carries exactly the required strings and none of the forbidden ones/);
});

test("draft v28 (held; the handoff version) ships the static-line candidate and its debug twin, pins the offline mutation evidence, and carries the reference values; the rules refuse an eligible debug image, a wrong digest and a missing entry", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-28.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
  assert.match(d.status, /^DRAFT, HELD, NOT STAGED \(v27 7d1ff947 is the staged package; v28 is the HANDOFF version/);
  const c = d.profiles.vbs.measuredVtl0Candidate, cf = d.files.find((f) => f.path === c.file), tf = d.files.find((f) => f.path === c.debugTwinFile);
  assert.ok(cf && cf.role === "candidate.igvm" && cf.sha256 === "c567e43210ebd78c31273be47d9f4ca448f9a04cce276c40bc5d2abd6374d637");
  assert.ok(tf && tf.role === "probe.firmware" && tf.sha256 === "24e7a1ffbd8a87244eecc12a4f34f98e80da2e1658bf5c50604f122bf20ce9d3" && /PROBE/.test(tf.path));
  assert.ok(d.vmWorkerRead.includes(c.file) && d.vmWorkerRead.includes(c.debugTwinFile), "the VM worker may read both");
  assert.equal(d.rebuild.vbsLinux.mutations.length, 5);
  assert.equal(d.rebuild.vbsLinux.mutations.at(-1).expectVbsBootDigest, "246DEE1B6F2057F504EF3B0C422E081CB365B121E7D0C7BFE420B1A8946A89F0", "static_command_line=false reproduces the superseded candidate");
  assert.ok(!Object.values(d.profiles).some((p) => p.firmware === c.file || p.medium === c.file), "the candidate is no profile's firmware until a version records it booting");
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   reference values reference\/nucbox-vbs-reference\.json: .*\(5 images, 1 eligible\)/);
  const ref = refFor(D);
  const withRef = (mut) => { const m = structuredClone(d), x = structuredClone(ref); mut(x); const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vbsref-")), "ref.json"); fs.writeFileSync(p, JSON.stringify(x)); const f = m.files.find((f) => f.role === "reference.values"); f.from = { file: p }; f.sha256 = sha256(fs.readFileSync(p)); f.bytes = fs.statSync(p).size; return run(["verify", writeManifest(m)]); };
  let x = withRef((j) => { j.images.find((e) => e.id === "vbs-linux-candidate-debug-twin").eligible = true; });
  assert.equal(x.code, 1); assert.match(x.out, /FAIL reference values .*vbs-linux-candidate-debug-twin is marked eligible but is a confidential-debug image/, fails(x.out));
  x = withRef((j) => { j.images.find((e) => e.id === "vbs-linux-candidate").vbsBootDigest = "246DEE1B6F2057F504EF3B0C422E081CB365B121E7D0C7BFE420B1A8946A89F0"; });
  assert.equal(x.code, 1); assert.match(x.out, /FAIL reference values .*vbs-linux-candidate\.vbsBootDigest is "246DEE1B.*the pinned bytes give "A0FDAC0F/, fails(x.out));
  x = withRef((j) => { j.images = j.images.filter((e) => e.id !== "a7b0bd4-debug"); });
  assert.equal(x.code, 1); assert.match(x.out, /FAIL reference values .*openhcl-cvm-VBS-DEBUG-TRUSTS-HOST-81e163ee\.bin \(probe\.firmware\) has no reference entry/, fails(x.out));
});

test("draft v29 (staged) records the measured candidate's first boot AND first serving run verbatim as profile vbsLinux: served is not isolated, host_excluded=no, no chain", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-29.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT, STAGED \(supersedes v28, which was staged for the handoff\)\. THE MEASURED LINUX-VTL0 CANDIDATE BOOTS AND SERVES/);
  const p = d.profiles.vbsLinux;
  assert.match(p.status, /^EXPERIMENT: BOOTS AND SERVES/);
  assert.match(p.status, /Served is not isolated or attested: NO isolation claim; no report, no chain; host_excluded=no\./);
  assert.equal(p.firmware, d.profiles.vbs.measuredVtl0Candidate.file);
  assert.equal(d.files.find((f) => f.path === p.firmware).sha256, "c567e43210ebd78c31273be47d9f4ca448f9a04cce276c40bc5d2abd6374d637");
  assert.match(p.measured[0], /FIRST OBSERVABLE: Start-VM ACCEPTED.*'MON boundary tier=t0-hv vmpl=n\/a vmpl_floor=n\/a vmpl0=n\/a host_excluded=no hv_isolation=vbs paravisor=no'.*'MON ready control_port=9000 snp=false transport=hv_sock'/);
  assert.match(p.measured[1], /^WHAT THE BOOT SHOWS.*that run loaded no app/);
  // the serving run, verbatim from enclave-d1's 88f444b3, and what it does NOT establish
  assert.match(p.measured[2], /^SERVED: .*canary 062450.*evidence 88f444b3/);
  assert.match(p.measured[2], /'06:25:26 APP ANSWERED: 13 raw bytes, sha256 03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340'/);
  assert.match(p.measured[2], /'06:25:26 APP OK: the app served EXACTLY the pinned bytes through the guest's own TLS'/);
  assert.match(p.measured[2], /"boot":null/);
  assert.match(p.measured[2], /the --igvm-sha256 report path is built but was NOT exercised/);
  assert.match(p.measured[2], /identity \(curl accepted the guest's certificate; judge-hv's job\)/);
  assert.match(p.measured[3], /no report, no chain, host_excluded=no\.$/);
  assert.match(d.profiles.vbs.measuredVtl0Candidate.status, /^BOOTED AND SERVED/);
  // the launcher re-pinned to enclave-d1's post-build hash (8f156c9a), and the script that ran the canary
  const L = d.files.find((f) => f.path === "control/vbslike-host.exe");
  assert.equal(L.sha256, "0160d83511ec8dee2ca2da0f180050561f21b7ac884e62c7d5efe2e78baefea0"); assert.equal(L.bytes, 1126912);
  assert.equal(L.source.commit.slice(0, 8), "8f156c9a");
  assert.equal(d.files.find((f) => f.path === "control/windows/vbslike/ops/uefi-dev-boot.ps1").from.git.commit.slice(0, 8), "8f156c9a");
  for (const n of ["candidate-c567e432-review-88f444b3.md", "PROOF-CHECKLIST-88f444b3.md"])
    assert.ok(d.inputs.some((i) => i.name === n && i.from.git.commit.startsWith("88f444b3")), n);
  for (const n of ["wmiserve.rs", "launcher.rs"])
    assert.ok(d.inputs.some((i) => i.name === n && i.from.git.commit.startsWith("8f156c9a")), n);
  assert.ok(d.inputs.some((i) => i.name === "vbsdigest/src/main.rs" && i.from.git.commit.startsWith("5ae35c7d")));
  assert.match(d.owners.package, /^enclave-63 \(from enclave-53/);
  const ref = refFor(D);
  const c = ref.images.find((e) => e.id === "vbs-linux-candidate");
  assert.match(c.booted, /^yes: BOOTED .* SERVED .*NOT exercised; identity, any report or chain, and host exclusion are NOT established\.$/);
  assert.equal(c.eligible, true);
  assert.equal(d.tier.hostExcluded, false); assert.equal(d.tier.attested, false);
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   every quoted 'MON boundary' line says host_excluded=no/);
});

test("draft v30 ships the G1 measured-VTL0 candidate (a44bb55a, 58DFEBFE) and its debug twin, reviewed and NOT booted: no profile's firmware, not yet eligible", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-30.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT \(supersedes v29, which is staged at pkg\\dccc74a5135bf9c1\\\)\. THE G1 MEASURED-VTL0 CANDIDATE, BUILT AND REVIEWED, NOT BOOTED/);
  const CF = "guest/igvm-vbs/vbs-linux-candidate-g1-a44bb55a.bin", DF = "guest/igvm-vbs/PROBE-FIRMWARE-never-a-serving-candidate/vbs-linux-candidate-G1-DEBUG-TRUSTS-HOST-4991b3e1.bin";
  const c = d.files.find((f) => f.path === CF), t = d.files.find((f) => f.path === DF);
  assert.equal(c.role, "candidate.igvm"); assert.equal(c.sha256, "a44bb55a89bb0e6d2757287032070662041a0952eaf3713901cedc92404717e4");
  assert.equal(t.role, "probe.firmware"); assert.equal(t.sha256, "4991b3e13c7a6d4d75ac24ea3d68d7db7ded86ba14c2a25bb6773bd2e755505e");
  // not booted: no profile boots it, and the booted c567e432 stays profile vbsLinux's firmware
  for (const [n, p] of Object.entries(d.profiles)) for (const k of ["firmware", "image"]) assert.notEqual(p[k], CF, `${n}.${k}`);
  assert.equal(d.profiles.vbsLinux.firmware, "guest/igvm-vbs/vbs-linux-candidate-c567e432.bin");
  assert.match(d.profiles.vbs.g1Candidate.status, /^BUILT AND REVIEWED, NOT BOOTED/);
  // the recipe: c567e432's manifest and resources with ONLY linux_initrd swapped for 5d's G1+G3 initrd
  const a = d.rebuild.vbsLinux, g = d.rebuild.vbsLinuxG1;
  assert.equal(g.manifest, a.manifest); assert.deepEqual(g.twin, a.twin);
  assert.deepEqual({ ...g.resources, linux_initrd: a.resources.linux_initrd }, a.resources);
  assert.equal(g.resources.linux_initrd, "mon-680d40fa.cpio.gz");
  assert.equal(d.inputs.find((i) => i.name === "mon-680d40fa.cpio.gz").sha256, "680d40fa5c181e5434d8a44c0e8935914eb85347698b8799603cc5d4f6f3e35b");
  assert.deepEqual(g.mutations.map((m) => m.expectVbsBootDigest), ["C634A3347081D1A81E1711905CB5BA7C95925F88FD5EA70046B7369AD762F966", "CE9683FDC084F8FB4CD571439DDAB0C9D735ABDF28655DB60F839722D238CB72",
    "949562CF529E0E5CE0E9138B1D0E574082167681A9DFE2B225D429FCBC2D48E6", "0A2D658076E443C6EAC1A84BC9DFF7F1C047F94059A19F89AD70EDF829CE1DD2", "476F8FEAFA156BF84AFBF46EA5A505840D99752EC2E3507C6D9C6ED55C0E518C"]);
  assert.deepEqual(d.rebuild.vbsLinuxG1Debug.args, ["--confidential-debug"]);
  assert.ok(d.inputs.some((i) => i.name === "candidate-a44bb55a-review.md" && i.from.git.commit.startsWith("ce26bc6e")));
  // reference values: the G1 candidate listed but NOT eligible yet; exactly ONE eligible digest (c567e432's)
  const ref = refFor(D);
  const e = (id) => ref.images.find((x) => x.id === id);
  assert.equal(e("vbs-linux-candidate-g1").vbsBootDigest, "58DFEBFE5F46E5C0E371CE94C2AB947735EA618CF51F973FBBB58048D9C7343A"); assert.equal(e("vbs-linux-candidate-g1").eligible, false);
  assert.equal(e("vbs-linux-candidate-g1-debug-twin").confidentialDebug, true); assert.equal(e("vbs-linux-candidate-g1-debug-twin").eligible, false);
  assert.deepEqual(ref.images.filter((x) => x.eligible).map((x) => x.id), ["vbs-linux-candidate"]);
  assert.equal(d.tier.hostExcluded, false); assert.equal(d.tier.attested, false);
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
  // the G1 debug twin as a profile's firmware is refused (a probe firmware is never a profile's firmware)
  const m2 = structuredClone(d); m2.profiles.vbsLinux.firmware = DF; const x = run(["verify", writeManifest(m2)]);
  assert.equal(x.code, 1); assert.match(x.out, /vbsLinux\.firmware .*4991b3e1\.bin is probe\.firmware: a probe firmware is never a profile's firmware/, fails(x.out));
});

test("pkg.mjs: a not-yet-booted candidate IGVM cannot be a profile's firmware (the reference entry must record it booting)", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-30.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  const ok = run(["verify", D]);
  assert.equal(ok.code, 0, fails(ok.out));
  assert.match(ok.out, /ok   a candidate IGVM is a profile's firmware only once its reference entry records it booting \(1 profile use\(s\) of a candidate IGVM, each recorded as booted\)/);
  // the G1 candidate (reference: "no: ... not booted yet") made profile vbsLinux's firmware: refused by the rule
  const m2 = pinRef(structuredClone(d), refRawFor(D)); m2.profiles.vbsLinux.firmware = "guest/igvm-vbs/vbs-linux-candidate-g1-a44bb55a.bin";
  const x = run(["verify", writeManifest(m2)]);
  assert.equal(x.code, 1);
  assert.match(x.out, /FAIL a candidate IGVM is a profile's firmware only once its reference entry records it booting: vbsLinux\.firmware guest\/igvm-vbs\/vbs-linux-candidate-g1-a44bb55a\.bin is a candidate IGVM whose reference entry says booted "no: built by enclave-63/, fails(x.out));
});

test("draft v31 records the G1 candidate's canary (boots, serves, the per-boot nonce holds) and rolls over: a44bb55a is vbsLinux's firmware and the one eligible entry, c567e432 superseded and not shipped", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-31.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT \(supersedes v30, which is staged at pkg\\c3ebd7940216581e\\\)\. THE G1 CANDIDATE a44bb55a BOOTS, SERVES, AND ITS PER-BOOT NONCE HOLDS/);
  const CF = "guest/igvm-vbs/vbs-linux-candidate-g1-a44bb55a.bin";
  const p = d.profiles.vbsLinux;
  assert.equal(p.firmware, CF);
  assert.equal(p.debugTwin, "guest/igvm-vbs/PROBE-FIRMWARE-never-a-serving-candidate/vbs-linux-candidate-G1-DEBUG-TRUSTS-HOST-4991b3e1.bin");
  assert.match(p.identity, /^the VBS launch digest 58DFEBFE5F46E5C0E371CE94C2AB947735EA618CF51F973FBBB58048D9C7343A/);
  // the canary, verbatim from enclave-d1's 7b509d16
  const g = p.measured[0];
  assert.match(g, /^G1 CANARY: .*canary 070020.*evidence 7b509d16/);
  assert.match(g, /'CONSOLE: MON boot 39725c19e15c91afe488ce62251055f5'/);
  assert.match(g, /"boot":"39725c19e15c91afe488ce62251055f5","guestPort":40001,"id":1,"ok":true,"step":"load"/);
  assert.match(g, /'1\/3 destroy WITHOUT boot -> \{"bootRequired":true,.*app afterwards HTTP 200; '2\/3 destroy with a WRONG boot \(c76aeca5534a631588ded855f3242fc0\) -> \{"boot":"39725c19e15c91afe488ce62251055f5",.*"rebooted":true\}', app afterwards HTTP 200; '3\/3 destroy with the load answer's boot -> \{"destroyed":1\}', app afterwards HTTP 000/);
  assert.match(g, /'07:00:55 APP ANSWERED: 13 raw bytes, sha256 03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340'/);
  assert.match(g, /NOT COVERED \(enclave-d1\): the launcher's own rebooted:true handling .*and G4/);
  assert.match(g, /host_excluded=no\.$/);
  // the superseded image is no longer shipped or rebuilt
  assert.ok(!d.files.some((f) => /c567e432|24e7a1ff/.test(f.path)), "c567e432 and its twin are not shipped");
  assert.ok(!("vbsLinux" in d.rebuild) && !("vbsLinuxDebug" in d.rebuild) && "vbsLinuxG1" in d.rebuild && "vbsLinuxG1Debug" in d.rebuild);
  assert.equal(d.files.find((f) => f.path === "control/windows/vbslike/ops/uefi-dev-boot.ps1").from.git.commit.slice(0, 8), "95752533");
  for (const n of ["candidate-a44bb55a-review-7b509d16.md", "g1-canary-070020-uefi-dev-boot.txt", "g1-canary-070020-wmiserve.txt"])
    assert.ok(d.inputs.some((i) => i.name === n && i.from.git.commit.startsWith("7b509d16")), n);
  assert.match(d.profiles.vbs.g1Candidate.status, /^BOOTED, SERVED, AND THE G1 NONCE HOLDS/);
  assert.match(d.profiles.vbs.measuredVtl0Candidate.status, /^SUPERSEDED in v31 by the G1 candidate a44bb55a/);
  // reference values: the rollover in ONE version (enclave-99's rule): exactly one eligible, the old one superseded
  const ref = refFor(D);
  assert.deepEqual(ref.images.filter((x) => x.eligible).map((x) => [x.id, x.vbsBootDigest]), [["vbs-linux-candidate-g1", "58DFEBFE5F46E5C0E371CE94C2AB947735EA618CF51F973FBBB58048D9C7343A"]]);
  assert.match(ref.images.find((x) => x.id === "vbs-linux-candidate-g1").reason, /eligibility stays PROSPECTIVE/);
  const sup = ref.superseded.find((x) => x.id === "vbs-linux-candidate-c567e432");
  assert.equal(sup.vbsBootDigest, "A0FDAC0FC1EFB7B702D6DE1FACFAD8EB4E738DD35F3D3EE39AA0F5416BBCA244"); assert.equal(sup.eligible, false);
  assert.match(sup.reason, /superseded in v31 by the G1 candidate vbs-linux-candidate-g1 \(a44bb55a…, 58DFEBFE…\)\. It booted \(canary 061934\) and served \(canary 062450\), but no report was ever verified for it/);
  assert.ok(ref.superseded.some((x) => x.id === "vbs-linux-candidate-debug-twin-c567e432" && x.eligible === false));
  assert.equal(d.tier.hostExcluded, false); assert.equal(d.tier.attested, false);
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   a candidate IGVM is a profile's firmware only once its reference entry records it booting \(1 profile use\(s\) of a candidate IGVM, each recorded as booted\)/);
  // the same manifest with the G1 entry's boot record withdrawn is refused by the rule
  const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const x = structuredClone(ref); x.images.find((e) => e.id === "vbs-linux-candidate-g1").booted = "no: withdrawn";
  const rp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vbsref-")), "ref.json"); fs.writeFileSync(rp, JSON.stringify(x));
  const m2 = structuredClone(d), f = m2.files.find((y) => y.role === "reference.values"); f.from = { file: rp }; f.sha256 = sha256(fs.readFileSync(rp)); f.bytes = fs.statSync(rp).size;
  const y = run(["verify", writeManifest(m2)]);
  assert.equal(y.code, 1); assert.match(y.out, /FAIL a candidate IGVM is a profile's firmware only once its reference entry records it booting: vbsLinux\.firmware /, fails(y.out));
});

test("draft v32 ships enclave-d1's new launcher 15338081 BESIDE the pinned 0160d835 as a candidate.launcher (never a profile's launcher) and labels profile uefi pre-G1", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-32.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT \(supersedes v31, which is staged at pkg\\5e6b972e0451416a\\\)\. SHIPS enclave-d1's NEW LAUNCHER BUILD BESIDE THE PINNED ONE, AS A CANDIDATE/);
  const cand = d.files.filter((f) => f.role === "candidate.launcher"), pinned = d.files.filter((f) => f.role === "control.launcher");
  assert.equal(cand.length, 1); assert.equal(pinned.length, 1);
  assert.equal(cand[0].sha256, "15338081b81692a155130ec28e37fa654117a3e769427b621404fff3d6c6bca4"); assert.equal(cand[0].bytes, 1128448);
  assert.equal(cand[0].source.commit.slice(0, 8), "50010709");
  assert.equal(pinned[0].sha256, "0160d83511ec8dee2ca2da0f180050561f21b7ac884e62c7d5efe2e78baefea0");
  assert.match(pinned[0].note, /REPRODUCIBILITY \(enclave-d1, evidence 637b21c3\).*cc8707d7.*24 bytes different.*IDENTICAL/);
  assert.equal(d.profiles["hcs-dev"].launcher, pinned[0].path, "the profile keeps the pinned launcher");
  assert.equal(d.inputs.find((i) => i.name === "wmiserve-50010709.rs").sha256.slice(0, 16), "893f65bd773d50fa");
  assert.equal(d.inputs.find((i) => i.name === "Cargo.lock-637b21c3").sha256, "5c0ee1b7f9d70d1b9d6973dea54e8d8f9b9563117d1a8f97a8172ce29c96ad3b");
  assert.equal(d.profiles.uefi.label, "uefi-medium: pre-G1 monitor (initrd 0d14db23); no isolation claim possible (unmeasured medium); not a proof or serving candidate");
  assert.match(d.status, /NOT exercised: the stdin LIFETIME/);
  assert.equal(d.profiles.vbsLinux.firmware, "guest/igvm-vbs/vbs-linux-candidate-g1-a44bb55a.bin");
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   every profile's launcher is a control\.launcher \(a candidate\.launcher is never a profile's launcher\) \(1 profile launcher\(s\), 1 candidate launcher\(s\) shipped beside\)/);
  // the candidate made a profile's launcher is refused by the rule
  const m2 = pinRef(structuredClone(d), refRawFor(D)); m2.profiles["hcs-dev"].launcher = cand[0].path;
  const x = run(["verify", writeManifest(m2)]);
  assert.equal(x.code, 1);
  assert.match(x.out, /FAIL every profile's launcher is a control\.launcher .*hcs-dev\.launcher control\/candidate-launcher\/vbslike-host-15338081\.exe is candidate\.launcher/, fails(x.out));
});

test("pkg.mjs: a stated boot-form pair (profile.contract) must be exactly one of the verifier contract's canonical pairs (ae6e9147)", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-32.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  const verify = (mut) => { const m = pinRef(structuredClone(d), refRawFor(D)); mut(m); return run(["verify", writeManifest(m)]); };
  // canonical pairs, and null (not launched by wmiserve), pass
  let x = verify((m) => { m.profiles.vbsLinux.contract = { partition: "wmi-openhcl-gen2-igvm-linux", guestImageKind: "igvm-linux-direct", source: "ae6e9147" };
                          m.profiles.uefi.contract = { partition: "wmi-openhcl-gen2", guestImageKind: "uefi-medium" }; m.profiles["hcs-dev"].contract = null; });
  assert.equal(x.code, 0, fails(x.out)); assert.match(x.out, /ok   every stated boot-form pair .* \(2 stated pair\(s\)\)/);
  // a crossed pairing, a near-miss name and an unknown key are each refused
  for (const [c, why] of [[{ partition: "wmi-openhcl-gen2-igvm-linux", guestImageKind: "uefi-medium" }, "crossed"],
                          [{ partition: "wmi-openhcl-gen2", guestImageKind: "igvm-linux-direct" }, "crossed the other way"],
                          [{ partition: "wmi-openhcl-gen2-igvm", guestImageKind: "igvm-linux-direct" }, "near-miss name"],
                          [{ partition: "wmi-openhcl-gen2", guestImageKind: "uefi-medium", eligible: true }, "unknown key"]]) {
    x = verify((m) => { m.profiles.vbsLinux.contract = c; });
    assert.equal(x.code, 1, why); assert.match(x.out, /FAIL every stated boot-form pair .*vbsLinux\.contract .* is not exactly one canonical pair/, `${why}: ${fails(x.out)}`);
  }
});

test("draft v33 ships the G4 PROBE image (never a profile's firmware, never eligible), records the manager restart-recovery acceptance as a manager result only, and states each profile's boot-form pair", { skip }, () => {
  const D = path.join(HERE, "drafts/nucbox-ownguest-33.json"), d = JSON.parse(fs.readFileSync(D, "utf8"));
  assert.match(d.status, /^DRAFT \(supersedes v32, which is staged at pkg\\071f194b86a573ac\\\)\. THE G4 PROBE IMAGE, BUILT AND REVIEWED, NOT BOOTED/);
  const PF = "guest/igvm-vbs/PROBE-FIRMWARE-never-a-serving-candidate/PROBE-g4panic-72462737.bin";
  const f = d.files.find((x) => x.path === PF);
  assert.equal(f.role, "probe.firmware"); assert.equal(f.sha256, "724627378d81b51f0c56d7b22120162c11025961c678d2f2952ce7bb87a2bc1b");
  for (const [n, p] of Object.entries(d.profiles)) for (const k of ["firmware", "image"]) assert.notEqual(p[k], PF, `${n}.${k}`);
  assert.equal(d.rebuild.g4probe.resources.linux_initrd, "PROBE-g4panic-mon-e3b68c92.cpio.gz");
  assert.deepEqual({ ...d.rebuild.g4probe.resources, linux_initrd: d.rebuild.vbsLinuxG1.resources.linux_initrd }, d.rebuild.vbsLinuxG1.resources, "only the initrd differs from the G1 candidate");
  assert.equal(d.inputs.find((i) => i.name === "PROBE-g4panic-mon-e3b68c92.cpio.gz").sha256, "e3b68c926133aa62d7335bb49576417b65e32126d811971fc55cf9222b463898");
  assert.ok(d.inputs.some((i) => i.name === "candidate-probe-g4-72462737-review.md" && i.from.git.commit.startsWith("7ce0a5fa")));
  const ref = refFor(D), e = ref.images.find((x) => x.id === "g4-probe-72462737");
  assert.equal(e.class, "probe"); assert.equal(e.eligible, false); assert.equal(e.vbsBootDigest, "CF339BC5C89E5F160482553CFE61A2CD694B38EE7583A55B6B722DBA13271B0F");
  assert.deepEqual(ref.images.filter((x) => x.eligible).map((x) => x.id), ["vbs-linux-candidate-g1"], "still exactly one eligible image");
  // the manager acceptance is recorded with its scope, and the candidate launcher is NOT re-roled by it
  assert.match(d.profiles.vbsLinux.managerAcceptance, /^MANAGER RESTART-RECOVERY ACCEPTANCE on a44bb55a .*run 080420.*PASS A0-A6.*SCOPE \(enclave-d1\): a manager restart-recovery result only\. No vbslike-host\.exe ran/);
  assert.equal(d.files.find((x) => x.role === "candidate.launcher").sha256.slice(0, 8), "15338081");
  assert.equal(d.profiles["hcs-dev"].launcher, d.files.find((x) => x.role === "control.launcher").path);
  // the boot-form pairs, in the contract's vocabulary
  assert.deepEqual(Object.fromEntries(Object.entries(d.profiles).map(([n, p]) => [n, p.contract && [p.contract.partition, p.contract.guestImageKind]])),
    { "hcs-dev": null, igvm: null, uefi: ["wmi-openhcl-gen2", "uefi-medium"], vbsLinux: ["wmi-openhcl-gen2-igvm-linux", "igvm-linux-direct"], vbs: ["wmi-openhcl-gen2", "uefi-medium"] });
  const r = run(["verify", D]);
  assert.equal(r.code, 0, fails(r.out));
  assert.match(r.out, /ok   every stated boot-form pair .* \(3 stated pair\(s\)\)/);
  // the probe as a profile's firmware, or marked eligible, is refused
  let x = run(["verify", writeManifest(((m) => { m.profiles.vbsLinux.firmware = PF; return m; })(pinRef(structuredClone(d), refRawFor(D))))]);
  assert.equal(x.code, 1); assert.match(x.out, /a probe firmware is never a profile's firmware/, fails(x.out));
  const bad = structuredClone(ref); bad.images.find((y) => y.id === "g4-probe-72462737").eligible = true;
  x = run(["verify", writeManifest(pinRef(structuredClone(d), JSON.stringify(bad)))]);
  assert.equal(x.code, 1); assert.match(x.out, /g4-probe-72462737 is marked eligible but is class probe/, fails(x.out));
});
