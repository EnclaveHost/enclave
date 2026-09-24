// A browser asking an app that is not accepting, over the REAL path: tunnel frames, a real
// WebSocket, real TLS, and a port with nothing behind it.
//
// This is behaviour, not source matching. The failure it guards against is the one Steven saw -
// https://d9798e4c.app.enclave.host/ returning ERR_EMPTY_RESPONSE - and the one a review caught in
// my first fix: writing the 502 and then tearing the transport down before the bytes had left, so
// a slow tunnel delivers a truncated body or none. The slow rig below exists for that second one.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket, { createWebSocketStream } from "ws";
import { appZone } from "../windows/node/appzone.mjs";
import { selfSigned } from "../windows/node/apptls.mjs";

const ID = "0x" + "dd".repeat(32);
const NAME = "unreachable.example.com";

/**
 * The app zone wired to a loopback "relay", with the app's port pointing at NOTHING - a port that
 * was bound and released, so connecting to it is refused exactly as the live node's was.
 *
 * `chunk` and `delay` make the transport slow and backpressured: every frame the zone sends is cut
 * into small pieces and written with a gap, which is what a real tunnel under load looks like and
 * what a premature close destroys.
 */
async function rig({ chunk = 0, delay = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-unreach-"));
  // a port nobody listens on: bind then close, so the number is real and refuses
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));

  const cert = selfSigned(NAME);
  const sockets = new Map();
  let serial = 0;
  const logs = [];
  // A per-socket write QUEUE. Without one, two overlapping slow writers interleave their pieces
  // and the TLS record stream is corrupted - which is a fault in the test rig, not in the zone,
  // and it showed up as "decryption failed or bad record mac" rather than as a truncated body.
  const queues = new Map();
  const pump = (sid, s) => {
    const q = queues.get(sid);
    if (!q || q.busy) return;
    q.busy = true;
    const step = () => {
      if (s.destroyed) { q.busy = false; return; }
      if (!q.buf.length) {
        q.busy = false;
        if (q.endAfter) { try { s.end(); } catch {} }
        return;
      }
      const take = chunk ? Math.min(chunk, q.buf.length) : q.buf.length;
      s.write(q.buf.subarray(0, take));
      q.buf = q.buf.subarray(take);
      setTimeout(step, delay);
    };
    setTimeout(step, delay);
  };
  const zone = appZone({
    send: (f) => {
      const s = sockets.get(f.sid); if (!s) return;
      if (!queues.has(f.sid)) queues.set(f.sid, { buf: Buffer.alloc(0), busy: false, endAfter: false });
      const q = queues.get(f.sid);
      if (f.t === "sd") { q.buf = Buffer.concat([q.buf, Buffer.from(f.d, "base64")]); pump(f.sid, s); }
      else if (f.t === "sx") { q.endAfter = true; pump(f.sid, s); if (!q.busy && !q.buf.length) { try { s.end(); } catch {} } }
    },
    resolve: async () => ({ id: ID, port: deadPort, gate: false, cert, private: false, waf: null }),
    serveHttp: async () => ({ status: 500, headers: {}, body: "should not be reached" }),
    log: (m) => logs.push(String(m)),
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
  return { port: tunnel.address().port, deadPort, logs,
    async close() {
      zone.closeAll();
      for (const s of sockets.values()) s.destroy();
      await new Promise((r) => tunnel.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    } };
}

/** One real browser-shaped request; resolves with everything that arrived. */
function request(port, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let settled = false, tlsSock = null, text = "";
    const ws = new WebSocket(`ws://127.0.0.1:${port}/x/${ID}/https`);
    const timer = setTimeout(() => done(new Error(`timeout; received ${JSON.stringify(text)}`)), timeoutMs);
    function done(err, out) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { tlsSock?.destroy(); } catch {}
      try { ws.terminate(); } catch {}
      err ? reject(err) : resolve(out);
    }
    ws.on("error", (e) => done(e));
    ws.on("open", () => {
      const stream = createWebSocketStream(ws);
      stream.on("error", () => {});
      tlsSock = tls.connect({ socket: stream, servername: NAME, rejectUnauthorized: false }, () => {
        tlsSock.write(`GET / HTTP/1.1\r\nHost: ${NAME}\r\nConnection: close\r\n\r\n`);
      });
      tlsSock.on("data", (b) => {
        text += b.toString();
        // Finish when the declared body is complete, which is what a browser does. Waiting for the
        // socket to close would test the peer's close behaviour instead of the answer's integrity.
        const i = text.indexOf("\r\n\r\n");
        const m = i > 0 && /content-length: (\d+)/i.exec(text.slice(0, i));
        if (m && Buffer.byteLength(text.slice(i + 4)) >= Number(m[1])) done(null, text);
      });
      tlsSock.on("error", (e) => done(new Error(`${e.message}; received ${JSON.stringify(text)}`)));
      tlsSock.on("close", () => done(null, text));
    });
  });
}

const parse = (text) => {
  const i = text.indexOf("\r\n\r\n");
  assert.ok(i > 0, `no complete header block in ${JSON.stringify(text.slice(0, 200))}`);
  const head = text.slice(0, i);
  const body = text.slice(i + 4);
  const len = /content-length: (\d+)/i.exec(head);
  return { head, body, declared: len ? Number(len[1]) : null };
};

test("an app that refuses the connection answers 502 with a complete body, not an empty close", async () => {
  const r = await rig();
  try {
    const text = await request(r.port);
    assert.notEqual(text, "", "an empty response is the defect: a browser renders it as ERR_EMPTY_RESPONSE");
    const { head, body, declared } = parse(text);
    assert.match(head, /^HTTP\/1\.1 502 Bad Gateway/);
    assert.match(head, /content-type: application\/json/i);
    assert.equal(Buffer.byteLength(body), declared, "the whole declared body arrived");
    const j = JSON.parse(body);
    assert.equal(j.error, "app_unreachable");
    assert.equal(j.id, ID);
    assert.match(j.hint, /the node holds the lease/);
  } finally { await r.close(); }
});

test("the whole body still arrives over a SLOW, chunked transport", async () => {
  // 8 bytes every 15 ms: the 502 cannot leave in one write, so a premature close truncates it.
  const r = await rig({ chunk: 8, delay: 15 });
  try {
    const text = await request(r.port);
    const { head, body, declared } = parse(text);
    assert.match(head, /502 Bad Gateway/);
    assert.equal(Buffer.byteLength(body), declared,
      "this is the regression: end() followed by an immediate ws.close() lost the tail");
    assert.equal(JSON.parse(body).error, "app_unreachable");
  } finally { await r.close(); }
});

test("it is the same answer every time, and the connection does not hang", async () => {
  const r = await rig({ chunk: 16, delay: 5 });
  try {
    for (let i = 0; i < 3; i++) {
      const { head, body, declared } = parse(await request(r.port));
      assert.match(head, /502 Bad Gateway/);
      assert.equal(Buffer.byteLength(body), declared, `attempt ${i + 1}`);
    }
    assert.ok(r.logs.some((l) => /ECONNREFUSED|app connect/i.test(l)), "and it says why in the log");
    assert.equal(r.logs.some((l) => /did not flush/.test(l)), false, "the backstop timer never had to fire");
  } finally { await r.close(); }
});
