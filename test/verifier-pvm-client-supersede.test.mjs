// Superseded-policy refusal at REQUEST RELEASE, against the owner's pinned SOURCE (pin pvm-client-src): client A
// commits policy serial 5 and its evidence request is held; meanwhile client B commits serial 6; when A's evidence is
// released with an envelope the (stubbed) verifier accepts, A must re-read the committed state just before sealing, find
// itself superseded, refuse at step "gate" and send NO sealed request. Only web/pvm-verify.js as imported by
// web/pvm-client.js is replaced (a Node loader hook, test/helpers/pvm-verify-stub-*.mjs); cli.mjs, the flow, the store,
// the gate and the sealing are the owner's code at the pinned commit. This is a source-level check, not one against the
// built artifact, and it is stated as such in the docs.
//   run: ENCLAVE_PVM_CLIENT_SRC=<pinned cli.mjs> node --test test/verifier-pvm-client-supersede.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { labServer, keys, signedPolicy, rawPub, APP, cliRun, committedState, install } from "./helpers/pvm-lab.mjs";

const SRC = process.env.ENCLAVE_PVM_CLIENT_SRC || "";
const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
if (STRICT && !(SRC && fs.existsSync(SRC))) throw new Error("strict integration: ENCLAVE_PVM_CLIENT_SRC (the pinned client source) is missing");
const skip = !(SRC && fs.existsSync(SRC)) && !STRICT && "pinned client source absent (node verifier/integration/resolve.mjs --pin pvm-client-src, then ENCLAVE_PVM_CLIENT_SRC)";
const HOOK = ["--import", new URL("./helpers/pvm-verify-stub-register.mjs", import.meta.url).href];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-supersede-"));
const K = keys(); const appKeyHex = rawPub(K.x25519).toString("hex");
const envelope = (nonce) => ({ format: "enclave-pvm-app-evidence/v2", lab: "stub-evidence", nonce, app: APP, spki: "302a300506032b6570032100" + "ab".repeat(32), identity: "{}", selftest: "x", chain: [], appKey: appKeyHex, appKeySig: "00".repeat(64) });
let L; test.before(async () => { L = await labServer(); L.evidenceAnswer = envelope; });
test.after(() => { L?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const run = (state, policy, label) => cliRun(SRC, tmp, ["run", "--policy", `${L.base}/policy/${policy}`, "--relay", `${L.base}/r/${label}`, "--app", APP, "--state", state, "--label", label, "--whole"], { nodeArgs: HOOK });

test("control: with the stubbed verifier the flow reaches the sealed request (the relay records it), so the supersede case is reachable", { skip }, async () => {
  const state = path.join(tmp, "c", "state.d"); install(SRC, tmp, state, K);
  L.policies.set("c5", signedPolicy(K, 5));
  const a = run(state, "c5", "c-a"); await L.evidenceRequested("c-a"); L.release("c-a");
  await L.sealedRequested("c-a"); const ra = await a.done;
  assert.equal(ra.result?.sent, true, `the private request was released (${JSON.stringify(ra.result)})`); assert.equal(ra.result?.step, "sealed");
  assert.equal(ra.committed?.serial, 5);
});
test("superseded at release: serial 6 committed while A waited for evidence makes A refuse at the gate, and no sealed request leaves", { skip }, async () => {
  const state = path.join(tmp, "s", "state.d"); install(SRC, tmp, state, K);
  L.policies.set("s5", signedPolicy(K, 5)); L.policies.set("s6", signedPolicy(K, 6));
  const a = run(state, "s5", "s-a"); await L.evidenceRequested("s-a"); assert.equal(committedState(SRC, tmp, state)?.serial, 5);
  const b = run(state, "s6", "s-b"); await L.evidenceRequested("s-b"); assert.equal(committedState(SRC, tmp, state)?.serial, 6);
  L.release("s-a"); const ra = await a.done;            // A's evidence now verifies (stub); A must notice it was superseded
  assert.equal(ra.result?.step, "gate", `A must refuse at the gate (${JSON.stringify(ra.result)})`); assert.match(ra.result?.refused || "", /serial 5 was superseded by serial 6/);
  assert.equal(ra.result?.sent, false); assert.equal(L.count("s-a:sealed"), 0, "no sealed request under the superseded policy");
  L.release("s-b"); await L.sealedRequested("s-b"); const rb = await b.done; assert.equal(rb.result?.sent, true);
  assert.equal(committedState(SRC, tmp, state)?.serial, 6);
});
test("superseded by a rotation: the successor key's policy committed meanwhile supersedes A the same way", { skip }, async () => {
  const state = path.join(tmp, "r", "state.d"); install(SRC, tmp, state, K);
  L.policies.set("r5", signedPolicy(K, 5, { nextPolicyKey: rawPub(K.policy2).toString("hex") })); L.policies.set("r6", signedPolicy(K, 6, { key: K.policy2 }));
  const a = run(state, "r5", "r-a"); await L.evidenceRequested("r-a");
  const b = run(state, "r6", "r-b"); await L.evidenceRequested("r-b");
  L.release("r-a"); const ra = await a.done; assert.equal(ra.result?.step, "gate"); assert.equal(L.count("r-a:sealed"), 0);
  L.release("r-b"); await L.sealedRequested("r-b"); await b.done;
});
test("the stub is the only difference: an envelope for another nonce is refused at verify, as the real verifier would refuse it", { skip }, async () => {
  const state = path.join(tmp, "n", "state.d"); install(SRC, tmp, state, K);
  L.policies.set("n5", signedPolicy(K, 5));
  L.evidenceAnswer = () => envelope("0".repeat(64));
  const a = run(state, "n5", "n-a"); await L.evidenceRequested("n-a"); L.release("n-a"); const ra = await a.done;
  assert.equal(ra.result?.step, "verify"); assert.match(ra.result?.refused || "", /another nonce/); assert.equal(L.count("n-a:sealed"), 0);
  L.evidenceAnswer = envelope;
});
