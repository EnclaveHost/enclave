// restart-accept.mjs - the manager's restart-safety rules (53672cbe, 6b1137ee, 8aac6cb4), on the REAL manager process
// and the REAL Hyper-V, for ONE domain this run creates:
//   A0 a clean start: the inventory is ready and holds nothing, and Hyper-V has no manager-owned VM
//   A1 POST /vms spawns: 201, an "hv"+32-hex id, status `starting`, the linux-direct partition name, hostExcluded false
//   A2 Hyper-V has exactly ONE VM carrying this id in its Notes identity, Running
//   A3 the manager process is KILLED (no graceful path): the VM is still Running - VMs outlive the manager
//   A4 a new manager recovers it: 200, recovered:true, status `starting` (never failed, never running), no relay
//   A5 a second POST for the same deployment is 409 naming the recovered id, and no second VM appears
//   A6 DELETE removes it: 200, no VM carries the id, and GET answers 404
//   A7 "the relay dies with the manager": N/A until a per-domain wmiserve relay exists (enclave-5d's wmiserve-run.mjs)
// Last line: RESTART-ACCEPT ALL PASS | RESTART-ACCEPT <n> FAILED | RESTART-ACCEPT REFUSED <why>. An N/A is never a PASS.
// It must run under manager-accept.ps1 (the run lock, the watchdog, the temporary firmware opt-in and its restore).
// Nothing here is an isolation result: host_excluded=no throughout.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One request on a FRESH connection (agent:false): a pooled keep-alive socket across a manager restart is a race. */
export function call(base, method, p, body = null, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, agent: false, timeout: timeoutMs,
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const t = Buffer.concat(chunks).toString("utf8"); let j = null; try { j = JSON.parse(t); } catch {}
        resolve({ status: res.statusCode, body: j, text: t }); });
    });
    req.on("timeout", () => req.destroy(new Error(`${method} ${p} timed out`)));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Wait until /vms answers (not 503, not a refused connection): the inventory is known. */
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
 * ctl: { startManager() -> base URL, killManager(), survey() -> {vms:[{vmId,name,state,notes}]}, parseNotes }
 * spawnBody: the POST body's derive (and flags); name: the deployment label this run owns.
 */
export async function runRestartAccept({ ctl, spawnBody, name, say = console.log, readyWaitMs = 240_000, expectPartition = "wmi-openhcl-gen2-igvm-linux" }) {
  let failed = 0; const na = [];
  const rec = (id, ok, detail) => { if (!ok) failed++; say(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`); return ok; };
  const mineIn = (s, id) => (s.vms || []).filter((v) => { const n = ctl.parseNotes(v.notes); return n.identity && n.identity.id === id; });
  let base = await ctl.startManager();
  let id = null;
  try {
    const inv0 = await inventoryReady(base, readyWaitMs);
    const s0 = await ctl.survey();
    const owned0 = (s0.vms || []).filter((v) => ctl.parseNotes(v.notes).owned);
    if ((inv0.vms || []).length || owned0.length) {
      say(`RESTART-ACCEPT REFUSED: the manager holds ${(inv0.vms || []).length} instance(s) and Hyper-V ${owned0.length} manager-owned VM(s) before this run: it touches only what it creates`);
      return { ok: false, refused: true };
    }
    rec("A0", true, "inventory ready and empty; no manager-owned VM on this host");

    const t0 = Date.now();
    const r1 = await call(base, "POST", "/vms", { ...spawnBody, name });
    id = r1.body && r1.body.id;
    const g1 = id ? await call(base, "GET", `/vms/${encodeURIComponent(id)}`) : null;
    const v1 = g1 && g1.body;
    rec("A1", r1.status === 201 && /^hv[0-9a-f]{32}$/.test(String(id)) && v1 && v1.status === "starting"
      && v1.boundary && v1.boundary.partition === expectPartition && v1.hostExcluded === false,
      `POST ${r1.status} in ${Date.now() - t0} ms, id ${id}, status ${v1 && v1.status}, partition ${v1 && v1.boundary && v1.boundary.partition}, hostExcluded ${v1 && v1.hostExcluded}`
      + (r1.status !== 201 ? `, error ${r1.text.slice(0, 300)}` : ""));
    if (!id) throw new Error("no instance was created; the remaining checks cannot run");

    const m2 = mineIn(await ctl.survey(), id);
    rec("A2", m2.length === 1 && m2[0].state === "Running", `${m2.length} VM(s) carry id ${id}: ${m2.map((v) => `${v.name} ${v.vmId} ${v.state}`).join("; ")}`);

    await ctl.killManager();
    let down = false; try { await call(base, "GET", "/health", null, 3000); } catch { down = true; }
    const m3 = mineIn(await ctl.survey(), id);
    rec("A3", down && m3.length === 1 && m3[0].state === "Running", `manager ${down ? "gone" : "STILL ANSWERING"}; the VM ${m3.length === 1 ? `is ${m3[0].state}` : `count is ${m3.length}`}`);

    base = await ctl.startManager();
    await inventoryReady(base, readyWaitMs);
    const g4 = await call(base, "GET", `/vms/${encodeURIComponent(id)}`);
    const v4 = g4.body || {};
    rec("A4", g4.status === 200 && v4.recovered === true && v4.status === "starting" && v4.appReady !== true && !v4.relay && v4.hostExcluded === false,
      `GET ${g4.status}: recovered ${v4.recovered}, status ${v4.status}, appReady ${v4.appReady}, relay ${JSON.stringify(v4.relay ?? null)}, hostExcluded ${v4.hostExcluded}`);

    const r5 = await call(base, "POST", "/vms", { ...spawnBody, name });
    const m5 = mineIn(await ctl.survey(), id);
    const all5 = (await ctl.survey()).vms.filter((v) => ctl.parseNotes(v.notes).owned);
    rec("A5", r5.status === 409 && r5.body && r5.body.id === id && m5.length === 1 && all5.length === 1,
      `second POST ${r5.status} naming ${r5.body && r5.body.id}; VMs with this id ${m5.length}, manager-owned VMs ${all5.length}`);

    const r6 = await call(base, "DELETE", `/vms/${encodeURIComponent(id)}`);
    const m6 = mineIn(await ctl.survey(), id);
    const g6 = await call(base, "GET", `/vms/${encodeURIComponent(id)}`);
    rec("A6", r6.status === 200 && m6.length === 0 && g6.status === 404, `DELETE ${r6.status}; VMs with this id ${m6.length}; GET after ${g6.status}`);
    if (r6.status === 200 && m6.length === 0) id = null;

    na.push("A7"); say("N/A A7: the relay dies with the manager - no per-domain wmiserve relay exists yet (enclave-5d's wmiserve-run.mjs)");
  } catch (e) {
    failed++; say(`FAIL error: ${e.message}`);
  } finally {
    if (id) {   // best effort: the harness's cleanup is the net under this
      try { const r = await call(base, "DELETE", `/vms/${encodeURIComponent(id)}`, null, 120_000); say(`cleanup: DELETE ${id} -> ${r.status}`); }
      catch (e) { say(`cleanup: DELETE ${id} failed: ${e.message}`); }
    }
    try { await ctl.killManager(); } catch {}
  }
  say(failed ? `RESTART-ACCEPT ${failed} FAILED` : `RESTART-ACCEPT ALL PASS${na.length ? ` (N/A: ${na.join(", ")})` : ""}`);
  return { ok: failed === 0, failed, na };
}

/* ---- the command line: the real main.mjs as a child process, the real launcher's survey ---------------------- */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8").replace(/^﻿/, ""));
  const tree = cfg.tree;
  const { WmiHyperVLauncher, parseNotes } = await import(pathToFileURL(path.join(tree, "windows/vbslike/manager/wmi-launcher.mjs")).href);
  const { powershellRunner } = await import(pathToFileURL(path.join(tree, "windows/vbslike/manager/psrun.mjs")).href);
  const surveyor = new WmiHyperVLauncher({ run: powershellRunner({ timeoutMs: 120_000 }), imagePath: cfg.igvm, imageSha256: cfg.igvmSha256 });
  const base = `http://127.0.0.1:${cfg.port}`;
  let child = null, n = 0;
  const ctl = {
    parseNotes,
    survey: () => surveyor.survey(),
    async startManager() {
      n++;
      const log = fs.openSync(path.join(cfg.logDir, `manager-${n}.log`), "a");
      child = spawn(process.execPath, [path.join(tree, "windows/vbslike/manager/main.mjs")], {
        stdio: ["ignore", log, log], windowsHide: true,
        env: { ...process.env, VMMGR_PORT: String(cfg.port), ENCLAVE_GUEST_IGVM: cfg.igvm, ENCLAVE_GUEST_IGVM_SHA256: cfg.igvmSha256,
               ENCLAVE_BOOT_FORM: "linux-direct", ENCLAVE_GUEST_STATE_MASTER: cfg.gsMaster, ENCLAVE_GUEST_STATE_MASTER_SHA256: cfg.gsMasterSha256,
               ENCLAVE_GUEST_STATE_ARCHIVE_DIR: cfg.archiveDir, ENCLAVE_HYPERV_MODULE: cfg.hypervModule,
               ENCLAVE_RUNTIME_IDENTITY: cfg.runtimeIdentity, PYTHON_BIN: cfg.python, IPFS_GATEWAY: cfg.gateway,
               PYTHONPATH: path.join(tree, "wasm") } });
      console.log(`manager #${n} pid ${child.pid}`);
      return base;
    },
    async killManager() {
      if (!child || child.exitCode !== null) return;
      const c = child; const gone = new Promise((r) => c.once("exit", r));
      c.kill("SIGKILL");                                   // TerminateProcess on Windows: no graceful path
      await Promise.race([gone, sleep(15_000)]);
    },
  };
  const spawnBody = JSON.parse(fs.readFileSync(cfg.spawnJson, "utf8").replace(/^﻿/, ""));
  delete spawnBody.id;                                     // the manager mints ids; the package's label is not one
  const r = await runRestartAccept({ ctl, spawnBody, name: cfg.name });
  process.exitCode = r.refused ? 3 : r.ok ? 0 : 1;
}
