#!/usr/bin/env node
/* ============================================================
   The permit guard's process entry (SOURCE ONLY - staged; install-guard.ps1 registers it as a service; this change
   installs, registers and starts NOTHING).

   Production (win32): ENCLAVE_GUARD_CONFIG + ENCLAVE_GUARD_CONFIG_SHA256 pin a JSON file:
     { pipe: "\\\\.\\pipe\\enclave-permit-guard", keyFile, journal, storage: { sddl, parentSddl }, maxLaunchMs }
   The journal is opened with the Windows exclusion and its ACL/NTFS/fixed-drive probe must pass before the guard
   is ready. Survey and removal are the WMI launcher's own CMD.survey / CMD.removeById scripts through the bounded
   PowerShell runner; process identity is Win32_Process.CreationDate (PID alone is never identity); the boot id is
   Win32_OperatingSystem.LastBootUpTime.

   TEST (portable Linux harness only, refused on win32): ENCLAVE_GUARD_TEST=TEST-ONLY-NOT-WINDOWS with
   --socket <path> --journal <path> --key <hex> --inventory <file>. A JSON-file "Hyper-V" (TEST), the in-process
   exclusion (TEST), /proc process start times (TEST). It is a REAL separate process, which is what the
   manager-death test needs; it proves nothing about Hyper-V, NTFS or the Windows service manager.
   ============================================================ */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { PermitGuard, GUARD_PURPOSE } from "./guard-core.mjs";
import { GUARD_PROTO, frames, send, hmac, shaJson, same } from "./guard-client.mjs";
import { openOwnedLog, WINDOWS_EXCLUSION, TEST_inProcessExclusion, checkWindowsStorage } from "../manager/win-durable.mjs";

const TEST_LABEL = "TEST-ONLY-NOT-WINDOWS";

/** TEST backend: a JSON inventory file standing in for Hyper-V. Exact by-id removal; never a prefix. */
export function TEST_fileBackend(file) {
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const write = (j) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(j)); fs.renameSync(tmp, file); };
  return {
    label: "TEST",
    async survey() { return read(); },
    async removeById(vmId) {
      const j = read(); const before = j.vms.length;
      j.vms = j.vms.filter((v) => String(v.vmId).toLowerCase() !== String(vmId).toLowerCase());
      write(j); return before === j.vms.length ? { found: false, removed: false } : { found: true, removed: true };
    },
  };
}

/** Production backend over the launcher's own scripts (survey selects every VM carrying manager identity Notes). */
export async function windowsBackend(run) {
  const { CMD, MANAGER_NOTES_PREFIX } = await import("../manager/wmi-launcher.mjs");
  const json = async (script) => { const r = await run(script); if (r.code !== 0) throw Error(`PowerShell failed (${r.code}): ${String(r.stderr).slice(0, 300)}`); return JSON.parse(String(r.stdout).trim()); };
  return { label: "hyperv-wmi", async survey() { return json(CMD.survey({ prefix: MANAGER_NOTES_PREFIX })); },
    async removeById(vmId) { return json(CMD.removeById({ vmId })); } };
}
export const processIdentityScript = (pid) => `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if (-not $p) { '{"alive":false}' } else { @{alive=$true; created=[string]$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`;
export const bootIdScript = `[string](Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')`;

async function linuxIdentity(pid) {
  try { const f = fs.readFileSync(`/proc/${Number(pid)}/stat`, "utf8"); return { alive: true, created: "TEST-proc-starttime-" + f.slice(f.lastIndexOf(")") + 2).split(" ")[19] }; }
  catch { return { alive: false }; }
}

export function serveGuard({ guard, key, verifyProcess, pollMs = 5_000 }) {
  return net.createServer((sock) => {
    const g = crypto.randomBytes(16).toString("hex"), nonce = crypto.randomBytes(32).toString("hex");
    let s = null, skey = null, last = 0, poll = null;
    const end = (why) => { clearInterval(poll); sock.destroy(); if (s) guard.sessionEnded(s, why); };
    sock.on("error", () => end("pipe error")); sock.on("close", () => end("pipe closed"));
    send(sock, { t: "hello", proto: GUARD_PROTO, guard: g, nonce });
    frames(sock, async (o) => {
      if (!s && !skey) {
        if (o.t !== "attach" || typeof o.clientNonce !== "string" || o.clientNonce.length < 32
            || !same(String(o.mac || ""), hmac(key, "attach", g, nonce, o.clientNonce, o.pid, o.created, o.epoch))) return end("attach MAC refused");
        skey = "pending";
        const id = await verifyProcess(o.pid).catch(() => ({ alive: false }));
        if (!id.alive || id.created !== o.created) return end("manager process identity does not match pid + creation time");
        try { s = guard.attach({ pid: o.pid, created: o.created, epoch: o.epoch }); } catch (e) { return end(e.message); }
        skey = Buffer.from(hmac(key, "skey", g, nonce, o.clientNonce), "hex");
        send(sock, { t: "attached", proof: hmac(skey, "proof", o.clientNonce) });
        // A second death signal beside the pipe: the registering process must stay exactly that process.
        poll = setInterval(async () => { const x = await verifyProcess(o.pid).catch(() => ({ alive: false })); if (!x.alive || x.created !== o.created) end("manager process identity ended"); }, pollMs);
        poll.unref?.();
        return;
      }
      if (!s || o.t !== "req" || o.seq !== last + 1 || !same(String(o.mac || ""), hmac(skey, "req", o.seq, o.op, shaJson(o.args)))) return end("request refused");
      last = o.seq;
      let ok = true, value;
      try {
        if (o.op === "register") value = guard.register(s, o.args);
        else if (o.op === "bindVm") value = guard.bindVm(s, o.args);
        else if (o.op === "renew") value = guard.renew(s, o.args);
        else if (o.op === "withdraw") value = guard.withdraw(s, o.args);
        else if (o.op === "status") value = guard.status();
        else throw Error("unknown guard operation");
      } catch (e) { ok = false; value = e.message; }
      send(sock, { t: "res", seq: o.seq, ok, ...(ok ? { value } : { error: value }), mac: hmac(skey, "res", o.seq, ok, shaJson(value)) });
    }, () => end("bad frame"));
  });
}

async function main() {
  // A closed console (the parent that started us died) must never take the guard down with it.
  process.stdout.on("error", () => {}); process.stderr.on("error", () => {});
  const say = (line) => { try { console.log(line); } catch { /* no console */ } };
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const test = process.env.ENCLAVE_GUARD_TEST === TEST_LABEL;
  if (test && process.platform === "win32") throw Error("the TEST guard harness is refused on Windows");
  let log, backend, key, listenPath, verifyProcess, bootId, maxLaunchMs;
  if (test) {
    log = openOwnedLog(arg("--journal"), { purpose: GUARD_PURPOSE, exclusion: TEST_inProcessExclusion() });
    backend = TEST_fileBackend(arg("--inventory"));
    key = Buffer.from(String(arg("--key")), "hex"); listenPath = arg("--socket");
    verifyProcess = linuxIdentity; bootId = "TEST-" + fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    maxLaunchMs = Number(arg("--max-launch-ms") || 2000);
  } else {
    if (process.platform !== "win32") throw Error("the production guard runs only on Windows");
    const file = process.env.ENCLAVE_GUARD_CONFIG, pin = process.env.ENCLAVE_GUARD_CONFIG_SHA256;
    if (!path.isAbsolute(String(file)) || !/^[0-9a-f]{64}$/.test(String(pin))) throw Error("pinned guard configuration required");
    const bytes = fs.readFileSync(file);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== pin) throw Error("guard configuration hash differs");
    const cfg = JSON.parse(bytes);
    const { powershellRunner } = await import("../manager/psrun.mjs");
    const run = powershellRunner({ timeoutMs: 120_000 });
    await checkWindowsStorage(run, cfg.journal, cfg.storage);
    log = openOwnedLog(cfg.journal, { purpose: GUARD_PURPOSE, exclusion: WINDOWS_EXCLUSION });
    const { parseKey } = await import("../manager/control.mjs");
    key = parseKey(fs.readFileSync(cfg.keyFile, "utf8"));
    backend = await windowsBackend(run); listenPath = cfg.pipe; maxLaunchMs = cfg.maxLaunchMs ?? 600_000;
    if (!/^\\\\\.\\pipe\\enclave-permit-guard[A-Za-z0-9-]*$/.test(listenPath)) throw Error("guard pipe name differs from the reviewed pattern");
    verifyProcess = async (pid) => JSON.parse(String((await run(processIdentityScript(pid))).stdout).trim());
    bootId = String((await run(bootIdScript)).stdout).trim();
    if (!bootId) throw Error("boot identity unavailable");
  }
  const guard = new PermitGuard({ log, backend, bootId, maxLaunchMs, monotonic: () => performance.now(),
    onEvent: (e) => say(`[guard] ${JSON.stringify(e)}`) });
  await guard.start();
  serveGuard({ guard, key, verifyProcess }).listen(listenPath, () => say(`[guard] ready on ${listenPath} (${test ? "TEST" : backend.label})`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => { console.error(`[guard] REFUSING TO START: ${e.message}`); process.exit(2); });
