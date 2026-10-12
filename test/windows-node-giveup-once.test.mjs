// ONE give-up per deployment at a time. The tick, the reconcile and the manager's report can all give up on the same
// domain in the same second; each read "the runner is still this box" and sent its own release, so one landed and the
// rest reverted on chain with gas spent (2026-10-12, nucbox-k11-4: seven give-ups and ten releases for one partition that
// died starting). Here: overlapping ticks over a lease this box must hand back (pinned to another host) send ONE release.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc, DEPLOYMENTS, enclaveIdOf } from "./helpers/fake-base-rpc.mjs";
import { DEP, ISOLATED, FakeHost, bootManager, closeManagers } from "./helpers/hv-fake-manager.mjs";
import { servedOwner } from "./helpers/owners.mjs";

process.env.NODE_OPERATOR_KEY = "0x" + "7f".repeat(32);   // a test key: the release is signed and counted, never mined
const rpc = await fakeBaseRpc();
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
chain.loadOperator();
const { Host } = await import("../windows/node/host.mjs");
after(() => { closeManagers(); rpc.close(); });

const ENDPOINT = "https://api.enclave.host/t/test";
const ME = enclaveIdOf(ENDPOINT);
const OWNER = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
const pinnedAway = JSON.stringify({ ...JSON.parse(ISOLATED), placement: { hostId: "0x" + "77".repeat(32) } });

test("overlapping ticks that each give up the same lease send ONE release", async () => {
  const { port } = await bootManager(new FakeHost(), 0);
  const logs = [];
  const h = servedOwner(new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-giveup-")), endpoint: ENDPOINT, name: "test",
    appsEnabled: true, cpuPricePerSec6: 12, log: (s) => logs.push(String(s)), engineRetired: true,
    isolationManager: `http://127.0.0.1:${port}` }), OWNER);
  h.chainReady = true; h.registered = { endpoint: ENDPOINT, cpuPricePerSec6: 12n };
  h.ensureRegistered = async () => {}; h.ensurePriced = async () => {}; h.scanLedger = async () => {};
  h.tracked.add(DEP);
  h.records.set(DEP, { id: DEP, owner: OWNER, status: "running", isolation: { instance: "hv1", appId: "1".repeat(64) } });
  rpc.row.current = { id: DEP, owner: OWNER, ports: "", configCid: pinnedAway,
    appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
    gpuMilli: 0, cpuMilli: 100, appPort: 8080, isPublic: true, active: true, createdAt: 1n, rate: 1n, balance6: 0n, spent6: 0n,
    runner: ME, runnerOperator: "0x" + "00".repeat(20), leaseUntil: BigInt(Math.floor(Date.now() / 1000) + 3600) };
  const before = rpc.chainTx.sent.length;
  rpc.chainTx.mine = true;
  try { await Promise.all([h.tick(), h.tick(), h.tick(), h.tick(), h.tick()]); } finally { rpc.chainTx.mine = false; }
  assert.equal(logs.filter((l) => /^giving up on 0x/.test(l)).length, 1, logs.join(" / "));
  assert.equal(rpc.chainTx.sent.length - before, 1, "release transactions sent: " + logs.join(" / "));
});
