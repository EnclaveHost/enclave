// The REAL app zone, end to end: tunnel frames in, a real WebSocket, real TLS, a real app.
//
// Why this file exists separately from the other private-path tests: those drove `host.proxy` and
// the app-zone REQUEST HANDLER, which is most of the path but not the branch that decides whether
// a connection is parsed at all or spliced raw to the app's port. My first attempt at covering
// that branch rebuilt the decision inside the test - so mutating the real one in appzone.mjs left
// the test green, which an audit demonstrated by doing exactly that. A test that copies the code
// it is checking proves only that the copy works.
//
// So nothing here reimplements anything. `appZone()` is driven the way the relay drives it -
// `s+`, then `sd` frames carrying the client's bytes, then `sx` - and the client is a real
// WebSocket with a real TLS session inside it, asking a real HTTP question.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket, { createWebSocketStream } from "ws";
import { Host } from "../windows/node/host.mjs";
import { appZone } from "../windows/node/appzone.mjs";
import { selfSigned } from "../windows/node/apptls.mjs";

const ID = "0x" + "aa".repeat(32);
const OWNER = "0x" + "bb".repeat(20);
const STRANGER = "0x" + "cc".repeat(20);
const NAME = "audit.example.com";

/**
 * A box serving ONE private deployment, with the app zone wired to a loopback "relay": a TCP
 * server that turns bytes into tunnel frames and back, which is what relay/tunnel.js does.
 */
async function rig({ isPublic = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-zonetls-"));
  let hits = 0;
  const backend = http.createServer((_q, res) => { hits++; res.end("PRIVATE FIXTURE"); });
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));

  const h = new Host({ dir, endpoint: "https://example.invalid", name: "test", appsEnabled: true,
                       cpuPricePerSec6: 12, log: () => {},
                       // A fixture verifier, so this file tests ROUTING. The real token rules are
                       // exercised in windows-node-session.test.mjs; mixing them here would make a
                       // routing regression look like a JWT bug.
                       sessionVerify: (headers) => headers.authorization === "owner" ? OWNER
                                                : headers.authorization === "stranger" ? STRANGER : null });
  h.records.set(ID, { id: ID, status: "running", isPublic, owner: OWNER });
  h.apps.set(ID, { state: "running", port: backend.address().port });

  const cert = selfSigned(NAME);
  const sockets = new Map();
  let serial = 0;
  const zone = appZone({
    send: (f) => {
      const s = sockets.get(f.sid); if (!s) return;
      if (f.t === "sd") s.write(Buffer.from(f.d, "base64"));
      else if (f.t === "sx") s.end();
    },
    // What the node really hands the zone, including the production zoneRules.
    resolve: async () => ({ id: ID, port: backend.address().port, gate: false, cert, ...h.zoneRules(ID) }),
    serveHttp: (id, req) => h.proxy(id, req),
    log: () => {},
  });
  const tunnel = net.createServer((sock) => {
    const sid = String(++serial);
    sockets.set(sid, sock);
    zone.onFrame({ t: "s+", sid });
    sock.on("data", (b) => zone.onFrame({ t: "sd", sid, d: b.toString("base64") }));
    sock.on("error", () => {});
    sock.on("close", () => { zone.onFrame({ t: "sx", sid }); sockets.delete(sid); });
  });
  await new Promise((r) => tunnel.listen(0, "127.0.0.1", r));

  return {
    hits: () => hits,
    port: tunnel.address().port,
    async close() {
      zone.closeAll();
      for (const s of sockets.values()) s.destroy();
      await Promise.all([new Promise((r) => tunnel.close(r)), new Promise((r) => backend.close(r))]);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One request: WebSocket to the "relay", TLS inside it, HTTP inside that. */
function request(port, auth) {
  return new Promise((resolve, reject) => {
    let settled = false, tlsSock = null, text = "";
    const ws = new WebSocket(`ws://127.0.0.1:${port}/x/${ID}/https`);
    const timer = setTimeout(() => finish(new Error(`timeout; received ${JSON.stringify(text)}`)), 8000);
    function finish(err, out) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { tlsSock?.destroy(); } catch {}
      try { ws.terminate(); } catch {}
      err ? reject(err) : resolve(out);
    }
    ws.on("error", (e) => finish(e));
    ws.on("open", () => {
      const stream = createWebSocketStream(ws);
      stream.on("error", () => {});
      tlsSock = tls.connect({ socket: stream, servername: NAME, rejectUnauthorized: false }, () => {
        tlsSock.write(`GET / HTTP/1.1\r\nHost: ${NAME}\r\nConnection: close\r\n`
                    + `${auth ? `Authorization: ${auth}\r\n` : ""}\r\n`);
      });
      tlsSock.on("data", (b) => {
        text += b.toString();
        const end = text.indexOf("\r\n\r\n");
        const cl = /\r\ncontent-length:\s*(\d+)/i.exec(text);
        if (end >= 0 && cl && Buffer.byteLength(text.slice(end + 4)) >= Number(cl[1])) finish(null, text);
      });
      tlsSock.on("end", () => finish(null, text));
      tlsSock.on("error", (e) => finish(e));
    });
  });
}

const statusOf = (t) => Number(/^HTTP\/1\.1 (\d+)/.exec(t)?.[1]);

test("a PRIVATE deployment through the real app zone: anonymous and stranger never reach it", async () => {
  const r = await rig();
  try {
    const anon = await request(r.port);
    assert.equal(statusOf(anon), 401, "anonymous must be refused");
    assert.ok(!anon.includes("PRIVATE FIXTURE"), "and must not see the body");
    assert.equal(r.hits(), 0, "the app must not be reached at all");

    const wrong = await request(r.port, "stranger");
    assert.equal(statusOf(wrong), 403);
    assert.ok(!wrong.includes("PRIVATE FIXTURE"));
    assert.equal(r.hits(), 0);

    const right = await request(r.port, "owner");
    assert.equal(statusOf(right), 200);
    assert.ok(right.includes("PRIVATE FIXTURE"));
    assert.equal(r.hits(), 1, "and only the owner ever reached it");
  } finally { await r.close(); }
});

test("a PUBLIC deployment through the same path is served to anyone", async () => {
  // The other half of the branch: a public socket app is spliced straight to its port, which is
  // the fast path this box has always had. If the private check leaked into it, this fails.
  const r = await rig({ isPublic: true });
  try {
    const anon = await request(r.port);
    assert.equal(statusOf(anon), 200);
    assert.ok(anon.includes("PRIVATE FIXTURE"), "a public app answers without any token");
    assert.equal(r.hits(), 1);
  } finally { await r.close(); }
});
