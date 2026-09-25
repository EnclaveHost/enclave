// host.mjs's side of the ee-host epoch: an apphandle that ee-host refuses as "stale epoch" means
// the app's ee-host boot is gone, exactly like "no such app" - so the request is answered
// app_gone AND the app is marked failed, which is what makes host.tick reload it. Without that
// mapping the refusal surfaces as a generic 502 enclave_error and the app stays "running" while
// every request to it fails.
//
// Driven the way it happens in production, with hostGen wired: a request is queued in the real
// funnel behind a slow command while its generation is still current (the local filter lets it
// through), ee-host restarts, and the queued apphandle reaches the NEW ee-host, which refuses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Host } from "../windows/node/host.mjs";
import { EnclaveApp } from "../windows/node/apprun.mjs";
import { makeHostCmd } from "../windows/node/appframe.mjs";
import { emuHost, restart } from "./helpers/ee-host-emu.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-stale-epoch-"));
const ID = "0xab";

test("a queued apphandle refused as stale epoch by the new ee-host is app_gone and marks the app for reload", async () => {
  const h1 = await emuHost();
  const hostCmd = makeHostCmd(h1.port, "127.0.0.1", 10_000);
  let gen = 1;
  const app = new EnclaveApp({ id: ID, cwasmPath: "x.cwasm", hostCmd, world: 2, hostGen: () => gen });
  await app.start();
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test",
                       appsEnabled: true, cpuPricePerSec6: 12, log: () => {} });
  h.records.set(ID, { id: ID, status: "running" });
  h.apps.set(ID, app);
  let h2;
  try {
    const ok = await h.proxy(ID, { method: "GET", pathRest: "/", headers: {}, ip: "1.1.1.1" });
    assert.equal(ok.status, 200, "the app serves while its ee-host boot is current");

    // A slow command holds the funnel inside the old ee-host; a request queues behind it while
    // the generation is still 1, so EnclaveApp's local filter lets it through.
    const held = h1.hold((l) => l === "appabi");
    const slow = hostCmd("appabi");
    await held.arrived;
    const pending = h.proxy(ID, { method: "GET", pathRest: "/", headers: {}, ip: "1.1.1.1" });

    h2 = await restart(h1, () => { gen = 2; });
    held.release();
    await slow;

    const r = await pending;
    assert.equal(r.status, 502);
    const body = JSON.parse(String(r.body));
    assert.equal(body.error, "app_gone", `a stale-epoch refusal is app_gone, not ${body.error}`);
    assert.match(body.message, /stale epoch/);
    assert.equal(app.state, "failed", "the app is marked failed so host.tick reloads it");
    assert.equal(h.records.get(ID).status, "failed");
    assert.match(h.records.get(ID).reason, /reloading/);
    assert.deepEqual(h2.refused.map((x) => x.cmd), ["apphandle"], "the new ee-host refused the queued request");
    assert.equal(h2.effects.length, 0, "and executed nothing for it");
  } finally { h1.close(); h2?.close(); }
});
