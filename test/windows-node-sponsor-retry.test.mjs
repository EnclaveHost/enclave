// windows/node/host.mjs ensureRegistered: a NEW box with no gas asks the relay to sponsor its first registration. Asked
// before the relay has seen its attach (seconds after start-up), it asks again within the minute, not in 10
// (nucbox-k11-2 waited 10 minutes over a 5-second race, 2026-10-12); any other refusal still waits 10 minutes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc } from "./helpers/fake-base-rpc.mjs";

const rpc = await fakeBaseRpc();                     // BEFORE chain.mjs loads: it reads BASE_RPCS once
const chain = await import("../windows/node/chain.mjs");
const { Host } = await import("../windows/node/host.mjs");
after(() => rpc.close());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-sponsor-")), keyFile = path.join(dir, "operator.key");
fs.writeFileSync(keyFile, "0x" + "11".repeat(32) + "\n");
chain.loadOperator(keyFile);

function box(refusal) {
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/new-box", name: "new-box", appsEnabled: true, cpuPricePerSec6: 12, log: () => {} });
  h.chainReady = true; h.registered = null;
  h.calls = 0; h.sponsorRegister = async () => { h.calls++; throw new Error(refusal); };
  return h;
}
const wait = (h) => h._sponsorRetryAt - Date.now();

test("not attached yet: asked again within the minute; anything else: in 10 minutes", async () => {
  for (const msg of ["the relay did not sponsor this registration (voucher, HTTP 404): no attested tunnel by that name",
                     "the relay did not sponsor this registration (voucher, HTTP 403): this box attached without naming its operator key (a v2 attach signature), or its name is already registered"]) {
    const h = box(msg);
    await h.ensureRegistered();
    assert.equal(h.calls, 1); assert.ok(wait(h) > 20_000 && wait(h) <= 30_000, `${msg}: ${wait(h)}`);
    await h.ensureRegistered(); assert.equal(h.calls, 1, "not asked again before the retry time");
  }
  const h = box("the relay did not sponsor this registration (voucher, HTTP 409): this hardware was sponsored already");
  await h.ensureRegistered();
  assert.ok(wait(h) > 590_000 && wait(h) <= 600_000, String(wait(h)));
});

test("no box sends an on-chain heartbeat, tunnelled or dialed (liveness is off-chain)", async () => {
  assert.equal(Host.isTunnelEndpoint("https://api.enclave.host/t/nucbox-k11-2"), true);
  for (const e of ["https://box.example.com", "https://api.enclave.host/t/", "https://api.enclave.host/t/a/b", "", null])
    assert.equal(Host.isTunnelEndpoint(e), false, String(e));
  const sent = [];
  for (const endpoint of ["https://api.enclave.host/t/new-box", "https://box.example.com"]) {
    const h = new Host({ dir, endpoint, name: "b", appsEnabled: true, cpuPricePerSec6: 12, log: (m) => sent.push([endpoint, m]) });
    h.chainReady = true; h.registered = { active: true };
    await h.heartbeat();
  }
  assert.ok(!sent.some(([, m]) => /heartbeat/i.test(m)), "neither box tried: " + JSON.stringify(sent));
  // (test/offchain-heartbeat-writers.test.mjs counts the transactions themselves on a real chain)
});
