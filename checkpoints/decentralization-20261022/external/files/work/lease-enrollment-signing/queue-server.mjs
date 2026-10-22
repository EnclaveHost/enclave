// Indexed, persistent extension of root's EIP-1193 handoff transport (handoff-server.mjs, same origin/host/token/CSP
// rules and the same per-attempt rules), for a fixed, approved list of operations. One durable journal PER OPERATION:
//   - nothing is prepared before the explicit, journaled start of the signing sequence;
//   - only the NEXT unconfirmed operation can be prepared, and only while no other operation has an open or unknown
//     attempt (awaiting-wallet / submitted) and none reverted (a revert halts the queue for review);
//   - the journal is written BEFORE a transaction reaches the browser; a disk failure returns no transaction;
//   - only an explicit wallet 4001 resets an unsubmitted attempt; a lost reply is released only when the chain shows its
//     nonce unused, and the op keeps that nonce (a stale wallet prompt and the retry cannot both land);
//   - a submitted hash is never replaced; a hash of another operation or of a setup stage is refused BEFORE recording;
//   - a journal written for another plan or operation refuses to load.
// The browser alone asks the wallet to sign and send.
import http from "node:http";
import { randomBytes } from "node:crypto";

const OPEN = ["preparing", "awaiting-wallet", "submitted"];
const lc = (h) => String(h || "").toLowerCase();

export function createQueueServer({ operations, planSha256, journals, session, prepare, verify, release, start, setupHashes = [], assets = {} }) {
  if (journals.length !== operations.length) throw new Error("one journal per operation is required");
  const states = journals.map((j, i) => {
    const s = j.read(), op = operations[i];
    if (s.opId !== undefined && (s.opId !== op.opId || s.planSha256 !== planSha256)) throw new Error(`journal ${i + 1} belongs to another plan or operation; refusing to load`);
    if (s.status === "preparing") { const r = { ...s, status: "ready" }; j.write(r); return r; }   // nothing ever left the server
    return s.opId ? s : { status: "ready", opId: op.opId, planSha256, index: i, attempts: [], reservedNonce: null };
  });
  let sess = session.read(), origin, busy = false;
  if (sess.status === "started" && sess.planSha256 !== planSha256) throw new Error("the signing session was started for another plan; refusing to load");
  const token = randomBytes(24).toString("hex");
  const set = (i, value) => { journals[i].write(value); states[i] = value; };
  const next = () => states.findIndex((s) => s.status !== "confirmed");
  const blocker = () => {
    const r = states.findIndex((s) => s.status === "reverted");
    if (r >= 0) return `operation ${r + 1} reverted on chain; the queue is halted for review`;
    const o = states.findIndex((s) => OPEN.includes(s.status));
    return o >= 0 ? `operation ${o + 1} has an open attempt (${states[o].status}); resolve it first` : null;
  };
  const view = () => {
    const confirmedWei = operations.reduce((s, o, i) => s + (states[i].status === "confirmed" ? BigInt(o.value) : 0n), 0n);
    const totalWei = operations.reduce((s, o) => s + BigInt(o.value), 0n), n = next();
    return { token, planSha256, admin: operations[0].from, session: sess.status === "started" ? "started" : "not started", next: n < 0 ? null : n, blocked: blocker(),
      totals: { operations: operations.length, confirmed: states.filter((s) => s.status === "confirmed").length, totalWei: String(totalWei), confirmedWei: String(confirmedWei), remainingWei: String(totalWei - confirmedWei),
        remainingSignatures: states.filter((s) => s.status !== "confirmed").length },
      operations: operations.map((o, i) => ({ index: i, title: o.title, appLabel: o.appLabel, action: o.action, kind: o.kind, to: o.to, amountWei: String(BigInt(o.value)), status: states[i].status,
        hash: states[i].hash || null, nonce: states[i].reservedNonce, recoverable: states[i].status === "ready" && states[i].attempts.length > 0, transaction: states[i].request?.transaction || null })) };
  };
  const reply = (res, code, value, type = "application/json") => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    res.end(typeof value === "string" ? value : JSON.stringify(value));
  };
  const body = async (req) => { let b = ""; for await (const c of req) { b += c; if (b.length > 2048) throw Error("request too large"); } return JSON.parse(b || "{}"); };
  const indexOf = (b) => { if (!Number.isInteger(b.index) || b.index < 0 || b.index >= operations.length) throw Error("invalid operation index"); return b.index; };
  const routes = {
    async "/start"() {
      if (sess.status === "started") return [200, view()];
      const check = await start(operations.filter((_o, i) => states[i].status !== "confirmed"));
      sess = { status: "started", planSha256, startedAt: new Date().toISOString(), check }; session.write(sess);
      return [200, view()];
    },
    async "/prepare"(b) {
      const i = indexOf(b), s = states[i];
      if (sess.status !== "started") return [409, { error: "Start the signing sequence first." }];
      const why = blocker(); if (why) return [409, { error: why }];
      if (i !== next() || s.status !== "ready") return [409, { error: `Operation ${next() + 1} is next; operations are signed in order.` }];
      if (states.slice(i + 1).some((x) => x.status !== "ready" || x.attempts.length)) return [409, { error: "a later operation already has an attempt; review required" }];
      set(i, { ...s, status: "preparing" });
      const op = operations[i], later = operations.slice(i + 1).reduce((t, o) => t + BigInt(o.value), 0n);
      let request;
      try {
        request = await prepare(op, { reservedNonce: s.reservedNonce, laterValueWei: later });
        const t = request.transaction;
        if (request.opId !== op.opId || lc(t.to) !== lc(op.to) || lc(t.data) !== lc(op.data) || BigInt(t.value) !== BigInt(op.value) || lc(t.from) !== lc(op.from))
          throw Error("prepared request differs from the approved operation");
      } catch (e) { set(i, s); throw e; }
      // A disk failure here MUST NOT return a transaction to the browser.
      set(i, { ...s, status: "awaiting-wallet", request, attempts: [...s.attempts, request], reservedNonce: Number(BigInt(request.transaction.nonce)) });
      return [200, { index: i, title: op.title, transaction: request.transaction, estimatedFeeLimitWei: request.estimatedFeeLimitWei }];
    },
    async "/rejected"(b) {
      const i = indexOf(b), s = states[i];
      if (s.status !== "awaiting-wallet" || b.code !== 4001) return [409, { error: "Only explicit wallet rejection can reset this attempt." }];
      const attempts = s.attempts.slice(0, -1);
      set(i, { ...s, status: "ready", request: undefined, attempts, reservedNonce: attempts.length ? s.reservedNonce : null });
      return [200, view()];
    },
    async "/release"(b) {
      const i = indexOf(b), s = states[i];
      if (s.status !== "awaiting-wallet") return [409, { error: "Only an unanswered wallet request can be released." }];
      const r = await release(operations[i], s.reservedNonce);
      set(i, { ...s, status: "ready", request: undefined, released: [...(s.released || []), r] });
      return [200, view()];
    },
    async "/result"(b) {
      const i = indexOf(b), s = states[i];
      if (!/^0x[0-9a-fA-F]{64}$/.test(b.hash || "")) return [400, { error: "invalid transaction hash" }];
      const hash = b.hash.toLowerCase();
      if (!(["awaiting-wallet", "submitted"].includes(s.status) || (s.status === "ready" && s.attempts.length))) return [409, { error: "no wallet request for this operation" }];
      if (s.hash && s.hash !== hash) return [409, { error: "different transaction already submitted" }];
      // A hash that belongs to another operation or a setup stage is refused BEFORE it is recorded here.
      if (!s.hash && (setupHashes.map(lc).includes(hash) || states.some((x, j) => j !== i && lc(x.hash) === hash))) return [409, { error: "that transaction belongs to another operation or setup stage; it is not recorded here" }];
      if (s.status === "ready" && states.some((x, j) => j !== i && OPEN.includes(x.status))) return [409, { error: blocker() }];
      set(i, { ...s, status: "submitted", hash });
      const result = await verify(operations[i], states[i].attempts, hash);
      set(i, { ...states[i], status: result.outcome === "confirmed" ? "confirmed" : "reverted", verification: result });
      return [200, { ...view(), verification: result }];
    },
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) return reply(res, 403, { error: "host refused" });
      if (req.headers.origin && req.headers.origin !== origin) return reply(res, 403, { error: "origin refused" });
      if (req.headers["sec-fetch-site"] === "cross-site" && !(req.method === "GET" && req.url === "/" && req.headers["sec-fetch-mode"] === "navigate")) return reply(res, 403, { error: "cross-site refused" });
      if (req.method === "GET" && assets[req.url]) return reply(res, 200, assets[req.url].body, assets[req.url].type);
      if (req.method === "GET" && req.url === "/queue") return reply(res, 200, view());
      if (req.method !== "POST" || !routes[req.url]) return reply(res, 404, { error: "not found" });
      if (req.headers.origin !== origin || req.headers["x-signing-token"] !== token) return reply(res, 403, { error: "authorization refused" });
      if (busy) return reply(res, 409, { error: "another action is in progress" });
      busy = true;
      try { const b = await body(req); const [code, value] = await routes[req.url](b); return reply(res, code, value); } finally { busy = false; }
    } catch (e) { reply(res, 400, { error: [e.shortMessage || e.message, e.details].filter(Boolean).join(" ").slice(0, 700) }); }
  });
  return { server, get states() { return states; }, get session() { return sess; }, get origin() { return origin; }, view,
    async listen(port = 0) { await new Promise((ok, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", ok); }); origin = "http://127.0.0.1:" + server.address().port; return origin; },
    async close() { server.closeAllConnections(); await new Promise((ok) => server.close(ok)); } };
}
