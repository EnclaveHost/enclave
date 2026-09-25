// reboot-accept.test.mjs - the driver's post-reboot VERIFY logic against a stub manager (HTTP) and a stub data plane (TCP),
// with a stub Hyper-V survey: a correct recovery passes, and each defect fails its own check.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { runVerify, armDeployments, SWITCHES } from "./reboot-accept.mjs";

const ids = ["hv" + "a".repeat(32), "hv" + "b".repeat(32)];
const vmIds = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];

async function fixture({ recovered = true, sweepFails = true, extraInstance = false, vmState = "Off", launchers = 0, routeAnswer = "NO the instance is failed", relayOpen = false, deleteRemoves = true, env = {} } = {}) {
  const started = Date.now();
  const recs = new Map(ids.map((id) => [id, { id, recovered, status: "starting", relay: null, appReady: false, reason: null }]));
  if (extraInstance) recs.set("hv" + "c".repeat(32), { id: "hv" + "c".repeat(32), recovered: false, status: "running", relay: { port: 1 }, appReady: true });
  let vms = vmIds.map((vmId, i) => ({ vmId, name: `enclave-app-${ids[i]}`, state: vmState, notes: `enclave-vbslike-app-domain/manager|${ids[i]}` }));
  const mgr = http.createServer((req, res) => {
    const m = req.url.match(/^\/vms(?:\/([^/?]+))?/);
    const send = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (!m) return send(404, {});
    if (!m[1]) return send(200, { vms: [...recs.values()] });
    const r = recs.get(m[1]);
    if (req.method === "DELETE") { if (!r) return send(404, {}); recs.delete(m[1]); if (deleteRemoves) vms = vms.filter((v) => !v.notes.endsWith(m[1])); return send(200, { removed: true }); }
    if (!r) return send(404, {});
    if (sweepFails && Date.now() - started > 1500 && r.status === "starting") { r.status = "failed"; r.reason = "the partition is Off: it stopped by itself"; }
    return send(200, r);
  });
  await new Promise((r) => mgr.listen(0, "127.0.0.1", r));
  const dp = net.createServer((c) => { c.once("data", () => { c.end(routeAnswer + "\n"); }); });
  await new Promise((r) => dp.listen(0, "127.0.0.1", r));
  const relay = net.createServer((c) => c.end());
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const relayPort = relay.address().port;
  if (!relayOpen) await new Promise((r) => relay.close(r));
  const base = `http://127.0.0.1:${mgr.address().port}`;
  const ctl = {
    parseNotes: (n) => { const s = String(n || ""); const owned = s.startsWith("enclave-vbslike-app-domain/manager|"); return { owned, identity: owned ? { id: s.split("|")[1] } : null }; },
    env: () => ({ ENCLAVE_LIVENESS_MS: "15000", ...env }), base: () => base,
    survey: async () => ({ vms }), launchers: async () => launchers,
    startManager: async () => base, killManager: async () => {},
  };
  const state = { dataPort: dp.address().port, expectBodySha256: null,
    deployments: ids.map((id, i) => ({ id, name: "0xb" + i + "a".repeat(62), vmId: vmIds[i], relayPort, transportKeySha256: "k".repeat(64),
                                        route: { id, app: "a".repeat(64), image: "b".repeat(64), runtime: "c".repeat(64), key: "k".repeat(64) } })) };
  const close = async () => { await new Promise((r) => mgr.close(r)); await new Promise((r) => dp.close(r)); if (relayOpen) await new Promise((r) => relay.close(r)); };
  return { ctl, state, close };
}
async function verify(opts) {
  const f = await fixture(opts); const lines = [];
  try { const r = await runVerify({ ctl: f.ctl, state: f.state, say: (l) => lines.push(l), sweepWaitMs: 8000 }); return { ...r, lines }; }
  finally { await f.close(); }
}
const failed = (r, id) => r.lines.some((l) => l.startsWith(`FAIL ${id}:`));

test("a correct recovery after a host reboot passes every check", async () => {
  const r = await verify();
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const id of ["V0", "V1", "V2a", "V3", "V2b", "V4", "V5"]) assert.ok(r.lines.some((l) => l.startsWith(`PASS ${id}:`)), `${id}\n${r.lines.join("\n")}`);
});
test("each defect fails its own check", async () => {
  assert.ok(failed(await verify({ env: { ENCLAVE_ISOLATION_RESPAWN: "1" } }), "V0"), "a respawn switch in the env");
  assert.ok(failed(await verify({ recovered: false }), "V1"), "not marked recovered");
  assert.ok(failed(await verify({ extraInstance: true }), "V1"), "an instance that was not armed");
  assert.ok(failed(await verify({ vmState: "Running" }), "V2a"), "a VM that came back by itself");
  assert.ok(failed(await verify({ launchers: 1 }), "V2a"), "a launcher running");
  assert.ok(failed(await verify({ sweepFails: false }), "V3"), "never failed by the liveness sweep");
  assert.ok(failed(await verify({ routeAnswer: "OK" }), "V4"), "an old route admitted");
  assert.ok(failed(await verify({ relayOpen: true }), "V4"), "an old relay port accepting");
  assert.ok(failed(await verify({ deleteRemoves: false }), "V5"), "a VM left after cleanup");
});
test("the armed lab deployments are named 0xb0…/0xb1… with distinct small policies, and the switch list is exact", () => {
  const d = armDeployments({ derive: { policy: { memMiB: 64 } } }, "0x" + "d1".repeat(32));
  assert.deepEqual(d.map((x) => x.name.slice(0, 4)), ["0xb0", "0xb1"]);
  assert.deepEqual(d.map((x) => x.derive.policy.memMiB), [128, 144]);
  assert.ok(d.every((x) => x.name.length === 66));
  assert.ok(SWITCHES.test("ENCLAVE_ISOLATION_RESPAWN") && SWITCHES.test("RELAY_HVNODE_ATTACH") && !SWITCHES.test("ENCLAVE_LIVENESS_MS"));
});
