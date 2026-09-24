// hvlab-route.mjs - the whole caller path for a deployment the NucBox node runs as a partition, with real processes,
// on this KVM host (NOT Hyper-V; see test-hv-local.sh):
//
//   a browser-shaped TLS client (SNI <label>.app.enclave.host)
//   -> the relay's splice half (isolation/m4/guestd/testdata/relay-fixture.mjs: raw bytes as WebSocket frames to
//      /x/<id>/https, the production relay contract)
//   -> an app-zone stand-in: upgrade, unwrap, isolatedTarget + createIsolationSplicer().serve()
//      (windows/vbslike/datapath/node-bridge.mjs - what windows/node/appzone.mjs + host.mjs will call; the stand-in
//      exists only because that hook is enclave-d1's and not written yet)
//   -> the manager's data plane, dataPlaneFor(manager), enclave-splice/1, looking up manager-shaped records built
//      from the REAL load answers and a REAL readiness judgement (the key the verifying handshake saw)
//   -> the launcher stand-in's relay (hvlab.py) -> the guest's domain port -> the domain's front: TLS ends there
//
// The node side also plans each deployment from its real catalog version (isolationPlan): /1 for hello-world, /2 for
// hookbin, with the spawn body the manager would receive. Every client verdict is judge-hv on the client's OWN
// handshake: at best monitor-signed (T0-hv, host not excluded).
//
//   usage: node hvlab-route.mjs <launcher key b64> <A relay port> <A appId> <B relay port> <B appId> <image sha256>
//   env:   HVLAB_JUDGE, HVLAB_RUNTIME as for hvlab-check.mjs
import tls from "node:tls";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { WebSocketServer, createWebSocketStream } from "ws";
import { isolationPlan, isolatedTarget, createIsolationSplicer, dataPlaneFor, V1, V2, BACKEND } from "../../windows/vbslike/datapath/node-bridge.mjs";
import { runtimeId as runtimeIdOf } from "../contract/runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [launcherKey, portA, appA, portB, appB, image] = process.argv.slice(2);
if (!image) { console.error("usage: node hvlab-route.mjs <launcher key> <A port> <A appId> <B port> <B appId> <image sha256>"); process.exit(2); }
const { judge: judgeHv } = await import(pathToFileURL(process.env.HVLAB_JUDGE).href);
const expectRuntime = JSON.parse(readFileSync(process.env.HVLAB_RUNTIME, "utf8"));
const RT = runtimeIdOf(expectRuntime).toString("hex");   // the manager pins the runtime it runs; the plan carries it
const sha = (b) => createHash("sha256").update(b).digest("hex");
let failed = 0;
const record = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };

// representative deployments (real ids and real catalog versions; run here locally, not on chain)
const DEP_A = "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e";
const DEP_B = "0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76";
const MEDIA = JSON.stringify({ _media: { thumbnail: "bafkreifzvpy3jk67jklyi3war6zzlz62hmj3dd7nblpllxcckwf6eoijzq", thumbnailSvg: true } });
const versions = {
  [DEP_A]: { appId: "0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed", index: 4,
             cid: "bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza", memMb: 128, ports: "", config: "", configCid: "" },
  [DEP_B]: { appId: "0xf7e65a8fdae1dd9f8c2a897f2f372cdb7f6150d1e20526fa06d10a682cc2e9e3", index: 4,
             cid: "bafkreidocbixnql7lroykdtwx4r2fmi5n6sra4lj7b7vhscsfqn4gctlee", memMb: 256, ports: "http:8000", config: MEDIA, configCid: "" },
};
const ledger = { cpuMilli: 100, gpuMilli: 0, isPublic: true, appPort: 8080 };
const MANAGER = { backend: BACKEND, catalog: { derivations: [V1, V2] } };   // the manager's /health, as it states itself

// 1. the node plans each deployment from its version (what host.mjs #isolationReconcile will call)
const plans = {};
for (const [dep, want, app] of [[DEP_A, V1, appA], [DEP_B, V2, appB]]) {
  const v = versions[dep];
  const p = isolationPlan({ deploymentId: dep, deployment: ledger, version: v, appConfig: v.config, hasSecrets: false,
                            waf: {}, volumes: [], runtimeId: RT, require: BACKEND, manager: MANAGER, appConfigCid: "" });
  plans[dep] = p;
  record(`plan ${dep.slice(0, 10)}: ${want}`, p.ok && p.derivation === want, p.ok ? `${p.derivation} http=${p.httpPort} memMiB=${p.policy.memMiB}` : `${p.input}: ${p.why}`);
}
record("plan: a deployment with staged secrets is refused, naming the input", (() => {
  const p = isolationPlan({ deploymentId: DEP_B, deployment: ledger, version: versions[DEP_B], appConfig: MEDIA, hasSecrets: true,
                            waf: {}, volumes: [], runtimeId: RT, require: BACKEND, manager: MANAGER, appConfigCid: "" });
  return !p.ok && p.input === "hasSecrets";
})(), "hasSecrets");

// 2. the manager's readiness judgement (what its spawn path does): the key a verifying handshake saw, and ready
function session(port, servername = "hvlab.test") {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port: Number(port), servername, rejectUnauthorized: false });
    s.once("error", reject);
    s.once("secureConnect", () => {
      const spki = s.getPeerX509Certificate().publicKey.export({ type: "spki", format: "der" });
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); agent.createConnection = () => s;
      const req = (method, p, body, headers = {}) => new Promise((res, rej) => {
        const r = http.request({ agent, method, path: p, headers: { host: servername, ...headers,
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } }, (a) => {
          const c = []; a.on("data", (x) => c.push(x)); a.on("end", () => res({ status: a.statusCode, body: Buffer.concat(c).toString() }));
        });
        r.on("error", rej); r.end(body);
      });
      resolve({ spki, req, close: () => s.destroy() });
    });
  });
}
async function judged(sess, app) {
  const nonce = randomBytes(32);
  const r = await sess.req("GET", `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`);
  return judgeHv({ doc: JSON.parse(r.body), spki: sess.spki, nonce, expectedAppSha256: app, launcherKey, expectRuntime });
}
const views = {};
for (const [dep, port, app] of [[DEP_A, portA, appA], [DEP_B, portB, appB]]) {
  const s = await session(port);
  const v = await judged(s, app);
  const ready = await s.req("GET", "/.well-known/enclave-ready");
  const id = "hv" + randomBytes(4).toString("hex");
  views[id] = { id, name: dep, status: v.verdict === "monitor-signed" && ready.status === 200 ? "running" : "failed",
                tier: "T0-hv", hostExcluded: false, verdict: v.verdict, appId: app, runtimeId: RT, image,
                transportKeySha256: sha(s.spki), relay: { host: "127.0.0.1", port: Number(port) } };
  record(`manager readiness ${dep.slice(0, 10)}`, views[id].status === "running", `${v.verdict}, ready ${ready.status}, key ${sha(s.spki).slice(0, 16)}...`);
  s.close();
}
const byName = (dep) => Object.values(views).find((v) => v.name === dep);

// 3. the node's records, as host.mjs keeps them after reconcile (instance + appId from the manager's view)
const records = {};
for (const dep of [DEP_A, DEP_B]) records[dep] = { status: "running", isolation: { instance: byName(dep).id, appId: byName(dep).appId } };

// 4. the manager's data plane, the node's app zone, the relay's splice half
const manager = { get: (id) => views[id] || null };
const dp = dataPlaneFor(manager);
dp.server.listen(0, "127.0.0.1"); await once(dp.server, "listening");
const splicer = createIsolationSplicer({ client: { get: async (id) => manager.get(id) }, dataAddr: `127.0.0.1:${dp.server.address().port}` });
const outcomes = [];
const wss = new WebSocketServer({ noServer: true });
const zone = http.createServer();
zone.on("upgrade", (req, sock, head) => {
  const m = /^\/x\/(0x[0-9a-f]{64})\/https$/.exec(req.url);
  const target = m ? isolatedTarget(m[1], records[m[1]]) : null;
  wss.handleUpgrade(req, sock, head, async (ws) => {
    outcomes.push(await splicer.serve(createWebSocketStream(ws), target, { close: () => ws.terminate() }));
  });
});
zone.listen(0, "127.0.0.1"); await once(zone, "listening");
const NOBODY = "0x" + "ab".repeat(32);
const relay = spawn(process.execPath, [path.join(HERE, "..", "m4", "guestd", "testdata", "relay-fixture.mjs"),
  String(zone.address().port), DEP_A, DEP_B, NOBODY], { stdio: ["ignore", "pipe", "inherit"] });
const routes = await new Promise((resolve) => {
  let buf = ""; relay.stdout.on("data", (c) => { buf += c; const nl = buf.indexOf("\n"); if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)).routes); });
});

// 5. a browser-shaped client through the relay: TLS to the app's own name, judged on its OWN handshake
const label = (dep) => `${dep.slice(2, 10)}.app.enclave.host`;
{
  const s = await session(routes[DEP_A], label(DEP_A));
  const v = await judged(s, appA);
  record("A through relay -> app zone -> data plane -> partition: TLS ends in the domain", v.verdict === "monitor-signed" && sha(s.spki) === byName(DEP_A).transportKeySha256,
    `verdict ${v.verdict} on the client's own handshake key ${sha(s.spki).slice(0, 16)}...`);
  const r = await s.req("GET", "/");
  record("A: the app answers on that route", r.status === 200 && /Hello World/.test(r.body), `${r.status} ${JSON.stringify(r.body.slice(0, 30))}`);
  s.close();
}
{
  const s = await session(routes[DEP_B], label(DEP_B));
  const v = await judged(s, appB);
  record("B (/2 socket server) through the same path: TLS ends in the domain", v.verdict === "monitor-signed", `verdict ${v.verdict}`);
  const bin = "rt" + randomBytes(4).toString("hex"), nonce = randomBytes(8).toString("hex");
  const mk = await s.req("POST", "/api/bins", null, { "x-bin-id": bin });
  const post = await s.req("POST", `/b/${bin}`, JSON.stringify({ nonce }), { "content-type": "application/json" });
  const got = await s.req("GET", `/api/bins/${bin}/requests`, null, { "x-bin-id": bin });
  let body = ""; try { body = Buffer.from(JSON.parse(got.body)[0].body_b64, "base64").toString(); } catch {}
  record("B: webhook round-trip on that route", mk.status === 200 && post.status === 200 && body.includes(nonce), `create ${mk.status}, post ${post.status}, read ${got.status}`);
  s.close();
}
// 6. refusals, through the same real chain
const fails = async (port, servername) => { try { const s = await session(port, servername); const r = await s.req("GET", "/").catch(() => null); s.close(); return !r; } catch { return true; } };
record("A's route with B's name in the ClientHello: refused before the data plane", await fails(routes[DEP_A], label(DEP_B)), "wrong-name");
record("a deployment this node holds no isolated record for: refused", await fails(routes[NOBODY], label(NOBODY)), "no-route");
{
  // the instance restarts with a new key after the node read its route: the data plane refuses the stale route
  const inst = byName(DEP_A), before = inst.transportKeySha256;
  const nodeView = { ...inst };
  inst.transportKeySha256 = "11".repeat(32);
  const stale = createIsolationSplicer({ client: { get: async () => nodeView }, dataAddr: `127.0.0.1:${dp.server.address().port}` });
  const staleZone = http.createServer(); const w2 = new WebSocketServer({ noServer: true });
  staleZone.on("upgrade", (req, sock, head) => w2.handleUpgrade(req, sock, head, async (ws) => {
    outcomes.push(await stale.serve(createWebSocketStream(ws), isolatedTarget(DEP_A, records[DEP_A]), { close: () => ws.terminate() }));
  }));
  staleZone.listen(0, "127.0.0.1"); await once(staleZone, "listening");
  const r2 = spawn(process.execPath, [path.join(HERE, "..", "m4", "guestd", "testdata", "relay-fixture.mjs"), String(staleZone.address().port), DEP_A],
    { stdio: ["ignore", "pipe", "inherit"] });
  const rt2 = await new Promise((resolve) => { let b = ""; r2.stdout.on("data", (c) => { b += c; const nl = b.indexOf("\n"); if (nl >= 0) resolve(JSON.parse(b.slice(0, nl)).routes); }); });
  record("a stale route (the instance's verified key changed): refused by the data plane", await fails(rt2[DEP_A], label(DEP_A)), "stale key");
  inst.transportKeySha256 = before;
  r2.kill(); staleZone.close();
}
await new Promise((r) => setTimeout(r, 300));
const kinds = outcomes.map((o) => (o.outcome === "spliced" ? "spliced" : o.kind));
record("outcomes the app zone saw", ["wrong-name", "no-route", "refused"].every((k) => kinds.includes(k)) && kinds.filter((k) => k === "spliced").length >= 2,
  kinds.join(","));
console.log(`data plane: ${JSON.stringify(dp.stats())}`);
relay.kill(); zone.close(); dp.server.close();
console.log(failed ? `HVLAB-ROUTE ${failed} FAILED` : "HVLAB-ROUTE ALL PASS");
process.exit(failed ? 1 : 0);
