// Independent MCP backend (docs/network/independent-mcp.md): the SAME tool set as the hosted endpoint (relay/mcp.js
// createTools), answered with no Enclave gateway, API, IPFS service, address-book lookup service or first-answer RPC.
//
// Authority, per configured profile (operator configuration, never a tool argument):
//   - explicit reviewed trust: a reviewed authority profile checked against its digest, or a strict contract-pin document
//     (cli/independent.mjs loadIndependentTrust: the same rules the independent CLI applies);
//   - an RPC quorum: k of n RPCs returning identical answers at ONE confirmed, fresh block (QuorumChain);
//   - the EXISTING admin-controlled EnclaveAddressBook, read on chain at that block through the pinned session factory's
//     implementation (network/session-authority.mjs readSessionAuthority): its ledger and catalog must be the pinned
//     ones, so an administrator's version migration refuses stale pins before anything is built instead of being bypassed.
//
// One tools/call = one Scope (AsyncLocalStorage): every read of that call happens at the same agreed block, against the
// bindings read at that block, and is recorded. A builder's answer is returned only after the bindings, schemas and every
// non-time-dependent read are replayed at a FRESH agreed block and found identical (one rebuild is attempted on a change,
// then the call refuses). No cache outlives a call, and nothing about one profile or one request is visible to another.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { getAddress, keccak256, stringToHex } from "viem";

import { loadIndependentTrust, QuorumChain, agreementKey, QuorumError, REGISTRY_SCHEMA4_ABI, quorumPublicClient } from "../cli/independent.mjs";
import { readSessionAuthority } from "../network/session-authority.mjs";
import { REVIEWED_SESSION_FACTORIES, readSessionFactoryIdentity, checkSessionFactoryIdentity } from "../network/session-factories.mjs";
import { hostLiveness, REGISTRY_UPDATE_WINDOW_SEC } from "../network/host-liveness.mjs";
import { frontendOrigin } from "../cli/independent-login.mjs";
import { validateStoragePlan } from "../sdk/storage/replicas.mjs";
import { parseUniqueJSON } from "../sdk/bootstrap/package.mjs";

export const CONFIG_FORMAT = "enclave-mcp-independent/v1";
const ZERO = "0x" + "0".repeat(40);
const lc = (s) => String(s || "").toLowerCase();
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
const nonZero = (a) => isAddr(a) && !/^0x0{40}$/i.test(a);
const MAX_CONFIG_BYTES = 65536;

// Reads whose value moves with block time even when nothing is sent (escrow accrual, refundable tails, balances):
// recorded, but not required to be identical on replay. Bindings, schemas, records, catalog rows and nonces are.
export const TIME_DEPENDENT = new Set(["refundableOf", "earnOf", "secondsFundable", "ownerEscrow6", "balanceOf", "getBalance", "free"]);

export class IndependentError extends Error {
  constructor(code, message) { super(message); this.name = "IndependentError"; this.code = code; }
}
class SnapshotChanged extends Error { constructor(what) { super(what); this.name = "SnapshotChanged"; this.retry = true; } }

// ---- operator configuration --------------------------------------------------------------------------------------
const PROFILE_KEYS = ["contractPins", "profile", "profileDigest", "usdc", "rpcs", "quorum", "confirmations", "maxBlockAgeSec", "addressBook",
  "managementDirectories", "capacityDirectories", "capacityCold", "maxHosts", "storagePlan", "grantFrontend", "sessionScan", "stateDir",
  "hostPolicy", "custody", "remote", "chainVerifier"];
function readBounded(file, max, what) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > max) throw new IndependentError("config", `${what} ${file} is not a file of at most ${max} bytes`);
  return fs.readFileSync(file);
}
function literalIpOrigins(list, what) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 8) throw new IndependentError("config", `${what}: 0 to 8 origins`);
  return list.map((o) => {
    const u = new URL(String(o));
    if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) throw new IndependentError("config", `${what}: ${o} must be an origin`);
    return u.origin;
  });
}
/**
 * The configuration document: { format, profiles: { NAME: {…} } }. Relative paths resolve against the document's
 * directory. -> frozen { profiles: Map(name -> resolved profile config) }. Nothing here reads the network.
 */
export function loadConfig(file) {
  const dir = path.dirname(path.resolve(file));
  let doc;
  try { doc = parseUniqueJSON(readBounded(file, MAX_CONFIG_BYTES, "config").toString("utf8")); }
  catch (e) { throw new IndependentError("config", `cannot read ${file}: ${e.message}`); }
  if (!doc || doc.format !== CONFIG_FORMAT || !doc.profiles || typeof doc.profiles !== "object" || Array.isArray(doc.profiles)
      || Object.keys(doc).some((k) => !["format", "profiles"].includes(k)))
    throw new IndependentError("config", `${file} is not an ${CONFIG_FORMAT} document`);
  const names = Object.keys(doc.profiles);
  if (!names.length || names.length > 16) throw new IndependentError("config", "1 to 16 profiles");
  const rel = (p) => (p === undefined ? undefined : path.resolve(dir, String(p)));
  const profiles = new Map();
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new IndependentError("config", `profile name ${name}: lowercase letters, digits, hyphens`);
    const p = doc.profiles[name];
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new IndependentError("config", `profile ${name} is not an object`);
    const unknown = Object.keys(p).filter((k) => !PROFILE_KEYS.includes(k));
    if (unknown.length) throw new IndependentError("config", `profile ${name}: unknown key ${unknown.join(", ")}`);
    if (!p.stateDir) throw new IndependentError("config", `profile ${name}: stateDir is required (management rollback floors, capacity floors)`);
    const scan = p.sessionScan || {};
    if (Object.keys(scan).some((k) => !["fromBlock", "chunk", "maxChunks"].includes(k))) throw new IndependentError("config", `profile ${name}.sessionScan: fromBlock, chunk, maxChunks`);
    profiles.set(name, Object.freeze({
      name, contractPins: rel(p.contractPins), profile: rel(p.profile), profileDigest: p.profileDigest, usdc: p.usdc, rpcs: p.rpcs,
      quorum: p.quorum, confirmations: p.confirmations, maxBlockAgeSec: p.maxBlockAgeSec, chainVerifier: p.chainVerifier,
      addressBook: p.addressBook === undefined ? null : getAddress(p.addressBook),
      managementDirectories: literalIpOrigins(p.managementDirectories, `${name}.managementDirectories`),
      capacityDirectories: literalIpOrigins(p.capacityDirectories, `${name}.capacityDirectories`),
      capacityCold: p.capacityCold === true, maxHosts: p.maxHosts ?? 64,
      storagePlan: p.storagePlan === undefined ? null : validateStoragePlan(parseUniqueJSON(readBounded(rel(p.storagePlan), 16384, "storage plan").toString("utf8"))),
      grantFrontend: p.grantFrontend === undefined ? null : frontendOrigin(p.grantFrontend),
      sessionScan: Object.freeze({ fromBlock: scan.fromBlock ?? null, chunk: scan.chunk ?? 2000, maxChunks: scan.maxChunks ?? 50 }),
      stateDir: path.resolve(dir, String(p.stateDir)), hostPolicy: p.hostPolicy ?? null, custody: p.custody ?? null,
      remote: Object.freeze({ allowPlaintextSecrets: false, ...(p.remote || {}) }),
    }));
    if (profiles.get(name).remote.allowPlaintextSecrets !== false) throw new IndependentError("config", `profile ${name}.remote.allowPlaintextSecrets: a remote adapter never accepts plaintext secrets`);
  }
  return Object.freeze({ file: path.resolve(file), profiles });
}

// ---- one profile's authority ---------------------------------------------------------------------------------------
const BOOK_ABI = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];
const CODE_NAMES = ["deployments", "appCatalog", "registry", "sessionVaultFactory"];

export class Authority {
  /** cfg: one resolved profile from loadConfig; deps (tests only): { clients } replacing the RPC transports. */
  constructor(cfg, deps = {}) {
    this.cfg = cfg;
    this.trustPromise = (async () => {
      const { validateContractPins } = await import("../network/contract-pins.mjs");
      const pinned = cfg.contractPins ? validateContractPins(parseUniqueJSON(readBounded(cfg.contractPins, 16384, "contract pins").toString("utf8"))) : null;
      return loadIndependentTrust({ profileFile: cfg.profile, profileDigest: cfg.profileDigest, contractPins: pinned, usdc: cfg.usdc,
        defaultUsdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", rpcs: cfg.rpcs, quorum: cfg.quorum, confirmations: cfg.confirmations,
        maxBlockAgeSec: cfg.maxBlockAgeSec, chainVerifier: cfg.chainVerifier });
    })();
    this.trustPromise.catch(() => {});   // surfaced by ready()
    this.deps = deps;
    this.chain = null;
    fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  }
  async ready() {
    if (this.chain) return this;
    const trust = await this.trustPromise;
    if (!nonZero(trust.pins.sessionVaultFactory))
      throw new IndependentError("config", `profile ${this.cfg.name}: the pins must select a SessionVault factory; its implementation names the admin AddressBook this profile resolves`);
    this.trust = trust;
    this.chain = this.chain || new QuorumChain({ rpcs: trust.rpcs, clients: this.deps.clients, quorum: trust.quorum, confirmations: trust.confirmations,
      maxBlockAgeMs: trust.maxBlockAgeMs });
    return this;
  }
  get name() { return this.cfg.name; }
}

// ---- one call's agreed snapshot ------------------------------------------------------------------------------------
const isRevert = (e) => { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (x.name === "ContractFunctionRevertedError" || x.name === "ExecutionRevertedError") return true; return false; };
const revertReason = (e) => { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (x.reason) return String(x.reason).slice(0, 200); return String(e?.shortMessage || e?.message || "").replace(/^.*?reverted(?: with the following reason:)?:?\s*/i, "").slice(0, 200); };

export class Scope {
  constructor(authority, { minBlock = 0n } = {}) {
    this.a = authority; this.chain = authority.chain; this.minBlock = minBlock;
    this.reads = []; this.memo = new Map(); this.block = null; this._bindings = null;
  }
  /** The agreed block of this call: chosen once (QuorumChain.pickBlock rules), never below minBlock. */
  async at() {
    if (this.block) return this.block;
    const failures = [];
    let { block, candidates } = await this.chain.pickBlock(failures);
    if (block < this.minBlock) block = this.minBlock;
    const heads = await Promise.allSettled(candidates.map(async (i) => {
      const b = await this.chain.peers[i].client.getBlock({ blockNumber: block });
      return { i, hash: b.hash, timestamp: Number(b.timestamp) * 1000 };
    }));
    const groups = new Map();
    heads.forEach((h, j) => {
      if (h.status !== "fulfilled") return failures.push(`${this.chain.host(candidates[j])}: ${String(h.reason?.shortMessage || h.reason?.message || h.reason).slice(0, 120)}`);
      const g = groups.get(h.value.hash) || []; g.push(h.value); groups.set(h.value.hash, g);
    });
    const best = [...groups.values()].sort((x, y) => y.length - x.length)[0];
    if (!best || best.length < this.chain.quorum) throw new QuorumError(`no ${this.chain.quorum} RPCs agreed on block ${block}`, { failures });
    const t = best[0].timestamp;
    if (t > this.chain.now() + 15000 || t + this.chain.maxBlockAgeMs < this.chain.now()) throw new QuorumError(`agreed block ${block} is stale or in the future`, { failures });
    this.block = { number: block, hash: best[0].hash, timestamp: t, peers: best.map((x) => x.i), agreeing: best.length, of: this.chain.peers.length };
    if (block > this.chain.lastBlock) this.chain.lastBlock = block;
    return this.block;
  }
  /** fn(client, blockNumber) on every peer that holds this call's block; `quorum` identical answers or it throws. */
  async agree(fn, label = "read") {
    const b = await this.at();
    const failures = [];
    const rs = await Promise.allSettled(b.peers.map(async (i) => {
      const c = this.chain.peers[i].client;
      const value = await fn(c, b.number);
      if ((await c.getBlock({ blockNumber: b.number })).hash !== b.hash) throw new Error("block replaced during the read");
      return { value, key: agreementKey(value) };
    }));
    const groups = new Map();
    rs.forEach((r, j) => {
      if (r.status !== "fulfilled") return failures.push(`${this.chain.host(b.peers[j])}: ${String(r.reason?.shortMessage || r.reason?.message || r.reason).split("\n")[0].slice(0, 120)}`);
      const g = groups.get(r.value.key) || []; g.push(r.value); groups.set(r.value.key, g);
    });
    const best = [...groups.values()].sort((x, y) => y.length - x.length)[0];
    if (!best || best.length < this.chain.quorum) {
      if (groups.size > 1) failures.push(`${groups.size} different answers`);
      throw new QuorumError(`${label}: no ${this.chain.quorum} RPCs agreed at block ${b.number}`, { failures });
    }
    return best[0].value;
  }
  /** readContract at this call's block; recorded for replay. An agreed revert throws (a fact, not an outage). */
  async read(address, abi, functionName, args = []) {
    const key = `${lc(address)}|${functionName}|${agreementKey(args)}`;
    if (this.memo.has(key)) return this.memo.get(key).then(unwrapRead);
    const p = this.agree(async (c, blockNumber) => {
      try { return { ok: await c.readContract({ address, abi, functionName, args, blockNumber }) }; }
      catch (e) { if (isRevert(e)) return { revert: revertReason(e) }; throw e; }
    }, `${functionName}`);
    this.memo.set(key, p);
    const v = await p;
    this.reads.push({ address, abi, functionName, args, key: agreementKey(v), timeDependent: TIME_DEPENDENT.has(functionName) });
    return unwrapRead(v);
  }
  async code(address) {
    const v = await this.agree(async (c, blockNumber) => { const x = await c.getCode({ address, blockNumber }); return x && x !== "0x" ? keccak256(x) : null; }, "getCode");
    this.reads.push({ code: address, key: agreementKey(v) });
    return v;
  }
  async balance(address) {
    const v = await this.agree((c, blockNumber) => c.getBalance({ address, blockNumber }), "getBalance");
    this.reads.push({ balance: address, key: agreementKey(v), timeDependent: true });
    return v;
  }
  /** eth_getLogs agreed over one bounded range at or below this call's block. */
  async logs({ address, topics, fromBlock, toBlock }) {
    const b = await this.at();
    const to = toBlock === undefined || toBlock > b.number ? b.number : toBlock;
    return this.agree(async (c) => (await c.request({ method: "eth_getLogs", params: [{ ...(address ? { address } : {}), topics,
      fromBlock: "0x" + BigInt(fromBlock).toString(16), toBlock: "0x" + to.toString(16) }] }))
      .map((l) => ({ address: lc(l.address), topics: l.topics.map(lc), data: lc(l.data), blockNumber: BigInt(l.blockNumber), logIndex: Number(l.logIndex) })), "getLogs");
  }
  /**
   * The bindings this call acts on, read at its block: the pinned factory's implementation, its book (the admin's
   * AddressBook for the production factory), the book's ledger and catalog (which must equal the pins) and its reviews
   * entry; with a reviewed profile, the reviewed code of every contract a decision relies on. Recorded like any read.
   */
  async bindings() {
    if (this._bindings) return this._bindings;
    this._bindings = (async () => {
      const { pins, usdc, profile } = this.a.trust;
      const expected = { factory: getAddress(pins.sessionVaultFactory), deployments: getAddress(pins.deployments), appCatalog: getAddress(pins.appCatalog), usdc };
      const auth = await this.agree((c, blockNumber) => readSessionAuthority(c, blockNumber, expected).catch((e) => ({ refused: String(e.message) })), "session authority");
      if (auth.refused) throw new IndependentError("bindings", `${auth.refused} (pinned factory ${expected.factory}, profile ${this.a.name})`);
      this.reads.push({ bindings: true, key: agreementKey(auth) });
      if (this.a.cfg.addressBook && lc(this.a.cfg.addressBook) !== lc(auth.book))
        throw new IndependentError("bindings", `the pinned factory resolves the address book ${auth.book}, not the configured ${this.a.cfg.addressBook}`);
      // the factory kind: the production (book) factory or the optional fixed-binding one, judged by the reviewed table
      // when its address is a reviewed one; an unreviewed factory (a private deployment, a test chain) is reported as such
      let factoryReview = "unreviewed address: identity not in network/session-factories.mjs";
      if (REVIEWED_SESSION_FACTORIES[lc(expected.factory)]) {
        const obs = await this.agree((c, blockNumber) => readSessionFactoryIdentity(c, blockNumber, expected.factory), "factory identity");
        const k = checkSessionFactoryIdentity(expected.factory, obs);
        factoryReview = `${k.kind} factory${k.production ? " (production)" : ""}, reviewed identity`;
      }
      if (profile) for (const n of CODE_NAMES) {
        const w = profile.contracts[n];
        if (!w) continue;
        const h = await this.code(w.address);
        if (h !== w.codeHash) throw new IndependentError("bindings", `${n} at ${w.address} does not carry the reviewed code (${h || "no code"}); refusing`);
      }
      let reviews = ZERO;
      try { const r = await this.read(auth.book, BOOK_ABI, "addr", [stringToHex("reviews", { size: 32 })]); if (nonZero(r)) reviews = getAddress(r); } catch (e) { if (!e.agreedRevert) throw e; }
      return Object.freeze({ deployments: auth.deployments, appCatalog: auth.appCatalog, reviews, registry: getAddress(pins.registry), book: auth.book,
        factory: auth.factory, implementation: auth.implementation, usdc: auth.usdc, factoryReview, codeReviewed: !!profile });
    })();
    return this._bindings;
  }
  summary() {
    return this.block ? { profile: this.a.name, blockNumber: this.block.number.toString(), blockHash: this.block.hash, agreeing: this.block.agreeing,
      peers: this.block.of, quorum: this.chain.quorum, reads: this.reads.length } : { profile: this.a.name, reads: 0 };
  }
}
const unwrapRead = (v) => { if (v.revert !== undefined) throw Object.assign(new Error(`execution reverted: ${v.revert}`), { agreedRevert: true }); return v.ok; };

/** Replay `s`'s recorded reads at a fresh agreed block; throws SnapshotChanged on any binding/record difference. */
export async function revalidate(s) {
  if (!s.block) return null;
  const fresh = new Scope(s.a, { minBlock: s.block.number });
  const fb = await fresh.at();
  if (fb.number === s.block.number && fb.hash !== s.block.hash) throw new SnapshotChanged(`block ${s.block.number} was replaced`);
  for (const r of s.reads) {
    if (r.timeDependent) continue;
    let key;
    if (r.bindings) { fresh._bindings = null; const b = await fresh.agree((c, blockNumber) => readSessionAuthority(c, blockNumber, { factory: getAddress(s.a.trust.pins.sessionVaultFactory),
      deployments: getAddress(s.a.trust.pins.deployments), appCatalog: getAddress(s.a.trust.pins.appCatalog), usdc: s.a.trust.usdc }).catch((e) => ({ refused: String(e.message) })), "session authority");
      key = agreementKey(b); }
    else if (r.code) key = agreementKey(await fresh.code(r.code));
    else if (r.balance) continue;
    else {
      const v = await fresh.agree(async (c, blockNumber) => {
        try { return { ok: await c.readContract({ address: r.address, abi: r.abi, functionName: r.functionName, args: r.args, blockNumber }) }; }
        catch (e) { if (isRevert(e)) return { revert: revertReason(e) }; throw e; }
      }, r.functionName);
      key = agreementKey(v);
    }
    if (key !== r.key) throw new SnapshotChanged(r.bindings ? "the platform bindings (address book, factory) changed" : `${r.functionName || "code"} changed between block ${s.block.number} and ${fb.number}`);
  }
  return { blockNumber: fb.number.toString(), blockHash: fb.hash, agreeing: fb.agreeing };
}

// ---- the backend ---------------------------------------------------------------------------------------------------
const store = new AsyncLocalStorage();
export const currentScope = () => {
  const s = store.getStore();
  if (!s) throw new Error("internal: an independent read outside a tools/call scope");
  return s;
};

const U256 = (name) => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];

/**
 * The backend relay/mcp.js createTools(B) runs over, for ONE profile. Everything it reads goes through the current
 * call's Scope. extras: { overrides, extend, prepareSessionCalls, finalizeFor } from mcp/independent-tools.mjs.
 */
export function independentBackend(authority, extras = {}) {
  const scope = () => currentScope();
  const memo = (key, fn) => { const s = scope(); if (!s.memo.has(key)) s.memo.set(key, fn()); return s.memo.get(key); };
  const B = {
    kind: "independent", authority,
    read: (address, abi, fn, args = []) => scope().read(address, abi, fn, args),
    addresses: async () => { const b = await scope().bindings(); return { deployments: b.deployments, appCatalog: b.appCatalog, reviews: b.reviews, usdc: b.usdc }; },
    depRev: () => memo("depRev", async () => {
      const { deployments } = await B.addresses();
      try { return Number(await B.read(deployments, U256("deploymentsSchema"), "deploymentsSchema")) || 2; }
      catch (e) { if (e.agreedRevert) return 1; throw e; }
    }),
    catRev: () => memo("catRev", async () => {
      const { appCatalog } = await B.addresses();
      try { return Number(await B.read(appCatalog, U256("catalogSchema"), "catalogSchema")) || 2; }
      catch (e) { if (e.agreedRevert) return 2; throw e; }
    }),
    catalogApps: () => memo("catalogApps", async () => {
      const { appCatalog } = await B.addresses();
      const { catAbiFor } = await import("../relay/mcp.js");
      const abi = catAbiFor(await B.catRev());
      const rows = [];
      for (let start = 0; start < 100000; start += 50) {
        const page = await B.read(appCatalog, abi, "getAppsPage", [BigInt(start), 50n]);
        rows.push(...page);
        if (page.length < 50) break;
      }
      return rows;
    }),
    // the hosted gateway is never reached in this mode; a missed path refuses instead of falling back
    self: async (method, p) => { throw new IndependentError("no-gateway", `independent mode never contacts the Enclave gateway (${method} ${String(p).split("?")[0]} refused)`); },
    availability: () => memo("availability", () => (extras.availability ? extras.availability(B) : null)),
    pricing: () => memo("pricing", () => (extras.pricing ? extras.pricing(B) : null)),
    enclaves: () => memo("enclaves", () => (extras.enclaves ? extras.enclaves(B) : [])),
    resolvePrefix: async (hex) => {
      const hits = (await ledgerRows(B)).filter((d) => d.id.slice(2).toLowerCase().startsWith(hex));
      if (hits.length !== 1) throw new IndependentError("id", hits.length ? `id prefix 0x${hex} is ambiguous (${hits.length} matches)` : `no deployment matches id prefix 0x${hex} at the agreed block`);
      return { id: hits[0].id };
    },
    ownerDeployments: async (owner) => (await ledgerRows(B)).filter((d) => lc(d.owner) === lc(owner))
      .map((d) => ({ id: d.id, image: { reference: d.appRef }, paidUsdc: (Number(BigInt(d.balance6) + BigInt(d.spent6)) / 1e6).toFixed(6) })),
    sessionState: (vault, sid) => sessionStateAt(B, vault, sid),
    sessionsConfig: async () => ({ factory: (await scope().bindings()).factory, site: authority.cfg.grantFrontend }),
    run: async (ctx, fn) => {
      await authority.ready();
      for (let attempt = 0; ; attempt++) {
        const s = new Scope(authority);
        try { return await store.run(s, fn); }
        catch (e) { if (e.retry && attempt === 0) continue; throw e.retry ? new IndependentError("snapshot", `refused: ${e.message} while this answer was built; nothing was returned. Retry once the chain settles.`) : e; }
      }
    },
    finalize: async (name, out) => {
      const s = scope();
      if (out && typeof out === "object" && (Array.isArray(out.transactions) || Array.isArray(out.calls) || out.revalidate === true)) {
        const r = await revalidate(s);
        const { revalidate: _r, ...rest } = out;
        return { ...rest, authority: { ...s.summary(), ...(s._bindings ? await bindingSummary(s) : {}), revalidatedAt: r } };
      }
      if (out && typeof out === "object" && !Array.isArray(out)) return { ...out, authority: { ...s.summary(), ...(s._bindings ? await bindingSummary(s) : {}) } };
      return out;
    },
    ...extras.backend,
  };
  if (extras.prepareSessionCalls) B.prepareSessionCalls = (session, steps, api) => extras.prepareSessionCalls(B, session, steps, api);
  B.overrides = extras.overrides ? Object.fromEntries(Object.entries(extras.overrides).map(([k, f]) => [k, (a, ctx, api, original) => f(B, a, ctx, api, original)])) : undefined;
  B.extend = extras.extend;
  B.schemas = extras.schemas;
  return B;
}
async function bindingSummary(s) {
  const b = await s._bindings;
  return { bindings: { ledger: b.deployments, catalog: b.appCatalog, registry: b.registry, reviews: b.reviews, addressBook: b.book,
    sessionFactory: b.factory, factoryReview: b.factoryReview, codeReviewed: b.codeReviewed } };
}

// ---- ledger and sessions at the call's block -----------------------------------------------------------------------
const MAX_RECORDS = 10000, LEDGER_PAGE = 100;
export async function ledgerAbi(B) {
  const { DEPLOYMENT_TUPLE, DEPLOYMENT_TUPLE_V1, depsAbiFor } = await import("../relay/mcp.js");
  const rev = await B.depRev();
  return [...depsAbiFor(rev),
    { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "getPage", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }],
      outputs: [{ type: "tuple[]", components: rev >= 2 ? DEPLOYMENT_TUPLE : DEPLOYMENT_TUPLE_V1 }] }];
}
/** Every ledger record at the call's block (count/getPage; bounded). */
export function ledgerRows(B) {
  const s = currentScope();
  if (!s.memo.has("ledgerRows")) s.memo.set("ledgerRows", (async () => {
    const { deployments } = await B.addresses();
    const abi = await ledgerAbi(B);
    const n = await B.read(deployments, abi, "count");
    if (n > BigInt(MAX_RECORDS)) throw new IndependentError("ledger", `the ledger holds ${n} records, more than the ${MAX_RECORDS} enumerated here`);
    const rows = [];
    for (let i = 0n; i < n; i += BigInt(LEDGER_PAGE)) {
      const page = await B.read(deployments, abi, "getPage", [i, BigInt(LEDGER_PAGE)]);
      if (page.length !== Number(n - i < BigInt(LEDGER_PAGE) ? n - i : BigInt(LEDGER_PAGE))) throw new IndependentError("ledger", "incomplete ledger page");
      rows.push(...page);
    }
    return rows;
  })());
  return s.memo.get("ledgerRows");
}

const SESSION_TUPLE = [["keyHash", "bytes32"], ["measurement", "bytes32"], ["actions", "uint256"], ["expiresAt", "uint64"], ["epoch", "uint64"],
  ["envs", "uint8"], ["state", "uint8"], ["anyApp", "bool"], ["balance6", "uint128"], ["spent6", "uint128"], ["perPeriod6", "uint128"],
  ["maxFee6", "uint128"], ["maxAppFeeHour6", "uint128"], ["maxRateHour6", "uint128"], ["periodStart", "uint64"], ["period", "uint32"],
  ["opsPerPeriod", "uint32"], ["periodSpent6", "uint128"], ["periodOps", "uint32"]].map(([name, type]) => ({ name, type }));
export const VAULT_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "epoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  // public mapping(bytes32 => mapping(uint192 => uint64)) seqOf: lane-scoped call sequence (contracts/SessionVault.sol)
  { type: "function", name: "seqOf", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint192" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "sessionOf", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [{ type: "tuple", components: SESSION_TUPLE }, { type: "bool" }, { type: "bytes32[]" }] },
];
export const FACTORY_ABI = [
  { type: "function", name: "isVault", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "vaultFor", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
];
/** A session as the chain holds it at the call's block, in a vault of the PINNED factory (refused otherwise). */
export async function sessionAt(B, vault, sid) {
  const { factory } = await currentScope().bindings();
  vault = getAddress(vault);
  if (!(await B.read(factory, FACTORY_ABI, "isVault", [vault]))) throw new IndependentError("session", `${vault} is not a vault of the pinned session factory ${factory}`);
  const [owner, [session, live, apps]] = await Promise.all([B.read(vault, VAULT_ABI, "owner"), B.read(vault, VAULT_ABI, "sessionOf", [sid])]);
  return { vault, sid: lc(sid), owner: getAddress(owner), session, live, apps, exists: !/^0x0{64}$/i.test(session.keyHash) };
}
async function sessionStateAt(B, vault, sid) {
  const s = await sessionAt(B, vault, sid);
  // the relay's state shape (relay/sessions.mjs), from the chain itself
  const x = s.session;
  return { live: s.live, actions: x.actions, envs: Number(x.envs), balance6: x.balance6, spent6: x.spent6, expiresAt: x.expiresAt,
    keyHash: x.keyHash, owner: s.owner, apps: s.apps, exists: s.exists };
}

// ---- hosts (deployed schema-4 registry), with the platform host policy ----------------------------------------------
const MAX_HOSTS = 4096, HOST_PAGE = 50;
/** Every registered host at the call's block; refuses any registry that is not the deployed schema 4. */
export function registryAt(B) {
  const s = currentScope();
  if (!s.memo.has("registry")) s.memo.set("registry", (async () => {
    const { registry } = await s.bindings();
    let schema;
    try { schema = await B.read(registry, REGISTRY_SCHEMA4_ABI, "registrySchema"); } catch (e) { if (!e.agreedRevert) throw e; schema = null; }
    if (schema === null || BigInt(schema) !== 4n) throw new IndependentError("registry", `the pinned registry reports schema ${schema}; this server decodes exactly the deployed schema 4`);
    const n = await B.read(registry, REGISTRY_SCHEMA4_ABI, "count");
    if (n > BigInt(MAX_HOSTS)) throw new IndependentError("registry", `the registry lists ${n} hosts, more than ${MAX_HOSTS}`);
    const rows = [];
    for (let i = 0n; i < n; i += BigInt(HOST_PAGE)) rows.push(...await B.read(registry, REGISTRY_SCHEMA4_ABI, "getPage", [i, BigInt(HOST_PAGE)]));
    const { keccak256: k, toBytes } = await import("viem");
    return rows.map((e) => ({ id: k(toBytes(e.endpoint)), endpoint: e.endpoint, repo: e.repo, measurement: e.measurement, operator: lc(e.operator),
      registeredAt: Number(e.registeredAt), lastSeen: Number(e.lastSeen), active: e.active, cpuPricePerSec6: BigInt(e.cpuPricePerSec6),
      gpuPricePerSec6: BigInt(e.gpuPricePerSec6), proofKey: lc(e.proofKey), payoutWallet: lc(e.payoutWallet) }));
  })());
  return s.memo.get("registry");
}
export { REGISTRY_UPDATE_WINDOW_SEC, hostLiveness, quorumPublicClient, ZERO };
