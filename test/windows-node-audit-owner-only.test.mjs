// windows/node/host.mjs: on an OWNER-ONLY box an admitted capacity-audit job (owned by a keyless fee wallet) is served:
// claimed, kept and spliced. Until the process's first ledger scan has decided, a running audit workload is not swept on
// owner grounds (a node restart must not kill a running job); any other stranger's deployment still is.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_OPERATOR_KEY = "0x" + "7f".repeat(32);
const chain = await import("../windows/node/chain.mjs");
chain.loadOperator();
const { Host } = await import("../windows/node/host.mjs");
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const APP = "catalog://0x962622b0284b438f58ad480b824d4fbf7fa9ce3dc84e2af97b65bd15392a5e6f/0";
const WALLET = "0x14b37ee3c06b047bb3a3f7fe54d29a8e67091428";

function ownerOnlyHost(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-audit-oo-")); dirs.push(dir);
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test", appsEnabled: true, cpuPricePerSec6: 12, engineRetired: true,
    auditAppRefs: APP, ...extra });
  h.servingScope = () => "owner-only";
  return h;
}

test("before the first scan, a running audit workload is not swept; a stranger's other deployment is", () => {
  const h = ownerOnlyHost();
  assert.equal(h.ownerNotServed({ id: "0x" + "01".repeat(32), owner: WALLET, appRef: APP }), false, "audit workload: kept until the scan decides");
  assert.equal(h.ownerNotServed({ id: "0x" + "02".repeat(32), owner: WALLET, appRef: "catalog://0x" + "77".repeat(32) + "/0" }), true);
});

test("with no audit workloads configured, owner-only scope is exactly as before", () => {
  const h = ownerOnlyHost({ auditAppRefs: "" });
  assert.equal(h.ownerNotServed({ id: "0x" + "01".repeat(32), owner: WALLET, appRef: APP }), true);
  assert.equal(h.servesAuditJob({ id: "0x" + "01".repeat(32), appRef: APP }), false);
});
