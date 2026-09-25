// hvlab-accept.mjs - the acceptance run for ONE isolated deployment on a node: the node's own ensureApp to a browser's
// TLS session ending inside the partition, then the refusals, a forced relaunch, and a node restart. It drives a
// manager that is ALREADY RUNNING as its own process - on the NucBox, the Windows owner's manager (main.mjs) with its
// real launch backend; on this Linux host, hvlab-manager.mjs with plain KVM guests (NOT Hyper-V). It never boots,
// stops or reconfigures anything but the one instance it creates, and it removes that one at the end.
//
// Real (from HVACC_NODE_TREE, the node's tree): windows/node/host.mjs (ensureApp, appZoneTarget), appzone.mjs,
// isolation-client.mjs, isolation-lifecycle.mjs (retire), relay/tunnel.js (the relay's tunnel hub), the bridge's splicer.
// Stands in: the relay's secrets route (answers "no secrets", truthfully: none are staged for this deployment), the
// agent's three-line frame dispatch (agent.mjs needs the box's TPM to attach), and the browser.
//
//   HVACC_NODE_TREE      the node's tree (a worktree of windows/isolation-manager, or the box's deployed copy)
//   HVACC_MANAGER        the manager's base URL, e.g. http://127.0.0.1:7071
//   HVACC_DATA           the manager's data plane, e.g. 127.0.0.1:7072
//   HVACC_LAUNCHER_KEY   the key the launcher signs domain reports with (what the manager's judge was given), or
//                        "record": each instance's own, from the manager's record (wmiserve mints a new key per run).
//                        That key is a HOST STATEMENT, never a root: T0-hv trusts the host launcher by definition, and the
//                        host is not excluded. A run with =record proves the path works, not that anyone is excluded.
//   HVACC_JUDGE          judge-hv.mjs;  HVACC_RUNTIME  the image's runtime.json
//   optional: HVACC_DEPLOYMENT (default hello-world 0x4e62e60d...), HVACC_APPREF, HVACC_APPPORT, HVACC_PYTHON,
//             HVACC_TIMEOUT_S (per wait, default 300), IPFS_GATEWAY,
//             HVACC_EXPECT_HV_ISOLATION (none|vbs|snp|tdx|n/a): when set, the guest's own boundary tuple, served in
//             the attestation document, must state exactly that hv_isolation (a STATED configuration: it records
//             which partition type the run was on, it proves nothing and it never changes host_excluded=no)
//   usage: node hvlab-accept.mjs          last line: HVLAB-ACCEPT ALL PASS | HVLAB-ACCEPT <n> FAILED | HVLAB-ACCEPT REFUSED ...
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createHash, randomBytes, generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";

const E = (k, d) => { const v = process.env[k] || d; if (v === undefined) { console.error(`${k} is required`); process.exit(2); } return v; };
const T = E("HVACC_NODE_TREE"), MANAGER = E("HVACC_MANAGER"), DATA = E("HVACC_DATA"), LAUNCHER_KEY = E("HVACC_LAUNCHER_KEY");
const DEP = E("HVACC_DEPLOYMENT", "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e");
const APPREF = E("HVACC_APPREF", "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4");
const APPPORT = Number(E("HVACC_APPPORT", "8080")), WAIT_S = Number(E("HVACC_TIMEOUT_S", "300"));
const imp = (rel) => import(pathToFileURL(path.join(T, rel)).href);
process.env.PYTHONPATH = [path.join(T, "wasm"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };

const { Host } = await imp("windows/node/host.mjs");
const chain = await imp("windows/node/chain.mjs");
await chain.resolveAddresses();                       // the read-only half of host.init(); init() also registers a node
const { appZone } = await imp("windows/node/appzone.mjs");
const { IsolationManagerClient } = await imp("windows/node/isolation-client.mjs");
const { retire } = await imp("windows/node/isolation-lifecycle.mjs");
const { createIsolationSplicer } = await imp("windows/vbslike/datapath/node-bridge.mjs");
const { createTunnelHub } = await imp("relay/tunnel.js");
const { runtimeId } = await imp("isolation/contract/runtime.mjs");
const { WebSocket, createWebSocketStream } = await import(pathToFileURL(path.join(T, "node_modules", "ws", "wrapper.mjs")).href);
const { privateKeyToAccount } = await import(pathToFileURL(path.join(T, "node_modules", "viem", "_esm", "accounts", "index.js")).href);
const { judge } = await import(pathToFileURL(E("HVACC_JUDGE")).href);
const expectRuntime = JSON.parse(fs.readFileSync(E("HVACC_RUNTIME"), "utf8"));
const client = new IsolationManagerClient({ base: MANAGER });

// ---- SAFETY: only an instance this run creates is ever touched ---------------------------------------------------
const health = await client.health();
console.log(`manager ${MANAGER}: backend=${health.backend} canStart=${health.canStart} tier=${health.boundary?.tier} `
  + `hostExcluded=${health.boundary?.hostExcluded} partition=${JSON.stringify(health.boundary?.partition)} derivations=${JSON.stringify(health.catalog?.derivations)}`);
const pre = await client.findByName(DEP);
if (pre) {
  console.log(`the manager already holds ${pre.id} (${pre.status}) for ${DEP.slice(0, 10)}: this run did not create it and will not touch it`);
  console.log("HVLAB-ACCEPT REFUSED: the deployment already has an instance on this manager");
  process.exit(3);
}
const created = new Set();                           // instance ids this run caused, removed in cleanup

// ---- the relay's side: the secrets route (fixture) and the tunnel hub (real) ---------------------------------------
const TOKEN = randomBytes(16).toString("hex"), BOX = "hvacc-node";
const hub = createTunnelHub({ allow: [{ name: BOX, tokenSha256: sha(TOKEN) }] });
const relaySrv = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/secrets/fetch") {
    let b = ""; for await (const c of req) b += c;
    res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ id: JSON.parse(b).id, env: {}, rev: 0 }));
  }
  res.statusCode = 404; res.end("{}");
});
relaySrv.on("upgrade", (req, socket, head) => {
  if (req.url === "/v1/fleet-tunnel") return hub.handleUpgrade(req, socket, head);
  const m = /^\/t\/([^/]+)(\/x\/0x[0-9a-f]{8,64}\/https)$/.exec(req.url);
  if (m) return hub.spliceUpgrade(`tunnel://${m[1]}`, req, socket, head, m[2]);
  socket.destroy();
});
relaySrv.listen(0, "127.0.0.1"); await once(relaySrv, "listening");
const relayBase = `http://127.0.0.1:${relaySrv.address().port}`;

// ---- a node: the real Host + app zone, attached to the hub as the agent attaches (a restart = a fresh one) ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvacc-"));
const op = privateKeyToAccount("0x" + randomBytes(32).toString("hex"));
const logs = [];
async function startNode(tag) {
  const host = new Host({ dir, endpoint: `https://api.enclave.test/t/${BOX}`, name: BOX, appsEnabled: true, appZone: "app.enclave.host",
    relayBase, gateway: process.env.IPFS_GATEWAY || "https://ipfs.enclave.host", python: process.env.HVACC_PYTHON || "python3",
    isolationManager: MANAGER, isolationRuntimeId: runtimeId(expectRuntime).toString("hex"), isolationDataAddr: DATA,
    secretsSign: (m) => op.signMessage({ message: m }), log: (m) => logs.push(`[${tag}] ${m}`) });
  let tunnel;
  const zone = appZone({ send: (o) => tunnel.send(JSON.stringify(o)), resolve: (id) => host.appZoneTarget(id), pressure: () => 0,
    serveHttp: async () => ({ status: 502, headers: {}, body: "" }), log: (m) => logs.push(`[${tag} app-zone] ${m}`),
    isolationSplicer: createIsolationSplicer({ client: new IsolationManagerClient({ base: MANAGER }), dataAddr: DATA }) });
  tunnel = new WebSocket(`${relayBase.replace("http", "ws")}/v1/fleet-tunnel`, { headers: { "x-metal-name": BOX, "x-metal-token": TOKEN } });
  tunnel.on("message", (m) => { const f = JSON.parse(m); if (f.t === "s+" || f.t === "sd" || f.t === "sx") zone.onFrame(f); else if (f.t === "ping") tunnel.send('{"t":"pong"}'); });
  await once(tunnel, "open");
  tunnel.send(JSON.stringify({ t: "hello", name: BOX, mode: "vbs", publicUrl: `${relayBase}/t/${BOX}` }));
  await sleep(200);
  return { host, close: () => { try { tunnel.close(); } catch {} } };
}
const ledger = { id: DEP, appRef: APPREF, cpuMilli: 100, gpuMilli: 0, isPublic: true, owner: "0x29479bf04ed889d46a7afb7f292b9bb26e12647c",
                 leaseUntil: Math.floor(Date.now() / 1000) + 3600, appPort: APPPORT,
                 configCid: JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } }) };
// the node's tick calls ensureApp again while the manager judges readiness; this does the same, bounded
async function ensureRunning(host, opts, label) {
  const t0 = Date.now();
  let r = await host.ensureApp(DEP, ledger, opts).catch((e) => ({ status: "threw", reason: e.message }));
  while (r && r.status === "provisioning" && Date.now() - t0 < WAIT_S * 1000) {
    await sleep(2000);
    r = await host.ensureApp(DEP, ledger).catch((e) => ({ status: "threw", reason: e.message }));
  }
  const iso = (r && r.isolation) || {};
  if (iso.instance) created.add(iso.instance);
  console.log(`${label}: status=${r && r.status} after ${((Date.now() - t0) / 1000).toFixed(1)} s, instance=${iso.instance} `
    + `key=${String(iso.transportKeySha256 || "").slice(0, 16)} image=${String(iso.image || "").slice(0, 16)} tier=${iso.tier} `
    + `hostExcluded=${iso.hostExcluded} reason=${JSON.stringify(r && r.reason)}`);
  return r || {};
}

// a browser: TLS over a WebSocket to /t/<box>/x/<label>/https, what relay/relay.js sends for <label>.app.enclave.host
const LABEL = DEP.slice(2, 10);
function browser() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${relayBase.replace("http", "ws")}/t/${BOX}/x/0x${LABEL}/https`);
    const up = createWebSocketStream(ws); up.on("error", () => {});
    const s = tls.connect({ socket: up, servername: `${LABEL}.app.enclave.host`, rejectUnauthorized: false });
    const to = setTimeout(() => { s.destroy(); resolve({ error: "no TLS session in 30 s" }); }, 30_000);
    s.once("error", (e) => { clearTimeout(to); resolve({ error: e.message }); });
    s.once("secureConnect", () => { clearTimeout(to); resolve(session(s)); });
  });
}
function session(s) {
  const spki = s.getPeerX509Certificate().publicKey.export({ type: "spki", format: "der" });
  let closed = false; s.once("close", () => { closed = true; });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); agent.createConnection = () => s;
  const req = (method, p) => new Promise((res) => {
    if (closed) return res({ status: 0, body: "the session is closed" });
    const r = http.request({ agent, method, path: p, headers: { host: `${LABEL}.app.enclave.host` } }, (a) => {
      const c = []; a.on("data", (x) => c.push(x)); a.on("end", () => res({ status: a.statusCode, body: Buffer.concat(c).toString() }));
    });
    r.setTimeout(20_000, () => r.destroy(new Error("no answer in 20 s")));
    r.on("error", (e) => res({ status: 0, body: e.message })); r.end();
  });
  return { spki, keySha: sha(spki), req, isClosed: () => closed, close: () => s.destroy() };
}
// the verifier's judgement of a session: the document fetched ON that session, bound to its key and a fresh nonce, the
// app, the runtime identity, the launcher's key, and the guest image the manager's record names
let IMAGE, STATEMENT;
const KEY_FROM_RECORD = LAUNCHER_KEY === "record";
let LKEY = KEY_FROM_RECORD ? null : LAUNCHER_KEY;
// The launcher's (partition, guestImageKind) statement from the manager's OWN record (the node client's view drops it).
// A WMI partition's image is judged only as a pair with it (judge-hv, enclave-d1 + enclave-99 ae6e9147); the HCS lab's
// records state none, and are judged on the image as before.
async function rawRecord(id) {
  return await fetch(`${MANAGER.replace(/\/+$/, "")}/vms/${encodeURIComponent(id)}`).then((r) => r.json()).catch(() => null);
}
async function statementOf(id) {
  const gi = (await rawRecord(id))?.guestIdentity;
  return gi ? { partition: gi.partition, guestImageKind: gi.guestImageKind } : undefined;
}
// HVACC_LAUNCHER_KEY=record: the key THIS instance's reports are signed with, as the manager's record states it
async function useKeyOf(id) {
  if (!KEY_FROM_RECORD) return;
  const k = (await rawRecord(id))?.launcherKey;
  if (Buffer.from(String(k || ""), "base64").length !== 32) throw new Error(`the manager's record of ${id} names no launcherKey`);
  LKEY = k;
}
async function judged(b, appId, { spki = b.spki, nonceFor = null } = {}) {
  const nonce = randomBytes(32);
  const at = await b.req("GET", `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`);
  let v, doc = null;
  try { doc = JSON.parse(at.body);
        v = judge({ doc, spki, nonce: nonceFor || nonce, expectedAppSha256: appId, launcherKey: LKEY,
                    expectedImageSha256: IMAGE, ...(STATEMENT ? { expectedStatement: STATEMENT } : {}), expectRuntime }); }
  catch (e) { v = { verdict: "reject", reasons: [e.message] }; }
  return { ...v, why: (v.reasons || []).join("; "), guestBoundary: doc && typeof doc.boundary === "string" ? doc.boundary : null };
}
// the data plane's own admission, asked directly: one preamble line, its answer
function preamble(fields) {
  return new Promise((resolve) => {
    const [h, p] = DATA.split(":");
    const c = net.connect({ host: h, port: Number(p) });
    let got = "";
    c.on("data", (d) => { got += d.toString("latin1"); if (got.includes("\n")) { c.destroy(); resolve(got.split("\n")[0]); } });
    c.on("error", (e) => resolve(`error ${e.message}`)); c.on("close", () => resolve(got.split("\n")[0] || "closed without an answer"));
    c.write(`ENCLAVE-SPLICE/1 id=${fields.id} app=${fields.app} image=${fields.image} runtime=${fields.runtime} key=${fields.key}\n`);
  });
}
const rid = runtimeId(expectRuntime).toString("hex");
const other = () => sha(randomBytes(32));

let node = await startNode("node-1"), K1, I1, APP;
try {
  // ---- 1. the node's ensureApp takes the deployment to running --------------------------------------------------------
  const r1 = await ensureRunning(node.host, {}, "ensureApp");
  const iso1 = r1.isolation || {};
  record("ensureApp reaches running through the node's own path", r1.status === "running" && !!iso1.instance && /^[0-9a-f]{64}$/.test(iso1.transportKeySha256 || ""),
    `status=${r1.status} instance=${iso1.instance}`);
  record("the record's labels are this tier's: T0-hv, the host NOT excluded", iso1.tier === "T0-hv" && iso1.hostExcluded === false,
    `tier=${iso1.tier} hostExcluded=${iso1.hostExcluded}`);
  if (r1.status !== "running") throw new Error("not running; nothing further can be exercised");
  K1 = iso1.transportKeySha256; I1 = iso1.instance; APP = iso1.appId;
  const view1 = await client.get(I1);
  IMAGE = view1.image;
  STATEMENT = await statementOf(I1);
  await useKeyOf(I1);
  console.log(`the manager's view of ${I1}: ${JSON.stringify(view1).slice(0, 400)}; statement ${JSON.stringify(STATEMENT ?? null)}`);

  // ---- 2. a browser through the relay's tunnel, the app zone and the data plane: TLS ends in the domain ---------------
  const b1 = await browser();
  if (b1.error) record("browser -> the domain", false, b1.error);
  else {
    const v = await judged(b1, APP);
    record("browser -> tunnel -> app zone -> data plane -> domain: the session's key is the one the manager verified",
      v.verdict === "monitor-signed" && b1.keySha === K1, `${v.verdict} on the browser's handshake key ${b1.keySha.slice(0, 16)}, record ${K1.slice(0, 16)}`);
    // the guest's own tuple (the monitor's, relayed by the front): printed always, checked only when asked
    console.log(`the guest's boundary tuple: ${JSON.stringify(v.guestBoundary)}`);
    const wantIso = process.env.HVACC_EXPECT_HV_ISOLATION;
    if (wantIso) {
      const f = Object.fromEntries(String(v.guestBoundary || "").split(/\s+/).filter((x) => x.includes("=")).map((x) => x.split("=", 2)));
      record(`the guest states hv_isolation=${wantIso} (stated by the hypervisor, not a proof), and host_excluded=no`,
        f.hv_isolation === wantIso && f.host_excluded === "no", `hv_isolation=${f.hv_isolation} paravisor=${f.paravisor} host_excluded=${f.host_excluded}`);
    }
    const a = await b1.req("GET", "/");
    record("the app answers on its own name", a.status === 200, `${a.status} ${JSON.stringify(a.body.slice(0, 40))}`);

    // ---- 3. refusals: a verifier holding the wrong key, a replayed nonce, and the data plane's admission -------------
    const wrongSpki = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" });
    const vk = await judged(b1, APP, { spki: wrongSpki });
    record("a verifier that holds another key does not accept the document", vk.verdict !== "monitor-signed", `${vk.verdict}${vk.why ? ` (${vk.why})` : ""}`);
    const vn = await judged(b1, APP, { nonceFor: randomBytes(32) });
    record("a document for another nonce is not accepted (no replay)", vn.verdict !== "monitor-signed", `${vn.verdict}${vn.why ? ` (${vn.why})` : ""}`);
    const va = await judged(b1, sha(randomBytes(8)));
    record("a verifier expecting another app does not accept it", va.verdict !== "monitor-signed", `${va.verdict}${va.why ? ` (${va.why})` : ""}`);
    const good = { id: I1, app: APP, image: view1.image, runtime: rid, key: K1 };
    const cases = [
      ["the exact record (control: admitted)", good, /^OK$/],
      ["another transport key", { ...good, key: other() }, /^NO .*transport key/],
      ["another guest image", { ...good, image: other() }, /^NO .*guest image/],
      ["another app", { ...good, app: other() }, /^NO .*not that app/],
      ["another runtime", { ...good, runtime: other() }, /^NO .*runtime/],
      ["an instance the manager does not hold", { ...good, id: "hvacc-nonexistent" }, /^NO no such instance/],
    ];
    for (const [what, f, want] of cases) {
      const ans = await preamble(f);
      record(`data plane admission, ${what}`, want.test(ans), JSON.stringify(ans));
    }

    // ---- 4. a forced relaunch (a config edit, an artifact override): a fresh domain, a fresh key --------------------
    const r2 = await ensureRunning(node.host, { force: true }, "ensureApp {force:true}");
    const iso2 = r2.isolation || {};
    const K2 = iso2.transportKeySha256, I2 = iso2.instance;
    record("the forced relaunch reaches running on a NEW instance with a NEW transport key",
      r2.status === "running" && I2 && I2 !== I1 && /^[0-9a-f]{64}$/.test(K2 || "") && K2 !== K1, `instance ${I1} -> ${I2}, key ${K1.slice(0, 16)} -> ${String(K2).slice(0, 16)}`);
    const old = await client.get(I1).catch((e) => ({ error: e.message }));
    record("the manager no longer holds the old instance", old === null, JSON.stringify(old));
    if (old === null) created.delete(I1);
    const named = (await client.list()).filter((x) => x.name === DEP);
    record("exactly one instance carries this deployment's name", named.length === 1, named.map((x) => `${x.id}:${x.status}`).join(", "));
    // the session opened on the old domain must not outlive it
    let gone = b1.isClosed();
    for (let i = 0; !gone && i < 20; i++) { const x = await b1.req("GET", "/"); gone = b1.isClosed() || x.status === 0; if (!gone) await sleep(500); }
    record("the session opened on the old domain has ended", gone, gone ? "closed" : "STILL ANSWERING after the relaunch");
    const stale = await preamble({ ...good });
    record("the old route (old instance, old key) is refused", /^NO /.test(stale), JSON.stringify(stale));
    const view2 = await client.get(I2);
    await useKeyOf(I2);                                  // a relaunched domain's wmiserve signs with a NEW key
    const oldKey = await preamble({ id: I2, app: APP, image: view2.image, runtime: rid, key: K1 });
    record("the new instance under the OLD key is refused", /^NO .*transport key/.test(oldKey), JSON.stringify(oldKey));
    const b2 = await browser();
    if (b2.error) record("the browser reconnects", false, b2.error);
    else {
      const v2 = await judged(b2, APP);
      record("the browser reconnects: monitor-signed on the NEW key the manager verified", v2.verdict === "monitor-signed" && b2.keySha === K2,
        `${v2.verdict} on ${b2.keySha.slice(0, 16)}, record ${String(K2).slice(0, 16)}`);
      record("a client pinned to the old key sees a different key and must refuse", b2.keySha !== K1, `pinned ${K1.slice(0, 16)}, served ${b2.keySha.slice(0, 16)}`);
      const a2 = await b2.req("GET", "/");
      record("the app answers after the relaunch", a2.status === 200, `${a2.status}`);
      b2.close();
    }

    // ---- 5. the node restarts (a fresh Host, a fresh tunnel): it ADOPTS the running domain, it does not start another --
    node.close(); await sleep(500);
    node = await startNode("node-2");
    const r3 = await ensureRunning(node.host, {}, "ensureApp after a node restart");
    const iso3 = r3.isolation || {};
    record("after a node restart ensureApp adopts the SAME instance and key", r3.status === "running" && iso3.instance === I2 && iso3.transportKeySha256 === K2,
      `instance ${iso3.instance} key ${String(iso3.transportKeySha256).slice(0, 16)}`);
    const named3 = (await client.list()).filter((x) => x.name === DEP);
    record("still exactly one instance for the deployment", named3.length === 1, named3.map((x) => `${x.id}:${x.status}`).join(", "));
    const b3 = await browser();
    if (b3.error) record("the browser reconnects through the restarted node", false, b3.error);
    else {
      const v3 = await judged(b3, APP);
      record("the browser reconnects through the restarted node, on the same verified key", v3.verdict === "monitor-signed" && b3.keySha === K2,
        `${v3.verdict} on ${b3.keySha.slice(0, 16)}`);
      const a3 = await b3.req("GET", "/");
      record("the app answers through the restarted node", a3.status === 200, `${a3.status}`);
      b3.close();
    }
  }
} catch (e) {
  record("the run", false, e.message);
} finally {
  // ---- cleanup: the node's own retire path for every instance this run created; confirmed gone -----------------------
  for (const id of created) {
    const r = await retire({ client, deployment: { id: DEP }, ledger: null, instanceId: id }).catch((e) => ({ removed: false, reason: e.message }));
    const after = await client.get(id).catch(() => "unknown");
    record(`cleanup: instance ${id} retired and confirmed gone`, r.removed === true && after === null, `removed=${r.removed} reason=${JSON.stringify(r.reason)} after=${JSON.stringify(after)}`);
  }
  node.close(); relaySrv.close();
  for (const l of logs.filter((l) => /isolation|app-zone|giving up|plan|retire/i.test(l)).slice(-20)) console.log(`  node: ${l.slice(0, 220)}`);
  console.log(failed ? `HVLAB-ACCEPT ${failed} FAILED` : "HVLAB-ACCEPT ALL PASS");
  process.exit(failed ? 1 : 0);
}
