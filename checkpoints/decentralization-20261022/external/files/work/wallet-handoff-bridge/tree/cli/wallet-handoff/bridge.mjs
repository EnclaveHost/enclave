// cli/wallet-handoff/bridge.mjs -- hand journaled signer intents to MetaMask in a browser that is already open, over a
// loopback-only page this process serves. It is a front end to the durable external signer (cli/independent-signer.mjs),
// not a second signer:
//   - intents are created by createExternalSigner({ mode: "handoff" }).sendQuorumTx: the same per-account reservation,
//     agreed simulation, agreed pending nonce, gas and fee caps, and the same journal the CLI's `signer` commands use;
//   - a returned hash goes through the signer's attachHash -> confirmIntent (the quorum's receipt and the mined fields,
//     sender and nonce are verified), and an interrupted session is settled with resolve / attach / abandon.
// What the bridge adds:
//   - a step plan (e.g. release-adapter.mjs) re-derives each transaction from agreed chain state, and is re-checked at a
//     fresh agreed block both when an intent is prepared and again immediately before the wallet is asked;
//   - ONE wallet request per intent, ever: before the page receives the parameters, an exclusive, flushed claim file
//     is created next to the journal (handoff-claim-<intent>). A second click, a reload, another bridge process or a
//     restart finds it and never offers those parameters again;
//   - the only wallet outcome the page can record is an explicit EIP-1193 4001 rejection. Anything else (a lost answer,
//     a timeout, a closed tab) leaves the intent open until attach / resolve / an explicit abandon.
// The page never supplies transaction fields: it names a step or an intent, and returns a hash or a 4001.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256 } from "viem";
import { createExternalSigner, intentJournal, attachHash, resolveIntent, abandonIntent, isOpen, isUnresolved, SignerError } from "../independent-signer.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hex = (n) => "0x" + BigInt(n).toString(16);
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const isHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
const isRevert = (e) => { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (x.name === "ContractFunctionRevertedError" || x.name === "ExecutionRevertedError") return true; return false; };
const short = (e) => String(e?.shortMessage || e?.message || e).split("\n")[0].replace(/https?:\/\/\S+/g, "<url>").slice(0, 300);
export class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }

/** The exact eth_sendTransaction parameters of a handoff intent (the same shape the signer prints for `--signer-mode handoff`). */
export const sendParams = (rec) => ({ from: getAddress(rec.from), to: getAddress(rec.to), value: hex(rec.value), data: rec.data, nonce: hex(rec.nonce), gas: hex(rec.gas),
  maxFeePerGas: hex(rec.maxFeePerGas), maxPriorityFeePerGas: hex(rec.maxPriorityFeePerGas), chainId: hex(rec.chainId), type: "0x2" });

function syncDir(d) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(d, "r");
  try { fs.fsyncSync(fd); } catch (e) { if (e.code !== "EINVAL" && e.code !== "ENOTSUP") throw e; } finally { fs.closeSync(fd); }
}
/** Created only if absent (EEXIST otherwise), 0600, flushed with its directory entry before this returns. */
function createExclusive(f, text) {
  const fd = fs.openSync(f, "wx", 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDir(path.dirname(f));
}

/**
 * createBridge({ chain, plan, journalDir, maxFeeGwei, gasCap, waitOpts, log, checkTtlMs })
 *   -> { state(), prepare(step), claim(intent), attach(intent, ticket, hash), rejected(intent, ticket, code),
 *        resolve(intent), discard(intent), listen({ port }) -> { url, origin, close() }, settled() }
 */
export function createBridge({ chain, plan, journalDir, maxFeeGwei = 0.5, gasCap = 2_000_000n, waitOpts = { timeoutMs: 180000, pollMs: 2000 }, log = () => {}, checkTtlMs = 8000, now = Date.now }) {
  const journal = intentJournal(journalDir);
  const { from, chainId } = plan;
  if (Number(chain.chainId) !== Number(chainId)) throw new Error(`the quorum is chain ${chain.chainId}, the plan is for chain ${chainId}`);
  const steps = plan.steps, stepOf = (id) => steps.find((s) => s.id === id) || (() => { throw new HttpError(404, "no such step"); })();
  const claimFile = (id) => path.join(journal.dir, `handoff-claim-${id}`);
  const claimOf = (id) => { try { return JSON.parse(fs.readFileSync(claimFile(id), "utf8")); } catch (e) { if (e.code === "ENOENT") return null; return { unreadable: true }; } };
  const inflight = new Map();          // intent -> { hash, done: Promise, error? } (attach confirmations running here)
  const checks = new Map();            // step -> { at, verdict }

  async function check(step, { fresh = false } = {}) {
    const c = checks.get(step.id);
    if (!fresh && c && now() - c.at < checkTtlMs) return c.verdict;
    let verdict;
    try { verdict = await step.check(chain); } catch (e) { verdict = { state: "unavailable", reason: short(e) }; }
    checks.set(step.id, { at: now(), verdict });
    return verdict;
  }
  /** The intent, which must be one this plan created for this account and chain. */
  function bridgeIntent(id) {
    let rec;
    try { rec = journal.get(String(id)); } catch (e) { throw new HttpError(404, short(e)); }
    if (rec.bridge?.plan !== plan.id || !same(rec.from, from) || Number(rec.chainId) !== Number(chainId)) throw new HttpError(409, `intent ${id} was not prepared by this release`);
    return rec;
  }
  const ticketOk = (id, ticket) => {
    const c = claimOf(id);
    if (!c || c.unreadable || typeof ticket !== "string") return false;
    const a = Buffer.from(sha256(ticket)), b = Buffer.from(String(c.ticketSha256));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  function view(rec) {
    const claim = claimOf(rec.id), f = inflight.get(rec.id);
    return { id: rec.id, step: rec.bridge?.step || null, state: rec.state, open: isOpen(rec), nonce: rec.nonce, hash: rec.hash || null,
      claimed: !!claim, walletRequestedAt: claim?.at || null, minedBlock: rec.minedBlock ?? null, note: rec.note || null, adjusted: rec.adjusted || [],
      verifying: !!f && !f.settled, lastError: f?.error || null, preparedAt: rec.createdAt,
      params: sendParams(rec), calldataBytes: (rec.data.length - 2) / 2, calldataKeccak: keccak256(rec.data),
      maxNetworkFeeWei: (BigInt(rec.gas) * BigInt(rec.maxFeePerGas)).toString() };
  }

  async function state({ fresh = false } = {}) {
    const all = journal.list(), problems = journal.problems();
    const mine = all.filter((r) => r.bridge?.plan === plan.id && same(r.from, from));
    const blocking = all.filter((r) => isOpen(r) && same(r.from, from) && Number(r.chainId) === Number(chainId) && r.bridge?.plan !== plan.id)
      .map((r) => ({ id: r.id, state: r.state, mode: r.mode, nonce: r.nonce }));
    const out = [];
    let earlierDone = true;
    for (const s of steps) {
      const verdict = await check(s, { fresh });
      const ints = mine.filter((r) => r.bridge.step === s.id);
      const current = ints.find(isOpen) || ints.at(-1) || null;
      const openAny = mine.find(isOpen);
      out.push({ id: s.id, title: s.title, links: s.links, effects: s.effects(verdict.facts), verdict: { ...verdict, tx: undefined },
        intent: current ? view(current) : null, history: ints.map((r) => ({ id: r.id, state: r.state, hash: r.hash || null })),
        canPrepare: earlierDone && verdict.state === "ready" && !openAny && !blocking.length && !problems.length });
      earlierDone = earlierDone && verdict.state === "done";
    }
    return { plan: plan.summary, from, chainId: Number(chainId), chainHex: hex(chainId), journal: journal.dir, steps: out, blocking,
      unreadable: problems.map((p) => ({ id: p.id, why: p.why })) };
  }

  async function prepare(stepId) {
    const step = stepOf(stepId);
    let open;
    try { open = journal.unresolved(from, chainId); } catch (e) { throw new HttpError(409, short(e)); }
    if (open.length) throw new HttpError(409, `intent ${open[0].id} (${open[0].state}) for this account is unresolved; settle it first`, { intent: open[0].id });
    for (const s of steps) {
      if (s === step) break;
      const v = await check(s, { fresh: true });
      if (v.state !== "done") throw new HttpError(409, `${s.title} is not confirmed on chain yet (${v.reason || v.state})`);
    }
    const v = await check(step, { fresh: true });
    if (v.state !== "ready") throw new HttpError(409, v.reason || `step is ${v.state}`);
    let handed = null;
    const signer = createExternalSigner({ from, chainId: Number(chainId), mode: "handoff", journalDir: journal.dir, feePolicy: "capped",
      onHandoff: (rec) => { journal.update(rec.id, { bridge: { plan: plan.id, step: step.id, checkedBlock: String(v.block.number) } }); handed = rec; return { handoff: rec.id }; } });
    try { await signer.sendQuorumTx(chain, { to: v.tx.to, data: v.tx.data, value: v.tx.value, maxFeeGwei, gasCap }); }
    catch (e) { if (e instanceof SignerError) throw new HttpError(409, short(e), { intent: e.intent }); throw e; }
    log(`prepared intent ${handed.id} for step ${step.id} (nonce ${handed.nonce}); nothing was sent`);
    return view(journal.get(handed.id));
  }

  async function claim(id) {
    const rec = bridgeIntent(id);
    if (!isOpen(rec) || rec.state !== "handoff" || rec.hash) throw new HttpError(409, `intent ${rec.id} is ${rec.state}${rec.hash ? ` with ${rec.hash}` : ""}; it is not offered to the wallet`);
    if (claimOf(rec.id)) throw new HttpError(409, `intent ${rec.id} was already handed to the wallet once and is never offered again. Approve or reject that request in MetaMask; if it is gone, check status (resolve) or attach its hash from the CLI`, { claimed: true });
    const step = stepOf(rec.bridge.step);
    const v = await check(step, { fresh: true });
    if (v.state !== "ready") throw new HttpError(409, `not handed to the wallet: ${v.reason || `the step is ${v.state}`}`);
    if (!same(v.tx.to, rec.to) || v.tx.data !== rec.data || BigInt(v.tx.value) !== BigInt(rec.value)) throw new HttpError(409, "not handed to the wallet: the prepared intent no longer matches the agreed step; discard it and prepare again");
    const s = await chain.snapshot(async (c, blockNumber) => {
      const [count, block] = await Promise.all([c.getTransactionCount({ address: from, blockNumber }), c.getBlock({ blockNumber })]);
      try { await c.call({ account: from, to: rec.to, data: rec.data, value: BigInt(rec.value), gas: BigInt(rec.gas), blockNumber }); return { count, baseFee: block.baseFeePerGas ?? 0n, ok: true }; }
      catch (e) { if (isRevert(e)) return { count, baseFee: block.baseFeePerGas ?? 0n, revert: short(e) }; throw e; }
    });
    if (Number(s.value.count) !== Number(rec.nonce)) throw new HttpError(409, `not handed to the wallet: nonce ${rec.nonce} of ${from} is ${Number(s.value.count) > Number(rec.nonce) ? "already used" : "not next"} at agreed block ${s.blockNumber}; resolve this intent`);
    if (s.value.revert !== undefined) throw new HttpError(409, `not handed to the wallet: the exact transaction would revert at agreed block ${s.blockNumber} (${s.value.revert})`);
    if (BigInt(s.value.baseFee) > BigInt(rec.maxFeePerGas)) throw new HttpError(409, `not handed to the wallet: the base fee (${s.value.baseFee} wei) is above this intent's max fee; discard it and prepare again`);
    const pending = await chain.each((c) => c.getTransactionCount({ address: from, blockTag: "pending" }), "pending nonce");
    if (!pending.every((n) => Number(n) === Number(rec.nonce))) throw new HttpError(409, `not handed to the wallet: the RPCs report pending nonce ${[...new Set(pending.map(String))].join("/")} for ${from}, not ${rec.nonce}; a transaction may be in flight`);
    const ticket = crypto.randomBytes(32).toString("base64url");
    try { createExclusive(claimFile(rec.id), JSON.stringify({ intent: rec.id, ticketSha256: sha256(ticket), at: now(), pid: process.pid, block: String(s.blockNumber) }) + "\n"); }
    catch (e) { if (e.code === "EEXIST") throw new HttpError(409, `intent ${rec.id} was already handed to the wallet once and is never offered again`, { claimed: true }); throw e; }
    try { journal.update(rec.id, { walletRequestedAt: now() }); } catch {}   // informational; the claim file is the record
    log(`intent ${rec.id} handed to the wallet once (agreed block ${s.blockNumber})`);
    return { intent: rec.id, ticket, params: sendParams(rec) };
  }

  async function attach(id, ticket, hash) {
    const rec = bridgeIntent(id);
    if (!ticketOk(rec.id, ticket)) throw new HttpError(403, "this page did not hand that intent to the wallet");
    if (!isHash(hash)) throw new HttpError(400, "not a 0x transaction hash");
    hash = hash.toLowerCase();
    if (rec.hash) { if (rec.hash === hash) return view(rec); throw new HttpError(409, `intent ${rec.id} already has ${rec.hash}`); }
    if (!isUnresolved(rec)) throw new HttpError(409, `intent ${rec.id} is ${rec.state}`);
    const entry = { hash, settled: false, error: null };
    entry.done = attachHash(chain, journal, rec.id, hash, waitOpts).then(
      () => { entry.settled = true; log(`intent ${rec.id}: ${hash} confirmed by the quorum`); },
      (e) => { entry.settled = true; entry.error = short(e); log(`intent ${rec.id}: ${hash} not confirmed (${entry.error})`); });
    inflight.set(rec.id, entry);
    const after = journal.get(rec.id);
    if (after.hash !== hash) { await entry.done; throw new HttpError(409, entry.error || "the hash was not attached"); }
    return view(after);
  }

  function rejected(id, ticket, code) {
    const rec = bridgeIntent(id);
    if (!ticketOk(rec.id, ticket)) throw new HttpError(403, "this page did not hand that intent to the wallet");
    if (code !== 4001) throw new HttpError(400, "only an explicit wallet rejection (EIP-1193 code 4001) is recorded; any other answer leaves the outcome open");
    if (rec.state !== "handoff" || rec.hash || !isOpen(rec)) throw new HttpError(409, `intent ${rec.id} is ${rec.state}${rec.hash ? ` with ${rec.hash}` : ""}`);
    journal.update(rec.id, { state: "rejected", note: "the wallet answered 4001: the user rejected the request in the wallet; nothing was sent", rejectedAt: now() });
    log(`intent ${rec.id}: rejected in the wallet (4001)`);
    return view(journal.get(rec.id));
  }

  async function resolve(id) {
    const rec = bridgeIntent(id);
    try { await resolveIntent(chain, journal, rec.id); } catch (e) { throw new HttpError(503, short(e)); }
    return view(journal.get(rec.id));
  }

  /** Close a prepared intent that was NEVER handed to the wallet (no claim file). Handed ones are settled from the CLI. */
  function discard(id) {
    const rec = bridgeIntent(id);
    if (claimOf(rec.id)) throw new HttpError(409, `intent ${rec.id} was handed to the wallet: settle it with run.mjs resolve / attach, or abandon it explicitly from the CLI`);
    if (rec.state !== "handoff" || rec.hash) throw new HttpError(409, `intent ${rec.id} is ${rec.state}`);
    abandonIntent(journal, rec.id);
    log(`intent ${rec.id}: discarded before it was handed to the wallet`);
    return view(journal.get(rec.id));
  }

  // ---- HTTP ----------------------------------------------------------------------------------------------------------
  const assets = Object.fromEntries([["/", "page.html", "text/html; charset=utf-8"], ["/page.js", "page.js", "text/javascript; charset=utf-8"], ["/page.css", "page.css", "text/css; charset=utf-8"]]
    .map(([p, f, type]) => [p, { body: fs.readFileSync(path.join(HERE, f)), type }]));
  const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin", "cross-origin-resource-policy": "same-origin",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
  const ROUTES = {
    "/api/prepare": [["step"], (b) => prepare(b.step)],
    "/api/claim": [["intent"], (b) => claim(b.intent)],
    "/api/attach": [["intent", "ticket", "hash"], (b) => attach(b.intent, b.ticket, b.hash)],
    "/api/rejected": [["intent", "ticket", "code"], (b) => rejected(b.intent, b.ticket, b.code)],
    "/api/resolve": [["intent"], (b) => resolve(b.intent)],
    "/api/discard": [["intent"], (b) => discard(b.intent)],
  };

  function listen({ port = 0, host = "127.0.0.1" } = {}) {
    if (host !== "127.0.0.1" && host !== "::1") throw new Error("the bridge only listens on loopback");
    const token = crypto.randomBytes(32).toString("base64url");
    let origin, hostHeader;
    const tokenOk = (t) => { const a = Buffer.from(String(t ?? "")), b = Buffer.from(token); return a.length === b.length && crypto.timingSafeEqual(a, b); };
    const reply = (res, status, body, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { ...HEADERS, "content-type": type });
      res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body, (_k, v) => typeof v === "bigint" ? v.toString() : v));
    };
    const server = http.createServer(async (req, res) => {
      try {
        if (req.headers.host !== hostHeader) return reply(res, 421, { error: "wrong Host" });   // DNS rebinding
        const url = new URL(req.url, origin), site = req.headers["sec-fetch-site"];
        if (req.method === "GET" && assets[url.pathname]) {
          if (site && !["same-origin", "none"].includes(site) && !(url.pathname === "/" && req.headers["sec-fetch-mode"] === "navigate")) return reply(res, 403, { error: "cross-site" });
          return reply(res, 200, assets[url.pathname].body, assets[url.pathname].type);
        }
        if (!url.pathname.startsWith("/api/")) return reply(res, 404, { error: "not found" });
        if (site && site !== "same-origin") return reply(res, 403, { error: "cross-site request refused" });
        if (req.headers.origin !== undefined && req.headers.origin !== origin) return reply(res, 403, { error: "foreign Origin refused" });
        if (!tokenOk(req.headers["x-handoff-token"])) return reply(res, 403, { error: "missing or wrong handoff token" });
        if (req.method === "GET" && url.pathname === "/api/state") return reply(res, 200, await state({ fresh: url.searchParams.get("fresh") === "1" }));
        const route = ROUTES[url.pathname];
        if (!route) return reply(res, 404, { error: "not found" });
        if (req.method !== "POST") return reply(res, 405, { error: "POST only" });
        if (req.headers.origin !== origin) return reply(res, 403, { error: "a write must come from this page (Origin)" });
        if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] || "")) return reply(res, 415, { error: "JSON only" });
        let raw = "";
        for await (const c of req) { raw += c; if (raw.length > 4096) return reply(res, 413, { error: "too large" }); }
        let body;
        try { body = JSON.parse(raw); } catch { return reply(res, 400, { error: "not JSON" }); }
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !route[0].includes(k))) return reply(res, 400, { error: `expected only ${route[0].join(", ")}` });
        return reply(res, 200, await route[1](body));
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) log(`error: ${short(e)}`);
        return reply(res, status, { error: short(e), ...(e.intent ? { intent: e.intent } : {}), ...(e.claimed ? { claimed: true } : {}) });
      }
    });
    return new Promise((ok, fail) => {
      server.once("error", fail);
      server.listen(port, host, () => {
        const a = server.address();
        hostHeader = host === "::1" ? `[::1]:${a.port}` : `${host}:${a.port}`;
        origin = `http://${hostHeader}`;
        ok({ origin, url: `${origin}/#token=${token}`, server,
          close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) });
      });
    });
  }
  /** Wait for attach confirmations running in this process (tests, shutdown). */
  const settled = () => Promise.all([...inflight.values()].map((f) => f.done));
  return { journal, state, prepare, claim, attach, rejected, resolve, discard, listen, settled };
}
