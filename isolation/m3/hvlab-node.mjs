// hvlab-node.mjs - the REAL NucBox node code path for an isolated deployment, run against local KVM guests.
//
// What is real (imported from the Windows owner's tree, HVLAB_NODE_TREE, e.g. a worktree of windows/isolation-manager):
//   windows/node/host.mjs        Host.ensureApp -> #isolationReconcile -> isolationPlan -> the manager; appZoneTarget
//   windows/node/appzone.mjs     the app zone: tunnel stream frames -> WebSocket unwrap -> isolationSplicer
//   windows/node/isolation-client.mjs, windows/vbslike/manager/server.mjs (+ ready.mjs: the readiness judgement)
//   windows/vbslike/datapath/{node-bridge,datapath}.mjs, isolation/m4/guestd/supervisor-splice.mjs (from that tree)
//   relay/tunnel.js              the relay's tunnel hub: spliceUpgrade turns /t/<box>/x/<id>/https into s+/sd/sx frames
//   the guests                   the NucBox guest initrd, booted by test-hv-local.sh as plain KVM guests (NOT Hyper-V)
// What stands in, and why:
//   KvmBackend (below)           the manager's launch backend: HCS/WMI need Windows. It loads the manager's derived
//                                bundle into a pre-booted guest (hvlab.py load, the monitor's own control port) and
//                                exposes the domain port through hvlab.py relay, as vbslike-host's relay does
//   the agent's frame dispatch   three lines of windows/node/agent.mjs (s+/sd/sx -> zone.onFrame; zone.send -> tunnel);
//                                agent.mjs itself needs the box's TPM to attach
//   the relay's secrets route    answers "no secrets" for every deployment, truthfully for these (none are staged);
//                                it does not verify the signature (the real relay does)
//   the browser                  TLS over a WebSocket to /t/<box>/x/<label>/https: what relay/relay.js sends
//
// SAFETY: the node's endpoint is a test origin, so its enclave id is not the runner of any real deployment; its dir has
// no operator key. #giveUp reads the chain (read-only) and releases only a lease THIS enclave holds: none here.
//
//   usage: HVLAB_NODE_TREE=<tree> HVLAB_JUDGE=<judge-hv.mjs> HVLAB_RUNTIME=<runtime.json> \
//          node hvlab-node.mjs <hvlab state dir> <guest image> <cid A> <cid B>
import http from "node:http";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = process.env.HVLAB_NODE_TREE;
const [stateDir, imagePath, cidA, cidB] = process.argv.slice(2);
if (!T || !cidB) { console.error("usage: HVLAB_NODE_TREE=<tree> node hvlab-node.mjs <state dir> <image> <cid A> <cid B>"); process.exit(2); }
const imp = (rel) => import(pathToFileURL(path.join(T, rel)).href);
// On the box ipfs_fetch.py is deployed beside windows/node/fetch-cid.py; in a checkout it is wasm/ipfs_fetch.py.
process.env.PYTHONPATH = [path.join(T, "wasm"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
const sha = (b) => createHash("sha256").update(b).digest("hex");
let failed = 0;
const record = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };

// the tree's own copies of the bridge must be the bytes this checkout publishes (a stale copy is named, not hidden)
const MINE = path.join(HERE, "..", "..");
for (const rel of ["windows/vbslike/datapath/node-bridge.mjs", "windows/vbslike/datapath/datapath.mjs", "isolation/m4/guestd/supervisor-splice.mjs"]) {
  const have = sha(fs.readFileSync(path.join(T, rel))), want = sha(fs.readFileSync(path.join(MINE, rel)));
  record(`the node tree carries the published ${path.basename(rel)}`, have === want, `tree ${have.slice(0, 8)}, published ${want.slice(0, 8)}`);
}

const { Host } = await imp("windows/node/host.mjs");
// the node's host.init() resolves the address book before it touches a deployment; init() also registers the node,
// so the harness calls only the read-only half
const chain = await imp("windows/node/chain.mjs");
await chain.resolveAddresses();
const { appZone } = await imp("windows/node/appzone.mjs");
const { IsolationManagerClient } = await imp("windows/node/isolation-client.mjs");
const { Manager, createServer } = await imp("windows/vbslike/manager/server.mjs");
// the splicer and the data plane from the PUBLISHED bridge (this checkout): if the tree's copy is stale that is named
// above as a FAIL, and the path past it is still exercised with the bytes the tree is meant to carry
const { createIsolationSplicer, dataPlaneFor } = await import(pathToFileURL(path.join(HERE, "..", "..", "windows/vbslike/datapath/node-bridge.mjs")).href);
const { createTunnelHub } = await imp("relay/tunnel.js");
const { runtimeId } = await imp("isolation/contract/runtime.mjs");
const { WebSocket, createWebSocketStream } = await import(pathToFileURL(path.join(T, "node_modules", "ws", "wrapper.mjs")).href);
const { privateKeyToAccount } = await import(pathToFileURL(path.join(T, "node_modules", "viem", "_esm", "accounts", "index.js")).href);
const expectRuntime = JSON.parse(fs.readFileSync(process.env.HVLAB_RUNTIME, "utf8"));
const launcherKey = execFileSync("python3", [path.join(HERE, "hvlab.py"), "pubkey", stateDir]).toString().trim();
const image = sha(fs.readFileSync(imagePath));

// ---- the manager, with a KVM launch backend -------------------------------------------------------------------------
const guests = [Number(cidA), Number(cidB)];
const relays = [];
class KvmBackend {
  // it stands in for the NucBox launch backend, so it answers to that backend's name; its boundary says what it is
  get backend() { return "hyperv-partition-per-app"; }
  get supports() { return { gpu: false, secrets: false, egress: false, config: false, ports: false }; }
  get boundary() { return { tier: "T0-hv", hostExcluded: false, partition: "kvm-plain-fixture (hvlab, NOT Hyper-V)" }; }
  async preflight() { return { ok: true, checks: [], boundary: this.boundary }; }
  async start(mapping, { instanceId }) {
    const cid = guests.shift();
    if (!cid) throw new Error("no free KVM guest");
    const bundle = mapping.bundle || mapping.bundleBytes;
    const file = path.join(os.tmpdir(), `hvnode-${instanceId}.bundle`);
    fs.writeFileSync(file, Buffer.from(bundle));
    const ans = JSON.parse(execFileSync("python3", [path.join(HERE, "hvlab.py"), "load", stateDir, String(cid), file, instanceId]).toString());
    fs.rmSync(file, { force: true });
    if (ans.appSha256 !== mapping.appId) throw new Error(`hash disagreement: manager ${mapping.appId} guest ${ans.appSha256}`);
    const tcpPort = 18460 + cid % 100;
    const r = spawn("python3", ["-u", path.join(HERE, "hvlab.py"), "relay", String(cid), String(ans.port), String(tcpPort)], { stdio: "ignore" });
    relays.push(r);
    await new Promise((res) => setTimeout(res, 400));
    // the handle the HCS backend returns carries its BOUNDARY verbatim (the manager takes the record's tier from it):
    // d1's own constant, with only the partition label saying what this stand-in is
    return { name: instanceId, vmId: `hvlab-cid-${cid}`, appId: mapping.appId, tcpPort, guestPort: ans.port, image,
             launcherKey, guest: { booted: true }, boundary: { ...HCS_BOUNDARY, partition: "kvm-plain-fixture (hvlab, NOT Hyper-V)" } };
  }
  async stop() { return { stopped: true }; }
}
const components = {};
for (const f of ["hello.wasm", "hookbin.wasm"]) {
  const p = path.join(process.env.HVLAB_WASM_DIR || os.homedir() + "/enclave-bench/hvguest", f);
  if (fs.existsSync(p)) components[f] = fs.readFileSync(p);
}
const byCid = { bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza: components["hello.wasm"],
                bafkreidocbixnql7lroykdtwx4r2fmi5n6sra4lj7b7vhscsfqn4gctlee: components["hookbin.wasm"] };
// wired as the manager's main.mjs wires it: judgeReady is ready.mjs's judgeRunning (the constructor's own default is
// null, which leaves every record `starting`)
const { judgeRunning } = await imp("windows/vbslike/manager/ready.mjs");
const { BOUNDARY: HCS_BOUNDARY } = await imp("windows/vbslike/manager/backend-hcs.mjs");
const manager = new Manager({ backend: new KvmBackend(), runtime: expectRuntime, judgeReady: judgeRunning,
                              fetchComponent: async (cid) => { if (!byCid[cid]) throw new Error(`no local bytes for ${cid}`); return byCid[cid]; } });
const mgrSrv = createServer(manager); mgrSrv.listen(0, "127.0.0.1"); await once(mgrSrv, "listening");
const managerBase = `http://127.0.0.1:${mgrSrv.address().port}`;
// the manager's main.mjs hook 4, as two lines: its data plane over its own records
const dp = dataPlaneFor(manager); dp.server.listen(0, "127.0.0.1"); await once(dp.server, "listening");
const dataAddr = `127.0.0.1:${dp.server.address().port}`;

// ---- the relay: the secrets route (fixture) and the tunnel hub (real) ------------------------------------------------
const TOKEN = randomBytes(16).toString("hex"), BOX = "hvlab-node";
const hub = createTunnelHub({ allow: [{ name: BOX, tokenSha256: sha(TOKEN) }] });
const secretsAsked = [];
const relaySrv = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/secrets/fetch") {
    let b = ""; for await (const c of req) b += c;
    const j = JSON.parse(b); secretsAsked.push(j.id);
    res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ id: j.id, env: {}, rev: 0 }));
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

// ---- the node: the real Host and app zone, and the agent's three-line frame dispatch --------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvnode-"));
const op = privateKeyToAccount("0x" + randomBytes(32).toString("hex"));
const logs = [];
const host = new Host({ dir, endpoint: `https://api.enclave.test/t/${BOX}`, name: BOX, appsEnabled: true, appZone: "app.enclave.host",
  relayBase, gateway: process.env.IPFS_GATEWAY || "https://ipfs.enclave.host", python: "python3",
  isolationManager: managerBase, isolationRuntimeId: runtimeId(expectRuntime).toString("hex"), isolationDataAddr: dataAddr,
  secretsSign: (m) => op.signMessage({ message: m }), log: (m) => logs.push(m) });
let tunnel;
const zone = appZone({ send: (o) => tunnel.send(JSON.stringify(o)), resolve: (id) => host.appZoneTarget(id), pressure: () => 0,
  serveHttp: async () => ({ status: 502, headers: {}, body: "" }), log: (m) => logs.push(`[app-zone] ${m}`),
  isolationSplicer: createIsolationSplicer({ client: new IsolationManagerClient({ base: managerBase }), dataAddr }) });
tunnel = new WebSocket(`${relayBase.replace("http", "ws")}/v1/fleet-tunnel`, { headers: { "x-metal-name": BOX, "x-metal-token": TOKEN } });
tunnel.on("message", (m) => { const f = JSON.parse(m); if (f.t === "s+" || f.t === "sd" || f.t === "sx") zone.onFrame(f); else if (f.t === "ping") tunnel.send('{"t":"pong"}'); });
await once(tunnel, "open");
tunnel.send(JSON.stringify({ t: "hello", name: BOX, mode: "vbs", publicUrl: `${relayBase}/t/${BOX}` }));

// ---- two representative deployments, driven through the node's own ensureApp -----------------------------------------
const AGENT = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
const deps = {
  A: { id: "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e", appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4", appPort: 8080 },
  B: { id: "0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76", appRef: "catalog://0xf7e65a8fdae1dd9f8c2a897f2f372cdb7f6150d1e20526fa06d10a682cc2e9e3/4", appPort: 8000 },
};
record("SAFETY: this node's enclave id is a test id, not a deployment's runner", /^0x[0-9a-f]{64}$/.test(host.enclaveId) && !fs.existsSync(path.join(dir, "operator.key")),
  `enclaveId ${host.enclaveId.slice(0, 18)}..., no operator key in ${dir}`);
const ledgerOf = (d) => ({ id: d.id, appRef: d.appRef, cpuMilli: 100, gpuMilli: 0, isPublic: true, owner: AGENT,
                           leaseUntil: Math.floor(Date.now() / 1000) + 3600, appPort: d.appPort,
                           configCid: JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } }) });
async function drive(label) {
  const out = {};
  for (const [k, d] of Object.entries(deps)) {
    out[k] = await host.ensureApp(d.id, ledgerOf(d)).catch((e) => ({ status: "threw", reason: e.message }));
    console.log(`${label} ensureApp ${k} ${d.id.slice(0, 10)}: status=${out[k] && out[k].status} reason=${JSON.stringify(out[k] && out[k].reason)}`);
  }
  // the manager judges readiness behind its answer; wait for it, then reconcile once more as the node's tick would
  await Promise.all([...(manager.judging?.values?.() || [])]).catch(() => {});
  for (const [k, d] of Object.entries(deps))
    if (out[k] && out[k].status === "provisioning") out[k] = await host.ensureApp(d.id, ledgerOf(d)).catch((e) => ({ status: "threw", reason: e.message }));
  return out;
}
// PASS 1, the node as configured for isolation and nothing else: this is the real behaviour
let results = await drive("[as configured]");
for (const v of (manager.list ? manager.list() : [])) console.log(`manager record ${v.id} (${String(v.name).slice(0, 10)}): status=${v.status} verdict=${v.verdict} reason=${JSON.stringify(v.reason)}`);
for (const [k] of Object.entries(deps))
  record(`ensureApp ${k} (${k === "A" ? "hello-world /1" : "hookbin /2"}) reaches running through the node's own path, AS CONFIGURED`,
    results[k] && results[k].status === "running", `status=${results[k] && results[k].status} reason=${JSON.stringify(results[k] && results[k].reason)}`);
// PASS 2, only if pass 1 stopped at the in-enclave runtime gates (appsInTee / the enclave's worlds), which should not
// apply to a partition: set the flags that open those gates, CLEARLY A WORKAROUND - this box has no in-enclave app
// runtime - so the rest of the chain is exercised anyway. The run still FAILS while pass 1 does.
if (Object.values(results).some((r) => /no app runtime|enclave has no socket|this box runs an app INSIDE/.test(String(r && r.reason)))) {
  console.log("WORKAROUND for the in-enclave runtime gates: cfg.enclaveAppAbi=1, cfg.enclaveAppWorlds=7 (NOT a real enclave runtime)");
  host.cfg.enclaveAppAbi = 1; host.cfg.enclaveAppWorlds = 7;
  for (const d of Object.values(deps)) { host.blocked?.delete?.(d.id); host.records.delete(d.id); }
  results = await drive("[workaround]");
  for (const [k] of Object.entries(deps))
    console.log(`${results[k] && results[k].status === "running" ? "PASS" : "FAIL"} (workaround) ensureApp ${k} reaches running: status=${results[k] && results[k].status} reason=${JSON.stringify(results[k] && results[k].reason)}`);
}

// PASS 3, the steps of host.mjs #isolationReconcile called directly, because at this tree ensureApp never reaches
// them: the CURRENT plan (this checkout's node-bridge, with require/manager/appConfigCid) -> the node's real
// IsolationManagerClient + isolation-lifecycle reconcile -> the real manager's spawn and readiness judgement -> the
// record #isolationReconcile writes -> the real appZoneTarget/appzone below.
if (Object.values(results).some((r) => !r || r.status !== "running")) {
  console.log("PASS 3: #isolationReconcile's own steps, called directly (ensureApp does not reach them at this tree)");
  const { reconcile } = await imp("windows/node/isolation-lifecycle.mjs");
  const { fetchSecrets } = await imp("windows/node/secrets.mjs");
  const { isolationPlan } = await import(pathToFileURL(path.join(MINE, "windows/vbslike/datapath/node-bridge.mjs")).href);
  const client = new IsolationManagerClient({ base: managerBase });
  for (const [k, d] of Object.entries(deps)) {
    const led = ledgerOf(d);
    const v = await chain.resolveAppRef(d.appRef);                                  // the real catalog version
    const env = JSON.parse(led.configCid);                                          // the deployment's options envelope
    const sec = await fetchSecrets({ id: d.id, endpoint: host.cfg.endpoint, sign: host.cfg.secretsSign, base: relayBase });
    let volumes = null;
    try { const c = v.config ? JSON.parse(v.config) : {}; volumes = Array.isArray(c.volumes) ? c.volumes : []; } catch {}
    const plan = isolationPlan({ deploymentId: d.id, deployment: led, version: v, appConfig: await host.appConfigResolved(led, v),
      hasSecrets: sec.count > 0, waf: env.waf || {}, volumes, runtimeId: host.cfg.isolationRuntimeId,
      require: env.isolation && env.isolation.require, manager: await client.health().catch(() => null),
      appConfigCid: env.configCid || "" });
    record(`pass 3 plan ${k} (${k === "A" ? "hello-world /1" : "hookbin /2"})`,
      k === "A" ? plan.ok : (plan.ok || plan.input === "manager.catalog.derivations"),
      plan.ok ? `${plan.derivation}, record ${sha(JSON.stringify(plan.spawn.derive)).slice(0, 8)}` : `refused ${plan.input}: ${plan.why}`);
    if (!plan.ok) { results[k] = { status: "refused", reason: `${plan.input}: ${plan.why}` }; continue; }
    const body = IsolationManagerClient.spawnBody(plan.spawn);
    let r;
    for (let i = 0; i < 90; i++) {
      r = await reconcile({ client, deployment: { id: d.id, body }, ledger: null });
      if (r.action !== "held" && r.instance && r.instance.status === "running") break;
      if (r.action === "failed") break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    const inst = (r && r.instance) || {};
    console.log(`pass 3 reconcile ${k}: action=${r && r.action} instance=${inst.id} status=${inst.status} verdict=${inst.verdict} image=${String(inst.image || "").slice(0, 16)} key=${String(inst.transportKeySha256 || "").slice(0, 16)} reason=${JSON.stringify(r && r.reason)}`);
    if (inst.id) console.log(`pass 3 the manager's own record for ${inst.id}: ${JSON.stringify(manager.get(inst.id)).slice(0, 600)}`);
    if (inst.status === "running") {
      // what #isolationReconcile's #record writes
      host.records.set(d.id, { ...(host.records.get(d.id) || {}), id: d.id, status: "running", reason: null,
        isolation: { backend: "hyperv-partition-per-app", instance: inst.id, appId: inst.appId ?? null, image: inst.image ?? null,
                     tier: inst.tier ?? null, hostExcluded: inst.hostExcluded === true, transportKeySha256: inst.transportKeySha256 ?? null } });
      results[k] = host.records.get(d.id);
    } else results[k] = { status: inst.status || (r && r.action), reason: r && r.reason };
    record(`pass 3 ${k}: the real manager spawns, judges readiness and reports running`, k === "B" || inst.status === "running",
      `status=${inst.status} verdict=${inst.verdict} hostExcluded=${inst.hostExcluded}`);
  }
}

// ---- a browser through the relay's tunnel to each app's own name ------------------------------------------------------
const { judge: judgeHv } = await import(pathToFileURL(process.env.HVLAB_JUDGE).href);
function browser(dep) {
  const label = dep.slice(2, 10);
  return new Promise((resolve) => {
    const ws = new WebSocket(`${relayBase.replace("http", "ws")}/t/${BOX}/x/0x${label}/https`);
    const up = createWebSocketStream(ws); up.on("error", () => {});
    const s = tls.connect({ socket: up, servername: `${label}.app.enclave.host`, rejectUnauthorized: false });
    s.once("error", (e) => resolve({ error: e.message }));
    s.once("secureConnect", () => {
      const spki = s.getPeerX509Certificate().publicKey.export({ type: "spki", format: "der" });
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); agent.createConnection = () => s;
      const req = (method, p, body, headers = {}) => new Promise((res) => {
        const r = http.request({ agent, method, path: p, headers: { host: `${label}.app.enclave.host`, ...headers,
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } }, (a) => {
          const c = []; a.on("data", (x) => c.push(x)); a.on("end", () => res({ status: a.statusCode, body: Buffer.concat(c).toString() }));
        });
        r.on("error", (e) => res({ status: 0, body: e.message })); r.end(body);
      });
      resolve({ spki, req, close: () => s.destroy() });
    });
  });
}
for (const [k, d] of Object.entries(deps)) {
  if (results[k] && results[k].status === "refused") { console.log(`SKIP browser -> ${k}: the plan refused it (${results[k].reason})`); continue; }
  if (!results[k] || results[k].status !== "running") { record(`browser -> ${k}`, false, "not running; nothing to route"); continue; }
  const b = await browser(d.id);
  if (b.error) { record(`browser -> ${k} through relay tunnel -> app zone -> data plane -> partition`, false, b.error); continue; }
  const nonce = randomBytes(32);
  const at = await b.req("GET", `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`);
  let v = { verdict: "no document" };
  try { v = judgeHv({ doc: JSON.parse(at.body), spki: b.spki, nonce, expectedAppSha256: results[k].isolation?.appId, launcherKey, expectRuntime }); } catch {}
  record(`browser -> ${k} through relay tunnel -> app zone -> data plane -> partition: TLS ends in the domain`,
    v.verdict === "monitor-signed" && sha(b.spki) === results[k].isolation?.transportKeySha256,
    `${v.verdict} on the browser's own handshake key ${sha(b.spki).slice(0, 16)}...`);
  const r = k === "A" ? await b.req("GET", "/") : await b.req("POST", "/api/bins", null, { "x-bin-id": "nd" + randomBytes(3).toString("hex") });
  record(`${k}: the app answers on its own name`, r.status === 200, `${r.status} ${JSON.stringify(r.body.slice(0, 30))}`);
  b.close();
}
console.log(`secrets probed for: ${secretsAsked.map((x) => x.slice(0, 10)).join(", ") || "(none)"}`);
console.log(`data plane: ${JSON.stringify(dp.stats())}`);
for (const l of logs.filter((l) => /isolation|app-zone|giving up|plan|secrets/i.test(l)).slice(-25)) console.log(`  node: ${l.slice(0, 220)}`);
for (const r of relays) r.kill();
tunnel.close(); relaySrv.close(); dp.server.close(); mgrSrv.close();
console.log(failed ? `HVLAB-NODE ${failed} FAILED` : "HVLAB-NODE ALL PASS");
process.exit(failed ? 1 : 0);
