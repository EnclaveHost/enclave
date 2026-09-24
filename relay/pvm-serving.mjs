// pvm-serving.mjs -- the relay's carrier for a pVM DEPLOYMENT (shielded/anchor/avf/RELAY-SERVING.md; LAB module, NOT wired
// into api-relay.js and not deployed): POST /x/<id>/pvm/evidence and POST /x/<id>/pvm/sealed carry a buyer's bytes to the
// pVM tunnel of that deployment's ON-CHAIN runner and the VM's answer back, as bytes -- exactly the lab web carrier's two
// endpoints (cpu/web-carrier.mjs), under the deployment's path.
//   - resolve(id) must return the runner's live endpoint from the LEDGER (runnerEndpointOf), never a fan-out probe; it
//     must be tunnel://<name>, and the hub must accept the stream for that kind (tunnel.js spliceRaw: pvm-evidence for an
//     AVF-attested pVM tunnel, pvm-app-sealed only for an app the hub verified). Anything else: a plain 404, no body a
//     client could mistake for evidence, no fallback to another tunnel or enclave.
//   - Only full canonical ids (0x + 64 lowercase hex): no prefix, so nothing ambiguous can be resolved.
//   - Bounds as the lab carrier: evidence 256 B in / 256 KiB out, sealed 1 MiB + 4 in / 16 MiB + 64 out; the answer is
//     streamed as it arrives, with backpressure; a buyer that goes away closes the stream to the VM.
//   - A per-deployment and a per-client rate (every evidence request costs the VM an attestation): 429, plain.
//   - Nothing is parsed or logged beyond sizes and timings.
// The relay is a CARRIER: none of this is the client's trust. The client verifies the VM itself, and the id is only a
// route -- the evidence names no deployment, so a hostile relay could still route to another genuine instance of the same
// app (RELAY-SERVING.md "Not given").
import { Duplex } from "node:stream";

const ID = /^0x[0-9a-f]{64}$/;
const KINDS = { evidence: ["pvm-evidence", 256, 256 << 10, "application/json"], sealed: ["pvm-app-sealed", (1 << 20) + 4, (16 << 20) + 64, "application/octet-stream"] };

/** A fixed-window counter per key: allow(key) -> true while fewer than `max` calls in the current `ms` window. */
export function windowLimiter({ max, ms, now = Date.now }) {
  const seen = new Map();
  return (key) => {
    const t = now(), w = seen.get(key);
    if (!w || t - w.start >= ms) { seen.set(key, { start: t, n: 1 }); return true; }
    if (w.n >= max) return false;
    w.n++; return true;
  };
}

/**
 * handle(req, res) -> true when the request was a pVM carrier request (answered), false otherwise (not ours).
 * resolve(id): Promise<string|null> the ledger runner's live endpoint; hub.spliceRaw(name, socket, kind) -> bool.
 */
export function createPvmServing({ resolve, hub, emit = () => {}, perDeployment = windowLimiter({ max: 60, ms: 60000 }),
                                   perClient = windowLimiter({ max: 30, ms: 60000 }), clientOf = (req) => req.socket.remoteAddress || "?" }) {
  const plain = (res, status) => { if (!res.headersSent) { res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" }); } res.end(); };
  return function handle(req, res) {
    const m = /^\/x\/([^/]+)\/pvm\/(evidence|sealed)$/.exec((req.url || "").split("?")[0]);
    if (!m) return false;
    const [, id, what] = m, [kind, maxIn, maxOut, type] = KINDS[what];
    if (req.method !== "POST") return plain(res, 405), true;
    if (!ID.test(id)) return plain(res, 404), true;                      // a full canonical id only: no prefix to be ambiguous
    if (!perClient(clientOf(req)) || !perDeployment(id)) { emit({ pvm: what, id, refused: "rate" }); return plain(res, 429), true; }
    const inb = []; let nIn = 0, over = false;
    // over the bound: answer 413 first, then close the connection once the answer is out (destroying the request first
    // would reset the socket and the client would see no status at all)
    req.on("data", (d) => { if (over) return; nIn += d.length; if (nIn > maxIn) { over = true; res.setHeader("connection", "close"); plain(res, 413); res.on("finish", () => req.destroy()); } else inb.push(d); });
    req.on("end", async () => {
      if (over || res.headersSent) return;
      let ep = null; try { ep = await resolve(id); } catch { ep = null; }
      const t = typeof ep === "string" && /^tunnel:\/\/([A-Za-z0-9._-]+)$/.exec(ep);
      if (!t) { emit({ pvm: what, id, refused: ep ? "the runner is not a tunnel" : "no live runner" }); return plain(res, 404); }
      // the socket spliceRaw drives: its readable side is the buyer's bytes, what it is written is the VM's answer
      let nOut = 0, started = false; const t0 = Date.now();
      const sock = new Duplex({
        read() {},
        write(chunk, _e, cb) {
          nOut += chunk.length;
          if (nOut > maxOut) { sock.destroy(); return cb(); }
          if (!started) { started = true; res.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" }); }
          if (!res.write(chunk)) res.once("drain", cb); else cb();
        },
      });
      sock.on("close", () => { emit({ pvm: what, id, tunnel: t[1], bytesIn: nIn, bytesOut: nOut, ms: Date.now() - t0 }); if (!started) plain(res, 502); else res.end(); });
      sock.on("error", () => {});
      res.on("close", () => { if (!res.writableFinished) sock.destroy(); });   // the buyer went away: close the stream to the VM
      if (!hub.spliceRaw(t[1], sock, kind)) { emit({ pvm: what, id, refused: "the tunnel does not take this stream" }); return plain(res, 404); }
      sock.push(Buffer.concat(inb));   // the request bytes, once the stream is set up (spliceRaw reads after the open)
    });
    return true;
  };
}
