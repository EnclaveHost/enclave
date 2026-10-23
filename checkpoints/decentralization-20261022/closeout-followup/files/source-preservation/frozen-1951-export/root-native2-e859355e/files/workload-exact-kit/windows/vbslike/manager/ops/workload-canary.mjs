// workload-canary.mjs - a REAL CPU workload through the real launcher, for root on the NucBox: one type-1 partition per
// case, sized from a purchased share exactly as the manager sizes it (cpu-share.mjs), the CPU-share probe app
// (isolation/m2/app: GET /burn?n=, n million xorshift rounds) loaded and served through the pinned wmiserve, and timed
// over its relay: one request alone (T1), then N at once (TN). The app's own throughput says what the guest lets it use:
//   speedup = N*T1/TN.  A guest that confines the app to its catalog cpuPercent 100 gives ~1/limit (1.19 at 84%) whatever
//   the VM has; a VM-bound image (cpu-vm-bound.enabled) gives ~min(N, VPs). Across cases at one VP, T1 scales with the
//   explicit guest cgroup quota (1% of 16 = 16% of a VP is ~6.25x slower than 6.25% = one whole VP).
// It changes nothing it did not create: its own prefix, its own VMs (removed by Id), its own bundle files.
//
//   node workload-canary.mjs <config.json>
//   config: { imagePath, imageSha256, boot: "linux-direct", guestStateMaster, guestStateMasterSha256, guestStateArchiveDir,
//             hypervModule, prefix, wmiserveExe, wmiserveSha256, bundleDir, componentPath, componentSha256, cpuPoolVcpus,
//             burnMillions, cases: [{ share, concurrency, expect: { minSpeedup?, maxSpeedup? } }], guestReadySec? }
// Each step prints one JSON line; exit 0 only if every case met its expectation and every VM it made is gone.
import { WmiHyperVLauncher, parseNotes } from "../wmi-launcher.mjs";
import { cpuForShare } from "../cpu-share.mjs";
import { derive } from "../derive.mjs";
import { powershellRunner } from "../psrun.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import { fileURLToPath } from "node:url";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
/** CIDv1 raw sha2-256 of the bytes, base32: a well-formed content id for the (local, never published) component. */
function rawCid(bytes) {
  const b = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), crypto.createHash("sha256").update(bytes).digest()]);
  const A = "abcdefghijklmnopqrstuvwxyz234567"; let bits = 0, v = 0, s = "";
  for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { s += A[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) s += A[(v << (5 - bits)) & 31];
  return "b" + s;
}

/** One GET over the relay to the domain's own TLS front; resolves with { ms, body }. The front's key is the domain's
 *  per-boot transport key (not a CA name), so this timing client does not verify it: nothing here is a trust decision. */
export function burnRequest({ port, millions, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const r = https.request({ host: "127.0.0.1", port, path: `/burn?n=${millions}`, method: "GET", rejectUnauthorized: false, agent: false, timeout: timeoutMs },
      (res) => { let body = ""; res.on("data", (d) => { body += d; }); res.on("end", () => {
        if (res.statusCode !== 200 || !/burn=\d+M state=[0-9a-f]{16}/.test(body)) return reject(new Error(`burn answered ${res.statusCode}: ${body.slice(0, 120)}`));
        resolve({ ms: performance.now() - t0, body: body.trim() }); }); });
    r.on("timeout", () => r.destroy(new Error(`burn timed out after ${timeoutMs} ms`)));
    r.on("error", reject); r.end();
  });
}

export async function runWorkloadCanary({ run, cfg, say, request = burnRequest, spawn = undefined }) {
  const component = fs.readFileSync(cfg.componentPath);
  if (sha(component) !== cfg.componentSha256) throw new Error("the probe component does not hash to its pin");
  if (sha(fs.readFileSync(cfg.wmiserveExe)) !== cfg.wmiserveSha256) throw new Error("wmiserve does not hash to its pin");
  const mapping = derive({ component, record: { derivation: "enclave-catalog-bundle/1", catalog: { app: "0x" + sha("cpu-workload-canary"), version: 1 },
    cid: rawCid(component), runtimeId: sha("synthetic: the bundle carries no runtime id"), policy: { cpuPercent: 100, memMiB: 256, vcpus: 1 } } });
  const launcher = new WmiHyperVLauncher({ run, imagePath: cfg.imagePath, imageSha256: cfg.imageSha256, boot: cfg.boot,
    guestStateMaster: cfg.guestStateMaster, guestStateMasterSha256: cfg.guestStateMasterSha256, guestStateArchiveDir: cfg.guestStateArchiveDir,
    hypervModule: cfg.hypervModule, prefix: cfg.prefix, guestCpuAllowance: true,
    serve: { exe: cfg.wmiserveExe, bundleDir: cfg.bundleDir, readyTimeoutMs: 180_000, ...(spawn ? { spawn } : {}) } });
  const timeoutMs = cfg.requestTimeoutMs || 90_000;
  let ok = true;
  say({ step: "probe", appId: mapping.appId, component: cfg.componentSha256, image: cfg.imageSha256 });
  for (const c of cfg.cases) {
    const cpu = cpuForShare(cfg.cpuPoolVcpus, c.share, mapping.record.policy);
    const id = "hv" + crypto.randomBytes(16).toString("hex");
    const instanceId = id.slice(0, 16) + "-cpuwl";
    const identity = { id, name: "0x" + sha("cpu-workload-canary/" + id), instanceId, appId: mapping.appId };
    let handle = null, res = { share: c.share, want: { vcpus: cpu.vcpus, limit: cpu.limit, reservation: cpu.reservation } };
    try {
      handle = await launcher.start(mapping, { instanceId, identity, guestReadySec: cfg.guestReadySec || 40,
        appMemoryMiB: 512, appCpu: { vcpus: cpu.vcpus, limit: cpu.limit, reservation: cpu.reservation, appCpuPercent: cpu.appCpuPercent } });
      res.readback = handle.cpu.readback; res.guestOnlineVcpus = handle.cpu.guestOnlineVcpus; res.appCpuRequested = handle.cpu.appCpuRequested; res.appCpuPercent = handle.cpu.appCpuPercent; const expectedCpu = cpu.appCpuPercent; if (res.appCpuRequested !== expectedCpu || res.appCpuPercent !== expectedCpu) throw new Error("explicit guest CPU allocation was not echoed exactly");
      res.warmAttempts = []; let warm = false;
      say({ step: "loaded", share: c.share, at: new Date().toISOString(), vmId: handle.vmId, appCpuRequested: res.appCpuRequested, appCpuPercent: res.appCpuPercent });
      for (let attempt=0; attempt<10; attempt++) {
        try { const r=await request({port:handle.tcpPort,millions:1,timeoutMs:5000}); res.warmAttempts.push({ok:true,ms:Math.round(r.ms)}); warm=true; break; }
        catch(e) { res.warmAttempts.push({ok:false,error:e.message}); await new Promise(r=>setTimeout(r,250)); }
      }
      if (!warm) throw new Error("guest did not answer the warmup within ten bounded attempts");
      say({step:"warm",share:c.share,attempts:res.warmAttempts});
      const one = await request({ port: handle.tcpPort, millions: cfg.burnMillions, timeoutMs });
      const n = c.concurrency || 1;
      const t0 = performance.now();
      const many = n > 1 ? await Promise.all(Array.from({ length: n }, () => request({ port: handle.tcpPort, millions: cfg.burnMillions, timeoutMs }))) : [one];
      const tn = n > 1 ? performance.now() - t0 : one.ms;
      res.t1Ms = Math.round(one.ms); res.tnMs = Math.round(tn); res.concurrency = n;
      res.speedup = Number((n * one.ms / tn).toFixed(3));
      res.sameAnswer = many.every((x) => x.body === one.body);
      const e = c.expect || {};
      res.ok = res.sameAnswer && (e.minSpeedup == null || res.speedup >= e.minSpeedup) && (e.maxSpeedup == null || res.speedup <= e.maxSpeedup)
        && handle.cpu.guestOnlineVcpus === cpu.vcpus;
    } catch (err) { res.ok = false; res.error = err.message; res.cleanup = err.cleanup ?? null; }
    finally {
      if (handle) {
        try { const r = await launcher.stop(handle); res.removed = r.removed === true; }
        catch (err) { res.removed = false; res.stopError = err.message; }
        res.ok = res.ok && res.removed;
      }
    }
    say({ step: "case", ...res });
    ok = ok && res.ok;
  }
  try {
    const s = await launcher.survey();
    const left = (s.vms || []).filter((v) => String(v.name || "").startsWith(cfg.prefix) && parseNotes(v.notes).owned);
    say({ step: "survey-after", ok: left.length === 0, left: left.map((v) => ({ vmId: v.vmId, name: v.name, state: v.state })) });
    ok = ok && left.length === 0;
  } catch (err) { ok = false; say({ step: "survey-after", ok: false, error: err.message }); }
  say({ step: "result", ok });
  return ok;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8").replace(/^﻿/, ""));
  const ok = await runWorkloadCanary({ run: powershellRunner({ timeoutMs: 240_000 }), cfg, say: (o) => console.log(JSON.stringify(o)) });
  process.exitCode = ok ? 0 : 1;
}
