// accept.mjs evaluate(): a fully healthy post-cutover fixture (built from the pinned expectations) is ACCEPTED; EVERY single
// deviation fails it; missing payments are PENDING, never success.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "../accept.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const expect = JSON.parse(fs.readFileSync(path.join(HERE, "../expectations.json"), "utf8"));
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const cutover = { cutoverBlock: 1000, activatedAt: "2026-10-21T09:00:00.000Z", activateStartedAt: "2026-10-21T08:58:00.000Z" };
const good = () => ({
  minipc: { at: "2026-10-21T09:30:00Z", vms: expect.vms.map((id) => ({ id, status: "running" })), agents: [{ pid: 1, created: "2026-10-21T08:59:00Z" }], loops: [{ pid: 2, created: "2026-10-21T08:59:00Z" }],
    healthy: true, leaseMode: "app-funded", operator: expect.operator, control: { ...expect.control }, settings: { ...expect.settings }, settingsCalled: true,
    tasks: { Node: "Running", Shield: "Running", Network: "Running", Update: "Ready", Relay: "Running" }, relayProcesses: 1, relayListeners: 1,
    relayInfo: { payee: expect.relay.payee, chainId: 8453, reserve: expect.relay.reserve, executor: expect.relay.executor }, relayLog: [{ status: "success", hash: H(1), paid: "1" }] },
  source: { at: "2026-10-21T09:31:00Z", activeState: "inactive", loadState: "masked", unitFileState: "masked", unitPathLink: "/dev/null", relayProcesses: 0, listeners8549: 0,
    localAnswersAsPayee: false, frontAnswersAsPayee: false, stopReceipt: { masked: true, keyMoved: false, stoppedAt: "2026-10-21T08:40:00Z" } },
  chain: { at: "2026-10-21T09:32:00Z", status: "LOCAL_VERIFIED", window: { fromBlock: "1000" }, counts: { moved: 2, fallback: 1, failed: 0 }, failures: [] },
});
const run = (mut) => { const g = good(); mut?.(g); return evaluate({ expect, cutover, ...g }); };

test("the healthy post-cutover state is ACCEPTED", () => {
  const r = run(); assert.equal(r.status, "ACCEPTED", JSON.stringify(r.checks.filter((c) => c.state !== "pass")));
  assert.ok(r.checks.length >= 18);
});
test("every single deviation FAILS the acceptance", () => {
  const cases = {
    "a VM lost": (g) => { g.minipc.vms[3].status = "stopped"; },
    "a VM missing": (g) => { g.minipc.vms.pop(); },
    "an extra VM": (g) => { g.minipc.vms.push({ id: "hv" + "1".repeat(32), status: "running" }); },
    "no VM list": (g) => { g.minipc.vms = null; },
    "two agents": (g) => { g.minipc.agents.push({ pid: 3 }); },
    "no loop": (g) => { g.minipc.loops = []; },
    "loop not restarted by the activation": (g) => { g.minipc.loops[0].created = "2026-10-21T08:00:00Z"; },
    "unhealthy": (g) => { g.minipc.healthy = false; },
    "operator-paid": (g) => { g.minipc.leaseMode = "operator-paid"; },
    "another operator": (g) => { g.minipc.operator = "0x" + "2".repeat(40); },
    "the bundle is the old one": (g) => { g.minipc.control["windows/node/lease-gas-runtime.bundle.mjs"] = "64712447030248173f35e8ac916c737dfd91f719d69335979a83f1cfffb356b6"; },
    "an unchanged file drifted": (g) => { g.minipc.control["windows/node/agent.mjs"] = "00".repeat(32); },
    "a control file missing": (g) => { delete g.minipc.control["windows/node/host.mjs"]; },
    "settings still before": (g) => { g.minipc.settings["lease-gas-config.cmd"] = "9ed3c199db6968a4274b40e9940a65a591f68295b1c3dae44e23084a27efa56e"; },
    "settings not called": (g) => { g.minipc.settingsCalled = false; },
    "relay task disabled": (g) => { g.minipc.tasks.Relay = "Disabled"; },
    "no relay listener": (g) => { g.minipc.relayListeners = 0; },
    "the relay is another payee": (g) => { g.minipc.relayInfo.payee = expect.fallbackPayee; },
    "the relay serves another reserve": (g) => { g.minipc.relayInfo.reserve = "0x" + "3".repeat(40); },
    "the relay does not answer": (g) => { g.minipc.relayInfo = null; },
    "the source is not masked": (g) => { g.source.loadState = "loaded"; g.source.unitFileState = "disabled"; },
    "the source is active": (g) => { g.source.activeState = "active"; },
    "the source still listens": (g) => { g.source.listeners8549 = 1; },
    "the source front answers as the payee": (g) => { g.source.frontAnswersAsPayee = true; },
    "no stop receipt": (g) => { g.source.stopReceipt = null; },
    "the chain audit failed": (g) => { g.chain.status = "FAILED"; g.chain.failures = [{ error: "not routed through minipc" }]; },
    "the chain window starts before the cutover": (g) => { g.chain.window.fromBlock = "900"; },
    "a stale minipc document": (g) => { g.minipc.at = "2026-10-21T08:00:00Z"; },
  };
  for (const [why, mut] of Object.entries(cases)) assert.equal(run(mut).status, "FAILED", why);
});
test("no payment yet, or eu-central only, is PENDING: neither success nor failure", () => {
  const none = run((g) => { g.chain.status = "NO_EVENTS_YET"; g.chain.counts = { moved: 0, fallback: 0, failed: 0 }; });
  assert.equal(none.status, "PENDING"); assert.match(none.checks.find((c) => c.id === "chain").detail, /absence is not proven/);
  const fb = run((g) => { g.chain.status = "FALLBACK_ONLY"; g.chain.counts = { moved: 0, fallback: 2, failed: 0 }; });
  assert.equal(fb.status, "PENDING");
  const part = run((g) => { g.chain.status = "PARTIAL"; g.chain.counts = { moved: 4, fallback: 0, unverified: 2, failed: 0 }; });
  assert.equal(part.status, "PENDING"); assert.match(part.checks.find((c) => c.id === "chain").detail, /not a failure/);
  assert.equal(run((g) => { g.chain.status = "UNVERIFIED_ONLY"; g.chain.counts = { moved: 0, fallback: 0, unverified: 1, failed: 0 }; }).status, "PENDING");
  assert.equal(run((g) => { g.chain.status = "NO_EVENTS_YET"; g.minipc.healthy = false; }).status, "FAILED", "a failure outranks pending");
  assert.equal(evaluate({ expect, cutover: { cutoverBlock: 1000 }, ...good() }).status, "FAILED", "no activatedAt in the marker: refused");
});
