// metal/guest/agent.mjs — the in-CVM side of the fleet tunnel.
//
// The tunnel decides ROUTING and nothing else: the relay is a router, not a
// trusted party, and the guest must treat every frame that arrives over it as
// hostile input. The property under test is that a frame can choose a PATH on
// the guest supervisor and nothing more — not a host, not a port, not a scheme.
// `new URL(frame.path, SUP_URL)` used to honor an absolute target, which handed
// the relay an SSRF primitive inside the CVM (cloud metadata, the box's LAN,
// any other loopback service).
//
// Driven as the real agent process against a fake relay, a fake supervisor and
// a honeypot that must never be touched.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "metal", "guest", "agent.mjs");

let proc, sup, honey, relay, ws;
let honeyHits = 0, supPaths = [];
const frames = new Map();                       // id -> resolve

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); });
});

before(async () => {
  sup = http.createServer((req, res) => { supPaths.push(req.url); res.writeHead(200); res.end("sup"); });
  honey = http.createServer((req, res) => { honeyHits++; res.writeHead(200); res.end("stolen"); });
  const [supPort, honeyPort] = [await listen(sup), await listen(honey)];

  const relaySrv = http.createServer();
  const relayPort = await listen(relaySrv);
  relay = new WebSocketServer({ server: relaySrv });
  const connected = new Promise((r) => relay.on("connection", (sock) => {
    ws = sock;
    sock.on("message", (d) => {
      let f; try { f = JSON.parse(d); } catch { return; }
      const done = frames.get(f.id);
      if (f.t === "res" && done) { frames.delete(f.id); done(f); }
    });
    r();
  }));

  proc = spawn(process.execPath, [AGENT], {
    env: { ...process.env, METAL_MODE: "dev", METAL_NAME: "testbox",
           METAL_SUP_URL: `http://127.0.0.1:${supPort}`,
           METAL_RELAY_URL: `ws://127.0.0.1:${relayPort}/v1/fleet-tunnel`,
           METAL_TUNNEL_TOKEN: "t", METAL_RAD_PORT: String(await freePort()) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.resume(); proc.stderr.resume();
  await connected;
  Object.assign(globalThis, { __ports: { supPort, honeyPort } });
});
after(() => {
  try { proc.kill("SIGKILL"); } catch {}
  for (const s of [sup, honey, relay?.options?.server]) { try { s?.close(); } catch {} }
  try { relay?.close(); } catch {}
});

let nextId = 1;
const send = (path, method = "GET") => new Promise((resolve, reject) => {
  const id = nextId++;
  const t = setTimeout(() => { frames.delete(id); reject(new Error("no reply for " + path)); }, 5000);
  frames.set(id, (f) => { clearTimeout(t); resolve(f); });
  ws.send(JSON.stringify({ t: "req", id, method, path, headers: {}, body: null }));
});
const b64 = (s) => Buffer.from(s || "", "base64").toString("utf8");

test("agent: an ordinary path reaches the guest supervisor", async () => {
  const r = await send("/v1/health?x=1");
  assert.equal(r.status, 200);
  assert.equal(b64(r.body), "sup");
  assert.equal(supPaths.at(-1), "/v1/health?x=1", "path and query pass through verbatim");
});

test("agent: an absolute target is refused — the relay cannot pick the host", async () => {
  const { honeyPort } = globalThis.__ports;
  for (const target of [`http://127.0.0.1:${honeyPort}/steal`,
                        `//127.0.0.1:${honeyPort}/steal`,
                        "http://169.254.169.254/latest/meta-data/",
                        "https://example.invalid/x"]) {
    const r = await send(target);
    assert.equal(r.status, 400, target);
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(honeyHits, 0, "nothing but the supervisor was ever dialed");
});

test("agent: dot segments cannot climb off the supervisor either", async () => {
  const r = await send("/x/abc/../../v1/health");
  assert.equal(r.status, 200);
  assert.equal(supPaths.at(-1), "/v1/health", "resolved against the supervisor, still the supervisor");
});
