// proof-agent.mjs -- the owner-side POSTING AGENT for a pVM runner's EnclaveProofOfTime checkpoints (PROOF-KEY.md
// "Activation, exactly", step 5). It holds NO proof key: the VM signs. This agent reads the lease from the chain, asks the VM
// -- through a carrier it does not trust (the phone's Android host, the relay) -- for a checkpoint over an anchor it chose,
// verifies the answer itself, simulates it, and submits it with the OPERATOR signer, then follows the transaction to a
// confirmed receipt that is still canonical.
//
// What it trusts, and where each thing comes from:
//   - the contract addresses: the owner's config, cross-checked against the address book (when one is named) and against
//     the contracts' own frozen bindings (prover.deployments(), prover.registry(), ledger.prover());
//   - the proof key: ONLY the VM's attested `enclave-proof-key/v1` statement, verified by the canonical verifyPvmProofKey
//     (relay/pvm-app-attest.mjs) under the owner's evidence pins, over this agent's own fresh nonce; its pins must be exactly
//     this lease's, and the registry entry must publish exactly that key;
//   - the lease: the ledger row (runner, runnerOperator, active, leaseUntil), read before every checkpoint request;
//   - a checkpoint: verifyPvmCheckpoint (relay/pvm-checkpoint.mjs: the pins, low s, v, the attested signer) AND equality with
//     the exact (upto, anchorBlock, anchorHash) this agent asked for -- a carrier that replays an older, genuinely signed
//     checkpoint is refused before any chain sees it.
//
// Idempotency and recovery. Every transaction is signed LOCALLY and journaled (raw bytes and hash) BEFORE it is broadcast, so
// a crash at any point leaves a journal from which the next start knows exactly what may be in flight: it follows that
// transaction (rebroadcasting the same bytes while the anchor is fresh) before it asks the VM for anything new. The chain
// makes a replay harmless ("nothing to prove"), and the agent simulates before every send, so an already-landed proof is
// never paid for twice. One agent per state directory (an O_EXCL lock).
//
// Bounded everywhere: the carrier timeout, the receipt wait, the confirmation wait, the number of fee-bumped replacements,
// the fee cap (the owner's), the anchor's age. A tick that cannot finish in its bounds says so and leaves the next tick to
// continue; nothing loops unbounded and nothing is retried harder than once per tick. The contract's window (15 min) is
// wider than the default cadence (5 min), so one lost tick costs no proven time.
//
//   const agent = await createProofAgent({ config, publicClient, account, stateDir })
//   await agent.start()          // resolve + cross-check the contracts, recover the journal, attest the VM
//   const outcome = await agent.tick()   // one bounded round; outcome.kind names what happened
//   await agent.run({ ticks, signal })   // tick every policy.intervalSec
//   agent.close()
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseAbi, encodeFunctionData, keccak256, stringToBytes, parseEventLogs, hexToString } from "viem";
import { verifyPvmProofKey, canonicalChainId } from "../../../../relay/pvm-app-attest.mjs";
import { verifyPvmCheckpoint } from "../../../../relay/pvm-checkpoint.mjs";

export { LEDGER_ABI, REGISTRY_ABI };
export const AGENT_CONFIG_FORMAT = "enclave-pvm-proof-agent/v1";
export const AGENT_DEFAULTS = Object.freeze({
  intervalSec: 300,          // one checkpoint every 5 min, against the contract's 15 min window (supervisor.js PROOF_INTERVAL_SEC)
  vmGapSec: 61,              // the VM signs at most one checkpoint per 60 s
  carrierGapMs: 3000,        // the VM answers at most one evidence-port request per 2 s
  carrierTimeoutMs: 20000,
  anchorDepth: 1,            // the parent of the newest block (supervisor.js: blockhash(latest) can be 0 inside the next block)
  maxAnchorAgeBlocks: 192,   // of blockhash()'s 256: a proof older than this is not sent
  confirmations: 2,
  receiptTimeoutMs: 90000,   // per send (supervisor.js awaitReceipt)
  confirmTimeoutMs: 120000,
  pollMs: 2000,
  maxReplacements: 3,        // fee-bumped replacements of one nonce per tick
  feeBumpPct: 25,            // geth requires >= 10 % on both fee fields
  gasMarginPct: 30,
  attestEverySec: 3600,      // re-read the attested statement at least hourly
});

const ADDR = /^0x[0-9a-f]{40}$/, B32 = /^0x[0-9a-f]{64}$/, HEX64 = /^[0-9a-f]{64}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

const POT_ABI = parseAbi([
  "function checkpoint(bytes32 id, bytes32 enclaveId, uint64 upto, uint64 anchorBlock, bytes32 anchorHash, bytes sig)",
  "function proofWindowSec() view returns (uint64)",
  "function deployments() view returns (address)",
  "function registry() view returns (address)",
  "function recordOf(bytes32) view returns (uint64 lastProofAt, uint64 provenSec, uint32 proofs)",
  "event Checkpointed(bytes32 indexed id, bytes32 indexed enclaveId, address indexed operator, uint64 provenUntil, uint64 secondsProven, uint64 anchorBlock)",
]);
// the ledger's Deployment and the registry's Enclave, exactly as EnclaveProofOfTime reads them (its IEnclaveDeployments /
// IEnclaveRegistry): the registry has appended fields since (schema 4+), which a prefix decode leaves alone, as the prover does
const LEDGER_ABI = parseAbi([
  "function claimableBy(bytes32 id, bytes32 enclaveId) view returns (bool)",
  "function claimBond6() view returns (uint256)",
  "function bondOf(address operator) view returns (uint256 amount6, uint64 exitAt)",
  "function claim(bytes32 id, bytes32 enclaveId)",
  "function renew(bytes32 id)",
  "function release(bytes32 id)",
  "function get(bytes32 id) view returns ((bytes32 id, address owner, string appRef, string ports, string configCid, uint16 gpuMilli, uint16 cpuMilli, uint32 appPort, bool isPublic, bool active, uint64 createdAt, uint256 rate, uint256 balance6, uint256 spent6, bytes32 runner, address runnerOperator, uint64 leaseUntil))",
  "function provenUntil(bytes32 id) view returns (uint64)",
  "function prover() view returns (address)",
]);
const REGISTRY_ABI = parseAbi([
  "function register(string endpoint, string repo, bytes32 measurement, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6, address proofKey) returns (bytes32)",
  "function setProofKey(bytes32 id, address proofKey)",
  "function heartbeat(bytes32 id)",
  "function deregister(bytes32 id)",
  "function get(bytes32 id) view returns ((string endpoint, string repo, bytes32 measurement, address operator, uint64 registeredAt, uint64 lastSeen, bool active, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6, address proofKey))",
]);
const BOOK_ABI = parseAbi(["function all() view returns (bytes32[], address[])"]);
// the events a lifecycle call must produce (RUNNER-AGENT.md): a mined call without its event is a failure, not a success
export const LIFECYCLE_EVENTS = parseAbi([
  "event Registered(bytes32 indexed id, address indexed operator, string endpoint, string repo)",
  "event Updated(bytes32 indexed id, string repo, bytes32 measurement)",
  "event ProofKeySet(bytes32 indexed id, address indexed proofKey)",
  "event Heartbeat(bytes32 indexed id, uint64 at)",
  "event Deregistered(bytes32 indexed id)",
  "event Claimed(bytes32 indexed id, bytes32 indexed enclaveId, address indexed operator, uint64 leaseUntil, uint256 burned6)",
  "event Renewed(bytes32 indexed id, bytes32 indexed enclaveId, uint64 leaseUntil, uint256 burned6)",
  "event Released(bytes32 indexed id, bytes32 indexed enclaveId, uint256 refunded6)",
]);

// ---------------------------------------------------------------------------------------------------------------------------
// configuration: public values only (addresses, ids, pins, URLs). The operator key is never in it.
// ---------------------------------------------------------------------------------------------------------------------------
const CONFIG_KEYS = ["addressBook", "carrier", "chainId", "deployment", "deployments", "endpoint", "evidence", "format", "maxFeePerGasWei",
                     "operator", "policy", "proofOfTime", "registry"];
const EVIDENCE_KEYS = ["allowedAuthorityHashes", "allowedCodeHashes", "allowedRuntimeIds", "appId", "instanceIds", "rootPins"];

/** Strict: a config the agent would have to repair is refused, with the rule it broke. */
export function checkAgentConfig(c) {
  const bad = (m) => { throw new Error(`proof-agent config: ${m}`); };
  if (!c || typeof c !== "object" || Array.isArray(c)) bad("not an object");
  for (const k of Object.keys(c)) if (!CONFIG_KEYS.includes(k)) bad(`unknown key ${JSON.stringify(k)}`);
  if (c.format !== AGENT_CONFIG_FORMAT) bad(`format must be ${AGENT_CONFIG_FORMAT}`);
  if (canonicalChainId(c.chainId) === null) bad("chainId must be a canonical decimal in 1..2^64-1");
  if (BigInt(c.chainId) > BigInt(Number.MAX_SAFE_INTEGER)) bad("chainId beyond 2^53 is not supported by the transaction signer");
  for (const k of ["addressBook", "proofOfTime", "registry", "deployments"]) if (c[k] !== undefined && !ADDR.test(c[k])) bad(`${k} must be 0x + 40 lowercase hex`);
  if (!c.addressBook && !(c.proofOfTime && c.registry && c.deployments)) bad("name an addressBook, or all of proofOfTime, registry and deployments");
  if (!B32.test(c.deployment || "")) bad("deployment must be 0x + 64 lowercase hex");
  if (typeof c.endpoint !== "string" || !/^https:\/\/[^\s/]+\/t\/[A-Za-z0-9._-]+$/.test(c.endpoint)) bad("endpoint must be the runner's self-routed https://<relay>/t/<name>");
  if (!ADDR.test(c.operator || "") || c.operator === ZERO) bad("operator must be 0x + 40 lowercase hex, not zero");
  if (typeof c.carrier !== "string" || !/^https?:\/\/\S+$/.test(c.carrier)) bad("carrier must be the http(s) URL of the VM's evidence endpoint");
  if (!/^[1-9][0-9]{0,30}$/.test(c.maxFeePerGasWei || "")) bad("maxFeePerGasWei (the owner's fee cap, wei, decimal) is required");
  const e = c.evidence;
  if (!e || typeof e !== "object" || Object.keys(e).sort().join() !== EVIDENCE_KEYS.join()) bad(`evidence must be exactly { ${EVIDENCE_KEYS.join(", ")} }`);
  if (!HEX64.test(e.appId || "")) bad("evidence.appId must be 64 lowercase hex");
  for (const k of EVIDENCE_KEYS.filter((k) => k !== "appId")) {
    if (!Array.isArray(e[k]) || !e[k].length || e[k].some((x) => !HEX64.test(x) && !(k === "allowedAuthorityHashes" && /^[0-9a-f]{128}$/.test(x))))
      bad(`evidence.${k} must be a non-empty list of lowercase hex digests`);
  }
  const p = c.policy || {};
  for (const [k, v] of Object.entries(p)) {
    if (!(k in AGENT_DEFAULTS)) bad(`unknown policy key ${JSON.stringify(k)}`);
    if (!Number.isInteger(v) || v < 0) bad(`policy.${k} must be a non-negative integer`);
  }
  const policy = { ...AGENT_DEFAULTS, ...p };
  if (policy.vmGapSec < 61) bad("policy.vmGapSec below 61 s would ask the VM to break its own 60 s rate");
  if (policy.maxAnchorAgeBlocks >= 256 || policy.anchorDepth < 1 || policy.anchorDepth >= policy.maxAnchorAgeBlocks) bad("anchorDepth must be >= 1 and below maxAnchorAgeBlocks, and that below 256");
  if (policy.confirmations < 1) bad("policy.confirmations must be at least 1");
  return { ...c, enclaveId: keccak256(stringToBytes(c.endpoint)), policy };
}

// ---------------------------------------------------------------------------------------------------------------------------
// the journal and the lock
// ---------------------------------------------------------------------------------------------------------------------------
function openState(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(stateDir, "agent.lock");
  for (let i = 0; i < 2; i++) {
    try { const fd = fs.openSync(lock, "wx", 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); break; }
    catch (e) {
      if (e.code !== "EEXIST" || i) throw new Error(`another proof agent holds ${lock}`);
      const pid = parseInt(fs.readFileSync(lock, "utf8"), 10);
      let alive = false; try { process.kill(pid, 0); alive = true; } catch (k) { alive = k.code === "EPERM"; }
      if (alive) throw new Error(`another proof agent (pid ${pid}) holds ${lock}`);   // this process included: one agent per state dir
      fs.unlinkSync(lock);   // its process is gone: the lock is stale
    }
  }
  const file = path.join(stateDir, "journal.jsonl");
  const entries = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`journal ${file} line ${i + 1} is not JSON: refusing to guess what is in flight`); }
  }) : [];
  const fd = fs.openSync(file, "a", 0o600);
  return {
    entries,
    append(o) { fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n"); fs.fsyncSync(fd); },
    close() { try { fs.closeSync(fd); } catch {} try { if (parseInt(fs.readFileSync(lock, "utf8"), 10) === process.pid) fs.unlinkSync(lock); } catch {} },
  };
}

/** A pending transaction's journal key: a checkpoint's EIP-712 digest, or a lifecycle intent's own digest. */
export const keyOf = (p) => (p.checkpoint ? p.checkpoint.digest : p.call.digest);

/** What the journal says is still in flight: the newest nonce with a sent transaction and no terminal record. */
export function pendingFromJournal(entries) {
  let p = null;
  for (const e of entries) {
    if (e.ev === "signed") p = { checkpoint: e.checkpoint, nonce: null, txs: [], replacements: 0 };
    else if (e.ev === "intent") p = { call: e.call, nonce: null, txs: [], replacements: 0 };
    else if (e.ev === "tx" && p && e.digest === keyOf(p)) {
      if (p.nonce !== null && p.nonce !== e.nonce) p.txs = [];
      p.nonce = e.nonce; p.txs.push({ hash: e.hash, raw: e.raw, maxFeePerGas: e.maxFeePerGas, maxPriorityFeePerGas: e.maxPriorityFeePerGas, gas: e.gas, ...(e.cancel ? { cancel: true } : {}) });
      if (e.cancel) p.cancelling = true;
      if (e.replacement) p.replacements++;
    } else if (e.ev === "done" && p && e.digest === keyOf(p)) p = null;
  }
  return p && p.txs.length ? p : null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// the agent
// ---------------------------------------------------------------------------------------------------------------------------
export async function createProofAgent({ config, publicClient, account, stateDir, fetchImpl = globalThis.fetch, now = Date.now,
                                         sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const cfg = checkAgentConfig(config), P = cfg.policy;
  if (!account || typeof account.signTransaction !== "function" || !ADDR.test(String(account.address).toLowerCase()))
    throw new Error("proof-agent: the operator signer must be a local account (it signs each transaction before it is journaled)");
  if (account.address.toLowerCase() !== cfg.operator) throw new Error(`proof-agent: the signer ${account.address} is not the configured operator ${cfg.operator}`);
  if (!stateDir) throw new Error("proof-agent: a stateDir is required (the journal is what makes a restart safe)");
  const st = openState(stateDir);
  const me = cfg.operator, D = cfg.deployment, E = cfg.enclaveId;
  let addrs = null, attested = null, pending = pendingFromJournal(st.entries);
  let lastCarrierAt = 0, lastCheckpointAskAt = 0;
  const lastSigned = st.entries.filter((e) => e.ev === "signed").map((e) => BigInt(e.checkpoint.upto)).reduce((a, b) => (b > a ? b : a), 0n);
  let maxSignedUpto = lastSigned;
  const note = (o) => { st.append(o); log(o); };
  const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });
  const lc = (a) => String(a).toLowerCase();

  // ---- the contracts: the config, the address book, and the contracts' own frozen bindings must all agree ----
  async function resolve() {
    const rpcChain = await publicClient.getChainId();
    if (String(rpcChain) !== cfg.chainId) throw new Error(`the RPC serves chain ${rpcChain}, not the configured ${cfg.chainId}`);
    const a = { proofOfTime: cfg.proofOfTime, registry: cfg.registry, deployments: cfg.deployments };
    if (cfg.addressBook) {
      const [keys, values] = await read(cfg.addressBook, BOOK_ABI, "all");
      const book = {};
      keys.forEach((k, i) => { book[hexToString(k, { size: 32 }).replace(/\0+$/, "")] = lc(values[i]); });
      for (const k of ["proofOfTime", "registry", "deployments"]) {
        if (!book[k] || book[k] === ZERO) throw new Error(`the address book has no ${k}`);
        if (a[k] && a[k] !== book[k]) throw new Error(`the config's ${k} ${a[k]} is not the address book's ${book[k]}`);
        a[k] = book[k];
      }
    }
    const [potLedger, potRegistry, ledgerProver] = await Promise.all([read(a.proofOfTime, POT_ABI, "deployments"), read(a.proofOfTime, POT_ABI, "registry"),
                                                                      read(a.deployments, LEDGER_ABI, "prover")]);
    if (lc(potLedger) !== a.deployments) throw new Error(`the prover ${a.proofOfTime} is bound to ledger ${lc(potLedger)}, not ${a.deployments}`);
    if (lc(potRegistry) !== a.registry) throw new Error(`the prover ${a.proofOfTime} reads registry ${lc(potRegistry)}, not ${a.registry}`);
    if (lc(ledgerProver) !== a.proofOfTime) throw new Error(`the ledger's prover is ${lc(ledgerProver)}, not ${a.proofOfTime}`);
    addrs = a;
    return a;
  }

  // ---- the carrier: untrusted bytes in both directions; paced to the VM's own limits ----
  async function ask(line) {
    const wait = lastCarrierAt + P.carrierGapMs - now();
    if (wait > 0) await sleep(wait);
    lastCarrierAt = now();
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), P.carrierTimeoutMs);
    try {
      const r = await fetchImpl(cfg.carrier, { method: "POST", body: line + "\n", headers: { "content-type": "text/plain" }, signal: ac.signal });
      const body = await r.text();
      if (r.status !== 200) return { error: `the carrier answered ${r.status}`, carrier: true };
      try { return JSON.parse(body.split("\n")[0]); } catch { return { error: "the carrier's answer is not one JSON line", carrier: true }; }
    } catch (e) { return { error: `the carrier failed: ${e.name === "AbortError" ? `no answer in ${P.carrierTimeoutMs} ms` : e.message}`, carrier: true }; }
    finally { clearTimeout(timer); }
  }

  // ---- the VM's attested statement over our own nonce: the only source of the proof key ----
  async function attest() {
    if (!addrs) await resolve();
    const nonce = randomBytes(32).toString("hex"), doc = await ask(`PROOFKEY ${nonce}`);
    if (doc && doc.carrier) { note({ ev: "attest", ok: false, reason: doc.error }); attested = null; return { ok: false, reason: doc.error }; }   // no statement at all: say so
    const e = cfg.evidence;
    const v = verifyPvmProofKey(doc, { nonce, appId: e.appId, allowedRuntimeIds: e.allowedRuntimeIds, allowedCodeHashes: e.allowedCodeHashes,
                                       allowedAuthorityHashes: e.allowedAuthorityHashes, rootPins: e.rootPins, instanceIds: e.instanceIds, deployment: D });
    if (!v.ok) { note({ ev: "attest", ok: false, reason: v.reasons.at(-1) }); attested = null; return { ok: false, reason: v.reasons.at(-1) }; }
    const want = { chainId: cfg.chainId, proofOfTime: addrs.proofOfTime, registry: addrs.registry, deployment: D, enclaveId: E, operator: me };
    for (const [k, x] of Object.entries(want)) if (v.claims[k] !== x) {
      const reason = `the VM's pins name ${k} ${v.claims[k]}, not this lease's ${x}`;
      note({ ev: "attest", ok: false, reason }); attested = null; return { ok: false, reason };
    }
    attested = { claims: v.claims, at: now() };
    note({ ev: "attest", ok: true, proofKey: v.claims.proofKey, instanceId: v.claims.instanceId });
    return { ok: true, claims: v.claims };
  }

  // ---- the lease, as the chain has it now ----
  async function lease() {
    const head = await publicClient.getBlock({ blockTag: "latest" });
    const [d, provenUntil, reg, rec, windowSec] = await Promise.all([read(addrs.deployments, LEDGER_ABI, "get", [D]), read(addrs.deployments, LEDGER_ABI, "provenUntil", [D]),
      read(addrs.registry, REGISTRY_ABI, "get", [E]), read(addrs.proofOfTime, POT_ABI, "recordOf", [D]), read(addrs.proofOfTime, POT_ABI, "proofWindowSec")]);
    return { head, headTs: BigInt(head.timestamp), runner: lc(d.runner), runnerOperator: lc(d.runnerOperator), active: d.active, leaseUntil: BigInt(d.leaseUntil),
             rate: BigInt(d.rate), balance6: BigInt(d.balance6),
             provenUntil: BigInt(provenUntil), regProofKey: lc(reg.proofKey), regOperator: lc(reg.operator), regActive: reg.active,
             regExists: lc(reg.operator) !== ZERO, regLastSeen: BigInt(reg.lastSeen), regRepo: reg.repo, regMeasurement: reg.measurement, regCpuPrice6: BigInt(reg.cpuPricePerSec6),
             regEndpointId: reg.endpoint ? keccak256(stringToBytes(reg.endpoint)) : null, lastProofAt: BigInt(rec[0]), windowSec: BigInt(windowSec) };
  }

  const revertReason = (x) => {
    let r = null;
    if (x && typeof x.walk === "function") x.walk((e) => { if (!r && e && (e.reason || (e.data && e.data.errorName))) r = e.reason || e.data.errorName; return false; });
    return r || (x && (x.shortMessage || x.message)) || String(x);
  };
  const receipt = (hash) => publicClient.getTransactionReceipt({ hash }).catch(() => null);
  const txArgs = (c) => [c.id, c.enclaveId, BigInt(c.upto), BigInt(c.anchorBlock), c.anchorHash, c.sig];

  async function signAndSend(p, fees, replacement) {
    const c = p.checkpoint;
    const tx = { type: "eip1559", chainId: Number(cfg.chainId), to: c ? addrs.proofOfTime : p.call.to, value: 0n, nonce: p.nonce, gas: BigInt(p.gas),
                 data: c ? encodeFunctionData({ abi: POT_ABI, functionName: "checkpoint", args: txArgs(c) }) : p.call.data,
                 maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    const raw = await account.signTransaction(tx), hash = keccak256(raw);
    const t = { hash, raw, maxFeePerGas: String(fees.maxFeePerGas), maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas), gas: String(p.gas) };
    note({ ev: "tx", digest: keyOf(p), nonce: p.nonce, ...t, replacement: !!replacement });   // journaled BEFORE it can reach any node
    p.txs.push(t); if (replacement) p.replacements++;
    return broadcast(t);
  }
  async function broadcast(t) {
    try { await publicClient.sendRawTransaction({ serializedTransaction: t.raw }); return { ok: true }; }
    catch (x) {
      const m = revertReason(x);
      if (/already known|known transaction|already imported/i.test(m)) return { ok: true };
      return { ok: false, reason: m, nonceTooLow: /nonce too low|nonce has already been used/i.test(m), underpriced: /underpriced|fee too low/i.test(m) };
    }
  }
  const cap = () => BigInt(cfg.maxFeePerGasWei);
  const capped = (f) => { const max = f.maxFeePerGas > cap() ? cap() : f.maxFeePerGas;
                          return { maxFeePerGas: max, maxPriorityFeePerGas: f.maxPriorityFeePerGas > max ? max : f.maxPriorityFeePerGas }; };
  const bump = (x) => x + (x * BigInt(P.feeBumpPct) + 99n) / 100n;
  const maxOf = (x, y) => (x > y ? x : y);
  // the fees a transaction REPLACING `prev` at the same nonce needs: the estimate, or prev bumped, whichever is higher; null
  // when that is above the owner's cap (a replacement below the bump is refused by every node, so it is not sent)
  async function replacementFees(prev) {
    const est = await publicClient.estimateFeesPerGas();
    const want = { maxFeePerGas: maxOf(est.maxFeePerGas, bump(BigInt(prev.maxFeePerGas))), maxPriorityFeePerGas: maxOf(est.maxPriorityFeePerGas, bump(BigInt(prev.maxPriorityFeePerGas))) };
    return want.maxFeePerGas > cap() ? { over: want.maxFeePerGas } : want;
  }

  // ---- follow what is in flight to a confirmed, canonical receipt: bounded ----
  // Returns the outcome. `pending` stays set when the transaction may still land (stuck, unconfirmed, fee-capped); the outcome
  // then says `fresh: true` when only a NEW proof (or a cancel) can still use its nonce, because its anchor has aged out.
  async function settle(p) {
    const op = p.checkpoint ? {} : { op: p.call.op };
    const done = (kind, extra = {}) => { note({ ev: "done", digest: keyOf(p), kind, ...op, ...extra }); pending = null; return { kind, ...op, ...extra }; };
    const keep = (kind, extra) => { pending = p; note({ ev: "stuck", digest: keyOf(p), nonce: p.nonce, kind, ...op, ...extra }); return { kind, nonce: p.nonce, ...op, ...extra }; };
    let replacedHere = 0;   // a lifecycle call has no anchor to age out: its replacements are bounded per tick, and it keeps its nonce
    for (let reorgs = 0; ; ) {
      const deadline = now() + P.receiptTimeoutMs;
      let found = null;
      for (;;) {
        for (const t of p.txs) { const r = await receipt(t.hash); if (r) { found = { t, r }; break; } }
        if (found || now() >= deadline) break;
        await sleep(P.pollMs);
      }
      if (!found) {
        const latest = await publicClient.getTransactionCount({ address: me, blockTag: "latest" });
        if (latest > p.nonce) {
          for (const t of p.txs) { const r = await receipt(t.hash); if (r) { found = { t, r }; break; } }
          if (!found) return done("nonce-consumed", { nonce: p.nonce, reason: "another transaction from the operator took this nonce; the next tick proves afresh" });
        } else {
          if (p.cancelling) return keep("stuck", { reason: "the cancel is not mined yet" });
          if (p.checkpoint) {
            const head = await publicClient.getBlock({ blockTag: "latest" });
            const age = Number(head.number) - Number(p.checkpoint.anchorBlock);
            if (age >= P.maxAnchorAgeBlocks) return keep("stuck", { fresh: true, anchorAge: age, reason: `not mined, and the anchor is ${age} blocks old: only a fresh proof (or a cancel) can use nonce ${p.nonce} now` });
            const anc = await publicClient.getBlock({ blockNumber: BigInt(p.checkpoint.anchorBlock) }).catch(() => null);
            if (!anc || anc.hash !== p.checkpoint.anchorHash)
              return keep("stuck", { fresh: true, reason: `not mined, and the anchor block ${p.checkpoint.anchorBlock} is no longer canonical: only a fresh proof (or a cancel) can use nonce ${p.nonce} now` });
          }
          const replaced = p.checkpoint ? p.replacements : replacedHere;
          if (replaced >= P.maxReplacements) return keep("stuck", { replacements: replaced, reason: `not mined after ${replaced} replacements; kept for the next tick` });
          const fees = await replacementFees(p.txs.at(-1));
          if (fees.over) return keep("fee-cap", { reason: `a replacement needs maxFeePerGas ${fees.over}, above the owner's cap ${cfg.maxFeePerGasWei}` });
          const b = await signAndSend(p, fees, true); replacedHere++;
          if (!b.ok && !b.nonceTooLow) note({ ev: "broadcast-failed", digest: keyOf(p), reason: b.reason });
          continue;   // mined meanwhile (nonce too low): the next pass finds its receipt, or calls the nonce consumed
        }
      }
      const { t, r } = found;
      if (t.cancel) return done("cancelled", { hash: t.hash, block: Number(r.blockNumber), nonce: p.nonce });
      if (r.status !== "success") return done("reverted", { hash: t.hash, block: Number(r.blockNumber), gasUsed: String(r.gasUsed) });
      // confirmations, then the receipt must still be the canonical one
      const cdl = now() + P.confirmTimeoutMs;
      for (;;) {
        const n = await publicClient.getBlockNumber({ cacheTime: 0 });
        if (n >= r.blockNumber + BigInt(P.confirmations - 1)) break;
        if (now() >= cdl) { pending = p; return { kind: "unconfirmed", hash: t.hash, reason: `${P.confirmations} confirmations did not arrive in ${P.confirmTimeoutMs} ms; the next tick checks again` }; }
        await sleep(P.pollMs);
      }
      const r2 = await receipt(t.hash);
      const blk = await publicClient.getBlock({ blockNumber: r.blockNumber }).catch(() => null);
      if (!r2 || r2.blockHash !== r.blockHash || !blk || blk.hash !== r.blockHash) {
        note({ ev: "reorg", digest: keyOf(p), hash: t.hash, block: Number(r.blockNumber), was: r.blockHash, now: r2 ? r2.blockHash : null });
        if (++reorgs > 2) return done("reorged-out", { hash: t.hash, reason: "reorganized away twice; the next tick proves afresh" });
        // back in the pool or dropped: rebroadcast the same bytes while the anchor is still a canonical, recent block (a lifecycle
        // call has no anchor: its bytes are rebroadcast as they are)
        const a = p.checkpoint ? await publicClient.getBlock({ blockNumber: BigInt(p.checkpoint.anchorBlock) }).catch(() => null) : null;
        if (p.checkpoint && (!a || a.hash !== p.checkpoint.anchorHash)) {
          const latest = await publicClient.getTransactionCount({ address: me, blockTag: "latest" });
          if (latest <= p.nonce) return keep("stuck", { fresh: true, reason: "the anchor block itself was reorganized away: only a fresh proof (or a cancel) can use this nonce" });
          return done("reorged-out", { hash: t.hash, reason: "the anchor block was reorganized away and the nonce is used; the next tick proves afresh" });
        }
        for (const x of p.txs) await broadcast(x);
        continue;
      }
      if (r2.status !== "success") return done("reverted", { hash: t.hash, block: Number(r2.blockNumber) });
      if (!p.checkpoint) {   // a lifecycle call: the event it must produce, from the contract it called, for its id
        const want = p.call.event, evs = parseEventLogs({ abi: LIFECYCLE_EVENTS, logs: r2.logs, strict: false })
          .filter((l) => lc(l.address) === lc(p.call.to) && want.split("|").includes(l.eventName) && (!p.call.eventId || lc(l.args.id) === lc(p.call.eventId)));
        if (!evs.length) return done("reverted", { hash: t.hash, reason: `mined without its ${want} event` });
        const args = Object.fromEntries(Object.entries(evs.at(-1).args).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v]));
        return done("landed", { hash: t.hash, block: Number(r2.blockNumber), blockHash: r2.blockHash, event: evs.at(-1).eventName, args, gasUsed: String(r2.gasUsed), nonce: p.nonce });
      }
      const ev = parseEventLogs({ abi: POT_ABI, logs: r2.logs, eventName: "Checkpointed", strict: false })
        .find((l) => lc(l.address) === addrs.proofOfTime && lc(l.args.id) === D);
      if (!ev) return done("reverted", { hash: t.hash, reason: "mined without a Checkpointed event for this deployment" });
      const ledgerNow = BigInt(await read(addrs.deployments, LEDGER_ABI, "provenUntil", [D]));
      return done("landed", { hash: t.hash, block: Number(r2.blockNumber), blockHash: r2.blockHash, provenUntil: String(ev.args.provenUntil),
                              secondsProven: String(ev.args.secondsProven), ledgerProvenUntil: String(ledgerNow), gasUsed: String(r2.gasUsed), nonce: p.nonce });
    }
  }

  // A nonce that can no longer carry a proof, with no fresh proof to put in it this tick, is CANCELLED (a 0-value transfer to
  // the operator itself at bumped fees) so it cannot block the operator's other transactions (claim, renew, heartbeat).
  async function cancel(p) {
    const fees = await replacementFees(p.txs.at(-1));
    if (fees.over) return keep2(p, "fee-cap", { reason: `cancelling nonce ${p.nonce} needs maxFeePerGas ${fees.over}, above the owner's cap ${cfg.maxFeePerGasWei}` });
    const tx = { type: "eip1559", chainId: Number(cfg.chainId), to: me, value: 0n, nonce: p.nonce, gas: 21000n, ...fees };
    const raw = await account.signTransaction(tx), hash = keccak256(raw);
    const t = { hash, raw, maxFeePerGas: String(fees.maxFeePerGas), maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas), gas: "21000", cancel: true };
    note({ ev: "tx", digest: keyOf(p), nonce: p.nonce, ...t, replacement: true });
    p.txs.push(t); p.cancelling = true;
    const b = await broadcast(t);
    if (!b.ok && !b.nonceTooLow) note({ ev: "broadcast-failed", digest: keyOf(p), reason: b.reason });
    return settle(p);
  }
  const keep2 = (p, kind, extra) => { pending = p; note({ ev: "stuck", digest: keyOf(p), nonce: p.nonce, kind, ...extra }); return { kind, nonce: p.nonce, ...extra }; };

  // ---- after a restart: what the journal says may be in flight is followed before anything new is asked ----
  async function recover() {
    if (!pending) return null;
    note({ ev: "recover", digest: keyOf(pending), nonce: pending.nonce, txs: pending.txs.length, ...(pending.call ? { op: pending.call.op } : {}) });
    const latest = await publicClient.getTransactionCount({ address: me, blockTag: "latest" });
    if (latest <= pending.nonce) {
      const head = await publicClient.getBlock({ blockTag: "latest" });
      if (pending.cancelling || !pending.checkpoint || Number(head.number) - Number(pending.checkpoint.anchorBlock) < P.maxAnchorAgeBlocks) for (const t of pending.txs) await broadcast(t);
    }
    return settle(pending);
  }

  // ---- one bounded round ----
  async function tick() {
    if (!addrs) await resolve();
    let carry = null;   // a nonce an earlier tick left stuck with an aged-out anchor: this tick's fresh proof replaces it, or it is cancelled
    if (pending) {
      const s = await settle(pending);
      if (pending && !s.fresh) { note({ ev: "tick", ...s }); return s; }
      if (pending) carry = pending;
      else if (s.kind === "landed") { note({ ev: "tick", ...s }); return s; }
    }
    const o = await fresh(carry);
    if (o.sent) { note({ ev: "tick", ...o.sent }); return o.sent; }
    note({ ev: "tick", ...o });
    if (carry && pending === carry) { const c = await cancel(carry); note({ ev: "tick", ...c, cancelledFor: o.kind }); return { ...o, cancel: c }; }
    return o;
  }

  async function fresh(carry) {
    const L = await lease();
    const out = (kind, extra = {}) => ({ kind, ...extra });
    if (!L.active) return out("inactive", { reason: "the deployment is not active" });
    if (L.runner !== E || L.runnerOperator !== me) return out("not-our-lease", { runner: L.runner, runnerOperator: L.runnerOperator });
    if (L.leaseUntil <= L.headTs) return out("lease-ended", { leaseUntil: String(L.leaseUntil) });
    if (!L.regActive || L.regOperator !== me || L.regEndpointId !== E) return out("registry-mismatch", { reason: "the registry entry is inactive, or not this operator's, or not this endpoint's" });
    if (!attested || now() - attested.at > P.attestEverySec * 1000) { const a = await attest(); if (!a.ok) return out("attest-failed", { reason: a.reason }); }
    if (L.regProofKey !== attested.claims.proofKey)
      return out("proof-key-mismatch", { registered: L.regProofKey, attested: attested.claims.proofKey, reason: "the owner must setProofKey to the attested key; nothing is signed until then" });
    const upto = L.headTs < L.leaseUntil ? L.headTs : L.leaseUntil;
    if (upto <= L.provenUntil) return out("up-to-date", { provenUntil: String(L.provenUntil) });
    if (L.headTs <= L.lastProofAt) return out("up-to-date", { reason: "a proof landed in this block already" });
    if (upto <= maxSignedUpto) return out("up-to-date", { reason: "no new time since the last signed checkpoint" });
    if (L.head.baseFeePerGas != null && L.head.baseFeePerGas > cap()) return out("fee-cap", { reason: `the base fee ${L.head.baseFeePerGas} is above the owner's cap ${cfg.maxFeePerGasWei}` });
    if (now() - lastCheckpointAskAt < P.vmGapSec * 1000) return out("vm-rate", { reason: `the VM signs at most one checkpoint per 60 s; the last ask was ${Math.round((now() - lastCheckpointAskAt) / 1000)} s ago` });
    // the anchor: a canonical block anchorDepth below the head, re-read by number so the pair is one chain's
    const anchorBlock = L.head.number - BigInt(P.anchorDepth);
    const ab = await publicClient.getBlock({ blockNumber: anchorBlock });
    if (P.anchorDepth === 1 && ab.hash !== L.head.parentHash) return out("anchor-moved", { reason: "the head's parent is not the block at its number: the chain moved under the read; the next tick retries" });
    const anchorHash = ab.hash;
    lastCheckpointAskAt = now();
    const doc = await ask(`CHECKPOINT ${upto} ${anchorBlock} ${anchorHash.slice(2)}`);
    if (doc && doc.error) return out(doc.carrier ? "carrier-failed" : "vm-refused", { reason: doc.error });
    const v = await verifyPvmCheckpoint(doc, { pins: attested.claims, proofKey: attested.claims.proofKey });
    if (!v.ok && /is signed by/.test(v.reasons[0])) {   // perhaps a re-provisioned VM with a new key: re-attest; never trust THIS answer
      const a = await attest();
      return out("checkpoint-refused", { reason: v.reasons[0], reattested: a.ok ? a.claims.proofKey : `failed: ${a.reason}` });
    }
    if (!v.ok) return out("checkpoint-refused", { reason: v.reasons[0] });
    const c = v.checkpoint;
    if (c.upto !== upto || c.anchorBlock !== anchorBlock || c.anchorHash !== anchorHash)
      return out("checkpoint-refused", { reason: `the answer is a checkpoint for (${c.upto}, ${c.anchorBlock}), not the one asked for (${upto}, ${anchorBlock}): a replayed or crossed answer` });
    maxSignedUpto = upto;
    const cp = { id: c.id, enclaveId: c.enclaveId, upto: String(c.upto), anchorBlock: String(c.anchorBlock), anchorHash: c.anchorHash, sig: c.sig, digest: c.digest };
    // simulate on the state the transaction will meet: a refusal comes back as the contract's own reason, and costs nothing
    let gas;
    try {
      await publicClient.simulateContract({ account: me, address: addrs.proofOfTime, abi: POT_ABI, functionName: "checkpoint", args: txArgs(cp) });
      gas = await publicClient.estimateContractGas({ account: me, address: addrs.proofOfTime, abi: POT_ABI, functionName: "checkpoint", args: txArgs(cp) });
    } catch (x) {
      const reason = revertReason(x);
      const kind = /nothing to prove/.test(reason) ? "already-proven" : /stale or unknown anchor/.test(reason) ? "stale-anchor" : /not the runner/.test(reason) ? "not-our-lease" : "simulate-refused";
      note({ ev: "signed", checkpoint: cp, simulated: false });
      note({ ev: "done", digest: cp.digest, kind, reason });
      return out(kind, { reason });
    }
    gas = gas + (gas * BigInt(P.gasMarginPct) + 99n) / 100n;
    let fees = capped(await publicClient.estimateFeesPerGas());
    if (carry) {   // this fresh proof REPLACES the stuck nonce: it must outbid the transaction already there
      const need = await replacementFees(carry.txs.at(-1));
      if (need.over) return out("fee-cap", { reason: `replacing stuck nonce ${carry.nonce} needs maxFeePerGas ${need.over}, above the owner's cap ${cfg.maxFeePerGasWei}` });
      fees = { maxFeePerGas: maxOf(fees.maxFeePerGas, need.maxFeePerGas), maxPriorityFeePerGas: maxOf(fees.maxPriorityFeePerGas, need.maxPriorityFeePerGas) };
    }
    note({ ev: "signed", checkpoint: cp, simulated: true });
    const nonce = carry ? carry.nonce : await publicClient.getTransactionCount({ address: me, blockTag: "pending" });
    const p = { checkpoint: cp, nonce, txs: carry ? [...carry.txs] : [], replacements: 0, gas: String(gas) };   // the stuck hashes stay watched
    pending = p;
    let b = await signAndSend(p, fees, !!carry);
    if (!b.ok && b.nonceTooLow && !carry) {
      p.nonce = await publicClient.getTransactionCount({ address: me, blockTag: "pending" }); p.txs = [];
      b = await signAndSend(p, fees, false);
    }
    if (!b.ok && !b.nonceTooLow) note({ ev: "broadcast-failed", digest: cp.digest, reason: b.reason });
    return { sent: await settle(p) };
  }

  // ---- a lifecycle call (RUNNER-AGENT.md): simulated first, then signed, journaled and sent exactly like a checkpoint ----
  // c = { op, contract: "registry" | "deployments", functionName, args, event: "Name" or "A|B", eventId } -> the outcome
  async function sendCall(c) {
    if (!addrs) await resolve();
    if (pending) return { kind: "busy", op: c.op, reason: "a transaction is already in flight: it is followed first" };
    const to = addrs[c.contract], abi = c.contract === "registry" ? REGISTRY_ABI : LEDGER_ABI;
    const data = encodeFunctionData({ abi, functionName: c.functionName, args: c.args });
    let gas;
    try {
      await publicClient.simulateContract({ account: me, address: to, abi, functionName: c.functionName, args: c.args });
      gas = await publicClient.estimateContractGas({ account: me, address: to, abi, functionName: c.functionName, args: c.args });
    } catch (x) { const reason = revertReason(x); note({ ev: "refused", op: c.op, reason }); return { kind: "refused", op: c.op, reason }; }
    gas = gas + (gas * BigInt(P.gasMarginPct) + 99n) / 100n;
    const head = await publicClient.getBlock({ blockTag: "latest" });
    if (head.baseFeePerGas != null && head.baseFeePerGas > cap()) return { kind: "fee-cap", op: c.op, reason: `the base fee ${head.baseFeePerGas} is above the owner's cap ${cfg.maxFeePerGasWei}` };
    const fees = capped(await publicClient.estimateFeesPerGas());
    const call = { op: c.op, to: lc(to), data, event: c.event, eventId: c.eventId || null,
                   digest: keccak256(stringToBytes(`${c.op}|${lc(to)}|${data}|${randomBytes(16).toString("hex")}`)) };
    note({ ev: "intent", call, simulated: true });
    const nonce = await publicClient.getTransactionCount({ address: me, blockTag: "pending" });
    const p = { call, nonce, txs: [], replacements: 0, gas: String(gas) };
    pending = p;
    let b = await signAndSend(p, fees, false);
    if (!b.ok && b.nonceTooLow) { p.nonce = await publicClient.getTransactionCount({ address: me, blockTag: "pending" }); p.txs = []; b = await signAndSend(p, fees, false); }
    if (!b.ok && !b.nonceTooLow) note({ ev: "broadcast-failed", digest: call.digest, reason: b.reason });
    return settle(p);
  }
  // follow whatever is in flight (a checkpoint or a call) without deciding anything new
  async function settlePending() { if (!addrs) await resolve(); return pending ? settle(pending) : null; }

  async function start() {
    await resolve();
    const r = await recover();
    const a = await attest();
    return { addresses: addrs, recovered: r, attested: a.ok ? a.claims : null, attestReason: a.ok ? null : a.reason };
  }

  async function run({ ticks = Infinity, signal } = {}) {
    const outs = [];
    for (let i = 0; i < ticks && !(signal && signal.aborted); i++) {
      const t0 = now();
      try { outs.push(await tick()); } catch (e) { const o = { kind: "error", reason: e.shortMessage || e.message }; note({ ev: "tick", ...o }); outs.push(o); }
      if (i + 1 < ticks) { const wait = t0 + P.intervalSec * 1000 - now(); if (wait > 0) await sleep(wait); }
    }
    return outs;
  }

  return { start, resolve, attest, tick, run, recover, sendCall, settlePending, note, config: cfg, lease: async () => { if (!addrs) await resolve(); return lease(); },
           readLedger: (fn, args) => read(addrs.deployments, LEDGER_ABI, fn, args), get lastCheckpointAskAt() { return lastCheckpointAskAt; },
           get addresses() { return addrs; }, get attested() { return attested && attested.claims; }, get pending() { return pending; },
           close: () => st.close() };
}
