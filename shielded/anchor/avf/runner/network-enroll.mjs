#!/usr/bin/env node
// network-enroll.mjs -- enroll the apps a pVM host serves into its Enclave-network agent (docs/design/enclave-network.md
// on main), the pVM's twin of network/reconcile-apps.mjs. Run beside the host agent:
//   node network-enroll.mjs --host-state <pvm-host state/host-state.json> --config <agent config.json> --apps-dir <dir>
//                           [--reload-unit <unit>] [--runtime-id <hex>] [--dry-run]
// The host agent's state names the deployments its slot VMs serve; once one serves with its certificate installed (the
// agent's local proof is a WebPKI TLS fetch of the VM's own evidence, through the host agent's SNI router), this writes
// the app's expectation (appRef and configCid exactly as the ledger has them, the component's SHA-256 the VM attests, the
// pinned runtime) and adds the app to the config; its route is the owner's network policy, which the agent reads.
// Nothing is removed: a lease that ends ends its admission.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const DRY = argv.includes("--dry-run");
// the privacy agent re-reads its app list (each app's expectation, names and any new app) only on SIGHUP: --reload-unit
// names its systemd --user unit, signalled after every change here. Without it a config edit (a new configCid in the
// expectation) left the route withdrawn ("no matching current app expectation") until a restart: measured 2026-10-09.
const RELOAD_UNIT = arg("--reload-unit");
const reload = async (why) => {
  if (!RELOAD_UNIT || DRY) return;
  await new Promise((r) => execFile("systemctl", ["--user", "kill", "-s", "HUP", RELOAD_UNIT], (e) => { log(e ? `reload ${RELOAD_UNIT}: ${e.message}` : `${RELOAD_UNIT} told to re-read its apps (${why})`); r(); }));
};
const hostStateFile = arg("--host-state"), configFile = arg("--config"), appsDir = arg("--apps-dir"),
      runtimeId = arg("--runtime-id") || "d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba";
if (!hostStateFile || !configFile || !appsDir) {
  console.error("usage: network-enroll.mjs --host-state F --config F --apps-dir D [--reload-unit U] [--runtime-id H] [--dry-run]"); process.exit(2);
}
const log = (m) => console.log(`[network-enroll] ${m}`);
const writeAtomic = async (file, text, mode = 0o600) => { const t = file + ".tmp"; await fs.writeFile(t, text, { mode }); await fs.rename(t, file); };

const host = JSON.parse(await fs.readFile(hostStateFile, "utf8"));
// every app the host's slots serve (one VM each); the one-VM agent's `current` is read too
const served = [...Object.values(host.slots || {}), host.current].filter(Boolean);
const cfg = JSON.parse(await fs.readFile(configFile, "utf8"));
if (!cfg.enclaveNetwork) { console.error("the agent config has no enclaveNetwork section (docs/design/enclave-network.md)"); process.exit(2); }
let reloadWhy = null, cfgChanged = false;
/** One app: its expectation kept current; a new one added to the config. */
async function enroll(cur) {
  if (cur.phase !== "serving" || !cur.cert || !/^0x[0-9a-f]{64}$/.test(cur.id || "")) { log(`${String(cur.id).slice(2, 10)}: not serving with a certificate yet`); return; }
  if (typeof cur.configCid !== "string" || !cur.appRef || !/^[0-9a-f]{64}$/.test(cur.sha || "")) { log(`${String(cur.id).slice(0, 10)}: the host state lacks appRef/configCid/sha; the agent records them when it takes a deployment`); return; }
  const id = cur.id, label = id.slice(2, 10), names = [`${label}.app.enclave.host`];
  const expected = { appRef: cur.appRef, configCid: cur.configCid, appSha256: cur.sha, runtimeId };
  const existing = cfg.apps.find((a) => a.deploymentId === id);
  const dir = path.join(appsDir, id);
  if (existing) {
    const have = JSON.parse(await fs.readFile(existing.expectedFile, "utf8").catch(() => "{}"));
    if (JSON.stringify(have) === JSON.stringify(expected)) { log(`${label}: enrolled`); return; }
    log(`${label}: the expectation changed (${String(have.appSha256).slice(0, 8)} -> ${expected.appSha256.slice(0, 8)})`);
    if (!DRY) await writeAtomic(existing.expectedFile, JSON.stringify(expected, null, 2));
    reloadWhy = "an expectation changed";
    return;
  }
  log(`${label}: enrolling ${names.join(", ")}`);
  if (DRY) return;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await writeAtomic(path.join(dir, "expected.json"), JSON.stringify(expected, null, 2));
  cfg.apps.push({ deploymentId: id, names, expectedFile: path.join(dir, "expected.json"), internetMode: "enclave-network", publishToMirror: true });
  cfgChanged = true; log(`${label}: enrolled on the Enclave network`); reloadWhy = "a new app";
}
if (!served.length) { log("nothing served yet"); process.exit(0); }
for (const cur of served) await enroll(cur);
if (cfgChanged) await writeAtomic(configFile, JSON.stringify(cfg, null, 1));
if (reloadWhy) await reload(reloadWhy);
