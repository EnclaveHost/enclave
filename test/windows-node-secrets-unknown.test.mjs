// Whether an isolated deployment HAS staged secrets is known only from the relay's own answer for that deployment
// (enclave-b4's N3). fetchSecrets read EVERY 503 as "this relay has no secrets plane", so a proxy's 503 in front of a
// restarting relay made the node count "none" - and the isolation plan went ahead. Now only the relay's own
// secrets_disabled 503 is authoritative for a launch, any other 503 is retried and thrown, and the isolation probe
// treats anything but a 200 for this id as UNKNOWN, which holds. Against the real node, plan and manager; only
// Hyper-V, Base and the relay are faked.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";
import { REC, DEP, ISOLATED, PLANNED, FakeHost, bootManager, closeManagers } from "./helpers/hv-fake-manager.mjs";

const rpc = await fakeBaseRpc();
(await import("../windows/node/chain.mjs")).addresses.deployments = DEPLOYMENTS;
const { Host } = await import("../windows/node/host.mjs");
const { fetchSecrets } = await import("../windows/node/secrets.mjs");
after(() => { closeManagers(); rpc.close(); });

const sign = async () => "0x" + "11".repeat(65);
// a relay (or whatever answers at its address) that replies `answer(call#)` to every POST /v1/secrets/fetch
async function relayAnswering(answer) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      calls.push(raw);
      const { status, body, type = "application/json" } = answer(calls.length - 1, JSON.parse(raw || "{}"));
      res.writeHead(status, { "content-type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  return { base: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close() };
}
const PROXY_503 = () => ({ status: 503, type: "text/html", body: "<html><body>503 Service Unavailable</body></html>" });
const DISABLED = () => ({ status: 503, body: { error: "secrets_disabled", message: "Per-deployment secrets are not configured on this relay." } });

test("fetchSecrets: a 503 that is not the relay's own secrets_disabled is retried and thrown, never 'no secrets'", { timeout: 30_000 }, async (t) => {
  const relay = await relayAnswering(PROXY_503);
  t.after(relay.close);
  await assert.rejects(() => fetchSecrets({ id: DEP, endpoint: "https://api.enclave.host/t/test", sign, base: relay.base }),
                       /after 3 tries \(HTTP 503/);
  assert.equal(relay.calls.length, 3, "a transient 503 gets the 5xx backoff");
  // the relay's own answer stays what it was: authoritative for a launch, one call
  const off = await relayAnswering(DISABLED);
  t.after(off.close);
  const r = await fetchSecrets({ id: DEP, endpoint: "https://api.enclave.host/t/test", sign, base: off.base });
  assert.equal(r.source, "disabled");
  assert.equal(off.calls.length, 1);
});

const dep = () => ({ appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  leaseUntil: Math.floor(Date.now() / 1000) + 3600, cpuMilli: 100, gpuMilli: 0, isPublic: true,
  owner: "0x29479bf04ed889d46a7afb7f292b9bb26e12647c", configCid: ISOLATED });
async function planWith(answer) {
  const host = new FakeHost();
  const m = await bootManager(host, 0);
  const relay = await relayAnswering(answer);
  const h = new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-sec-unknown-")), endpoint: "https://api.enclave.host/t/test",
    name: "test", appsEnabled: true, cpuPricePerSec6: 12, log: () => {}, isolationManager: `http://127.0.0.1:${m.port}`,
    isolationRuntimeId: REC.runtimeId, relayBase: relay.base, engineRetired: true });
  h.cfg.secretsSign = sign;
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  relay.close();
  return { r, host, relay };
}

test("the isolation plan HOLDS when the relay has no secrets plane: secrets_disabled is unknown, not 'none'", { timeout: 30_000 }, async () => {
  const { r, host } = await planWith(DISABLED);
  assert.equal(r.status, "provisioning", JSON.stringify(r));
  assert.match(r.reason, /hasSecrets: whether the deployment has staged secrets is not known here/);
  assert.equal(host.running().length, 0, "a partition was started on an unknown");
});

test("the isolation plan HOLDS on a proxy's 503: retried, thrown, unknown", { timeout: 30_000 }, async () => {
  const { r, host, relay } = await planWith(PROXY_503);
  assert.equal(r.status, "provisioning", JSON.stringify(r));
  assert.match(r.reason, /hasSecrets/);
  assert.equal(relay.calls.length, 3);
  assert.equal(host.running().length, 0);
});

test("the relay's own 200 with nothing staged is KNOWN none: the partition is started", { timeout: 30_000 }, async () => {
  const { r, host } = await planWith((i, b) => ({ status: 200, body: { id: b.id, rev: 0, env: {} } }));
  assert.equal(r.status, "running", r.reason);
  assert.equal(host.running().length, 1);
});

test("names the node's filter drops were still STAGED: the plan refuses rather than run without them", { timeout: 30_000 }, async () => {
  const { r, host } = await planWith((i, b) => ({ status: 200, body: { id: b.id, rev: 1, env: { "not a name": "x" } } }));
  assert.notEqual(r.status, "running", JSON.stringify(r));
  assert.match(r.reason, /hasSecrets: the deployment has staged secrets/);
  assert.equal(host.running().length, 0);
});
