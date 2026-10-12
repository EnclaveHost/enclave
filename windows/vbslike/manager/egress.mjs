/* ============================================================
   OUTBOUND HTTPS FOR A SHIELD SECRET DOMAIN: the host's half, per partition.

   A partition has no NIC. A secret domain's front (isolation/m2/front shield_egress.go) derives its allowlist inside
   the guest from the measured config resolved with its released secrets, listens on 127.64.0.N:443 for each allowed
   origin, and carries each stream over AF_VSOCK to CID 2 port 9443 in the m2 egress-v1 protocol. On this host:

     shielded-bridge.exe <vmId> 9443 <port> 0    the SAME pinned bridge the Shield GPU path uses (unchanged): it binds
                                                 THIS partition's hv_sock service only and checks every peer's VmId
     shield-egress.exe -listen 127.0.0.1:0 ...   isolation/m2/cmd/shield-egress: m2's egress server, whose ONLY upstream
                                                 is the host's loopback SOCKS entry (or the deployment's own route); no
                                                 direct path, every resolved address judged public, outcome codes only

   Both are pinned by SHA-256 like every executable this manager runs, hashed again at each start, and supervised by
   stdin: closing it ends them. The partition lifecycle owns them (wmi-launcher.mjs startEgress): started after the VM
   runs and before the app is served, stopped on a failed start and on every stop. Feature OFF unless
   ENCLAVE_EGRESS_V1=1 (main.mjs), and then only for secret deployments (V6), the only domains whose front opens it.

   A WMI partition's hv_sock service must be registered under GuestCommunicationServices or the bridge's bind fails
   with 10013; the launcher's preflight READS that (EGRESS_SERVICE_GUID) and never writes the registry.

   This is NOT the spawn body's `egress` (Linux's dedicated-IP egress URL): server.mjs refuses that, and the node's
   PARTITION_OFFERS.egress / networkOptions are unchanged.
   ============================================================ */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";

export const EGRESS_VSOCK_PORT = 9443;
/** vsock port 9443 -> hv_sock service id (Linux hyperv_transport srv_id_template; host/src/hvsock.rs service_id). */
export const EGRESS_SERVICE_GUID = "000024e3-facb-11e6-bd58-64006a7986d3";
export const GCS_KEY = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Virtualization\\GuestCommunicationServices";

const SHA256 = /^[0-9a-f]{64}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPLOYMENT = /^0x[0-9a-f]{64}$/;

/** A loopback IPv4 literal and a port, nothing else: the SOCKS entry is this host's, and never a name. */
export function loopbackEntry(s) {
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(String(s || ""));
  return !!m && m.slice(1, 4).every((o) => Number(o) <= 255) && Number(m[4]) >= 1 && Number(m[4]) <= 65535;
}

/**
 * The egress configuration from the manager's environment, or null when the feature is off. Throws, naming every
 * missing or malformed setting, when ENCLAVE_EGRESS_V1=1 and the rest is incomplete: a half-configured egress is refused
 * at startup rather than guessed at.
 */
export function egressConfigFromEnv(env = process.env) {
  const v = (k) => String(env[k] || "").trim();
  if (v("ENCLAVE_EGRESS_V1") !== "1") return null;
  const cfg = { exe: v("ENCLAVE_EGRESS_EXE"), sha256: v("ENCLAVE_EGRESS_EXE_SHA256").toLowerCase(),
                bridgeExe: v("ENCLAVE_EGRESS_BRIDGE_EXE"), bridgeSha256: v("ENCLAVE_EGRESS_BRIDGE_EXE_SHA256").toLowerCase(),
                socks: v("ENCLAVE_EGRESS_SOCKS") || null, appRoutes: v("ENCLAVE_EGRESS_APP_ROUTES") || null,
                allow: v("ENCLAVE_EGRESS_ALLOW") || null };
  const miss = [!cfg.exe && "ENCLAVE_EGRESS_EXE", !SHA256.test(cfg.sha256) && "ENCLAVE_EGRESS_EXE_SHA256 (64 hex)",
                !cfg.bridgeExe && "ENCLAVE_EGRESS_BRIDGE_EXE", !SHA256.test(cfg.bridgeSha256) && "ENCLAVE_EGRESS_BRIDGE_EXE_SHA256 (64 hex)"]
    .filter(Boolean);
  if (!!cfg.socks === !!cfg.appRoutes) miss.push("exactly one of ENCLAVE_EGRESS_SOCKS (127.x.y.z:port) or ENCLAVE_EGRESS_APP_ROUTES");
  if (cfg.socks && !loopbackEntry(cfg.socks)) miss.push(`ENCLAVE_EGRESS_SOCKS must be a loopback IPv4 literal and port, not ${JSON.stringify(cfg.socks)}`);
  if (miss.length) throw new Error(`ENCLAVE_EGRESS_V1=1 needs ${miss.join(", ")}`);
  cfg.mode = cfg.socks ? "socks" : "app-routes";
  return cfg;
}

/** The executable's bytes are its pin, or nothing starts. */
export function checkPin(exe, sha256, what) {
  let got;
  try { got = createHash("sha256").update(fs.readFileSync(exe)).digest("hex"); }
  catch (e) { throw new Error(`${what} cannot be read at ${exe}: ${e.message}`); }
  if (got !== sha256) throw new Error(`${what} at ${exe} hashes ${got}, not its pin ${sha256}`);
  return got;
}

/**
 * One supervised child: resolves when `ready` matches its stdout, rejects on exit, error or timeout. Its output is
 * always drained (a full pipe would stall it) and only a bounded tail is kept, for the error message.
 */
function supervise(child, ready, what, timeoutMs) {
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
  child.once("error", (e) => resolveExit({ error: e.message }));
  let out = "", err = "";
  child.stdout.on("data", (b) => { out = (out + b).slice(-1000); });
  child.stderr.on("data", (b) => { err = (err + b).slice(-1000); });
  const stop = async () => {
    child.stdin.destroy();                       // EOF: the child ends itself, and with it every stream it carries
    const timer = setTimeout(() => child.kill(), 2000); timer.unref?.();
    await exited; clearTimeout(timer);
  };
  const up = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} readiness timed out`)), timeoutMs);
    const finish = (e, m) => { clearTimeout(timer); e ? reject(e) : resolve(m); };
    child.once("error", (e) => finish(e));
    const look = () => { const m = ready.exec(out); if (m) finish(null, m); };
    child.stdout.on("data", look);
    exited.then((x) => finish(new Error(`${what} exited (${x.code ?? x.signal ?? x.error}): ${err.trim().slice(-300)}`)));
  });
  return { exited, stop, up };
}

/**
 * Start a partition's egress path: shield-egress first (it picks a free loopback port and says which), then the bridge
 * for THIS partition's 9443 service to that port. Returns { exited, stop, port }: `exited` settles when EITHER child
 * ends (the path is then gone, and the caller fails the domain), and `stop` ends both, bridge first. Anything that fails
 * stops what was started before it rethrows.
 */
export async function startEgress({ cfg, vmId, deploymentId = null, spawn = nodeSpawn, readyTimeoutMs = 10_000 }) {
  if (!cfg) throw new Error("egress is not configured");
  if (!GUID.test(String(vmId || "")) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(vmId)) throw new Error(`not a partition id: ${vmId}`);
  if (cfg.appRoutes && !DEPLOYMENT.test(String(deploymentId || "")))
    throw new Error("a per-app route needs the deployment's id (0x + 64 hex)");
  checkPin(cfg.exe, cfg.sha256, "the shield-egress executable");
  checkPin(cfg.bridgeExe, cfg.bridgeSha256, "the shielded-bridge executable");
  const args = ["-listen", "127.0.0.1:0", ...(cfg.socks ? ["-socks", cfg.socks] : ["-app-routes", cfg.appRoutes, "-deployment", deploymentId]),
                ...(cfg.allow ? ["-allow", cfg.allow] : [])];
  const opts = { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] };
  const server = supervise(spawn(cfg.exe, args, opts), /shield-egress ready listen=127\.0\.0\.1:(\d{1,5})\b/, "shield-egress", readyTimeoutMs);
  let bridge = null;
  try {
    const port = Number((await server.up)[1]);
    if (!(port >= 1 && port <= 65535)) throw new Error("shield-egress named no usable port");
    bridge = supervise(spawn(cfg.bridgeExe, [vmId, String(EGRESS_VSOCK_PORT), String(port), "0"], opts),
                       /shielded bridge ready/, "the egress bridge", readyTimeoutMs);
    await bridge.up;
    const exited = Promise.race([server.exited.then((x) => ({ who: "shield-egress", ...x })),
                                 bridge.exited.then((x) => ({ who: "shielded-bridge", ...x }))]);
    return { port, exited, stop: async () => { await bridge.stop(); await server.stop(); } };
  } catch (e) {
    if (bridge) await bridge.stop();
    await server.stop();
    throw e;
  }
}
