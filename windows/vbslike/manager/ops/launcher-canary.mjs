// launcher-canary.mjs - the manager's REAL WmiHyperVLauncher on the host, once: preflight, start one type-1 VM,
// survey it, stop (remove by VM Id), survey again. It runs no app and no data plane. It must be run under
// ops/manager-launcher-canary.ps1, which owns the temporary AllowFirmwareLoadFromFile opt-in (this launcher
// never sets it) and the watchdog.
//
//   node launcher-canary.mjs <config.json>
//   config: { imagePath, imageSha256, boot, guestStateMaster, guestStateMasterSha256, guestStateArchiveDir,
//             hypervModule, prefix, memMiB, vcpus }
// Each step prints one JSON line. Exit 0 only if every step held: started, listed with our identity, removed, gone.
// runCanary() is exported so launcher-canary.test.mjs can drive the same steps against the fake host.
import { WmiHyperVLauncher, parseNotes } from "../wmi-launcher.mjs";
import { powershellRunner } from "../psrun.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export async function runCanary({ run, cfg, say, guestReadySec = 40 }) {
  const launcher = new WmiHyperVLauncher({ run, imagePath: cfg.imagePath, imageSha256: cfg.imageSha256, boot: cfg.boot,
    guestStateMaster: cfg.guestStateMaster, guestStateMasterSha256: cfg.guestStateMasterSha256,
    guestStateArchiveDir: cfg.guestStateArchiveDir, hypervModule: cfg.hypervModule, prefix: cfg.prefix });
  const id = "hv" + crypto.randomBytes(16).toString("hex");
  const instanceId = id.slice(0, 16) + "-canary";
  const identity = { id, name: "0x" + "c0".repeat(32), instanceId, appId: "00".repeat(32) };
  const mapping = { appId: identity.appId, record: { policy: { vcpus: cfg.vcpus || 1, memMiB: cfg.memMiB || 2048, cpuPercent: 100 } } };
  let ok = true, handle = null;
  try {
    const pre = await launcher.preflight();
    say({ step: "preflight", ok: pre.ok, failed: pre.checks.filter((c) => !c.ok).map((c) => c.name) });
    if (!pre.ok) throw new Error("preflight refused: " + pre.checks.filter((c) => !c.ok).map((c) => c.name).join(", "));
    const t0 = Date.now();
    handle = await launcher.start(mapping, { instanceId, identity, guestReadySec });
    const { stop, ...h } = handle;
    say({ step: "start", ok: true, ms: Date.now() - t0, handle: h });
    const s1 = await launcher.survey();
    const mine = (s1.vms || []).filter((v) => String(v.vmId).toLowerCase() === String(handle.vmId).toLowerCase());
    const notes = mine[0] ? parseNotes(mine[0].notes) : null;
    const listed = mine.length === 1 && !!notes && !!notes.identity && notes.identity.id === id;
    say({ step: "survey", ok: listed, vm: mine[0] ? { vmId: mine[0].vmId, name: mine[0].name, state: mine[0].state } : null,
          identity: notes && notes.identity });
    ok = ok && listed;
  } catch (e) {
    ok = false; say({ step: "error", error: e.message, cleanup: e.cleanup ?? null, guestState: e.guestState ?? null });
  } finally {
    if (handle) {
      try {
        const r = await launcher.stop(handle);
        const removed = r.removed === true;
        say({ step: "stop", ok: removed, result: r });
        ok = ok && removed;
      } catch (e) { ok = false; say({ step: "stop", ok: false, error: e.message }); }
    }
    try {
      const s2 = await launcher.survey();
      const left = (s2.vms || []).filter((v) => String(v.name || "").startsWith(cfg.prefix));
      say({ step: "survey-after", ok: left.length === 0, left: left.map((v) => ({ vmId: v.vmId, name: v.name, state: v.state })) });
      ok = ok && left.length === 0;
    } catch (e) { ok = false; say({ step: "survey-after", ok: false, error: e.message }); }
    say({ step: "result", ok });
  }
  return ok;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // A FILE, not JSON on the command line: Windows re-quotes arguments, and a config is not worth that risk.
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8").replace(/^\uFEFF/, ""));
  const ok = await runCanary({ run: powershellRunner({ timeoutMs: 240_000 }), cfg, say: (o) => console.log(JSON.stringify(o)) });
  process.exitCode = ok ? 0 : 1;
}
