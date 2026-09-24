// Activation of a staged update and the launch of the active version (client/DESIGN.md "Activation"): the BUILT CLI in
// child processes, harmless lab canaries (test/fixtures/pvm-client-canary.mjs) that report every execution to a file in
// the test's own directory, and real "next" builds of the client itself. Interleavings are forced by deterministic
// barriers (test versions are 9.3.x: newer than any client under test; test/fixtures/pvm-client-store-driver.mjs: inside the compare-and-swap, between verifying bytes and the start
// check, between verifying bytes and handing them to the child) -- never timing -- except the one swap loop, which is
// labelled as evidence, not proof.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { CLIENT_VERSION, VERSION_MARKER } from "../shielded/anchor/avf/client/src/trust.js";
import { canary } from "./fixtures/pvm-client-canary.mjs";
import { deriveLabNext } from "../shielded/anchor/avf/client/tools/lab-next.mjs";
import { tmpdir, makeCa, haveOpenssl } from "./fixtures/avf-synthetic.mjs";
import { startFakeVm } from "./fixtures/pvm-fake-vm.mjs";
import { createWebCarrier } from "../shielded/anchor/avf/cpu/web-carrier.mjs";

const CLI = new URL("../shielded/anchor/avf/client/dist/pvm-client.mjs", import.meta.url).pathname;
const DRIVER = new URL("./fixtures/pvm-client-store-driver.mjs", import.meta.url).pathname;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const key = () => { const k = generateKeyPairSync("ed25519"); const pub = k.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex"); return { k, pub, fp: sha(Buffer.from(pub, "hex")) }; };
const esig = (t, domain, K) => edSign(null, Buffer.concat([Buffer.from(domain), Buffer.from(t)]), K.k.privateKey).toString("hex");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = "1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339";

function proc(bin, args, env = {}) {
  const c = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } }); let out = "";
  c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
  c.done = new Promise((r) => c.on("close", (code, sig) => r({ code, sig, lines: out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) })));
  return c;
}
const cli = (args, env) => proc(CLI, args, env).done;
async function reached(barrier, name) { for (let i = 0; i < 3000; i++) { if (fs.existsSync(path.join(barrier, `${name}.reached`))) return; await wait(10); } throw new Error(`${name} never reached its barrier`); }
const go = (barrier, name) => fs.writeFileSync(path.join(barrier, `${name}.go`), "");
async function pair(first, second) {   // two driver processes both paused inside the compare-and-swap; released in the order given
  const barrier = tmp("pvm-bar-");
  const kids = Object.fromEntries([first, second].map((d) => [d.name, proc(DRIVER, d.args(barrier))]));
  await reached(barrier, first.name); await reached(barrier, second.name);
  go(barrier, first.name); const o1 = (await kids[first.name].done).lines.at(-1);
  go(barrier, second.name); const o2 = (await kids[second.name].done).lines.at(-1);
  return { [first.name]: o1, [second.name]: o2 };
}
// a genuinely newer build of the real client: the built artifact, relabelled as a LAB next-version test artifact by the
// same tool the device run uses (client/tools/lab-next.mjs: the first line and the version constant, nothing else)
const DIST = fs.readFileSync(CLI);
const realNext = (v) => deriveLabNext(DIST, v).bytes;
function signed(dir, P, R, version, bytes) {   // a release-signed, policy-countersigned manifest for these bytes
  const af = path.join(dir, `a-${version}-${sha(bytes).slice(0, 8)}.mjs`); fs.writeFileSync(af, bytes);
  const t = JSON.stringify({ type: "enclave-pvm-client-update", artifact: "pvm-client.mjs", version, artifactSha256: sha(bytes), size: bytes.length, sourceCommit: "ab".repeat(20),
    notAfter: iso(Date.now() + 3600e3), releaseKey: R.pub, policyKey: P.pub, nextReleaseKey: null });
  const mf = path.join(dir, `m-${version}-${sha(bytes).slice(0, 8)}.json`);
  fs.writeFileSync(mf, JSON.stringify({ manifest: Buffer.from(t).toString("base64"), releaseSig: esig(t, "enclave-pvm-client-update-v1\n", R), policySig: esig(t, "enclave-pvm-client-update-countersign-v1\n", P) }));
  return { mf, af, bytes, sha: sha(bytes), name: `pvm-client-${version}-${sha(bytes)}.mjs`, version };
}
const policyDoc = (P, serial, over = {}) => {
  const t = JSON.stringify({ type: "enclave-pvm-client-policy", key: P.pub, serial, notBefore: iso(Date.now() - 3600e3), notAfter: iso(Date.now() + 86400e3),
    codeHashes: ["6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990"], authorityHashes: ["cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f"], // gitleaks:allow -- public: sha512 of the TEST signing certificate
    runtimeIds: [sha('{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}')],
    appIds: [APP], googleRootPins: ["6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"], formats: ["enclave-pvm-app-evidence/v2"], sealedModes: ["chunked", "whole"],
    sealedWindow: { seconds: 600, maxRequests: 256 }, minClientVersion: "0.1.0", nextPolicyKey: null, ...over });
  return { policy: Buffer.from(t).toString("base64"), sig: esig(t, "enclave-pvm-client-policy-v1\n", P) };
};

// an installed client: its state, an install directory apart from the CLI, a report file for the canaries
async function installed() {
  const dir = tmp("pvm-act-"), st = path.join(dir, "state"), inst = path.join(dir, "inst"), report = path.join(dir, "report.jsonl"), P = key(), R = key();
  fs.mkdirSync(inst);
  assert.equal((await cli(["install", "--state", st, "--policy-key-fp", P.fp, "--serial-floor", "1", "--release-key-fp", R.fp])).code, 0);
  const L = { dir, st, inst, report, P, R };
  L.reports = () => (fs.existsSync(report) ? fs.readFileSync(report, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  L.canary = (version, token, o = {}) => signed(dir, P, R, version, canary({ version, token, report, ...o }));
  L.real = (version) => signed(dir, P, R, version, realNext(version));
  L.stage = async (f) => (await cli(["update", "--state", st, "--manifest", f.mf, "--artifact", f.af, "--install-dir", inst])).lines.at(-1).update;
  L.activate = async (env) => { const o = await cli(["activate", "--state", st, "--install-dir", inst], env); return { ...o.lines.at(-1).activate, code: o.code }; };
  L.runWith = (args, env) => cli(["run", "--state", st, "--install-dir", inst, ...args], env);
  L.run = (env) => L.runWith(["--policy", path.join(dir, "no-policy.json"), "--relay", "http://127.0.0.1:9", "--app", APP], env);
  L.state = async () => (await cli(["state", "--state", st])).lines[0];
  L.staged = async () => { const o = await cli(["staged", "--state", st, "--install-dir", inst]); return { ...o.lines[0], code: o.code }; };
  L.listing = () => fs.readdirSync(inst).sort();
  L.file = (f) => path.join(inst, f.name);
  return L;
}
const put = (file, bytes, how) => {   // replace a published file's bytes: over its name (a new inode), or in place
  if (how === "rename-over") { const t = `${file}.swap`; fs.writeFileSync(t, bytes); fs.renameSync(t, file); }
  else { fs.chmodSync(file, 0o644); fs.writeFileSync(file, bytes); }
};
const tokens = (L, cmd) => L.reports().filter((e) => !cmd || e.cmd === cmd).map((e) => e.token);

test("activation is explicit and recorded once: the staged bytes are start-checked from memory in a scrubbed environment; `run` then executes exactly them, one hop, with explicit directories", async () => {
  const L = await installed();
  const A = L.canary("9.3.1", "tok-A");
  assert.equal((await L.stage(A)).ok, true);
  const r0 = (await L.run()).lines.at(-1).result;   // staged, not active: the launcher runs `run` itself
  assert.equal(r0.clientVersion, CLIENT_VERSION); assert.equal(r0.step, "policy"); assert.deepEqual(L.reports(), [], "a staged update never runs before activation");
  const g0 = (await L.state()).gen;
  const a = await L.activate({ NODE_OPTIONS: "--no-deprecation" });
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.code, 0); assert.equal(a.version, "9.3.1"); assert.equal(a.sha256, A.sha); assert.equal(a.gen, g0 + 1);
  const s1 = await L.state();
  assert.deepEqual(s1.state.active, { version: "9.3.1", sha256: A.sha, size: A.bytes.length, file: A.name, sourceCommit: "ab".repeat(20) });
  assert.deepEqual(s1.state.active, s1.state.staged, "active is exactly the staged record");
  // the start check ran once: over stdin, `version` only, no NODE_OPTIONS, HOME == XDG_CONFIG_HOME == cwd == a scratch directory, gone now
  const [e] = L.reports(); assert.equal(L.reports().length, 1);
  assert.equal(e.token, "tok-A"); assert.deepEqual(e.argv, ["version"]); assert.equal(e.argv1, "-"); assert.ok(!e.url.includes("pvm-client-9.3.1"), e.url);
  assert.equal(e.nodeOptions, null); assert.equal(e.delegated, null); assert.equal(e.home, e.xdg); assert.equal(e.cwd, e.home); assert.notEqual(e.home, os.homedir());
  assert.equal(fs.existsSync(e.home), false, "the start check's scratch directory was removed");
  const again = await L.activate();
  assert.equal(again.ok, true); assert.equal(again.already, true); assert.equal(again.gen, g0 + 1); assert.equal(L.reports().length, 1, "nothing re-run, nothing recorded");
  // run: exactly A's bytes, one hop, the resolved directories, NODE_OPTIONS removed, the real HOME; the launch writes nothing
  const before = L.listing();
  const r = await L.run({ NODE_OPTIONS: "--no-deprecation" });
  assert.equal(r.code, 0); assert.deepEqual(r.lines, [{ canary: "tok-A", ran: "9.3.1" }], "only the child's own output: the launcher adds nothing");
  const e2 = L.reports()[1];
  assert.equal(e2.cmd, "run"); assert.equal(e2.argv1, "-"); assert.equal(e2.delegated, `9.3.1:${A.sha}`); assert.equal(e2.nodeOptions, null); assert.equal(e2.home, process.env.HOME);
  assert.deepEqual([e2.argv.filter((x) => x === "--state").length, e2.argv.filter((x) => x === "--install-dir").length], [1, 1]);
  assert.equal(e2.argv[e2.argv.indexOf("--state") + 1], L.st); assert.equal(e2.argv[e2.argv.indexOf("--install-dir") + 1], L.inst);
  assert.equal((await L.state()).gen, g0 + 1, "a launch commits nothing"); assert.deepEqual(L.listing(), before, "a launch writes nothing");
});

test("the active client's own end is relayed: exit 7 as 7, a SIGKILL as an error -- never retried, nothing else run after it", async () => {
  const L = await installed();
  const S = L.canary("9.3.1", "tok-7", { onRun: "exit7" });
  assert.equal((await L.stage(S)).ok, true); assert.equal((await L.activate()).ok, true);
  const r = await L.run();
  assert.equal(r.code, 7); assert.deepEqual(r.lines, [{ canary: "tok-7", ran: "9.3.1" }]);
  const K = L.canary("9.3.2", "tok-kill", { onRun: "sigkill" });
  assert.equal((await L.stage(K)).ok, true); assert.equal((await L.activate()).ok, true);
  const k = await L.run();
  assert.equal(k.code, 2); assert.equal(k.lines.length, 2); assert.deepEqual(k.lines[0], { canary: "tok-kill", ran: "9.3.2" });
  assert.match(k.lines[1].error, /the active client 9\.3\.2 ended by signal SIGKILL/); assert.equal("sent" in k.lines[1], false, "no claim about what was sent");
  assert.deepEqual(tokens(L, "run"), ["tok-7", "tok-kill"], "one execution per launch, and the launcher's own `run` never ran");
});

test("exactly the verified bytes run: a file swapped between verification and execution cannot change what runs; a naive hash-the-path-then-run-the-path launcher runs the swap", async () => {
  const L = await installed();
  const A = L.canary("9.3.1", "tok-A"), B = canary({ version: "9.3.1", token: "tok-B", report: L.report });
  assert.equal((await L.stage(A)).ok, true); assert.equal((await L.activate()).ok, true);
  const file = L.file(A);
  for (const how of ["rename-over", "in-place"]) {
    put(file, A.bytes, "rename-over");
    const barrier = tmp("pvm-bar-"), d = proc(DRIVER, ["launch", L.st, L.inst, barrier, "go", "--policy", "x"]);
    await reached(barrier, "go");               // A's bytes are read and verified; the child is not started yet
    put(file, B, how);                          // the path now holds B
    go(barrier, "go"); const o = await d.done;
    assert.deepEqual(o.lines[0], { canary: "tok-A", ran: "9.3.1" }, `${how}: the verified bytes ran`);
    assert.equal(tokens(L).includes("tok-B"), false, `${how}: the swapped bytes never ran`);
  }
  // negative control: the same swap at the same point, in a launcher that verifies the path and then gives node the PATH
  put(file, A.bytes, "rename-over");
  assert.equal(sha(fs.readFileSync(file)), A.sha, "the naive launcher's check passes");
  put(file, B, "rename-over");
  await new Promise((r) => spawn(process.execPath, [file, "run"], { stdio: "ignore" }).on("close", r));
  assert.deepEqual(tokens(L, "run").slice(-1), ["tok-B"], "the naive launcher ran the swapped bytes: the race is real");
  // and the launcher itself, meeting B at the path: refused, nothing run
  const r = await L.run();
  assert.equal(r.code, 2); assert.equal(r.lines.length, 1); const res = r.lines[0].result;
  assert.equal(res.step, "launch"); assert.equal(res.sent, false); assert.equal(res.found, sha(B)); assert.deepEqual(res.expected, { version: "9.3.1", sha256: A.sha, file: A.name });
  assert.equal(tokens(L).filter((t) => t === "tok-B").length, 1, "only the naive control ever ran B");
  // evidence, not proof: 24 launches while another process keeps swapping A and B at the path -- each runs A or is refused, never B
  put(file, A.bytes, "rename-over");
  const swapper = spawn(process.execPath, ["-e", `const fs=require("fs");const f=${JSON.stringify(file)};const b=[fs.readFileSync(f),Buffer.from(${JSON.stringify(B.toString("base64"))},"base64")];let i=0;setInterval(()=>{const t=f+".s"+(i%2);fs.writeFileSync(t,b[i++%2]);fs.renameSync(t,f);},1);`], { stdio: "ignore" });
  const outcomes = [];
  try { for (let i = 0; i < 24; i++) { const o = await L.run(); outcomes.push(o.code === 0 ? o.lines[0].canary : o.lines[0].result?.step); } }
  finally { swapper.kill("SIGKILL"); }
  assert.ok(outcomes.every((x) => x === "tok-A" || x === "launch"), JSON.stringify(outcomes));
  assert.equal(tokens(L).filter((t) => t === "tok-B").length, 1, "under the swap loop, B never ran");
  console.log("swap loop outcomes:", JSON.stringify(outcomes.reduce((m, x) => ({ ...m, [x]: (m[x] || 0) + 1 }), {})));
});

test("a missing or tampered active file: `run` is refused at launch and nothing runs -- no fallback; `staged` diagnoses it; `update` with the same artifact repairs it", async () => {
  const L = await installed();
  const A = L.canary("9.3.1", "tok-A"), T = canary({ version: "9.3.1", token: "tok-T", report: L.report });
  assert.equal((await L.stage(A)).ok, true); assert.equal((await L.activate()).ok, true);
  const g = (await L.state()).gen, file = L.file(A);
  fs.rmSync(file);
  const m = await L.run();
  assert.equal(m.code, 2); assert.equal(m.lines.length, 1, "no result from the launcher's own `run`");
  assert.deepEqual({ ...m.lines[0].result, refused: undefined }, { step: "launch", refused: undefined, sent: false, expected: { version: "9.3.1", sha256: A.sha, file: A.name }, found: "missing" });
  assert.match(m.lines[0].result.refused, /no fallback/);
  const d = await L.staged(); assert.equal(d.code, 1); assert.equal(d.active.bytesMatch, false); assert.equal(d.staged.bytesMatch, false);
  const fix = await L.stage(A); assert.equal(fix.ok, true); assert.equal(fix.already, true, "the same artifact re-publishes the file");
  assert.equal((await L.staged()).code, 0); assert.equal((await L.run()).code, 0);
  // tampered in place: refused with what was found; the same artifact cannot write over a wrong file, so the user removes it
  put(file, T, "in-place");
  const t = await L.run(); assert.equal(t.code, 2); assert.equal(t.lines[0].result.found, sha(T));
  assert.match((await L.stage(A)).reasons[0], /already exists with bytes other than its name says/);
  fs.rmSync(file); assert.equal((await L.stage(A)).already, true);
  assert.equal((await L.run()).code, 0, "repaired: the active bytes run again");
  assert.deepEqual(tokens(L, "run"), ["tok-A", "tok-A"], "the two runs after each repair, and nothing else");
  assert.equal(tokens(L).includes("tok-T"), false, "the tampered bytes never ran");
  assert.equal((await L.state()).gen, g, "no launch, refusal or repair moved the state");
});

test("activation refusals record nothing: nothing staged, a tampered staged file (never executed), start checks that fail -- while nothing is active, `run` stays the launcher's own", async () => {
  const L = await installed();
  const g0 = (await L.state()).gen;
  const n = await L.activate(); assert.equal(n.ok, false); assert.equal(n.code, 1); assert.equal(n.step, "nothing newer");
  const C = L.canary("9.3.1", "tok-C"), T = canary({ version: "9.3.1", token: "tok-T", report: L.report });
  assert.equal((await L.stage(C)).ok, true); put(L.file(C), T, "in-place");
  const f = await L.activate();
  assert.equal(f.step, "file"); assert.equal(f.found, sha(T)); assert.deepEqual(f.expected, { version: "9.3.1", sha256: C.sha, file: C.name });
  assert.deepEqual(tokens(L), [], "neither the staged nor the tampered bytes executed");
  const W = L.canary("9.3.2", "tok-W", { answer: "9.3.9" }), X = L.canary("9.3.3", "tok-X", { start: "exit3" }), Y = L.canary("9.3.4", "tok-Y", { start: "throw" });
  for (const [c, why] of [[W, /not exactly one line naming version 9\.3\.2/], [X, /exited 3/], [Y, /exited 1/]]) {
    assert.equal((await L.stage(c)).ok, true);
    const s = await L.activate(); assert.equal(s.ok, false); assert.equal(s.step, "start check"); assert.match(s.reasons[0], why);
  }
  assert.deepEqual(tokens(L), ["tok-W", "tok-X", "tok-Y"], "each start-check fixture executed exactly once, with `version`");
  const st = await L.state(); assert.equal(st.state.active, null); assert.equal(st.gen, g0 + 4, "four stagings, no activation");
  assert.equal((await L.run()).lines.at(-1).result.clientVersion, CLIENT_VERSION, "nothing active: the launcher's own `run` -- the status quo, not a fallback");
  const Z = L.canary("9.3.5", "tok-Z"); assert.equal((await L.stage(Z)).ok, true); assert.equal((await L.activate()).ok, true);
  assert.equal((await L.stage(L.canary("9.3.4", "tok-old"))).ok, false, "monotonic: nothing older is staged after 9.3.5");
});

const adrv = (name, L, where = "cas") => ({ name, args: (b) => ["activate", L.st, L.inst, b, name, where, CLIENT_VERSION] });
const udrv = (name, L, f) => ({ name, args: (b) => ["update", L.st, f.mf, f.af, b, name, L.inst, CLIENT_VERSION] });

test("processes: two activators -- one commit, both succeed; activation racing a newer staging, both orders; a crash before the commit activates nothing", async () => {
  const L = await installed();
  const A = L.canary("9.3.1", "tok-A"); assert.equal((await L.stage(A)).ok, true);
  const g = (await L.state()).gen;
  const two = await pair(adrv("x", L), adrv("y", L));
  assert.equal(two.x.ok, true); assert.equal(two.y.ok, true); assert.equal(two.y.already, true); assert.equal((await L.state()).gen, g + 1, "exactly one generation");
  // activation first, then a newer staging: 9.3.1 active, 9.3.2 staged; `run` runs the active one
  const M = await installed(), A1 = M.canary("9.3.1", "tok-A1"), B2 = M.canary("9.3.2", "tok-B2");
  assert.equal((await M.stage(A1)).ok, true);
  const p1 = await pair(adrv("act", M), udrv("upd", M, B2));
  assert.equal(p1.act.ok, true); assert.equal(p1.upd.ok, true, JSON.stringify(p1.upd));
  const s1 = (await M.state()).state; assert.equal(s1.active.version, "9.3.1"); assert.equal(s1.staged.version, "9.3.2");
  assert.deepEqual((await M.run()).lines, [{ canary: "tok-A1", ran: "9.3.1" }], "the active version runs, not the staged one");
  // the newer staging first: the activation of what it verified is refused, nothing activated
  const N = await installed(), A2 = N.canary("9.3.1", "tok-A2"), B3 = N.canary("9.3.2", "tok-B3");
  assert.equal((await N.stage(A2)).ok, true);
  const p2 = await pair(udrv("upd", N, B3), adrv("act", N));
  assert.equal(p2.upd.ok, true); assert.equal(p2.act.ok, false); assert.equal(p2.act.step, "changed while activating");
  assert.equal((await N.state()).state.active, null);
  assert.equal((await N.activate()).version, "9.3.2", "activated again, it takes the newest");
  // a crash inside the commit, and one between the byte check and the start check: nothing active either way
  for (const where of ["cas", "verified"]) {
    const K = await installed(); assert.equal((await K.stage(K.canary("9.3.1", "tok-K"))).ok, true);
    const gk = (await K.state()).gen, barrier = tmp("pvm-bar-"), d = proc(DRIVER, adrv("k", K, where).args(barrier));
    await reached(barrier, "k"); d.kill("SIGKILL"); await d.done;
    assert.equal((await K.state()).state.active, null, `${where}: nothing active`); assert.equal((await K.state()).gen, gk);
    assert.equal((await K.activate()).ok, true, `${where}: a retry activates`);
  }
});

test("processes: activation racing a policy commit that rotates the policy key, both orders -- neither loses the other's change", async () => {
  for (const order of ["activation-first", "policy-first"]) {
    const L = await installed(); const K2 = key();
    assert.equal((await L.stage(L.canary("9.3.1", "tok-A"))).ok, true);
    const pf = path.join(L.dir, "p2.json"); fs.writeFileSync(pf, JSON.stringify(policyDoc(L.P, 2, { nextPolicyKey: K2.pub })));
    const pol = { name: "pol", args: (b) => ["policy", L.st, pf, b, "pol"] };
    const r = await pair(...(order === "activation-first" ? [adrv("act", L), pol] : [pol, adrv("act", L)]));
    assert.equal(r.act.ok, true, JSON.stringify(r.act)); assert.equal(r.pol.ok, true, JSON.stringify(r.pol));
    const s = (await L.state()).state;
    assert.equal(s.active.version, "9.3.1", `${order}: the activation survived`); assert.equal(s.serial, 2, `${order}: the policy survived`);
    assert.equal(s.nextPolicyFp, K2.fp, `${order}: the rotation survived`);
  }
});

test("the real client, activated: runs `run` from memory end to end; one hop even when a newer activation lands meanwhile; a planted marker never makes the launcher skip delegation", { skip: !haveOpenssl && "no openssl", timeout: 180000 }, async () => {
  const cadir = tmpdir("pvm-act-ca-"), ca = makeCa(cadir);
  const vm = await startFakeVm({ dir: cadir, ca, code: Buffer.from("6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990", "hex"), appId: APP });
  const recorded = tmp("pvm-act-ev-");   // the carrier's LAB evidence capture (what the device runs keep for offline re-verification)
  const carrier = createWebCarrier({ port: 0, evidencePort: vm.evidencePort, sealedPort: vm.sealedPort, recordEvidence: recorded });
  await new Promise((r) => carrier.on("listening", r));
  const relay = `http://127.0.0.1:${carrier.address().port}`;
  try {
    const L = await installed();
    const pol = (serial) => { const f = path.join(L.dir, `pol-${serial}.json`); fs.writeFileSync(f, JSON.stringify(policyDoc(L.P, serial))); return f; };
    const R1 = L.real("9.3.1"); assert.equal((await L.stage(R1)).ok, true);
    const a1 = await L.activate(); assert.equal(a1.ok, true, JSON.stringify(a1));
    // end to end from memory: the activated real client takes the policy, verifies the VM itself and refuses its non-Google chain
    const e = (await L.runWith(["--policy", pol(7), "--relay", relay, "--app", APP])).lines.at(-1).result;
    assert.equal(e.clientVersion, "9.3.1"); assert.equal(e.step, "verify"); assert.match(e.refused, /not a pinned Google attestation root/); assert.equal(e.sent, false);
    assert.equal((await L.state()).state.serial, 7, "the delegated client committed the policy to the same state");
    // one hop: a launch holds after verifying 9.3.1's bytes; meanwhile 9.3.2 is staged and activated; released, 9.3.1 runs itself
    const barrier = tmp("pvm-bar-"), d = proc(DRIVER, ["launch", L.st, L.inst, barrier, "hop", "--policy", pol(8), "--relay", relay, "--app", APP]);
    await reached(barrier, "hop");
    const R2 = L.real("9.3.2"); assert.equal((await L.stage(R2)).ok, true); assert.equal((await L.activate()).version, "9.3.2");
    go(barrier, "hop"); const h = (await d.done).lines.find((l) => l.result).result;
    assert.equal(h.clientVersion, "9.3.1", "the delegated child did not delegate again"); assert.equal(h.step, "verify");
    assert.equal((await L.runWith(["--policy", pol(9), "--relay", relay, "--app", APP])).lines.at(-1).result.clientVersion, "9.3.2", "a new launch runs the newer active");
    // a marker planted on the launcher, started from its file, is ignored: it still delegates
    const planted = await L.runWith(["--policy", pol(10), "--relay", relay, "--app", APP], { ENCLAVE_PVM_CLIENT_DELEGATED: `${CLIENT_VERSION}:${"00".repeat(32)}` });
    assert.equal(planted.lines.at(-1).result.clientVersion, "9.3.2");
    // over stdin: a marker naming another version is refused; a delegated client runs only `run`
    const viaStdin = (bytes, args, marker) => new Promise((resolve) => {
      const c = spawn(process.execPath, ["--input-type=module", "-", ...args], { env: { ...process.env, ENCLAVE_PVM_CLIENT_DELEGATED: marker } }); let out = "";
      c.stdout.on("data", (x) => (out += x)); c.on("close", (code) => resolve({ code, line: JSON.parse(out.split("\n")[0]) })); c.stdin.end(bytes);
    });
    const wrong = await viaStdin(R1.bytes, ["run", "--state", L.st, "--install-dir", L.inst], `9.3.2:${R2.sha}`);
    assert.equal(wrong.code, 2); assert.match(wrong.line.error, /delegated as 9\.3\.2, but this client is 9\.3\.1/);
    const other = await viaStdin(R1.bytes, ["state", "--state", L.st], `9.3.1:${R1.sha}`);
    assert.equal(other.code, 2); assert.match(other.line.error, /runs only `run`/);
    // a deployment selection passes through the launcher unchanged: the delegated real client makes it from the signed table
    const D = "0x" + "d1".repeat(32), tbl = path.join(L.dir, "pol-11-table.json");
    fs.writeFileSync(tbl, JSON.stringify(policyDoc(L.P, 11, { deployments: [{ id: D, app: APP }] })));
    const sel = (await L.runWith(["--policy", tbl, "--relay", relay, "--deployment", D])).lines.at(-1).result;
    assert.equal(sel.clientVersion, "9.3.2", "the delegated child selected, not the launcher"); assert.deepEqual(sel.deployment, { id: D, app: APP, instance: null, bound: false });
    assert.equal(sel.step, "verify"); assert.match(sel.refused, /not a pinned Google attestation root/);
    // no fallback for the real client either: its file gone, nothing runs
    fs.rmSync(L.file(R2));
    const gone = await L.runWith(["--policy", pol(11), "--relay", relay, "--app", APP]);
    assert.equal(gone.code, 2); assert.equal(gone.lines[0].result.step, "launch"); assert.equal(gone.lines[0].result.found, "missing");
    assert.equal((await L.state()).state.serial, 11, "no launch refusal moved the floor (serial 11 was the table policy's)");
    // the carrier recorded each evidence exchange as received -- the five runs that fetched evidence (serials 7, 8, 9, 10 and
    // the table policy's 11), not the launch refusal
    const ev = fs.readdirSync(recorded).filter((f) => /^evidence-\d{3}\.json$/.test(f)).sort();
    assert.equal(ev.length, 5, JSON.stringify(fs.readdirSync(recorded)));
    for (const f of ev) {
      const env = JSON.parse(fs.readFileSync(path.join(recorded, f), "utf8")), q = fs.readFileSync(path.join(recorded, f.replace(/\.json$/, ".request")), "utf8");
      assert.equal(env.format, "enclave-pvm-app-evidence/v2"); assert.equal(q, `EVIDENCE ${env.nonce}\n`, "each envelope answers the nonce the client sent");
      const meta = JSON.parse(fs.readFileSync(path.join(recorded, f.replace(/\.json$/, ".meta.json")), "utf8"));
      assert.equal(`evidence-${String(meta.n).padStart(3, "0")}.json`, f); assert.ok(meta.sentToVmAt <= meta.answeredAt && /Z$/.test(meta.answeredAt), "UTC times, in order");
    }
    assert.equal(vm.log.filter((l) => l.served).length, 0, "no request reached the VM");
  } finally { carrier.close(); vm.close(); }
});

test("the lab next-version artifact (client/tools/lab-next.mjs): deterministic, labelled, the base's code with only the version moved; malformed bases refused", () => {
  const a = deriveLabNext(DIST, "9.3.1"), b = deriveLabNext(DIST, "9.3.1");
  assert.equal(a.sha256, b.sha256, "reproducible"); assert.deepEqual(a.base, { version: CLIENT_VERSION, sha256: sha(DIST) });
  const lines = a.bytes.toString("utf8").split("\n"), base = DIST.toString("utf8").split("\n");
  assert.match(lines[0], new RegExp(`^/\\*! enclave-pvm-client 9\\.3\\.1 \\(LAB NEXT-VERSION TEST ARTIFACT, not production: derived by client/tools/lab-next\\.mjs from pvm-client\\.mjs ${CLIENT_VERSION.replace(/\./g, "\\.")} sha256 ${sha(DIST)}\\)`));
  assert.equal(lines.length, base.length);
  const changed = lines.map((l, i) => (l === base[i] ? null : i)).filter((i) => i !== null);
  assert.equal(changed.length, 2, "the first line and the version constant, nothing else");
  assert.equal(lines[changed[1]], 'var CLIENT_VERSION = "9.3.1";');
  assert.throws(() => deriveLabNext(DIST, CLIENT_VERSION), /must differ/);
  assert.throws(() => deriveLabNext(Buffer.from("export const x = 1;\n"), "9.3.1"), /not a client version marker/);
  assert.throws(() => deriveLabNext(Buffer.concat([DIST, Buffer.from(`\nvar CLIENT_VERSION = "${CLIENT_VERSION}";\n`)]), "9.3.1"), /exactly one/);
});
