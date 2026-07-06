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
