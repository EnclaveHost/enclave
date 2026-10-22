// PID 1's hand-off in the REWRAP image (replaces the metal image's /opt/metal/gsup.mjs; scripts/build-custody-rewrap.mjs).
// Runs the measured rewrap guest ONCE (custody/v2/rewrap-guest.mjs, /opt/rewrap/rewrap.mjs), never restarts it, then idles:
// the host reads the result and stops the VM. Its only input is fw_cfg, which the guest itself reads and verifies.
import fs from "node:fs";
import { spawn } from "node:child_process";

const log = (m) => { try { fs.writeFileSync("/dev/console", `[rewrap-gsup] ${m}\n`); } catch { console.log(m); } };
const c = spawn("/usr/local/bin/node", ["/opt/rewrap/rewrap.mjs"], {
  env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt" },
  stdio: ["ignore", "inherit", "inherit"] });
c.on("exit", (code, sig) => { log(`rewrap guest finished: code=${code} sig=${sig}; idle until the host stops this VM`); setInterval(() => {}, 1 << 30); });
