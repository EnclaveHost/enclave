// The node's prices (host.mjs + price-guide.mjs): by default the cheapest per-(GB x GFLOPS) unit among the OTHER hosts of
// its tier times its own GB x GFLOPS (the network default when none); the owner's override wins; the registry follows.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc } from "./helpers/fake-base-rpc.mjs";

process.env.NODE_OPERATOR_KEY = "0x" + "7a".repeat(32);
const rpc = await fakeBaseRpc();
const chain = await import("../windows/node/chain.mjs");
chain.loadOperator();
const { Host } = await import("../windows/node/host.mjs");
const { DEFAULT_UNIT_PER_HOUR, perSec6Of } = await import("../windows/node/price-guide.mjs");
after(() => rpc.close());

const ME = "nucbox-k11-4";
const box = (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-pricing-")), logs = []) =>
  new Host({ dir, endpoint: `https://api.enclave.host/t/${ME}`, name: ME, appsEnabled: true, cpuPricePerSec6: 12, gpuPricePerSec6: 28,
             ramGb: 111, appRamGb: 55, gflops: 370, log: (m) => logs.push(m) });
const row = (name, mode, cpuPerSec6, gb, gflops, extra = {}) => ({ name, mode, availability: { askCpuPricePerSec6: cpuPerSec6, nodeRamGb: gb, nodeGflops: gflops, ...extra } });
const METAL0 = row("metal0", "snp", 834, 96, 540, { teeCpu: "amd-sev-snp" });
const SELF = row(ME, "hv-node", 1, 55, 370);                              // this box's own (cheap) row never prices it

test("the default: no other CPU host -> the network default unit x 55 GB x 370 GFLOPS; another CPU host's cheaper unit wins", () => {
  const h = box(), gb = h.pricedCapacity().cpu.gb;
  assert.equal(h.pricedCapacity().cpu.flops, 370);
  h.setPriceRows([METAL0, SELF]);
  const want = perSec6Of(DEFAULT_UNIT_PER_HOUR.cpu * gb * 370);
  assert.equal(h.cfg.cpuPricePerSec6, want, "a TEE host is another tier; this box's own row is left out");
  const v = h.pricingView().cpu;
  assert.equal(v.tier, "cpu"); assert.equal(v.default.from, null); assert.equal(v.override, null); assert.equal(v.gb, gb);
  // another Shield PC posts $0.02/hr for 32 GB x 300 GFLOPS: a unit well under the default
  h.setPriceRows([METAL0, SELF, row("other-pc", "hv-node", perSec6Of(0.02), 32, 300)]);
  assert.equal(h.pricingView().cpu.default.from, "other-pc");
  assert.equal(h.cfg.cpuPricePerSec6, perSec6Of(perSec6Of(0.02) * 3600 / 1e6 / (32 * 300) * gb * 370));
});

test("a default that drifts under 10% keeps the posted price (each change is a transaction); a bigger move follows", () => {
  const h = box();
  h.setPriceRows([row("other-pc", "hv-node", 1000, 32, 300)]);
  const first = h.cfg.cpuPricePerSec6;
  h.setPriceRows([row("other-pc", "hv-node", 1050, 32, 300)]);
  assert.equal(h.cfg.cpuPricePerSec6, first, "5% cheaper/dearer elsewhere changes nothing on chain");
  h.setPriceRows([row("other-pc", "hv-node", 700, 32, 300)]);
  assert.ok(h.cfg.cpuPricePerSec6 < first * 0.75, "a 30% move is followed");
});

test("the owner's override wins, survives a restart, and null goes back to the default; bad input changes nothing", () => {
  const logs = [], h = box(undefined, logs);
  h.setPriceRows([METAL0]);
  const def = h.cfg.cpuPricePerSec6;
  const v = h.setPriceOverride({ cpuPerHour: 0.25 });
  assert.equal(h.cfg.cpuPricePerSec6, perSec6Of(0.25)); assert.equal(v.cpu.override, 0.25); assert.equal(h.pricedBy.cpu, "owner");
  assert.ok(logs.some((l) => /price: cpu 0\.2500 USDC\/hr \(set by the owner/.test(l)));
  const again = box(h.cfg.dir); again.setPriceRows([METAL0]);
  assert.equal(again.cfg.cpuPricePerSec6, perSec6Of(0.25), "a restarted node keeps the owner's price");
  for (const bad of [{ cpuPerHour: 0 }, { cpuPerHour: -1 }, { cpuPerHour: "1" }, { cpuPerHour: 5000 }, { cpu: 1 }, null, []])
    assert.throws(() => h.setPriceOverride(bad), (e) => e.status === 400, JSON.stringify(bad));
  assert.equal(h.cfg.cpuPricePerSec6, perSec6Of(0.25));
  h.setPriceOverride({ cpuPerHour: null });
  assert.equal(h.cfg.cpuPricePerSec6, def, "back to the default at once, whatever the drift rule"); assert.equal(h.pricedBy.cpu, "default");
});

test("the registry follows: one setPrices with both prices when the CPU price changed, none when it already matches", async () => {
  const h = box(); h.chainReady = true; h.refreshRegistration = async () => {};
  h.registered = { cpuPricePerSec6: 12n, gpuPricePerSec6: 0n };
  const calls = []; const setPrices = async (...a) => { calls.push(a); return "0x" + "ab".repeat(32); };
  h.setPriceOverride({ cpuPerHour: 0.25 });
  await h.ensurePriced({ setPrices }); await h.ensurePriced({ setPrices });
  assert.equal(calls.length, 1, "once, not every tick while the read lags");
  assert.deepEqual(calls[0].slice(1), [perSec6Of(0.25), 0]);
  h.registered = { cpuPricePerSec6: BigInt(perSec6Of(0.25)), gpuPricePerSec6: 0n };
  await h.ensurePriced({ setPrices });
  assert.equal(calls.length, 1); assert.equal(h.priceSent, null);
});

test("the tray's call: PUT /v1/local/hosting/price sets and clears the override; GET shows pricing; bad input is a 400", async () => {
  const http = (await import("node:http")).default;
  const { hostingAdminHandler } = await import("../windows/node/hosting.mjs");
  const h = box(); h.setPriceRows([METAL0]);
  const server = http.createServer(hostingAdminHandler({ host: h, token: "t0k" }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); after(() => server.close());
  const call = (method, p, body) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { authorization: "Bearer t0k", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (r) => ({ status: r.status, json: await r.json() }));
  const v0 = await call("GET", "/v1/local/hosting");
  assert.equal(v0.json.pricing.cpu.override, null); assert.ok(v0.json.pricing.cpu.default.perHour > 0); assert.equal(v0.json.pricing.gpu, null, "no card, no GPU price");
  const set = await call("PUT", "/v1/local/hosting/price", { cpuPerHour: 0.3 });
  assert.equal(set.status, 200); assert.equal(set.json.pricing.cpu.override, 0.3);
  assert.equal((await call("PUT", "/v1/local/hosting/price", { cpuPerHour: "cheap" })).status, 400);
  assert.equal((await call("POST", "/v1/local/hosting/price", { cpuPerHour: 1 })).status, 405);
  const cleared = await call("PUT", "/v1/local/hosting/price", { cpuPerHour: null });
  assert.equal(cleared.json.pricing.cpu.override, null);
});

test("after a restart the default keeps the registry's price when it is within the drift: no transaction for a re-measured box", () => {
  const h = box();
  const def = perSec6Of(DEFAULT_UNIT_PER_HOUR.cpu * h.pricedCapacity().cpu.gb * 370);
  h.registered = { cpuPricePerSec6: BigInt(def + 2), gpuPricePerSec6: 0n };      // what an earlier run posted (a few % off)
  h.setPriceRows([METAL0]);
  assert.equal(h.cfg.cpuPricePerSec6, def + 2, "the posted price stands");
  const far = box(); far.registered = { cpuPricePerSec6: BigInt(def * 2), gpuPricePerSec6: 0n };
  far.setPriceRows([METAL0]);
  assert.equal(far.cfg.cpuPricePerSec6, def, "twice the default is out of the drift: the default goes up");
});
