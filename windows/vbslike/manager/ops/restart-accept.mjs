// restart-accept.mjs - the manager's restart-safety rules (53672cbe, 6b1137ee, 8aac6cb4), on the REAL manager process
// and the REAL Hyper-V, for ONE domain this run creates:
//   A0 a clean start: the inventory is ready and holds nothing, and Hyper-V has no manager-owned VM
//   A1 POST /vms spawns: 201, an "hv"+32-hex id, status `starting`, the linux-direct partition name, hostExcluded false
//   A2 Hyper-V has exactly ONE VM carrying this id in its Notes identity, Running
//   A3 the manager process is KILLED (no graceful path): the VM is still Running - VMs outlive the manager
//   A4 a new manager recovers it: 200, recovered:true, status `starting` (never failed, never running), no relay
//   A5 a second POST for the same deployment is 409 naming the recovered id, and no second VM appears
//   A6 DELETE removes it: 200, no VM carries the id, and GET answers 404
//   A7 with serve (wmiserve per domain, --hold stdin): before the kill the domain is `running` with a relay that accepts
//      TCP (A2s); after it, that relay REFUSES within a bound, because the manager's death closed wmiserve's stdin.
//      Without serve, A7 is N/A.
// Last line: RESTART-ACCEPT ALL PASS | RESTART-ACCEPT <n> FAILED | RESTART-ACCEPT REFUSED <why>. An N/A is never a PASS.
// It must run under manager-accept.ps1 (the run lock, the watchdog, the temporary firmware opt-in and its restore).
// Nothing here is an isolation result: host_excluded=no throughout.
import http from "node:http";
import net from "node:net";
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

/** Does a loopback TCP port accept a connection right now? */
export function tcpAccepts(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
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
export async function runRestartAccept({ ctl, spawnBody, name, say = console.log, readyWaitMs = 240_000, expectPartition = "wmi-openhcl-gen2-igvm-linux",
                                         serve = false, relayGoneWaitMs = 20_000 }) {
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
    // `starting` at the answer; with serve the manager judges readiness BEHIND it, so a fast judge may already say running
    rec("A1", r1.status === 201 && /^hv[0-9a-f]{32}$/.test(String(id)) && v1 && (v1.status === "starting" || (serve && v1.status === "running"))
      && v1.boundary && v1.boundary.partition === expectPartition && v1.hostExcluded === false,
      `POST ${r1.status} in ${Date.now() - t0} ms, id ${id}, status ${v1 && v1.status}, partition ${v1 && v1.boundary && v1.boundary.partition}, hostExcluded ${v1 && v1.hostExcluded}`
      + (r1.status !== 201 ? `, error ${r1.text.slice(0, 300)}` : "")
      + (v1 && v1.status !== "starting" && v1.status !== "running" ? `, reason ${JSON.stringify(String(v1.reason ?? "").slice(0, 600))}, guest ${JSON.stringify(v1.guest ?? null)}` : ""));
    if (!id) throw new Error("no instance was created; the remaining checks cannot run");

    const m2 = mineIn(await ctl.survey(), id);
    rec("A2", m2.length === 1 && m2[0].state === "Running", `${m2.length} VM(s) carry id ${id}: ${m2.map((v) => `${v.name} ${v.vmId} ${v.state}`).join("; ")}`);

    let relayPort = null;
    if (serve) {
      // the manager judges readiness behind the POST: wait for its verdict, then the relay must carry TCP
      const until = Date.now() + readyWaitMs; let v = null;
      while (Date.now() < until) {
        const g = await call(base, "GET", `/vms/${encodeURIComponent(id)}`); v = g.body;
        if (v && (v.status === "running" || v.status === "failed")) break;
        await sleep(2000);
      }
      relayPort = v && v.relay && v.relay.port;
      const ok = relayPort ? await tcpAccepts(relayPort) : false;
      rec("A2s", !!v && v.status === "running" && ok, `status ${v && v.status}, relay port ${relayPort}, TCP ${ok ? "accepts" : "refused"}`
        + `, launcherKey ${v && v.launcherKey ? "named" : "absent"}, image ${v && v.image}, statement ${JSON.stringify(v && v.guestIdentity)}`
        + (v && v.status !== "running" ? `, reason ${JSON.stringify(String(v.reason ?? "").slice(0, 400))}` : ""));
    }

    await ctl.killManager();
    let down = false; try { await call(base, "GET", "/health", null, 3000); } catch { down = true; }
    const m3 = mineIn(await ctl.survey(), id);
    rec("A3", down && m3.length === 1 && m3[0].state === "Running", `manager ${down ? "gone" : "STILL ANSWERING"}; the VM ${m3.length === 1 ? `is ${m3[0].state}` : `count is ${m3.length}`}`);
    if (serve) {
      // the relay dies with the manager: wmiserve's stdin reached EOF when its parent died
      const until = Date.now() + relayGoneWaitMs; let open = relayPort ? true : null;
      while (relayPort && open && Date.now() < until) { open = await tcpAccepts(relayPort, 1000); if (open) await sleep(500); }
      rec("A7", relayPort != null && open === false, relayPort == null ? "no relay port was ever named (A2s)" : `relay port ${relayPort} ${open ? `STILL ACCEPTS after ${relayGoneWaitMs} ms` : "refuses: the relay died with the manager"}`);
    }

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

    if (!serve) { na.push("A7"); say("N/A A7: the relay dies with the manager - this run did not serve (no wmiserve settings)"); }
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
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8").replace(/^\uFEFF/, ""));
  const tree = cfg.tree;
  const { WmiHyperVLauncher, parseNotes } = await import(pathToFileURL(path.join(tree, "windows/vbslike/manager/wmi-launcher.mjs")).href);
  const { powershellRunner } = await import(pathToFileURL(path.join(tree, "windows/vbslike/manager/psrun.mjs")).href);
  const surveyor = new WmiHyperVLauncher({ run: powershellRunner({ timeoutMs: 120_000 }), imagePath: cfg.igvm, imageSha256: cfg.igvmSha256 });
  const base = `http://127.0.0.1:${cfg.port}`;
  let child = null, n = 0;
  const ctl = {
    parseNotes,
    survey: () => surveyor.survey(),
    async startManager(extraEnv = {}) {
      n++;
      const log = fs.openSync(path.join(cfg.logDir, `manager-${n}.log`), "a");
      child = spawn(process.execPath, [path.join(tree, "windows/vbslike/manager/main.mjs")], {
        stdio: ["ignore", log, log], windowsHide: true,
        env: { ...process.env, VMMGR_PORT: String(cfg.port), ENCLAVE_GUEST_IGVM: cfg.igvm, ENCLAVE_GUEST_IGVM_SHA256: cfg.igvmSha256,
               ENCLAVE_BOOT_FORM: "linux-direct", ENCLAVE_GUEST_STATE_MASTER: cfg.gsMaster, ENCLAVE_GUEST_STATE_MASTER_SHA256: cfg.gsMasterSha256,
               ENCLAVE_GUEST_STATE_ARCHIVE_DIR: cfg.archiveDir, ENCLAVE_HYPERV_MODULE: cfg.hypervModule,
               ENCLAVE_RUNTIME_IDENTITY: cfg.runtimeIdentity, PYTHON_BIN: cfg.python, IPFS_GATEWAY: cfg.gateway,
               PYTHONPATH: path.join(tree, "wasm"),
               ...(cfg.wmiserveExe ? { ENCLAVE_WMISERVE_EXE: cfg.wmiserveExe, ENCLAVE_WMISERVE_EXE_SHA256: cfg.wmiserveSha256,
                                       ENCLAVE_BUNDLE_DIR: cfg.bundleDir } : {}), ...extraEnv } });
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
  const spawnBody = JSON.parse(fs.readFileSync(cfg.spawnJson, "utf8").replace(/^\uFEFF/, ""));
  delete spawnBody.id;                                     // the manager mints ids; the package's label is not one

  // PHASE 1 (optional, cfg.hvlab): enclave-5d's hvlab-accept.mjs against THIS manager, started with the data plane on.
  // It drives the node's real ensureApp, app zone and tunnel hub to a browser TLS session inside the partition, with the
  // refusals, a forced relaunch and a node restart. Its verdict is its own last line; a missing PASS is not a pass.
  let phase1 = null;
  if (cfg.hvlab) {
    const h = cfg.hvlab;
    const base1 = await ctl.startManager({ ENCLAVE_DATAPLANE_PORT: String(h.dataPort) });
    await inventoryReady(base1, 240_000);
    console.log(`PHASE 1: hvlab-accept against ${base1} (data plane 127.0.0.1:${h.dataPort})`);
    const out = [];
    const code = await new Promise((resolve) => {
      const c = spawn(process.execPath, [h.script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HVACC_NODE_TREE: h.nodeTree, HVACC_MANAGER: base1, HVACC_DATA: `127.0.0.1:${h.dataPort}`,
               HVACC_LAUNCHER_KEY: "record", HVACC_EXPECT_HV_ISOLATION: "vbs", HVACC_JUDGE: path.join(h.nodeTree, "windows/vbslike/verify/judge-hv.mjs"),
               HVACC_RUNTIME: cfg.runtimeIdentity, HVACC_TIMEOUT_S: String(h.timeoutS || 300), PYTHONPATH: path.join(h.nodeTree, "wasm"),
               HVACC_PYTHON: cfg.python, IPFS_GATEWAY: cfg.gateway } });
      const line = (pre) => (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) { out.push(l); console.log(`${pre}${l}`); } };
      c.stdout.on("data", line("  HVLAB: ")); c.stderr.on("data", line("  HVLAB-ERR: "));
      c.on("close", resolve);
    });
    const last = out.filter((l) => /^HVLAB-ACCEPT /.test(l)).at(-1) || "(no HVLAB-ACCEPT line)";
    phase1 = { code, last, pass: code === 0 && /^HVLAB-ACCEPT ALL PASS/.test(last) };
    console.log(`PHASE 1 RESULT: exit ${code}, ${last}`);
    await ctl.killManager();
    const left = (await ctl.survey()).vms.filter((v) => ctl.parseNotes(v.notes).owned);
    if (left.length) {
      console.log(`PHASE 1 LEFT ${left.length} manager-owned VM(s): ${left.map((v) => v.name).join(", ")}`);
      console.log("RESTART-ACCEPT REFUSED: phase 1 left VMs behind; phase 2 needs a clean start");
      process.exit(1);
    }
  }

  console.log("PHASE 2: restart recovery" + (cfg.wmiserveExe ? " (serving: A2s and A7 apply)" : ""));
  const r = await runRestartAccept({ ctl, spawnBody, name: cfg.name, serve: !!cfg.wmiserveExe });
  const ok = r.ok && (!phase1 || phase1.pass);
  console.log(`ACCEPTANCE: phase 1 ${phase1 ? (phase1.pass ? "PASS" : "FAIL") : "not run"}, phase 2 ${r.refused ? "REFUSED" : r.ok ? "PASS" : "FAIL"}`);
  process.exitCode = r.refused ? 3 : ok ? 0 : 1;
}
