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
  const { p, logs } = spawnRelay("tcp6-relay.js", {
    ENCLAVES: `${encA.origin},${encB.origin}`, NET_POLL_SEC: "1" });
  t.after(() => { p.kill(); encA.close(); encB.close(); });

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
  const { p, logs } = spawnRelay("relay.js", {
    RELAY_DOMAIN: "tcp.test", RELAY_PORTS: `${pub}:6667`, RELAY_BIND: "127.0.0.1",
    NET_POLL_SEC: "1", ENCLAVES: `${encA.origin},${encB.origin}` });
  t.after(() => { p.kill(); encA.close(); encB.close(); });

  // wait until the relay bound the port (its index is populated before listen)
  for (let i = 0; i < 40 && !logs.join("").includes("listening on"); i++) await delay(250);

  // legacy id: dep-alpha.tcp.test  -> enclave A (dep- maps back to dep_)
  const ra = await sniExchange(pub, "dep-alpha.tcp.test", "ping-a");
  assert.equal(ra, "A:ping-a", `legacy-id route wrong (logs: ${logs.join("")})`);

  // bytes32 by hex PREFIX: abcdef01.tcp.test -> enclave B (unique prefix)
  const rb = await sniExchange(pub, "abcdef0123456789.tcp.test", "ping-b");
  assert.equal(rb, "B:ping-b", `bytes32-prefix route wrong (logs: ${logs.join("")})`);
});
