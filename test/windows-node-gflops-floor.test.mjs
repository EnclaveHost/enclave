// Catalog cpuGflops FLOORS are in the units they were written in: the fleet's 62.5-GFLOPS-a-vCPU convention (risc-box
// 0.6.62's 250 is exactly 4 vCPUs, 25% of a 16-vCPU node's nominal 1000). The node now PUBLISHES its measured GFLOPS
// (compute-measure.mjs: 446.7 on nucbox-k11), and comparing old floors against that figure was a unit mismatch. On
// 2026-10-08 18:44Z it made RISC Box 0xe64f7cba unplaceable ("needs 250 GFLOPS and 25% of this box is 112"; enclave-68).
// Floors are checked against the nominal figure (agent gflopsFloorBasis -> host capacity().cpuGflops).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimPolicy } from "../windows/node/chain.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "0x29479Bf04ED889D46a7AfB7f292B9Bb26e12647C";
const ENCLAVE = "0xd497d065ca395192db3630699dbc5a6418f2f028256212a4d9ab73288643fe1b";
const riscBox = { id: "0xe64f7cba307e2d97485bde356d75564ccb74c5e31c272b5ab3349abfe122569b", owner: OWNER, appRef: "catalog://0xapp/0",
  configCid: "", gpuMilli: 0, cpuMilli: 250, isPublic: true, active: true, createdAt: 1790000000n, runner: "0x" + "0".repeat(64), leaseUntil: 0n };
const v0662 = { cid: "bafy", version: "0.6.62", memMb: 6144, cpuGflops: 250, config: "", approval: 1, yanked: false };
const box = (cpuGflops) => ({ slots: 8, slotsFree: 6, cpuShareFree: 0.69, ramMbFree: 64000, cpuGflops, gpuShareFree: 0, cardGb: 0 });
const ctx = (cpuGflops) => ({ ownerAllow: OWNER, enclaveId: ENCLAVE, appsEnabled: true, capacity: box(cpuGflops), version: v0662 });

test("a convention-unit floor fits the nominal figure (the units it was written in)", () => {
  assert.equal(claimPolicy(riscBox, ctx(1000)), null, "250 GFLOPS at 25% of a 16-vCPU node: exactly what the publisher sized");
});

test("against the MEASURED figure the same floor was refused: the mismatch this fixes", () => {
  assert.match(claimPolicy(riscBox, ctx(446.7)), /needs 250 GFLOPS and 25% of this box is 112/);
});

test("the node passes the nominal floor basis and capacity() checks floors against it (pinned in source)", () => {
  const agent = fs.readFileSync(path.join(ROOT, "windows/node/agent.mjs"), "utf8");
  const host = fs.readFileSync(path.join(ROOT, "windows/node/host.mjs"), "utf8");
  assert.match(agent, /gflopsFloorBasis: Math\.round\(62\.5 \* NODE_VCPUS_N\),/);
  assert.match(agent, /gflops: COMPUTE\.gflops,/, "while the node still publishes what it measured");
  assert.match(host, /cpuGflops: Number\(this\.cfg\.gflopsFloorBasis \?\? this\.cfg\.gflops\) \|\| 0,/);
});

test("the site sizes against the nominal figure too, and still shows the measured one", async () => {
  const { enclaveSpecOf, minPctsOf } = await import("../site/js/core/pricing.js");
  const nucbox = { availability: { nodeVcpus: 16, nodeRamGb: 64, nodeGflops: 446.7 } };
  const s = enclaveSpecOf(nucbox);
  assert.equal(s.nodeGflops, 446.7, "the measured figure is what the box is");
  assert.equal(s.nodeGflopsFloor, 1000, "the nominal one is what floors divide by");
  assert.equal(minPctsOf({ memMb: 512, cpuGflops: 250 }, s).cpuPct, 25, "risc-box 0.6.62 asks 25%, as it was sized");
});
