#!/usr/bin/env node
/* Loopback entry point, wired for real. The supervisor reaches this over guestd-control/1.

   Everything the manager needs is constructed here and nowhere else: the bounded PowerShell
   runner, the WMI launcher with the guest image pinned BY HASH, and a CID-verified component
   fetcher. The manager then asks the host what it can actually do (probe) before it answers
   /health, so "canStart" is the host's answer rather than a configuration detail. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Manager, createServer } from "./server.mjs";
import { judgeRunning } from "./ready.mjs";
import { HyperVPartitionBackend } from "./backend.mjs";
import { WmiHyperVLauncher } from "./wmi-launcher.mjs";
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

const launcher = imagePath && imageSha256
  ? new WmiHyperVLauncher({ run: powershellRunner(), imagePath, imageSha256 })
  : null;
const manager = new Manager({ judgeReady: judgeRunning,
  runtimeId,
  fetchComponent,
  backend: new HyperVPartitionBackend({ launcher }),
});

await manager.probe();            // ask the host BEFORE answering anything about what it can do
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
