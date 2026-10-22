// The Windows node host enforces the SAME platform host policy gate as supervisor.js (network/host-service-gate.mjs from
// the shared host-admission bundle): an explicit ban refuses new claims (consider) and app traffic (proxy, the one place
// both of the box's HTTP doors funnel through), an outage after the ban keeps it refused, the admin's unban restores.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Host } from "../windows/node/host.mjs";
import { createHostServiceGate } from "../network/host-service-gate.mjs";
import { measuredHostGate } from "../network/host-policy-adapters.mjs";

test("Windows host: ban -> no new claims and no app traffic; outage keeps refusing; unban restores; default is off in tests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "win-policy-"));
  const plain = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test", appsEnabled: true, cpuPricePerSec6: 12, log: () => {} });
  assert.equal(plain.platformPolicy.enabled, false, "no activation config and no production book: off, unchanged behavior");
  let mode = "ban";
  const probe = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test", appsEnabled: true, cpuPricePerSec6: 12, log: () => {}, platformPolicy: { enabled: false, start() {}, newWorkRefusal: () => null, serviceRefusal: () => null } });
  const hostId = probe.enclaveId;
  const gate = { async refresh() {}, async decide() {
    if (mode === "down") throw Error("rpc quorum unavailable");
    return { decisions: { [hostId]: mode === "ban" ? { admit: false, status: "current", reason: "banned by platform policy #7 (operator): abuse" } : { admit: true, status: "current" } } }; } };
  const runtime = { measured: (id, o) => measuredHostGate({ gate, hostId: id, ...o }), status: () => ({}) };
  const pp = createHostServiceGate({ runtime, hostId, stateDir: dir, log: () => {} });
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test", appsEnabled: true, cpuPricePerSec6: 12, log: () => {}, platformPolicy: pp });
  const id = "0x" + "ab".repeat(32);
  await pp.check();
  const c1 = await h.consider(id); assert.equal(c1.accepted, false); assert.match(c1.reason, /platform host policy: banned by platform policy #7/);
  const p1 = await h.proxy(id, { method: "GET", pathRest: "/", headers: {}, body: null });
  assert.equal(p1.status, 403); assert.equal(JSON.parse(Buffer.from(p1.body).toString()).error, "host_policy_refused");
  mode = "down"; await pp.check();
  assert.match((await h.consider(id)).reason, /platform host policy: banned/, "an outage after the ban never resurrects work");
  mode = "admit"; await pp.check();
  const c2 = await h.consider(id); assert.doesNotMatch(c2.reason || "", /platform host policy/, "after the unban the claim proceeds to its normal checks");
  const p2 = await h.proxy(id, { method: "GET", pathRest: "/", headers: {}, body: null });
  assert.notEqual(p2.status === 403 && /host_policy_refused/.test(Buffer.from(p2.body || "").toString()), true, "app traffic is no longer refused by the policy");
  fs.rmSync(dir, { recursive: true, force: true });
});
