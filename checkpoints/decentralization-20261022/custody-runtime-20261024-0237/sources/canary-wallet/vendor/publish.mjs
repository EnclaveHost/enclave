// The custody-canary-proof catalog publication: ONE transaction, EnclaveAppCatalog(0x18419…).publishVersion(...) from the
// catalog owner/admin 0x0b2d…, read-only PREPARE only. This module never reads a key, never signs, never uploads and
// never sends: it has no broadcast method, no wallet and no upload code at all (a test greps for them).
//
//   offline (`request()`): the exact arguments, calldata, appId and selector, from pins alone (no network).
//   prepare: two RPCs, one agreed block. Pins the book (code hash; appCatalog and deployments keys), the ledger code
//     hash, the catalog code hash, its owner (= the publisher, pendingOwner 0), schema 9 and fee cap; proves the slug is
//     NEW for this publisher (numVersions 0, no transfer redirect) and the CID unlisted; simulates the exact call from
//     the publisher (decoded appId/index must be the expected new listing); estimates gas; prices L2 + the GasPriceOracle
//     L1 data-fee upper bound for the maximum signed size of the exact tx (real nonce) + the oracle's operator fee for
//     the gas limit (Isthmus, else refuse); checks the caps; reports the publisher's balance. Writes a public plan.
// Every chain fact needs both RPCs to agree; an RPC error is an error, never "absent".
import { createHash } from "node:crypto";
import { encodeFunctionData, decodeFunctionResult, encodePacked, keccak256, serializeTransaction, stringToHex, toFunctionSelector } from "viem";

const lc = (a) => String(a).toLowerCase();
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const hexN = (n) => "0x" + BigInt(n).toString(16);
const ZERO = "0x0000000000000000000000000000000000000000";
const key32 = (s) => stringToHex(s, { size: 32 });           // EnclaveAddressBook keys: ASCII, right-padded

export const COMPONENT = Object.freeze({
  file: "out/custody_canary_proof.wasm",
  sha256: "7ce32918490b91b87c7ffa4cf69769c676b5b835ca11d55904b1511ef93ee883",
  size: 101222,
  cid: "bafkreid44murqsilsg4hy772jt3jo2ogo223qnokchkvsbfrkeppspxiqm",   // CIDv1 raw sha2-256: one block (< 256 KiB)
});

export const PRODUCTION = Object.freeze({
  chainId: 8453,
  book: "0xab214342d5a490150a4a977063a2f88e21f80907",
  bookCodeHash: "0xe4f570e99f2ac708b35539fe5906889d8cb99189e6c9075f5e46d3b6921ac152",
  catalog: "0x18419ca2b502d423a8de6269aeee171a378626e3",
  catalogCodeHash: "0x3f3c4cc028abd3e117465362e196243cafaaffa7508dc6297d78a6b709dcc79f",   // f2e9a71d0, rebuilt offline
  catalogSchema: 9n,
  ledger: "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b",                                     // EnclaveDeployments rev 16d
  ledgerCodeHash: "0x71d50076336283e774ba2ef8d5cbf7602e9cdc5dd918a7e7390c743367766682",
  publisher: "0x0b2d009c0c9af05b12100d77f3c815fea822ee61",                                  // catalog owner = Enclave admin
  oracle: "0x420000000000000000000000000000000000000f",
  rpcs: Object.freeze(["https://mainnet.base.org", "https://base.public.blockpi.network/v1/rpc/public"]),
  // the request: a NEW dedicated slug and version; nothing existing is replaced
  request: Object.freeze({
    slug: "custody-canary-proof",
    name: "Custody canary proof",
    description: "Custody canary use ONLY: answers HMAC-SHA256 proofs for dedicated CANARY_ test markers (32 fresh CSPRNG bytes each). Never stage real or user secrets.",
    version: "0.1.0",
    cid: COMPONENT.cid,
    res: Object.freeze([0, 0, 128, 10]),        // [vramMb, gpuGflops, memMb, cpuGflops]: hello-world v4's policy {100,128,1}
    ports: "",
    config: '{"wasi":"0.2"}',                   // exactly what `enclave publish` stamps for this binary (no other key)
    feePerSec6: 0n,                             // free; nothing is paid to the publisher
  }),
  caps: Object.freeze({ gas: 1_500_000n, maxFeePerGas: 100_000_000n /* 0.1 gwei */, totalWei: 50_000_000_000_000n /* 0.00005 ETH */ }),
  readDepth: 2,
});

export const CATALOG_ABI = [
  { type: "function", name: "publishVersion", stateMutability: "nonpayable",
    inputs: [{ type: "string", name: "slug" }, { type: "string", name: "name" }, { type: "string", name: "description" }, { type: "string", name: "version" },
             { type: "string", name: "cid" }, { type: "uint32[4]", name: "res" }, { type: "string", name: "ports" }, { type: "string", name: "config" },
             { type: "uint256", name: "feePerSec6" }],
    outputs: [{ type: "bytes32", name: "appId" }, { type: "uint256", name: "index" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pendingOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "catalogSchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxFeePerSec6", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "appIdOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "string" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "numVersions", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "cidStatus", stateMutability: "view", inputs: [{ type: "string" }],
    outputs: [{ type: "bool", name: "listed" }, { type: "bytes32", name: "appId" }, { type: "uint256", name: "index" }, { type: "uint8", name: "approval" },
              { type: "bool", name: "yanked" }, { type: "bool", name: "appActive" }, { type: "uint32[4]", name: "res" }] },
];
const BOOK_ABI = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];
const ORACLE_ABI = [
  { type: "function", name: "getL1FeeUpperBound", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isIsthmus", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "getOperatorFee", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
];
export const ORACLE_SIGNATURE_ALLOWANCE = 68;
export const SELECTOR = toFunctionSelector("publishVersion(string,string,string,string,string,uint32[4],string,string,uint256)");

export class Refusal extends Error { constructor(code, message) { super(message); this.code = code; } }
const refuse = (code, message) => { throw new Refusal(code, message); };

// the contract's own limits (EnclaveAppCatalog f2e9a71d0) and the CLI's slug rule, checked before anything is sent
export function checkRequest(r) {
  const len = (s) => Buffer.byteLength(s, "utf8");
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(r.slug)) refuse("request", "slug: the CLI rule ^[a-z0-9][a-z0-9-]{0,39}$");
  if (len(r.name) < 1 || len(r.name) > 80) refuse("request", "name: 1..80 bytes");
  if (len(r.description) > 500) refuse("request", "description: at most 500 bytes");
  if (len(r.version) < 1 || len(r.version) > 32) refuse("request", "version: 1..32 bytes");
  if (len(r.cid) < 1 || len(r.cid) > 100) refuse("request", "cid: 1..100 bytes");
  if (len(r.ports) > 96) refuse("request", "ports: at most 96 bytes");
  if (len(r.config) > 4096) refuse("request", "config: at most 4096 bytes inline");
  const [vram, gpu, mem, cpu] = r.res;
  if (r.res.length !== 4 || r.res.some((x) => !Number.isInteger(x) || x < 0)) refuse("request", "res: four non-negative integers");
  if (vram > 1048576 || mem < 1 || mem > 1048576 || gpu > 10_000_000 || cpu > 10_000_000) refuse("request", "res: outside the catalog's bounds");
  if (r.feePerSec6 !== 0n) refuse("request", "the canary listing is free (feePerSec6 0)");
  return r;
}

/** The exact call, offline: arguments, calldata, the expected appId (no transfer redirect for a new slug). */
export function request(cfg = PRODUCTION) {
  const r = checkRequest(cfg.request);
  const args = [r.slug, r.name, r.description, r.version, r.cid, [...r.res], r.ports, r.config, r.feePerSec6];
  const data = encodeFunctionData({ abi: CATALOG_ABI, functionName: "publishVersion", args });
  if (data.slice(0, 10) !== SELECTOR) refuse("request", "selector mismatch");
  const appId = keccak256(encodePacked(["address", "string"], [cfg.publisher, r.slug]));
  return { args, data, appId, selector: SELECTOR, dataSha256: sha256(Buffer.from(data.slice(2), "hex")) };
}

export function txSizes(tx) {
  const unsigned = (serializeTransaction(tx).length - 2) / 2;
  const signedMax = (serializeTransaction(tx, { r: "0x" + "ff".repeat(32), s: "0x" + "ff".repeat(32), yParity: 1 }).length - 2) / 2;
  return { unsigned, signedMax, argument: Math.max(unsigned, signedMax - ORACLE_SIGNATURE_ALLOWANCE) };
}
export function assertCoversSigned({ argument, signedMax }) {
  if (!(Number.isSafeInteger(argument) && argument + ORACLE_SIGNATURE_ALLOWANCE >= signedMax))
    refuse("l1_size", `the L1 fee size ${argument} (+${ORACLE_SIGNATURE_ALLOWANCE}) undercounts the signed transaction (${signedMax} bytes)`);
}

/** JSON-RPC over fetch, ONE attempt with a deadline; an error answer throws. Counts requests. An HTTP error carries its
 *  status, and a 429 its Retry-After header, for the pacing layer; nothing here retries. */
export const httpRpc = (timeoutMs = 15_000, counter = { n: 0 }) => async (url, method, params) => {
  counter.n++;
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!r.ok) throw Object.assign(new Error(`${new URL(url).host} ${method}: HTTP ${r.status}`), { status: r.status, retryAfter: r.headers.get("retry-after") });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(`${new URL(url).host} ${method}: ${String(j.error.message || j.error.code).slice(0, 200)}`), { rpcError: j.error });
  return j.result;
};

// READ pacing (root 2026-10-23: a live prepare died on mainnet.base.org eth_maxPriorityFeePerGas HTTP 429). Every request
// of one prepare goes through one paced transport:
//   - per provider, at most one request starts per minIntervalMs (the two providers are paced independently);
//   - HTTP 429 ONLY is retried, at most max429Retries times per request: after Retry-After when the provider sends one
//     (seconds or an HTTP date) and it is <= retryAfterCapMs, else after the short backoff for that attempt; a
//     Retry-After beyond the cap is not waited out (the read fails). Nothing else is retried: other HTTP statuses,
//     JSON-RPC errors (no transient class is documented for them here), timeouts and network errors fail at once;
//   - finite overall budgets: maxRequests (attempts, retries included) and timeBudgetMs from the start of prepare; a
//     wait that would cross the deadline is not started;
//   - freshness: the agreed block may be at most freshnessMs old (measured from when it was selected) when the plan is
//     written, and the time budget may never exceed the freshness window (refused at construction, never relaxed).
// Exhausted budgets and exhausted 429 retries are Refusals ("rpc_budget", "rpc_rate_limited"; a late plan "stale").
export const PACING = Object.freeze({ minIntervalMs: 250, max429Retries: 3, retryAfterCapMs: 5_000, backoffMs: Object.freeze([500, 1_000, 2_000]),
  maxRequests: 80, timeBudgetMs: 60_000, freshnessMs: 60_000 });
export const realClock = Object.freeze({ now: () => Date.now(), sleepUntil: (at) => new Promise((r) => setTimeout(r, Math.max(0, at - Date.now()))) });

export function checkPacing(p) {
  const int = (x, lo, hi) => Number.isSafeInteger(x) && x >= lo && x <= hi;
  if (!int(p.minIntervalMs, 0, 5_000) || !int(p.max429Retries, 0, 5) || !int(p.retryAfterCapMs, 0, 10_000) || !int(p.maxRequests, 1, 100)
      || !int(p.timeBudgetMs, 1, 120_000) || !int(p.freshnessMs, 1, 120_000) || !Array.isArray(p.backoffMs) || p.backoffMs.length < p.max429Retries
      || p.backoffMs.some((b) => !int(b, 0, 10_000)))
    throw new Error("pacing: out of bounds");
  if (p.timeBudgetMs > p.freshnessMs) throw new Error("pacing: the time budget may not exceed the block freshness window");
  return p;
}

/** Retry-After in ms (delta seconds or an HTTP date), or null when absent/unparseable. */
export function retryAfterMs(v, nowMs) {
  if (v == null || v === "") return null;
  if (/^\d+$/.test(String(v).trim())) return Number(String(v).trim()) * 1000;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

/** The paced, budgeted transport over a single-attempt rpc(url, method, params). */
export function pacedTransport({ rpc, pacing = PACING, clock = realClock, start = clock.now() }) {
  checkPacing(pacing);
  const next = new Map(), stats = { requests: 0, retries429: 0, waitedMs: 0 };
  const deadline = start + pacing.timeBudgetMs;
  async function waitUntil(at, why) {
    if (at > deadline) refuse("rpc_budget", `${why}: waiting until +${at - start} ms would cross the ${pacing.timeBudgetMs} ms budget`);
    const t = clock.now();
    if (at > t) { stats.waitedMs += at - t; await clock.sleepUntil(at); }
  }
  async function send(url, method, params) {
    for (let attempt = 0; ; attempt++) {
      // per-provider pacing: reserve this provider's next slot before waiting, so concurrent callers queue up
      const slot = Math.max(clock.now(), next.get(url) ?? -Infinity);
      next.set(url, slot + pacing.minIntervalMs);
      await waitUntil(slot, `${new URL(url).host} ${method}`);
      if (stats.requests >= pacing.maxRequests) refuse("rpc_budget", `the ${pacing.maxRequests}-request budget is exhausted (at ${method})`);
      stats.requests++;
      try { return await rpc(url, method, params); } catch (e) {
        if (e instanceof Refusal || e?.status !== 429) throw e;                   // only HTTP 429 is transient here
        if (attempt >= pacing.max429Retries) refuse("rpc_rate_limited", `${e.message} after ${attempt} retries`);
        const ra = retryAfterMs(e.retryAfter, clock.now());
        if (ra !== null && ra > pacing.retryAfterCapMs) refuse("rpc_rate_limited", `${e.message}: Retry-After ${ra} ms is beyond the ${pacing.retryAfterCapMs} ms cap`);
        stats.retries429++;
        await waitUntil(clock.now() + (ra ?? pacing.backoffMs[attempt]), `${new URL(url).host} ${method} 429 retry`);
      }
    }
  }
  return { send, stats, start, deadline };
}

// ledgerCodeHashOf: a TEST seam only, for the ledger alone (its deployed runtime embeds immutables and a library address
// that are not rebuilt here; the book and catalog are rebuilt byte-exact and always hashed with keccak256). The CLI never
// passes it.
export function createPreparer({ cfg = PRODUCTION, rpc = httpRpc(), clock = realClock, pacing = PACING, ledgerCodeHashOf = keccak256 } = {}) {
  // nothing that names the transaction may differ from production; tests change only the RPC URLs
  for (const k of ["chainId", "book", "bookCodeHash", "catalog", "catalogCodeHash", "catalogSchema", "ledger", "ledgerCodeHash", "publisher", "oracle", "readDepth"])
    if (cfg[k] !== PRODUCTION[k]) throw new Error(`config ${k} must be the production value`);
  if (cfg.request !== PRODUCTION.request || cfg.caps !== PRODUCTION.caps) throw new Error("the request and caps must be the production values");
  const rpcs = [...cfg.rpcs];
  if (rpcs.length !== 2 || rpcs[0] === rpcs[1]) throw new Error("exactly two distinct RPCs");
  checkPacing(pacing);
  let transport = null;                                                  // one paced, budgeted transport per prepare
  const both = (method, params) => Promise.all(rpcs.map((u) => transport.send(u, method, params)));
  const agree = async (what, method, params) => {
    const r = await both(method, params);
    if (JSON.stringify(r[0]) !== JSON.stringify(r[1])) refuse("rpc_disagree", `the RPCs disagree on ${what}`);
    return r[0];
  };
  const req = request(cfg);

  async function agreedBlock() {
    const ids = await both("eth_chainId", []);
    if (ids.some((x) => Number(x) !== cfg.chainId)) refuse("chain", "an RPC is not on Base");
    const heads = (await both("eth_blockNumber", [])).map((x) => BigInt(x));
    const n = (heads[0] < heads[1] ? heads[0] : heads[1]) - BigInt(cfg.readDepth);
    const blocks = await both("eth_getBlockByNumber", [hexN(n), false]);
    if (!blocks[0] || !blocks[1] || lc(blocks[0].hash) !== lc(blocks[1].hash)) refuse("rpc_disagree", `the RPCs disagree on block ${n}`);
    const latest = await both("eth_getBlockByNumber", ["latest", false]);
    const base = latest.map((b) => BigInt(b.baseFeePerGas)).reduce((a, x) => (x > a ? x : a), BigInt(blocks[0].baseFeePerGas));
    return { number: n, hash: lc(blocks[0].hash), baseFee: base, timestamp: Number(blocks[0].timestamp) };
  }

  async function prepare() {
    transport = pacedTransport({ rpc, pacing, clock });
    const blk = await agreedBlock();
    const selectedAt = clock.now();
    const at = { blockHash: blk.hash, requireCanonical: true };
    const call = (to, abi, functionName, args = [], from) => agree(`${to} ${functionName}`, "eth_call",
      [{ to, data: encodeFunctionData({ abi, functionName, args }), ...(from ? { from } : {}) }, at]).then((data) => decodeFunctionResult({ abi, functionName, data }));
    const codeHash = async (a, what, hashOf = keccak256) => hashOf(await agree(`${what} code`, "eth_getCode", [a, at]));

    // the deployed addresses, from the actual book (not any CLI default)
    if (await codeHash(cfg.book, "book") !== cfg.bookCodeHash) refuse("book", "the address book's code hash differs from the reviewed one");
    const bookCatalog = lc(await call(cfg.book, BOOK_ABI, "addr", [key32("appCatalog")]));
    const bookLedger = lc(await call(cfg.book, BOOK_ABI, "addr", [key32("deployments")]));
    if (bookCatalog !== cfg.catalog) refuse("book", `the book's appCatalog is ${bookCatalog}, not the pinned catalog`);
    if (bookLedger !== cfg.ledger) refuse("book", `the book's deployments ledger is ${bookLedger}, not the pinned ledger`);
    if (await codeHash(cfg.ledger, "ledger", ledgerCodeHashOf) !== cfg.ledgerCodeHash) refuse("ledger", "the ledger's code hash differs from the reviewed rev 16d");
    if (await codeHash(cfg.catalog, "catalog") !== cfg.catalogCodeHash) refuse("catalog", "the catalog's code hash differs from the reviewed f2e9a71d0 build");

    // the catalog's authority and limits
    const owner = lc(await call(cfg.catalog, CATALOG_ABI, "owner")), pending = lc(await call(cfg.catalog, CATALOG_ABI, "pendingOwner"));
    if (owner !== cfg.publisher) refuse("authority", `the catalog owner is ${owner}: the publish would NOT be approved on publish`);
    if (pending !== ZERO) refuse("authority", `an ownership handoff to ${pending} is pending`);
    const schema = await call(cfg.catalog, CATALOG_ABI, "catalogSchema");
    if (schema !== cfg.catalogSchema) refuse("catalog", `catalog schema ${schema}, expected ${cfg.catalogSchema}`);
    const maxFee = await call(cfg.catalog, CATALOG_ABI, "maxFeePerSec6");

    // a NEW dedicated listing: no transfer redirect, no version under this slug, the CID unlisted
    const appId = lc(await call(cfg.catalog, CATALOG_ABI, "appIdOf", [cfg.publisher, cfg.request.slug]));
    if (appId !== lc(req.appId)) refuse("listing", "the slug resolves through a transfer redirect: not a new listing");
    const versions = await call(cfg.catalog, CATALOG_ABI, "numVersions", [req.appId]);
    if (versions !== 0n) refuse("listing", `the slug already has ${versions} version(s): this tool never adds to or replaces an existing listing`);
    const cs = await call(cfg.catalog, CATALOG_ABI, "cidStatus", [cfg.request.cid]);
    if (cs[0]) refuse("listing", `the component CID is already listed (app ${cs[1]} index ${cs[2]})`);

    // the publisher: settled nonce, balance, code (an EOA or a delegation is reported, not changed)
    const pubCode = lc(await agree("publisher code", "eth_getCode", [cfg.publisher, at]));
    const nonceAt = BigInt(await agree("nonce at block", "eth_getTransactionCount", [cfg.publisher, at]));
    const nl = (await both("eth_getTransactionCount", [cfg.publisher, "latest"])).map(BigInt), np = (await both("eth_getTransactionCount", [cfg.publisher, "pending"])).map(BigInt);
    if ([...nl, ...np].some((x) => x !== nonceAt)) refuse("nonce", "the publisher's nonce is not settled (latest/pending/agreed differ): a transaction may be in flight");
    const balance = BigInt(await agree("balance", "eth_getBalance", [cfg.publisher, at]));

    // the exact call, simulated from the publisher at the agreed block
    const P = { from: cfg.publisher, to: cfg.catalog, data: req.data, value: "0x0" };
    const ret = decodeFunctionResult({ abi: CATALOG_ABI, functionName: "publishVersion", data: await agree("simulation", "eth_call", [P, at]) });
    if (lc(ret[0]) !== lc(req.appId) || ret[1] !== 0n) refuse("simulation", `the simulation returned app ${ret[0]} index ${ret[1]}, not the new listing at index 0`);
    const est = (await both("eth_estimateGas", [P, hexN(blk.number)])).map(BigInt);
    const estMax = est[0] > est[1] ? est[0] : est[1];
    const gas = (estMax * 5n + 3n) / 4n;                                                   // +25 %
    if (gas > cfg.caps.gas) refuse("gas", `gas ${gas} exceeds the cap ${cfg.caps.gas}`);
    const tips = (await both("eth_maxPriorityFeePerGas", [])).map(BigInt);
    const prio = tips[0] > tips[1] ? tips[0] : tips[1];
    const maxFeePerGas = 2n * blk.baseFee + prio;
    if (maxFeePerGas > cfg.caps.maxFeePerGas) refuse("fees", `maxFeePerGas ${maxFeePerGas} exceeds the cap ${cfg.caps.maxFeePerGas}`);
    const tx = { type: "eip1559", chainId: cfg.chainId, nonce: Number(nonceAt), to: cfg.catalog, value: 0n, data: req.data, gas, maxFeePerGas, maxPriorityFeePerGas: prio };
    const sizes = txSizes(tx);
    assertCoversSigned(sizes);
    const l1 = await call(cfg.oracle, ORACLE_ABI, "getL1FeeUpperBound", [BigInt(sizes.argument)]);
    let isthmus;
    try { isthmus = await call(cfg.oracle, ORACLE_ABI, "isIsthmus"); } catch (e) {
      if (e instanceof Refusal) throw e;
      refuse("operator_fee", `the GasPriceOracle cannot report the operator fee (${String(e.message).slice(0, 120)}): undetermined, not bounded`);
    }
    if (isthmus !== true) refuse("operator_fee", "the GasPriceOracle reports no Isthmus operator-fee support: the operator fee is undetermined");
    let operatorFee;
    try { operatorFee = await call(cfg.oracle, ORACLE_ABI, "getOperatorFee", [gas]); } catch (e) {
      if (e instanceof Refusal) throw e;
      refuse("operator_fee", `getOperatorFee(${gas}) failed (${String(e.message).slice(0, 120)}): undetermined, not bounded`);
    }
    const l2 = gas * maxFeePerGas, total = l2 + l1 + operatorFee;
    if (total > cfg.caps.totalWei) refuse("cap", `the worst-case cost ${total} wei (L2 ${l2} + L1 ${l1} + operator ${operatorFee}) exceeds the cap ${cfg.caps.totalWei}`);

    // freshness: never write a plan from a block selected longer ago than the window allows
    const age = clock.now() - selectedAt;
    if (age > pacing.freshnessMs) refuse("stale", `the agreed block was selected ${age} ms ago (window ${pacing.freshnessMs} ms): prepare again`);
    const plan = {
      v: 1, tool: "custody-canary-publish-prepare", readOnly: true, preparedAt: new Date(clock.now()).toISOString(),
      component: COMPONENT,
      call: { function: "publishVersion(string,string,string,string,string,uint32[4],string,string,uint256)", selector: SELECTOR,
              args: { slug: cfg.request.slug, name: cfg.request.name, description: cfg.request.description, version: cfg.request.version, cid: cfg.request.cid,
                      res: { vramMb: cfg.request.res[0], gpuGflops: cfg.request.res[1], memMb: cfg.request.res[2], cpuGflops: cfg.request.res[3] },
                      ports: cfg.request.ports, config: cfg.request.config, feePerSec6: "0" },
              dataSha256: req.dataSha256 },
      unsignedTx: { type: "eip1559", chainId: cfg.chainId, from: cfg.publisher, to: cfg.catalog, value: "0", data: req.data, nonce: nonceAt.toString(),
                    gas: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: prio.toString() },
      expected: { appId: lc(req.appId), index: "0", approvalOnPublish: "approved (catalog owner; VersionApprovalSet(appId, 0, 1) in the same receipt)" },
      caps: { gas: cfg.caps.gas.toString(), maxFeePerGas: cfg.caps.maxFeePerGas.toString(), totalWei: cfg.caps.totalWei.toString() },
      observed: { block: blk.number.toString(), blockHash: blk.hash, rpcs: rpcs.map((u) => new URL(u).host),
                  book: { address: cfg.book, codeHash: cfg.bookCodeHash, appCatalog: bookCatalog, deployments: bookLedger },
                  ledger: { address: cfg.ledger, codeHash: cfg.ledgerCodeHash },
                  catalog: { address: cfg.catalog, codeHash: cfg.catalogCodeHash, owner, pendingOwner: pending, schema: schema.toString(), maxFeePerSec6: maxFee.toString() },
                  listing: { appIdOf: appId, numVersions: "0", cidListed: false },
                  simulation: { appId: lc(ret[0]), index: ret[1].toString() },
                  publisher: { address: cfg.publisher, code: pubCode === "0x" ? "none (EOA)" : pubCode, nonce: nonceAt.toString(), balanceWei: balance.toString() },
                  estimates: est.map(String), baseFeePerGas: blk.baseFee.toString(),
                  fees: { l2MaxWei: l2.toString(), l1DataUpperBoundWei: l1.toString(), operatorFeeUpperBoundWei: operatorFee.toString(), totalAtBlockWei: total.toString(),
                          encodedBytes: { unsigned: sizes.unsigned, signedMax: sizes.signedMax, oracleArgument: sizes.argument, oracleSignatureAllowance: ORACLE_SIGNATURE_ALLOWANCE },
                          note: "L2 cap (gas x maxFeePerGas) + GasPriceOracle L1 data-fee upper bound for the maximum signed size + the oracle's operator fee for the gas limit, all at the agreed block's parameters. Not a guarantee against later changes; the signer must re-check before signing." },
                  balanceSufficient: balance >= total, fundingNeededWei: (balance >= total ? 0n : total - balance).toString() },
      transport: { requests: transport.stats.requests, retries429: transport.stats.retries429, waitedMs: transport.stats.waitedMs,
                   elapsedMs: clock.now() - transport.start, blockAgeMs: age, pacing },
    };
    const text = JSON.stringify(plan, null, 1) + "\n";
    return { status: "prepared", planHash: "0x" + sha256(text), text, plan };
  }
  return { prepare, request: () => req, stats: () => transport?.stats ?? null };
}
