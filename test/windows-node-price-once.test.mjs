// d1's live NucBox node at 013deb51 sent "card price now 0/sec (was 28)" at 00:55:04 (0xe4368ba9) AND again at 00:55:33
// (0x79ebd389) after a restart: the registry read lagged the first transaction, and every start sent it again, while
// /availability still asked 28. Now (coordinator enclave-87): with the engine retired (gpu:false) the desired card price
// is 0 and /availability asks it; NO transaction when the chain already equals it; ONE when it does not, remembered in
// host-state.json so a restart inside the lag does not repeat it. Two Hosts on one state directory are two starts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";

process.env.NODE_OPERATOR_KEY = "0x" + "6e".repeat(32);   // a throwaway operator: ensurePriced needs one to act at all
const rpc = await fakeBaseRpc();
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
chain.loadOperator();
const { Host } = await import("../windows/node/host.mjs");
after(() => rpc.close());

const ENDPOINT = "https://api.enclave.host/t/test";
const card = { vramBudgetGb: 8, vramFreeGb: 6 };
// one START: a fresh Host on `dir`, whose registry read says `listed` (a lagging read keeps saying the old value)
const start = (dir, listed, cfg = {}) => {
  const h = new Host({ dir, endpoint: ENDPOINT, name: "test", appsEnabled: true, cpuPricePerSec6: 12, gpuPricePerSec6: 28, log: () => {}, ...cfg });
  h.chainReady = true;
  h.registered = { endpoint: ENDPOINT, cpuPricePerSec6: 12n, gpuPricePerSec6: BigInt(listed) };
  h.refreshRegistration = async () => {};              // the read does not catch up inside this test: the worst case
  return h;
};
const counter = () => { const calls = []; return { calls, setPrices: async (...a) => { calls.push(a); return "0x" + "cd".repeat(32); } }; };
const RETIRED = { engineRetired: true, isolationManager: "http://127.0.0.1:1", card: () => card };

test("engine retired, the chain already at the desired 0: two starts in a row send NO transaction; the ask is 0", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-price1-")), c = counter();
  for (let i = 0; i < 2; i++) {
    const h = start(dir, 0, RETIRED);
    await h.ensurePriced({ setPrices: c.setPrices });
    await h.ensurePriced({ setPrices: c.setPrices });
    const a = h.availability();
    assert.equal(a.askGpuPricePerSec6, 0);
    assert.equal("askShieldedPricePerSec6" in a, false);
  }
  assert.equal(c.calls.length, 0);
});

test("engine retired, the chain says 28: the first start sends EXACTLY ONE (to 0); a restart inside the lag sends none", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-price2-")), c = counter();
  const t0 = Date.now();
  const first = start(dir, 28, RETIRED);
  await first.ensurePriced({ setPrices: c.setPrices, now: t0 });
  await first.ensurePriced({ setPrices: c.setPrices, now: t0 + 30_000 });          // its next tick, the read still 28
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0][2], 0, "the desired card price with the engine retired is 0");
  assert.equal(first.availability().askGpuPricePerSec6, 0, "the ask agrees with it, whatever the registry still lists");
  const second = start(dir, 28, RETIRED);                                         // A8's kill: a new process, same state dir
  await second.ensurePriced({ setPrices: c.setPrices, now: t0 + 29_000 });
  assert.equal(c.calls.length, 1, "the restart sent the same price transaction again");
  // ...and after the settle window a registry that STILL disagrees is corrected once more
  const later = start(dir, 28, RETIRED);
  await later.ensurePriced({ setPrices: c.setPrices, now: t0 + Host.PRICE_SETTLE_MS + 1 });
  assert.equal(c.calls.length, 2);
  // once the chain shows it, the record is dropped
  const settled = start(dir, 0, RETIRED);
  await settled.ensurePriced({ setPrices: c.setPrices, now: t0 + Host.PRICE_SETTLE_MS + 2 });
  assert.equal(settled.priceSent, null);
  assert.equal(c.calls.length, 2);
});

test("legacy engine: the chain already right sends nothing over two starts; a real change sends one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-price3-")), c = counter();
  for (let i = 0; i < 2; i++) await start(dir, 28, { card: () => card }).ensurePriced({ setPrices: c.setPrices });
  assert.equal(c.calls.length, 0);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ee-price4-"));
  await start(dir2, 0, { card: () => card }).ensurePriced({ setPrices: c.setPrices });
  await start(dir2, 0, { card: () => card }).ensurePriced({ setPrices: c.setPrices });
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0][2], 28);
});
