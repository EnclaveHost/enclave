// Fleet-aware relays — the dedicated-IP data-plane daemons (tcp6/udp/egress)
// follow an arbitrary, changing set of enclaves via relay/fleet.mjs instead of
// a single ENCLAVE_URL pin. Unit-tests the env/config resolution, then drives
// the REAL daemons as child processes against two fake in-test "enclaves" to
// prove the merge: one relay process serves both at once, each binding/control
// channel routed to its owning enclave.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer } from "ws";
import { fleetConfig, createFleet, fetchJson } from "../relay/fleet.mjs";
import { keccak256, stringToBytes } from "viem";

// ---------- U7: the api-relay's eligibility verdicts, as the data-plane daemons read them ------------------------------
// A stub /enclaves: one row per origin, `id` = keccak256(origin) exactly as the api-relay stamps it, `eligible` as given.
// `down()` makes every poll fail (the feed keeps its last verdict only until it is stale).
async function eligibilityApi(verdicts) {
  let up = true;
  const srv = http.createServer((req, res) => {
    if (!up || req.url !== "/enclaves") { res.statusCode = up ? 404 : 503; return res.end("{}"); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ enclaves: Object.entries(verdicts).map(([origin, eligible]) =>
      ({ endpoint: origin, id: keccak256(stringToBytes(origin)), eligible })) }));
  });
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  return { url: `http://127.0.0.1:${srv.address().port}`, set: (o, e) => { verdicts[o] = e; }, down: () => { up = false; },
           close: () => srv.close() };
}

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fleetConfig / createFleet (unit) --------------------------------

test("fleetConfig: ENCLAVES + legacy ENCLAVE_URL fold together, deduped, slashes stripped", () => {
  const cfg = fleetConfig({
    ENCLAVES: " https://a.example/ ,https://b.example",
    ENCLAVE_URL: "https://a.example",           // legacy pin, already in the list
  });
  assert.deepEqual(cfg.staticList, ["https://a.example", "https://b.example"]);
  assert.equal(cfg.registryAddress, "");
});

test("fleetConfig: ENCLAVE_URL alone still works (legacy env files)", () => {
  const cfg = fleetConfig({ ENCLAVE_URL: "https://enclave1.example/" });
  assert.deepEqual(cfg.staticList, ["https://enclave1.example"]);
});

test("fleetConfig: neither source -> empty (daemons treat as fatal)", () => {
  const cfg = fleetConfig({});
  assert.deepEqual(cfg.staticList, []);
  assert.equal(cfg.registryAddress, "");
});

test("createFleet: static mode serves the list immediately, start() is a no-op", async () => {
  const fleet = createFleet(fleetConfig({ ENCLAVES: "https://a.example,https://b.example" }));
  assert.deepEqual(fleet.origins(), ["https://a.example", "https://b.example"]);
  await fleet.start();                                   // must not throw or hang
  assert.deepEqual(fleet.origins(), ["https://a.example", "https://b.example"]);
});

test("fetchJson: json on 2xx, null on non-2xx and on refused", async (t) => {
  const srv = http.createServer((req, res) => {
    if (req.url === "/ok") { res.setHeader("content-type", "application/json"); res.end('{"a":1}'); }
    else { res.statusCode = 500; res.end(); }
  });
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  t.after(() => srv.close());
  const origin = `http://127.0.0.1:${srv.address().port}`;
  assert.deepEqual(await fetchJson(`${origin}/ok`), { a: 1 });
  assert.equal(await fetchJson(`${origin}/boom`), null);
  assert.equal(await fetchJson("http://127.0.0.1:1/nope", 500), null);   // refused
});

// ---------- fixtures: a fake enclave -----------------------------------------

async function freePort() {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

// A fake enclave: /v1/net-map lists one deployment on ::1, and the WS bridge
// /x/<id>/tcp/<port> echoes bytes back (tagged so the test can tell WHICH
// enclave served the splice).
async function fakeEnclave({ id, tcpPort, tag }) {
  const srv = http.createServer((req, res) => {
    if (req.url === "/v1/net-map") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ enabled: true, deployments: [{ id, address: "::1", tcp: [tcpPort], udp: [] }] }));
    } else { res.statusCode = 404; res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true });
  srv.on("upgrade", (req, sock, head) => {
    if (req.url !== `/x/${id}/tcp/${tcpPort}`) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, (ws) => {
      ws.on("message", (d) => ws.send(Buffer.concat([Buffer.from(tag + ":"), d])));
    });
  });
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  return { origin: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

function spawnRelay(script, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.REGISTRY_ADDRESS;                            // never hit a real chain from tests
  const p = spawn(process.execPath, [path.join(RELAY_DIR, script)], { env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  p.stdout.on("data", (d) => logs.push(d.toString()));
  p.stderr.on("data", (d) => logs.push(d.toString()));
  return { p, logs };
}

// Every port must appear in the relay's OWN listen-callback output before the
// test dials it - proof the relay won the port rather than a stranger holding it.
async function bound(logs, ports, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const out = logs.join("");
    if (ports.every((p) => out.includes(`]:${p} ->`))) return;
    await delay(100);
  }
  throw new Error(`relay never reported binding ${ports.join(", ")}:\n${logs.join("")}`);
}

// Dial [::1]:port and exchange one payload through the relay, retrying until
// the relay has polled the map and bound the port.
async function exchange(port, payload, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const c = net.connect({ host: "::1", port, family: 6 });
        const chunks = [];
        c.on("error", reject);
        c.on("connect", () => c.write(payload));
        c.on("data", (d) => { chunks.push(d); c.end(); });
        c.on("close", () => chunks.length ? resolve(Buffer.concat(chunks).toString()) : reject(new Error("no data")));
        setTimeout(() => { c.destroy(new Error("timeout")); }, 2000);
      });
    } catch { await delay(250); }
  }
  throw new Error(`nothing listening on [::1]:${port} after ${attempts} attempts`);
}

// ---------- e2e: one tcp6-relay process serves TWO enclaves ------------------

test("tcp6-relay: merges net-maps across the fleet and routes each port to its owning enclave", async (t) => {
  const [portA, portB] = [await freePort(), await freePort()];
  const encA = await fakeEnclave({ id: "dep_aaa", tcpPort: portA, tag: "A" });
  const encB = await fakeEnclave({ id: "dep_bbb", tcpPort: portB, tag: "B" });
  // TCP6_PREFIX declares what this rig may bind. A declared prefix IS the
  // policy (see bindRefusal), so `::1/128` lets the test bind exactly loopback
  // and nothing else - on the real box it is the routed /64 and loopback loses.
  const elig = await eligibilityApi({ [encA.origin]: true, [encB.origin]: true });
  const { p, logs } = spawnRelay("tcp6-relay.js", {
    ENCLAVES: `${encA.origin},${encB.origin}`, NET_POLL_SEC: "1", TCP6_PREFIX: "::1/128", ELIGIBILITY_API: elig.url });
  t.after(() => { p.kill(); encA.close(); encB.close(); elig.close(); });

  // Wait for the RELAY's own bind lines before dialing. freePort() reserves
  // nothing - it binds :0, reads the number and closes - so under a parallel run
  // something else can hold portA by the time the relay gets there. Dialing then
  // reaches a stranger and the failure reads as a routing bug rather than a lost
  // race. The relay logs "[tcp6-relay] [::1]:<port> -> <origin>" from its listen
  // callback, so those lines mean the relay, and only the relay, owns them.
  await bound(logs, [portA, portB]);

  const [ra, rb] = await Promise.all([exchange(portA, "ping-a"), exchange(portB, "ping-b")]);
  assert.equal(ra, "A:ping-a", `wrong route for enclave A (logs: ${logs.join("")})`);
  assert.equal(rb, "B:ping-b", `wrong route for enclave B (logs: ${logs.join("")})`);
});

// ---------- e2e: one egress-relay process attaches to every enclave ----------

test("egress-relay: opens an authenticated control channel to every enclave in the fleet", async (t) => {
  const TOKEN = "fleet-test-token";
  const attached = new Set();
  async function controlEndpoint(tag) {
    const srv = http.createServer((_q, res) => { res.statusCode = 404; res.end(); });
    const wss = new WebSocketServer({ noServer: true });
    srv.on("upgrade", (req, sock, head) => {
      if (!req.url.startsWith("/v1/egress-control")) { sock.destroy(); return; }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        sock.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); sock.destroy(); return;
      }
      wss.handleUpgrade(req, sock, head, () => attached.add(tag));
    });
    srv.listen(0, "127.0.0.1"); await once(srv, "listening");
    return { origin: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
  }
  const encA = await controlEndpoint("A");
  const encB = await controlEndpoint("B");
  const { p, logs } = spawnRelay("egress-relay.js", {
    ENCLAVES: `${encA.origin},${encB.origin}`, EGRESS_RELAY_TOKEN: TOKEN });
  t.after(() => { p.kill(); encA.close(); encB.close(); });

  for (let i = 0; i < 40 && attached.size < 2; i++) await delay(250);
  assert.deepEqual([...attached].sort(), ["A", "B"],
    `expected control channels to both enclaves (logs: ${logs.join("")})`);
});

// ---------- e2e: SNI relay routes each deployment to its OWNING enclave -------

const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
// A minimal TLS ClientHello carrying `sni` — enough for relay.js's SNI parser.
function clientHello(sni) {
  const name = Buffer.from(sni, "ascii");
  const sniList = Buffer.concat([Buffer.from([0x00]), u16(name.length), name]);
  const sniExtBody = Buffer.concat([u16(sniList.length), sniList]);
  const sniExt = Buffer.concat([u16(0x0000), u16(sniExtBody.length), sniExtBody]);
  const extBlock = Buffer.concat([u16(sniExt.length), sniExt]);
  const body = Buffer.concat([
    Buffer.from([0x01]), Buffer.from([0, 0, 0]),   // ClientHello + handshake len (ignored)
    Buffer.from([0x03, 0x03]), Buffer.alloc(32),   // legacy_version + random
    Buffer.from([0x00]),                            // session id len 0
    u16(2), Buffer.from([0x00, 0x2f]),             // cipher suites (len 2, one suite)
    Buffer.from([0x01, 0x00]),                      // compression (len 1, null)
    extBlock,
  ]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(body.length), body]);
}

// A fake enclave: /v1/net-map advertises `id` with a tls-able tcp port, and its
// /x/<id>/tls/<port> WS bridge echoes bytes tagged so the test sees which
// enclave served the splice.
async function fakeEnclaveTls({ id, logicalPort, tag }) {
  const srv = http.createServer((req, res) => {
    if (req.url === "/v1/net-map") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ enabled: true, deployments: [{ id, address: "::1", tcp: [logicalPort], udp: [] }] }));
    } else { res.statusCode = 404; res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true });
  srv.on("upgrade", (req, sock, head) => {
    if (req.url !== `/x/${encodeURIComponent(id)}/tls/${logicalPort}`) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, (ws) => {
      // ignore the buffered ClientHello (first message); reply tagged to app bytes
      let first = true;
      ws.on("message", (d) => { if (first) { first = false; return; } ws.send(Buffer.concat([Buffer.from(tag + ":"), d])); });
    });
  });
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  return { origin: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

// Open a raw TCP conn to the relay, send the ClientHello for `sni` then a probe,
// return the (tagged) reply.
function sniExchange(port, sni, probe) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1");
    // send the ClientHello, then the app probe as a SEPARATE chunk once the
    // relay has parsed the SNI + established the splice (so the enclave sees
    // hello and probe as distinct messages, like a real TLS handshake).
    c.on("connect", () => { c.write(clientHello(sni)); setTimeout(() => c.write(probe), 250); });
    c.on("data", (d) => { clearTimeout(t); c.destroy(); resolve(d.toString()); });   // the tagged echo
    c.on("error", (e) => { clearTimeout(t); reject(e); });
    const t = setTimeout(() => { c.destroy(); reject(new Error("no echo (route failed)")); }, 5000);
  });
}

test("relay (SNI): routes each deployment to its owning enclave; legacy id + bytes32 prefix", async (t) => {
  const bytes32 = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const encA = await fakeEnclaveTls({ id: "dep_alpha", logicalPort: 6667, tag: "A" });
  const encB = await fakeEnclaveTls({ id: bytes32, logicalPort: 6667, tag: "B" });
  const pub = await freePort();
  const elig = await eligibilityApi({ [encA.origin]: true, [encB.origin]: true });
  const { p, logs } = spawnRelay("relay.js", {
    RELAY_DOMAIN: "tcp.test", RELAY_PORTS: `${pub}:6667`, RELAY_BIND: "127.0.0.1",
    NET_POLL_SEC: "1", ENCLAVES: `${encA.origin},${encB.origin}`, ELIGIBILITY_API: elig.url });
  t.after(() => { p.kill(); encA.close(); encB.close(); elig.close(); });

  // wait until the relay bound the port (its index is populated before listen)
  for (let i = 0; i < 40 && !logs.join("").includes("listening on"); i++) await delay(250);

  // legacy id: dep-alpha.tcp.test  -> enclave A (dep- maps back to dep_)
  const ra = await sniExchange(pub, "dep-alpha.tcp.test", "ping-a");
  assert.equal(ra, "A:ping-a", `legacy-id route wrong (logs: ${logs.join("")})`);

  // bytes32 by hex PREFIX: abcdef01.tcp.test -> enclave B (unique prefix)
  const rb = await sniExchange(pub, "abcdef0123456789.tcp.test", "ping-b");
  assert.equal(rb, "B:ping-b", `bytes32-prefix route wrong (logs: ${logs.join("")})`);
});

// ---------- U7: the data-plane daemons dial an ELIGIBLE host only ----------------------------------------------------

test("U7 fleet: the eligibility feed answers only while fresh; ineligible, stale and unconfigured are all 'no'", async () => {
  const A = "http://a.test", B = "http://b.test";
  const elig = await eligibilityApi({ [A]: true, [B]: false });
  const fleet = createFleet(fleetConfig({ ENCLAVES: `${A},${B}`, ELIGIBILITY_API: elig.url, ELIGIBILITY_POLL_SEC: "1", ELIGIBILITY_MAX_AGE_SEC: "2" }));
  await fleet.start(); await fleet.startEligibility();
  try {
    assert.equal(fleet.eligibleOriginSync(A), true); assert.equal(fleet.eligibleOriginSync(A + "/"), true, "a trailing slash is the same origin");
    assert.equal(fleet.eligibleOriginSync(B), false, "the api-relay says ineligible");
    assert.equal(await fleet.eligibleOrigin(A), true); assert.equal(await fleet.eligibleOrigin(B), false);
    assert.equal(fleet.eligibleId(keccak256(stringToBytes(A))), true); assert.equal(fleet.eligibleId(keccak256(stringToBytes(B))), false);
    assert.equal(fleet.eligibleOriginSync("http://c.test"), false, "an origin the api-relay does not list");
    elig.set(B, true); await delay(1500);
    assert.equal(fleet.eligibleOriginSync(B), true, "the next poll picks up a changed verdict");
    elig.down(); await delay(2600);
    assert.equal(fleet.eligibleOriginSync(A), false, "a verdict older than the max age is no verdict");
    assert.equal(fleet.eligibleId(keccak256(stringToBytes(A))), false);
  } finally { fleet.stopEligibility(); elig.close(); }
  const none = createFleet(fleetConfig({ ENCLAVES: A }));
  await none.startEligibility();
  assert.equal(none.eligibleOriginSync(A), false, "no ELIGIBILITY_API (or DOMAINS_API): nothing is eligible");
  assert.equal(await none.eligibleOrigin(A), false);
});

test("U7 fleet: a held session is closed once its host stops being eligible, or its verdict ages out, and at once if it already is not", async () => {
  const A = "http://a.test", B = "http://b.test", C = "http://c.test";
  const elig = await eligibilityApi({ [A]: true, [B]: true, [C]: true });
  const fleet = createFleet(fleetConfig({ ENCLAVES: `${A},${B}`, ELIGIBILITY_API: elig.url, ELIGIBILITY_POLL_SEC: "1", ELIGIBILITY_MAX_AGE_SEC: "2" }));
  await fleet.start(); await fleet.startEligibility();
  try {
    // judged by its id against the CURRENT verdict: an origin outside this daemon's own list is not refused for that
    assert.equal(fleet.eligibleOriginSync(C), true);
    const closed = [];
    const relA1 = fleet.holdWhileEligible(A + "/", () => closed.push("a1"));
    fleet.holdWhileEligible(A, () => closed.push("a2"));
    const relB = fleet.holdWhileEligible(B, () => closed.push("b"));
    assert.equal(fleet.heldSessions(), 3);
    relA1();                                                   // a1 ends on its own
    assert.equal(fleet.heldSessions(), 2);
    await delay(1500);
    assert.deepEqual(closed, [], "held across a poll while eligible");
    elig.set(A, false); await delay(1500);
    assert.deepEqual(closed, ["a2"], "A's live session is closed (once); the released one is not called; B's stays");
    assert.equal(fleet.heldSessions(), 1);
    fleet.holdWhileEligible(A, () => closed.push("a3"));
    assert.deepEqual(closed, ["a2", "a3"], "holding toward a host that is not eligible closes at once");
    assert.equal(fleet.heldSessions(), 1);
    elig.down(); await delay(3500);                            // every poll fails; the verdict ages out
    assert.deepEqual(closed, ["a2", "a3", "b"], "a stale verdict closes what it held open");
    assert.equal(fleet.heldSessions(), 0);
    relB();                                                    // its release after the sweep is a no-op
    assert.equal(fleet.heldSessions(), 0);
  } finally { fleet.stopEligibility(); elig.close(); }
});

// open a connection, exchange one payload, and KEEP it open (the U7 revocation tests close it from the relay side)
async function openHeld(connect, payload, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const c = connect();
        c.on("error", () => {});
        const t = setTimeout(() => { c.destroy(); reject(new Error("timeout")); }, 3000);
        c.once("error", (e) => { clearTimeout(t); reject(e); });
        c.once("close", () => { clearTimeout(t); reject(new Error("closed before the echo")); });
        c.on("connect", () => payload.forEach(([ms, d]) => setTimeout(() => { if (!c.destroyed) c.write(d); }, ms)));
        c.once("data", (d) => { clearTimeout(t); resolve({ c, first: d.toString() }); });
      });
    } catch { await delay(250); }
  }
  throw new Error(`never got an echo after ${attempts} attempts`);
}
const closedWithin = (c, ms) => new Promise((resolve) => {
  if (c.destroyed) return resolve(true);
  const t = setTimeout(() => resolve(false), ms);
  c.once("close", () => { clearTimeout(t); resolve(true); });
});
const echoOn = (c, d) => new Promise((resolve) => { c.once("data", (x) => resolve(x.toString())); c.write(d); });

test("U7 tcp6-relay: a LIVE connection is closed once its host loses eligibility; the eligible neighbour's is untouched", async (t) => {
  const [portA, portB] = [await freePort(), await freePort()];
  const encA = await fakeEnclave({ id: "dep_aaa", tcpPort: portA, tag: "A" });
  const encB = await fakeEnclave({ id: "dep_bbb", tcpPort: portB, tag: "B" });
  const elig = await eligibilityApi({ [encA.origin]: true, [encB.origin]: true });
  const { p, logs } = spawnRelay("tcp6-relay.js", {
    ENCLAVES: `${encA.origin},${encB.origin}`, NET_POLL_SEC: "1", TCP6_PREFIX: "::1/128", ELIGIBILITY_API: elig.url, ELIGIBILITY_POLL_SEC: "1" });
  t.after(() => { p.kill(); encA.close(); encB.close(); elig.close(); });
  await bound(logs, [portA, portB]);
  const tcp = (port) => () => net.connect({ host: "::1", port, family: 6 });
  const a = await openHeld(tcp(portA), [[0, "ping-a"]]), b = await openHeld(tcp(portB), [[0, "ping-b"]]);
  assert.equal(a.first, "A:ping-a"); assert.equal(b.first, "B:ping-b");
  assert.equal(await closedWithin(a.c, 1500), false, "held open across a poll while eligible");
  elig.set(encA.origin, false);
  assert.equal(await closedWithin(a.c, 4000), true, `closed within a poll of losing eligibility (logs: ${logs.join("")})`);
  assert.equal(b.c.destroyed, false);
  assert.equal(await echoOn(b.c, "again"), "B:again", "the eligible neighbour's live connection still carries data");
  assert.match(logs.join(""), /closed 1 live session\(s\) to hosts no longer eligible \(U7\)/);
  b.c.destroy();
});

test("U7 tcp6-relay: a port owned by an INELIGIBLE enclave is refused, its eligible neighbour still routes", async (t) => {
  const [portA, portB] = [await freePort(), await freePort()];
  const encA = await fakeEnclave({ id: "dep_aaa", tcpPort: portA, tag: "A" });
  const encB = await fakeEnclave({ id: "dep_bbb", tcpPort: portB, tag: "B" });
  const elig = await eligibilityApi({ [encA.origin]: true, [encB.origin]: false });
  const { p, logs } = spawnRelay("tcp6-relay.js", {
    ENCLAVES: `${encA.origin},${encB.origin}`, NET_POLL_SEC: "1", TCP6_PREFIX: "::1/128", ELIGIBILITY_API: elig.url, ELIGIBILITY_POLL_SEC: "1" });
  t.after(() => { p.kill(); encA.close(); encB.close(); elig.close(); });
  await bound(logs, [portA, portB]);
  assert.equal(await exchange(portA, "ping-a"), "A:ping-a");
  await assert.rejects(exchange(portB, "ping-b", 6), /nothing listening/, "the ineligible enclave's port routes nowhere");
  assert.match(logs.join(""), /dep_bbb tcp:\d+ -> .* REFUSED: not an eligible host \(U7\)/);
});

test("U7 relay (SNI): an INELIGIBLE enclave's deployment is refused, the eligible one still routes", async (t) => {
  const bytes32 = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const encA = await fakeEnclaveTls({ id: "dep_alpha", logicalPort: 6667, tag: "A" });
  const encB = await fakeEnclaveTls({ id: bytes32, logicalPort: 6667, tag: "B" });
  const pub = await freePort();
  const elig = await eligibilityApi({ [encA.origin]: true, [encB.origin]: false });
  const { p, logs } = spawnRelay("relay.js", {
    RELAY_DOMAIN: "tcp.test", RELAY_PORTS: `${pub}:6667`, RELAY_BIND: "127.0.0.1",
    NET_POLL_SEC: "1", ENCLAVES: `${encA.origin},${encB.origin}`, ELIGIBILITY_API: elig.url, ELIGIBILITY_POLL_SEC: "1" });
  t.after(() => { p.kill(); encA.close(); encB.close(); elig.close(); });
  for (let i = 0; i < 40 && !logs.join("").includes("listening on"); i++) await delay(250);
  assert.equal(await sniExchange(pub, "dep-alpha.tcp.test", "ping-a"), "A:ping-a");
  await assert.rejects(sniExchange(pub, "abcdef0123456789.tcp.test", "ping-b"), "the ineligible enclave gets no splice");
  assert.match(logs.join(""), /REFUSED: not an eligible host \(U7\)/);
  // and a relay with no eligibility source routes NOTHING (fail closed), not everything
  const pub2 = await freePort();
  const none = spawnRelay("relay.js", { RELAY_DOMAIN: "tcp.test", RELAY_PORTS: `${pub2}:6667`, RELAY_BIND: "127.0.0.1",
    NET_POLL_SEC: "1", ENCLAVES: `${encA.origin},${encB.origin}`, ELIGIBILITY_API: "", DOMAINS_API: "" });
  t.after(() => none.p.kill());
  for (let i = 0; i < 40 && !none.logs.join("").includes("listening on"); i++) await delay(250);
  await assert.rejects(sniExchange(pub2, "dep-alpha.tcp.test", "ping-a"), "unconfigured: no host is eligible");
  assert.match(none.logs.join(""), /ELIGIBILITY_API \(or DOMAINS_API\) unset: NO host is eligible/);
});

test("U7 relay (SNI): a LIVE splice is closed once its host loses eligibility; the eligible neighbour's is untouched", async (t) => {
  const bytes32 = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const encA = await fakeEnclaveTls({ id: "dep_alpha", logicalPort: 6667, tag: "A" });
  const encB = await fakeEnclaveTls({ id: bytes32, logicalPort: 6667, tag: "B" });
  const pub = await freePort();
  const elig = await eligibilityApi({ [encA.origin]: true, [encB.origin]: true });
  const { p, logs } = spawnRelay("relay.js", {
    RELAY_DOMAIN: "tcp.test", RELAY_PORTS: `${pub}:6667`, RELAY_BIND: "127.0.0.1",
    NET_POLL_SEC: "1", ENCLAVES: `${encA.origin},${encB.origin}`, ELIGIBILITY_API: elig.url, ELIGIBILITY_POLL_SEC: "1" });
  t.after(() => { p.kill(); encA.close(); encB.close(); elig.close(); });
  for (let i = 0; i < 40 && !logs.join("").includes("listening on"); i++) await delay(250);
  const sni = () => net.connect(pub, "127.0.0.1");
  const a = await openHeld(sni, [[0, clientHello("dep-alpha.tcp.test")], [250, "ping-a"]]);
  const b = await openHeld(sni, [[0, clientHello("abcdef0123456789.tcp.test")], [250, "ping-b"]]);
  assert.equal(a.first, "A:ping-a"); assert.equal(b.first, "B:ping-b");
  assert.equal(await closedWithin(a.c, 1500), false, "held open across a poll while eligible");
  elig.set(encA.origin, false);
  assert.equal(await closedWithin(a.c, 4000), true, `closed within a poll of losing eligibility (logs: ${logs.join("")})`);
  assert.equal(b.c.destroyed, false);
  assert.equal(await echoOn(b.c, "again"), "B:again", "the eligible neighbour's live splice still carries data");
  assert.match(logs.join(""), /closed 1 live session\(s\) to hosts no longer eligible \(U7\)/);
  b.c.destroy();
});

// a fake enclave with one udp:N port: /v1/udp-map declares it on ::1; the WS bridge /x/<id>/udp/<N> echoes, tagged
async function fakeEnclaveUdp({ id, udpPort, tag }) {
  const srv = http.createServer((req, res) => {
    if (req.url === "/v1/udp-map") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ enabled: true, deployments: [{ id, address: "::1", ports: [udpPort] }] }));
    }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const seen = [], bridgeClosed = [];
  srv.on("upgrade", (req, sock, head) => {
    seen.push(req.url);
    if (req.url !== `/x/${id}/udp/${udpPort}`) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, (ws) => {
      ws.on("message", (d) => ws.send(Buffer.concat([Buffer.from(tag + ":"), d])));
      ws.on("close", () => bridgeClosed.push(req.url));
    });
  });
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  return { origin: `http://127.0.0.1:${srv.address().port}`, seen, bridgeClosed, close: () => srv.close() };
}
async function udpExchange(port, payload, ms = 1500) {
  const dgram = await import("node:dgram");
  return await new Promise((resolve) => {
    const s = dgram.createSocket("udp6");
    const done = (v) => { clearTimeout(t); try { s.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done(null), ms);
    s.on("message", (m) => done(m.toString()));
    s.send(Buffer.from(payload), port, "::1");
  });
}

test("U7 udp-relay: a flow toward an INELIGIBLE enclave never opens; the eligible one's does", async (t) => {
  const [portA, portB] = [await freePort(), await freePort()];
  const encA = await fakeEnclaveUdp({ id: "dep_aaa", udpPort: portA, tag: "A" });
  const encB = await fakeEnclaveUdp({ id: "dep_bbb", udpPort: portB, tag: "B" });
  const elig = await eligibilityApi({ [encA.origin]: true, [encB.origin]: false });
  const { p, logs } = spawnRelay("udp-relay.js", {
    ENCLAVES: `${encA.origin},${encB.origin}`, UDP_POLL_SEC: "1", UDP_PREFIX: "::1/128", ELIGIBILITY_API: elig.url, ELIGIBILITY_POLL_SEC: "1" });
  t.after(() => { p.kill(); encA.close(); encB.close(); elig.close(); });
  await bound(logs, [portA, portB]);
  let ra = null;
  for (let i = 0; i < 10 && ra === null; i++) ra = await udpExchange(portA, "ping-a");
  assert.equal(ra, "A:ping-a", `eligible enclave's flow (logs: ${logs.join("")})`);
  assert.equal(await udpExchange(portB, "ping-b"), null, "no answer through an ineligible enclave");
  assert.deepEqual(encB.seen, [], "no WebSocket was ever opened toward the ineligible enclave");
});

test("U7 udp-relay: a LIVE flow is dropped once its host loses eligibility, and no new one opens", async (t) => {
  const portA = await freePort();
  const encA = await fakeEnclaveUdp({ id: "dep_aaa", udpPort: portA, tag: "A" });
  const elig = await eligibilityApi({ [encA.origin]: true });
  const { p, logs } = spawnRelay("udp-relay.js", {
    ENCLAVES: encA.origin, UDP_POLL_SEC: "1", UDP_PREFIX: "::1/128", ELIGIBILITY_API: elig.url, ELIGIBILITY_POLL_SEC: "1" });
  t.after(() => { p.kill(); encA.close(); elig.close(); });
  await bound(logs, [portA]);
  const dgram = await import("node:dgram");
  const s = dgram.createSocket("udp6"); t.after(() => { try { s.close(); } catch {} });
  await new Promise((r) => s.bind(0, "::1", r));
  const ask = (payload, ms = 1500) => new Promise((resolve) => {
    const done = (v) => { clearTimeout(tm); s.off("message", on); resolve(v); };
    const on = (m) => done(m.toString());
    const tm = setTimeout(() => done(null), ms);
    s.on("message", on); s.send(Buffer.from(payload), portA, "::1");
  });
  let r = null;
  for (let i = 0; i < 10 && r === null; i++) r = await ask("ping-a");
  assert.equal(r, "A:ping-a", `eligible flow (logs: ${logs.join("")})`);
  await delay(1500);
  assert.deepEqual(encA.bridgeClosed, [], "the flow's bridge stays open across a poll while eligible");
  assert.equal(await ask("still"), "A:still");
  elig.set(encA.origin, false);
  for (let i = 0; i < 40 && !encA.bridgeClosed.length; i++) await delay(100);
  assert.equal(encA.bridgeClosed.length, 1, `the live flow's bridge is closed within a poll (logs: ${logs.join("")})`);
  const opened = encA.seen.length;
  assert.equal(await ask("after"), null, "the same client gets nothing through the ineligible host");
  assert.equal(encA.seen.length, opened, "and no new flow's bridge was opened toward it");
  assert.match(logs.join(""), /closed 1 live session\(s\) to hosts no longer eligible \(U7\)/);
});

// ---- U7 relay (SNI) app subdomains with a ledger: the lease holder or nothing, never a probe ----
const W32 = (v) => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase() : BigInt(v).toString(16)).padStart(64, "0");
function encLedgerPage(rows) {
  const tuples = rows.map((d) => {
    const strs = ["ipfs://x", "", ""].map((s) => { const hex = Buffer.from(s, "utf8").toString("hex");
      return { body: W32(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0"), words: 1 + Math.ceil(hex.length / 64) }; });
    let off = 17 * 32;
    const heads = strs.map((s) => { const h = W32(off); off += s.words * 32; return h; });
    return [W32(d.id), W32("0x" + "aa".repeat(20)), heads[0], heads[1], heads[2], W32(0), W32(10), W32(8080), W32(1), W32(1), W32(1700000000),
            W32(3), W32(5_000_000), W32(0), W32(d.runner), W32("0x" + "00".repeat(20)), W32(d.leaseUntil)].join("") + strs.map((s) => s.body).join("");
  });
  let off = rows.length * 32;
  const heads = tuples.map((t) => { const h = W32(off); off += t.length / 2; return h; });
  return "0x" + W32(32) + W32(rows.length) + heads.join("") + tuples.join("");
}
async function ledgerRpc(ledger) {
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      const one = (m) => {
        if (m.method !== "eth_call") return "0x";
        const data = m.params[0].data;
        if (data.startsWith("0x5d1b72b6")) return "0x" + W32(2);
        if (data.startsWith("0x06661abd")) return "0x" + W32(ledger.length);
        const start = Number(BigInt("0x" + data.slice(10, 74))), n = Number(BigInt("0x" + data.slice(74, 138)));
        return encLedgerPage(ledger.slice(start, start + n));
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(q) ? q.map((m) => ({ jsonrpc: "2.0", id: m.id, result: one(m) })) : { jsonrpc: "2.0", id: q.id, result: one(q) }));
    });
  });
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}
// an ELIGIBLE box that claims EVERY app id it is probed for (HEAD /x/<id> 200) and bridges /x/<id>/https, tagged
async function fakeEnclaveApp(tag) {
  const bridged = [];
  const srv = http.createServer((req, res) => { res.statusCode = req.method === "HEAD" && req.url.startsWith("/x/") ? 200 : 404; res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  srv.on("upgrade", (req, sock, head) => {
    bridged.push(req.url);
    if (!/^\/x\/[^/]+\/https$/.test(req.url)) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, (ws) => {
      let first = true;
      ws.on("message", (d) => { if (first) { first = false; return; } ws.send(Buffer.concat([Buffer.from(tag + ":"), d])); });
    });
  });
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  return { origin: `http://127.0.0.1:${srv.address().port}`, bridged, close: () => srv.close() };
}

test("U7 relay (SNI): an app subdomain routes to its ledger lease holder when eligible, and NEVER falls back to a probe", async (t) => {
  const encA = await fakeEnclaveApp("A");
  const HOLDS = "0xaaaa1111" + "11".repeat(28), ELSEWHERE = "0xbbbb2222" + "22".repeat(28);
  const future = Math.floor(Date.now() / 1000) + 3600;
  const ledger = await ledgerRpc([
    { id: HOLDS, runner: keccak256(stringToBytes(encA.origin)), leaseUntil: future },      // leased to the eligible box
    { id: ELSEWHERE, runner: "0x" + "77".repeat(32), leaseUntil: future },               // leased to a runner not in this fleet
  ]);
  const elig = await eligibilityApi({ [encA.origin]: true });
  const pub = await freePort();
  const { p, logs } = spawnRelay("relay.js", {
    APP_DOMAIN: "app.test", RELAY_PORTS: `${pub}:443`, RELAY_BIND: "127.0.0.1", NET_POLL_SEC: "1", ENCLAVES: encA.origin,
    ELIGIBILITY_API: elig.url, ELIGIBILITY_POLL_SEC: "1", DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20), BASE_RPC: ledger.url, ADDRESS_BOOK_ADDRESS: "" });
  t.after(() => { p.kill(); encA.close(); elig.close(); ledger.close(); });
  for (let i = 0; i < 40 && !logs.join("").includes("listening on"); i++) await delay(250);
  await delay(1200);                                                         // the first eligibility poll
  assert.equal(await sniExchange(pub, "aaaa1111.app.test", "ping"), "A:ping", `the lease holder is routed (logs: ${logs.join("")})`);
  const n = encA.bridged.length;
  await assert.rejects(sniExchange(pub, "bbbb2222.app.test", "ping"), "a deployment leased elsewhere is not handed to a box that merely answers for it");
  assert.equal(encA.bridged.length, n, "no bridge was opened to the probe-answering box");
});
