// windows/vbslike/review/appzone-hook.test.mjs: the Windows node's app-zone hook for an isolated deployment
// (windows/node/appzone.mjs at 5af19b19), driven through its real tunnel-frame surface. The guest lane's question
// (enclave-5d): is the isolated branch taken BEFORE any certificate or port check, and is no TLSSocket ever built for an
// isolated target? Both answered by mechanism, not by reading: the isolated target's `cert` and `port` are getters that
// THROW if touched, tls.TLSSocket is counted, and a gate-served control target proves both tells are live.
//   run: node --test windows/vbslike/review/appzone-hook.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { appZone } from "../../node/appzone.mjs";

const DEP = "0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76";
const upgrade = (id) => Buffer.from(`GET /x/${id}/https HTTP/1.1\r\nHost: 0ddbd824.app.enclave.host\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.from("the sample nonce").toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`).toString("base64");
const untouchable = (what) => { throw new Error(`${what} was read for an isolated target: the tier would be terminated here`); };

/** count every TLSSocket the module builds: appzone.mjs constructs `new tls.TLSSocket(...)` through the module object */
let built = 0; const Orig = tls.TLSSocket;
tls.TLSSocket = function CountedTLSSocket(...a) { built++; return new Orig(...a); };

async function drive(target, splicer) {
  const frames = [];
  const zone = appZone({ send: (f) => frames.push(f), resolve: async () => target, pressure: () => 0, serveHttp: async () => ({}), log: () => {}, isolationSplicer: splicer });
  zone.onFrame({ t: "s+", sid: 7 });
  zone.onFrame({ t: "sd", sid: 7, d: upgrade(DEP) });
  await new Promise((r) => setTimeout(r, 150));
  const sent = Buffer.concat(frames.filter((f) => f.t === "sd").map((f) => Buffer.from(f.d, "base64"))).toString("latin1");
  zone.closeAll();
  return { frames, sent };
}

test("an isolated target is handed to the splicer as an unopened stream, with a 101, before any certificate or port is read, and no TLSSocket is built", async () => {
  const target = { id: DEP, isolation: { instance: "hv0a1b2c3d", appId: "d2".repeat(32), expectName: "0ddbd824.app.enclave.host" },
                   get cert() { untouchable("cert"); }, get port() { untouchable("port"); }, get gate() { untouchable("gate"); } };
  const calls = [];
  const splicer = { serve: async (stream, t, { close }) => { calls.push({ stream, t }); stream.destroy(); close(); return { outcome: "spliced" }; } };
  built = 0;
  const { sent } = await drive(target, splicer);
  assert.equal(calls.length, 1, "the splicer was asked exactly once");
  assert.equal(calls[0].t, target, "with the target as resolved");
  assert.equal(typeof calls[0].stream.pipe, "function", "and a stream, not a TLS socket");
  assert.match(sent, /^HTTP\/1\.1 101 /, "the upgrade was answered on the tunnel");
  assert.equal(built, 0, "no TLSSocket was built for an isolated target");
});

test("control: a gate-served target reaches the certificate path and builds exactly one TLSSocket (the tells are live)", async () => {
  const target = { id: DEP, cert: { key: "k", cert: "c", name: "0ddbd824.app.enclave.host" }, port: 1 };
  built = 0;
  const { sent } = await drive(target, null);
  assert.match(sent, /^HTTP\/1\.1 101 /);
  assert.equal(built, 1, "the old path terminates here: one TLSSocket");
});

test("an isolated target with NO splicer configured is 503, never terminated here", async () => {
  const target = { id: DEP, isolation: { instance: "hv0a1b2c3d", appId: "d2".repeat(32), expectName: "0ddbd824.app.enclave.host" }, get cert() { untouchable("cert"); } };
  built = 0;
  const { sent } = await drive(target, null);
  assert.match(sent, /^HTTP\/1\.1 503 /); assert.equal(built, 0);
});
