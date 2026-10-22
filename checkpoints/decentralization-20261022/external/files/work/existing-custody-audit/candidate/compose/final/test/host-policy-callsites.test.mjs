// Platform host policy at its real call sites (unit level, no chain): the relay tunnel hub (every attach path + the hot ban
// of attached tunnels) and the host service gate shared by supervisor.js and the Windows node host (new work, service,
// renewal; sticky refusal; grace through transient outages; persistence across restarts; admin unban recovery).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { createTunnelHub } from "../relay/tunnel.js";
import { createHostServiceGate, hostIdOfEndpoint } from "../network/host-service-gate.mjs";
import { measuredHostGate } from "../network/host-policy-adapters.mjs";
import { resolveHostPolicyConfig, PRODUCTION_BOOK } from "../network/platform-host-policy-config.mjs";

const TOKEN = "s3cret-token", TOKEN_SHA = createHash("sha256").update(TOKEN).digest("hex");
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
async function hubServer(hostAdmission, hostPolicyRecheckMs = 60_000) {
  const hub = createTunnelHub({ allow: [{ name: "metal0", tokenSha256: TOKEN_SHA }], hostAdmission, hostPolicyRecheckMs });
  const server = http.createServer((_q, r) => r.end("ok"));
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { hub, url: `ws://127.0.0.1:${server.address().port}/v1/fleet-tunnel`, close: () => new Promise((r) => server.close(r)) };
}
const dial = (url, headers) => new Promise((resolve) => {
  const ws = new WebSocket(url, { headers }); const frames = []; let closed = false;
  ws.on("message", (d) => { try { frames.push(JSON.parse(d)); } catch {} });
  ws.on("close", () => { closed = true; });
  ws.on("open", () => resolve({ state: "open", ws, frames, closed: () => closed }));
  ws.on("unexpected-response", (_q, res) => { try { ws.terminate(); } catch {} resolve({ state: res.statusCode }); });
  ws.on("error", () => resolve({ state: "error" }));
});

test("tunnel: a refused host cannot attach (token path); an admitted one can; the hot ban detaches it; undecided never detaches", async () => {
  let decision = { admit: false, status: "current", reason: "banned by platform policy #2 (operator): abuse" }, asked = [];
  const h = await hubServer(async (name) => { asked.push(name); return decision; }, 40);
  try {
    assert.equal((await dial(h.url, { "x-metal-name": "metal0", "x-metal-token": TOKEN })).state, 403, "token attach refused by the policy");
    assert.equal(h.hub.count(), 0);
    assert.equal((await dial(h.url, { "x-metal-name": "metal0", "x-metal-token": "wrong" })).state, 401, "the token check still comes first");
    decision = { admit: true, status: "current" };
    const ok = await dial(h.url, { "x-metal-name": "metal0", "x-metal-token": TOKEN });
    assert.equal(ok.state, "open"); await settle(); assert.equal(h.hub.count(), 1);
    decision = { admit: false, status: "behind", reason: "node behind the anchor" };
    await settle(150); assert.equal(h.hub.count(), 1, "an undecided recheck leaves an attached box alone");
    decision = { admit: false, status: "current", reason: "banned by platform policy #3 (owner): fraud" };
    await settle(200);
    assert.equal(h.hub.count(), 0, "HOT BAN: the attached tunnel is cut off");
    assert.ok(ok.closed(), "its socket is terminated");
    assert.ok(asked.length >= 4);
  } finally { await h.close(); }
});

test("tunnel: with no policy configured nothing changes", async () => {
  const h = await hubServer(null);
  try { const ok = await dial(h.url, { "x-metal-name": "metal0", "x-metal-token": TOKEN }); assert.equal(ok.state, "open"); await settle(); assert.equal(h.hub.count(), 1); ok.ws.close(); }
  finally { await h.close(); }
});

// ---- the host service gate (supervisor.js and windows/node/host.mjs call exactly these methods) ----
const HOST = hostIdOfEndpoint("https://host.example.org");
function scripted() {
  let mode = "admit";
  const gate = { async refresh() {}, async decide() {
    if (mode === "down") throw Error("rpc quorum unavailable");
    const d = mode === "admit" ? { admit: true, status: "current" } : mode === "not-activated" ? { admit: true, status: "not-activated" }
      : mode === "ban" ? { admit: false, status: "current", reason: "banned by platform policy #5 (registryId): abuse" }
      : mode === "inactive" ? { admit: false, status: "inactive", reason: "host registry entry is not active" } : { admit: false, status: "behind", reason: "behind" };
    return { decisions: { [HOST]: d } }; } };
  return { set: (m) => { mode = m; }, runtime: { measured: (id, o) => measuredHostGate({ gate, hostId: id, ...o }), status: () => ({ activation: "anchor" }) } };
}
test("host service gate: admit -> ban stops new work, service and renewal; outage keeps it stopped; the admin's unban restores", async () => {
  let t = 1_000_000; const s = scripted(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "hpg-"));
  const g = createHostServiceGate({ runtime: s.runtime, hostId: HOST, stateDir: dir, graceMs: 60_000, now: () => t, log: () => {} });
  assert.equal(g.enabled, true);
  assert.match(g.newWorkRefusal(), /not yet checked/, "a fresh host takes no work before its first admit");
  await g.check(); assert.equal(g.newWorkRefusal(), null); assert.equal(g.serviceRefusal(), null);
  s.set("down"); t += 10_000; await g.check(); assert.equal(g.serviceRefusal(), null, "transient outage: grace keeps serving");
  s.set("ban"); t += 1000; await g.check();
  assert.match(g.newWorkRefusal(), /banned by platform policy #5/); assert.match(g.serviceRefusal(), /banned/);
  for (const m of ["down", "behind"]) { s.set(m); t += 1000; await g.check(); assert.match(g.serviceRefusal(), /banned/, `${m} after a ban keeps refusing`); }
  // restart during the outage: the KNOWN refusal is persisted
  const g2 = createHostServiceGate({ runtime: s.runtime, hostId: HOST, stateDir: dir, graceMs: 60_000, now: () => t, log: () => {} });
  s.set("down"); await g2.check(); assert.match(g2.serviceRefusal(), /banned/, "a banned host restarted during an outage stays refused");
  s.set("admit"); t += 1000; await g2.check(); assert.equal(g2.serviceRefusal(), null, "the admin's unban restores service");
  // restart during an outage after an admit: bounded grace from the persisted admit
  const g3 = createHostServiceGate({ runtime: s.runtime, hostId: HOST, stateDir: dir, graceMs: 60_000, now: () => t, log: () => {} });
  s.set("down"); t += 5000; await g3.check(); assert.equal(g3.serviceRefusal(), null, "persisted admit: grace across the restart");
  t += 120_000; await g3.check(); assert.match(g3.serviceRefusal(), /unreadable/, "the grace is bounded");
  s.set("not-activated"); await g3.check(); assert.equal(g3.newWorkRefusal(), null, "not activated by the admin: today's behavior");
  s.set("inactive"); await g3.check(); assert.match(g3.newWorkRefusal(), /not active/);
});
test("host service gate: off for test chains/books, ON for the production chain + book, unusable config refuses", () => {
  const off = createHostServiceGate({ env: {}, chainId: 31337, book: PRODUCTION_BOOK, endpoint: "https://h.example" });
  assert.equal(off.enabled, false); assert.equal(off.newWorkRefusal(), null); assert.equal(off.serviceRefusal(), null);
  assert.equal(resolveHostPolicyConfig({ env: {}, chainId: 8453, book: PRODUCTION_BOOK }).on, true, "production default: on");
  assert.equal(resolveHostPolicyConfig({ env: {}, chainId: 8453, book: null }).on, false, "no book: off unless the activation config says production");
  assert.equal(resolveHostPolicyConfig({ env: { ENCLAVE_PLATFORM_HOST_POLICY: "production" }, chainId: 8453, book: null }).on, true, "measured/Windows activation config");
  assert.equal(resolveHostPolicyConfig({ env: { ENCLAVE_PLATFORM_HOST_POLICY: "off" }, chainId: 8453, book: PRODUCTION_BOOK }).on, false);
  assert.throws(() => createHostServiceGate({ env: { ENCLAVE_PLATFORM_HOST_POLICY: "production" }, chainId: 8453 }), /PUBLIC_URL/, "on but no endpoint: supervisor turns this into refuse-all");
  assert.throws(() => resolveHostPolicyConfig({ env: { ENCLAVE_PLATFORM_HOST_POLICY: "{bad" } }), /production \| off \| JSON/);
});
