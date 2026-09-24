#!/usr/bin/env node
// Loopback entry point. The supervisor reaches this over guestd-control/1, never directly.
import { Manager, createServer } from "./server.mjs";

const port = Number(process.env.VMMGR_PORT || 8091);
const manager = new Manager({ runtimeId: (process.env.ENCLAVE_RUNTIME_ID || "").trim() });
createServer(manager).listen(port, "127.0.0.1", () => {
  const h = manager.health();
  console.log(`[winmgr] ${h.backend} on 127.0.0.1:${port} · canStart=${h.canStart}`
    + (h.canStart ? "" : ` · ${h.cannotStart.absentHere.join(", ")} absent`));
});
