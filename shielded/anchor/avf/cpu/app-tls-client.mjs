#!/usr/bin/env node
// app-tls-client.mjs -- the LAB serving prototype's client (PVM-CPU.md; NOT production): one request to a portable app served
// inside a Pixel pVM, through the relay's hub (cpu/local-hub.mjs) and the phone's Android app, with TLS 1.3 terminating IN
// the VM. The trust decision happens at the handshake, before any application byte is written:
//   1. GET <hub>/pvm-app/<name>: the app the RELAY verified (its ABI/2 evidence bound the relay's fresh nonce) and the
//      VM's attested transport key -- the only key this client accepts;
//   2. TLS 1.3 to the hub's raw app port; the peer certificate's key must be exactly that key (and the handshake signature
//      proves the peer holds it); otherwise the connection is dropped with nothing sent.
// Modes (each prints one JSON result line):
//   ok          the request, pinned; --record FILE keeps the client->server bytes (ciphertext) for `replay`
//   wrong-pin   pins a key one bit off: must refuse before sending
//   tamper      a local carrier flips one byte of the client's first encrypted record: no answer may come back
//   replay      sends a recorded session's client bytes on a new connection: no answer may come back
//   plaintext   sends plain HTTP to the app port: no HTTP may come back
//   --pin HEX   pin this key instead of the relay's (after a reconnect, an earlier boot's key must be refused)
//   node cpu/app-tls-client.mjs --hub http://127.0.0.1:18443 --name NAME --app-port 18445 --path /ping [--mode ok] [--record F]
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import { X509Certificate } from "node:crypto";

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const hub = arg("--hub", "http://127.0.0.1:18443"), name = arg("--name"), appPort = Number(arg("--app-port", "18445"));
const path = arg("--path", "/ping"), mode = arg("--mode", "ok"), record = arg("--record");
const out = (o) => { process.stdout.write(JSON.stringify({ mode, ...o }) + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function verifiedApp() {
  const r = await fetch(`${hub}/pvm-app/${name}`);
  if (r.status !== 200) return null;
  return r.json();
}

// a carrier this client controls, between it and the hub's app port: records or tampers with client->server bytes
function carrier({ tamper = false, rec = null } = {}) {
  return new Promise((resolve) => {
    const srv = net.createServer((c) => {
      const up = net.connect(appPort, "127.0.0.1");
      let flipped = false;
      c.on("data", (d) => {
        let b = Buffer.from(d);
        if (rec) rec.push(b.toString("base64"));
        // tamper: walk this chunk's TLS records and flip the last byte of the first ENCRYPTED one (type 0x17); a chunk can
        // lead with the compatibility ChangeCipherSpec (0x14) and carry the encrypted Finished and the request after it
        for (let o = 0; tamper && !flipped && o + 5 <= b.length; ) {
          const type = b[o], len = b.readUInt16BE(o + 3);
          if (type === 0x17 && o + 5 + len <= b.length) { b[o + 5 + len - 1] ^= 0x01; flipped = true; srv.flipped = true; break; }
          o += 5 + len;
        }
        up.write(b);
      });
      up.on("data", (d) => c.write(d));
      c.on("close", () => up.destroy()); up.on("close", () => c.destroy());
      c.on("error", () => up.destroy()); up.on("error", () => c.destroy());
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// TLS 1.3 through `port`, pinning `spkiHex`; resolves { refused } or { status, body, bytes, ms }
function request(port, spkiHex) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ALPNProtocols: ["http/1.1"] });
    let data = Buffer.alloc(0), sent = false, done = false;
    const finish = (o) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve({ ms: Date.now() - t0, sent, ...o }); };
    s.setTimeout(60000, () => finish({ error: "timeout" }));
    s.on("secureConnect", () => {
      const cert = s.getPeerX509Certificate ? s.getPeerX509Certificate() : new X509Certificate(s.getPeerCertificate(true).raw);
      const got = cert.publicKey.export({ type: "spki", format: "der" }).toString("hex");
      if (s.getProtocol() !== "TLSv1.3") return finish({ refused: `protocol ${s.getProtocol()}` });
      if (got !== spkiHex) return finish({ refused: "the server's key is not the attested transport key", serverKey: got.slice(-16) });
      sent = true;
      s.write(`GET ${path} HTTP/1.1\r\nHost: pvm-app\r\nConnection: close\r\n\r\n`);
    });
    s.on("data", (d) => { data = Buffer.concat([data, d]); });
    s.on("end", () => {
      const txt = data.toString("utf8"), head = txt.split("\r\n\r\n")[0];
      let body = txt.slice(head.length + 4);
      if (/transfer-encoding: chunked/i.test(head)) { let out = "", rest = body; for (;;) { const i = rest.indexOf("\r\n"); if (i < 0) break; const n = parseInt(rest.slice(0, i), 16); if (!n) break; out += rest.slice(i + 2, i + 2 + n); rest = rest.slice(i + 2 + n + 2); } body = out; }
      finish({ status: Number((head.match(/^HTTP\/1\.1 (\d{3})/) || [])[1]) || null, body, bytes: data.length });
    });
    s.on("error", (e) => finish({ error: e.code || e.message }));
  });
}

// raw bytes to the app port (replay / plaintext); resolves what came back
function raw(chunks, waitMs = 4000) {
  return new Promise((resolve) => {
    const c = net.connect(appPort, "127.0.0.1");
    let got = Buffer.alloc(0), closed = false;
    c.on("data", (d) => { got = Buffer.concat([got, d]); });
    c.on("close", () => { closed = true; });
    c.on("error", () => {});
    c.on("connect", async () => {
      for (const b of chunks) { c.write(b); await sleep(150); }
      await sleep(waitMs);
      c.destroy();
      resolve({ bytesBack: got.length, httpInClear: /HTTP\/1\.[01] \d{3}/.test(got.toString("latin1")), firstByte: got.length ? got[0] : null, closedByPeer: closed });
    });
  });
}

const app = await verifiedApp();
if (!app) { out({ refused: "the relay has not verified an app under this name: nothing is sent" }); process.exit(mode === "ok" ? 1 : 0); }
const pin = arg("--pin") || app.transportSpki;   // --pin: a key the caller insists on (e.g. an earlier boot's), instead of the relay's
if (mode === "ok") {
  const rec = record ? [] : null;
  const c = await carrier({ rec });
  const r = await request(c.address().port, pin);
  c.close();
  if (record) fs.writeFileSync(record, JSON.stringify({ note: "client->server TLS bytes of one session (ciphertext), for the replay test", chunks: rec }));
  out({ app: app.appId, runtime: app.runtimeId, pinned: pin.slice(-16), ...r });
  process.exit(r.status === 200 ? 0 : 1);
} else if (mode === "wrong-pin") {
  const wrong = pin.slice(0, -2) + ((parseInt(pin.slice(-2), 16) ^ 1).toString(16).padStart(2, "0"));
  const r = await request(appPort, wrong);
  out({ expected: "refused before sending", ...r });
  process.exit(r.refused && !r.sent ? 0 : 1);
} else if (mode === "tamper") {
  const c = await carrier({ tamper: true });
  const r = await request(c.address().port, pin);
  out({ expected: "no answer (the VM's TLS refuses the altered record)", flipped: !!c.flipped, ...r });
  c.close();
  process.exit(c.flipped && r.status !== 200 ? 0 : 1);
} else if (mode === "replay") {
  const rec = JSON.parse(fs.readFileSync(record, "utf8")).chunks.map((b) => Buffer.from(b, "base64"));
  const r = await raw(rec);
  out({ expected: "no answer (a replayed session cannot complete a new handshake)", chunks: rec.length, ...r });
  process.exit(!r.httpInClear && r.bytesBack < 4096 ? 0 : 1);
} else if (mode === "plaintext") {
  const r = await raw([Buffer.from(`GET ${path} HTTP/1.1\r\nHost: pvm-app\r\nConnection: close\r\n\r\n`)]);
  out({ expected: "no HTTP (the port speaks TLS only)", ...r });
  process.exit(!r.httpInClear ? 0 : 1);
} else { out({ error: `unknown mode ${mode}` }); process.exit(2); }
