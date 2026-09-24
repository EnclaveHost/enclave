// Activation of a staged update in the installed pVM client, black-box, against the agreed design
// (docs/security/pvm-client-activation-review.md section 4): `activate` commits a monotonic `active` record after a
// start check of the bytes read once; `run` hands the active bytes over stdin, refuses at step "launch" with no fallback,
// and passes the child's exit through. Staged artifacts are CANARIES (test/helpers/pvm-lab.mjs canaryArtifact): which
// bytes executed is observable by the token they post; a canary that must never run carries its own token. Written from
// the agreed interface before any implementation existed; it skips without ENCLAVE_PVM_LAUNCHER (the pinned installed
// artifact with `activate`, 0.3.0 or later) and fails under strict integration when that is missing.
//   run: ENCLAVE_PVM_LAUNCHER=<pinned pvm-client.mjs with activate> node --test test/verifier-pvm-client-activation.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { labServer, keys, signedPolicy, signedManifest, canaryArtifact, above, sha256, APP, cliRun, cliSync, committedState, install } from "./helpers/pvm-lab.mjs";

const LAUNCHER = process.env.ENCLAVE_PVM_LAUNCHER || "";
const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
if (STRICT && !(LAUNCHER && fs.existsSync(LAUNCHER))) throw new Error("strict integration: ENCLAVE_PVM_LAUNCHER (the pinned installed artifact with activate) is missing");
const skip = !(LAUNCHER && fs.existsSync(LAUNCHER)) && !STRICT && "no launcher pinned yet (ENCLAVE_PVM_LAUNCHER: the owner's client with activate, 0.3.0 or later)";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-activate-"));
const K = keys();
let L, V;   // the lab, and the installed artifact's own version (lab artifacts sit above it)
test.before(async () => { L = await labServer(); if (!skip) { const r = cliSync(LAUNCHER, tmp, ["version"]); V = r.lines.find((l) => l.version)?.version; assert.ok(V, `the launcher reports its version (${r.stdout} ${r.stderr})`); } });
test.after(() => { L?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// one install per case: the installed artifact copied beside its published files, its own state directory
function fresh(name) {
  const d = path.join(tmp, name), install_ = path.join(d, "install"), state = path.join(d, "state.d");
  fs.mkdirSync(install_, { recursive: true }); fs.copyFileSync(LAUNCHER, path.join(install_, "pvm-client.mjs"));
  const cli = path.join(install_, "pvm-client.mjs");
  install(cli, tmp, state, K);
  const args = (a) => [...a, "--state", state, "--install-dir", install_];
  const env = { NODE_OPTIONS: "--max-old-space-size=512" };   // harmless for the launcher; a child must NOT see it
  const run = (a) => cliRun(cli, tmp, args(a), { extraEnv: env });
  const sync = (a) => cliSync(cli, tmp, args(a), { extraEnv: env });
  const stateNow = () => committedState(cli, tmp, state);
  const listing = () => fs.readdirSync(install_).sort();
  const put = (n, version, opts = {}) => { const bytes = canaryArtifact(version, L.base, { token: `${n}-${randomBytes(4).toString("hex")}`, ...opts }); L.artifacts.set(n, { bytes, hold: !!opts.hold }); L.manifests.set(n, signedManifest(K, version, bytes)); return { bytes, token: /LAB CANARY (\S+):/.exec(bytes.toString())[1], sha256: sha256(bytes), file: `pvm-client-${version}-${sha256(bytes)}.mjs` }; };
  const update = (n) => sync(["update", "--manifest", `${L.base}/manifest/${n}`, "--artifact", `${L.base}/artifact/${n}`]);
  const activate = () => run(["activate"]).done;   // async: the start check posts to the lab, which a blocking spawn could not answer
  const activation = (r) => r.lines.find((l) => l.activate)?.activate ?? null;
  const posted = (token, cmd) => L.canaries.filter((c) => c.token === token && (cmd === undefined || c.cmd === cmd));
  return { d, install: install_, state, cli, run, sync, stateNow, listing, put, update, activate, activation, posted };
}
const isPath = (url) => /^file:\/\/\/.*\.mjs$/.test(url || "") && !/\[(eval|stdin)/.test(url || "");

test("activate: a valid staged canary becomes active after a start check on bytes handed over stdin; state.active equals the staged record; a second activate is idempotent", { skip }, async () => {
  const x = fresh("a1"); const c = x.put("a1", above(V));
  assert.equal(x.update("a1").status, 0); const g0 = x.stateNow().gen;
  const r = await x.activate(); const a = x.activation(r);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(a?.ok, true); assert.equal(a?.version, above(V)); assert.equal(a?.sha256, c.sha256);
  const st = x.stateNow(); assert.deepEqual({ version: st.active?.version, sha256: st.active?.sha256, file: st.active?.file }, { version: above(V), sha256: c.sha256, file: c.file }); assert.equal(st.gen, g0 + 1);
  assert.deepEqual({ version: st.staged?.version, sha256: st.staged?.sha256 }, { version: above(V), sha256: c.sha256 }, "staged is kept");
  const sc = x.posted(c.token, "version"); assert.equal(sc.length, 1, "the start check ran the canary once with `version`");
  assert.equal(isPath(sc[0].url), false, `the start check ran from memory, not a path (${sc[0].url})`); assert.equal(sc[0].nodeOptions, null, "NODE_OPTIONS scrubbed for the start check");
  assert.ok(sc[0].home && sc[0].home === sc[0].xdg && sc[0].home === sc[0].cwd && sc[0].home !== os.homedir(), `the start check sees a scratch HOME/XDG that is also its cwd (${JSON.stringify([sc[0].home, sc[0].xdg, sc[0].cwd])})`);
  assert.equal(sc[0].argv.includes("--state"), false, "the start check gets no --state"); assert.equal(fs.existsSync(sc[0].home), false, "the scratch directory is removed afterwards");
  assert.equal(st.active?.size, c.bytes.length, "the active record carries the size");
  assert.equal(x.posted(c.token, "run").length, 0, "activation runs nothing but the start check");
  const r2 = await x.activate(); assert.equal(r2.status, 0); assert.equal(x.activation(r2)?.already, true); assert.equal(x.stateNow().gen, g0 + 1, "idempotent: no new generation");
});
test("run delegates to the active bytes over stdin with the resolved directories and the one-hop marker; exit 0 passes through; run writes nothing", { skip }, async () => {
  const x = fresh("a2"); const c = x.put("a2", above(V)); assert.equal(x.update("a2").status, 0); assert.equal((await x.activate()).status, 0);
  const gen = x.stateNow().gen, files = x.listing();
  const r = await x.run(["run", "--policy", `${L.base}/policy/none`, "--relay", `${L.base}/r/a2`, "--app", APP, "--label", "a2"]).done;
  assert.equal(r.status, 0, r.out + r.err);
  const p = x.posted(c.token, "run"); assert.equal(p.length, 1, "the active canary ran once");
  assert.equal(isPath(p[0].url), false, `handed over stdin, not a path (${p[0].url})`);
  assert.ok(p[0].argv.includes("--install-dir") && p[0].argv.includes(x.install) && p[0].argv.includes("--state") && p[0].argv.includes(x.state), `explicit directories reach the child (${JSON.stringify(p[0].argv)})`);
  assert.equal(p[0].delegated, `${above(V)}:${c.sha256}`, "the one-hop marker names the active version and digest"); assert.equal(p[0].nodeOptions, null, "NODE_OPTIONS scrubbed for the child");
  assert.equal(p[0].xdg, path.join(tmp, "xdg-unused"), "the run child keeps the real configuration directories");
  assert.equal(r.result?.clientVersion, above(V), "the child's own result names the active version");
  assert.equal(x.stateNow().gen, gen, "run committed nothing"); assert.deepEqual(x.listing(), files, "run wrote nothing beside the client");
});
test("a delegated child's exit 7 passes through and a self-kill is an error with exit 2; neither falls back to the installed version's own run", { skip }, async () => {
  for (const [name, runMode, expect] of [["a3", "exit7", 7], ["a3k", "kill", 2]]) {
    const x = fresh(name); const c = x.put(name, above(V), { runMode }); assert.equal(x.update(name).status, 0); assert.equal((await x.activate()).status, 0);
    const r = await x.run(["run", "--policy", `${L.base}/policy/none`, "--relay", `${L.base}/r/${name}`, "--app", APP]).done;
    assert.equal(r.status, expect, `${name}: ${r.out} ${r.err}`);
    if (runMode === "kill") { assert.match(r.lines.find((l) => l.error)?.error || "", /ended by signal SIGKILL/, `a signal death is reported as an error (${r.out})`); assert.equal(r.lines.some((l) => l.result?.sent === false), false, "no sent:false claim for a child that may have sent"); }
    assert.equal(x.posted(c.token, "run").length, 1, "the child ran exactly once: no retry");
    assert.equal(r.lines.some((l) => l.result && l.result.clientVersion === V), false, "the installed version's own run never ran as a fallback");
    assert.equal(r.lines.some((l) => l.committed), false);
  }
});
test("a replaced or missing active file: run refuses at launch with no fallback, the planted bytes never execute, the state is unchanged; then the repair path", { skip }, async () => {
  const x = fresh("a4"); const c = x.put("a4", above(V)); assert.equal(x.update("a4").status, 0); assert.equal((await x.activate()).status, 0);
  const before = x.stateNow();
  const planted = canaryArtifact(above(V), L.base, { token: "planted-" + randomBytes(4).toString("hex") }); const plantedToken = /LAB CANARY (\S+):/.exec(planted.toString())[1];
  fs.rmSync(path.join(x.install, c.file)); fs.writeFileSync(path.join(x.install, c.file), planted);
  let r = await x.run(["run", "--policy", `${L.base}/policy/none`, "--relay", `${L.base}/r/a4`, "--app", APP]).done;
  assert.equal(r.status, 2); assert.equal(r.result?.step, "launch", JSON.stringify(r.result)); assert.equal(r.result?.sent, false);
  assert.deepEqual(r.result?.expected, { version: above(V), sha256: c.sha256, file: c.file }, "the refusal names the expected record"); assert.equal(r.result?.found, sha256(planted), "and what was found");
  const diag = x.sync(["staged"]); assert.equal(diag.status, 1, "`staged` exits 1 on an active mismatch"); assert.equal(diag.lines.find((l) => "active" in l)?.active?.bytesMatch, false);
  assert.equal(x.posted(plantedToken).length, 0, "the planted bytes never executed"); assert.equal(x.posted(c.token, "run").length, 0, "no fallback ran anything");
  assert.equal(r.lines.some((l) => l.result && l.result.clientVersion === V), false, "no fallback to the installed version");
  assert.deepEqual(x.stateNow(), before, "the state is untouched by a refused launch");
  assert.equal(x.update("a4").status, 1, "re-staging over a wrong file under the name is refused (the file is left untouched)");
  assert.equal(sha256(fs.readFileSync(path.join(x.install, c.file))), sha256(planted));
  fs.rmSync(path.join(x.install, c.file));                                    // the missing-file case, and the repair
  r = await x.run(["run", "--policy", `${L.base}/policy/none`, "--relay", `${L.base}/r/a4`, "--app", APP]).done; assert.equal(r.status, 2); assert.equal(r.result?.step, "launch"); assert.equal(r.result?.found, "missing");
  const u = x.update("a4"); assert.equal(u.status, 0, u.stdout); assert.equal(sha256(fs.readFileSync(path.join(x.install, c.file))), c.sha256, "the same artifact re-published the file");
  r = await x.run(["run", "--policy", `${L.base}/policy/none`, "--relay", `${L.base}/r/a4`, "--app", APP]).done; assert.equal(r.status, 0); assert.equal(x.posted(c.token, "run").length, 1);
  assert.deepEqual({ ...x.stateNow(), gen: 0 }, { ...before, gen: 0 }, "repair changed no field");
});
test("activate refuses: nothing staged; a staged file replaced before activation is never executed; a start-check failure leaves active null and staged kept", { skip }, async () => {
  const x = fresh("a5");
  let r = await x.activate(); assert.equal(r.status, 1); assert.equal(x.activation(r)?.ok, false); assert.equal(x.activation(r)?.step, "nothing newer"); assert.equal(x.stateNow().active, null);
  const c = x.put("a5", above(V)); assert.equal(x.update("a5").status, 0);
  const planted = canaryArtifact(above(V), L.base, { token: "planted-" + randomBytes(4).toString("hex") }); const plantedToken = /LAB CANARY (\S+):/.exec(planted.toString())[1];
  fs.rmSync(path.join(x.install, c.file)); fs.writeFileSync(path.join(x.install, c.file), planted);
  r = await x.activate(); assert.equal(r.status, 1); assert.equal(x.activation(r)?.step, "file", JSON.stringify(x.activation(r)));
  assert.equal(x.posted(plantedToken).length, 0, "rejected bytes were not executed, not even for a start check"); assert.equal(x.stateNow().active, null);
  fs.rmSync(path.join(x.install, c.file)); assert.equal(x.update("a5").status, 0);   // repaired
  const y = fresh("a5b"); const bad = y.put("a5b", above(V), { versionAnswer: "9.9.9" }); assert.equal(y.update("a5b").status, 0);
  r = await y.activate(); assert.equal(r.status, 1); assert.equal(y.activation(r)?.step, "start check", JSON.stringify(y.activation(r)));
  assert.equal(y.posted(bad.token, "version").length, 1, "the start check did run the verified bytes"); assert.equal(y.stateNow().active, null); assert.equal(y.stateNow().staged?.sha256, bad.sha256, "staged kept");
  const z = fresh("a5c"); const dead = z.put("a5c", above(V), { versionExit: 1 }); assert.equal(z.update("a5c").status, 0);
  r = await z.activate(); assert.equal(r.status, 1); assert.equal(z.activation(r)?.step, "start check"); assert.equal(z.stateNow().active, null); assert.equal(z.posted(dead.token, "version").length, 1);
});
test("one hop: a child started from a path ignores the marker (the base still delegates), and a delegated marker for another version is refused", { skip }, async () => {
  const x = fresh("a6a"); const c = x.put("a6a", above(V)); assert.equal(x.update("a6a").status, 0); assert.equal((await x.activate()).status, 0);
  const r = await cliRun(x.cli, tmp, ["run", "--policy", `${L.base}/policy/none`, "--relay", `${L.base}/r/a6a`, "--app", APP, "--state", x.state, "--install-dir", x.install], { extraEnv: { ENCLAVE_PVM_CLIENT_DELEGATED: `${V}:${"0".repeat(64)}` } }).done;
  assert.equal(r.status, 0, r.out + r.err); assert.equal(x.posted(c.token, "run").length, 1, "the base, started from a file path, ignored the planted marker and delegated as usual");
});
test("two activators at once: one activates, the other is idempotent; exactly one generation added", { skip }, async () => {
  const x = fresh("a6"); const c = x.put("a6", above(V)); assert.equal(x.update("a6").status, 0); const g0 = x.stateNow().gen;
  const [r1, r2] = await Promise.all([x.run(["activate"]).done, x.run(["activate"]).done]);
  for (const r of [r1, r2]) assert.equal(r.status, 0, r.out + r.err);
  assert.equal(x.stateNow().gen, g0 + 1); assert.equal(x.stateNow().active?.sha256, c.sha256);
  assert.equal([r1, r2].filter((r) => r.lines.find((l) => l.activate)?.activate?.already).length <= 1, true);
});
test("activation against staging a newer version, both orders: run uses active and never staged; the next activate moves forward; nothing moves back", { skip }, async () => {
  const x = fresh("a7"); const a = x.put("a7-a", above(V, 1)), b = x.put("a7-b", above(V, 2));
  assert.equal(x.update("a7-a").status, 0); assert.equal((await x.activate()).status, 0); assert.equal(x.update("a7-b").status, 0);
  let st = x.stateNow(); assert.equal(st.active?.sha256, a.sha256); assert.equal(st.staged?.sha256, b.sha256);
  let r = await x.run(["run", "--policy", `${L.base}/policy/none`, "--relay", `${L.base}/r/a7`, "--app", APP]).done; assert.equal(r.status, 0);
  assert.equal(x.posted(a.token, "run").length, 1, "run used the active bytes"); assert.equal(x.posted(b.token, "run").length, 0, "never the merely staged ones");
  assert.equal((await x.activate()).status, 0); st = x.stateNow(); assert.equal(st.active?.sha256, b.sha256);
  r = await x.run(["run", "--policy", `${L.base}/policy/none`, "--relay", `${L.base}/r/a7`, "--app", APP]).done; assert.equal(r.status, 0); assert.equal(x.posted(b.token, "run").length, 1);
  const older = x.put("a7-old", above(V, 1), {}); assert.equal(x.update("a7-old").status, 1, "an older version cannot be staged over the newer active one");
  assert.equal(x.activation(await x.activate())?.already, true); assert.equal(x.stateNow().active?.sha256, b.sha256, "active never moves back");
  const y = fresh("a7b"); const p = y.put("a7b-p", above(V, 1)), q = y.put("a7b-q", above(V, 2));   // the other order: two staged, then activate
  assert.equal(y.update("a7b-p").status, 0); assert.equal(y.update("a7b-q").status, 0); assert.equal((await y.activate()).status, 0);
  assert.equal(y.stateNow().active?.sha256, q.sha256, "activate takes the current staged record"); assert.equal(y.posted(p.token).length, 0, "the superseded staged bytes never ran");
});
test("activation and a policy commit, both orders, with the held-evidence barrier: serial, keys and active are all present afterwards", { skip }, async () => {
  const x = fresh("a8"); const c = x.put("a8", above(V)); assert.equal(x.update("a8").status, 0);
  L.policies.set("a8-3", signedPolicy(K, 3)); L.policies.set("a8-4", signedPolicy(K, 4));
  const pol = x.run(["run", "--policy", `${L.base}/policy/a8-3`, "--relay", `${L.base}/r/a8-3`, "--app", APP, "--label", "a8-3"]);   // the installed version runs (nothing active yet)
  await L.evidenceRequested("a8-3");                                          // serial 3 committed, the run held
  assert.equal((await x.activate()).status, 0); L.release("a8-3"); await pol.done;
  let st = x.stateNow(); assert.equal(st.serial, 3); assert.equal(st.active?.sha256, c.sha256, "activation after the policy commit kept both");
  const pol2 = x.run(["run", "--policy", `${L.base}/policy/a8-4`, "--relay", `${L.base}/r/a8-4`, "--app", APP, "--label", "a8-4"]);   // now delegated: the canary ignores the policy
  await pol2.done; st = x.stateNow(); assert.equal(st.active?.sha256, c.sha256); assert.equal(st.policyFp, st.policyFp);
});
test("swap stress: the active file replaced right after run starts; the swapped bytes never execute (evidence, not proof)", { skip }, async () => {
  const x = fresh("a9"); const c = x.put("a9", above(V)); assert.equal(x.update("a9").status, 0); assert.equal((await x.activate()).status, 0);
  const planted = canaryArtifact(above(V), L.base, { token: "swap-" + randomBytes(4).toString("hex") }); const plantedToken = /LAB CANARY (\S+):/.exec(planted.toString())[1];
  let ran = 0, refused = 0;
  for (let i = 0; i < 12; i++) {
    const r = x.run(["run", "--policy", `${L.base}/policy/none`, "--relay", `${L.base}/r/a9`, "--app", APP]);
    try { fs.rmSync(path.join(x.install, c.file)); fs.writeFileSync(path.join(x.install, c.file), planted); } catch {}
    const d = await r.done; if (d.status === 0) ran++; else { assert.equal(d.result?.step, "launch"); refused++; }
    fs.rmSync(path.join(x.install, c.file), { force: true }); fs.writeFileSync(path.join(x.install, c.file), c.bytes, { mode: 0o444 });
  }
  assert.equal(x.posted(plantedToken).length, 0, `the swapped bytes never executed (${ran} ran, ${refused} refused)`); assert.equal(x.posted(c.token, "run").length, ran);
});
