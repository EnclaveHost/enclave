// G4 composition: network-enroll keeps the operator's enclaveNetwork.challengeReplica byte-for-byte (like hostServices),
// before walletAdmission (which stays LAST for the wallet-hold helper's no-op rule); steady passes change nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNetworkEnroll } from "../windows/node/network-enroll.mjs";
import { rawDigest } from "../network/shield-expectation.mjs";

const RID = "ab".repeat(32), APP = "0x" + "5a".repeat(32), RUNNER = "0x" + "22".repeat(32), D = "0x" + "11".repeat(32);
const CID = "bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza";
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "challenge-enroll-")), agentDir = path.join(dir, "agent"), policyFile = path.join(dir, "policy.json");
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
  const p = path.join(agentDir, "privacy-config.json");
  return { dir, agentDir, make, p, read: () => JSON.parse(fs.readFileSync(p, "utf8")), restarts: () => restarts };
}
const CR = { role: "app-zone-replica", front: { listen: "127.0.0.1:18292", managed: { zone: "app.enclave.host", declarationFile: "C:\\ProgramData\\Enclave\\network\\challenge\\challenge-front.json" } }, note: "ünïcode kept" };

test("challengeReplica: kept byte-for-byte across passes, no rewrite and no agent restart; absent stays absent", async () => {
  const w = world();
  await w.make(null).pass();
  assert.equal(w.read().enclaveNetwork.challengeReplica, undefined, "absent: nothing added");
  // the operator adds it at the canonical place (end of enclaveNetwork, i.e. after hostServices, before walletAdmission)
  const c = w.read(); c.enclaveNetwork.challengeReplica = CR; fs.writeFileSync(w.p, JSON.stringify(c, null, 2) + "\n");
  const before = fs.readFileSync(w.p, "utf8"), r = await w.make(null).pass();
  assert.equal(r.changed, false); assert.equal(w.restarts(), 0, "no restart"); assert.equal(fs.readFileSync(w.p, "utf8"), before, "byte-identical");
  // with the wallet hold channel on: walletAdmission is (re)placed LAST, challengeReplica kept just before it
  const file = path.join(w.agentDir, "wallet-admission.json");
  await w.make({ file }).pass();
  const keys = Object.keys(w.read().enclaveNetwork);
  assert.deepEqual(w.read().enclaveNetwork.challengeReplica, CR); assert.equal(keys.at(-1), "walletAdmission"); assert.equal(keys.at(-2), "challengeReplica");
  assert.equal(w.restarts(), 1, "the wallet channel's one restart only");
  assert.equal((await w.make({ file }).pass()).changed, false); assert.equal(w.restarts(), 1, "steady");
  // removed by the operator: stays removed
  const d = w.read(); delete d.enclaveNetwork.challengeReplica; fs.writeFileSync(w.p, JSON.stringify(d, null, 2) + "\n");
  await w.make({ file }).pass(); assert.equal(w.read().enclaveNetwork.challengeReplica, undefined);
  // a non-object is not carried
  const e = w.read(); e.enclaveNetwork.challengeReplica = ["x"]; fs.writeFileSync(w.p, JSON.stringify(e, null, 2) + "\n");
  await w.make({ file }).pass(); assert.equal(w.read().enclaveNetwork.challengeReplica, undefined);
  fs.rmSync(w.dir, { recursive: true, force: true });
});
