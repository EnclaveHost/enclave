// pvm-serving.mjs -- the relay's carrier for a pVM DEPLOYMENT (shielded/anchor/avf/RELAY-SERVING.md; LAB): wired into
// api-relay.js behind PVM_SERVING, which is OFF by default and not enabled anywhere; not deployed. POST /x/<id>/pvm/evidence and POST /x/<id>/pvm/sealed carry a buyer's bytes to the
// pVM tunnel of that deployment's ON-CHAIN runner and the VM's answer back, as bytes -- exactly the lab web carrier's two
// endpoints (cpu/web-carrier.mjs), under the deployment's path.
//   - resolve(id) must return the runner's live endpoint from the LEDGER (pvmRunnerResolver, the carrier's own: never the
//     app router's runnerEndpointOf, never a fan-out probe); it
//     must be tunnel://<name>, and the hub must accept the stream for that kind (tunnel.js spliceRaw: pvm-evidence for an
//     AVF-attested pVM tunnel, pvm-app-sealed only for an app the hub verified). Anything else: a plain 404, no body a
//     client could mistake for evidence, no fallback to another tunnel or enclave.
//   - Only full canonical ids (0x + 64 lowercase hex): no prefix, so nothing ambiguous can be resolved. Only the EXACT raw
//     routes, POST, no query (carrierRoute): anything else is not the carrier's and falls through to the relay (U7).
//   - Bounds as the lab carrier: evidence 256 B in / 256 KiB out, sealed 1 MiB + 4 in / 16 MiB + 64 out; the answer is
//     streamed as it arrives, with backpressure, and aborted (never ended cleanly) past its bound; a buyer that goes away
//     closes the stream to the VM.
//   - A per-deployment and a per-client rate (every evidence request costs the VM an attestation): 429, plain.
//   - Nothing is parsed or logged beyond sizes and timings.
// The BOOTSTRAP route (RUNNER-AGENT.md "Before the lease"): POST /t/<name>/pvm/evidence carries the EVIDENCE kind only (never
// sealed) to the pVM tunnel attached under <name> -- no ledger lookup, because it exists for the one moment the ledger cannot
// answer: before a runner is registered and leased, its owner must read the VM's attested proof key over its own nonce, and
// the relay is the only path to the VM. The same bounds, the same per-client rate, a per-tunnel rate, sizes-only logging and
// plain refusals; the hub still gives the evidence kind only to an AVF-attested pVM tunnel (tunnel.js spliceRaw). api-relay.js
// hands a /t/ path to this handler only when that name is an attached pVM (mode "avf") tunnel, so every other tunnel's /t/
// proxy is untouched.
// The relay is a CARRIER: none of this is the client's trust. The client verifies the VM itself, and the id is only a
// route -- the evidence names no deployment, so a hostile relay could still route to another genuine instance of the same
// app (RELAY-SERVING.md "Not given").
import { Duplex } from "node:stream";

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

// ---- the relay's wiring (api-relay.js): an explicit switch, OFF by default ----
const ON = /^(1|true|on|yes)$/i;
const HEX64 = /^[0-9a-f]{64}$/;
// The carrier's two routes, as a carve-out that sits AHEAD of the relay's tenant-eligibility refusals (U7; enclave-99's
// conditions): the RAW request target -- before any decoding -- must be EXACTLY /x/<canonical id>/pvm/{evidence,sealed} or
// /t/<name>/pvm/evidence, the method POST, and no query. Nothing percent-encoded, no backslash, no repeated slash, no dot
// segment, no trailing slash or segment, no case variant: anything else is NOT the carrier's and falls through to the
// relay's own handling unchanged (round 2's bypass was a canonicalized path judged while the raw one was forwarded).
export function carrierRoute(req) {
  if (!req || req.method !== "POST") return null;
  const raw = String(req.url || "");
  const m = /^\/x\/(0x[0-9a-f]{64})\/pvm\/(evidence|sealed)$/.exec(raw);
  if (m) return { id: m[1], what: m[2], tunnel: null };
  const t = /^\/t\/([A-Za-z0-9_-]{1,64})\/pvm\/evidence$/.exec(raw);
  return t ? { id: null, what: "evidence", tunnel: t[1] } : null;
}
// Every carrier answer, refusals included: never sniffed, never a document (a phone row is not a tenant host; its answers
// carry no cookie and take none -- the carrier forwards the request BODY only, never the caller's headers)
const CARRIER_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'" };

/**
 * PVM_APP_IDS, PVM_APP_RUNTIME_IDS: comma lists in the ABI/2 wire form EXACTLY -- 64 lowercase hex, no 0x, whitespace only
 * around commas, no empty element, no duplicate. Anything else nulls the whole policy (the relay then answers 503): an
 * operator's typo fails loudly at startup, it is never repaired. Admission is the CROSS PRODUCT, as the hub checks it
 * (tunnel.js pvmApp): any listed app over any listed runtime -- the lists do not pair an app with its runtimes.
 */
export function pvmAppPolicyFromEnv(env) {
  const list = (v) => { const xs = String(v ?? "").split(",").map((x) => x.trim()); return xs.length && xs.every((x) => HEX64.test(x)) && new Set(xs).size === xs.length ? xs : null; };
  const appIds = list(env.PVM_APP_IDS), runtimeIds = list(env.PVM_APP_RUNTIME_IDS);
  return appIds && runtimeIds ? { appIds, runtimeIds } : null;
}

/**
 * The relay's switch: PVM_SERVING (1/true/on/yes). OFF (the default, and any other value): { enabled: false } -- nothing is
 * built and the relay behaves exactly as without this module. ON: { enabled, missing, attestPvmApp, handler(deps) }:
 *   - missing: what the relay lacks to serve pVM deployments -- AVF attach, the pVM CPU policy, the app admission policy.
 *     With anything missing, handler() CLAIMS the two routes and answers each with a plain, empty 503: fail closed, and
 *     never a fall-through to the ordinary /x proxy.
 *   - attestPvmApp: the tunnel hub's app admission policy (tunnel.js attest.pvmApp) when nothing is missing, else null.
 * While ON, a POST to exactly /x/<id>/pvm/evidence or /x/<id>/pvm/sealed (no query) is RESERVED for every deployment on the
 * relay's API host (an app's own POST of that name is not reachable through /x); any other method or form of those paths is
 * the relay's ordinary /x path, under its tenant-eligibility rules (U7). api-relay.js calls the handler only on its /x gateway, after app
 * subdomains, custom domains, the MCP host, box hosts and /t/, so an app's own origin never reaches it; WebSocket upgrades
 * on those paths are not intercepted.
 */
export function pvmServingFromEnv(env, { avfOn = false, pvmCpuOn = false } = {}) {
  if (!ON.test(String(env.PVM_SERVING || "").trim())) return { enabled: false };
  const app = pvmAppPolicyFromEnv(env);
  const missing = [!avfOn && "AVF attach (METAL_AVF_*)", !pvmCpuOn && "the pVM CPU policy (PVM_CPU_*)",
                   !app && "the app admission policy (PVM_APP_IDS and PVM_APP_RUNTIME_IDS, 64-hex lists)"].filter(Boolean);
  const refuseAll = (req, res) => {
    if (!carrierRoute(req)) return false;
    res.writeHead(503, { "content-type": "text/plain", ...CARRIER_HEADERS, connection: "close" }); res.end(); return true;
  };
  return { enabled: true, missing, attestPvmApp: missing.length ? null : app, handler: (deps) => (missing.length ? refuseAll : createPvmServing(deps)),
           pvmRunnerResolver };   // the carrier's own resolver, handed out with the handler (OFF, this module is never loaded)
}

/**
 * The pVM carrier's OWN resolver (RELAY-SERVING.md "Routing: the carrier's own resolver"; reviewed with the verifier
 * session). /x/<D>/pvm/{evidence,sealed} ONLY -- never the app router, an app subdomain, a custom domain, a WS upgrade or a
 * certificate. It answers "tunnel://<name>" or null:
 *   - D is a FULL canonical id (0x + 64 lowercase hex; no prefix, nothing ambiguous) whose ledger row has a runner and a
 *     LIVE lease (leaseUntil in the future, judged at THIS request: a lease that lapses mid-session refuses the next one);
 *   - the ledger is read through the caller's cache; a miss (no row, or no live lease) gets ONE fresh read, then no route;
 *     a read that fails is no route -- never an owner cache, never a fan-out probe of live rows;
 *   - the runner must be one of the hub's CURRENT tunnels (origins(): tunnel://<name>, the row the hub builds from its own
 *     attach verdict) whose MODE is the hub's "avf" (set only after a verified AVF attach; a hello cannot set it) and whose
 *     own public URL hashes to that runner id.
 * The tier is NOT required: a tunnel re-attached in place carries none (the tier is the inference lane's capability
 * admission -- the model and a self-test after the attach -- not a security gate). What each stream may carry is still
 * the hub's own judgement (spliceRaw: evidence for an AVF-attested attach, sealed only for an app it verified), and the
 * client verifies the VM itself.
 * ledgerRows(): Promise<rows> (the caller's cached ledger read); expire(): drop that cache so the next read is fresh;
 * origins(): the hub's current tunnel rows; endpointId(url): Promise<registry id> (keccak256 of the URL).
 */
export function pvmRunnerResolver({ ledgerRows, expire, origins, endpointId, now = Date.now }) {
  const CANON = /^0x[0-9a-f]{64}$/, ZERO = /^0x0+$/, TUNNEL = /^tunnel:\/\/[A-Za-z0-9_-]{1,64}$/;
  const liveLease = (d) => !!d && !ZERO.test(String(d.runner)) && Number(d.leaseUntil) * 1000 > now();
  const read = async (id, fresh) => {
    if (fresh) expire();
    let rows; try { rows = await ledgerRows(); } catch { return { failed: true }; }
    const hits = (Array.isArray(rows) ? rows : []).filter((d) => d && String(d.id).toLowerCase() === id);
    return { d: hits.length === 1 ? hits[0] : null };
  };
  return async function resolve(id) {
    const h = String(id || "");
    if (!CANON.test(h)) return null;
    let r = await read(h, false);
    if (r.failed) return null;
    if (!liveLease(r.d)) { r = await read(h, true); if (r.failed || !liveLease(r.d)) return null; }
    const runner = String(r.d.runner).toLowerCase();
    for (const o of origins() || []) {
      if (!o || o.tunnel !== true || o.mode !== "avf" || !TUNNEL.test(String(o.endpoint)) || !o.publicUrl) continue;
      let eid; try { eid = String(await endpointId(o.publicUrl)).toLowerCase(); } catch { continue; }
      if (eid === runner) return o.endpoint;
    }
    return null;
  };
}
/**
 * handle(req, res) -> true when the request was a pVM carrier request (answered), false otherwise (not ours).
 * resolve(id): Promise<string|null> the ledger runner's live endpoint (pvmRunnerResolver); hub.spliceRaw(name, socket, kind) -> bool.
 */
// clientOf: the relay's AUTHENTICATED client identity. The default is the socket's address, which behind a front (Caddy, a
// relay) is the FRONT's -- every buyer would share one bucket -- and X-Forwarded-For is never read (spoofable). Wiring must
// pass the identity the relay's per-IP WAF already trusts. The per-deployment bucket is a courtesy to the VM (which serves
// one connection at a time); a per-(client, deployment) bucket is the wiring step's choice (RELAY-SERVING.md review).
export function createPvmServing({ resolve, hub, emit = () => {}, perDeployment = windowLimiter({ max: 60, ms: 60000 }),
                                   perClient = windowLimiter({ max: 30, ms: 60000 }), clientOf = (req) => req.socket.remoteAddress || "?",
                                   resolveTimeoutMs = 5000, maxPendingPerClient = 4, bounds = {} }) {
  const pending = new Map();   // client -> resolves in flight: a hung ledger cannot pile up requests and their bodies
  const plain = (res, status) => { if (!res.headersSent) { res.writeHead(status, { "content-type": "text/plain", ...CARRIER_HEADERS }); } res.end(); };
  // a refusal before the body is read closes the connection: the unread body is dropped, never drained, and a client can
  // not reuse a socket the server is about to reset
  const early = (res, status) => { res.setHeader("connection", "close"); plain(res, status); };
  return function handle(req, res) {
    const r = carrierRoute(req);                                          // exact, raw, POST, no query -- or not ours at all
    if (!r) return false;
    const m = !r.tunnel, tn = r.tunnel ? [null, r.tunnel] : null, { id, what } = r;
    const [kind, maxIn, maxOut, type] = [...KINDS[what].slice(0, 1), ...(bounds[what] || KINDS[what].slice(1, 3)), KINDS[what][3]];
    const who = clientOf(req), bucket = m ? id : `t/${tn[1]}`;             // the bootstrap route: a per-TUNNEL bucket
    if (!perClient(who) || !perDeployment(bucket)) { emit({ pvm: what, ...(m ? { id } : { tunnel: tn[1] }), refused: "rate" }); return early(res, 429), true; }
    if ((pending.get(who) || 0) >= maxPendingPerClient) { emit({ pvm: what, id, refused: "pending" }); return early(res, 429), true; }
    const inb = []; let nIn = 0, over = false;
    // over the bound: answer 413 first, then close the connection once the answer is out (destroying the request first
    // would reset the socket and the client would see no status at all)
    req.on("data", (d) => { if (over) return; nIn += d.length; if (nIn > maxIn) { over = true; res.setHeader("connection", "close"); plain(res, 413); res.on("finish", () => req.destroy()); } else inb.push(d); });
    req.on("end", async () => {
      if (over || res.headersSent) return;
      // the ledger answer, bounded in time: a hung resolve answers a plain 504 instead of holding the request
      pending.set(who, (pending.get(who) || 0) + 1);
      let ep = null, timedOut = false, timer;
      try { ep = tn ? `tunnel://${tn[1]}` : await Promise.race([resolve(id), new Promise((r) => { timer = setTimeout(() => { timedOut = true; r(null); }, resolveTimeoutMs); })]); }
      catch { ep = null; }
      finally { clearTimeout(timer); const n = (pending.get(who) || 1) - 1; if (n) pending.set(who, n); else pending.delete(who); }
      if (timedOut) { emit({ pvm: what, id, refused: "resolve timeout" }); return plain(res, 504); }
      const t = typeof ep === "string" && /^tunnel:\/\/([A-Za-z0-9._-]+)$/.exec(ep);
      if (!t) { emit({ pvm: what, id, refused: ep ? "the runner is not a tunnel" : "no live runner" }); return plain(res, 404); }
      // the socket spliceRaw drives: its readable side is the buyer's bytes, what it is written is the VM's answer
      let nOut = 0, started = false, cut = false; const t0 = Date.now();
      const sock = new Duplex({
        read() {},
        write(chunk, _e, cb) {
          nOut += chunk.length;
          if (nOut > maxOut) { cut = true; sock.destroy(); return cb(); }
          if (!started) { started = true; res.writeHead(200, { "content-type": type, ...CARRIER_HEADERS }); }
          if (!res.write(chunk)) res.once("drain", cb); else cb();
        },
      });
      let spliced = false;
      // an answer past the bound is ABORTED once the 200 is out (the chunked body is never terminated), so a client never
      // sees a clean end of a cut answer; before the 200, a plain 502
      sock.on("close", () => { if (!spliced) return; emit({ pvm: what, id, tunnel: t[1], bytesIn: nIn, bytesOut: nOut, ms: Date.now() - t0, ...(cut ? { cut: "past the bound" } : {}) });
        if (!started) plain(res, 502); else if (cut) res.destroy(); else res.end(); });
      sock.on("error", () => {});
      res.on("close", () => { if (!res.writableFinished) sock.destroy(); });   // the buyer went away: close the stream to the VM
      if (!hub.spliceRaw(t[1], sock, kind)) { emit({ pvm: what, id, refused: "the tunnel does not take this stream" }); return plain(res, 404); }
      spliced = true;
      sock.push(Buffer.concat(inb));   // the request bytes, once the stream is set up (spliceRaw reads after the open)
    });
    return true;
  };
}
