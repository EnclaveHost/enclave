// Local handoff for the EnclaveDNS 0.1.5 release: upload authorization, publish, upgrade (through the deployment's
// SessionVault). A copy of the reviewed IPNS Publisher handoff server (ens-public-site-20261021/publisher-wallet-handoff/
// server.mjs) whose code is UNCHANGED apart from this header: the steps come from chain.mjs TX_STEPS (here publish, upgrade).
// The transport and journal rules of the reviewed site activation:
//   - loopback only; one origin; the Host must be it; a per-launch random token on every POST; cross-site refused;
//     every reply no-store with a self-only CSP; no endpoint signs, and none takes a transaction from the page;
//   - one action at a time (a second click while one runs gets 409);
//   - steps strictly in order: the upload is verified before publish; publish CONFIRMED (two providers) before upgrade;
//   - every wallet request is re-prepared from the pins against a fresh two-provider anchor (chain.mjs prepareTx);
//   - the journal is written BEFORE a transaction reaches the browser, and a disk failure returns no transaction;
//   - only an explicit wallet 4001 resets an unsubmitted attempt;
//   - a lost reply is released only when the chain shows its nonce unused, and the retry keeps that nonce;
//   - a submitted hash is never replaced; a hash of another step is refused before it is recorded;
//   - a landed transaction the wallet altered (gas limit or fee caps), or a revert, halts everything for review;
//   - every journal is bound to the approved plan: a journal written under another plan refuses to load.
// Upload errors reach the page and the journal only as fixed text (UploadRefusal); anything else is withheld.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { opIdOf, TX_STEPS as TX } from "./chain.mjs";
import { UploadRefusal } from "../../site-host-live-publish/handoff/site-upload.mjs";

const OPEN = ["preparing", "awaiting-wallet", "submitted"];
const lc = (h) => String(h || "").toLowerCase();
const clean = (e) => String(e?.shortMessage || e?.message || e).replace(/0x[0-9a-fA-F]{120,}/g, "[redacted]").slice(0, 600);
const WITHHELD = "the upload did not complete (details withheld: they may carry the authorization); sign again";

/**
 * createPublisherServer({ t, plan, planSha256, journals: {session, upload, publish, upgrade, config}, now,
 *   start(), prepare(step, {reservedNonce}), verify(step, attempts, hash), release(nonce), uploadMessage(nowMs),
 *   runUpload({auth, signature, nowMs}), assets })
 */
export function createPublisherServer({ t, plan, planSha256, journals, now = () => Date.now(), start, prepare, verify, release, uploadMessage, runUpload, assets = {} }) {
  if (!/^[0-9a-f]{64}$/.test(planSha256 || "")) throw new Error("the approved plan sha256 is required");
  const token = randomBytes(24).toString("hex");
  let origin, busy = false;
  const st = {};
  const opOf = (k) => opIdOf(plan.steps.find((x) => x.step === k));
  // every journal names the plan it was written under; another plan's journal is never resumed
  for (const k of ["session", "upload", ...TX]) {
    const s = journals[k].read();
    if (s.plan && s.plan !== planSha256) throw new Error(`the ${k} journal belongs to another plan (${String(s.plan).slice(0, 12)}…); refusing to load`);
  }
  const write = (k, v) => { const r = { ...v, plan: planSha256 }; journals[k].write(r); return r; };
  st.session = journals.session.read().status === "started" ? journals.session.read() : { status: "not started" };
  st.upload = (() => { const s = journals.upload.read();
    if (s.status === "uploading") return write("upload", { status: "ready", lastError: "the previous upload was interrupted; sign again" });
    return s.status ? s : { status: "ready" }; })();
  for (const k of TX) {
    let s = journals[k].read();
    if (s.opId && s.opId !== opOf(k)) throw new Error(`the ${k} journal belongs to another operation; refusing to load`);
    if (s.status === "preparing") s = write(k, { ...s, status: "ready" });      // nothing reached the browser
    st[k] = { attempts: [], reservedNonce: null, status: "ready", ...s, step: k, opId: opOf(k) };
  }
  const set = (k, v) => { st[k] = write(k, v); };
  const stepOf = (b) => { if (!TX.includes(b.step)) throw Error("invalid step"); return b.step; };
  const blocker = () => {
    for (const k of TX) if (st[k].status === "reverted") return `step ${k} reverted on chain; halted for review`;
    for (const k of TX) if (st[k].halted) return `step ${k}: ${st[k].halted}`;
    for (const k of TX) if (OPEN.includes(st[k].status)) return `step ${k} has an open attempt (${st[k].status}); resolve it first`;
    return null;
  };
  const next = () => st.upload.status !== "uploaded" ? "upload" : TX.find((k) => st[k].status !== "confirmed") ?? null;
  const view = () => ({
    token, owner: lc(t.admin), chainId: "0x" + t.chainId.toString(16), plan: "sha256:" + planSha256, session: st.session.status, next: next(), blocked: blocker(), done: next() === null,
    upload: { status: st.upload.status, cid: st.upload.cid || null, message: st.upload.status === "awaiting-signature" ? st.upload.message : null, expiry: st.upload.expiry || null, lastError: st.upload.lastError || null },
    steps: plan.steps.map((s) => ({ n: s.n, step: s.step, kind: s.kind, title: s.title, destination: s.destination, amountWei: s.amountWei, gasCap: s.gasCap ? String(s.gasCap) : null,
      status: s.step === "upload" ? st.upload.status : st[s.step].status, hash: st[s.step]?.hash || null, nonce: st[s.step]?.reservedNonce ?? null, halted: st[s.step]?.halted || null,
      recoverable: s.step !== "upload" && st[s.step].status === "ready" && st[s.step].attempts.length > 0, transaction: st[s.step]?.request?.transaction || null,
      verification: st[s.step]?.verification ? { block: st[s.step].verification.minedBlock, providers: st[s.step].verification.providers } : null })),
  });
  const reply = (res, code, value, type = "application/json") => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    res.end(typeof value === "string" ? value : JSON.stringify(value));
  };
  // a parse error would quote the body (it may hold the signature): fixed text only
  const body = async (req) => { let b = ""; for await (const c of req) { b += c; if (b.length > 4096) throw Error("request too large"); } try { return JSON.parse(b || "{}"); } catch { throw Error("request is not JSON"); } };
  const routes = {
    async "/start"() {
      if (st.session.status === "started") return [200, view()];
      const check = await start();
      st.session = write("session", { status: "started", startedAt: new Date(now()).toISOString(), check });
      return [200, view()];
    },
    async "/upload/prepare"() {
      if (st.session.status !== "started") return [409, { error: "Start first." }];
      if (!["ready", "awaiting-signature"].includes(st.upload.status)) return [409, { error: `the upload is ${st.upload.status}` }];
      const m = uploadMessage(now());
      st.upload = write("upload", { status: "awaiting-signature", message: m.message, expiry: m.expiry });
      return [200, { message: m.message, hexMessage: m.hexMessage, expiry: m.expiry, account: lc(t.admin) }];
    },
    async "/upload/signature"(b) {
      if (st.upload.status !== "awaiting-signature") return [409, { error: "no upload authorization is awaiting a signature" }];
      const auth = { message: st.upload.message, expiry: st.upload.expiry };
      st.upload = write("upload", { ...st.upload, status: "uploading" });
      try {
        const r = await runUpload({ auth, signature: String(b.signature || ""), nowMs: now() });
        st.upload = write("upload", { status: "uploaded", cid: r.cid, carSha256: r.carSha256, blocks: r.blocks, verifiedAt: r.verifiedAt, expiry: auth.expiry });
        return [200, view()];
      } catch (e) {
        // only the upload module's fixed refusal texts are shown or journaled, and never with the signature in them
        const sig = String(b.signature || ""), msg = e instanceof UploadRefusal && !(sig.length > 8 && (e.message.includes(sig) || e.message.includes(sig.slice(2)))) ? e.message.slice(0, 300) : WITHHELD;
        st.upload = write("upload", { status: "ready", lastError: msg });
        return [409, { error: msg }];
      }
    },
    async "/tx/prepare"(b) {
      const k = stepOf(b), s = st[k];
      if (st.session.status !== "started") return [409, { error: "Start first." }];
      const why = blocker(); if (why) return [409, { error: why }];
      if (next() !== k || s.status !== "ready") return [409, { error: `step ${next()} is next; steps run in order` }];
      if (TX.slice(TX.indexOf(k) + 1).some((x) => st[x].status !== "ready" || st[x].attempts.length)) return [409, { error: "a later step already has an attempt; review required" }];
      set(k, { ...s, status: "preparing" });
      const want = plan.steps.find((x) => x.step === k);
      let request;
      try {
        request = await prepare(k, { reservedNonce: s.reservedNonce });
        const tx = request.transaction;
        if (request.step !== k || request.opId !== s.opId || lc(tx.to) !== lc(want.to) || lc(tx.data) !== lc(want.data) || BigInt(tx.value) !== 0n || lc(tx.from) !== lc(t.admin) || tx.chainId !== "0x" + t.chainId.toString(16))
          throw Error("prepared request differs from the reviewed step");
      } catch (e) { set(k, s); throw e; }
      // A disk failure here MUST NOT return a transaction to the browser.
      set(k, { ...s, status: "awaiting-wallet", request, attempts: [...s.attempts, request], reservedNonce: Number(BigInt(request.transaction.nonce)) });
      return [200, { step: k, title: want.title, destination: want.destination, amountWei: "0", transaction: request.transaction, expiresAt: request.expiresAt, estimatedFeeLimitWei: request.estimatedFeeLimitWei }];
    },
    async "/tx/rejected"(b) {
      const k = stepOf(b), s = st[k];
      if (s.status !== "awaiting-wallet" || b.code !== 4001) return [409, { error: "Only explicit wallet rejection can reset this attempt." }];
      const attempts = s.attempts.slice(0, -1);
      set(k, { ...s, status: "ready", request: undefined, attempts, reservedNonce: attempts.length ? s.reservedNonce : null });
      return [200, view()];
    },
    async "/tx/release"(b) {
      const k = stepOf(b), s = st[k];
      if (s.status !== "awaiting-wallet") return [409, { error: "Only an unanswered wallet request can be released." }];
      const r = await release(s.reservedNonce);
      set(k, { ...s, status: "ready", request: undefined, released: [...(s.released || []), r] });
      return [200, view()];
    },
    async "/tx/result"(b) {
      const k = stepOf(b), s = st[k];
      if (!/^0x[0-9a-fA-F]{64}$/.test(b.hash || "")) return [400, { error: "invalid transaction hash" }];
      const hash = b.hash.toLowerCase();
      if (!(["awaiting-wallet", "submitted"].includes(s.status) || (s.status === "ready" && s.attempts.length))) return [409, { error: "no wallet request for this step" }];
      if (s.hash && s.hash !== hash) return [409, { error: "different transaction already submitted" }];
      if (!s.hash && TX.some((x) => x !== k && lc(st[x].hash) === hash)) return [409, { error: "that transaction belongs to another step; it is not recorded here" }];
      if (s.status === "ready" && TX.some((x) => x !== k && OPEN.includes(st[x].status))) return [409, { error: blocker() }];
      set(k, { ...s, status: "submitted", hash });
      let result;
      try { result = await verify(k, st[k].attempts, hash); }
      catch (e) { if (!e?.halt) throw e; set(k, { ...st[k], halted: clean(e) }); return [409, { error: blocker() }]; }   // landed, but altered by the wallet
      set(k, { ...st[k], status: result.outcome === "confirmed" ? "confirmed" : "reverted", verification: result });
      return [200, { ...view(), verification: result }];
    },
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) return reply(res, 403, { error: "host refused" });
      if (req.headers.origin && req.headers.origin !== origin) return reply(res, 403, { error: "origin refused" });
      if (req.headers["sec-fetch-site"] === "cross-site" && !(req.method === "GET" && req.url === "/" && req.headers["sec-fetch-mode"] === "navigate")) return reply(res, 403, { error: "cross-site refused" });
      if (req.method === "GET" && assets[req.url]) return reply(res, 200, assets[req.url].body, assets[req.url].type);
      if (req.method === "GET" && req.url === "/state") return reply(res, 200, view());
      if (req.method !== "POST" || !routes[req.url]) return reply(res, 404, { error: "not found" });
      if (req.headers.origin !== origin || req.headers["x-signing-token"] !== token) return reply(res, 403, { error: "authorization refused" });
      if (busy) return reply(res, 409, { error: "another action is in progress" });
      busy = true;
      try { const b = await body(req); const [code, value] = await routes[req.url](b); return reply(res, code, value); } finally { busy = false; }
    } catch (e) { reply(res, 400, { error: clean(e) }); }
  });
  return { server, view, get state() { return st; }, get origin() { return origin; },
    async listen(port = 0) { await new Promise((ok, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", ok); }); origin = "http://127.0.0.1:" + server.address().port; return origin; },
    async close() { server.closeAllConnections(); await new Promise((ok) => server.close(ok)); } };
}
