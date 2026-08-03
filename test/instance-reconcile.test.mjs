// Instance reconciliation (supervisor.js) — the records are the truth, the
// BACKEND's instances are a cache: orphanInstancePlan() names every instance
// the manager is still running that no live record owns, so the instance
// reconciler can tear it down. Driven through the INSTANCE_SELFTEST seam, same
// contract as POOL_SELFTEST/YANK_SELFTEST.
//
// Why this exists (2026-08-03, kryptos): an owner's setActive(false) released
// the lease on-chain and dropped the local record, but the DELETE to the
// wasm-manager never landed. stopContainer returns false in exactly that case
// and twelve of its thirteen callers discard the boolean — they must, because
// the on-chain release has to happen either way — so the manager kept the
// tenant "running": 4% of the share pool and 17.6 GB of resident ggml weights,
// 35% of the node's sellable RAM, held against a deployment that no longer
// existed. Neither side could see it: the supervisor had no record, and the
// manager has no owner-liveness check. Only a manager restart would have
// cleared it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

const NOW = 1_800_000_000_000;                 // fixed clock; ages are computed against it
const secsAgo = (s) => (NOW - s * 1000) / 1000; // backend createdAt is unix SECONDS

async function plan(c) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret",
           INSTANCE_SELFTEST: JSON.stringify({ nowMs: NOW, minAgeSec: 120, ...c }),
           POOL_SELFTEST: "", SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "",
           ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
           ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const vm = (id, name, ageSec = 3600) => ({ id, name, createdAt: secsAgo(ageSec), status: "running" });

test("the kryptos leak: an instance whose record is gone is reaped", async () => {
  // exactly the live state — the manager still runs it, the supervisor has
  // dropped the record entirely (setActive(false) -> teardown + release)
  const p = await plan({
    instances: [vm("app_1a2b3c4d5", "0x5c2dcc4b6e")],
    records: [],
  });
  assert.deepEqual(p, [{ vmId: "app_1a2b3c4d5", id: "0x5c2dcc4b6e" }]);
});

test("a terminal record owns nothing: its instance is an orphan too", async () => {
  // the other half of the same leak — the record survives but went terminal,
  // which releases its slice synchronously (TERMINAL_STATUSES). An instance
  // still running for it is drift by definition.
  for (const status of ["expired", "failed", "terminated", "stopping"]) {
    const p = await plan({
      instances: [vm("app_x", "0xdead")],
      records: [{ id: "0xdead", status }],
    });
    assert.deepEqual(p.map((o) => o.id), ["0xdead"], `status=${status}`);
  }
});

test("live tenants are never touched", async () => {
  const p = await plan({
    instances: [vm("app_a", "0xaaa"), vm("app_b", "0xbbb"), vm("app_c", "0xccc")],
    records: [
      { id: "0xaaa", status: "running" },
      { id: "0xbbb", status: "claimed" },
      { id: "0xccc", status: "provisioning" },
    ],
  });
  assert.deepEqual(p, []);
});

test("the provisioning race: ownership keys on the deployment id, not the vid", async () => {
  // rec._vmId is only assigned AFTER spawnContainer returns, but the record
  // exists from reservation. Matching on the manager's random vid would call
  // every in-flight launch an orphan; matching on `name` (the deployment id)
  // is what makes the sweep safe to run against a live box.
  const p = await plan({
    instances: [{ id: "app_justborn", name: "0xnew", createdAt: secsAgo(0), status: "starting" }],
    records: [{ id: "0xnew", status: "running" }],   // no _vmId yet
  });
  assert.deepEqual(p, []);
});

test("young instances get a grace window even with no record at all", async () => {
  const young = await plan({
    instances: [vm("app_y", "0xyoung", 30)],       // 30s old, min age 120s
    records: [],
  });
  assert.deepEqual(young, [], "inside the window: left alone");

  const aged = await plan({
    instances: [vm("app_y", "0xyoung", 300)],
    records: [],
  });
  assert.deepEqual(aged.map((o) => o.id), ["0xyoung"], "past the window: reaped");
});

test("an instance with no usable createdAt is still reapable", async () => {
  // a manager predating the field, or one that reports it unparseably: age is
  // unknowable, and unknowable means old — it cannot be a launch we just made,
  // because those are owned by an existing record (see the race test above).
  for (const createdAt of [undefined, null, 0, "nonsense"]) {
    const p = await plan({
      instances: [{ id: "app_o", name: "0xold", createdAt, status: "running" }],
      records: [],
    });
    assert.deepEqual(p.map((o) => o.id), ["0xold"], `createdAt=${JSON.stringify(createdAt)}`);
  }
});

test("worker backend: tenants are keyed by the deployment id itself", async () => {
  // worker.py keys _tenants by the deployment id and _pub echoes it as `id`
  // with no `name`, so the plan falls back to `id` for both roles
  const p = await plan({
    instances: [{ id: "0xworker-orphan", createdAt: secsAgo(600), status: "running" },
                { id: "0xworker-live", createdAt: secsAgo(600), status: "running" }],
    records: [{ id: "0xworker-live", status: "running" }],
  });
  assert.deepEqual(p, [{ vmId: "0xworker-orphan", id: "0xworker-orphan" }]);
});

test("the plan is idempotent and order-independent", async () => {
  const scenario = {
    instances: [vm("app_1", "0xkeep"), vm("app_2", "0xdrop"), vm("app_3", "0xalso-drop")],
    records: [{ id: "0xkeep", status: "running" }, { id: "0xdrop", status: "expired" }],
  };
  const a = await plan(scenario);
  const b = await plan(scenario);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((o) => o.id).sort(), ["0xalso-drop", "0xdrop"]);
});

test("malformed entries are skipped, not crashed on", async () => {
  const p = await plan({
    instances: [null, {}, { name: "0xnoid" }, { id: "", name: "0xempty" }, vm("app_ok", "0xreal")],
    records: [],
  });
  assert.deepEqual(p.map((o) => o.id), ["0xreal"]);
});
