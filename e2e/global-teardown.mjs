// Kill everything global-setup started (anvil + relay by PID; the in-process
// stripe stub and site server die with the runner).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default async function globalTeardown() {
  const f = path.join(path.dirname(fileURLToPath(import.meta.url)), ".stack.json");
  try {
    const { pids } = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const pid of pids || []) { try { process.kill(pid, "SIGKILL"); } catch {} }
  } catch {}
  try { globalThis.__stack?.stripe?.close(); } catch {}
  try { globalThis.__stack?.site?.close(); } catch {}
}
