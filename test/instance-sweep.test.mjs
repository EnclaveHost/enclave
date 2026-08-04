// The instance reconciler's IO path (supervisor.js) — INSTANCE_SELFTEST covers
// the pure plan; this drives ONE REAL reconcileInstances() pass against a stub
// manager, because this is the code that actually issues DELETEs against live
// tenants. The property that matters most here is the fail-closed one: a
// listing the manager cannot answer must reap NOTHING. Reading an unreachable
// manager as "no instances run" would turn one flaky health check into a sweep
// that tears down every paying tenant on the box.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

// A stub wasm-manager. `vms` is the GET /vms answer (null = answer 500);
// records every DELETE it receives so the test can assert what was torn down.
function stubManager({ vms, deleteStatus = 200 }) {
  const deleted = [];
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/vms") {
      if (vms === null) { res.writeHead(500); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ vms }));
    }
    if (req.method === "DELETE" && req.url.startsWith("/vms/")) {
      deleted.push(decodeURIComponent(req.url.slice("/vms/".length)));
      res.writeHead(deleteStatus); return res.end("{}");
    }
    res.writeHead(404); res.end("{}");
  });
  return { srv, deleted };
}

async function sweep({ vms, records = [], deleteStatus = 200, kill = false }) {
  const { srv, deleted } = stubManager({ vms, deleteStatus });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  if (kill) await new Promise((r) => srv.close(r));   // nothing listening: connection refused
  try {
    const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
      env: { ...process.env, SECRET: "test-secret",
             PROVISION_BACKEND: "vm", VMMGR_URL: `http://127.0.0.1:${port}`,
             INSTANCE_REAP_MIN_AGE_SEC: "60",
             INSTANCE_SWEEP_SELFTEST: JSON.stringify({ records }),
             MOCK_SPAWN: "", POOL_SELFTEST: "", INSTANCE_SELFTEST: "", SWEEP_SELFTEST: "",
             REACH_SELFTEST: "", ACME_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "",
             REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "",
             APP_CERT_DOMAIN: "", DNS_API: "" } });
    const lines = stdout.trim().split("\n").filter(Boolean);
    return { ...JSON.parse(lines[lines.length - 1]), deleted };
  } finally {
    if (!kill) await new Promise((r) => srv.close(r));
  }
}

const old = (id, name) => ({ id, name, createdAt: Date.now() / 1000 - 3600, status: "running" });

test("the kryptos leak, end to end: the orphan is actually DELETEd", async () => {
  const r = await sweep({
    vms: [old("app_1a2b3c4d5", "0x5c2dcc4b6e")],
    records: [],
  });
  assert.deepEqual(r.reaped, ["0x5c2dcc4b6e"]);
  assert.deepEqual(r.deleted, ["app_1a2b3c4d5"], "DELETE targets the manager's vid, not the deployment id");
});

test("live tenants are never DELETEd", async () => {
  const r = await sweep({
    vms: [old("app_a", "0xaaa"), old("app_b", "0xbbb")],
    records: [{ id: "0xaaa", status: "running" }, { id: "0xbbb", status: "claimed" }],
  });
  assert.deepEqual(r.reaped, []);
  assert.deepEqual(r.deleted, []);
});

test("FAIL CLOSED: a manager that 500s the listing reaps nothing", async () => {
  const r = await sweep({ vms: null, records: [] });
  assert.deepEqual(r.reaped, []);
  assert.deepEqual(r.deleted, [], "an unreadable listing must never read as an empty fleet");
});

test("FAIL CLOSED: an unreachable manager reaps nothing", async () => {
  const r = await sweep({ vms: [old("app_x", "0xzzz")], records: [], kill: true });
  assert.deepEqual(r.reaped, []);
  assert.deepEqual(r.deleted, []);
});

test("a DELETE that 404s counts as reaped (already gone)", async () => {
  const r = await sweep({ vms: [old("app_g", "0xgone")], records: [], deleteStatus: 404 });
  assert.deepEqual(r.reaped, ["0xgone"]);
});

test("a DELETE that fails is NOT counted, and retries next pass", async () => {
  const r = await sweep({ vms: [old("app_s", "0xstuck")], records: [], deleteStatus: 503 });
  assert.deepEqual(r.reaped, [], "not reaped: the instance is still there");
  assert.deepEqual(r.deleted, ["app_s"], "but it was attempted");
});

// The telemetry exists so a stuck sweep is visible WITHOUT shell access, which
// is what the 2026-08-03 recurrence actually cost. Its one job is to not report
// a clean sweep when the leak is still leaking.
test("telemetry: a failed listing reports ok:false, never a clean pass", async () => {
  const r = await sweep({ vms: null, records: [] });
  assert.equal(r.sweep.ok, false);
  assert.match(r.sweep.reason, /listing unavailable/);
  assert.equal(r.sweep.reaped, 0);
});

test("telemetry: an orphan that survives DELETE is NOT ok", async () => {
  const r = await sweep({ vms: [old("app_s", "0xstuck")], records: [], deleteStatus: 503 });
  assert.equal(r.sweep.ok, false, "a surviving orphan must not read as a clean sweep");
  assert.equal(r.sweep.orphans, 1);
  assert.equal(r.sweep.reaped, 0);
  assert.match(r.sweep.reason, /survived DELETE/);
});

test("telemetry: a genuinely clean box reports ok with what it holds", async () => {
  const r = await sweep({
    vms: [old("app_a", "0xaaa")],
    records: [{ id: "0xaaa", status: "running" }],
  });
  assert.equal(r.sweep.ok, true);
  assert.equal(r.sweep.reason, "clean");
  assert.equal(r.sweep.seen, 1);
  assert.deepEqual(r.sweep.held, [{ id: "0xaaa", vm: "app_a", status: "running", owned: true }]);
});

test("telemetry: held[] names the leaking tenant and marks it unowned", async () => {
  const r = await sweep({ vms: [old("app_1", "0xleak")], records: [], deleteStatus: 503 });
  assert.deepEqual(r.sweep.held, [{ id: "0xleak", vm: "app_1", status: "running", owned: false }]);
});

test("mixed box: only the unowned instances go", async () => {
  const r = await sweep({
    vms: [old("app_live", "0xlive"), old("app_orph", "0xorph"), old("app_term", "0xterm")],
    records: [{ id: "0xlive", status: "running" }, { id: "0xterm", status: "expired" }],
  });
  assert.deepEqual(r.reaped.sort(), ["0xorph", "0xterm"]);
  assert.deepEqual(r.deleted.sort(), ["app_orph", "app_term"]);
});
