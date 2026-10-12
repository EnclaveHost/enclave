// network/shield-expectation.mjs: the expectation a Shield host's privacy agent pins (shared by the SSH reconcile and the
// host's own enrollment).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shieldExpectation, rawDigest } from "../network/shield-expectation.mjs";
const RID = "ab".repeat(32), APP = "0x" + "5a".repeat(32), ID = "0x" + "11".repeat(32), CID = "bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza";
const policy = { cpu: { runtimeId: RID, configBundleV5: true, secretsV1: true, configSocketServer: true, protectedPorts: true }, gpu: { runtimeId: "cd".repeat(32) } };
const row = { id: ID, appRef: `catalog://${APP}/4`, configCid: "{}" };
const vm = (o = {}) => ({ name: ID, status: "running", appReady: true, catalog: { app: APP, version: 4 }, cid: CID, appId: "ef".repeat(32), runtimeId: RID,
  componentSha256: rawDigest(CID), derivation: "enclave-catalog-bundle/1", gpuMilli: 0, startedAt: 2, ...o });
const run = (vms, o = {}) => shieldExpectation({ row, version: { cid: CID }, vms, policy, ...o });

test("a ready partition of the lease's current version pins appRef, configCid, its app digest and the policy's runtime", () => {
  assert.deepEqual(run([vm()]).expected, { appRef: row.appRef, configCid: "{}", appSha256: "ef".repeat(32), runtimeId: RID, requiresConfigBundleV5: false, requiresSecretsV1: false });
  const v7 = run([vm({ derivation: "enclave-catalog-bundle/7", secretDeployment: ID })]).expected;
  assert.equal(v7.requiresConfigSocketServer, true); assert.equal(v7.requiresSecretsV1, true);
  assert.equal(run([vm({ derivation: "enclave-catalog-bundle/5" })], { previous: { requiresConfigSocketServer: true } }).expected.requiresConfigSocketServer, true);
  assert.equal(run([vm({ appId: "01".repeat(32), startedAt: 1 }), vm()]).expected.appSha256, "ef".repeat(32), "the newest partition");
});
test("waits for a ready current partition; skips anything outside the admitted policy", () => {
  for (const o of [{ status: "starting" }, { appReady: false }, { launching: true }, { catalog: { app: APP, version: 3 } }, { cid: "bafkreiother" }, { name: "0x" + "22".repeat(32) }])
    assert.ok(run([vm(o)]).wait, JSON.stringify(o));
  for (const o of [{ runtimeId: "00".repeat(32) }, { componentSha256: "00".repeat(32) }, { appId: "nothex" }, { gpuMilli: 500 },
                   { derivation: "enclave-catalog-bundle/6", secretDeployment: "0x" + "22".repeat(32) }])
    assert.ok(run([vm(o)]).skip, JSON.stringify(o));
  assert.ok(shieldExpectation({ row: { ...row, appRef: "ipfs://x" }, version: { cid: CID }, vms: [vm()], policy }).skip);
});
