// The REAL client activated: a reproducible next version of the pinned client (verifier/integration/next-build.mjs: the
// pinned source rebuilt with only CLIENT_VERSION changed, and the owner's derived device artifact tied to it) is staged,
// activated and delegated to, so the delegated REAL client commits policies after activation, which a canary cannot:
// a policy commit after activation, a policy-key rotation and a successor-key policy committed by the delegated client, a
// release-key rotation carried by staging the next version, and one hop under a concurrent activation. Evidence class:
// HOST, lab keys, this session's relay answering 503 to every evidence request, so the delegated real client reaches
// "policy committed, evidence requested, refused: no evidence" and never a verified attestation or a sealed request;
// that part is the owner's device run, reviewed separately. Strict: skips are failures.
//   run: ENCLAVE_PVM_CLIENT_CLI=<pinned 0.3.x pvm-client.mjs> ENCLAVE_PVM_NEXT_DIR=<next-build output dir> node --test test/verifier-pvm-client-next.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { labServer, keys, signedPolicy, signedManifest, rawPub, fpOf, sha256, APP, cliRun, cliSync, committedState, install } from "./helpers/pvm-lab.mjs";

const CLI = process.env.ENCLAVE_PVM_CLIENT_CLI || "", NEXT = process.env.ENCLAVE_PVM_NEXT_DIR || "";
const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
const have = CLI && fs.existsSync(CLI) && NEXT && fs.existsSync(path.join(NEXT, "MANIFEST.json"));
if (STRICT && !have) throw new Error("strict integration: the pinned client (ENCLAVE_PVM_CLIENT_CLI) or the next builds (ENCLAVE_PVM_NEXT_DIR) are missing");
const skip = !have && !STRICT && "pinned client or next builds absent (node verifier/integration/next-build.mjs, then ENCLAVE_PVM_NEXT_DIR)";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-next-"));
const K = keys();
// the next builds are read at load (the skip conditions below depend on them): the rebuilt pair and the owner's derived artifact
let L, V, M = null, N1 = null, N2 = null, D1 = null;
if (have) {
  M = JSON.parse(fs.readFileSync(path.join(NEXT, "MANIFEST.json"), "utf8"));
  const [a, b] = Object.keys(M.builds).sort(); N1 = { version: a, bytes: fs.readFileSync(path.join(NEXT, a, "pvm-client.mjs")) }; N2 = { version: b, bytes: fs.readFileSync(path.join(NEXT, b, "pvm-client.mjs")) };
  const dv = Object.keys(M.derived || {})[0]; D1 = dv ? { version: dv, bytes: fs.readFileSync(path.join(NEXT, "derived", dv, "pvm-client.mjs")) } : null;
  for (const n of [N1, N2, D1].filter(Boolean)) { if (sha256(n.bytes) !== (n === D1 ? M.derived : M.builds)[n.version].sha256) throw new Error(`${n.version}: the next bytes are not the recorded ones`); if (!n.bytes.subarray(0, 60).toString().startsWith(`/*! enclave-pvm-client ${n.version} `)) throw new Error(`${n.version}: wrong first line`); }
}
if (STRICT && !D1) throw new Error("strict integration: the owner's derived device artifact is not among the next builds");
test.before(async () => { L = await labServer(); if (!skip) V = cliSync(CLI, tmp, ["version"]).lines.find((l) => l.version)?.version; });
test.after(() => { L?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function fresh(name) {
  const d = path.join(tmp, name), install_ = path.join(d, "install"), state = path.join(d, "state.d");
  fs.mkdirSync(install_, { recursive: true }); fs.copyFileSync(CLI, path.join(install_, "pvm-client.mjs"));
  const cli = path.join(install_, "pvm-client.mjs"); install(cli, tmp, state, K);
  const args = (a) => [...a, "--state", state, "--install-dir", install_];
  const run = (a) => cliRun(cli, tmp, args(a));
  const stage = async (n, next, opts = {}) => { L.artifacts.set(n, { bytes: next.bytes }); L.manifests.set(n, signedManifest(K, next.version, next.bytes, opts)); return run(["update", "--manifest", `${L.base}/manifest/${n}`, "--artifact", `${L.base}/artifact/${n}`]).done; };
  const activate = () => run(["activate"]).done;
  const activation = (r) => r.lines.find((l) => l.activate)?.activate ?? null;
  // a policy run: held at the relay's evidence barrier, then released (503: no evidence), or refused before any request
  const policyRun = async (policyName, label, { release = true } = {}) => {
    const r = run(["run", "--policy", `${L.base}/policy/${policyName}`, "--relay", `${L.base}/r/${label}`, "--app", APP, "--label", label]);
    const arrived = await Promise.race([L.evidenceRequested(label).then(() => true), r.done.then(() => false)]);
    const committedBefore = arrived && /"committed"/.test(r.out());
    if (arrived && release) L.release(label);
    const d = await r.done; return { ...d, arrived, committedBefore };
  };
  const stateNow = () => committedState(cli, tmp, state);
  const stagedOut = () => cliSync(cli, tmp, args(["staged"]));
  return { install: install_, state, cli, run, stage, activate, activation, policyRun, stateNow, stagedOut };
}
const policy = (name, serial, opts) => { L.policies.set(name, signedPolicy(K, serial, opts)); return name; };

test("staging runs nothing; activation of the real next version keeps the serial and the keys; the active record is the staged one", { skip }, async () => {
  const x = fresh("n1");
  let r = await x.policyRun(policy("n1-2", 2), "n1-2"); assert.equal(r.committed?.serial, 2); assert.equal(r.result?.clientVersion, V); assert.equal(r.result?.step, "evidence");
  assert.equal((await x.stage("n1", N1)).status, 0);
  r = await x.policyRun(policy("n1-3", 3), "n1-3"); assert.equal(r.committed?.serial, 3); assert.equal(r.result?.clientVersion, V, "staging runs nothing: the launcher still runs itself");
  const before = x.stateNow();
  const a = x.activation(await x.activate()); assert.equal(a?.ok, true, JSON.stringify(a)); assert.equal(a?.version, N1.version); assert.equal(a?.sha256, sha256(N1.bytes));
  const st = x.stateNow();
  assert.deepEqual({ version: st.active?.version, sha256: st.active?.sha256, size: st.active?.size }, { version: N1.version, sha256: sha256(N1.bytes), size: N1.bytes.length });
  assert.equal(st.serial, 3, "the serial survived activation"); assert.equal(st.policyFp, before.policyFp); assert.equal(st.releaseFp, before.releaseFp); assert.equal(st.gen, before.gen + 1);
  assert.equal(x.stagedOut().status, 0);
});
test("a policy commit AFTER activation, by the delegated real client: committed before its evidence request; serial, keys and active all kept", { skip }, async () => {
  const x = fresh("n2"); assert.equal((await x.stage("n2", N1)).status, 0); assert.equal(x.activation(await x.activate())?.ok, true);
  const before = x.stateNow();
  const r = await x.policyRun(policy("n2-4", 4), "n2-4");
  assert.equal(r.arrived, true, "the delegated client requested evidence"); assert.equal(r.committedBefore, true, "the commit line was printed before the evidence request");
  assert.equal(r.committed?.serial, 4); assert.equal(r.result?.clientVersion, N1.version, "the delegated real client ran it"); assert.equal(r.result?.step, "evidence"); assert.match(r.result?.refused || "", /no evidence/);
  assert.equal(L.count("n2-4:sealed"), 0, "nothing sealed: my relay gave no evidence (host evidence class, not attestation)");
  const st = x.stateNow();
  assert.equal(st.serial, 4); assert.equal(st.gen, before.gen + 1); assert.deepEqual(st.active, before.active, "active kept by the delegated client's commit"); assert.deepEqual(st.staged, before.staged);
  assert.equal(st.policyFp, before.policyFp); assert.equal(st.releaseFp, before.releaseFp);
});
test("a policy-key rotation committed by the delegated real client, then the successor key accepted and the retired key and a rollback refused; active kept throughout", { skip }, async () => {
  const x = fresh("n3"); assert.equal((await x.stage("n3", N1)).status, 0); assert.equal(x.activation(await x.activate())?.ok, true);
  const active = x.stateNow().active;
  let r = await x.policyRun(policy("n3-5", 5, { nextPolicyKey: rawPub(K.policy2).toString("hex") }), "n3-5"); assert.equal(r.committed?.serial, 5); assert.equal(r.result?.clientVersion, N1.version);
  let st = x.stateNow(); assert.equal(st.nextPolicyFp, fpOf(K.policy2)); assert.deepEqual(st.active, active);
  r = await x.policyRun(policy("n3-6", 6, { key: K.policy2 }), "n3-6"); assert.equal(r.committed?.serial, 6); assert.equal(r.result?.clientVersion, N1.version);
  st = x.stateNow(); assert.equal(st.policyFp, fpOf(K.policy2), "the anchor moved under the delegated client"); assert.equal(st.nextPolicyFp, null); assert.deepEqual(st.active, active);
  r = await x.policyRun(policy("n3-7", 7), "n3-7"); assert.equal(r.arrived, false, "the retired key's policy makes no request"); assert.equal(r.result?.step, "policy"); assert.equal(r.result?.clientVersion, N1.version);
  r = await x.policyRun(policy("n3-4", 4, { key: K.policy2 }), "n3-4"); assert.equal(r.arrived, false); assert.match(r.result?.refused || "", /rollback/);
  st = x.stateNow(); assert.equal(st.serial, 6); assert.deepEqual(st.active, active);
});
test("a release-key rotation carried by staging the next version after activation: staged moves, active and the serial stay, run still executes the active version", { skip }, async () => {
  const x = fresh("n4"); assert.equal((await x.stage("n4a", N1)).status, 0); assert.equal(x.activation(await x.activate())?.ok, true);
  let r = await x.policyRun(policy("n4-3", 3), "n4-3"); assert.equal(r.committed?.serial, 3);
  const before = x.stateNow();
  const u = await x.stage("n4b", N2, { nextReleaseKey: rawPub(K.release2).toString("hex") }); assert.equal(u.status, 0, u.out);
  let st = x.stateNow(); assert.equal(st.staged?.version, N2.version); assert.equal(st.nextReleaseFp, fpOf(K.release2)); assert.deepEqual(st.active, before.active); assert.equal(st.serial, 3);
  r = await x.policyRun(policy("n4-8", 8), "n4-8"); assert.equal(r.committed?.serial, 8); assert.equal(r.result?.clientVersion, N1.version, "run executes the active version, never the merely staged one");
  st = x.stateNow(); assert.equal(st.staged?.version, N2.version); assert.deepEqual(st.active, before.active); assert.equal(st.nextReleaseFp, fpOf(K.release2));
});
test("one hop under a concurrent activation: a held run of the first next version finishes as that version while the second is activated; the next run is the second; every field kept", { skip }, async () => {
  const x = fresh("n5"); assert.equal((await x.stage("n5a", N1)).status, 0); assert.equal(x.activation(await x.activate())?.ok, true);
  assert.equal((await x.stage("n5b", N2, { nextReleaseKey: rawPub(K.release2).toString("hex") })).status, 0);
  policy("n5-9", 9); policy("n5-10", 10);
  const held = x.run(["run", "--policy", `${L.base}/policy/n5-9`, "--relay", `${L.base}/r/n5-9`, "--app", APP, "--label", "n5-9"]);
  await L.evidenceRequested("n5-9");                                                     // the 0.3.1 child waits on my relay
  const a = x.activation(await x.activate()); assert.equal(a?.ok, true, JSON.stringify(a)); assert.equal(a?.version, N2.version);
  L.release("n5-9"); const h = await held.done;
  assert.equal(h.result?.clientVersion, N1.version, "the held child stayed the version it was handed (one hop), whatever the state says now"); assert.equal(h.result?.step, "evidence");
  const r = await x.policyRun("n5-10", "n5-10"); assert.equal(r.committed?.serial, 10); assert.equal(r.result?.clientVersion, N2.version, "the next run is the newly active version");
  const st = x.stateNow();
  assert.equal(st.serial, 10); assert.equal(st.active?.version, N2.version); assert.equal(st.active?.sha256, sha256(N2.bytes)); assert.equal(st.staged?.version, N2.version);
  assert.equal(st.policyFp, fpOf(K.policy)); assert.equal(st.releaseFp, fpOf(K.release)); assert.equal(st.nextReleaseFp, fpOf(K.release2));
});
test("the owner's derived device artifact behaves on the host exactly like the source rebuild: same version answer, activation, delegation and policy commit", { skip: skip || (!D1 && "no derived artifact recorded") }, async () => {
  const x = fresh("n6"); assert.equal((await x.stage("n6", D1)).status, 0);
  const a = x.activation(await x.activate()); assert.equal(a?.ok, true, JSON.stringify(a)); assert.equal(a?.sha256, sha256(D1.bytes));
  const r = await x.policyRun(policy("n6-2", 2), "n6-2"); assert.equal(r.committed?.serial, 2); assert.equal(r.result?.clientVersion, D1.version); assert.equal(r.committedBefore, true);
  const body = (b) => b.subarray(b.indexOf(10)); assert.ok(body(D1.bytes).equals(body(N1.bytes)), "beyond its first line the device artifact is the source rebuild");
});
test("a tampered active real file: refused at launch with what was found, nothing requested, state unchanged; repaired by re-staging the same artifact", { skip }, async () => {
  const x = fresh("n7"); assert.equal((await x.stage("n7", N1)).status, 0); assert.equal(x.activation(await x.activate())?.ok, true);
  const before = x.stateNow(), file = path.join(x.install, before.active.file);
  fs.rmSync(file); fs.writeFileSync(file, N2.bytes);
  let r = await x.policyRun(policy("n7-2", 2), "n7-2"); assert.equal(r.arrived, false, "nothing requested"); assert.equal(r.status, 2); assert.equal(r.result?.step, "launch"); assert.equal(r.result?.found, sha256(N2.bytes)); assert.equal(r.result?.clientVersion, undefined, "a launch refusal is the launcher's, not a client's result");
  assert.equal(x.stagedOut().status, 1); assert.deepEqual(x.stateNow(), before);
  fs.rmSync(file); assert.equal((await x.stage("n7", N1)).status, 0, "the same artifact re-publishes the file");
  r = await x.policyRun("n7-2", "n7-2b"); assert.equal(r.committed?.serial, 2); assert.equal(r.result?.clientVersion, N1.version);
});
