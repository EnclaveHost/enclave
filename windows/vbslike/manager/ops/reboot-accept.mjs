// reboot-accept.mjs - recovery after a HOST reboot (enclave-d1's READINESS.md U4), on the REAL manager and the REAL
// Hyper-V. This is NOT a manager restart (restart-accept.mjs A3-A7 kills only the manager): the whole host goes down while
// the manager serves, and the manager comes back on a fresh boot. FUNCTIONAL only: the package's pinned hello-world as
// lab deployments; no probe, no customer app; host_excluded=no.
//
// reboot-accept.ps1 owns everything around it (the run lock, the temporary firmware setting and 9001 key, the one-shot
// boot restore task, the reboot itself) and runs this driver in one of three modes:
//   arm      R0 a clean start; R1 two lab deployments POSTed; R2 both running on distinct VMs with distinct launcher and
//            transport keys, each answering the pinned bytes through the data plane on exactly the key the manager
//            verified. The state is written to <state.json>, and the manager is LEFT RUNNING (detached) so that the host
//            goes down with it serving.
//   recheck  after the wrapper has restored the setting and the 9001 key: both still answer (a running partition needs
//            neither), from the state file.
//   verify   after the reboot, with the setting at its prior state:
//            V0 the manager's environment carries no respawn and no attach switch;
//            V1 the manager recovers EXACTLY the armed ids, HELD: recovered:true, never running, no relay, no new VM;
//            V2 nothing comes back by itself: the VMs stay Off, and no launcher (vbslike-host) runs;
//            V3 the liveness sweep fails each as Off and LEAVES its VM (for the node to retire), with no restart;
//            V4 the old routes are refused by the data plane, and the old relay ports refuse;
//            V5 cleanup: DELETE both, and no manager-owned VM remains.
// Last line: REBOOT-ACCEPT <MODE> ALL PASS | REBOOT-ACCEPT <MODE> <n> FAILED | REBOOT-ACCEPT <MODE> REFUSED <why>.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call, tcpAccepts } from "./restart-accept.mjs";
import { deploymentOf, viaDataPlane } from "./multi-accept.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const routeOf = (v) => ({ id: v.id, app: v.appId, image: v.image, runtime: v.runtimeId, key: v.transportKeySha256 });
// the lab deployments: multi-accept's deploymentOf (distinct small policies, so distinct AppIDs), renamed with first bytes
// 0xb0 and 0xb1, apart from multi-accept's 0xa0-0xa2 (deploymentOf itself sets the first byte to 0xa0+i)
export const armDeployments = (spawnBody, name) => [0, 1].map((i) => ({ ...deploymentOf(spawnBody, name, i, 128), name: "0x" + (0xb0 + i).toString(16) + String(name).slice(4) }));
// no respawn and no attach switch may be in the manager's environment: the defaults keep both OFF
export const SWITCHES = /^(ENCLAVE_ISOLATION_RESPAWN|RELAY_HVNODE_ATTACH|ENCLAVE_ENGINE)$/;

async function inventoryReady(base, waitMs) {
  const until = Date.now() + waitMs; let last = "no answer";
  while (Date.now() < until) {
    try { const r = await call(base, "GET", "/vms", null, 10_000); if (r.status === 200) return r.body; last = `${r.status} ${r.text.slice(0, 120)}`; }
    catch (e) { last = e.message; }
    await sleep(1000);
  }
  throw new Error(`the manager's inventory was not ready within ${waitMs} ms: ${last}`);
}

/**
 * ctl: { startManager({ detached }) -> base, env() -> the manager's env, killManager(), survey(), parseNotes, launchers() -> count }
 */
export async function runArm({ ctl, spawnBody, name, dataPort, expectBodySha256, statePath, say = console.log, readyWaitMs = 300_000 }) {
  let failed = 0;
  const rec = (id, ok, detail) => { if (!ok) failed++; say(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`); return ok; };
  const owned = (s) => (s.vms || []).filter((v) => ctl.parseNotes(v.notes).owned);
  const mineIn = (s, id) => (s.vms || []).filter((v) => { const p = ctl.parseNotes(v.notes); return p.identity && p.identity.id === id; });
  const o0 = owned(await ctl.survey());
  if (o0.length) { say(`REBOOT-ACCEPT ARM REFUSED: ${o0.length} manager-owned VM(s) exist before this run`); return { ok: false, refused: true }; }
  const base = await ctl.startManager({ detached: true });
  const inv0 = await inventoryReady(base, 240_000);
  if ((inv0.vms || []).length) { say(`REBOOT-ACCEPT ARM REFUSED: the manager holds ${(inv0.vms || []).length} instance(s) before this run`); await ctl.killManager(); return { ok: false, refused: true }; }
  rec("R0", true, "inventory ready and empty; no manager-owned VM");
  const deps = armDeployments(spawnBody, name);
  const ids = [];
  for (const d of deps) { const r = await call(base, "POST", "/vms", d); if (r.body && r.body.id) ids.push(r.body.id); say(`R1: POST ${d.name.slice(0, 10)}… -> ${r.status} ${r.body && r.body.id}`); }
  if (!rec("R1", ids.length === 2 && new Set(ids).size === 2, `2 lab deployments created: ${ids.join(", ")}`)) {
    for (const id of ids) { try { await call(base, "DELETE", `/vms/${encodeURIComponent(id)}`, null, 120_000); } catch {} }
    await ctl.killManager(); say(`REBOOT-ACCEPT ARM ${failed} FAILED`); return { ok: false };
  }
  const views = new Map(); const until = Date.now() + readyWaitMs;
  while (Date.now() < until && views.size < 2) {
    for (const id of ids) if (!views.has(id)) { const v = (await call(base, "GET", `/vms/${encodeURIComponent(id)}`)).body; if (v && (v.status === "running" || v.status === "failed")) views.set(id, v); }
    if (views.size < 2) await sleep(2000);
  }
  const vs = ids.map((id) => views.get(id) || { id, status: "not settled" });
  const s2 = await ctl.survey(); const vms = ids.map((id) => mineIn(s2, id));
  const ok2 = vs.every((v) => v.status === "running") && vms.every((x) => x.length === 1 && x[0].state === "Running")
    && new Set(vms.map((x) => x[0] && x[0].vmId)).size === 2 && new Set(vs.map((v) => v.launcherKey)).size === 2
    && new Set(vs.map((v) => v.transportKeySha256)).size === 2 && vs.every((v) => v.relay && v.relay.port);
  const answered = [];
  if (vs.every((v) => v.status === "running")) for (let i = 0; i < 2; i++) answered.push(await viaDataPlane(dataPort, routeOf(vs[i]), { tlsFor: deps[i].name }));
  const serves = answered.length === 2 && answered.every((r, i) => r.ok && r.key === vs[i].transportKeySha256 && r.status === 200 && (!expectBodySha256 || r.bodySha256 === expectBodySha256));
  rec("R2", ok2 && serves, vs.map((v, i) => `${v.id}: ${v.status}, VM ${vms[i].map((x) => `${x.vmId} ${x.state}`).join("|") || "none"}, relay ${v.relay && v.relay.port}, `
    + `key ${String(v.transportKeySha256).slice(0, 16)}, answer ${answered[i] ? `${answered[i].line} ${answered[i].status} key ${String(answered[i].key).slice(0, 16)} body ${String(answered[i].bodySha256).slice(0, 8)}` : "not asked"}`).join("; "));
  const state = { armedAt: new Date().toISOString(), base, dataPort, managerPid: ctl.pid(), expectBodySha256,
    deployments: vs.map((v, i) => ({ id: v.id, name: deps[i].name, vmId: vms[i][0] && vms[i][0].vmId, route: routeOf(v), relayPort: v.relay && v.relay.port,
                                     launcherKey: v.launcherKey, transportKeySha256: v.transportKeySha256, appId: v.appId })) };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
  say(`state written: ${statePath}`);
  if (failed) {   // an arm that did not serve is not rebooted: the wrapper cleans up
    for (const id of ids) { try { const r = await call(base, "DELETE", `/vms/${encodeURIComponent(id)}`, null, 120_000); say(`cleanup: DELETE ${id} -> ${r.status}`); } catch {} }
    await ctl.killManager();
  } else say(`the manager (pid ${state.managerPid}) is LEFT RUNNING with both domains serving: the host is to go down with it`);
  say(failed ? `REBOOT-ACCEPT ARM ${failed} FAILED` : "REBOOT-ACCEPT ARM ALL PASS");
  return { ok: failed === 0, state };
}

export async function runRecheck({ state, say = console.log }) {
  let failed = 0;
  const out = [];
  for (const d of state.deployments) {
    const r = await viaDataPlane(state.dataPort, d.route, { tlsFor: d.name });
    const ok = r.ok && r.key === d.transportKeySha256 && r.status === 200 && (!state.expectBodySha256 || r.bodySha256 === state.expectBodySha256);
    if (!ok) failed++;
    out.push(`${d.id}: ${r.line} ${r.status ?? ""} key ${String(r.key).slice(0, 16)}${r.error ? ` (${r.error})` : ""}`);
  }
  say(`${failed ? "FAIL" : "PASS"} RC: after the setting and the 9001 key were restored, both armed domains still answer: ${out.join("; ")}`);
  say(failed ? `REBOOT-ACCEPT RECHECK ${failed} FAILED` : "REBOOT-ACCEPT RECHECK ALL PASS");
  return { ok: failed === 0 };
}

export async function runVerify({ ctl, state, say = console.log, sweepWaitMs = 60_000 }) {
  let failed = 0;
  const rec = (id, ok, detail) => { if (!ok) failed++; say(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`); return ok; };
  const owned = (s) => (s.vms || []).filter((v) => ctl.parseNotes(v.notes).owned);
  const armed = state.deployments.map((d) => d.id);
  const offNow = async (label) => {
    const s = owned(await ctl.survey());
    const byId = new Map(s.map((v) => [ctl.parseNotes(v.notes).identity?.id, v]));
    const launchers = await ctl.launchers();
    const ok = s.length === 2 && armed.every((id) => byId.get(id) && byId.get(id).state === "Off") && launchers === 0;
    return { ok, detail: `${label}: ${s.map((v) => `${v.name} ${v.state}`).join(", ") || "no owned VM"}; vbslike-host processes ${launchers}` };
  };
  try {
    const env = ctl.env();
    const sw = Object.keys(env).filter((k) => SWITCHES.test(k));
    rec("V0", sw.length === 0, sw.length ? `the manager's env carries ${sw.join(", ")}` : "the manager's env carries no respawn, attach or engine switch (defaults: OFF)");
    const pre = await offNow("before the manager starts");
    rec("V2a", pre.ok, pre.detail);
    const base = await ctl.startManager({ detached: false });
    const inv = await inventoryReady(base, 240_000);
    const invIds = (inv.vms || []).map((v) => v.id).sort();
    const views = await Promise.all(armed.map(async (id) => (await call(base, "GET", `/vms/${encodeURIComponent(id)}`)).body));
    rec("V1", JSON.stringify(invIds) === JSON.stringify([...armed].sort())
      && views.every((v) => v && v.recovered === true && v.status !== "running" && !v.relay && !v.appReady),
      `inventory ${invIds.join(", ") || "empty"}; ${views.map((v) => v ? `${v.id}: recovered ${v.recovered}, status ${v.status}, relay ${JSON.stringify(v.relay ?? null)}, appReady ${v.appReady}` : "missing").join("; ")}`);
    // the liveness sweep: each is failed as Off, and its VM is left in place (the node retires it), never restarted
    const until = Date.now() + sweepWaitMs; let last = views;
    while (Date.now() < until) {
      last = await Promise.all(armed.map(async (id) => (await call(base, "GET", `/vms/${encodeURIComponent(id)}`)).body));
      if (last.every((v) => v && v.status === "failed")) break;
      await sleep(2000);
    }
    const mid = await offNow("after the liveness sweep");
    rec("V3", last.every((v) => v && v.status === "failed" && /Off/.test(String(v.reason || ""))) && mid.ok,
      `${last.map((v) => v ? `${v.id}: ${v.status} (${String(v.reason || "").slice(0, 110)})` : "missing").join("; ")}; ${mid.detail}`);
    rec("V2b", mid.ok, `nothing came back by itself after the sweep: ${mid.detail}`);
    const refusals = [];
    for (const d of state.deployments) {
      const r = await viaDataPlane(state.dataPort, d.route);
      const port = d.relayPort ? await tcpAccepts(d.relayPort) : false;
      refusals.push({ id: d.id, line: r.line, refused: r.ok === false && /^NO /.test(r.line), port: d.relayPort, portAccepts: port });
    }
    rec("V4", refusals.every((x) => x.refused && !x.portAccepts),
      refusals.map((x) => `${x.id}: old route "${x.line}", old relay port ${x.port} ${x.portAccepts ? "ACCEPTS" : "refuses"}`).join("; "));
  } catch (e) {
    failed++; say(`FAIL error: ${e.message}`);
  } finally {
    // V5 cleanup: retire both through the manager (it removes the VMs and archives their guest state)
    const dels = [];
    for (const id of armed) {
      try { const r = await call(ctl.base(), "DELETE", `/vms/${encodeURIComponent(id)}`, null, 180_000); dels.push(`${id} -> ${r.status}`); }
      catch (e) { dels.push(`${id} -> ${e.message}`); }
    }
    const left = owned(await ctl.survey());
    rec("V5", left.length === 0, `DELETE ${dels.join(", ")}; manager-owned VMs left ${left.length}`);
    try { await ctl.killManager(); } catch {}
  }
  say(failed ? `REBOOT-ACCEPT VERIFY ${failed} FAILED` : "REBOOT-ACCEPT VERIFY ALL PASS");
  return { ok: failed === 0 };
}

/* ---- the command line: node reboot-accept.mjs <cfg.json> <arm|recheck|verify> <state.json> ---------------------- */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cfgPath, mode, statePath] = process.argv.slice(2);
  if (!["arm", "recheck", "verify"].includes(mode) || !cfgPath || !statePath) { console.log("REBOOT-ACCEPT REFUSED: usage <cfg.json> <arm|recheck|verify> <state.json>"); process.exit(3); }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8").replace(/^﻿/, ""));
  if (!cfg.wmiserveExe || !cfg.dataPort) { console.log("REBOOT-ACCEPT REFUSED: serving (wmiserve) and a data-plane port are required"); process.exit(3); }
  const tree = cfg.tree;
  const { WmiHyperVLauncher, parseNotes } = await import(pathToFileURL(path.join(tree, "windows/vbslike/manager/wmi-launcher.mjs")).href);
  const { powershellRunner } = await import(pathToFileURL(path.join(tree, "windows/vbslike/manager/psrun.mjs")).href);
  const surveyor = new WmiHyperVLauncher({ run: powershellRunner({ timeoutMs: 120_000 }), imagePath: cfg.igvm, imageSha256: cfg.igvmSha256 });
  const base = `http://127.0.0.1:${cfg.port}`;
  const env = () => ({ ...process.env, VMMGR_PORT: String(cfg.port), ENCLAVE_GUEST_IGVM: cfg.igvm, ENCLAVE_GUEST_IGVM_SHA256: cfg.igvmSha256,
    ENCLAVE_BOOT_FORM: "linux-direct", ENCLAVE_GUEST_STATE_MASTER: cfg.gsMaster, ENCLAVE_GUEST_STATE_MASTER_SHA256: cfg.gsMasterSha256,
    ENCLAVE_GUEST_STATE_ARCHIVE_DIR: cfg.archiveDir, ENCLAVE_HYPERV_MODULE: cfg.hypervModule,
    ENCLAVE_RUNTIME_IDENTITY: cfg.runtimeIdentity, PYTHON_BIN: cfg.python, IPFS_GATEWAY: cfg.gateway,
    PYTHONPATH: path.join(tree, "wasm"), ENCLAVE_LIVENESS_MS: String(cfg.livenessMs || 5000), ENCLAVE_ANSWER_CHECK_MS: String(cfg.answerCheckMs || 5000),
    ENCLAVE_WMISERVE_EXE: cfg.wmiserveExe, ENCLAVE_WMISERVE_EXE_SHA256: cfg.wmiserveSha256, ENCLAVE_BUNDLE_DIR: cfg.bundleDir,
    ENCLAVE_DATAPLANE_PORT: String(cfg.dataPort) });
  let child = null;
  const ctl = {
    parseNotes, env, base: () => base, pid: () => child && child.pid,
    survey: () => surveyor.survey(),
    async launchers() {
      const r = await powershellRunner({ timeoutMs: 60_000 })("@(Get-Process -Name vbslike-host -EA SilentlyContinue).Count");
      return Number(String(r.stdout || "").trim()) || 0;
    },
    async startManager({ detached = false } = {}) {
      const log = fs.openSync(path.join(cfg.logDir, `manager-${mode}.log`), "a");
      child = spawn(process.execPath, [path.join(tree, "windows/vbslike/manager/main.mjs")], { stdio: ["ignore", log, log], windowsHide: true, detached, env: env() });
      if (detached) child.unref();
      console.log(`manager (${mode}) pid ${child.pid}${detached ? " (detached: it outlives this driver)" : ""}`);
      return base;
    },
    async killManager() {
      if (!child || child.exitCode !== null) return;
      const c = child; const gone = new Promise((r) => c.once("exit", r));
      c.kill("SIGKILL");
      await Promise.race([gone, sleep(15_000)]);
    },
  };
  const spawnBody = JSON.parse(fs.readFileSync(cfg.spawnJson, "utf8").replace(/^﻿/, ""));
  delete spawnBody.id;
  // the answer the PACKAGE pins for this app (its MANIFEST.json apps[].expect, beside the spawn.json it serves): the same
  // lookup as multi-accept.mjs, so R2 and RC check the exact bytes and not only a 200
  let expectBodySha256 = null;
  try {
    const pkgDir = path.dirname(path.dirname(path.dirname(cfg.spawnJson)));
    const man = JSON.parse(fs.readFileSync(path.join(pkgDir, "MANIFEST.json"), "utf8").replace(/^\uFEFF/, ""));
    const rel = path.relative(pkgDir, path.dirname(cfg.spawnJson)).split(path.sep).join("/");
    const app = (man.apps || []).find((x) => x.dir === rel);
    if (app && app.expect && /^[0-9a-f]{64}$/.test(String(app.expect.bodySha256))) expectBodySha256 = app.expect.bodySha256;
  } catch { /* stays null: the checks then compare the status and the key only, and say so */ }
  console.log(`REBOOT-ACCEPT ${mode.toUpperCase()}: liveness ${cfg.livenessMs || 5000} ms, answer check ${cfg.answerCheckMs || 5000} ms; `
    + `pinned body ${expectBodySha256 || "(none found: 200 and the verified key only)"}. Functional recovery only; host_excluded=no.`);
  let r;
  if (mode === "arm") r = await runArm({ ctl, spawnBody, name: cfg.name, dataPort: Number(cfg.dataPort), expectBodySha256, statePath });
  else {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    r = mode === "recheck" ? await runRecheck({ state }) : await runVerify({ ctl, state, sweepWaitMs: Math.max(60_000, 4 * Number(cfg.livenessMs || 5000)) });
  }
  process.exitCode = r.refused ? 3 : r.ok ? 0 : 1;
}
