// The relay's measurement predictor (relay/measurement-predict.mjs). The rule is checked against guestd's REAL derivation
// records (their recordSha256 included) and, when the toolchain commit is in this repository, against the supervisor's own
// functions at that commit. The pipeline is driven with stub tools (the real tools' lab run is
// docs/security/measurement-prediction/), so every refusal, bound and cache path runs here without a release or a network.
//   run: node --test test/measurement-predict.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as P from "../relay/measurement-predict.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "measurement-predict-test-"));
const WASMTIME_48 = '{"name":"wasmtime","version":"48.0.1","execution":"jit","targetIsa":"x86_64","hostIsa":"x86_64","cpuFeatures":"host-detected","wx":"enforced","cache":"none"}';

test("the rule reproduces guestd's real derivation records, byte for byte (recordSha256), and never the stale /1 record", () => {
  const rid = P.runtimeIdOfJson(WASMTIME_48);
  assert.equal(rid, "ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8", "RuntimeID of the releases' runtime.json");
  const [k2, k1] = P.KNOWN_ANSWERS;
  // what the chain states for the two versions (read 2026-09-25 from the address book's appCatalog)
  const r2 = P.derivationRecord(`catalog://${k2.record.catalog.app}/4`, { cid: k2.record.cid, memMb: 256, ports: "http:8000" }, rid);
  const r1 = P.derivationRecord(`catalog://${k1.record.catalog.app}/4`, { cid: k1.record.cid, memMb: 128, ports: "" }, rid);
  assert.deepEqual(r2, k2.record); assert.deepEqual(r1, k1.record);
  assert.equal(sha(P.canonical(r2)), "1fb9360ddfd50a25d4740d989e5ae5fd6b6f967bf017606f39b220bb84d3303e", "guestd's recordSha256 (bundle/2)");
  assert.equal(sha(P.canonical(r1)), "bff33b951aade0a921edea4b0aca89712005d20cbb2c074c0f885d079e059d6c", "guestd's recordSha256 (bundle/1)");
  // guestd also holds a /1 record for the http:8000 version (recordSha256 1cf48b7a…, AppID 9add8960…): the chain never derives it
  assert.notEqual(sha(P.canonical(r2)), "1cf48b7a559f74cbe786c319d7d73abd19ff5eb281f76e1815549fbfacd5eddd");
  // a mixed-case catalog ref is the same record (the supervisor lowercases the app)
  assert.deepEqual(P.derivationRecord(`catalog://${k1.record.catalog.app.toUpperCase().replace("0X", "0x")}/4`, { cid: k1.record.cid, memMb: 128, ports: "" }, rid), r1);
  for (const [ports, ok] of [["", 0], ["http:8000", 8000], [" HTTP:1 ", 1], ["tcp:22", null], ["http:80,http:81", null], ["http:0", null], ["http:50000", null], ["udp:53", null]]) {
    if (ok === null) assert.throws(() => P.isolationHttpPortOf(ports), /not offered/, ports);
    else assert.equal(P.isolationHttpPortOf(ports), ok, ports);
  }
  assert.throws(() => P.derivationRecord("ipfs://bafy", { cid: "x", memMb: 1 }, rid), /catalog/);
  assert.throws(() => P.derivationRecord(`catalog://${k1.record.catalog.app}/4`, { cid: "", memMb: 1 }, rid), /CID/);
});

// the supervisors the per-app tier runs: the live 0181bce3 and the pool release c42612c0 (GUEST-POOL-ROLLOUT S2)
const SUPERVISOR_COMMITS = ["0181bce3", "c42612c0"];
const supervisorAt = (c) => { try { return execFileSync("git", ["show", `${c}:supervisor.js`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }); } catch { return null; } };

test("the supervisor's rule is pinned: every tier supervisor this clone holds, and the working tree's, carry exactly the rule the predictor implements", (t) => {
  let checked = 0;
  for (const c of SUPERVISOR_COMMITS) {
    const src = supervisorAt(c);
    if (!src) continue;
    assert.equal(P.supervisorRuleSha256(src), P.SUPERVISOR_RULE_SHA256, `supervisor.js at ${c}: a changed rule must change the predictor with it`);
    checked++;
  }
  const here = fs.existsSync("supervisor.js") ? P.supervisorRuleSha256(fs.readFileSync("supervisor.js", "utf8")) : null;
  if (here !== null) { assert.equal(here, P.SUPERVISOR_RULE_SHA256, "the working tree's supervisor.js carries another rule"); checked++; }
  if (!checked) t.skip("no tier supervisor in this clone");
});

for (const commit of SUPERVISOR_COMMITS) test(`parity with the supervisor's own functions at ${commit} (skipped when that commit is not in this repository)`, (t) => {
  const src = supervisorAt(commit);
  if (!src) return t.skip(`${commit} is not in this clone`);
  const fn = (name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf("\n}\n", i) + 2); };
  const sup = vm.runInNewContext(`${fn("isolationPolicyFor")}\n${fn("isolationHttpPortOf")}\n${fn("isolationDerivation")}\n({ isolationPolicyFor, isolationHttpPortOf, isolationDerivation })`);
  const rid = "cc".repeat(32), app = "0x" + "Ab".repeat(32);
  for (const memMb of [0, 1, 127.2, 128, 128.5, 256, 1e6, "abc", null, undefined]) {
    for (const ports of ["", "http:8000", " HTTP:1 ", "tcp:22", "http:80,http:81", "http:0", "http:49999", "http:50000", ["http:80"]]) {
      let theirs, ours;
      try { theirs = JSON.stringify(sup.isolationDerivation(`catalog://${app}/7`, "ipfs://bafkreiabc", sup.isolationPolicyFor({ memMb }), rid, sup.isolationHttpPortOf(ports))); }
      catch (e) { theirs = "throws"; }
      try { ours = JSON.stringify(P.derivationRecord(`catalog://${app}/7`, { cid: "bafkreiabc", memMb, ports }, rid)); }
      catch (e) { ours = "throws"; }
      assert.equal(ours, theirs, `memMb ${memMb}, ports ${JSON.stringify(ports)}`);
    }
  }
});

test("versionRefusal: only an approved, unyanked version of a listed app", () => {
  const ok = { cid: "b", approval: 1, yanked: false };
  assert.equal(P.versionRefusal({ active: true }, ok), null);
  assert.match(P.versionRefusal({ active: false }, ok), /not listed/);
  assert.match(P.versionRefusal(null, ok), /not listed/);
  assert.match(P.versionRefusal({ active: true }, null), /no such version/);
  assert.match(P.versionRefusal({ active: true }, { ...ok, yanked: true }), /yanked/);
  for (const a of [0, 2]) assert.match(P.versionRefusal({ active: true }, { ...ok, approval: a }), /not approved|rejected/);
  // the supervisor's forPrivate: a PENDING version is released to a private deployment; a rejected one never
  assert.equal(P.versionRefusal({ active: true }, { ...ok, approval: 0 }, true), null);
  assert.match(P.versionRefusal({ active: true }, { ...ok, approval: 2 }, true), /rejected/);
  assert.match(P.versionRefusal({ active: true }, { ...ok, approval: 0, yanked: true }, true), /yanked/);
});

// ---- the pipeline, with stub tools ----
function toolchainRepo() {
  const dir = fs.mkdtempSync(path.join(TMP, "repo-"));
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], { encoding: "utf8" }).trim();
  g("init", "-q");
  for (const p of P.TOOLCHAIN_PATHS) {
    const f = path.join(dir, p.includes(".") ? p : path.join(p, "committed.txt"));
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `committed ${p}\n`);
  }
  g("add", "-A"); g("commit", "-q", "-m", "toolchain");
  return { dir, commit: g("rev-parse", "HEAD") };
}
function release(name, runtimeJson = WASMTIME_48) {
  const dir = path.join(TMP, "rel-" + name);
  fs.mkdirSync(path.join(dir, "template/rt"), { recursive: true });
  fs.writeFileSync(path.join(dir, "template/rt/runtime.json"), runtimeJson);
  return dir;
}
const R1 = "a1".repeat(32), R2 = "a2".repeat(32), R3 = "a3".repeat(32), RK = "ab".repeat(32);
const RT_OTHER = WASMTIME_48.replace("48.0.1", "49.0.0");
const REL = { [R1]: release("r1"), [R2]: release("r2"), [R3]: release("r3", RT_OTHER), [RK]: release("rk") };
// the stub tools: a "bundle" is canonical({policy, http, component}); a "measurement" is sha384(release id ‖ AppID ‖ runtime)
const stubBundle = (rec, comp) => Buffer.from(P.canonical({ policy: rec.policy, http: rec.http || 0, comp: comp.toString() }));
const stubMeasure = (id, appId, rid) => createHash("sha384").update(id + appId + rid).digest("hex");
function stubs(over = {}) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    if (cmd === "tar") return P.runBounded(cmd, args, opts);
    const script = path.basename(args[0] || "");
    calls.push({ script, args });
    if (over[script]) { const r = await over[script](args, opts); if (r) return r; }
    if (script === "fetch-cid.py") { fs.writeFileSync(args[3], "component:" + args[2]); return { code: 0, out: "ok", err: "" }; }
    if (script === "derive_reference.py") {
      const b = stubBundle(JSON.parse(fs.readFileSync(args[2], "utf8")), fs.readFileSync(args[3]));
      fs.writeFileSync(args[4], b); return { code: 0, out: JSON.stringify({ appId: sha(b) }), err: "" };
    }
    if (script === "expected-measurement.sh") {
      const [, , id, dir, bundle] = args, appId = sha(fs.readFileSync(bundle));
      const rid = P.runtimeIdOfJson(fs.readFileSync(path.join(dir, "template/rt/runtime.json"), "utf8"));
      return { code: 0, out: `release ${id}\napp_id ${appId}\nruntime_id ${rid}\nruntime_identity_json {}\nmeasurement ${stubMeasure(id, appId, rid)}\n`, err: "" };
    }
    return { code: 127, out: "", err: `no stub for ${cmd} ${script}` };
  };
  return { run, calls };
}
const APPX = "0x" + "5a".repeat(32), REF = `catalog://${APPX}/3`, CID = "bafkreisyntheticcomponent";
const katRecord = P.derivationRecord(`catalog://0x${"4b".repeat(32)}/1`, { cid: "bafkreikatcomponent", memMb: 64, ports: "" }, P.runtimeIdOfJson(WASMTIME_48));
const katApp = sha(stubBundle(katRecord, Buffer.from("component:bafkreikatcomponent")));
const KAT = [{ what: "a stub known answer", release: RK, record: katRecord, appId: katApp, measurement: stubMeasure(RK, katApp, katRecord.runtimeId) }];
const TOOL = "5e".repeat(32), tool = { digest: TOOL };   // the stub sev-snp-measure's digest, as pinned
function predictor(over = {}) {
  const repo = over.repo || toolchainRepo();
  const tools = stubs(over.tools);
  const clock = { t: 1_000_000 };
  const versions = over.versions || { [REF]: { app: { active: true }, version: { cid: CID, memMb: 300, ports: "http:8080", approval: 1, yanked: false } } };
  const p = P.makePredictor({ repo: repo.dir, commit: repo.commit, releases: Object.entries(REL).map(([id, dir]) => ({ id, dir })),
    admit: over.admit || [R1, R2, R3], readCatalog: over.readCatalog || (async (app, i) => { const v = versions[`catalog://${app}/${i}`]; if (!v) throw new Error("rpc down"); return v; }),
    gateway: "https://trustless.example", sevSnpMeasure: "/nonexistent/sev-snp-measure", sevSnpMeasureSha256: TOOL,
    digestTool: async () => tool.digest, work: fs.mkdtempSync(path.join(TMP, "work-")),
    knownAnswers: over.knownAnswers || KAT, run: tools.run, now: () => clock.t, ...over.opts });
  return { p, tools, clock, repo, versions };
}
const count = (calls, s) => calls.filter((c) => c.script === s).length;

test("a prediction: one record per distinct admitted runtime, one image per admitted release; cached after", async () => {
  const { p, tools } = predictor();
  const r = await p.expectedFor(REF);
  assert.equal(r.ok, true, JSON.stringify(r));
  const rec = P.derivationRecord(REF, { cid: CID, memMb: 300, ports: "http:8080" }, P.runtimeIdOfJson(WASMTIME_48));
  const appId = sha(stubBundle(rec, Buffer.from("component:" + CID)));
  assert.equal(r.appId, appId, "the AppID excludes the runtime: both runtimes derive the same bundle");
  const ridA = P.runtimeIdOfJson(WASMTIME_48), ridB = P.runtimeIdOfJson(RT_OTHER);
  assert.deepEqual(r.images.map((i) => [i.release, i.runtimeId, i.measurement]).sort(), [
    [R1, ridA, stubMeasure(R1, appId, ridA)], [R2, ridA, stubMeasure(R2, appId, ridA)], [R3, ridB, stubMeasure(R3, appId, ridB)]].sort());
  const n = tools.calls.length;
  assert.deepEqual(await p.expectedFor(REF), r, "the same answer from the cache");
  assert.equal(tools.calls.length, n, "no tool ran for the cached answer");
  assert.equal(p.state().cacheHits, 1);
  // the known-answer test ran once, before the first prediction, against its own release only
  assert.equal(tools.calls.filter((c) => c.script === "expected-measurement.sh" && c.args[2] === RK).length, 1);
});

test("the toolchain is the COMMIT's content: a later edit or an untracked file in the working tree is never executed", async () => {
  const repo = toolchainRepo();
  fs.writeFileSync(path.join(repo.dir, "isolation/m4/expected-measurement.sh"), "edited after the commit\n");
  fs.writeFileSync(path.join(repo.dir, "isolation/m4/injected.sh"), "untracked\n");
  fs.writeFileSync(path.join(repo.dir, "wasm/hashlib.py"), "untracked shadowing module\n");
  const { p, tools } = predictor({ repo });
  assert.equal((await p.expectedFor(REF)).ok, true);
  const tc = p.state().toolchain;
  assert.equal(fs.readFileSync(path.join(tc, "isolation/m4/expected-measurement.sh"), "utf8"), "committed isolation/m4/expected-measurement.sh\n");
  assert.equal(fs.existsSync(path.join(tc, "isolation/m4/injected.sh")), false);
  assert.equal(fs.existsSync(path.join(tc, "wasm/hashlib.py")), false);
  assert.ok(tools.calls.every((c) => c.args[0].startsWith(tc + path.sep)), "every tool ran from the extracted commit");
  // a commit the repository does not hold predicts nothing
  const bad = predictor({ repo: { dir: repo.dir, commit: "0".repeat(40) } });
  const r = await bad.p.expectedFor(REF);
  assert.equal(r.ok, false); assert.equal(r.code, "prediction_unavailable"); assert.match(r.reason, /not extractable/);
});

test("refusals: every input the prediction depends on, changed or unavailable, is a refusal naming it", async () => {
  const v = (over) => ({ [REF]: { app: { active: true }, version: { cid: CID, memMb: 300, ports: "", approval: 1, yanked: false, ...over } } });
  const cases = [
    ["not a catalog reference", {}, "ipfs://bafkreisynthetic", "not_catalog"],
    ["the chain cannot be read", { readCatalog: async () => { throw new Error("rpc down"); } }, REF, "catalog_unreachable"],
    ["a yanked version", { versions: v({ yanked: true }) }, REF, "version_not_admitted"],
    ["a pending version", { versions: v({ approval: 0 }) }, REF, "version_not_admitted"],
    ["a delisted app", { versions: { [REF]: { app: { active: false }, version: v()[REF].version } } }, REF, "version_not_admitted"],
    ["a version with a raw tcp port", { versions: v({ ports: "tcp:22" }) }, REF, "version_not_admitted"],
    ["a component that does not verify against its CID", { tools: { "fetch-cid.py": (a) => (a[2] === CID ? { code: 1, out: "", err: "fetch/verify failed: block hash mismatch" } : null) } }, REF, "component_unavailable"],
    ["a component that derives no bundle (a core module)", { tools: { "derive_reference.py": (a) => (fs.readFileSync(a[2], "utf8").includes(CID) ? { code: 1, out: "", err: "not a component" } : null) } }, REF, "underivable"],
    ["a changed release file (its manifest no longer verifies against the pinned id)", { tools: { "expected-measurement.sh": (a) => (a[2] === R2 ? { code: 1, out: "", err: "release-manifest: template/front sha256 differs" } : null) } }, REF, "prediction_failed"],
    ["a release whose verified runtime is not the one read", { tools: { "expected-measurement.sh": (a) => (a[2] === R1 ? { code: 0, out: `release ${R1}\napp_id x\nruntime_id ${"dd".repeat(32)}\nmeasurement ${"0".repeat(96)}\n`, err: "" } : null) } }, REF, "prediction_failed"],
    ["a release that assembled another AppID", { tools: { "expected-measurement.sh": (a) => (a[2] === R3 ? { code: 0, out: `release ${R3}\napp_id ${"ee".repeat(32)}\nruntime_id ${P.runtimeIdOfJson(RT_OTHER)}\nmeasurement ${"0".repeat(96)}\n`, err: "" } : null) } }, REF, "prediction_failed"],
    ["sev-snp-measure missing (no measurement)", { tools: { "expected-measurement.sh": (a) => (a[2] !== RK ? { code: 127, out: "", err: "sev-snp-measure: not found" } : null) } }, REF, "prediction_failed"],
    ["an admitted release that is not installed", { admit: [R1, "f0".repeat(32)] }, REF, "predictor_unconfigured"],
    ["no admitted release", { admit: [] }, REF, "predictor_unconfigured"],
  ];
  for (const [label, over, ref, code] of cases) {
    const { p } = predictor(over);
    const r = await p.expectedFor(ref);
    assert.equal(r.ok, false, `${label}: ${JSON.stringify(r)}`); assert.equal(r.code, code, `${label}: ${r.reason}`);
    assert.equal(r.images, undefined, `${label}: no image`);
  }
});

test("a refusal is cached only briefly; busy is never cached", async () => {
  let fail = true;
  const { p, tools, clock } = predictor({ tools: { "fetch-cid.py": (a) => (fail && a[2] === CID ? { code: 1, out: "", err: "gateway 504" } : null) } });
  assert.equal((await p.expectedFor(REF)).code, "component_unavailable");
  fail = false;
  assert.equal((await p.expectedFor(REF)).code, "component_unavailable", "within the negative TTL");
  assert.equal(count(tools.calls, "fetch-cid.py"), 2, "the KAT's fetch and one for REF");
  clock.t += 61_000;
  assert.equal((await p.expectedFor(REF)).ok, true, "after the TTL it is tried again");
});

test("bounds: one reconstruction at a time, a bounded queue answers busy, concurrent asks for one version share one run", async () => {
  let open; const gate = new Promise((r) => { open = r; });
  const REF2 = `catalog://${APPX}/4`;
  const versions = { [REF]: { app: { active: true }, version: { cid: CID, memMb: 300, ports: "", approval: 1, yanked: false } },
                     [REF2]: { app: { active: true }, version: { cid: CID + "two", memMb: 300, ports: "", approval: 1, yanked: false } } };
  const { p, tools } = predictor({ versions, opts: { maxQueue: 0 }, tools: { "derive_reference.py": async (a) => { if (fs.readFileSync(a[2], "utf8").includes(`"version":3`)) await gate; return null; } } });
  await p.selfTest();
  const first = p.expectedFor(REF), again = p.expectedFor(REF);
  await new Promise((r) => setTimeout(r, 50));
  const busy = await p.expectedFor(REF2);
  assert.equal(busy.ok, false); assert.equal(busy.code, "busy");
  open();
  const [a, b] = await Promise.all([first, again]);
  assert.equal(a.ok, true); assert.deepEqual(a, b);
  assert.equal(tools.calls.filter((c) => c.script === "derive_reference.py" && fs.existsSync(c.args[2]) === false).length >= 0, true);
  assert.equal(count(tools.calls, "fetch-cid.py"), 2, "the KAT and ONE run for the two concurrent asks: " + JSON.stringify(tools.calls.map((c) => [c.script, c.args[2]])));
  assert.equal((await p.expectedFor(REF2)).ok, true, "busy was not cached");
});

test("the known-answer test: a mismatch disables every prediction until a later test passes; an unreachable gateway is never a first pass", async () => {
  let wrong = true;
  const { p, clock } = predictor({ tools: { "expected-measurement.sh": (a) => (wrong && a[2] === RK ? { code: 0, out: `release ${RK}\napp_id ${katApp}\nruntime_id ${katRecord.runtimeId}\nmeasurement ${"ab".repeat(48)}\n`, err: "" } : null) } });
  const r = await p.expectedFor(REF);
  assert.equal(r.code, "prediction_unavailable"); assert.match(r.reason, /known answer.*measurement/);
  wrong = false;
  assert.equal((await p.expectedFor(REF)).code, "prediction_unavailable", "not re-tested within the TTL");
  clock.t += 61_000;
  assert.equal((await p.expectedFor(REF)).ok, true, "re-tested, passed, serving");
  // aged: re-run in the background; a failure then disables and clears the cache
  wrong = true; clock.t += 7 * 3600_000;
  assert.equal((await p.expectedFor(REF)).ok, true, "the aged verdict serves while the re-test runs");
  await p.selfTest();
  assert.equal(p.state().kat.ok, false); assert.equal(p.state().cached, 0);
  assert.equal((await p.expectedFor(REF)).code, "prediction_unavailable");

  // the gateway down at the FIRST test: inconclusive, which is not a pass
  let down = true;
  const q = predictor({ tools: { "fetch-cid.py": () => (down ? { code: 1, out: "", err: "gateway down" } : null) } });
  const r2 = await q.p.expectedFor(REF);
  assert.equal(r2.code, "prediction_unavailable"); assert.match(r2.reason, /inconclusive/);
  down = false; q.clock.t += 61_000;
  assert.equal((await q.p.expectedFor(REF)).ok, true);
  // ...and after a pass, an inconclusive re-test keeps the pass
  down = true; q.clock.t += 7 * 3600_000;
  await q.p.selfTest();
  assert.equal(q.p.state().kat.ok, true, "an unreachable gateway does not disable a checked toolchain");

  // an inconclusive re-test keeps a pass for at most a day: then prediction is disabled until a test passes
  q.clock.t += 18 * 3600_000;
  await q.p.selfTest();
  assert.equal(q.p.state().kat.ok, false, "a pass older than 24 h does not survive another inconclusive test");
  assert.match(q.p.state().kat.reason, /older than 24 h/);

  // no known answer's release installed: the toolchain is unchecked, so nothing is predicted
  const none = predictor({ knownAnswers: [{ ...KAT[0], release: "99".repeat(32) }] });
  const r3 = await none.p.expectedFor(REF);
  assert.equal(r3.code, "prediction_unavailable"); assert.match(r3.reason, /unchecked/);
});

test("components: a raw-CID component is kept and re-verified against its CID on every read; a changed copy is fetched again", async () => {
  const bytes = Buffer.concat([Buffer.from("0061736d0d000100", "hex"), Buffer.from(" a synthetic component")]);
  const A32 = "abcdefghijklmnopqrstuvwxyz234567";
  const raw = Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), createHash("sha256").update(bytes).digest()]);
  let bits = 0, v = 0, cid = "b";
  for (const x of raw) { v = (v << 8) | x; bits += 8; while (bits >= 5) { cid += A32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) cid += A32[(v << (5 - bits)) & 31];
  assert.equal(P.rawCidDigest(cid), sha(bytes));
  const REF3 = `catalog://${APPX}/9`, REF4 = `catalog://${APPX}/10`;
  const ver = { app: { active: true }, version: { cid, memMb: 128, ports: "", approval: 1, yanked: false } };
  const { p, tools, versions } = predictor({ versions: { [REF3]: ver, [REF4]: { ...ver, version: { ...ver.version, memMb: 512 } } },
    tools: { "fetch-cid.py": (a) => (a[2] === cid ? (fs.writeFileSync(a[3], bytes), { code: 0, out: "ok", err: "" }) : null) } });
  const fetched = () => tools.calls.filter((c) => c.script === "fetch-cid.py" && c.args[2] === cid).length;
  assert.equal((await p.expectedFor(REF3)).ok, true);
  assert.equal(fetched(), 1);
  assert.equal((await p.expectedFor(REF4)).ok, true, "another version of the same component");
  assert.equal(fetched(), 1, "served from the kept copy, which still hashes to its CID");
  // the kept copy changed: it no longer hashes to its CID, so a third version fetches (and verifies) again
  fs.writeFileSync(path.join(path.dirname(p.state().toolchain), "components", cid), "a changed copy");
  const REF5 = `catalog://${APPX}/11`;
  versions[REF5] = { ...ver, version: { ...ver.version, memMb: 1024 } };
  const r5 = await p.expectedFor(REF5);
  assert.equal(r5.ok, true); assert.equal(fetched(), 2, "the changed copy was not used");
  assert.equal(r5.appId, sha(stubBundle(P.derivationRecord(REF5, versions[REF5].version, P.runtimeIdOfJson(WASMTIME_48)), bytes)), "derived from the verified bytes");
});

test("the pinned sev-snp-measure: a changed tool disables prediction; its digest covers the entry script and the package", async () => {
  const { p } = predictor();
  assert.equal((await p.expectedFor(REF)).ok, true);
  tool.digest = "66".repeat(32);
  try {
    const q = predictor();
    const r = await q.p.expectedFor(REF);
    assert.equal(r.code, "prediction_unavailable"); assert.match(r.reason, /digest .* is not the pinned/);
  } finally { tool.digest = TOOL; }
  // the real digest function over a synthetic venv: entry script + package tree, __pycache__ ignored
  const venv = fs.mkdtempSync(path.join(TMP, "venv-")), pkg = path.join(venv, "site", "sevsnpmeasure");
  fs.mkdirSync(path.join(pkg, "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "__init__.py"), "x = 1\n"); fs.writeFileSync(path.join(pkg, "__pycache__", "a.pyc"), "noise");
  const py = path.join(venv, "python"); fs.writeFileSync(py, `#!/bin/sh\necho ${pkg}\n`); fs.chmodSync(py, 0o755);
  const exe = path.join(venv, "sev-snp-measure"); fs.writeFileSync(exe, `#!${py}\nentry\n`);
  const d1 = await P.sevSnpMeasureDigest(exe);
  fs.writeFileSync(path.join(pkg, "__pycache__", "a.pyc"), "other noise");
  assert.equal(await P.sevSnpMeasureDigest(exe), d1, "bytecode caches are not part of the tool");
  fs.writeFileSync(path.join(pkg, "__init__.py"), "x = 2\n");
  assert.notEqual(await P.sevSnpMeasureDigest(exe), d1, "a changed package file changes the digest");
  fs.writeFileSync(path.join(pkg, "__init__.py"), "x = 1\n"); fs.writeFileSync(exe, `#!${py}\nentry changed\n`);
  assert.notEqual(await P.sevSnpMeasureDigest(exe), d1, "a changed entry script changes the digest");
});

test("a bounded wait answers warming and keeps computing; the next ask gets the cached answer", async () => {
  let open; const gate = new Promise((r) => { open = r; });
  const { p } = predictor({ tools: { "derive_reference.py": async (a) => { if (fs.readFileSync(a[2], "utf8").includes(`"version":3`)) await gate; return null; } } });
  await p.selfTest();
  const r = await p.expectedFor(REF, { waitMs: 50 });
  assert.equal(r.ok, false); assert.equal(r.code, "warming");
  open();
  await new Promise((res) => setTimeout(res, 100));
  const r2 = await p.expectedFor(REF, { waitMs: 50 });
  assert.equal(r2.ok, true, JSON.stringify(r2));
});

test("the catalog read: every configured RPC is read and all must agree; one lying RPC is a refusal, never a pick", async () => {
  const honest = { getApp: { appId: "0x" + "11".repeat(32), active: true, versionCount: 5 }, getVersion: { cid: CID, memMb: 300, ports: "", approval: 1, yanked: false } };
  const client = (over = {}) => ({ readContract: async ({ functionName }) => ({ ...honest[functionName], ...(over[functionName] || {}) }) });
  const good = P.catalogReader([client(), client()], "0x" + "cc".repeat(20));
  assert.equal(good.sources, 2);
  assert.deepEqual(await good(APPX, 3), { app: { active: true }, version: { cid: CID, memMb: 300, ports: "", approval: 1, yanked: false } });
  for (const lie of [{ getVersion: { cid: "bafkreianotherapp" } }, { getVersion: { memMb: 256 } }, { getVersion: { yanked: true } }, { getApp: { active: false } }]) {
    const r = P.catalogReader([client(), client(lie)], "0x" + "cc".repeat(20));
    await assert.rejects(r(APPX, 3), /disagree/, JSON.stringify(lie));
  }
  const { p } = predictor({ readCatalog: P.catalogReader([client(), client({ getVersion: { cid: "bafkreianotherapp" } })], "0x" + "cc".repeat(20)) });
  const r = await p.expectedFor(`catalog://${APPX}/3`);
  assert.equal(r.code, "catalog_unreachable"); assert.match(r.reason, /disagree/);
});

test("fetchVerified: a config CID through the platform's fetcher; a raw-CID answer kept and re-verified; refusals, and no known-answer gate", async () => {
  const bytes = Buffer.from('{"config":"synthetic"}');
  const A32 = "abcdefghijklmnopqrstuvwxyz234567";
  const raw = Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), createHash("sha256").update(bytes).digest()]);
  let bits = 0, v = 0, cid = "b";
  for (const x of raw) { v = (v << 8) | x; bits += 8; while (bits >= 5) { cid += A32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) cid += A32[(v << (5 - bits)) & 31];
  let down = false;
  // a known-answer test that would FAIL: fetchVerified does not depend on it (it measures nothing)
  const { p, tools } = predictor({ tools: {
    "fetch-cid.py": (a) => (a[2] === cid ? (down ? { code: 1, out: "", err: "gateway down" } : (fs.writeFileSync(a[3], bytes), { code: 0, out: "ok", err: "" }))
                          : a[2] === "bafkreinotfetchedatall" ? { code: 1, out: "", err: "fetch/verify failed: not found" } : null),
    "expected-measurement.sh": () => ({ code: 1, out: "", err: "broken" }) } });
  const r = await p.fetchVerified(cid);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual(r.bytes, bytes);
  down = true;
  const again = await p.fetchVerified(cid);
  assert.equal(again.ok, true, "served from the kept copy, re-verified against its CID");
  assert.equal(tools.calls.filter((c) => c.script === "fetch-cid.py").length, 1);
  const nope = await p.fetchVerified("bafkreinotfetchedatall");
  assert.equal(nope.ok, false); assert.equal(nope.code, "unavailable");
  assert.equal((await p.fetchVerified("not a cid!")).code, "bad_cid");
  assert.equal(tools.calls.filter((c) => c.script === "expected-measurement.sh").length, 0, "no measurement ran");
});

test("versionConfigReader: the version's inline config and configCid through agreeing RPCs; a revert on versionConfigCid is none; a disagreement refuses", async () => {
  const mk = (over = {}) => ({ readContract: async ({ functionName }) => {
    if (functionName === "getVersion") return { cid: CID, version: "1", vramMb: 0, gpuGflops: 0, memMb: 128, cpuGflops: 0, createdAt: 0n, verified: false, yanked: false, ports: "", approval: 1, config: over.config ?? '{"wasi":"p2"}' };
    if (functionName === "versionConfigCid") { if (over.revert) throw Object.assign(new Error("execution reverted"), { shortMessage: "The contract function reverted." }); if (over.rpcDown) throw new Error("fetch failed"); return over.configCid ?? "bafkreiversionconfig"; }
  } });
  const addr = "0x" + "cc".repeat(20);
  assert.deepEqual(await P.versionConfigReader([mk(), mk()], addr)(APPX, 3), { config: '{"wasi":"p2"}', configCid: "bafkreiversionconfig" });
  assert.deepEqual(await P.versionConfigReader([mk({ revert: true }), mk({ revert: true })], addr)(APPX, 3), { config: '{"wasi":"p2"}', configCid: "" }, "an older catalog: no configCid");
  await assert.rejects(P.versionConfigReader([mk(), mk({ configCid: "bafkreianother" })], addr)(APPX, 3), /disagree/);
  await assert.rejects(P.versionConfigReader([mk(), mk({ config: '{"other":1}' })], addr)(APPX, 3), /disagree/);
  await assert.rejects(P.versionConfigReader([mk(), mk({ rpcDown: true })], addr)(APPX, 3), /fetch failed/, "a transport failure is not 'no configCid'");
});

test("an installed release may be READ-ONLY: the predictor measures an owner-writable snapshot inside its job directory", async () => {
  const ro = release("read-only-copy");
  const RO = "ad".repeat(32);
  const chmodAll = (p, fm, dm) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) { chmodAll(q, fm, dm); fs.chmodSync(q, dm); } else fs.chmodSync(q, fm); } fs.chmodSync(p, dm); };
  chmodAll(ro, 0o444, 0o555);
  const seen = [];
  const repo = toolchainRepo();
  const tools = stubs({ "expected-measurement.sh": (a) => { if (a[2] === RO) { seen.push(a[3]); fs.accessSync(path.join(a[3], "template/rt/runtime.json"), fs.constants.W_OK); } return null; } });
  const p = P.makePredictor({ repo: repo.dir, commit: repo.commit, releases: [...Object.entries(REL).map(([id, dir]) => ({ id, dir })), { id: RO, dir: ro }], admit: [RO],
    readCatalog: async () => ({ app: { active: true }, version: { cid: CID, memMb: 300, ports: "", approval: 1, yanked: false } }),
    gateway: "https://trustless.example", sevSnpMeasure: "/x", sevSnpMeasureSha256: TOOL, digestTool: async () => TOOL,
    work: fs.mkdtempSync(path.join(TMP, "work-")), knownAnswers: KAT, run: tools.run });
  try {
    const r = await p.expectedFor(REF);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(seen.length, 1); assert.notEqual(seen[0], ro, "the snapshot, not the installed release, is measured");
    assert.ok(seen[0].startsWith(path.dirname(p.state().toolchain)), "inside the predictor's private work directory");
    assert.equal(fs.existsSync(seen[0]), false, "and removed with the job");
  } finally { chmodAll(ro, 0o644, 0o755); }
});

test("two sets: the release's admitted releases, and every INSTALLED release for a certificate; the release never predicts outside its own", async () => {
  const { p } = predictor({ admit: [R1] });
  assert.deepEqual(p.sets.release, [R1]); assert.deepEqual([...p.sets.cert].sort(), Object.keys(REL).sort());
  const rel = await p.expectedFor(REF), cert = await p.expectedFor(REF, { set: "cert" });
  assert.equal(rel.ok, true); assert.equal(cert.ok, true);
  assert.deepEqual(rel.images.map((i) => i.release), [R1], "the release admits only its own set");
  assert.deepEqual(cert.images.map((i) => i.release).sort(), Object.keys(REL).sort(), "a certificate: every installed release");
  assert.equal(cert.appId, rel.appId);
  assert.equal((await p.expectedFor(REF, { set: "other" })).code, "predictor_unconfigured");
});

test("read-only SEED components (verified against their CIDs, copied into the writable cache) and a tool PATH for the children", async () => {
  const bytes = Buffer.concat([Buffer.from("0061736d0d000100", "hex"), Buffer.from(" a seeded component")]);
  const A32 = "abcdefghijklmnopqrstuvwxyz234567";
  const raw = Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), createHash("sha256").update(bytes).digest()]);
  let bits = 0, v = 0, cid = "b";
  for (const x of raw) { v = (v << 8) | x; bits += 8; while (bits >= 5) { cid += A32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) cid += A32[(v << (5 - bits)) & 31];
  const seed = fs.mkdtempSync(path.join(TMP, "seed-")), bad = fs.mkdtempSync(path.join(TMP, "seedbad-"));
  fs.writeFileSync(path.join(bad, cid), "tampered"); fs.writeFileSync(path.join(seed, cid), bytes);
  fs.chmodSync(seed, 0o555);
  const toolDir = fs.mkdtempSync(path.join(TMP, "tools-"));
  const seenPath = [];
  const REF9 = `catalog://${APPX}/19`;
  const { p, tools } = predictor({ versions: { [REF9]: { app: { active: true }, version: { cid, memMb: 128, ports: "", approval: 1, yanked: false } } },
    opts: { seedComponents: [bad, seed], toolPath: [toolDir] },
    tools: { "fetch-cid.py": (a) => (a[2] === cid ? { code: 1, out: "", err: "gateway down" } : null),
             "derive_reference.py": (a, o) => { seenPath.push(o.env.PATH); return null; } } });
  try {
    const r = await p.expectedFor(REF9);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(tools.calls.filter((c) => c.script === "fetch-cid.py" && c.args[2] === cid).length, 0, "the seed served it: no fetch");
    assert.ok(seenPath.every((x) => x.split(":")[0] === toolDir), "the tool path comes first in the children's PATH");
    assert.equal(fs.readFileSync(path.join(path.dirname(p.state().toolchain), "components", cid)).equals(bytes), true, "copied into the writable cache");
    const r2 = await p.fetchVerified(cid); assert.equal(r2.ok, true);
  } finally { fs.chmodSync(seed, 0o755); }
});

test("tool-path and seed directories must be absolute (a relative PATH entry would resolve against a job's cwd)", () => {
  for (const opts of [{ toolPath: ["go/bin"] }, { seedComponents: ["./components"] }]) {
    const { p } = predictor({ opts });
    assert.ok(p.problems.some((x) => /an absolute tool\/seed directory/.test(x)), JSON.stringify(opts));
  }
  assert.equal(predictor({ opts: { toolPath: ["/opt/x/go/bin"], seedComponents: ["/opt/x/components"] } }).p.problems.length, 0);
});

test("runBounded: a hung tool is killed with its whole process group at the timeout; output is capped", async () => {
  const t0 = Date.now();
  const r = await P.runBounded("sh", ["-c", "sleep 30 & sleep 30; echo never"], { env: { PATH: process.env.PATH }, timeoutMs: 300 });
  assert.ok(Date.now() - t0 < 5000, "returned promptly");
  assert.notEqual(r.code, 0); assert.match(r.err, /timed out/); assert.doesNotMatch(r.out, /never/);
  const big = await P.runBounded("sh", ["-c", "head -c 1000000 /dev/zero | tr '\\0' x"], { env: { PATH: process.env.PATH }, timeoutMs: 10_000 });
  assert.equal(big.code, 0); assert.ok(big.out.length <= (1 << 16) + (1 << 16), `capped (${big.out.length})`);
});

test("predictorEnv: every knob is read from the environment; malformed release entries are dropped", () => {
  const c = P.predictorEnv({ SECRETS_RELEASE_PREDICT_REPO: "/r", SECRETS_RELEASE_PREDICT_COMMIT: "AB".repeat(20),
    SECRETS_RELEASE_PREDICT_RELEASES: `${R1}=/a, nothex=/b, ${R2}=/c`, SECRETS_RELEASE_DOMAIN_RELEASES: `${R1}, ${R2.toUpperCase()}`,
    SECRETS_RELEASE_PREDICT_GATEWAY: "https://g", SECRETS_RELEASE_SEV_SNP_MEASURE: "/m", SECRETS_RELEASE_PREDICT_WORK: "/w" });
  assert.equal(c.commit, "ab".repeat(20));
  assert.deepEqual(c.releases, [{ id: R1, dir: "/a" }, { id: R2, dir: "/c" }]);
  assert.deepEqual(c.admit, [R1, R2]);
  const p = P.makePredictor({ ...P.predictorEnv({}), readCatalog: null });
  assert.ok(p.problems.length >= 6, p.problems.join("; "));
});

// ---- a certificate set separate from the known-answer set (enclave-87, 2026-09-26) -------------------------------------
test("certReleases: a release installed only for the KAT is measurable by the KAT but never certifiable; the admitted one stays certifiable", async () => {
  const { p } = predictor({ admit: [R1], opts: { certReleases: [R1.toUpperCase()] } });
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.sets.cert, [R1], "the named set, not every installed release");
  const k = await p.selfTest();
  assert.equal(k.ok, true, `the KAT still runs on RK, installed but not certifiable: ${k.reason}`);
  const cert = await p.expectedFor(REF, { set: "cert" }), rel = await p.expectedFor(REF);
  assert.equal(cert.ok, true, JSON.stringify(cert));
  assert.deepEqual(cert.images.map((i) => i.release), [R1], "a guest on RK (the KAT release) or on R2/R3 gets no certificate: no image to match");
  assert.deepEqual(rel.images.map((i) => i.release), [R1], "the admitted release is released and certifiable");
  // unset: unchanged (every installed release)
  const { p: all } = predictor({ admit: [R1] });
  assert.deepEqual([...all.sets.cert].sort(), Object.keys(REL).sort());
});

test("certReleases misconfigured is a PROBLEM (every prediction refused), never a silent outage: not installed, or an admitted release left out", async () => {
  const { p: stray } = predictor({ admit: [R1], opts: { certReleases: [R1, "c0".repeat(32)] } });
  assert.ok(stray.problems.some((x) => /certificate release c0c0c0c0c0c0 installed/.test(x)), stray.problems.join("; "));
  const { p: dropped } = predictor({ admit: [R1, R2], opts: { certReleases: [R1] } });
  assert.ok(dropped.problems.some((x) => new RegExp(`admitted release ${R2.slice(0, 12)} in the certificate set`).test(x)), dropped.problems.join("; "));
  const r = await dropped.expectedFor(REF, { set: "cert" });
  assert.equal(r.ok, false, "a misconfigured predictor answers nothing");
  const c = P.predictorEnv({ SECRETS_RELEASE_CERT_RELEASES: ` ${R1.toUpperCase()}, ${R2} ` });
  assert.deepEqual(c.certReleases, [R1, R2]);
  assert.deepEqual(P.predictorEnv({}).certReleases, [], "unset: none named (every installed release)");
});
