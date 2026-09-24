// supervisor-splice.mjs - the supervisor's half of the per-app data path (C4): a client's TLS session, as the
// relay delivers it to /x/<id>/https, spliced UNOPENED to that deployment's own guest. supervisor.js imports this
// only when ISOLATION_BACKEND is set.
//
//   client --TLS--> relay (SNI route) --wss /x/<id>/https--> HERE (reads the ClientHello, holds no key for the
//   app) --enclave-splice/1--> guestd's data plane (datapath.go) --> the guest's forwarder --> the guest front,
//   where TLS ends
//
// What this side decides, and nothing more:
//   - the connection is TLS: the first record must be one well-formed ClientHello, whole within HELLO_MAX bytes
//     and HELLO_MS, or the connection is closed. There is no plaintext path and no fallback to one: the
//     supervisor's own TLS terminator is never offered for these deployments;
//   - the ClientHello names THIS deployment: its SNI must be exactly the deployment's app-zone name. A relay (or
//     anything in front of this) that delivers one app's session to another's route is refused here, before a
//     byte reaches a guest;
//   - which guest: the route comes from guestd over guestd-control/1 (an authenticated answer), must be running,
//     and must be the app this supervisor launched for the deployment. guestd then admits the connection only
//     for that instance's verified identity (app, measurement, runtime, transport key).
//
// What it is NOT: the client's trust. Every check above runs on hardware the client does not trust (the node
// CVM's word, and guestd's on the host). A client trusts the guest only after verifying it itself, over this
// same connection: the key from its own handshake, the attestation document fetched through the session that
// key protects (/.well-known/enclave-attestation, answered by the guest front, never by this process), and a
// measurement it recomputed from the pinned domain release. These checks make misrouting fail early and
// visibly; they do not make a misrouted connection acceptable to a client, and nothing here says otherwise.
//
// Bounds: HELLO_MS for the whole ClientHello; OPEN_MS to be admitted by guestd; IDLE_MS with no bytes in either
// direction closes both sides. Bytes move with stream backpressure (pipe), so a reader that stops reading
// stops the writer instead of filling this process's memory.
import net from "node:net";
import { createWebSocketStream } from "ws";

export const HELLO_MAX = 16384 + 5;   // one TLS record: 2^14 bytes of handshake, plus its 5-byte header
export const HELLO_MS = 10_000;
export const OPEN_MS = 10_000;
export const IDLE_MS = 180_000;

export class SpliceRefused extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

// parseClientHello: {state:"more"} until one whole record is here, then {state:"ok", sni} or
// {state:"reject", kind, why}. Every length is checked against what encloses it before it is used.
export function parseClientHello(buf) {
  if (buf.length < 1) return { state: "more" };
  if (buf[0] !== 0x16) return { state: "reject", kind: "not-tls", why: "the first byte is not a TLS handshake record" };
  if (buf.length < 5) return { state: "more" };
  if (buf[1] !== 0x03 || buf[2] < 0x01 || buf[2] > 0x04)
    return { state: "reject", kind: "malformed", why: "the record version is not TLS" };
  const recLen = buf.readUInt16BE(3);
  if (recLen < 4) return { state: "reject", kind: "malformed", why: "an empty handshake record" };
  if (recLen > 16384) return { state: "reject", kind: "oversize", why: `a ${recLen}-byte record exceeds TLS's 16384` };
  if (buf.length < 5 + recLen) return { state: "more" };
  const d = buf.subarray(5, 5 + recLen);
  if (d[0] !== 0x01) return { state: "reject", kind: "malformed", why: "the handshake is not a ClientHello" };
  const hsLen = (d[1] << 16) | (d[2] << 8) | d[3];
  if (hsLen !== recLen - 4)
    return { state: "reject", kind: "malformed", why: "the ClientHello does not fill exactly one record (fragmented or padded)" };
  const bad = (why) => ({ state: "reject", kind: "malformed", why });
  let o = 4 + 2 + 32;                                   // header, legacy_version, random
  const need = (n) => o + n <= d.length;
  if (!need(1)) return bad("truncated before the session id");
  o += 1 + d[o];
  if (!need(2)) return bad("truncated before the cipher suites");
  o += 2 + d.readUInt16BE(o);
  if (!need(1)) return bad("truncated before the compression methods");
  o += 1 + d[o];
  if (!need(2)) return bad("no extensions, so no SNI");
  const extEnd = o + 2 + d.readUInt16BE(o);
  o += 2;
  if (extEnd !== d.length) return bad("the extensions do not end where the ClientHello does");
  let sni = null;
  while (o < extEnd) {
    if (o + 4 > extEnd) return bad("a truncated extension header");
    const type = d.readUInt16BE(o), len = d.readUInt16BE(o + 2);
    o += 4;
    if (o + len > extEnd) return bad("an extension overruns the ClientHello");
    if (type === 0x0000) {
      if (sni !== null) return bad("two server_name extensions");
      const e = d.subarray(o, o + len);
      if (e.length < 5 || e.readUInt16BE(0) !== e.length - 2) return bad("a malformed server_name list");
      if (e[2] !== 0x00) return bad("a server_name that is not a host_name");
      const n = e.readUInt16BE(3);
      if (5 + n !== e.length) return bad("a server_name list with more than one name, or a bad name length");
      sni = e.subarray(5, 5 + n).toString("latin1").toLowerCase();   // DNS names are case-insensitive
      if (!HOSTNAME.test(sni)) return bad("the server_name is not a DNS host name");
    }
    o += len;
  }
  if (sni === null) return { state: "reject", kind: "no-sni", why: "the ClientHello names no server" };
  return { state: "ok", sni };
}

// readClientHello reads from a stream until parseClientHello decides, and returns the SNI and EVERY byte read
// (all of it is the client's and goes to the guest, in order). The stream is paused on return.
export function readClientHello(stream, { timeoutMs = HELLO_MS, maxBytes = HELLO_MAX } = {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0), done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off("data", onData); stream.off("end", onEnd); stream.off("close", onEnd); stream.off("error", onErr);
      stream.pause();
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new SpliceRefused("timeout", `no whole ClientHello within ${timeoutMs} ms`)), timeoutMs);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      const r = parseClientHello(buf);
      if (r.state === "ok") return finish(null, { sni: r.sni, head: buf });
      if (r.state === "reject") return finish(new SpliceRefused(r.kind, r.why));
      if (buf.length > maxBytes) finish(new SpliceRefused("oversize", `${buf.length} bytes and still no whole ClientHello`));
    };
    const onEnd = () => finish(new SpliceRefused("closed", "the client left before its ClientHello was whole"));
    const onErr = (e) => finish(new SpliceRefused("closed", e.message));
    stream.on("data", onData); stream.once("end", onEnd); stream.once("close", onEnd); stream.once("error", onErr);
    stream.resume();
  });
}

const HEX = (n) => new RegExp(`^[0-9a-f]{${2 * n}}$`);

// routeFor asks guestd, over the authenticated channel, which instance serves this deployment and what it was
// verified as. `expectAppId` is what the supervisor recorded when it launched the deployment: the route must
// still be that app.
export async function routeFor(transport, instanceId, expectAppId, { timeoutMs = OPEN_MS } = {}) {
  if (!instanceId) throw new SpliceRefused("no-route", "the deployment has no guest instance");
  const r = await transport.request("GET", `/vms/${encodeURIComponent(instanceId)}`, null, timeoutMs);
  const b = r && r.body;
  if (!r || r.status !== 200 || !b) throw new SpliceRefused("no-route", `guestd answered ${r && r.status} for the instance`);
  if (b.status !== "running") throw new SpliceRefused("not-running", `the instance is ${b.status}`);
  // Two instance shapes, one rule: a whole verified identity or no route. An SNP guest (guestd, "gd…") is named by
  // its launch measurement; a NucBox partition (windows/vbslike manager, "hv…") has none and is named by the guest
  // image it booted - carried as `image`, never as a measurement, so neither can be read as the other.
  const hv = /^hv[0-9a-f]{8}$/.test(String(b.id || ""));
  const route = hv
    ? { id: b.id, appId: b.appId, image: b.image, runtimeId: b.runtimeId, key: b.transportKeySha256 }
    : { id: b.id, appId: b.appId, measurement: b.measurement, runtimeId: b.runtimeId, key: b.transportKeySha256 };
  if (route.id !== instanceId || !(hv || /^gd[0-9a-f]{8}$/.test(route.id)) || !HEX(32).test(route.appId || "")
      || !(hv ? HEX(32).test(route.image || "") : HEX(48).test(route.measurement || ""))
      || !HEX(32).test(route.runtimeId || "") || !HEX(32).test(route.key || ""))
    throw new SpliceRefused("no-route", "guestd's answer does not state a whole verified identity for the instance");
  if (!HEX(32).test(String(expectAppId || "")) || route.appId !== expectAppId)
    throw new SpliceRefused("wrong-app", `the instance is app ${route.appId.slice(0, 16)}…, not the app launched for this deployment`);
  return route;
}

// openSplice connects to guestd's data plane and is admitted for exactly this route, or throws.
export function openSplice(dataAddr, route, { timeoutMs = OPEN_MS } = {}) {
  const [host, port] = splitAddr(dataAddr);
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    let buf = Buffer.alloc(0), done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.off("data", onData);
      if (err) { s.destroy(); reject(err); } else { s.pause(); resolve(s); }
    };
    const timer = setTimeout(() => finish(new SpliceRefused("timeout", `guestd did not admit the splice within ${timeoutMs} ms`)), timeoutMs);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) { if (buf.length > 512) finish(new SpliceRefused("refused", "guestd's answer is not a line")); return; }
      const line = buf.subarray(0, nl).toString("latin1");
      if (line !== "OK") return finish(new SpliceRefused("refused", `guestd refused the splice: ${line.replace(/^NO /, "")}`));
      if (buf.length > nl + 1) return finish(new SpliceRefused("refused", "guestd sent bytes before the guest could have"));
      finish(null);
    };
    s.on("data", onData);
    s.once("error", (e) => finish(new SpliceRefused("unreachable", `guestd's data plane: ${e.message}`)));
    s.once("close", () => finish(new SpliceRefused("unreachable", "guestd closed the data connection")));
    s.write(`ENCLAVE-SPLICE/1 id=${route.id} app=${route.appId} `
      + (route.image !== undefined ? `image=${route.image} ` : `measurement=${route.measurement} `)
      + `runtime=${route.runtimeId} key=${route.key}\n`);
  });
}

// GUESTD_DATA_ADDR is an operator setting: the host's loopback when the supervisor runs beside guestd, or the
// host's address as the node CVM sees it (QEMU user networking's 10.0.2.2). An IPv4 literal or localhost; no DNS,
// so nothing outside the node's own configuration decides where the ciphertext goes.
function splitAddr(a) {
  const m = /^((?:\d{1,3}\.){3}\d{1,3}|\[::1\]|localhost):(\d{1,5})$/.exec(String(a || ""));
  if (!m) throw new SpliceRefused("config", `GUESTD_DATA_ADDR=${JSON.stringify(a)} is not an IPv4 host:port`);
  return [m[1].replace(/^\[|\]$/g, ""), Number(m[2])];
}

// pipeBoth moves bytes both ways with backpressure until either side ends or fails, or nothing moves for idleMs.
// A normal end is FLUSHED to the other side (end, then destroy once it has drained), never cut.
export function pipeBoth(client, guest, { idleMs = IDLE_MS } = {}) {
  return new Promise((resolve) => {
    let last = Date.now(), up = 0, down = 0, over = false;
    const touch = () => { last = Date.now(); };
    client.on("data", (c) => { up += c.length; touch(); });
    guest.on("data", (c) => { down += c.length; touch(); });
    client.pipe(guest);
    guest.pipe(client);
    const idle = setInterval(() => { if (Date.now() - last > idleMs) end("idle", true); }, Math.max(50, Math.floor(idleMs / 4)));
    const end = (why, hard) => {
      if (over) return;
      over = true;
      clearInterval(idle);
      for (const s of [client, guest]) {
        if (hard) { s.destroy(); continue; }
        s.end();
        setTimeout(() => s.destroy(), 5000).unref();
      }
      resolve({ why, up, down });
    };
    client.once("end", () => end("client ended", false));
    guest.once("end", () => end("guest ended", false));
    client.once("close", () => end("client closed", false));
    guest.once("close", () => end("guest closed", false));
    client.once("error", (e) => end(`client error: ${e.message}`, true));
    guest.once("error", (e) => end(`guest error: ${e.message}`, true));
  });
}

// handleIsolationHttps is the whole of /x/<id>/https for a deployment on this backend. It resolves when the
// connection is over, with what happened; it never throws. `expectName` is the deployment's app-zone name.
export function handleIsolationHttps({ wss, req, socket, head, expectName, instanceId, expectAppId, transport,
                                       dataAddr, limits = {}, onOutcome = () => {} }) {
  return new Promise((resolve) => {
    wss.handleUpgrade(req, socket, head, async (ws) => {
      const stream = createWebSocketStream(ws);
      const report = (o) => { onOutcome(o); resolve(o); };
      const refuse = (kind, why) => {
        try { stream.destroy(); } catch {}
        try { ws.terminate(); } catch {}
        report({ outcome: "refused", kind, why });
      };
      stream.on("error", () => {});
      let hello;
      try { hello = await readClientHello(stream, { timeoutMs: limits.helloMs ?? HELLO_MS }); }
      catch (e) { return refuse(e.kind || "closed", e.message); }
      if (hello.sni !== expectName)
        return refuse("wrong-name", `the ClientHello names ${hello.sni}, not this deployment's ${expectName}`);
      let guest;
      try {
        const route = await routeFor(transport, instanceId, expectAppId, { timeoutMs: limits.openMs ?? OPEN_MS });
        guest = await openSplice(dataAddr, route, { timeoutMs: limits.openMs ?? OPEN_MS });
      } catch (e) {
        return refuse(e instanceof SpliceRefused ? e.kind : "no-route", e.message);
      }
      guest.write(hello.head);
      const r = await pipeBoth(stream, guest, { idleMs: limits.idleMs ?? IDLE_MS });
      report({ outcome: "spliced", ...r });
    });
  });
}
