// PID 1's hand-off in the CUSTODIAN image (replaces the metal image's /opt/metal/gsup.mjs; scripts/build-custodian-v2.mjs).
// Runs two processes and keeps them alive:
//   - the custodian (/opt/custodian/custodian.mjs, custody/v2/daemon.mjs) on :8787;
//   - the fleet-tunnel agent (/opt/metal/agent.mjs, unchanged from the metal image), which attaches to the relay by this
//     guest's SEV-SNP quote and forwards https://api.enclave.host/t/<name>/... to the custodian.
// Its inputs are fw_cfg's opt/org.enclave.custody JSON (unmeasured: name, public URL, VCEK), never the custodian's keys.
import fs from "node:fs";
import { spawn } from "node:child_process";

const FW = "/sys/firmware/qemu_fw_cfg/by_name/opt/org.enclave.custody/raw";
const log = (m) => { try { fs.writeFileSync("/dev/console", `[custodian-gsup] ${m}\n`); } catch { console.log(m); } };
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(FW, "utf8")); } catch (e) { log(`no host config (${e.message}); the custodian will refuse to start`); }
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/.test(String(cfg.tunnelName || "")) ? cfg.tunnelName : "custody-unnamed";
const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function keep(name, args, env) {
  let restarts = 0;
  const run = () => {
    const c = spawn("/usr/local/bin/node", args, { env: { PATH, NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt", ...env }, stdio: ["ignore", "inherit", "inherit"] });
    c.on("exit", (code, sig) => { restarts++; const d = Math.min(2000 * restarts, 30000); log(`${name} exited code=${code} sig=${sig}; restart in ${d} ms`); setTimeout(run, d); });
  };
  run();
}
keep("custodian", ["/opt/custodian/custodian.mjs"], {});
keep("agent", ["/opt/metal/agent.mjs"], {
  METAL_MODE: "snp", METAL_NAME: NAME, METAL_SUP_URL: "http://127.0.0.1:8787",
  METAL_RELAY_URL: String(cfg.relayUrl || "wss://api.enclave.host/v1/fleet-tunnel"),
  METAL_PUBLIC_URL: String(cfg.endpoint || ""), METAL_VCEK_B64: typeof cfg.vcek === "string" ? cfg.vcek : "",
  METAL_RAD_PORT: "8443", METAL_TUNNEL_TOKEN: "",
});
log(`custodian + tunnel agent "${NAME}" started`);
