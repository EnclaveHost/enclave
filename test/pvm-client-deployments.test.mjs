// Deployment selection with caller-owned trust (client/DESIGN.md "Deployments"; since 0.4.0): a deployment's expected app
// comes from the verified, committed policy's signed table -- never from a catalog or a relay. The BUILT CLI in child
// processes against a fake VM (the selection refusals happen before any evidence request; a good selection reaches the
// VM's evidence with the table's app), and in process on the Pixel's REAL v2 evidence (the table's app releases; a table
// naming another app -- a genuine VM of the wrong app behind the relay -- is refused before anything is sealed).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { initialState, verifyPolicy, selectDeployment, CLIENT_VERSION } from "../shielded/anchor/avf/client/src/trust.js";
import { connect } from "../shielded/anchor/avf/client/src/client.js";
import { FileStore } from "../shielded/anchor/avf/client/src/store-file.js";
import { tmpdir, makeCa, haveOpenssl } from "./fixtures/avf-synthetic.mjs";
import { startFakeVm } from "./fixtures/pvm-fake-vm.mjs";
import { createWebCarrier } from "../shielded/anchor/avf/cpu/web-carrier.mjs";

const CLI = new URL("../shielded/anchor/avf/client/dist/pvm-client.mjs", import.meta.url).pathname;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const key = () => { const k = generateKeyPairSync("ed25519"); const pub = k.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex"); return { k, pub, fp: sha(Buffer.from(pub, "hex")) }; };
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const APP = "1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339";   // the fake VM's app
const OTHER = "ee".repeat(32);
const D1 = "0x" + "d1".repeat(32), D2 = "0x" + "d2".repeat(32), D3 = "0x" + "d3".repeat(32);
const PIXEL_RID = sha('{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}');
const policy = (P, over = {}, now = Date.now()) => {
  const body = { type: "enclave-pvm-client-policy", key: P.pub, serial: 5, notBefore: iso(now - 3600e3), notAfter: iso(now + 86400e3),
    codeHashes: ["6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990"], authorityHashes: ["cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f"], // gitleaks:allow -- public: sha512 of the TEST signing certificate
    runtimeIds: [PIXEL_RID], appIds: [APP, OTHER], googleRootPins: ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"],
    formats: ["enclave-pvm-app-evidence/v2"], sealedModes: ["chunked", "whole"], sealedWindow: { seconds: 600, maxRequests: 256 },
    minClientVersion: "0.1.0", nextPolicyKey: null, deployments: [{ id: D1, app: APP }, { id: D2, app: OTHER }], ...over };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  const t = JSON.stringify(body);
  return { policy: Buffer.from(t).toString("base64"), sig: edSign(null, Buffer.concat([Buffer.from("enclave-pvm-client-policy-v1\n"), Buffer.from(t)]), P.k.privateKey).toString("hex") };
};
const cli = (args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, ...args]); let out = "";
  c.stdout.on("data", (d) => (out += d));
  const t = setTimeout(() => c.kill("SIGKILL"), 60000);
  c.on("close", (code) => { clearTimeout(t); resolve({ code, lines: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)) }); });
});

test("the policy's deployment table: optional, closed, unique, admitted apps only; the selection is exact", async () => {
  const P = key(), state = initialState({ policyKeyFp: P.fp, serialFloor: 1, releaseKeyFp: key().fp });
  const ok = await verifyPolicy(policy(P), { state }); assert.equal(ok.ok, true, ok.reasons[0]);
  assert.equal((await verifyPolicy(policy(P, { deployments: undefined }), { state })).ok, true, "no table: exactly the 15 fields, as before 0.4.0");
  for (const [over, why] of [
    [{ deployments: [] }, /1\.\.64 entries/], [{ deployments: {} }, /1\.\.64 entries/],
    [{ deployments: [{ id: D1, app: APP }, { id: D1, app: OTHER }] }, /deployment id twice/],
    [{ deployments: [{ id: D1, app: "ab".repeat(32) }] }, /not one of the policy's appIds/],
    [{ deployments: [{ id: D1.toUpperCase().replace("0X", "0x"), app: APP }] }, /0x \+ 64 lowercase hex/], [{ deployments: [{ id: "d1".repeat(32), app: APP }] }, /0x \+ 64 lowercase hex/],
    [{ deployments: [{ id: D1, app: APP, relay: "https://x" }] }, /exactly \{ id, app \}/], [{ deployments: [{ id: D1 }] }, /exactly \{ id, app \}/],
    [{ deployments: [D1] }, /exactly \{ id, app \}/], [{ deployments: [null] }, /exactly \{ id, app \}/], [{ deployments: [[D1, APP]] }, /exactly \{ id, app \}/],
    [{ deployments: D1 }, /1\.\.64 entries/], [{ deployments: null }, /1\.\.64 entries/],
    [{ deploymentz: [] }, /fields must be exactly/],
  ]) { const r = await verifyPolicy(policy(P, over), { state }); assert.equal(r.ok, false, JSON.stringify(over)); assert.match(r.reasons[0], why); }
  const p = ok.policy;
  assert.deepEqual(selectDeployment(p, { deployment: D1 }), { ok: true, app: APP, deployment: D1, instances: null });
  assert.deepEqual(selectDeployment(p, { deployment: D1, app: APP }), { ok: true, app: APP, deployment: D1, instances: null });
  assert.match(selectDeployment(p, { deployment: D1, app: OTHER }).reason, /is not the app the policy expects/);
  assert.match(selectDeployment(p, { deployment: D3 }).reason, /does not name deployment/);
  assert.match(selectDeployment(p, { deployment: D1.toUpperCase() }).reason, /not normalized/);
  assert.match(selectDeployment({ ...p, deployments: undefined }, { deployment: D1 }).reason, /names no deployments/);
  assert.match(selectDeployment(p, {}).reason, /no app or deployment selected/);
});

test("the built CLI: a deployment's app comes from the signed table; unknown, mismatched, repeated, non-canonical, tableless, forged and rolled-back selections are refused before any evidence request", { skip: !haveOpenssl && "no openssl", timeout: 180000 }, async () => {
  const cadir = tmpdir("pvm-dep-ca-"), ca = makeCa(cadir);
  const vm = await startFakeVm({ dir: cadir, ca, code: Buffer.from("6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990", "hex"), appId: APP });
  const carrier = createWebCarrier({ port: 0, evidencePort: vm.evidencePort, sealedPort: vm.sealedPort });
  await new Promise((r) => carrier.on("listening", r));
  const relay = `http://127.0.0.1:${carrier.address().port}`;
  const dir = tmp("pvm-dep-"), st = path.join(dir, "state"), P = key(), R = key(), X = key();
  const write = (o) => { const f = path.join(dir, `p-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(o)); return f; };
  const evidence = () => vm.log.filter((l) => l.evidence).length;
  const run = async (pol, sel) => { const o = await cli(["run", "--state", st, "--policy", write(pol), "--relay", relay, ...sel]); return { ...o, result: o.lines.at(-1).result }; };
  // one clock for every policy this test signs: the same intent is the same bytes (a policy re-signed a second later would
  // differ in its validity window and be refused, correctly, as equivocation)
  const T0 = Date.now(), pol = (over) => policy(P, over, T0);
  try {
    assert.equal((await cli(["install", "--state", st, "--policy-key-fp", P.fp, "--serial-floor", "1", "--release-key-fp", R.fp])).code, 0);
    // the selection list comes from the verified policy
    const l = await cli(["deployments", "--state", st, "--policy", write(pol({ serial: 5 }))]);
    assert.equal(l.code, 0); assert.deepEqual(l.lines[0].deployments, [{ id: D1, app: APP }, { id: D2, app: OTHER }]); assert.equal(l.lines[0].policySerial, 5);
    // a good selection: the table's app, all the way to the VM's evidence (the fake VM's chain is not Google's: refused there)
    let e0 = evidence();
    const good = await run(pol({ serial: 5 }), ["--deployment", D1]);
    assert.equal(good.result.step, "verify", JSON.stringify(good.result)); assert.match(good.result.refused, /not a pinned Google attestation root/);
    assert.deepEqual(good.result.deployment, { id: D1, app: APP, instance: null, bound: false }); assert.equal(good.result.clientVersion, CLIENT_VERSION);
    assert.equal(evidence(), e0 + 1, "it asked the VM for evidence, for the table's app");
    // a relay URL that names ANOTHER deployment never feeds selection: --deployment decides, and the result names it (the
    // carrier path does not exist on the lab carrier, so the exchange ends at evidence -- the selection is what is asserted)
    const viaUrl = await cli(["run", "--state", st, "--policy", write(pol({ serial: 5 })), "--relay", `${relay}/x/${D2}/pvm`, "--deployment", D1]);
    const vr = viaUrl.lines.at(-1).result;
    assert.deepEqual(vr.deployment, { id: D1, app: APP, instance: null, bound: false }, JSON.stringify(vr)); assert.equal(vr.sent, false);
    // refused at "select", after the policy was verified and committed, before ANY evidence request
    e0 = evidence();
    // a table present (the committed serial 5, the same bytes), and neither --deployment nor --app: no default entry
    const none = await run(pol({ serial: 5 }), []);
    assert.equal(none.result.step, "select", JSON.stringify(none.result)); assert.match(none.result.refused, /no app or deployment selected/);
    for (const [sel, why] of [
      [["--deployment", D3], /does not name deployment/],
      [["--deployment", D1, "--app", OTHER], /is not the app the policy expects/],
      [["--deployment", D1.toUpperCase().replace("0X", "0x")], /not normalized/],
      [["--deployment", "d1".repeat(32)], /not normalized/],
    ]) {
      const r = await run(pol({ serial: 5 }), sel);
      assert.equal(r.result.step, "select", JSON.stringify([sel, r.result])); assert.match(r.result.refused, why); assert.equal(r.result.sent, false); assert.notEqual(r.code, 0);
    }
    const noTable = await run(pol({ serial: 5, deployments: undefined }), ["--deployment", D1]);
    assert.equal(noTable.result.step, "policy", "a second policy with serial 5 and other bytes: equivocation, refused before selection");
    const noTable6 = await run(pol({ serial: 6, deployments: undefined }), ["--deployment", D1]);
    assert.equal(noTable6.result.step, "select"); assert.match(noTable6.result.refused, /names no deployments/);
    // no table and --app also given: still refused at select -- never a silent fall-back to --app
    const noTableApp = await run(pol({ serial: 6, deployments: undefined }), ["--deployment", D1, "--app", APP]);
    assert.equal(noTableApp.result.step, "select"); assert.match(noTableApp.result.refused, /names no deployments/);

    // repeated flags: refused before the policy is even fetched
    for (const sel of [["--deployment", D1, "--deployment", D2], ["--app", APP, "--app", OTHER], ["--deployment", D1, "--app", APP, "--app", APP]]) {
      const r = await run(pol({ serial: 7 }), sel);
      assert.equal(r.result.step, "select"); assert.match(r.result.refused, /more than once: ambiguous/); assert.equal(r.code, 2);
    }
    assert.equal((await cli(["state", "--state", st])).lines[0].state.serial, 6, "the repeated-flag runs fetched nothing: serial 7 was never seen");
    // substitution: a policy signed by another key, and an unsigned "catalog" served where the policy should be
    const forged = await run(policy(X, { serial: 9, deployments: [{ id: D1, app: OTHER }] }, T0), ["--deployment", D1]);
    assert.equal(forged.result.step, "policy"); assert.match(forged.result.refused, /anchor does not name/);
    const catalog = await run({ deployments: [{ id: D1, app: OTHER }] }, ["--deployment", D1]);
    assert.equal(catalog.result.step, "policy"); assert.match(catalog.result.refused, /exactly \{ policy, sig \}/);
    // rollback: serial 8 moves D1 to the other app; an older serial re-pointing it back is refused
    const moved = await run(pol({ serial: 8, deployments: [{ id: D1, app: OTHER }] }), ["--deployment", D1]);
    assert.equal(moved.result.step, "verify"); assert.deepEqual(moved.result.deployment, { id: D1, app: OTHER, instance: null, bound: false });
    const back = await run(pol({ serial: 7, deployments: [{ id: D1, app: APP }] }), ["--deployment", D1]);
    assert.equal(back.result.step, "policy"); assert.match(back.result.refused, /rollback/);
    // equivocation: the same serial 8, the table changed
    const eq = await run(pol({ serial: 8, deployments: [{ id: D1, app: APP }] }), ["--deployment", D1]);
    assert.equal(eq.result.step, "policy"); assert.match(eq.result.refused, /equivocation/);
    assert.equal(evidence(), e0 + 1, "of all the refused selections, only the genuine newer table (serial 8) reached the VM's evidence");
    assert.equal(vm.log.filter((x) => x.served).length, 0, "nothing was ever sealed to the fake VM");
  } finally { carrier.close(); vm.close(); }
});

test("in process, on the Pixel's REAL v2 evidence: the table's app for the deployment releases and is named; a table naming another app for it is refused before anything is sealed", async () => {
  const env = JSON.parse(fs.readFileSync(new URL("../shielded/anchor/avf/results/pvm-cpu-browser-channel/l1-evidence.json", import.meta.url)));
  const at = Date.parse("2026-09-24T07:26:36Z");
  const P = key();
  const store = new FileStore(path.join(tmp("pvm-dep-real-"), "state.d"));
  store.init({ ...initialState({ policyKeyFp: P.fp, serialFloor: 1, releaseKeyFp: key().fp }), staged: null, active: null });
  let sealedSeen = 0;
  const srv = http.createServer((q, s) => { let b = ""; q.on("data", (d) => { b += d; }); q.on("end", () => {
    if (q.url === "/evidence") return s.end(JSON.stringify(env) + "\n");
    sealedSeen++; s.writeHead(502); s.end(); }); }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.on("listening", r));
  const relay = `http://127.0.0.1:${srv.address().port}`;
  const orig = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = (a) => { if (a.length === 32) { a.set(Buffer.from(env.nonce, "hex")); return a; } return orig(a); };
  try {
    const pol = (serial, app) => policy(P, { serial, appIds: [env.app, OTHER], deployments: [{ id: D1, app }], codeHashes: ["6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990"] }, at);
    // the relay (or a catalog) cannot make D1 mean another app: a table that says so is followed, and the real VM is refused
    const wrong = await connect({ relay, policyEnv: pol(2, OTHER), store, deployment: D1, path: "/", usedNonces: new Set(), now: at });
    assert.equal(wrong.result.step, "verify", JSON.stringify(wrong.result)); assert.equal(wrong.result.sent, false); assert.equal(sealedSeen, 0);
    assert.deepEqual(wrong.result.deployment, { id: D1, app: OTHER, instance: null, bound: false });
    const right = await connect({ relay, policyEnv: pol(3, env.app), store, deployment: D1, path: "/?graph=g&steps=3", usedNonces: new Set(), now: at });
    assert.equal(right.result.step, "sealed", JSON.stringify(right.result)); assert.equal(right.result.sent, true); assert.equal(sealedSeen, 1, "released: sealed and sent once");
    assert.deepEqual(right.result.deployment, { id: D1, app: env.app, instance: null, bound: false }); assert.equal(right.result.verified.app, env.app);
  } finally { crypto.getRandomValues = orig; srv.close(); }
});

test("the operator side: lab-sign.mjs writes a policy only if the client's own verifyPolicy accepts it (a table every client would refuse is an outage)", async () => {
  const SIGN = new URL("../shielded/anchor/avf/client/tools/lab-sign.mjs", import.meta.url).pathname;
  const keys = tmp("pvm-dep-keys-"), dir = tmp("pvm-dep-sign-");
  const node = (args) => new Promise((resolve) => { const c = spawn(process.execPath, [SIGN, ...args]); let err = ""; c.stderr.on("data", (d) => (err += d)); c.on("close", (code) => resolve({ code, err })); });
  assert.equal((await node(["keygen", "--keys", keys, "--name", "policy"])).code, 0);
  const now = Date.now(), base = { type: "enclave-pvm-client-policy", key: "", serial: 3, notBefore: iso(now - 3600e3), notAfter: iso(now + 3600e3),
    codeHashes: ["aa".repeat(32)], authorityHashes: ["bb".repeat(64)], runtimeIds: ["cc".repeat(32)], appIds: [APP], googleRootPins: ["6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"],
    formats: ["enclave-pvm-app-evidence/v2"], sealedModes: ["chunked"], sealedWindow: { seconds: 600, maxRequests: 256 }, minClientVersion: "0.1.0", nextPolicyKey: null };
  for (const [name, body, ok, why] of [
    ["good", { ...base, deployments: [{ id: D1, app: APP }] }, true],
    ["unadmitted-app", { ...base, deployments: [{ id: D1, app: OTHER }] }, false, /not one of the policy's appIds/],
    ["duplicate-id", { ...base, deployments: [{ id: D1, app: APP }, { id: D1, app: APP }] }, false, /deployment id twice/],
    ["empty-table", { ...base, deployments: [] }, false, /1\.\.64 entries/],
    ["expired", { ...base, notAfter: iso(now - 10e3) }, false, /expired/],
  ]) {
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body));
    const out = path.join(dir, `${name}.signed.json`), r = await node(["policy", "--keys", keys, "--body", path.join(dir, `${name}.json`), "--out", out]);
    if (ok) { assert.equal(r.code, 0, r.err); assert.ok(fs.existsSync(out)); }
    else { assert.equal(r.code, 2, name); assert.match(r.err, why); assert.equal(fs.existsSync(out), false, `${name}: nothing written`); }
  }
});
