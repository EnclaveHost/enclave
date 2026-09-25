// A separate PROCESS that accepts a policy or stages an update through the client's durable store (client/src/store-file.js),
// pausing at a deterministic barrier between reading the state and committing: on its first read it writes
// <barrier>/<name>.reached (with the serial it read) and waits until the test creates <barrier>/<name>.go. Later reads (a
// retry after losing the compare-and-swap) do not pause. Test-only; the CLI never pauses.
//   node pvm-client-store-driver.mjs policy <storeDir> <policy.json> <barrierDir> <name> [nowMs]
//   node pvm-client-store-driver.mjs update <storeDir> <manifest.json> <artifact> <barrierDir> <name> <installDir> <currentVersion>
//   node pvm-client-store-driver.mjs activate <storeDir> <installDir> <barrierDir> <name> <cas|verified> <clientVersion>
//     cas: pauses inside the compare-and-swap (after the start check); verified: between reading the bytes and the start check
//   node pvm-client-store-driver.mjs launch <storeDir> <installDir> <barrierDir> <name> [run args...]
//     `run` under the active version, paused between reading+verifying its bytes and handing them to the child
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../../shielded/anchor/avf/client/src/store-file.js";
import { acceptPolicy } from "../../shielded/anchor/avf/client/src/client.js";
import { stageUpdate } from "../../shielded/anchor/avf/client/src/update.js";
import { activateStaged, launchActive } from "../../shielded/anchor/avf/client/src/activate.js";

const [mode, dir] = process.argv.slice(2, 4);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function holdAt(barrier, name) {
  let first = true;
  return async (state) => {
    if (!first) return; first = false;
    fs.writeFileSync(path.join(barrier, `${name}.reached`), JSON.stringify(state ? { serial: state.serial, releaseFp: state.releaseFp } : {}));
    while (!fs.existsSync(path.join(barrier, `${name}.go`))) await wait(10);
  };
}
const store = new FileStore(dir);
let r;
if (mode === "policy") {
  const [pf, barrier, name, now] = process.argv.slice(4);
  r = await acceptPolicy(store, JSON.parse(fs.readFileSync(pf, "utf8")), { hold: holdAt(barrier, name), ...(now ? { now: Number(now) } : {}) });
  r = { ok: r.ok, reason: r.reason, serial: r.serial, gen: r.gen };
} else if (mode === "update") {
  const [mf, af, barrier, name, installDir, currentVersion] = process.argv.slice(4);
  r = await stageUpdate(store, JSON.parse(fs.readFileSync(mf, "utf8")), new Uint8Array(fs.readFileSync(af)), { dir: installDir, currentVersion, hold: holdAt(barrier, name) });
} else if (mode === "activate") {
  const [installDir, barrier, name, where, clientVersion] = process.argv.slice(4);
  const h = holdAt(barrier, name);
  r = await activateStaged(store, { dir: installDir, clientVersion, ...(where === "cas" ? { hold: h } : { afterVerify: () => h(null) }) });
} else if (mode === "launch") {
  const [installDir, barrier, name, ...args] = process.argv.slice(4);
  r = await launchActive(store.latest().state.active, { dir: installDir, stateDir: store.dir, args, hold: () => holdAt(barrier, name)(null) });
}
process.stdout.write(JSON.stringify(r) + "\n");
