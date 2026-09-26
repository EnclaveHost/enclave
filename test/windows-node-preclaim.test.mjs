// The node never spends a claim on a deployment it would refuse (coordinator enclave-87, from d1's live test 1:
// 0x31136008 was claimed at 01:00:29Z, tx 0x0340540e, and held 2 s later on "hasSecrets ... not known here"). consider()
// now runs the SAME partition verdict as the spawn (host.isolationVerdict: node-bridge's isolationPlan) BEFORE the claim,
// with whether secrets are staged read from the relay's lease-free /v1/secrets/exists. Unknown -> queued, nothing
// tracked, no chain call; refused -> sticky while the ledger's inputs are unchanged; ok -> the claim goes ahead.
// And the backend rule 87 asked about: only a deployment requiring THIS box's backend is ever claimed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { fakeBaseRpc, DEPLOYMENTS, CATALOG, enclaveIdOf } from "./helpers/fake-base-rpc.mjs";
import { REC, DEP, FakeHost, bootManager, closeManagers } from "./helpers/hv-fake-manager.mjs";

process.env.NODE_OPERATOR_KEY = "0x" + "7f".repeat(32);
const rpc = await fakeBaseRpc();
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
chain.addresses.appCatalog = CATALOG;
chain.loadOperator();
const { Host } = await import("../windows/node/host.mjs");
after(() => { closeManagers(); rpc.close(); });

const ENDPOINT = "https://api.enclave.host/t/test";
const OPERATOR = chain.operatorAddress().toLowerCase();
const APPREF = `catalog://${REC.catalog.app}/${REC.catalog.version}`;
const env = (require) => JSON.stringify({ isolation: { require } });
rpc.catalog.current = { cid: REC.cid, version: "1.0.0", vramMb: 0, gpuGflops: 0, memMb: REC.policy.memMiB, cpuGflops: 0,
  createdAt: 1n, verified: true, yanked: false, ports: "", approval: 1, config: "{}" };
const row = (over = {}) => ({ id: DEP, owner: OPERATOR, appRef: APPREF, ports: "", configCid: env("hyperv-partition-per-app"),
  gpuMilli: 0, cpuMilli: 100, appPort: 8080, isPublic: true, active: true, createdAt: 1n, rate: 1n, balance6: 0n, spent6: 0n,
  runner: "0x" + "00".repeat(32), runnerOperator: "0x" + "00".repeat(20), leaseUntil: 0n, ...over });

async function relay(answer) {
  const paths = [];
  const srv = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => { raw += d; });
    req.on("end", () => { paths.push(req.url); const { status, body } = answer(JSON.parse(raw || "{}"));
                          res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
  });
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  return { base: `http://127.0.0.1:${srv.address().port}`, paths, close: () => srv.close() };
}
// every server a test opens is closed by the test runner, even when an assertion fails first (a stranded one kept the
// whole file alive)
const open = [];
after(() => { for (const c of open) try { c(); } catch {} });
async function node(answer) {
  const { port } = await bootManager(new FakeHost(), 0);
  const r = await relay(answer);
  open.push(r.close);
  const h = new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-preclaim-")), endpoint: ENDPOINT, name: "test", appsEnabled: true,
    cpuPricePerSec6: 12, ramGb: 64, log: () => {}, engineRetired: true, isolationManager: `http://127.0.0.1:${port}`,
    isolationRuntimeId: REC.runtimeId, relayBase: r.base });
  h.chainReady = true; h.registered = { endpoint: ENDPOINT, cpuPricePerSec6: 12n, gpuPricePerSec6: 0n };
  return { h, r };
}
const TX = /^eth_(sendRawTransaction|sendTransaction|estimateGas|getTransactionCount)$/;
const claimSide = (from) => rpc.calls.slice(from).filter((m) => TX.test(m));

test("an UNKNOWN has-secrets answer means no claim at all: queued, not tracked, no transaction prepared", async () => {
  rpc.row.current = row();
  const { h, r } = await node(() => ({ status: 503, body: { error: "secrets_disabled" } }));
  const from = rpc.calls.length;
  const out = await h.consider(DEP);
  r.close();
  assert.equal(out.accepted, false);
  assert.match(out.reason, /before any claim: hasSecrets: whether the deployment has staged secrets is not known here/);
  assert.equal(h.records.get(DEP).status, "queued");
  assert.equal(h.tracked.has(DEP), false, "tracked before its verdict");
  assert.deepEqual(claimSide(from), [], "a claim was prepared");
  assert.ok(r.paths.every((p) => p === "/v1/secrets/exists"));
});

test("a DEFINITE refusal (secrets staged) is sticky: asked once, not re-asked while the ledger's inputs are unchanged, re-asked when they change", async () => {
  rpc.row.current = row();
  const { h, r } = await node((b) => ({ status: 200, body: { id: b.id, exists: true } }));
  const from = rpc.calls.length;
  const a = await h.consider(DEP);
  assert.match(a.reason, /before any claim: hasSecrets: the deployment has staged secrets/);
  const asked = r.paths.length;
  const b = await h.consider(DEP);
  assert.equal(b.reason, a.reason);
  assert.equal(r.paths.length, asked, "a sticky refusal asked the relay again");
  assert.deepEqual(claimSide(from), []);
  assert.equal(h.tracked.has(DEP), false);
  rpc.row.current = row({ cpuMilli: 200 });                       // an input on the ledger changed: judged afresh
  await h.consider(DEP);
  assert.ok(r.paths.length > asked);
  r.close();
});

test("a verdict that passes goes on to the claim (the ledger is asked and a claim is prepared)", async () => {
  rpc.row.current = row();
  const { h, r } = await node((b) => ({ status: 200, body: { id: b.id, exists: false } }));
  const from = rpc.calls.length;
  const out = await h.consider(DEP);
  r.close();
  assert.equal(h.tracked.has(DEP), true);
  assert.ok(claimSide(from).length > 0 || /claim failed/.test(String(out.reason)), `no claim was attempted: ${JSON.stringify(out)}`);
});

test("87's backend rule: a SERVED owner's deployment requiring another backend, or none, is never claimed - and never probed", async () => {
  for (const configCid of [env("snp-guest-per-app"), ""]) {
    rpc.row.current = row({ configCid });
    const { h, r } = await node((b) => ({ status: 200, body: { id: b.id, exists: false } }));
    const from = rpc.calls.length;
    const out = await h.consider(DEP);
    r.close();
    assert.equal(out.accepted, false, configCid);
    assert.match(out.reason, configCid ? /requires isolation backend snp-guest-per-app, and this box runs hyperv-partition-per-app/
                                       : /claims only deployments that require hyperv-partition-per-app/);
    assert.deepEqual(claimSide(from), []);
    assert.deepEqual(r.paths, [], "the relay was asked about a deployment this box would never claim");
    // ...and held if it were ever this box's: not restarted, not spawned
    assert.ok(h.heldReason({ ...row({ configCid }), owner: OPERATOR }), "a non-hv deployment is not held");
  }
  assert.ok(enclaveIdOf);
});
