// multi-accept.mjs - N serving domains AT ONCE on the REAL manager and the REAL Hyper-V (enclave-d1's READINESS.md U1).
// FUNCTIONAL serving only: the package's pinned hello-world as N deployments with distinct names and, so that their
// AppIDs differ, distinct SMALL policies (memMiB = base + 16*i; the component and the rest of the record unchanged).
// No in-guest probe, no probe domain, no domprobe, no customer app; nothing here touches the parked probe, report or
// memory work.
//   M0 a clean start: the inventory is ready and empty, and Hyper-V has no manager-owned VM; box memory recorded
//   M1 N POSTs: each 201 with its own "hv"+32-hex id, and N distinct AppIDs
//   M2 all N reach running, each on its OWN VM (exactly one Running VM per id, N distinct VM Ids), with N distinct launcher
//      keys and N distinct transport keys; box memory recorded
//   M3 each answers through the DATA PLANE: "OK" to its own route, TLS to the domain's front on exactly the key the
//      manager verified, and GET / answers 200 (the pinned bytes, when expectBodySha256 is given)
//   M4 the data plane REFUSES A's key on B's route, and A's id with B's app
//   M5 DELETE A: A is gone (404, no VM, its route refused), and every other domain still answers 200
//   M6 turn B's VM Off from the host: B is failed by the liveness sweep and its route refused, and every other domain
//      still answers 200
//   M7 teardown: DELETE every domain this run created; zero manager-owned VMs remain; box memory recorded
// Last line: MULTI-ACCEPT ALL PASS | MULTI-ACCEPT <n> FAILED | MULTI-ACCEPT REFUSED <why>. host_excluded=no throughout.
// It must run under manager-accept.ps1 -Serve -Driver <this file> (the run lock, the watchdog, the temporary firmware
// opt-in and its restore, the report service's hv_sock GUID).
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call } from "./restart-accept.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** The i-th deployment: a distinct name (its first byte, so its 8-hex label differs too) and a distinct small policy. */
export function deploymentOf(spawnBody, name, i, memMiB) {
  if (!/^0x[0-9a-f]{64}$/.test(String(name))) throw new Error("the base name must be 0x + 64 lowercase hex");
  const d = structuredClone(spawnBody);
  d.derive = { ...d.derive, policy: { ...d.derive.policy, memMiB: memMiB + 16 * i } };
  return { ...d, name: "0x" + (0xa0 + i).toString(16) + name.slice(4) };
}

/**
 * One data-plane route: the preamble for `f`, and the answer line. With `tlsFor` (the deployment name), an "OK" goes on:
 * TLS to the domain's front over the same connection, the peer's key hashed, and GET / read. Never throws.
 */
export function viaDataPlane(dataPort, f, { tlsFor = null, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const c = net.connect({ host: "127.0.0.1", port: dataPort });
    let got = "", done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); try { c.destroy(); } catch {} resolve(v); };
    const t = setTimeout(() => finish({ line: got.split("\n")[0] || "timeout", ok: false, timeout: true }), timeoutMs);
    c.on("error", (e) => finish({ line: `error ${e.message}`, ok: false }));
    c.on("close", () => finish({ line: got.split("\n")[0] || "closed without an answer", ok: false }));
    const onData = (d) => {
      got += d.toString("latin1");
      const i = got.indexOf("\n"); if (i < 0) return;
      const line = got.slice(0, i);
      if (line !== "OK" || !tlsFor) return finish({ line, ok: line === "OK" });
      c.removeListener("data", onData);
      const label = String(tlsFor).slice(2, 10), host = `${label}.app.enclave.host`;
      const s = tls.connect({ socket: c, servername: host, rejectUnauthorized: false });
      s.on("error", (e) => finish({ line, ok: true, error: `TLS: ${e.message}` }));
      s.once("secureConnect", () => {
        const cert = s.getPeerX509Certificate && s.getPeerX509Certificate();
        const key = cert ? sha(cert.publicKey.export({ type: "spki", format: "der" })) : null;
        const agent = new http.Agent({ keepAlive: false }); agent.createConnection = () => s;
        const r = http.request({ agent, method: "GET", path: "/", headers: { host, connection: "close" } }, (a) => {
          const chunks = []; a.on("data", (x) => chunks.push(x));
          a.on("end", () => { const body = Buffer.concat(chunks); finish({ line, ok: true, key, status: a.statusCode, bodySha256: sha(body), body: body.toString("utf8").slice(0, 64) }); });
          a.on("error", (e) => finish({ line, ok: true, key, error: `answer: ${e.message}` }));
        });
        r.on("error", (e) => finish({ line, ok: true, key, error: `request: ${e.message}` }));
        r.end();
      });
    };
    c.on("data", onData);
    c.write(`ENCLAVE-SPLICE/1 id=${f.id} app=${f.app} image=${f.image} runtime=${f.runtime} key=${f.key}\n`);
  });
}
const routeOf = (v) => ({ id: v.id, app: v.appId, image: v.image, runtime: v.runtimeId, key: v.transportKeySha256 });

/**
 * ctl: { startManager(extraEnv) -> base URL, killManager(), survey() -> {vms:[{vmId,name,state,notes}]}, parseNotes,
 *        turnOff(vmId), memory() -> {freeMiB, totalMiB} }
 */
export async function runMultiAccept({ ctl, spawnBody, name, dataPort, n = 3, memMiB = 128, expectBodySha256 = null, say = console.log,
                                       readyWaitMs = 300_000, sweepWaitMs = 60_000 }) {
  let failed = 0;
  const rec = (id, ok, detail) => { if (!ok) failed++; say(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`); return ok; };
  const mineIn = (s, id) => (s.vms || []).filter((v) => { const p = ctl.parseNotes(v.notes); return p.identity && p.identity.id === id; });
  const owned = (s) => (s.vms || []).filter((v) => ctl.parseNotes(v.notes).owned);
  const mem = (when) => { const m = ctl.memory(); say(`MEMORY ${when}: ${m.freeMiB} MiB free of ${m.totalMiB} MiB`); return m; };
  const answers = (r, v) => r.ok && r.key === v.transportKeySha256 && r.status === 200 && (!expectBodySha256 || r.bodySha256 === expectBodySha256);
  const said = (r) => `${r.line}${r.status != null ? `, ${r.status} ${JSON.stringify(r.body)}` : ""}${r.key ? `, TLS key ${r.key.slice(0, 16)}` : ""}${r.error ? `, ${r.error}` : ""}`;
  if (!Number.isInteger(n) || n < 2) throw new Error("n must be at least 2: one domain is restart-accept's job");
  if (!Number.isInteger(dataPort) || dataPort < 1) throw new Error("a data-plane port is required");
  const base = await ctl.startManager({ ENCLAVE_DATAPLANE_PORT: String(dataPort) });
  const ids = []; let refused = null;
  try {
    const until0 = Date.now() + readyWaitMs; let inv0 = null;
    while (Date.now() < until0) { try { const r = await call(base, "GET", "/vms", null, 10_000); if (r.status === 200) { inv0 = r.body; break; } } catch {} await sleep(1000); }
    if (!inv0) { refused = "the manager's inventory never became ready"; return { ok: false, refused: true }; }
    const o0 = owned(await ctl.survey());
    if ((inv0.vms || []).length || o0.length) {
      refused = `the manager holds ${(inv0.vms || []).length} instance(s) and Hyper-V ${o0.length} manager-owned VM(s) before this run: it touches only what it creates`;
      return { ok: false, refused: true };
    }
    const m0 = mem("before");
    rec("M0", true, `inventory ready and empty; no manager-owned VM; ${m0.freeMiB} MiB free`);

    const deps = Array.from({ length: n }, (_, i) => deploymentOf(spawnBody, name, i, memMiB));
    const posts = [];
    for (const d of deps) { const r = await call(base, "POST", "/vms", d); posts.push(r); if (r.body && r.body.id) ids.push(r.body.id); }
    const apps = new Set(posts.map((r) => r.body && r.body.appId));
    rec("M1", posts.every((r) => r.status === 201 && /^hv[0-9a-f]{32}$/.test(String(r.body && r.body.id))) && new Set(ids).size === n && apps.size === n,
      posts.map((r, i) => `${deps[i].name.slice(0, 10)}… memMiB ${deps[i].derive.policy.memMiB}: ${r.status} ${r.body && r.body.id} app ${String(r.body && r.body.appId).slice(0, 8)}`).join("; ")
      + (apps.size !== n ? `; only ${apps.size} distinct AppID(s)` : ""));
    if (ids.length !== n) throw new Error("not every deployment was created; the remaining checks cannot run");

    const views = new Map(); const until = Date.now() + readyWaitMs;
    while (Date.now() < until && views.size < n) {
      for (const id of ids) if (!views.has(id)) { const v = (await call(base, "GET", `/vms/${encodeURIComponent(id)}`)).body; if (v && (v.status === "running" || v.status === "failed")) views.set(id, v); }
      if (views.size < n) await sleep(2000);
    }
    const vs = ids.map((id) => views.get(id) || { id, status: "not settled" });
    const s2 = await ctl.survey(), vms = ids.map((id) => mineIn(s2, id));
    const distinct = (f) => new Set(vs.map(f)).size === n && vs.every((v) => f(v));
    rec("M2", vs.every((v) => v.status === "running") && vms.every((x) => x.length === 1 && x[0].state === "Running") && new Set(vms.map((x) => x[0] && x[0].vmId)).size === n
      && distinct((v) => v.launcherKey) && distinct((v) => v.transportKeySha256),
      vs.map((v, i) => `${v.id}: ${v.status}${v.status !== "running" ? ` (${String(v.reason || "").slice(0, 160)})` : ""}, VM ${vms[i].map((x) => `${x.vmId} ${x.state}`).join("|") || "none"}, launcherKey ${String(v.launcherKey || "").slice(0, 8)}, key ${String(v.transportKeySha256 || "").slice(0, 8)}`).join("; "));
    mem(`with ${n} running`);
    const nameOf = (v) => deps[vs.indexOf(v)].name;          // vs is in POST order and never shrinks
    if (!vs.every((v) => v.status === "running")) throw new Error("not every domain reached running; the serving checks cannot run");

    const answered = [];
    for (const v of vs) answered.push(await viaDataPlane(dataPort, routeOf(v), { tlsFor: nameOf(v) }));
    rec("M3", vs.every((v, i) => answers(answered[i], v)), vs.map((v, i) => `${v.id}: ${said(answered[i])}${answered[i].key && answered[i].key !== v.transportKeySha256 ? " (NOT the verified key)" : ""}`).join("; "));

    const [A, B] = vs;
    const k = await viaDataPlane(dataPort, { ...routeOf(B), key: A.transportKeySha256 });
    const a = await viaDataPlane(dataPort, { ...routeOf(A), app: B.appId });
    rec("M4", !k.ok && /transport key/.test(k.line) && !a.ok && /not that app/.test(a.line), `A's key on B's route: "${k.line}"; A's id with B's app: "${a.line}"`);

    const dA = await call(base, "DELETE", `/vms/${encodeURIComponent(A.id)}`);
    const gA = await call(base, "GET", `/vms/${encodeURIComponent(A.id)}`);
    const vmA = mineIn(await ctl.survey(), A.id);
    const rA = await viaDataPlane(dataPort, routeOf(A));
    const rest5 = vs.slice(1), ans5 = [];
    for (const v of rest5) ans5.push(await viaDataPlane(dataPort, routeOf(v), { tlsFor: nameOf(v) }));
    rec("M5", dA.status === 200 && gA.status === 404 && vmA.length === 0 && !rA.ok && rest5.every((v, i) => answers(ans5[i], v)),
      `DELETE ${A.id} ${dA.status}, GET after ${gA.status}, VMs ${vmA.length}, its route "${rA.line}"; others: ${rest5.map((v, i) => `${v.id} ${said(ans5[i])}`).join("; ")}`);
    if (dA.status === 200 && vmA.length === 0) ids.splice(ids.indexOf(A.id), 1);

    const vmB = mineIn(await ctl.survey(), B.id)[0];
    let gB = null;
    if (vmB) {
      await ctl.turnOff(vmB.vmId);
      const t6 = Date.now();
      while (Date.now() - t6 < sweepWaitMs) { gB = (await call(base, "GET", `/vms/${encodeURIComponent(B.id)}`)).body; if (gB && gB.status === "failed") break; await sleep(1000); }
    }
    const rB = await viaDataPlane(dataPort, routeOf(B));
    const rest6 = vs.slice(2), ans6 = [];
    for (const v of rest6) ans6.push(await viaDataPlane(dataPort, routeOf(v), { tlsFor: nameOf(v) }));
    rec("M6", !!gB && gB.status === "failed" && /stopped by itself|no longer on this host/.test(String(gB.reason || "")) && !rB.ok && rest6.every((v, i) => answers(ans6[i], v)),
      `${B.id} after its VM ${vmB ? vmB.vmId : "(none)"} was turned Off: ${gB ? gB.status : "no answer"} (${JSON.stringify(String(gB && gB.reason || "").slice(0, 140))}), its route "${rB.line}"; others: ${rest6.map((v, i) => `${v.id} ${said(ans6[i])}`).join("; ")}`);
  } catch (e) {
    failed++; say(`FAIL error: ${e.message}`);
  } finally {
    // a refused run created nothing: it tears down nothing and its REFUSED line is the last
    if (refused) { try { await ctl.killManager(); } catch {} say(`MULTI-ACCEPT REFUSED: ${refused}`); }
    else {
    const del = [];
    for (const id of [...ids]) { try { const r = await call(base, "DELETE", `/vms/${encodeURIComponent(id)}`, null, 120_000); del.push(`${id} ${r.status}`); } catch (e) { del.push(`${id} ${e.message}`); } }
    let left = null; try { left = owned(await ctl.survey()); } catch (e) { say(`survey after teardown failed: ${e.message}`); }
    const m7 = (() => { try { return mem("after teardown"); } catch { return null; } })();
    rec("M7", left !== null && left.length === 0, `DELETE ${del.join(", ") || "(nothing left to delete)"}; manager-owned VMs left ${left ? left.length : "unknown"}${left && left.length ? `: ${left.map((v) => v.name).join(", ")}` : ""}${m7 ? `; ${m7.freeMiB} MiB free` : ""}`);
    try { await ctl.killManager(); } catch {}
    }
  }
  say(failed ? `MULTI-ACCEPT ${failed} FAILED` : "MULTI-ACCEPT ALL PASS");
  return { ok: failed === 0, failed };
}

/* ---- the command line: the real main.mjs as a child process, the real launcher's survey (manager-accept.ps1's config) ---- */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8").replace(/^﻿/, ""));
  const tree = cfg.tree;
  if (!cfg.wmiserveExe) { console.log("MULTI-ACCEPT REFUSED: serving is required (manager-accept.ps1 -Serve)"); process.exit(3); }
  const { WmiHyperVLauncher, parseNotes } = await import(pathToFileURL(path.join(tree, "windows/vbslike/manager/wmi-launcher.mjs")).href);
  const { powershellRunner } = await import(pathToFileURL(path.join(tree, "windows/vbslike/manager/psrun.mjs")).href);
  const surveyor = new WmiHyperVLauncher({ run: powershellRunner({ timeoutMs: 120_000 }), imagePath: cfg.igvm, imageSha256: cfg.igvmSha256 });
  const base = `http://127.0.0.1:${cfg.port}`;
  let child = null, k = 0;
  const ctl = {
    parseNotes,
    survey: () => surveyor.survey(),
    memory: () => ({ freeMiB: Math.round(os.freemem() / 1048576), totalMiB: Math.round(os.totalmem() / 1048576) }),
    async turnOff(vmId) {
      if (!/^[0-9a-f-]{36}$/i.test(String(vmId))) throw new Error(`not a VM Id: ${vmId}`);
      const r = await powershellRunner({ timeoutMs: 120_000 })(`$ErrorActionPreference = 'Stop'; $v = Get-VM -Id '${vmId}';
        if (-not ([string]$v.Notes).StartsWith('enclave-vbslike-app-domain/manager|')) { throw 'not a manager-owned VM: not touched' };
        Stop-VM -VM $v -TurnOff -Force; @{ state = [string](Get-VM -Id '${vmId}').State } | ConvertTo-Json -Compress`);
      if (r.code !== 0) throw new Error(`turnOff ${vmId}: ${r.stderr.trim().slice(0, 300)}`);
      console.log(`M6: turned ${vmId} off from the host -> ${r.stdout.trim()}`);
    },
    async startManager(extraEnv = {}) {
      k++;
      const log = fs.openSync(path.join(cfg.logDir, `manager-${k}.log`), "a");
      child = spawn(process.execPath, [path.join(tree, "windows/vbslike/manager/main.mjs")], {
        stdio: ["ignore", log, log], windowsHide: true,
        env: { ...process.env, VMMGR_PORT: String(cfg.port), ENCLAVE_GUEST_IGVM: cfg.igvm, ENCLAVE_GUEST_IGVM_SHA256: cfg.igvmSha256,
               ENCLAVE_BOOT_FORM: "linux-direct", ENCLAVE_GUEST_STATE_MASTER: cfg.gsMaster, ENCLAVE_GUEST_STATE_MASTER_SHA256: cfg.gsMasterSha256,
               ENCLAVE_GUEST_STATE_ARCHIVE_DIR: cfg.archiveDir, ENCLAVE_HYPERV_MODULE: cfg.hypervModule,
               ENCLAVE_RUNTIME_IDENTITY: cfg.runtimeIdentity, PYTHON_BIN: cfg.python, IPFS_GATEWAY: cfg.gateway,
               PYTHONPATH: path.join(tree, "wasm"), ENCLAVE_LIVENESS_MS: String(cfg.livenessMs || 5000),
               ENCLAVE_ANSWER_CHECK_MS: String(cfg.answerCheckMs || 5000),
               ENCLAVE_WMISERVE_EXE: cfg.wmiserveExe, ENCLAVE_WMISERVE_EXE_SHA256: cfg.wmiserveSha256, ENCLAVE_BUNDLE_DIR: cfg.bundleDir, ...extraEnv } });
      console.log(`manager #${k} pid ${child.pid}`);
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
  const m = cfg.multi || {};
  console.log(`MULTI: ${m.n || 3} serving domains at once, memMiB ${m.memMiB || 128}+16*i, data plane 127.0.0.1:${cfg.dataPort}. Functional serving only: no probe; host_excluded=no.`);
  const r = await runMultiAccept({ ctl, spawnBody, name: cfg.name, dataPort: Number(cfg.dataPort), n: m.n || 3, memMiB: m.memMiB || 128, expectBodySha256: m.expectBodySha256 || null });
  process.exitCode = r.refused ? 3 : r.ok ? 0 : 1;
}
