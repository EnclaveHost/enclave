// node --test tools/test_gate_proof.mjs - gate/gate-proof.mjs fed on stdin (--input-type=module) exactly as the coordinator and
// the root wrapper feed it. Fake bundle scenarios (no network) + the REAL installed bundle 6bef372d on its offline paths only:
// unset (the live node's state today: OFF = NOT_ADMISSIBLE, the old negative control), off, a refused value. No check() of the
// real bundle runs here (it would make public chain reads).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const A = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JS = fs.readFileSync(path.join(A, "gate/gate-proof.mjs"));
const REAL = path.resolve(A, "../../root-control-rpc-final-20261022/control-package/files/windows/node/host-admission.bundle.mjs");
const RUNNER = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a", EP = "https://api.enclave.host/t/nucbox-k11-4";
const R5 = "https://base-rpc.publicnode.com,https://base.gateway.tenderly.co,https://base-public.nodies.app,https://base.drpc.org,https://mainnet.base.org";
function world(mode) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gate-proof-"));
  fs.copyFileSync(path.join(A, "tools/fake-bundle.mjs"), path.join(d, "bundle.mjs"));
  fs.writeFileSync(path.join(d, "fake-gate.json"), JSON.stringify({ mode }));
  return d;
}
function run(bundle, { policy = "production", rpcs = "", host = RUNNER, endpoint = EP, timeout = 60000 } = {}) {
  const env = { PATH: process.env.PATH, GATE_BUNDLE: bundle, GATE_HOST: host, GATE_ENDPOINT: endpoint, GATE_POLICY: policy, GATE_RPCS: rpcs, GATE_OPTION: rpcs ? "R" : "P" };
  const r = spawnSync(process.execPath, ["--input-type=module"], { input: JS, env, timeout, encoding: "utf8" });
  const line = r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  return { code: r.status, out: line ? JSON.parse(line) : null, stderr: r.stderr };
}
test("the text is ASCII and its sha is the one compose pinned into the coordinator", () => {
  assert.ok(![...JS].some((c) => c > 127));
  const c = JSON.parse(fs.readFileSync(path.join(A, "helper/compose.json"), "utf8"));
  assert.equal(crypto.createHash("sha256").update(JS).digest("hex"), c.gateProof);
  assert.match(fs.readFileSync(path.join(A, "helper/node-policy-activation.ps1"), "utf8"), new RegExp(`\\$GATE_JS_SHA = '${c.gateProof}'`));
});
test("not activated (unanchored book): ADMISSIBLE, exit 0, registry row active with this endpoint; env passed is exactly the policy (P)", () => {
  const d = world("not-activated"), r = run(path.join(d, "bundle.mjs"));
  assert.equal(r.code, 0, r.stderr); assert.equal(r.out.verdict, "ADMISSIBLE"); assert.equal(r.out.gate.status, "not-activated");
  assert.equal(r.out.registry.active, true); assert.equal(r.out.registry.endpointMatches, true); assert.equal(r.out.idMatchesEndpoint, true);
  assert.equal(r.out.relayPolicy, "gate"); assert.equal(r.out.config.minAgree, 3); assert.equal(r.out.config.rpcHosts.length, 4);
  const calls = fs.readFileSync(path.join(d, "fake-gate-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(calls[0].env, { ENCLAVE_PLATFORM_HOST_POLICY: "production" }); assert.equal(calls[0].stateDir, null); assert.equal(calls[0].book, null); assert.equal(calls[0].chainId, 8453);
});
test("option R: the 5 RPCs reach the gate and the majority is 3", () => {
  const d = world("not-activated"), r = run(path.join(d, "bundle.mjs"), { rpcs: R5 });
  assert.equal(r.out.verdict, "ADMISSIBLE"); assert.equal(r.out.config.minAgree, 3); assert.equal(r.out.config.rpcHosts.length, 5);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, "fake-gate-calls.jsonl"), "utf8").trim()).env, { ENCLAVE_PLATFORM_HOST_POLICY: "production", ENCLAVE_PLATFORM_HOST_POLICY_RPCS: R5 });
});
test("an anchored policy that admits: ADMISSIBLE", () => { const r = run(path.join(world("admit"), "bundle.mjs")); assert.equal(r.out.verdict, "ADMISSIBLE"); assert.equal(r.out.gate.anchor, "anchored"); });
test("a ban: NOT_ADMISSIBLE (never UNKNOWN), exit 1", () => { const r = run(path.join(world("ban"), "bundle.mjs")); assert.equal(r.code, 1); assert.equal(r.out.verdict, "NOT_ADMISSIBLE"); assert.equal(r.out.gate.banned, true); });
test("an inactive registry row: NOT_ADMISSIBLE", () => { const r = run(path.join(world("inactive"), "bundle.mjs")); assert.equal(r.out.verdict, "NOT_ADMISSIBLE"); });
test("the registry endpoint differs: NOT_ADMISSIBLE", () => { const r = run(path.join(world("endpoint"), "bundle.mjs")); assert.equal(r.out.verdict, "NOT_ADMISSIBLE"); assert.equal(r.out.why, "registry endpoint differs"); });
test("policy unreadable (RPC quorum lost): UNKNOWN, exit 3 - never admitted", () => { const r = run(path.join(world("unreadable"), "bundle.mjs")); assert.equal(r.code, 3); assert.equal(r.out.verdict, "UNKNOWN"); });
test("registry read throws: UNKNOWN", () => { const r = run(path.join(world("decide-throws"), "bundle.mjs")); assert.equal(r.code, 3); assert.equal(r.out.verdict, "UNKNOWN"); });
test("a host id that is not keccak256(endpoint): REFUSED", () => { const r = run(path.join(world("not-activated"), "bundle.mjs"), { endpoint: "https://api.enclave.host/t/other" }); assert.equal(r.code, 1); assert.equal(r.out.verdict, "REFUSED"); });
test("a check that never returns: UNKNOWN after its own 45 s bound", () => { const t = Date.now(), r = run(path.join(world("hang"), "bundle.mjs"));
  assert.equal(r.code, 3); assert.equal(r.out.verdict, "UNKNOWN"); assert.ok(Date.now() - t >= 44000 && Date.now() - t < 55000); });
test("REAL bundle 6bef372d, policy unset (today's live env, OLD NEGATIVE CONTROL): gate OFF -> NOT_ADMISSIBLE", () => {
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(REAL)).digest("hex"), "6bef372d00a27567e94a11d00f165312f9d715a795519e7a7ad77b4718623b18");
  const r = run(REAL, { policy: "" }); assert.equal(r.code, 1); assert.equal(r.out.verdict, "NOT_ADMISSIBLE"); assert.equal(r.out.enabled, false);
  assert.match(r.out.reason, /not the production chain\/book \(chain 8453, book unset\)/); assert.equal(r.out.idMatchesEndpoint, true);
});
test("REAL bundle, policy off: NOT_ADMISSIBLE; a malformed value: REFUSED", () => {
  const off = run(REAL, { policy: "off" }); assert.equal(off.out.verdict, "NOT_ADMISSIBLE"); assert.match(off.out.reason, /explicitly disabled/);
  const bad = run(REAL, { policy: "productio" }); assert.equal(bad.out.verdict, "REFUSED");
});
