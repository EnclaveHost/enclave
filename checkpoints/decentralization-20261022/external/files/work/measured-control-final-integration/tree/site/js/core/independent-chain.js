/* ============================================================
   Chain reads that replace the API in independent mode.

   - The wallet's deployments: EnclaveDeployments.count() + getPage()
     at one agreed block (js/core/quorum.js), filtered to the wallet and
     its session vault - the CLI's chainDeployments, under RPC agreement.
     A failed or disagreeing read THROWS; it is never an empty list.
   - Host prices: per-host quotes from the pinned registry (heartbeat
     within the last hour). The owner chooses the spend ceiling and,
     optionally, one host; a suggestion is never raised automatically.
     Every registered host counts, not only ones an API chooses to follow.
   Rows use the relay's ledger-view shape (relay/api-relay.js ledgerView)
   so the existing dashboard renders them; `independent: true` marks them.
   Whether an app is actually answering is not a ledger fact: a live
   lease reads "claimed", never "running".
   ============================================================ */
import { INDEPENDENT, DEPLOYMENTS_ADDRESS, REGISTRY_ADDRESS } from "./config.js";
import { createQuorumReader, QuorumError } from "./quorum.js";
import { keccak256Utf8 } from "./keccak.js";
import { DEP_SCHEMA, DEP_SCHEMA_V1, decodeStructArray, decodeStruct, pad32 } from "./chain.js";

const sel = (sig) => keccak256Utf8(sig).slice(2, 10);
const SEL = {
  count: sel("count()"), getPage: sel("getPage(uint256,uint256)"), get: sel("get(bytes32)"),
  deploymentsSchema: sel("deploymentsSchema()"), registrySchema: sel("registrySchema()"),
  vaultFor: sel("vaultFor(address)"),
};
const PAGE = 100;
const HOST_LIVE_SECONDS = 3600;
const ZERO32 = /^0x0{64}$/;

let _reader = null;
export function reader(){
  if (INDEPENDENT.state !== "on") throw new QuorumError(INDEPENDENT.state === "off"
    ? "independent mode is off" : "the independent profile is not active in this tab");
  const p = INDEPENDENT.profile;
  return (_reader ||= createQuorumReader({ rpcs: [...p.rpcs], quorum: p.quorum, confirmations: p.confirmations,
    maxBlockAgeSeconds: p.maxBlockAgeSeconds, chainId: p.chainId }));
}
export const _setReaderForTests = (r) => { _reader = r; _implements.clear(); };

const word = (hex, i = 0) => BigInt("0x" + (hex.replace(/^0x/, "").slice(i * 64, i * 64 + 64) || "0"));
const addrOf = (hex) => "0x" + hex.replace(/^0x/, "").slice(24, 64);

export async function ledgerRev(r, snap){
  try { return Number(word(await r.call(snap, DEPLOYMENTS_ADDRESS, "0x" + SEL.deploymentsSchema))) || 1; }
  catch (e){ if (e && e.revert) return 1; throw e; }
}

/* Every deployment owned by one of `owners`, at one agreed block. */
export async function ownedDeployments(owners){
  const want = new Set(owners.filter(Boolean).map((a) => String(a).toLowerCase()));
  if (!want.size) throw new Error("connect a wallet to list its deployments");
  const r = reader(), snap = await r.snapshot();
  await assertImplements(snap, DEPLOYMENTS_ADDRESS, "the pinned ledger", ["count()", "getPage(uint256,uint256)"]);
  const rev = await ledgerRev(r, snap);
  const schema = rev >= 2 ? DEP_SCHEMA : DEP_SCHEMA_V1;
  const n = Number(word(await r.call(snap, DEPLOYMENTS_ADDRESS, "0x" + SEL.count)));
  if (!Number.isSafeInteger(n) || n < 0 || n > 1e6) throw new QuorumError("implausible deployment count");
  const rows = [];
  for (let start = 0; start < n; start += PAGE){
    const page = decodeStructArray(await r.call(snap, DEPLOYMENTS_ADDRESS, "0x" + SEL.getPage + pad32(start.toString(16)) + pad32(PAGE.toString(16))), schema);
    if (page.length !== Math.min(PAGE, n - start)) throw new QuorumError("deployment page did not match the count");
    for (const d of page) if (want.has(String(d.owner).toLowerCase())) rows.push(d);
  }
  return { snap, rev, rows };
}

export async function deploymentAt(id){
  if (!/^0x[0-9a-f]{64}$/i.test(id || "")) throw new Error("a full deployment id is required");
  const r = reader(), snap = await r.snapshot();
  const rev = await ledgerRev(r, snap);
  const d = decodeStruct(await r.call(snap, DEPLOYMENTS_ADDRESS, "0x" + SEL.get + pad32(id.replace(/^0x/, ""))), rev >= 2 ? DEP_SCHEMA : DEP_SCHEMA_V1);
  return { snap, rev, row: d && Number(d.createdAt) ? d : null };
}

// EnclaveRegistry.Enclave, by registry schema (fields are APPENDED per schema)
const REG_FIELDS = [
  { k: "endpoint", t: "str" }, { k: "repo", t: "str" }, { k: "measurement", t: "bytes32" }, { k: "operator", t: "addr" },
  { k: "registeredAt", t: "uint" }, { k: "lastSeen", t: "uint" }, { k: "active", t: "bool" },
  { k: "cpuPricePerSec6", t: "uint" }, { k: "gpuPricePerSec6", t: "uint" },       // schema 2
  { k: "proofKey", t: "addr" },                                                   // schema 3
  { k: "payoutWallet", t: "addr" },                                               // schema 4
  { k: "caps", t: "uint" }, { k: "region", t: "str" },                            // schema 5
];
const REG_LEN = { 2: 9, 3: 10, 4: 11, 5: 13 };

export async function registryHosts(snap){
  const r = reader(); snap ||= await r.snapshot();
  if (!REGISTRY_ADDRESS) throw new Error("the profile pins no registry");
  await assertImplements(snap, REGISTRY_ADDRESS, "the pinned registry", ["registrySchema()", "count()", "getPage(uint256,uint256)"]);
  let schema;
  try { schema = Number(word(await r.call(snap, REGISTRY_ADDRESS, "0x" + SEL.registrySchema))); }
  catch (e){ if (e && e.revert) throw new Error("the pinned registry predates posted prices"); throw e; }
  const fields = REG_FIELDS.slice(0, REG_LEN[Math.min(5, schema)] || 0);
  if (!fields.length) throw new Error("unsupported registry schema " + schema);
  const n = Number(word(await r.call(snap, REGISTRY_ADDRESS, "0x" + SEL.count)));
  if (!Number.isSafeInteger(n) || n < 0 || n > 1e6) throw new QuorumError("implausible registry size");
  const out = [];
  for (let start = 0; start < n; start += PAGE){
    const page = decodeStructArray(await r.call(snap, REGISTRY_ADDRESS, "0x" + SEL.getPage + pad32(start.toString(16)) + pad32(PAGE.toString(16))), fields);
    if (page.length !== Math.min(PAGE, n - start)) throw new QuorumError("registry page did not match the count");
    out.push(...page);
  }
  return { snap, schema, hosts: out };
}

/* The lease host management is judged against (js/core/independent-management.js): the deployment's row and its runner's
   registry entry, read at ONE block the profile's RPCs agree on - never one RPC and never a directory's word. The shape is
   the management helper's (network/management-browser.mjs): times in ms; validUntil bounds how long this read may be
   acted on (the agreed block's age limit, and at most two minutes). `current` is false when the runner's registry entry is
   inactive or names another operator, which the host's gateway refuses too. */
export async function agreedLease(id){
  if (!/^0x[0-9a-f]{64}$/.test(id || "")) throw new Error("a full lower-case deployment id is required");
  const r = reader(), snap = await r.snapshot();
  const rev = await ledgerRev(r, snap);
  const d = decodeStruct(await r.call(snap, DEPLOYMENTS_ADDRESS, "0x" + SEL.get + pad32(id.slice(2))), rev >= 2 ? DEP_SCHEMA : DEP_SCHEMA_V1);
  if (!d || !Number(d.createdAt)) throw new Error("this deployment is not on the pinned ledger");
  const runner = String(d.runner || "").toLowerCase(), operator = String(d.runnerOperator || "").toLowerCase();
  let host = null;
  if (/^0x[0-9a-f]{64}$/.test(runner) && !ZERO32.test(runner)){
    if (!REGISTRY_ADDRESS) throw new Error("the profile pins no registry");
    await assertImplements(snap, REGISTRY_ADDRESS, "the pinned registry", ["registrySchema()", "get(bytes32)"]);
    const schema = Number(word(await r.call(snap, REGISTRY_ADDRESS, "0x" + SEL.registrySchema)));
    const fields = REG_FIELDS.slice(0, REG_LEN[Math.min(5, schema)] || 0);
    if (!fields.length) throw new Error("unsupported registry schema " + schema);
    host = decodeStruct(await r.call(snap, REGISTRY_ADDRESS, "0x" + SEL.get + pad32(runner.slice(2))), fields);
  }
  const leaseUntil = Number(d.leaseUntil) * 1000;
  const p = INDEPENDENT.profile;
  const validUntil = Math.min(leaseUntil, (snap.timestamp + Number(p.maxBlockAgeSeconds || 600)) * 1000, Date.now() + 120000);
  const current = !!(host && host.active && String(host.operator).toLowerCase() === operator);
  return { snap, rev, row: d, host, current,
    lease: { id, owner: String(d.owner).toLowerCase(), runner, runnerOperator: operator, chainId: p.chainId,
      deployments: String(DEPLOYMENTS_ADDRESS).toLowerCase(), active: d.active === true, isPublic: d.isPublic === true,
      leaseUntil, validUntil, blockNumber: String(snap.number) } };
}

const runsCode = (h) => !h.caps || (Number(h.caps) & 1) === 1;   // pre-schema-5 rows read as hosts
export function liveHosts(hosts, chainNow){
  return hosts.filter((h) => h.active && runsCode(h) && Number(h.cpuPricePerSec6) > 0 && chainNow - Number(h.lastSeen) <= HOST_LIVE_SECONDS);
}

/* A host's total rate for one request, exactly as create()/claim price it: ceil((gpu*gpuMilli + cpu*cpuMilli)/1000). */
export const hostRate6 = (h, gpuMilli, cpuMilli) =>
  (BigInt(h.gpuPricePerSec6 || 0) * BigInt(gpuMilli) + BigInt(h.cpuPricePerSec6 || 0) * BigInt(cpuMilli) + 999n) / 1000n;

/* Per-HOST quotes for one request: every live registered host (heartbeat within the hour) that can serve it (a GPU
   request needs a posted card price), with that host's own total rate. Never a mix of one host's CPU price and
   another's GPU price - that is a price nobody offers. A host whose declared payout wallet is the owner charges that
   owner nothing (ledger rev 12). `defaultCap6` is the cheapest CHARGING eligible host's total: only a suggestion the
   owner sees and may change, never raised automatically. Posted prices are not capacity: a listed host may be full or
   decline the work. */
export function quoteHosts(hosts, { chainNow, gpuMilli, cpuMilli, owner = "", rev = 16 }){
  const me = String(owner || "").toLowerCase();
  const live = new Set(liveHosts(hosts, chainNow));
  const rows = hosts.filter((h) => h.active).map((h) => {
    const free = rev >= 12 && /^0x[0-9a-f]{40}$/.test(me) && String(h.payoutWallet || "").toLowerCase() === me;
    const reason = !live.has(h) ? "no heartbeat in the last hour"
      : gpuMilli > 0 && !(Number(h.gpuPricePerSec6) > 0) ? "posts no GPU price" : "";
    return { endpoint: h.endpoint, hostId: keccak256Utf8(h.endpoint), operator: h.operator, payoutWallet: h.payoutWallet || null,
      cpuPricePerSec6: Number(h.cpuPricePerSec6), gpuPricePerSec6: Number(h.gpuPricePerSec6 || 0), lastSeen: Number(h.lastSeen),
      eligible: !reason, reason, free, rate6: hostRate6(h, gpuMilli, cpuMilli) };
  });
  const eligible = rows.filter((r) => r.eligible).sort((a, b) => (a.rate6 < b.rate6 ? -1 : a.rate6 > b.rate6 ? 1 : 0));
  const charging = eligible.filter((r) => !r.free);
  return { hosts: [...eligible, ...rows.filter((r) => !r.eligible)], defaultCap6: charging.length ? charging[0].rate6 : null,
    eligibleCount: eligible.length };
}

export async function independentQuotes({ gpuMilli, cpuMilli, owner }){
  const { snap, hosts } = await registryHosts();
  const r = reader(), rev = await ledgerRev(r, snap);
  return { block: snap.number, chainNow: snap.timestamp, registeredHosts: hosts.length, ...quoteHosts(hosts, { chainNow: snap.timestamp, gpuMilli, cpuMilli, owner, rev }) };
}

/* /availability-shaped summary for panels that read one price pair. Both prices come from ONE host - the live host
   with the lowest whole-node price - never the per-field minima of different hosts. Deploy and the Host & price tab
   quote per host (independentQuotes) instead of using this pair. */
export async function independentAvailability(){
  const { snap, hosts } = await registryHosts();
  const live = liveHosts(hosts, snap.timestamp).sort((a, b) => Number(a.cpuPricePerSec6) - Number(b.cpuPricePerSec6));
  const ref = live[0];
  return { independent: true, block: snap.number, liveHosts: live.length, registeredHosts: hosts.length,
    ...(ref ? { cheapestCpuPricePerSec6: Number(ref.cpuPricePerSec6), referenceHost: ref.endpoint } : {}),
    ...(ref && Number(ref.gpuPricePerSec6) > 0 ? { cheapestGpuPricePerSec6: Number(ref.gpuPricePerSec6) } : {}) };
}

/* Registry rows in the /enclaves shape the panels read (name, endpoint,
   payoutWallet, serving). `serving` here means "heartbeat within an hour",
   the ledger-visible proxy; nothing here asked the host. */
export async function independentEnclaves(){
  const { snap, hosts } = await registryHosts();
  const live = new Set(liveHosts(hosts, snap.timestamp));
  return hosts.filter((h) => h.active).map((h) => ({ name: h.endpoint, endpoint: h.endpoint, hostId: keccak256Utf8(h.endpoint), operator: h.operator,
    payoutWallet: h.payoutWallet || null, cpuPricePerSec6: Number(h.cpuPricePerSec6), gpuPricePerSec6: Number(h.gpuPricePerSec6 || 0),
    lastSeen: Number(h.lastSeen), serving: live.has(h), independent: true }));
}

/* relay/api-relay.js ledgerView, from chain facts only. */
export function ledgerView(d, { chainNow, rev, hosts = [] }){
  const owner = String(d.owner).toLowerCase();
  const free = rev >= 12 && liveHosts(hosts, chainNow).some((h) => String(h.payoutWallet || "").toLowerCase() === owner);
  const leased = !ZERO32.test(d.runner) && Number(d.leaseUntil) > chainNow;
  const status = !d.active ? "stopped"
    : (!free && !(d.balance6 > 0 || d.spent6 > 0)) ? "awaiting_payment"
    : leased ? "claimed"
    : (free || d.balance6 >= d.rate) ? "queued" : "unfunded";
  const rate6 = Number(d.rate);
  const leaseTail = Math.max(0, Number(d.leaseUntil) - chainNow);
  const runner = leased ? hosts.find((h) => String(h.endpoint) && keccak256Utf8(h.endpoint) === String(d.runner).toLowerCase()) : null;
  return {
    id: d.id, owner, status, public: d.isPublic,
    ...(free ? { hostedFree: true } : {}),
    ...(runner ? { enclave: runner.endpoint } : {}),
    image: { reference: d.appRef },
    resources: { gpuShare: Number(d.gpuMilli) / 1000, cpuShare: Number(d.cpuMilli) / 1000 },
    createdAt: new Date(Number(d.createdAt) * 1000).toISOString(),
    ratePerSecondUsdc: (rate6 / 1e6).toFixed(7),
    spentUsdc: (Number(d.spent6) / 1e6).toFixed(2),
    paidUsdc: ((Number(d.balance6) + Number(d.spent6)) / 1e6).toFixed(2),
    timeRemainingSec: rate6 > 0 && !free ? leaseTail + Math.floor(Number(d.balance6) / rate6) : null,
    onchain: { contract: DEPLOYMENTS_ADDRESS, id: d.id, leaseUntil: Number(d.leaseUntil) ? new Date(Number(d.leaseUntil) * 1000).toISOString() : null },
    ledger: true, independent: true,
  };
}

async function hostsOrEmpty(snap){
  // Host names and free-hosting are display niceties: a registry failure must
  // not hide the owner's rows, but it is reported on the rows.
  try { return { hosts: (await registryHosts(snap)).hosts, hostsError: null }; }
  catch (e){ return { hosts: [], hostsError: String(e && e.message || e) }; }
}

/* The wallet's (and its vault's) rows: a bounded, resumable step of js/core/independent-list.js. The array carries
   `independentScan` = { complete, scanned, total, block, mode, reason, notMine } so the panel never presents a partial
   scan as the whole list. */
export async function independentList(owners, opts = {}){
  const r = reader();
  const snap0 = await r.snapshot();
  await assertImplements(snap0, DEPLOYMENTS_ADDRESS, "the pinned ledger", ["count()", "getPage(uint256,uint256)", "get(bytes32)"]);
  const { listOwned } = await import("./independent-list.js");
  const res = await listOwned(owners, { reader: r, ledgerRev, ...opts });
  const { hosts, hostsError } = await hostsOrEmpty(res.snap);
  const out = res.rows.map((d) => ({ ...ledgerView(d, { chainNow: res.snap.timestamp, rev: res.rev, hosts }), block: res.snap.number,
    ...(hostsError ? { hostsError } : {}) }));
  out.independentScan = { complete: res.complete, scanned: res.scanned, total: res.total, block: res.snap.number, mode: res.mode,
    reason: res.reason, notMine: res.notMine };
  return out;
}
export async function independentDeployment(id){
  const { snap, rev, row } = await deploymentAt(id);
  if (!row){ const e = new Error("No such deployment on the pinned ledger."); e.status = 404; throw e; }
  const { hosts } = await hostsOrEmpty(snap);
  return { ...ledgerView(row, { chainNow: snap.timestamp, rev, hosts }), block: snap.number };
}

/* The session vault a factory assigns `owner`, read at an agreed block. */
export async function agreedVaultFor(factory, owner){
  const r = reader(), snap = await r.snapshot();
  return addrOf(await r.call(snap, factory, "0x" + SEL.vaultFor + pad32(owner.replace(/^0x/, ""))));
}

/* The payment token's EIP-712 domain (name, version) at an agreed block, for
   EIP-3009 funding signatures. chainId and verifyingContract are ours to know. */
export async function tokenDomain(token){
  const r = reader(), snap = await r.snapshot();
  const { decodeString } = await import("./chain.js");
  const [name, version] = await Promise.all([r.call(snap, token, "0x" + sel("name()")), r.call(snap, token, "0x" + sel("version()"))]);
  return { name: decodeString(name), version: decodeString(version), chainId: INDEPENDENT.profile.chainId, verifyingContract: token };
}

/* SessionVault.held(id) at an agreed block: the vault's environment for a record it owns (0 unadopted, 1 staging,
   2 production), the promotion the owner last signed and the creating session. */
export async function agreedHeld(vault, id){
  const r = reader(), snap = await r.snapshot();
  const out = await r.call(snap, vault, "0x" + sel("held(bytes32)") + pad32(String(id).replace(/^0x/, "")));
  return { env: Number(word(out, 0)), promoted: "0x" + out.replace(/^0x/, "").slice(64, 128), createdBy: "0x" + out.replace(/^0x/, "").slice(128, 192), block: snap.number };
}

/* Precise refusal for a pinned contract that lacks a method this page needs: the agreed runtime must contain the
   function's 4-byte selector as a PUSH4 (how Solidity dispatches). Deployed code differs from HEAD (the live registry
   is schema 4, without registerRelay/caps), so a method is never assumed from source. */
const _implements = new Set();      // address:selector already seen in agreed code (runtime code cannot change in place)
export async function assertImplements(snap, address, what, signatures){
  const key = (sig) => String(address).toLowerCase() + ":" + (/^[0-9a-f]{8}$/.test(sig) ? sig : sel(sig));
  if (signatures.every((sig) => _implements.has(key(sig)))) return;
  const r = reader();
  const code = String(await r.code(snap, address)).toLowerCase();
  if (!code || code === "0x") throw new Error(what + " has no code at the agreed block");
  // a selector with leading zero bytes is pushed with a shorter PUSHn (0x00bd4dee -> PUSH3 bd4dee)
  const pushOf = (sig) => { let h = /^[0-9a-f]{8}$/.test(sig) ? sig : sel(sig); let n = 4; while (n > 1 && h.startsWith("00")){ h = h.slice(2); n--; } return (0x5f + n).toString(16) + h; };
  const missing = signatures.filter((sig) => !code.includes(pushOf(sig)));
  if (missing.length) throw new Error(what + " does not implement " + missing.join(", ") + " (deployed code at block " + snap.number + ")");
  for (const sig of signatures) _implements.add(key(sig));
}

// fundEth credit math in the deployed ledger (rev 16d, EnclaveLedgerBandwidth.ethCredit): value * answer / 1e20, i.e. an
// 8-decimal ETH/USD answer; answers older than FEED_MAX_AGE (2 hours) or carried over from an unfinished round revert.
const FEED_MAX_AGE = 7200, FEED_MARGIN = 600;

/* The ledger's ETH/USD price as fundEth will read it: the feed address the ledger reports, that feed's decimals and
   latest round, all at ONE agreed block. Refuses: ETH funding disabled (zero feed), a feed other than the profile's
   reviewed one, decimals other than 8, a non-positive answer, an unfinished round, or an answer that would be within
   ten minutes of the ledger's two-hour staleness limit. Returns the USD price per ETH and the round evidence. */
export async function ethFundingQuote(){
  const r = reader(), snap = await r.snapshot();
  await assertImplements(snap, DEPLOYMENTS_ADDRESS, "the pinned ledger", ["ethUsdFeed()", "fundEth(bytes32)"]);
  const feed = addrOf(await r.call(snap, DEPLOYMENTS_ADDRESS, "0x" + sel("ethUsdFeed()"))).toLowerCase();
  if (/^0x0{40}$/.test(feed)) throw new Error("ETH funding is disabled on the pinned ledger (no ETH/USD feed)");
  const pinned = INDEPENDENT.profile.ethUsdFeed;
  if (pinned && pinned !== feed) throw new Error("the ledger's ETH/USD feed " + feed + " is not the profile's reviewed feed " + pinned);
  await assertImplements(snap, feed, "the ledger's ETH/USD feed", ["latestRoundData()", "decimals()"]);
  const decimals = Number(word(await r.call(snap, feed, "0x" + sel("decimals()"))));
  if (decimals !== 8) throw new Error("the ETH/USD feed reports " + decimals + " decimals; the ledger's credit math assumes 8");
  const rd = await r.call(snap, feed, "0x" + sel("latestRoundData()"));
  const roundId = word(rd, 0), answerWord = word(rd, 1), updatedAt = Number(word(rd, 3)), answeredInRound = word(rd, 4);
  const answer = answerWord >= (1n << 255n) ? answerWord - (1n << 256n) : answerWord;
  if (answer <= 0n) throw new Error("the ETH/USD feed answer is not positive");
  if (answeredInRound < roundId) throw new Error("the ETH/USD feed's latest round is unfinished");
  const age = snap.timestamp - updatedAt;
  if (age < -60) throw new Error("the ETH/USD feed's answer is from the future");
  if (age > FEED_MAX_AGE - FEED_MARGIN) throw new Error("the ETH/USD feed's answer is " + age + "s old; the ledger refuses answers older than " + FEED_MAX_AGE + "s");
  return { feed, decimals, answer, roundId, updatedAt, ageSeconds: age, block: snap.number,
    ethUsd: Number(answer) / 1e8 };
}

/* The record's spend ceiling (EnclaveDeployments.capOf, USDC 6dp per second) at an agreed block. */
export async function agreedCap(id){
  const r = reader(), snap = await r.snapshot();
  await assertImplements(snap, DEPLOYMENTS_ADDRESS, "the pinned ledger", ["capOf(bytes32)"]);
  return { cap6: word(await r.call(snap, DEPLOYMENTS_ADDRESS, "0x" + sel("capOf(bytes32)") + pad32(String(id).replace(/^0x/, "")))), block: snap.number };
}
