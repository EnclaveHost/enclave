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
                            [11, /^DRAFT: the NEXT medium \(7b9b04d6.*NOT yet booted on the NucBox/],
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
  assert.ok(!d.files.find((f) => f.path === "guest/uefi/guest.iso").boxReuse, "a medium not yet on the box must not claim a box copy");
  assert.match(d.status, /NOT yet booted on the NucBox/);
  assert.ok(d.profiles.uefi.measured.some((m) => /MON ERROR no vsock transport/.test(m)), "the KVM refusal is recorded as the guard, not a boot");
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
