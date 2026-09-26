// From d1's live NucBox node at 013deb51 (coordinator enclave-87): /availability advertised secrets, secretsInConfig, configOverride and customDomains as true while the isolated
//      backend's plan refuses each. On that backend every feature is the node's plan AND the manager's /health word.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";
import { REC, DEP, PLANNED } from "./helpers/hv-fake-manager.mjs";

process.env.NODE_OPERATOR_KEY = "0x" + "6d".repeat(32);   // a throwaway operator, so ensurePriced gets past its key check
const rpc = await fakeBaseRpc();
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
chain.loadOperator();
const { Host } = await import("../windows/node/host.mjs");
const { PARTITION_OFFERS } = await import("../windows/vbslike/datapath/partition-offers.mjs");
const { isolationPlan, isolatedTarget } = await import("../windows/vbslike/datapath/node-bridge.mjs");
after(() => rpc.close());

const ENDPOINT = "https://api.enclave.host/t/test";
const card = { vramBudgetGb: 8, vramFreeGb: 6 };
const box = (cfg = {}) => {
  const h = new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-price-")), endpoint: ENDPOINT, name: "test", appsEnabled: true,
    cpuPricePerSec6: 12, gpuPricePerSec6: 28, log: () => {}, ...cfg });
  h.chainReady = true;
  return h;
};

// ---- (b) what the isolated backend advertises ------------------------------------------------------------------------
const FLAGS = ["secrets", "secretsInConfig", "configOverride", "customDomains", "waf", "networkOptions", "gpuOptional",
               "configCid", "configCidOverride", "configEdit", "devDeploy"];
test("the isolated backend advertises none of what a partition cannot be given - even with a manager that claims all of it", () => {
  const h = box({ engineRetired: true, isolationManager: "http://127.0.0.1:1", sessionKid: "k1" });
  h.cfg.secretsSign = async () => "0x";                 // what used to make secrets/customDomains true
  for (const supports of [null, { gpu: true, secrets: true, egress: true, config: true, ports: true, configCid: true, waf: true, customDomains: true, privateDeployments: true }]) {
    h.managerSupports = supports;
    const f = h.features(), a = h.availability();
    for (const k of FLAGS) {
      assert.equal(f[k], false, `features().${k} with supports=${JSON.stringify(supports)}`);
      assert.equal(a[k], false, `availability.${k}`);
    }
  }
});

test("the legacy engine's flags are unchanged", () => {
  const h = box({ sessionKid: "k1" });
  h.cfg.secretsSign = async () => "0x";
  const f = h.features();
  for (const k of ["secrets", "secretsInConfig", "configOverride", "customDomains", "waf", "configCid", "configCidOverride", "configEdit", "devDeploy"])
    assert.equal(f[k], true, k);
});

test("every false in PARTITION_OFFERS is a refusal in isolationPlan (or a constant of the spawn and the splice route)", () => {
  const manager = { backend: "hyperv-partition-per-app", catalog: { derivations: ["enclave-catalog-bundle/1"] } };
  const base = { deploymentId: DEP, deployment: { isPublic: true, gpuMilli: 0, cpuMilli: 100, appPort: 8080 },
                 version: { ...PLANNED, ports: "", configCid: "" }, appConfig: "", hasSecrets: false, waf: {}, volumes: [],
                 runtimeId: REC.runtimeId, require: "hyperv-partition-per-app", manager, appConfigCid: "" };
  const ok = isolationPlan(base);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const refused = {
    secrets: { hasSecrets: true },
    config: { appConfig: JSON.stringify({ greeting: "hi" }) },
    configCid: { appConfigCid: "bafyoverride" },
    waf: { waf: { rate: { perMin: 10 } } },
    gpu: { deployment: { ...base.deployment, gpuMilli: 100 } },
    privateDeployments: { deployment: { ...base.deployment, isPublic: false } },
    volumes: { volumes: ["gemma"] },
  };
  for (const [k, over] of Object.entries(refused)) {
    assert.equal(PARTITION_OFFERS[k], false, k);
    const r = isolationPlan({ ...base, ...over });
    assert.equal(r.ok, false, `${k} was planned: ${JSON.stringify(r).slice(0, 120)}`);
  }
  assert.equal(PARTITION_OFFERS.egress, false); assert.equal(ok.spawn.egress, "");
  assert.equal(PARTITION_OFFERS.customDomains, false);
  const t = isolatedTarget(DEP, { status: "running", isolation: { instance: "hv1", appId: "1".repeat(64) } }, "app.enclave.host");
  assert.equal(t.isolation.expectName, `${DEP.slice(2, 10)}.app.enclave.host`, "only the platform's own name is spliced");
  assert.deepEqual(Object.entries(PARTITION_OFFERS).filter(([, v]) => v !== false), [], "a partition offer turned true without its test");
});

test("the claim gate follows the flags: the isolated backend refuses a PRIVATE deployment at claim, by name, not after claiming it", async () => {
  const { enclaveIdOf } = await import("./helpers/fake-base-rpc.mjs");
  const operator = chain.operatorAddress().toLowerCase();
  const id = "0x" + "f3".repeat(32);
  rpc.row.current = { id, owner: operator, appRef: "catalog://0x" + "00".repeat(32) + "/0", ports: "", configCid: "",
    gpuMilli: 0, cpuMilli: 100, appPort: 8080, isPublic: false, active: true, createdAt: 1n, rate: 1n, balance6: 0n, spent6: 0n,
    runner: "0x" + "00".repeat(32), runnerOperator: "0x" + "00".repeat(20), leaseUntil: 0n };
  const hv = box({ engineRetired: true, isolationManager: "http://127.0.0.1:1", sessionKid: "k1" });
  hv.registered = { endpoint: ENDPOINT, cpuPricePerSec6: 12n, gpuPricePerSec6: 0n };
  const r = await hv.consider(id);
  assert.equal(r.accepted, false);
  assert.match(r.reason, /private deployment/);
  // the legacy engine with a session key still takes a private deployment past that check
  const legacy = box({ sessionKid: "k1" });
  legacy.registered = { endpoint: ENDPOINT, cpuPricePerSec6: 12n, gpuPricePerSec6: 0n };
  const l = await legacy.consider(id);
  assert.doesNotMatch(String(l.reason || ""), /private deployment/);
  assert.ok(enclaveIdOf);
});
