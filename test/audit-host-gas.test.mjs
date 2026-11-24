// supervisor.js: a capacity audit's job is claimed, renewed and released on the host's own gas where app-funded lease
// gas is configured (metal/audit-host-gas-patch.py). Only a deployment the availability contract says it funded, on this
// host's ledger, within the day's bound; every other deployment keeps the sponsored path and its refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = fs.readFileSync(path.join(ROOT, "supervisor.js"), "utf8");
const between = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); assert.ok(i >= 0 && j > i, a.slice(0, 40)); return SRC.slice(i, j); };
const LEDGER = "0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B";
const id = (n) => "0x" + String(n).padStart(64, "0");

function sandbox({ env = {}, funded = [], ledger = LEDGER, fail = false, active = true } = {}) {
  const reads = [], logs = [];
  const ctx = vm.createContext({ process: { env }, console: { log: (m) => logs.push(m), warn: (m) => logs.push(m) }, Date, Map, Number, Math, String,
    deployments: new Map(), DEPLOYMENTS_ADDRESS: LEDGER, leaseGasActive: () => active, getAddress: (a) => a, chainClient: null });
  vm.runInContext(between("const CAPACITY_AUDIT_CONTRACT =", "function leaseGasError(").replace(/^const /gm, "var "), ctx);
  const read = async (fn, args) => { reads.push(fn); if (fail) throw new Error("rpc down"); return fn === "ledger" ? ledger : funded.includes(args[0]); };
  return { ctx, reads, logs, ask: (x, now = 1_000_000_000) => ctx.auditLeaseOnHostGas(x, { read, now }) };
}

test("a job the availability contract funded is paid by the host; the answer is kept", async () => {
  const s = sandbox({ funded: [id(1)] });
  assert.equal(s.ctx.hostPaidLease(id(1)), false);
  assert.equal(await s.ask(id(1).toUpperCase().replace("0X", "0x")), true);
  assert.equal(s.ctx.hostPaidLease(id(1)), true);
  const n = s.reads.length;
  assert.equal(await s.ask(id(1)), true);
  assert.equal(s.reads.length, n, "a granted lease is not asked again");
  assert.match(s.logs.join("\n"), /capacity audit's job/);
});

test("any other deployment keeps the app-funded path", async () => {
  const s = sandbox({ funded: [id(1)] });
  assert.equal(await s.ask(id(2)), false);
  assert.equal(s.ctx.hostPaidLease(id(2)), false);
  const n = s.reads.length;
  assert.equal(await s.ask(id(2), 1_000_000_000 + 599_000), false);
  assert.equal(s.reads.length, n, "a no is kept ten minutes");
  await s.ask(id(2), 1_000_000_000 + 601_000);
  assert.ok(s.reads.length > n, "then asked again");
  for (const bad of ["", null, "0x12", id(1) + "00"]) assert.equal(await s.ask(bad), false);
});

test("an unreadable answer, another ledger, no contract or no lease gas: not granted", async () => {
  let s = sandbox({ funded: [id(1)], fail: true });
  assert.equal(await s.ask(id(1)), false);
  assert.match(s.logs.join("\n"), /not taken for an audit job: rpc down/);
  s = sandbox({ funded: [id(1)], ledger: "0x" + "11".repeat(20) });
  assert.equal(await s.ask(id(1)), false);
  s = sandbox({ funded: [id(1)], env: { CAPACITY_AUDIT_CONTRACT: "" } });
  assert.equal(await s.ask(id(1)), false);
  assert.equal(s.reads.length, 0);
  s = sandbox({ funded: [id(1)], active: false });
  assert.equal(await s.ctx.auditLeaseOnHostGas(id(1), { read: async () => { throw new Error("must not read"); }, active: false }), false);
});

test("the host pays for a bounded number of audit leases a day", async () => {
  const s = sandbox({ funded: [1, 2, 3, 4, 5, 6].map(id), env: { CAPACITY_AUDIT_HOST_PAID_PER_DAY: "2" } });
  assert.equal(await s.ask(id(1)), true);
  assert.equal(await s.ask(id(2)), true);
  assert.equal(await s.ask(id(3)), false);
  assert.match(s.logs.join("\n"), /already paid by this host in 24 h \(bound 2\)/);
  const day = 86_400_000;
  s.ctx.deployments.set(id(1), {});                         // still running here: its grant is kept, and counts no more
  assert.equal(await s.ask(id(4), 1_000_000_000 + day + 1), true);
  assert.equal(s.ctx.hostPaidLease(id(1)), true);
  assert.equal(s.ctx.hostPaidLease(id(2)), false, "a finished job's grant is dropped after a day");
});

test("the wiring: claim, renew and release of an audit job take the operator-paid path, and only they", () => {
  assert.match(SRC, /if \(!leaseGasActive\(\) \|\| hostPaidLease\(args\[0\]\)\) return sendClaimTx\(/);
  assert.match(SRC, /await auditLeaseOnHostGas\(d\.id\);\n  let rcpt;\n  try \{\n    const sent = sendLeaseTx\("claim"/);
  assert.match(SRC, /const hostPaid = await auditLeaseOnHostGas\(rec\.id\);[^\n]*\n    if \(leaseGasActive\(\) && !hostPaid && !lapsed/);
  assert.match(SRC, /await auditLeaseOnHostGas\(rec\.id\);\n\s+const sent = sendLeaseTx\("claim", \[rec\.id, _enclaveId\]/);
  assert.match(SRC, /if \(await auditLeaseOnHostGas\(id\)\) it\.hostPaid = true;/);
  assert.match(SRC, /if \(leaseGasActive\(\) && !it\.hostPaid\) return sponsoredRelease\(it\);/);
  assert.equal(SRC.split("sendLeaseTx(\"").length - 1, 4, "every lease write is at one of the three sites above (the renew site has two)");
});

test("the patch refuses a supervisor it does not fit, and one it already changed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-gas-"));
  const f = path.join(dir, "supervisor.js"), script = path.join(ROOT, "metal/audit-host-gas-patch.py");
  const run = () => { try { execFileSync("python3", ["-I", script, f], { stdio: "pipe" }); return ""; } catch (e) { return String(e.stderr); } };
  fs.writeFileSync(f, SRC);
  assert.match(run(), /already pays an audit job's lease gas/);
  fs.writeFileSync(f, "const x = 1;\n");
  assert.match(run(), /anchor not found exactly once/);
  assert.equal(fs.readFileSync(f, "utf8"), "const x = 1;\n");
  fs.rmSync(dir, { recursive: true });
});
