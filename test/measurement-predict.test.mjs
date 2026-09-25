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

test("parity with the supervisor's own functions at the toolchain commit (skipped when that commit is not in this repository)", (t) => {
  let src;
  try { src = execFileSync("git", ["show", "0181bce3:supervisor.js"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }); }
  catch { return t.skip("0181bce3 is not in this clone"); }
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
  for (const a of [0, 2]) assert.match(P.versionRefusal({ active: true }, { ...ok, approval: a }), /not approved/);
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
function predictor(over = {}) {
  const repo = over.repo || toolchainRepo();
  const tools = stubs(over.tools);
  const clock = { t: 1_000_000 };
  const versions = over.versions || { [REF]: { app: { active: true }, version: { cid: CID, memMb: 300, ports: "http:8080", approval: 1, yanked: false } } };
  const p = P.makePredictor({ repo: repo.dir, commit: repo.commit, releases: Object.entries(REL).map(([id, dir]) => ({ id, dir })),
    admit: over.admit || [R1, R2, R3], readCatalog: over.readCatalog || (async (app, i) => { const v = versions[`catalog://${app}/${i}`]; if (!v) throw new Error("rpc down"); return v; }),
    gateway: "https://trustless.example", sevSnpMeasure: "/nonexistent/sev-snp-measure", work: fs.mkdtempSync(path.join(TMP, "work-")),
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
