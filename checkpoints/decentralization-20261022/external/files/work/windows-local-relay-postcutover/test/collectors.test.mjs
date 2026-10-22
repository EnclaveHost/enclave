// The collectors' plumbing, LOCALLY (no remote host is contacted): collect-source.sh runs its exact remote script under a mock
// ssh with mock systemctl/pgrep/ss/curl; collect-minipc.sh's generated PowerShell is checked statically (80 control paths,
// no "$name:" interpolation, single-line statements) and its JSON extraction end to end. The collected documents then go
// through accept.mjs with the pinned expectations.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluate } from "../accept.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url)), DIR = path.resolve(HERE, "..");
const expect = JSON.parse(fs.readFileSync(path.join(DIR, "expectations.json"), "utf8"));
const PATHENV = `${path.join(HERE, "mock")}:${process.env.PATH}`;

function source(env) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "src-collect-")), link = path.join(t, "unit.service"), mig = path.join(t, "mig");
  fs.mkdirSync(mig); fs.symlinkSync("/dev/null", link);
  fs.writeFileSync(path.join(mig, "stop-receipt.json"), JSON.stringify({ stoppedAt: "2026-10-21T08:40:00Z", unit: "enclave-lease-relay.service", masked: true, keyMoved: false, stateSha256: "ab".repeat(32) }) + "\n");
  const r = spawnSync("bash", [path.join(DIR, "collect-source.sh"), "us-west"], { encoding: "utf8", env: { PATH: PATHENV, SOURCE_UNIT_PATH: link, SOURCE_MIG: mig,
    MOCK_ActiveState: "inactive", MOCK_LoadState: "masked", MOCK_UnitFileState: "masked", ...env } });
  fs.rmSync(t, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim());
}

test("collect-source.sh: masked, inactive, silent -> the facts accept.mjs needs; each live sign is reported", () => {
  const s = source({});
  assert.deepEqual([s.activeState, s.loadState, s.unitFileState, s.unitPathLink, s.relayProcesses, s.listeners8549, s.localAnswersAsPayee, s.frontAnswersAsPayee],
    ["inactive", "masked", "masked", "/dev/null", 0, 0, false, false]);
  assert.equal(s.stopReceipt.masked, true);
  const live = source({ MOCK_ActiveState: "active", MOCK_PROCS: "1", MOCK_LISTEN: "1", MOCK_FRONT_ANSWERS: "1", MOCK_LOCAL_ANSWERS: "1" });
  assert.deepEqual([live.activeState, live.relayProcesses, live.listeners8549, live.localAnswersAsPayee, live.frontAnswersAsPayee], ["active", 1, 1, true, true]);
});

test("collect-minipc.sh: the generated PowerShell covers all 80 control files with single-line statements; the JSON line is extracted", () => {
  const ps = spawnSync("bash", [path.join(DIR, "collect-minipc.sh"), "--print-script"], { encoding: "utf8" }).stdout;
  const lines = ps.trim().split("\n");
  for (const p of Object.keys(expect.control)) assert.ok(lines.some((l) => l.startsWith(`$ctl['${p}']=`)), p);
  assert.deepEqual([...ps.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*):/g)].map((m) => m[1]).filter((n) => n !== "env"), [], "no $name: interpolation");
  assert.ok(lines.every((l) => !/^\s/.test(l)), "one statement per line (powershell -Command - reads line by line)");
  assert.match(ps, /\[relay\\\] \(success\|reverted\) \(0x\[0-9a-fA-F\]\{64\}\)/, "the relay log is reduced to status + tx hash");
  assert.doesNotMatch(ps, /relay\.key/, "the key is never named, let alone read");
  const cap = path.join(os.tmpdir(), `ps-cap-${process.pid}.txt`), doc = { at: "2026-10-21T09:30:00Z", vms: [] };
  const r = spawnSync("bash", [path.join(DIR, "collect-minipc.sh"), "minipc"], { encoding: "utf8", env: { PATH: PATHENV, MOCK_PS_CAPTURE: cap, MOCK_MINIPC_JSON: JSON.stringify(doc) } });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout.trim()), doc, "only the COLLECT-JSON line, CR stripped");
  assert.equal(fs.readFileSync(cap, "utf8").trim(), ps.trim(), "exactly the generated script went to PowerShell"); fs.rmSync(cap);
});

test("end to end through accept.mjs: collected source facts + a healthy minipc document + a verified chain audit = ACCEPTED; a live source FAILS", () => {
  const cut = { cutoverBlock: 5, activatedAt: new Date(Date.now() - 3600_000).toISOString() };
  const minipc = { at: new Date().toISOString(), vms: expect.vms.map((id) => ({ id, status: "running" })), agents: [{ pid: 1 }], loops: [{ pid: 2, created: new Date().toISOString() }], healthy: true,
    leaseMode: "app-funded", operator: expect.operator, control: { ...expect.control }, settings: { ...expect.settings }, settingsCalled: true, tasks: { Relay: "Running" },
    relayProcesses: 1, relayListeners: 1, relayInfo: { payee: expect.relay.payee, chainId: 8453, reserve: expect.relay.reserve, executor: expect.relay.executor } };
  const chain = { at: new Date().toISOString(), status: "LOCAL_VERIFIED", window: { fromBlock: "5" }, counts: { moved: 1, fallback: 0, failed: 0 } };
  const src = source({}); src.at = new Date().toISOString();
  const r = evaluate({ expect, cutover: cut, minipc, source: src, chain });
  assert.equal(r.status, "ACCEPTED", JSON.stringify(r.checks.filter((c) => c.state !== "pass")));
  const live = source({ MOCK_FRONT_ANSWERS: "1" }); live.at = new Date().toISOString();
  assert.equal(evaluate({ expect, cutover: cut, minipc, source: live, chain }).status, "FAILED");
});
