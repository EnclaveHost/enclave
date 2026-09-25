#!/usr/bin/env node
/* Loopback entry point, wired for real. The supervisor reaches this over guestd-control/1.

   Everything the manager needs is constructed here and nowhere else: the bounded PowerShell
   runner, the WMI launcher with the guest image pinned BY HASH, and a CID-verified component
   fetcher. The manager then asks the host what it can actually do (probe) before it answers
   /health, so "canStart" is the host's answer rather than a configuration detail. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Manager, createServer, startManager } from "./server.mjs";
import { judgeRunning } from "./ready.mjs";
import { runtimeId as runtimeIdOf } from "../../../isolation/contract/runtime.mjs";
import { HyperVPartitionBackend } from "./backend.mjs";
import { WmiHyperVLauncher, HYPERV_MODULE_SHA256 } from "./wmi-launcher.mjs";
import { powershellRunner } from "./psrun.mjs";
import { cidFetcher } from "./fetchcid.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d = "") => (process.env[k] || d).trim();

const port        = Number(env("VMMGR_PORT", "8091"));
const imagePath   = env("ENCLAVE_GUEST_IGVM");          // e.g. C:\Users\claude\vbs-like\openhcl-ownguest.bin
const imageSha256 = env("ENCLAVE_GUEST_IGVM_SHA256");   // the bytes it must be; a path is not an identity
const runtimeId   = env("ENCLAVE_RUNTIME_ID");
// fetch-cid.py lives with the node, NOT in this directory, and it imports ipfs_fetch.py from beside
// itself - so the path must point at that copy rather than anywhere convenient.
const fetcherPath = env("ENCLAVE_CID_FETCHER", path.resolve(HERE, "../../node/fetch-cid.py"));

const fetchComponent = cidFetcher({
  script: fetcherPath,
  python: env("PYTHON_BIN", "python"),
  gateway: env("IPFS_GATEWAY"),
  timeoutMs: Number(env("ENCLAVE_FETCH_TIMEOUT_MS", "240000")),
});

// THE TYPE-1 DEFINITION (wmi-launcher.mjs, ported from uefi-dev-boot.ps1). The boot form is STATED
// here or not at all - "uefi-medium" (ENCLAVE_GUEST_MEDIUM + its sha256) or "linux-direct" (no
// medium; the IGVM is the identity) - and never inferred from which variables happen to be set. A
// launcher without it still surveys, stops and removes VMs, but refuses to start one, and /health
// says why. AllowFirmwareLoadFromFile is NOT configured here: the manager only reports it.
// THE APP AND ITS RELAY (enclave-5d's wmiserve-run.mjs): the Rust launcher's `wmiserve`, run per domain with
// `--hold stdin`, loads the bundle over hv_sock 9000, signs reports on 9001 and relays TCP to the domain. Without these
// three variables the manager boots VMs and serves nothing (the domain stays `starting`). The executable is PINNED BY
// HASH like every other input: a path is not an identity. It is checked here, and the manager refuses to start on a
// mismatch or a partial configuration rather than guessing which half was meant.
const wmiserveExe = env("ENCLAVE_WMISERVE_EXE"), wmiserveSha = env("ENCLAVE_WMISERVE_EXE_SHA256").toLowerCase();
const bundleDir = env("ENCLAVE_BUNDLE_DIR");
let serve = null;
if (wmiserveExe || wmiserveSha || bundleDir) {
  const miss = [!wmiserveExe && "ENCLAVE_WMISERVE_EXE", !/^[0-9a-f]{64}$/.test(wmiserveSha) && "ENCLAVE_WMISERVE_EXE_SHA256 (64 hex)",
                !bundleDir && "ENCLAVE_BUNDLE_DIR"].filter(Boolean);
  if (miss.length) {
    console.error(`[winmgr] REFUSING TO START: serving through wmiserve needs all three settings; missing ${miss.join(", ")}`);
    process.exit(2);
  }
  let got = null;
  try { got = createHash("sha256").update(fs.readFileSync(wmiserveExe)).digest("hex"); }
  catch (e) { console.error(`[winmgr] REFUSING TO START: cannot read the wmiserve executable ${wmiserveExe}: ${e.message}`); process.exit(2); }
  if (got !== wmiserveSha) {
    console.error(`[winmgr] REFUSING TO START: the wmiserve executable ${wmiserveExe} hashes ${got}, not the pinned ${wmiserveSha}`);
    process.exit(2);
  }
  serve = { exe: wmiserveExe, bundleDir };
  console.log(`[winmgr] serving through wmiserve ${wmiserveExe} (sha256 ${got}); bundles in ${bundleDir}`);
}

let launcher = null;
if (imagePath && imageSha256) {
  try {
    launcher = new WmiHyperVLauncher({
      run: powershellRunner(), imagePath, imageSha256,
      boot: env("ENCLAVE_BOOT_FORM") || null,
      medium: env("ENCLAVE_GUEST_MEDIUM") || null,
      mediumSha256: env("ENCLAVE_GUEST_MEDIUM_SHA256") || null,
      guestStateMaster: env("ENCLAVE_GUEST_STATE_MASTER") || null,
      guestStateMasterSha256: env("ENCLAVE_GUEST_STATE_MASTER_SHA256") || null,
      guestStateRunDir: env("ENCLAVE_GUEST_STATE_RUN_DIR") || null,
      guestStateArchiveDir: env("ENCLAVE_GUEST_STATE_ARCHIVE_DIR") || null,
      hypervModule: env("ENCLAVE_HYPERV_MODULE") || null,
      hypervModuleSha256: env("ENCLAVE_HYPERV_MODULE_SHA256", HYPERV_MODULE_SHA256),
      hypervUtilitiesSha256: env("ENCLAVE_HYPERV_UTILITIES_SHA256") || null,
      serve,
    });
  } catch (e) {
    // A contradictory launcher configuration (a medium with linux-direct, an unknown boot form, a
    // medium with no boot form) is refused at startup rather than guessed at.
    console.error(`[winmgr] REFUSING TO START: the launcher configuration is invalid: ${e.message}`);
    process.exit(2);
  }
}
// THE RUNTIME IDENTITY, read from the image's own runtime.json rather than configured as a hash.
//
// enclave-53 found that the defect-11 fix was not REACHED from here: this entry point passed only
// runtimeId, so this.runtime was null, #judgeReadiness passed expectRuntime: undefined, and
// checkRuntime pinned nothing. Two consequences, and the second is worse than the first: any
// admissible runtime a domain stated was accepted, AND an ABI/1 document was not refused as a
// downgrade, because judge.mjs refuses that only when want.runtime is given. So a manager started
// the normal way silently accepted exactly what the ABI/2 binding exists to prevent - while the
// record-to-route case was green, because it constructs the Manager directly.
//
// A path, not a hash: the hash is derived from the identity so the two cannot disagree.
const runtimeIdentityPath = env("ENCLAVE_RUNTIME_IDENTITY");
let runtime = null;
if (runtimeIdentityPath) {
  runtime = JSON.parse(fs.readFileSync(runtimeIdentityPath, "utf8"));
  const derived = Buffer.from(runtimeIdOf(runtime)).toString("hex");
  // If a RuntimeID was ALSO configured, they must agree. Two independently supplied values that
  // must match are two values that will eventually not, and the one that silently wins decides
  // what every domain is judged against.
  // A stale ENCLAVE_RUNTIME_ID must not take the manager down, and it must not silently win either.
  // The identity is the input; the hash is derived from it, and DERIVED WINS - but a disagreement
  // is said loudly, because an operator who set that variable believed they were pinning something
  // and a silent no-op is the failure family this whole lane has been about. (enclave-99's spec:
  // ENCLAVE_RUNTIME_ID stops being an input. Agreed - with the warning, not without it.)
  if (runtimeId && runtimeId.toLowerCase() !== derived) {
    console.error(`[winmgr] WARNING: ENCLAVE_RUNTIME_ID is ${runtimeId}, which is NOT what the identity at `
      + `${runtimeIdentityPath} derives (${derived}). The identity wins and that variable is ignored; `
      + "remove it, because it pins nothing.");
  }
  console.log(`[winmgr] runtime identity ${runtime.name}/${runtime.version} ${runtime.execution} `
    + `${runtime.targetIsa} -> RuntimeID ${derived}`);
} else if (runtimeId) {
  // A hash alone cannot pin an identity: checkRuntime diffs the identity field by field, so a hash
  // here would reject every real document. Refusing beats judging nothing while looking configured.
  console.error("[winmgr] REFUSING TO START: ENCLAVE_RUNTIME_ID is set but ENCLAVE_RUNTIME_IDENTITY is not. "
    + "A RuntimeID hash cannot pin a runtime - the verifier compares the identity field by field - so this "
    + "manager would accept any admissible runtime and would not refuse an ABI/1 downgrade. "
    + "Set ENCLAVE_RUNTIME_IDENTITY to the image's runtime.json.");
  process.exit(2);
}

const manager = new Manager({ judgeReady: judgeRunning,
  runtime,
  runtimeId,
  fetchComponent,
  backend: new HyperVPartitionBackend({ launcher }),
});

// THE DATA PLANE. Without it a domain can be started and judged running and still have nothing to
// carry its traffic: the record names a relay port and nobody listens on the other side. It admits
// only a record that is `running` with appId, image, runtimeId, transportKeySha256 and relay all
// present, which is why those had to be real before this was worth starting (enclave-5d's
// createDataPlane, via dataPlaneFor).
const dataPort = Number(env("ENCLAVE_DATAPLANE_PORT", "0"));
let dp = null;
if (dataPort > 0) {
  const { dataPlaneFor } = await import("../datapath/node-bridge.mjs");
  dp = dataPlaneFor(manager);
  dp.server.listen(dataPort, "127.0.0.1", () => console.log(`[winmgr] data plane on 127.0.0.1:${dataPort}`));
  // A reclaimed domain's sessions must not outlive it: closeInstance is what makes a stop actually
  // stop carrying traffic, rather than leaving established connections to a partition that is gone.
  manager.onReclaim = (id, why) => { try { dp.closeInstance(id, why); } catch {} };
} else {
  console.log("[winmgr] no ENCLAVE_DATAPLANE_PORT: no data plane, so a running domain carries no traffic");
}

// Ask the host BEFORE answering anything about what it can do, then THE INVENTORY, before any /vms
// answer means anything (63's P1): the VMs a previous manager left running are recovered from their
// Notes, so "not in my memory" is never answered as "absent". Until this completes every /vms request
// is 503; a failed survey keeps it that way and is retried. (server.mjs startManager: shared with tests.)
const inv = await startManager(manager);
console.log(`[winmgr] inventory ${inv.state}` + (inv.state === "ready" ? `: recovered ${inv.recovered}, unattributed ${inv.unattributed}` : inv.error ? `: ${inv.error}` : ""));
if (inv.state === "failed") {
  const retry = setInterval(async () => { const r = await manager.recover(); if (r.state !== "failed") { clearInterval(retry); console.log(`[winmgr] inventory ${r.state} on retry`); } }, 30_000);
  retry.unref?.();
}
const h = manager.health();
createServer(manager).listen(port, "127.0.0.1", () => {
  console.log(`[winmgr] ${h.backend} on 127.0.0.1:${port} · canStart=${h.canStart}`
    + (h.canStart ? "" : " · " + (h.preflight?.checks || []).filter((c) => !c.ok).map((c) => c.name).join(", ")));
  console.log(`[winmgr] fetcher ${fetcherPath}`);
  if (!imagePath || !imageSha256)
    console.log("[winmgr] no ENCLAVE_GUEST_IGVM / ENCLAVE_GUEST_IGVM_SHA256: no launcher, so no domain can start");
});
// Re-ask periodically: the role can be enabled under a running manager, and canStart must follow.
setInterval(() => { manager.probe().catch(() => {}); }, 60_000).unref?.();
