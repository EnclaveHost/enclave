// windows/node/appzone.mjs -- answering the app's OWN origin, https://<label>.app.enclave.host.
//
// THE PATH, end to end, because every hop matters and only one of them is ours:
//
//   browser ──TLS──> relay/relay.js:443        reads the SNI, terminates NOTHING
//           ──wss──> api.enclave.host/t/<box>/x/<id>/https
//           ──s+/sd/sx frames over the fleet tunnel──> this file
//           ── WebSocket unwrap ──> raw TLS bytes ──> terminate here ──> the app's own port
//
// The relay is a splice: it reads the ClientHello to know which box to hand the connection to and
// then copies bytes. So the handshake must be answered by whoever holds the lease, with a
// certificate for that name (apptls.mjs gets one), or a browser lands on a warning. That warning
// is what the console's amber padlock means: it only closes when a probe from the browser itself
// completes a real handshake.
//
// Over the tunnel the WebSocket arrives as a RAW BYTE STREAM with the upgrade request replayed
// into it (relay/tunnel.js spliceUpgrade), so this side has to be the WebSocket server as well:
// parse the request, answer 101, unwrap the frames, and only then is there TLS to terminate.
//
// WHERE TLS TERMINATES: in this process, in VTL0. See apptls.mjs's header for what that costs and
// why it is published rather than implied (`appTls.keyIn` in /availability). The plaintext is then
// proxied to the app's loopback port, which is the same brokered socket the /x/ path already uses.
import { Duplex } from "node:stream";
import net from "node:net";
import http from "node:http";
import tls from "node:tls";
import { WebSocketServer, createWebSocketStream } from "ws";

const MAX_STREAMS = 32;
const HEAD_LIMIT = 16 * 1024;          // an upgrade request that never ends is not one
const OPEN_MS = 15_000;
/**
 * The most request body this box will hold in memory for one app-zone request, when nothing
 * narrower applies.
 *
 * There has to be A number here. The handler below used to read a request with
 * `for await (const c of req) chunks.push(c)` and no bound at all, so a single client sending an
 * endless chunked body could exhaust the agent's memory before any rule was consulted - and a
 * deployment's own `maxBodyMb` could not help, because it was checked after the reading was done.
 *
 * 2 MiB is not arbitrary: the enclave gate carries a request as hex through ee-host.c's 4 MiB line
 * buffer into a 2 MiB binary staging buffer, so a gate-served app CANNOT be given more than this
 * however much is read. For an app served on its own port the bytes are only passing through, so
 * the ceiling is the operator's (ENCLAVE_APP_MAX_BODY_MB) and this is its default.
 */
const GATE_BODY_LIMIT = 2 * 1024 * 1024;

/**
 * One tunnel stream as a Duplex, so the WebSocket server can treat it as a socket.
 *
 * `ws` wants a few socket methods that mean nothing here (Nagle, keep-alive, timeouts): they are
 * no-ops rather than missing, because `ws` calls them unconditionally and a missing method is a
 * crash in the middle of a handshake.
 */
class StreamSocket extends Duplex {
  constructor(sendFrame, sid, pressure) {
    super({ highWaterMark: 256 * 1024 });
    this.sid = sid;
    this._send = sendFrame;
    // How much the tunnel's own socket is still holding. Without this there is no backpressure
    // anywhere in the path: a guest streaming a 400 KB response would queue every frame in the
    // agent's WebSocket buffer and the only limit would be memory.
    this._pressure = pressure || (() => 0);
    this._closed = false;
  }
  _read() {}
  _write(chunk, _enc, cb) {
    if (this._closed) return cb();
    this._send({ t: "sd", sid: this.sid, d: Buffer.from(chunk).toString("base64") });
    // Hand the callback back only once the tunnel has drained enough, which is what makes the
    // pipe above this one slow down instead of buffering without bound.
    const wait = () => {
      if (this._closed || this._pressure() < 4 * 1024 * 1024) return cb();
      setTimeout(wait, 20);
    };
    wait();
  }
  _final(cb) { this.closeRemote(); cb(); }
  _destroy(err, cb) { this.closeRemote(); cb(err); }
  closeRemote() {
    if (this._closed) return;
    this._closed = true;
    this._send({ t: "sx", sid: this.sid });
  }
  feed(buf) { this.push(buf); }
  remoteEnded() { this._closed = true; this.push(null); }
  // the socket surface `ws` reaches for
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  setTimeout() { return this; }
  get remoteAddress() { return "127.0.0.1"; }
  get remotePort() { return 0; }
}

/**
 * The app-zone half of the agent.
 *
 * `resolve(id)` answers { port, cert: { key, cert, name } } for a deployment this box serves, or
 * null. It is a callback rather than a lookup in here because the node owns both facts and this
 * file should not know how it stores them.
 */
/**
 * The caller's address as this box can know it.
 *
 * On the app's own hostname the relay splices TLS bytes without terminating them, so there is no
 * forwarded header and no real peer address to read: every caller shares one bucket here. That is
 * a real difference from the /x/ path and it is published rather than implied (host.features).
 */
/**
 * Read a request body, stopping the moment it passes `limit`.
 *
 * Exported because this is the part that has to be TRUE rather than plausible: the handler used to
 * read with `for await (...) chunks.push(c)` and no bound, so a client sending an endless chunked
 * body could exhaust the agent's memory before any rule was consulted - and checking a declared
 * content-length afterwards caught nothing, because a chunked request declares no length.
 *
 * Returns `{ body, over }`. When `over`, nothing beyond the limit was ever retained: the loop
 * stops at the first chunk that crosses it, so the peak is one chunk over the cap, not the whole
 * body. The caller answers 413 and destroys the connection - without that the client keeps
 * streaming into a socket nobody is draining.
 */
export async function readBounded(req, limit) {
  const chunks = [];
  let seen = 0;
  for await (const c of req) {
    seen += c.length;
    if (seen > limit) return { body: Buffer.alloc(0), over: true, seen };
    chunks.push(c);
  }
  return { body: Buffer.concat(chunks), over: false, seen };
}

/**
 * Read a bounded body, or answer 413 and close. Returns the body, or null when it refused.
 *
 * The order is: stop reading, answer, then close once the answer has FLUSHED (`res.finish`),
 * with `connection: close` so the peer does not try to reuse the socket.
 *
 * Measured, because I first wrote it the other way round and then claimed a failure I had not
 * seen: destroying the request stream immediately after `res.end()` ALSO delivers the 413 on node
 * 22 - the response is already on its way out. So this ordering is not a bug fix, it is simply the
 * version that does not depend on that timing. Waiting for `finish` is unambiguous; racing a flush
 * against a destroy is the kind of thing that works until a body is one packet larger.
 */
export async function readOrRefuse(req, res, limit, onRefuse = () => {}) {
  const r = await readBounded(req, limit);
  if (!r.over) return r.body;
  req.pause();
  onRefuse(limit);
  res.writeHead(413, { "content-type": "application/json", "connection": "close" });
  res.end(JSON.stringify({ error: "waf_body",
    message: `Request body exceeds the ${(limit / 1048576).toFixed(3)} MB limit for this deployment.` }));
  // Only now, and only once the bytes are out.
  res.once("finish", () => { try { req.socket?.destroy(); } catch {} });
  return null;
}

/**
 * The caller's address as this box can know it on the APP ZONE, which is: it cannot.
 *
 * The relay splices TLS bytes here WITHOUT terminating them, so nothing between the client and
 * this process inserts a forwarded header - which means any `x-forwarded-for` arriving on this
 * path was written by the CALLER, inside their own TLS session. Reading it would let anyone mint a
 * fresh rate-limit bucket per request by varying a header they control: not a weaker limit, no
 * limit at all. I had it reading that header.
 *
 * So every app-zone caller shares ONE bucket, deliberately. That is a real difference from the
 * /x/ path - where the relay does insert the header, measured - and host.features() publishes it
 * rather than implying it. The honest cost is that one heavy client can consume the rate allowance
 * for all of them here; the alternative on offer was an allowance nobody was subject to.
 */
export const APP_ZONE_BUCKET = "app-zone";
const clientIpOf = (_req) => APP_ZONE_BUCKET;


/**
 * The app zone's HTTP request handler, as a factory so it can be DRIVEN BY A TEST.
 *
 * THE CATCH BOUNDARY IS THE WHOLE CALLBACK, not just the dispatch. A client that sends a partial
 * body and disconnects makes the request stream REJECT, and this is an async callback: a rejection
 * that escapes it is an unhandled promise rejection, which on node is a process exit. That is one
 * TCP client ending the agent for every tenant on the box. The reading is exactly the part a peer
 * can make fail, and it was outside the try.
 */
export function appRequestHandler({ serveHttp, log = () => {} }) {
  return async (req, res) => {
    const id = req.socket.__enclaveId;
    try {
      // COUNTED, and stopped at the limit rather than after it. The limit is the narrowest of:
      // this deployment's own maxBodyMb, the operator's ceiling, and - for a gate-served app -
      // what the enclave's request buffer can carry at all. Reading past it would spend exactly
      // the memory the rule exists to protect, and refusing afterwards would arrive too late.
      const limit = req.socket.__enclaveBodyLimit || GATE_BODY_LIMIT;
      const body = await readOrRefuse(req, res, limit,
        (n) => log(`app-zone ${String(id).slice(0, 10)}: request body over ${n} bytes, refused and closed`));
      if (body === null) return;
      const r = await serveHttp(id, { method: req.method, pathRest: req.url,
                                      headers: req.headers, body, ip: clientIpOf(req) });
      res.writeHead(r.status || 502, r.headers || {});
      res.end(r.body || Buffer.alloc(0));
    } catch (e) {
      // An aborted request has nobody left to answer, so writing to it would throw again. Say it
      // once, at a lower volume than a real failure, and let the socket go.
      const gone = /ECONNRESET|aborted|premature close|socket hang up/i.test(e?.code || e?.message || "");
      log(`app-zone ${String(id).slice(0, 10)}: ${gone ? "client went away mid-request" : e.message}`);
      if (gone) { try { req.socket?.destroy(); } catch {} return; }
      try {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "enclave_error", message: e.message }));
      } catch { try { req.socket?.destroy(); } catch {} }
    }
  };
}

export function appZone({ send, resolve, pressure, serveHttp, maxBodyBytes = 0, log = () => {} }) {
  const streams = new Map();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  // The server for GATE-SERVED apps: node's own HTTP parser, fed sockets by hand. It never
  // listens on anything - a TLS socket is handed to it with emit("connection"), which is the
  // supported way to put an http.Server on top of a stream you already have.
  const httpd = http.createServer(appRequestHandler({ serveHttp, log }));
  httpd.on("clientError", (e, sock) => { try { sock.destroy(); } catch {} });

  /** A tunnel stream that is not (yet) a WebSocket: collect the upgrade request, then decide. */
  function begin(sid) {
    if (streams.size >= MAX_STREAMS) {
      send({ t: "s=", sid, ok: false, err: "too many app-zone streams on this box" });
      return null;
    }
    const sock = new StreamSocket(send, sid, pressure);
    const st = { sid, sock, head: Buffer.alloc(0), upgraded: false,
                 timer: setTimeout(() => { log(`app-zone stream ${sid}: no upgrade request in ${OPEN_MS / 1000}s`); drop(sid); }, OPEN_MS) };
    streams.set(sid, st);
    send({ t: "s=", sid, ok: true });
    return st;
  }

  function drop(sid) {
    const st = streams.get(sid);
    if (!st) return;
    streams.delete(sid);
    clearTimeout(st.timer);
    try { st.sock.destroy(); } catch {}
  }

  /** The request line and headers, once they are all here. */
  function parseHead(buf) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return null;
    const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
    const [method, url] = lines[0].split(" ");
    const headers = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return { method, url, headers, rest: buf.subarray(end + 4) };
  }

  async function onHead(st, head) {
    clearTimeout(st.timer);
    // /x/<id>/https is the browser bridge: an app-zone TLS connection for that deployment. The
    // /tls/<port> form is the declared-TCP-port path, which this box does not sell, so it is
    // refused by name rather than answered with something that is not TLS.
    // The relay addresses a deployment by its LABEL here (the first 8 hex of the id, which is
    // what the hostname carries), not by the full id: /x/0x7ae476a3/https. Both forms are
    // accepted, and the label is resolved against the leases this box actually holds.
    const m = /^\/x\/(0x[0-9a-fA-F]{8,64})\/(https|tls\/\d+)$/.exec(String(head.url || ""));
    if (!m || m[2] !== "https") {
      log(`app-zone stream ${st.sid}: refusing ${head.url}`);
      st.sock.write(`HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n`);
      return drop(st.sid);
    }
    const ref = m[1].toLowerCase();
    let target = null;
    try { target = await resolve(ref); } catch (e) { log(`app-zone ${ref}: ${e.message}`); }
    const id = target?.id || ref;
    if (!target || !target.cert || (!target.port && !target.gate)) {
      // 503 rather than a silent close: the relay logs the status and the operator can see which
      // half is missing (no app, or no certificate yet).
      log(`app-zone ${id.slice(0, 10)}: ${!target ? "not served here" : !target.cert ? "no certificate yet" : "no way to reach the app"}`);
      st.sock.write(`HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n`);
      return drop(st.sid);
    }
    // Hand the stream to the WebSocket server, which answers 101 on it.
    const req = { method: head.method || "GET", url: head.url, headers: head.headers, httpVersion: "1.1",
                  httpVersionMajor: 1, httpVersionMinor: 1, socket: st.sock, connection: st.sock };
    st.upgraded = true;
    wss.handleUpgrade(req, st.sock, head.rest, (ws) => {
      const wsStream = createWebSocketStream(ws, { decodeStrings: false });
      // Now it is just bytes: the client's TLS session, which terminates here.
      // THE CERTIFICATE IS CHOSEN BY SNI, because a deployment may answer on more than one name:
      // its own <label>.app.enclave.host and any domain its owner attached and proved. The relay
      // routes all of them down this same /x/<id>/https path, so the name is only knowable from
      // the ClientHello. `target.cert` stays the default for a client that sends no SNI at all.
      const tlsSock = new tls.TLSSocket(wsStream, {
        isServer: true, key: target.cert.key, cert: target.cert.cert,
        SNICallback: (name, cb) => {
          const n = String(name || "").toLowerCase().replace(/\.+$/, "");
          const ctx = target.contextFor && target.contextFor(name);
          if (!ctx) {
            // No context for this name: hand back the default rather than failing the handshake,
            // so a browser gets a NAME MISMATCH it can explain instead of a reset.
            //
            // Only WORTH SAYING when the name is not the default's. `contextFor` indexes the
            // domains an OWNER attached; a deployment's own <label>.app.enclave.host is never in
            // it, so every ordinary handshake logged "no certificate for e64f7cba.app.enclave.host,
            // serving e64f7cba.app.enclave.host" - a line that names the same certificate twice
            // and reads as a fault. It buried the real one, and I chased it as a defect.
            const dflt = String(target.cert.name || "").toLowerCase().replace(/\.+$/, "");
            if (n !== dflt) log(`app-zone ${id.slice(0, 10)}: no certificate for ${name}, serving ${target.cert.name}`);
            return cb(null, undefined);
          }
          cb(null, ctx);
        },
        // No client certificates, and nothing else on this socket: it is one browser's session.
        requestCert: false, rejectUnauthorized: false,
      });
      let app = null;
      // TEARDOWN, and the order is the whole point. Destroying on the app's close threw away
      // whatever was still in flight - the TLS socket's write buffer, the WebSocket stream, the
      // tunnel's own send queue - which truncated every response big enough to still be moving.
      // A 400 KB artifact came back a different length on every request. So a normal end FLUSHES:
      // the app ending ends the TLS socket (pipe's default), and only when that has closed is the
      // WebSocket closed. Destroying is for errors.
      const abort = (why) => {
        log(`app-zone ${id.slice(0, 10)}: ${why}`);
        try { tlsSock.destroy(); } catch {}
        try { if (app) app.destroy(); } catch {}
        try { ws.terminate(); } catch {}
        drop(st.sid);
      };
      const finish = () => {
        try { ws.close(); } catch {}
        drop(st.sid);
      };
      tlsSock.on("error", (e) => abort(`tls ${e.message}`));
      tlsSock.on("close", finish);
      tlsSock.on("secure", () => {
        // Only once the handshake is done is there anything to forward, and only then is it worth
        // reaching the app: a scanner that never completes a handshake costs the app nothing.
        //
        // A deployment with PROTECTION RULES is always parsed here rather than spliced to its
        // port, because a rule about methods, paths or rates cannot be applied to an opaque byte
        // stream. It costs an HTTP parse and a re-issue on the way to the same socket - the price
        // of the owner having asked for the rules at all.
        // A PRIVATE deployment is parsed here too, never spliced: an opaque byte stream carries no
        // Authorization header and no cookie, so a raw pipe to the app's port would hand a private
        // app to anyone who completed a handshake. That was reachable through this branch.
        if (target.gate || target.waf || target.private) {
          // A gate-served app has no socket. Parse the request off this connection and carry it
          // through the gate as a frame, which is the same path /x/ takes - the difference is only
          // that the TLS ended here instead of at the relay.
          // The body ceiling for THIS deployment, set before the parser sees a byte.
          tlsSock.__enclaveBodyLimit = Math.min(
            target.bodyLimit || Number.MAX_SAFE_INTEGER,
            target.gate ? GATE_BODY_LIMIT : (maxBodyBytes || GATE_BODY_LIMIT));
          tlsSock.__enclaveId = id;
          httpd.emit("connection", tlsSock);
          log(`app-zone ${id.slice(0, 10)}: ${tlsSock.servername || target.cert.name} handshake done, `
            + `${target.gate ? "carried through the gate"
                : target.private ? "parsed here so its owner can be checked"
                : "parsed here so its protection rules apply"}`);
          return;
        }
        // Belt and braces. Nothing should reach here for a private deployment - the branch above
        // takes it - but a raw pipe is exactly the path that cannot check anything, so it refuses
        // rather than trusting that the branch above was right.
        if (target.private) {
          log(`app-zone ${id.slice(0, 10)}: refusing to splice a PRIVATE deployment to its port`);
          return abort("a private deployment is never spliced");
        }
        app = net.connect(target.port, "127.0.0.1");
        // AN ANSWER, NOT A CLOSED SOCKET. Until the app has written its first byte this side owns
        // the response, and destroying the TLS socket here is what a browser renders as
        // ERR_EMPTY_RESPONSE: a blank tab with nothing to act on. It happened for real - two apps
        // stopped accepting on their brokered port, this connect got ECONNREFUSED, and their own
        // hostnames went blank while the deployments still read "running".
        //
        // So a failure BEFORE the app speaks becomes a plain 502 with a body saying which app and
        // what happened. Once the app HAS written something the response belongs to it, and the
        // only honest thing left is to drop the connection rather than append to its answer.
        let spoke = false;
        const refuse = (why) => {
          log(`app-zone ${id.slice(0, 10)}: ${why}`);
          const body = Buffer.from(JSON.stringify({ error: "app_unreachable", id,
            message: `this deployment is not accepting connections on the node right now (${why})`,
            hint: "the node holds the lease; the app inside the enclave is not answering" }) + "\n");
          try {
            tlsSock.end("HTTP/1.1 502 Bad Gateway\r\n"
              + "content-type: application/json\r\n"
              + `content-length: ${body.length}\r\n`
              + "connection: close\r\ncache-control: no-store\r\n\r\n" + body.toString("utf8"));
          } catch { try { tlsSock.destroy(); } catch {} }
          try { if (app) app.destroy(); } catch {}
          try { ws.close(); } catch {}
          drop(st.sid);
        };
        app.on("error", (e) => (spoke ? abort(`app ${e.message}`) : refuse(`app ${e.message}`)));
        app.once("data", () => { spoke = true; });
        tlsSock.pipe(app);                     // the client's request, into the app
        app.pipe(tlsSock);                     // the app's answer, ended when the app is done
        log(`app-zone ${id.slice(0, 10)}: ${target.cert.name} handshake done, serving from 127.0.0.1:${target.port}`);
      });
      wsStream.on("error", (e) => abort(`stream ${e.message}`));
    });
  }

  /** The tunnel frames this module owns: s+ (open), sd (data), sx (close). */
  function onFrame(f) {
    if (f.t === "s+") { begin(f.sid); return true; }
    const st = streams.get(f.sid);
    if (!st) return f.t === "sd" || f.t === "sx";
    if (f.t === "sx") { st.sock.remoteEnded(); drop(f.sid); return true; }
    if (f.t !== "sd") return false;
    const buf = Buffer.from(f.d || "", "base64");
    if (st.upgraded) { st.sock.feed(buf); return true; }
    st.head = Buffer.concat([st.head, buf]);
    if (st.head.length > HEAD_LIMIT) { log(`app-zone stream ${f.sid}: oversized upgrade request`); drop(f.sid); return true; }
    const head = parseHead(st.head);
    if (head) onHead(st, head).catch((e) => { log(`app-zone stream ${f.sid}: ${e.message}`); drop(f.sid); });
    return true;
  }

  return { onFrame, open: () => streams.size, closeAll: () => { for (const sid of [...streams.keys()]) drop(sid); } };
}
