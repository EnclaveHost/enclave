#!/usr/bin/env node
/* Loopback entry point, wired for real. The supervisor reaches this over guestd-control/1.

   Everything the manager needs is constructed here and nowhere else: the bounded PowerShell
   runner, the WMI launcher with the guest image pinned BY HASH, and a CID-verified component
   fetcher. The manager then asks the host what it can actually do (probe) before it answers
   /health, so "canStart" is the host's answer rather than a configuration detail. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { Manager, createServer } from "./server.mjs";
import { HyperVPartitionBackend } from "./backend.mjs";
import { WmiHyperVLauncher } from "./wmi-launcher.mjs";
import { powershellRunner } from "./psrun.mjs";

const execFileP = promisify(execFile);
const env = (k, d = "") => (process.env[k] || d).trim();

const port        = Number(env("VMMGR_PORT", "8091"));
const imagePath   = env("ENCLAVE_GUEST_IGVM");          // e.g. C:\Users\claude\vbs-like\openhcl-ownguest.bin
const imageSha256 = env("ENCLAVE_GUEST_IGVM_SHA256");   // the bytes it must be; a path is not an identity
const runtimeId   = env("ENCLAVE_RUNTIME_ID");
const fetcher     = env("ENCLAVE_CID_FETCHER", path.join(process.cwd(), "fetch-cid.py"));
const python      = env("PYTHON_BIN", "python");

/* The platform's own CAR verifier, not a gateway GET: the bytes must be checked against the CID
   they claim to be before anything derives an AppID from them. Same script the node already uses. */
async function fetchComponent(cid) {
  if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120}|z[1-9A-HJ-NP-Za-km-z]{40,120})$/.test(String(cid)))
    throw new Error(`refusing to fetch ${JSON.stringify(cid)}: not a bare CID`);
  const { stdout } = await execFileP(python, [fetcher, "--cid", String(cid), "--stdout"],
                                     { encoding: "buffer", maxBuffer: 256 << 20 });
  if (!stdout || !stdout.length) throw new Error(`the fetcher returned no bytes for ${cid}`);
  return Buffer.from(stdout);
}

const launcher = imagePath && imageSha256
  ? new WmiHyperVLauncher({ run: powershellRunner(), imagePath, imageSha256 })
  : null;
const manager = new Manager({
  runtimeId,
  fetchComponent,
  backend: new HyperVPartitionBackend({ launcher }),
});

await manager.probe();            // ask the host BEFORE answering anything about what it can do
const h = manager.health();
createServer(manager).listen(port, "127.0.0.1", () => {
  console.log(`[winmgr] ${h.backend} on 127.0.0.1:${port} · canStart=${h.canStart}`
    + (h.canStart ? "" : " · " + (h.preflight?.checks || []).filter((c) => !c.ok).map((c) => c.name).join(", ")));
  if (!imagePath || !imageSha256)
    console.log("[winmgr] no ENCLAVE_GUEST_IGVM / ENCLAVE_GUEST_IGVM_SHA256: no launcher, so no domain can start");
});
// Re-ask periodically: the role can be enabled under a running manager, and canStart must follow.
setInterval(() => { manager.probe().catch(() => {}); }, 60_000).unref?.();
