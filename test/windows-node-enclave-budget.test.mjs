// The enclave's RAM is a fixed, dedicated allocation, and what is left of it is the number a
// deployment is admitted against. This tests the arithmetic that decides both, because it is the
// arithmetic a tenant's app is refused by - and because it replaced a figure that was not memory
// at all (the CPU share ledger), which reported 14 GB of a 64 GB enclave "used" while four apps
// held half a gigabyte between them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Host } from "../windows/node/host.mjs";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-budget-"));
/** A Host with no chain and no enclave, built only far enough to ask it about capacity. */
function box(cfg = {}) {
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test",
                       appsEnabled: true, cpuPricePerSec6: 12, log: () => {},
                       enclaveGb: 64, engineHeldMb: 1879, appSlots: 8, ramGb: 112,
                       enclaveAppAbi: 5, enclaveAppWorlds: 7, ...cfg });
  // appsInTee() reads the runtime's reported ABI, which the fixture above supplies.
  return h;
}
const record = (h, id, memMb, status = "running") => {
  h.records.set(id, { id, status, memMb, cpuShare: 0.01, gpuShare: 0 });
};

test("the pool is the enclave's own size, not the machine's and not a share of it", () => {
  const h = box();
  const cap = h.capacity();
  assert.equal(cap.ramMbPool, 64 * 1024, "the enclave is 64 GB, dedicated at creation");
  assert.equal(cap.ramMbEngine, 1879, "what the engine holds is MEASURED, asked of the enclave");
  assert.equal(cap.ramMbFree, 64 * 1024 - 1879, "and everything else is free while nothing runs");
  // The machine has 112 GB and none of it is the pool: an app here lives in enclave memory.
  assert.notEqual(cap.ramMbPool, 112 * 1024);
});

test("a running app is charged its PROMISED floor, not what it has touched", () => {
  const h = box();
  record(h, "0xaa", 3072);
  record(h, "0xbb", 128);
  const cap = h.capacity();
  assert.equal(cap.ramMbFree, 64 * 1024 - 1879 - 3072 - 128,
    "the box has to keep the promise whether or not the pages are touched yet");
});

test("sizing a deployment excludes its OWN floor, so a restart is not refused for its own memory", () => {
  const h = box();
  record(h, "0xaa", 60000);
  // Beside itself, this deployment would see only what is left after its own 60 GB...
  assert.equal(h.capacity().ramMbFree, 64 * 1024 - 1879 - 60000);
  // ...but sized against the room BESIDE the others, its own floor is back on the table. Without
  // this, every restart of a large app refuses it for asking for the memory it already had.
  assert.equal(h.capacity({ exclude: "0xaa" }).ramMbFree, 64 * 1024 - 1879);
  assert.equal(h.capacity({ exclude: "0xAA" }).ramMbFree, 64 * 1024 - 1879, "and the id is case-insensitive");
});

test("an app bigger than the enclave cannot be admitted, whatever the machine has", () => {
  const h = box();
  const cap = h.capacity();
  // 64 GB machine RAM would say yes; the enclave says no. The refusal is the point: a lease this
  // box cannot fit costs the tenant their funding and thrashes VTL1.
  assert.ok(70 * 1024 > cap.ramMbFree);
  assert.ok(cap.ramMbFree < 64 * 1024, "the engine's own hold is never sellable");
});

test("an owner's optional per-app ceiling narrows the budget but never widens it", () => {
  const capped = box({ enclaveAppRamMb: 8192 }).capacity();
  assert.equal(capped.ramMbFree, 8192, "the ceiling wins when it is lower");
  assert.equal(capped.ramMbPool, 64 * 1024, "the pool is still the enclave's real size");
  const silly = box({ enclaveAppRamMb: 999999 }).capacity();
  assert.equal(silly.ramMbFree, 64 * 1024 - 1879, "a ceiling above the enclave is not a promotion");
});

test("no measurement of the engine yet means the whole enclave reads as free, and that is stated", () => {
  // engineHeldMb is 0 until the node has asked the enclave (`mem`). It is a startup window, not a
  // steady state, and it errs toward offering MORE - so it is worth knowing that is what happens.
  const cap = box({ engineHeldMb: 0 }).capacity();
  assert.equal(cap.ramMbFree, 64 * 1024);
  assert.equal(cap.ramMbEngine, 0);
});
