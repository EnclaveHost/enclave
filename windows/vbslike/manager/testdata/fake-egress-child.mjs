// TEST SUPPORT ONLY: stands in for BOTH children of a partition's egress path (egress.mjs), protocol-exact on the lines
// the manager reads:
//   shield-egress  (argv starts with -listen): "shield-egress ready listen=127.0.0.1:<port> ..." on stdout
//   shielded-bridge (argv <vmId> 9443 <port> 0): "shielded bridge ready vm=<vmId> port=9443 worker=127.0.0.1:<port>"
// Each lives until its stdin ends, as both real ones do. FAKE_EGRESS_SERVER / FAKE_EGRESS_BRIDGE (env) make one misbehave:
//   exit       refuse at once (exit 2, a reason on stderr: the bridge's is the real bind failure, os error 10013)
//   hang       never say ready
//   die-later  say ready, then exit 1 after 150 ms
//   no-port    (server) a ready line naming no usable port
// FAKE_EGRESS_LOG (env): a file each child appends one JSON line to per event: {role, event, argv}.
import fs from "node:fs";

const argv = process.argv.slice(2);
const role = argv[0] === "-listen" ? "server" : "bridge";
const mode = (role === "server" ? process.env.FAKE_EGRESS_SERVER : process.env.FAKE_EGRESS_BRIDGE) || "ok";
const log = (event) => { if (process.env.FAKE_EGRESS_LOG) fs.appendFileSync(process.env.FAKE_EGRESS_LOG, JSON.stringify({ role, event, argv }) + "\n"); };
log("start");
if (mode === "exit") {
  process.stderr.write(role === "bridge" ? "Error: Os { code: 10013, kind: PermissionDenied }\n" : "shield-egress: -socks: SOCKS entry must be a loopback IP and nonzero port\n");
  log("exit"); process.exit(2);
}
if (mode !== "hang") {
  if (role === "server") process.stdout.write(mode === "no-port" ? "shield-egress ready listen=127.0.0.1:0 upstream=socks host-allow=0\n"
                                                                   : "shield-egress ready listen=127.0.0.1:41234 upstream=socks host-allow=0\n");
  else process.stdout.write(`shielded bridge ready vm=${argv[0]} port=${argv[1]} worker=127.0.0.1:${argv[2]}\n`);
}
if (mode === "die-later") setTimeout(() => { log("died"); process.exit(1); }, 150);
process.stdin.on("end", () => { log("stdin-eof"); process.exit(0); });
process.stdin.resume();
setInterval(() => {}, 1 << 30);
