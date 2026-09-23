// ROLLOUT STEP 1 - capture the live guest (CPU, RAM, disk delta) to a NEW R2 key, leaving the
// config's snapshot object untouched. POST /snapshot blocks the app's event loop for the whole
// serialize + upload: the desktop and terminal FREEZE until it returns. Nothing on the node kills a
// frozen app (a failed liveness probe only skips a proof-of-time checkpoint).
// Usage: node rbsnapnow.mjs <s3 key> [level=1]    -> result appended to rbsnapnow.log
import fs from "node:fs";
import path from "node:path";
import { fetchSecrets } from "./secrets.mjs";
import { loadOperator } from "./chain.mjs";
const DIR = "C:\\Users\\claude\\vbs\\node", ID = "0xe64f7cba307e2d97485bde356d75564ccb74c5e31c272b5ab3349abfe122569b";
const LOG = path.join(DIR, "rbsnapnow.log");
const say = (s) => { const l = `${new Date().toISOString()} ${s}`; console.log(l); fs.appendFileSync(LOG, l + "\n"); };
const key = process.argv[2], level = Number(process.argv[3] || 1);
if (!key || /warm960-palette(-rt0)?\.snap$/.test(key)) { say(`refusing key ${key}: must be a NEW object, never the config's snapshot`); process.exit(2); }
const acct = loadOperator(path.join(DIR, "operator.key"));
const sec = await fetchSecrets({ id: ID, endpoint: "https://api.enclave.host/t/nucbox-k11",
                                 sign: async (m) => acct.signMessage({ message: m }), log: () => {} });
const KEY = sec.env.RISCBOX_API_KEY;              // never printed
const H = { "x-api-key": KEY, "content-type": "application/json" };
const pre = JSON.parse(await (await fetch("http://127.0.0.1:9822/status", { headers: H })).text());
say(`before: phase=${pre.phase} instances=${pre.instances?.count} retired=${pre.instret} footprint=${pre.instances?.footprintBytes}`);
if (pre.phase !== "running" || pre.instances?.count !== 1) { say("refusing: main must be running and alone (no forks)"); process.exit(3); }
say(`POST /snapshot key=${key} level=${level} - the loop is frozen until this returns`);
const t = Date.now();
try {
  const r = await fetch("http://127.0.0.1:9822/snapshot", { method: "POST", headers: H,
    body: JSON.stringify({ key, level }), signal: AbortSignal.timeout(3 * 3600 * 1000) });
  say(`HTTP ${r.status} after ${((Date.now() - t) / 1000).toFixed(0)} s: ${String(await r.text()).split(KEY).join("<redacted>").slice(0, 400)}`);
} catch (e) { say(`request ended after ${((Date.now() - t) / 1000).toFixed(0)} s: ${String(e.message).split(KEY).join("<redacted>")} (the app finishes regardless; check rbsnaplog.mjs)`); }
