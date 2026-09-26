// What a node with the engine retired says about ITSELF on /availability (enclave-b4's N5): the isolated backend by name
// (availability.isolation, which `enclave deploy --isolation` and the NucBox acceptance read, as metal-iso0 advertises
// its own), its boundary as this backend's - T0-hv, host NOT excluded - never a stronger one, the partitions it runs,
// TLS in the partition rather than "host-process", and the relay's attach verdict as given. It used to say isolation
// "none", capacity 0 and "sells no app hosting" while partitions served.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";

const rpc = await fakeBaseRpc();
(await import("../windows/node/chain.mjs")).addresses.deployments = DEPLOYMENTS;
const { Host } = await import("../windows/node/host.mjs");
after(() => rpc.close());

const box = (cfg = {}) => new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-labels-")), endpoint: "https://api.enclave.host/t/test",
  name: "test", appsEnabled: true, cpuPricePerSec6: 12, log: () => {}, engineRetired: true, ...cfg });
const hv = () => box({ isolationManager: "http://127.0.0.1:1" });

test("the hv node advertises its backend by name, with this backend's boundary: T0-hv, host not excluded", () => {
  const a = hv().availability();
  assert.equal(a.isolation, "hyperv-partition-per-app");
  assert.deepEqual(a.isolationBoundary, { tier: "T0-hv", hostExcluded: false });
  assert.equal(a.apps.isolation, "hyperv-partition-per-app");
  assert.equal(a.apps.tier, "T0-hv");
  assert.equal(a.apps.hostExcluded, false);
  assert.equal(a.apps.inTee, false);
  assert.doesNotMatch(JSON.stringify(a), /sells no app hosting|"isolation":"none"/);
});

test("running counts the partitions serving, not the in-process apps (there are none)", () => {
  const h = hv();
  h.records.set("0x" + "a1".repeat(32), { status: "running", isolation: { instance: "hv1", appId: "0x" + "1".repeat(64) } });
  h.records.set("0x" + "a2".repeat(32), { status: "provisioning", isolation: null, isolationHeld: "hv2" });
  h.records.set("0x" + "a3".repeat(32), { status: "held", reason: "not served" });
  const a = h.availability();
  assert.equal(a.apps.running, 1);
  assert.equal(a.appTls.served, true);
});

test("app TLS for a partition is the partition's: never 'host-process' on the isolated backend", () => {
  const t = hv().availability().appTls;
  assert.equal(t.keyIn, "partition");
  assert.equal(t.terminatesIn, "partition");
  assert.doesNotMatch(JSON.stringify(t), /host-process/);
});

test("the relay's attach verdict is kept as given; the node never raises it", () => {
  const h = hv();
  assert.deepEqual(h.availability().attach, { tier: null, hostExcluded: null }, "not attached: nothing claimed");
  h.relayTier = "hv-node"; h.relayHostExcluded = false;
  assert.deepEqual(h.availability().attach, { tier: "hv-node", hostExcluded: false });
});

test("no manager: no backend advertised, and the old 'none' description stands", () => {
  const a = box().availability();
  assert.equal(a.isolation, null);
  assert.equal("isolationBoundary" in a, false);
  assert.equal(a.apps.isolation, "none");
  assert.equal(a.appTls.keyIn, "host-process");
});

test("the agent keeps the relay's hostExcluded from attest-result (source: it is stored, typed, never defaulted to true)", () => {
  const src = fs.readFileSync(new URL("../windows/node/agent.mjs", import.meta.url), "utf8");
  assert.match(src, /host\.relayHostExcluded = typeof f\.hostExcluded === 'boolean' \? f\.hostExcluded : null;/);
});
