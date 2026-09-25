// Evidence v3 and policy type 2 (shielded/anchor/avf/INSTANCE-BINDING.md, agreed with the verifier session): a deployment
// bound to VM INSTANCES by the signed policy is served only by those instances, through the real client, the relay's pVM
// route (relay/pvm-serving.mjs) and fake VMs that speak the device's wire protocol (test/fixtures/pvm-fake-vm.mjs).
//   - IN PROCESS: the client's own connect(), gate and sealed channel, with the synthetic test root admitted in THIS process
//     only (pushed onto the client's built-in root list), so the cases reach the instance checks: bound, swapped instance,
//     wrong deployment, restart, rotation and rollback, downgrade, an old VM, unbound entries, enrollment.
//   - The BUILT artifacts (0.5.0 dist, and 0.4.1 from its commit) never trust that root: the cases they can show are the
//     ones refused before any certificate -- a downgrade, an old client given a type-2 policy, carrier refusals.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { createPvmServing } from "../relay/pvm-serving.mjs";
import { GOOGLE_ATTESTATION_ROOT_SHA256 } from "../shielded/anchor/avf/web/pvm-verify.js";
import { initialState } from "../shielded/anchor/avf/client/src/trust.js";
import { connect } from "../shielded/anchor/avf/client/src/client.js";
import { enrollInstance } from "../shielded/anchor/avf/client/src/enroll.js";
import { carrierFor, PLATFORM_RELAYS } from "../shielded/anchor/avf/client/src/carrier.js";
import { FileStore } from "../shielded/anchor/avf/client/src/store-file.js";
import { tmpdir, makeCa, haveOpenssl, AUTH } from "./fixtures/avf-synthetic.mjs";
import { startFakeVm, newInstance, PIXEL } from "./fixtures/pvm-fake-vm.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const CLI = path.join(ROOT, "shielded/anchor/avf/client/dist/pvm-client.mjs");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const key = () => { const k = generateKeyPairSync("ed25519"); const pub = k.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex"); return { k, pub, fp: sha(Buffer.from(pub, "hex")) }; };
const APP = "1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339", OTHER = "0b".repeat(32);
const CODE = createHash("sha256").update("pvm v3 test build").digest();
const D1 = "0x" + "d1".repeat(32), D2 = "0x" + "d2".repeat(32), D3 = "0x" + "d3".repeat(32);
const GOOGLE = "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0";
const V3 = "enclave-pvm-app-evidence/v3", V2 = "enclave-pvm-app-evidence/v2";

/** A type-2 policy (or type 1 with `type`), signed by P. */
function policy(P, { serial = 1, deployments, rootPin = GOOGLE, formats = [V3, V2], type = "enclave-pvm-client-policy/2", now = Date.now() } = {}) {
  const t = JSON.stringify({ type, key: P.pub, serial, notBefore: iso(now - 3600e3), notAfter: iso(now + 86400e3), codeHashes: [CODE.toString("hex")],
    authorityHashes: [AUTH.toString("hex")], runtimeIds: [sha(PIXEL)], appIds: [APP, OTHER], googleRootPins: [rootPin], formats,
    sealedModes: ["chunked", "whole"], sealedWindow: { seconds: 600, maxRequests: 256 }, minClientVersion: "0.5.0", nextPolicyKey: null, deployments });
  return { policy: Buffer.from(t).toString("base64"), sig: edSign(null, Buffer.concat([Buffer.from("enclave-pvm-client-policy-v1\n"), Buffer.from(t)]), P.k.privateKey).toString("hex") };
}
// the relay's pVM route over a stand-in for tunnel.js spliceRaw (the real hub is driven in pvm-relay-serving.test.mjs): the
// LEDGER maps a deployment to a tunnel, and a test re-points it -- a relay routing D anywhere it likes
function relayOver(tunnels) {
  const ledger = {};
  const hub = { spliceRaw(name, socket, kind) {
    const vm = tunnels[name]; if (!vm) { socket.destroy(); return false; }
    socket.pause();
    const up = net.connect(kind === "pvm-evidence" ? vm.evidencePort : vm.sealedPort, "127.0.0.1", () => { socket.on("data", (d) => up.write(d)); socket.resume(); });
    up.on("data", (d) => socket.write(d)); up.on("close", () => socket.destroy()); up.on("error", () => socket.destroy()); socket.on("close", () => up.destroy());
    return true;
  } };
  const handle = createPvmServing({ resolve: async (id) => (ledger[id] ? `tunnel://${ledger[id]}` : null), hub });
  const srv = http.createServer((q, s) => { if (!handle(q, s)) { s.writeHead(404); s.end(); } });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, ledger, base: `http://127.0.0.1:${srv.address().port}` })));
}
const served = (vm) => vm.log.filter((l) => l.served).length;

test("IN PROCESS, the client's own code: a bound deployment is served by its instances only -- swapped, wrong-deployment, downgraded and old-format answers are refused before anything is sealed; restart keeps the binding; rotation moves it only by a newer serial", { skip: !haveOpenssl && "no openssl", timeout: 240000 }, async () => {
  const dir = tmpdir("pvm-v3-e2e-"), ca = makeCa(dir);
  GOOGLE_ATTESTATION_ROOT_SHA256.push(ca.rootPin);   // THIS process only: the built artifacts never see it (next test)
  const I1 = newInstance(), I2 = newInstance(), I3 = newInstance();
  const mk = (o) => startFakeVm({ dir, ca, code: CODE, appId: APP, ...o });
  const vm = { i1: await mk({ instance: I1 }), i2: await mk({ instance: I2 }), i3: await mk({ instance: I3 }), i1b: await mk({ instance: I1 }),
               down: await mk({ instance: I1, forge: "downgrade" }), old: await mk({ instance: I1, forge: "no-v3" }), other: await mk({ instance: I3, appId: OTHER }) };
  const id = Object.fromEntries(Object.entries(vm).map(([k, v]) => [k, v.instanceId]));
  assert.equal(id.i1, id.i1b, "a RESTART (new transport key) keeps the instance"); assert.notEqual(vm.i1.transportSpki, vm.i1b.transportSpki);
  assert.notEqual(id.i1, id.i2);
  const { srv, ledger, base } = await relayOver(vm);
  const P = key(), store = new FileStore(path.join(tmpdir("pvm-v3-state-"), "state.d"));
  store.init({ ...initialState({ policyKeyFp: P.fp, serialFloor: 1, releaseKeyFp: key().fp }), staged: null, active: null });
  const table = (i1s) => [{ id: D1, app: APP, instances: i1s }, { id: D2, app: APP, instances: [id.i2] }, { id: D3, app: APP }];
  let pol = policy(P, { serial: 1, deployments: table([id.i1]), rootPin: ca.rootPin });
  const run = async (dep, tunnel, p = pol) => { ledger[dep] = tunnel;
    return (await connect({ relay: carrierFor({ relayBase: base, deployment: dep }).url, policyEnv: p, store, deployment: dep, usedNonces: new Set() })).result; };
  try {
    // bound: the listed instance serves, and the result names it
    const ok = await run(D1, "i1");
    assert.equal(ok.complete, true, JSON.stringify(ok)); assert.equal(ok.verified.format, V3);
    assert.deepEqual(ok.deployment, { id: D1, app: APP, instance: id.i1, bound: true }); assert.equal(served(vm.i1), 1);
    // swapped instance: ANOTHER genuine instance of the SAME app -- refused at the instance check, nothing sealed
    const sw = await run(D1, "i2");
    assert.equal(sw.step, "verify"); assert.match(sw.refused, /not one bound to the selected deployment/); assert.equal(sw.sent, false); assert.equal(served(vm.i2), 0);
    assert.equal(sw.deployment.instance, null, "a refused exchange names no instance as bound");
    // wrong deployment: D2's own instance answers for D1 -- refused; the same instance for D2 is served
    const d2 = await run(D2, "i2");
    assert.equal(d2.complete, true, JSON.stringify(d2)); assert.equal(d2.deployment.instance, id.i2);
    // the limit v2 left open (pvm-relay-serving "the stated limit"), now closed for bound deployments: one instance routed as
    // both D1 and D2 answers only for the deployment that lists it
    const both = await run(D2, "i1");
    assert.equal(both.step, "verify"); assert.match(both.refused, /not one bound/);
    // restart: the same instance with a fresh transport key keeps the binding
    const rs = await run(D1, "i1b");
    assert.equal(rs.complete, true, JSON.stringify(rs)); assert.equal(rs.deployment.instance, id.i1); assert.notEqual(rs.verified.key, ok.verified.key);
    // downgrade: v2 in answer to EVIDENCE3 -- refused by name before any certificate; an OLD VM that does not know EVIDENCE3 -- refused
    const dg = await run(D1, "down");
    assert.equal(dg.step, "verify"); assert.match(dg.refused, /unbound evidence format .* refused as a downgrade/); assert.equal(served(vm.down), 0);
    const old = await run(D1, "old");   // an OLD build answers EVIDENCE3 with its own error line: no evidence, in the VM's words
    assert.equal(old.step, "evidence"); assert.match(old.refused, /the VM answered with an error, not evidence: "request is EVIDENCE/); assert.equal(old.sent, false);
    // an UNBOUND entry keeps the 0.4 rule: v2, and it says it is not bound
    const ub = await run(D3, "i3");
    assert.equal(ub.complete, true, JSON.stringify(ub)); assert.equal(ub.verified.format, V2); assert.deepEqual(ub.deployment, { id: D3, app: APP, instance: null, bound: false });
    // ENROLLMENT, then rotation: the signer enrolls I3 for D1 under their own nonce; its record is what they sign
    ledger[D1] = "i3";
    const en = await enrollInstance({ relay: carrierFor({ relayBase: base, deployment: D1 }).url, policyEnv: pol, store, deployment: D1 });
    assert.equal(en.ok, true, JSON.stringify(en)); assert.equal(en.record.instanceId, id.i3); assert.equal(en.record.alreadyBound, false);
    assert.equal(en.record.envelope.format, V3); assert.equal(en.record.envelope.nonce, en.record.nonce); assert.equal(en.record.policySerial, 1);
    assert.ok(en.record.reasons.some((r) => r.includes("instance key signed")), "the whole verification is recorded");
    assert.equal(served(vm.i3), 1, "enrollment sealed nothing: the one served request is the unbound D3 exchange");
    // enrollment for another app's VM is refused (the ENTRY's app is expected), and for a deployment the table lacks
    ledger[D1] = "other";
    const eo = await enrollInstance({ relay: carrierFor({ relayBase: base, deployment: D1 }).url, policyEnv: pol, store, deployment: D1 });
    assert.equal(eo.ok, false); assert.equal(eo.step, "verify"); assert.match(eo.refused, /names another app/);
    const en2 = await enrollInstance({ relay: `${base}/x/${"0x" + "d9".repeat(32)}/pvm`, policyEnv: pol, store, deployment: "0x" + "d9".repeat(32) });
    assert.equal(en2.step, "select");
    // rotation: under serial 1, I3 is refused for D1; serial 2 lists I1 and I3 (overlap); serial 3 drops I1
    assert.match((await run(D1, "i3")).refused, /not one bound/);
    const s2 = policy(P, { serial: 2, deployments: table([id.i1, en.record.instanceId]), rootPin: ca.rootPin });
    for (const t of ["i1", "i3"]) { const r = await run(D1, t, s2); assert.equal(r.complete, true, `${t}: ${JSON.stringify(r)}`); }
    const s3 = policy(P, { serial: 3, deployments: table([id.i3]), rootPin: ca.rootPin });
    assert.equal((await run(D1, "i3", s3)).complete, true);
    const gone = await run(D1, "i1", s3);
    assert.equal(gone.step, "verify"); assert.match(gone.refused, /not one bound/, "the rotated-out instance is refused");
    const back = await run(D1, "i1", s2);
    assert.equal(back.step, "policy"); assert.match(back.refused, /rollback/, "the older policy that still listed it is refused");
  } finally { GOOGLE_ATTESTATION_ROOT_SHA256.splice(GOOGLE_ATTESTATION_ROOT_SHA256.indexOf(ca.rootPin), 1); srv.close(); for (const v of Object.values(vm)) v.close(); }
});

const cli = (bin, args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [bin, ...args]); let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.on("close", (code) => { const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)); resolve({ code, lines, result: lines.reverse().find((l) => l.result)?.result, enroll: lines.find((l) => l.enroll)?.enroll }); });
});

test("the BUILT artifacts: 0.5.0 refuses a downgrade by name and never trusts the synthetic root; 0.4.1 refuses a type-2 policy outright; carriers are the compiled-in platform relay or a lab loopback only; the manifest grants exactly those origins", { skip: !haveOpenssl && "no openssl", timeout: 240000 }, async () => {
  const dir = tmpdir("pvm-v3-cli-"), ca = makeCa(dir), I1 = newInstance();
  const vm = { i1: await startFakeVm({ dir, ca, code: CODE, appId: APP, instance: I1 }), down: await startFakeVm({ dir, ca, code: CODE, appId: APP, instance: I1, forge: "downgrade" }) };
  const { srv, ledger, base } = await relayOver(vm);
  const work = tmpdir("pvm-v3-cli-state-"), P = key(), R = key(), pf = path.join(work, "p.json");
  fs.writeFileSync(pf, JSON.stringify(policy(P, { deployments: [{ id: D1, app: APP, instances: [vm.i1.instanceId] }] })));   // Google's root: the real pin
  try {
    const st = path.join(work, "state");
    assert.equal((await cli(CLI, ["install", "--state", st, "--policy-key-fp", P.fp, "--serial-floor", "1", "--release-key-fp", R.fp])).code, 0);
    ledger[D1] = "down";
    const dg = await cli(CLI, ["run", "--state", st, "--policy", pf, "--relay-base", base, "--deployment", D1]);
    assert.equal(dg.result.step, "verify"); assert.match(dg.result.refused, /refused as a downgrade/); assert.equal(dg.result.clientVersion, "0.5.0");
    ledger[D1] = "i1";
    const syn = await cli(CLI, ["run", "--state", st, "--policy", pf, "--relay-base", base, "--deployment", D1]);
    assert.equal(syn.result.step, "verify"); assert.match(syn.result.refused, /not a pinned Google attestation root/, "the artifact never trusts the test root");
    const out = path.join(work, "enroll.json");
    const en = await cli(CLI, ["instance", "--state", st, "--policy", pf, "--relay-base", base, "--deployment", D1, "--out", out]);
    assert.equal(en.enroll.ok, false); assert.equal(en.enroll.step, "verify"); assert.equal(fs.existsSync(out), false, "a refused enrollment writes no record");
    // carriers
    for (const [args, re] of [[["--relay-base", "https://evil.example"], /not a platform relay/], [["--relay-base", base, "--relay", `${base}/x/${D1}/pvm`], /ambiguous/],
                              [["--relay-base", base, "--relay-base", base], /more than once/], [[], /no carrier/]]) {
      const r = await cli(CLI, ["run", "--state", st, "--policy", pf, "--deployment", D1, ...args]);
      assert.match(r.result.refused, re, JSON.stringify(args)); assert.equal(r.result.sent, false);
    }
    assert.match((await cli(CLI, ["run", "--state", st, "--policy", pf, "--app", APP, "--relay-base", base])).result.refused, /routes by deployment/);
    assert.deepEqual(carrierFor({ relayBase: "https://api.enclave.host", deployment: D1 }), { ok: true, url: `https://api.enclave.host/x/${D1}/pvm` });
    // the extension may fetch exactly the platform relays and the lab loopback: one list, held equal here
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, "shielded/anchor/avf/client/ext/manifest.json"), "utf8"));
    assert.deepEqual(man.host_permissions, ["http://127.0.0.1/*", ...PLATFORM_RELAYS.map((o) => `${o}/*`)]);
    assert.equal(man.version, "0.5.0");
    // 0.4.1, from its own commit: a type-2 policy is not a policy it knows -- it cannot run a bound deployment unbound
    const old = path.join(work, "pvm-client-0.4.1.mjs");
    fs.writeFileSync(old, execFileSync("git", ["show", "c1341ee3:shielded/anchor/avf/client/dist/pvm-client.mjs"], { cwd: ROOT, maxBuffer: 1 << 24 }));
    const ost = path.join(work, "old-state");
    assert.equal((await cli(old, ["install", "--state", ost, "--policy-key-fp", P.fp, "--serial-floor", "1", "--release-key-fp", R.fp])).code, 0);
    const o = await cli(old, ["run", "--state", ost, "--policy", pf, "--relay", `${base}/x/${D1}/pvm`, "--deployment", D1]);
    assert.equal(o.result.clientVersion, "0.4.1"); assert.equal(o.result.step, "policy"); assert.match(o.result.refused, /not a pVM client policy/);
  } finally { srv.close(); for (const v of Object.values(vm)) v.close(); }
});
