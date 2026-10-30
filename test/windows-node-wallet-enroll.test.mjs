// network-enroll.mjs carries the node's wallet hold channel into the privacy agent's config (enclaveNetwork.walletAdmission)
// only while the node runs one, and drops it - restarting the agent once each way - when it stops; the agent then reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNetworkEnroll } from "../windows/node/network-enroll.mjs";
import { rawDigest } from "../network/shield-expectation.mjs";

const RID = "ab".repeat(32), APP = "0x" + "5a".repeat(32), RUNNER = "0x" + "22".repeat(32), D = "0x" + "11".repeat(32);
const CID = "bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza";

function world(walletAdmission) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-enroll-")), agentDir = path.join(dir, "agent"), policyFile = path.join(dir, "policy.json");
  fs.mkdirSync(agentDir); fs.writeFileSync(policyFile, JSON.stringify({ cpu: { runtimeId: RID }, gpu: {} }));
  const rows = [{ id: D, appRef: `catalog://${APP}/4`, configCid: "{}", runner: RUNNER, active: true, isPublic: true, leaseUntil: 9999999999n }];
  const vm = { name: D, status: "running", appReady: true, catalog: { app: APP, version: 4 }, cid: CID, appId: "ef".repeat(32), runtimeId: RID,
               componentSha256: rawDigest(CID), derivation: "enclave-catalog-bundle/1", gpuMilli: 0, startedAt: 1 };
  let restarts = 0;
  const make = (wa) => createNetworkEnroll({ agentDir, binDir: path.join(dir, "bin"), runner: RUNNER, relayBase: "https://api.enclave.host",
    fetch: async () => ({ ok: true, json: async () => ({ domains: {} }) }), log: () => {}, restartAgent: async () => { restarts++; },
    config: { agentDir, binDir: path.join(dir, "bin"), nodeBinary: "node.exe", operatorKeyFile: "op.key", runner: RUNNER, endpoint: "https://api.enclave.host/t/box",
      relayBase: "https://api.enclave.host", policyFile, tpmBinary: "tpmattest.exe", tpmSha256: "aa".repeat(32), addressBook: "0x" + "44".repeat(20), chainRpc: ["https://rpc"],
      enclaveNetwork: { checkers: ["0x" + "57".repeat(20)] }, walletAdmission: wa },
    rows: async () => rows, version: async () => ({ cid: CID }), vms: async () => [vm] });
  const read = () => JSON.parse(fs.readFileSync(path.join(agentDir, "privacy-config.json"), "utf8"));
  return { dir, agentDir, make, read, restarts: () => restarts };
}

test("the channel is enrolled only while the node runs one: added and dropped with one agent restart each, steady otherwise", async () => {
  const w = world(null);
  await w.make(null).pass();
  assert.equal(w.read().enclaveNetwork.walletAdmission, undefined, "no channel: the agent admits on lease and proof as before");
  const file = path.join(w.agentDir, "wallet-admission.json");
  const on = w.make({ file });
  await on.pass();
  assert.deepEqual(w.read().enclaveNetwork.walletAdmission, { file }); assert.equal(w.restarts(), 1, "the agent restarts once to enforce it");
  assert.equal((await on.pass()).changed, false); assert.equal(w.restarts(), 1, "steady: no further restart");
  await w.make(null).pass();
  assert.equal(w.read().enclaveNetwork.walletAdmission, undefined, "a node without a channel (rolled back, or OFF) drops it");
  assert.equal(w.restarts(), 2);
  await w.make({ file: "relative.json" }).pass();
  assert.equal(w.read().enclaveNetwork.walletAdmission, undefined, "a relative path is never enrolled");
  fs.rmSync(w.dir, { recursive: true, force: true });
});
