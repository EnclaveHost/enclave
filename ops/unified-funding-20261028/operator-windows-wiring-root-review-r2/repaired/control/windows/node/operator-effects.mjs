// operator-effects.mjs - the ONE physically owned record of operator-key effects for one operator account + chain
// (operator durability repair r1, SOURCE ONLY, AUTHORED, NOT RUN).
//
// REPLACES operator-obligations.mjs for chain.mjs (that module is no longer imported). Its ENOENT -> {} treated a deleted established
// store as a first run, its read/modify/rename had no physical exclusion, it ignored short writes and swallowed every directory-sync
// error, and two module instances could each load and overwrite the other's records. Here:
//
// OWNERSHIP. Direct writes AND sponsored claim/renew/release obligations of one domain { account, chainId } live in ONE store with ONE
// physical owner, reusing the reviewed platform primitives (never a caller Boolean, never module memory):
//   - "windows-owned-log" (win32): win-durable.mjs openOwnedLog under its exclusion (WINDOWS_EXCLUSION: CreateFileW share mode 0, the
//     handle IS the owner; or a root-qualified windowsNumericExclusion passed in). checkWindowsStorage (ACL/NTFS/fixed volume) is
//     REQUIRED before open on win32. Append-only hash-chained events, full-write loop + FlushFileBuffers, failure latch. No rename or
//     directory-sync guarantee is assumed on Windows.
//   - "linux-owned-state" (linux): owned-durable-state.mjs openOwnedLock (genuine flock on <file>.lock) + openDurableState
//     (established/expectExisting, retained intent/commit/marker/history, owned boot verification). owner:null is never used.
//   TEST_inProcessExclusion may be passed to the Windows-log backend by portable tests; status() then says production:false. It is a
//   shared in-process test exclusion object only: never production, never cross-process qualification.
// Ownership is checked on every read and every change (assertLive). Any loss/failure LATCHES this store: every later read/change
// refuses, in-memory state is never presented as durable, and everything already on disk stays for the next owner.
//
// ESTABLISHMENT. initializeOperatorEffects() is a separate explicit install/migration step (never run because a file is absent). A
// normal open REFUSES an absent, foreign-purpose, foreign-domain, torn, quarantined, uncertain or malformed store, also after restart.
// Initialization refuses an existing store and refuses while a legacy operator-writes/sponsored-obligations file still holds records.
//
// RECORDS. Strictly validated: exact domain (no current-account fallback), safe types/ranges/states, the COMPLETE canonical request
// (bounded; a larger request is refused, never truncated) plus its sha256. Bounded: MAX_RECORDS unresolved records, MAX_ENTRIES
// entries per sponsored record, MAX_RECORD_BYTES per record, 7 MiB admission / 8 MiB hard with SETTLE_RESERVE bytes kept per open
// record for its settlement. A full store refuses NEW records; settlement stays possible. Nothing unresolved is deleted to make room,
// a torn log is never truncated, and there is no automatic compaction (explicit maintenance is unfinished follow-on work).
//
// durability r2 (SOURCE ONLY, AUTHORED, NOT RUN). CONTINUITY, NOT ONLY LOCK LIVENESS: r1's Linux assertLive asked only the owner
// lock (owned-durable-state assertLive). The established state file and its marker were checked only by that primitive's own
// check(), which r1 reached through h.store and never through records()/get()/assertLive, so cached records and the final gate
// survived deletion/replacement of the state or its marker while the lock stayed held (root boundary-v2: one inert write each).
// Every read, change and final assertLive now goes through the primitive's ACTUAL continuity check (h.state -> check(): lock, latch,
// same inode/size/mtime as our last durable write, marker present); a loss latches. Nothing is rebuilt from process memory. The
// Windows log adds a path presence/identity check under its held handle (a TEST exclusion does not deny deletion; WINDOWS_EXCLUSION's
// share mode 0 does, pending native qualification).
// Entry states added (r1 records stay valid): authorization "withheld"/"unsent", lease signing "unsent" ("unsent" = recorded
// intent whose signer was provably never invoked); optional sponsored "leaseOutcome" (the lease part settled while an EIP-7702
// authorization of that record still holds its ACCOUNT nonce).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { initializeOwnedLog, openOwnedLog, WINDOWS_EXCLUSION, checkWindowsStorage } from "../vbslike/manager/win-durable.mjs";
import { openDurableState, openOwnedLock } from "../../network/owned-durable-state.mjs";

export const OPERATOR_EFFECTS_PURPOSE = "enclave-operator-effects/1";
export const STATE_SCHEMA = "enclave-operator-effects-state/1";
export const MAX_RECORDS = 64;
export const MAX_ENTRIES = 6;
export const MAX_REQUEST_BYTES = 16384;   // room for a checkpointMany batch; a larger request is refused before any effect
export const MAX_RECORD_BYTES = 48 * 1024;
const HARD_BYTES = 8 * 1024 * 1024, ADMISSION_BYTES = 7 * 1024 * 1024, SETTLE_RESERVE = 2048;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const ADDR = /^0x[0-9a-f]{40}$/, H32 = /^0x[0-9a-f]{64}$/, HEX = /^0x[0-9a-fA-F]{2,2048}$/, FN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const KEY = /^(w:[0-9]{1,15}|s:(claim|renew|release):0x[0-9a-f]{64}:[0-9]{1,15}-[0-9]{1,9})$/;
const WRITE_STATES = new Set(["sending", "sent", "unknown"]);
const SPONSORED_STATES = new Set(["begun", "authorizing", "signing", "withheld", "signed", "posted"]);
const SIGNING_STATES = new Set(["signing", "returned", "withheld", "sign-threw", "unsent"]);
const AUTH_STATES = new Set(["signing", "returned", "withheld", "sign-threw", "unsent"]);
const SPONSORED_KEYS = ["type", "key", "account", "chainId", "fn", "id", "state", "bindings", "authorizations", "signings", "intents", "posts", "refused", "at"];
const fail = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** Deterministic JSON (sorted keys, BigInt as "<n>n"); throws on undefined/functions/non-finite numbers rather than dropping them. */
export function canonical(v) {
  const walk = (x) => {
    if (typeof x === "bigint") return `${x}n`;
    if (x === null || typeof x === "string" || typeof x === "boolean") return x;
    if (typeof x === "number") { if (!Number.isFinite(x)) throw Error("non-finite number"); return x; }
    if (Array.isArray(x)) return x.map(walk);
    if (typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype) {
      const o = {}; for (const k of Object.keys(x).sort()) o[k] = walk(x[k]); return o;
    }
    throw Error(`value of type ${typeof x} cannot be recorded exactly`);
  };
  return JSON.stringify(walk(v));
}
/** canonical(v), refused (never truncated) above MAX_REQUEST_BYTES */
export function canonicalBounded(v, what = "request") {
  const s = canonical(v);
  if (Buffer.byteLength(s) > MAX_REQUEST_BYTES) throw fail(`the ${what} is ${Buffer.byteLength(s)} bytes, above the ${MAX_REQUEST_BYTES}-byte exact-record bound: refused, never truncated`, "RequestNotRecordable");
  return s;
}

export function normalizeDomain(d) {
  const account = String(d?.account ?? "").toLowerCase(), chainId = d?.chainId;
  if (!ADDR.test(account) || !Number.isSafeInteger(chainId) || chainId < 1) throw fail("operator-effects domain must be { account: 0x + 40 hex, chainId: positive integer }", "BadDomain");
  return Object.freeze({ account, chainId });
}

const isInt = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const isText = (s, max) => typeof s === "string" && s.length <= max;
const exactCanon = (s, h) => isText(s, MAX_REQUEST_BYTES) && Buffer.byteLength(s) <= MAX_REQUEST_BYTES && typeof h === "string" && h === sha(s) && (() => { try { JSON.parse(s); return true; } catch { return false; } })();
const onlyKeys = (o, keys) => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k)) && keys.every((k) => Object.hasOwn(o, k));

/** one record, strictly: its own key, this exact domain, safe values only. Returns null or the problem. */
export function recordProblem(key, r, domain) {
  if (!KEY.test(String(key))) return "a record with an invalid key";
  if (!r || typeof r !== "object" || r.key !== key) return `${key}: record does not carry its own key`;
  if (r.account !== domain.account || r.chainId !== domain.chainId) return `${key}: record of another operator account or chain (${r.account} / ${r.chainId}): never replayed under this domain`;
  if (!isInt(r.at, 1)) return `${key}: invalid time`;
  if (Buffer.byteLength(JSON.stringify(r)) > MAX_RECORD_BYTES) return `${key}: record above ${MAX_RECORD_BYTES} bytes`;
  if (r.type === "write") {
    if (!onlyKeys(r, ["type", "key", "account", "chainId", "nonce", "address", "functionName", "request", "requestSha256", "state", "hash", "error", "at"])) return `${key}: unexpected or missing write fields`;
    if (!isInt(r.nonce) || key !== `w:${r.nonce}`) return `${key}: nonce does not match its key`;
    if (!ADDR.test(String(r.address).toLowerCase()) || !FN.test(String(r.functionName))) return `${key}: invalid target`;
    if (!exactCanon(r.request, r.requestSha256)) return `${key}: request is not the exact recorded request`;
    if (!WRITE_STATES.has(r.state) || !(r.hash === null || H32.test(String(r.hash))) || (r.state === "sent" && r.hash === null)) return `${key}: invalid write state`;
    if (!(r.error === null || isText(r.error, 300))) return `${key}: invalid error`;
    return null;
  }
  if (r.type === "sponsored") {
    if (!onlyKeys(r, Object.hasOwn(r, "leaseOutcome") ? [...SPONSORED_KEYS, "leaseOutcome"] : SPONSORED_KEYS)) return `${key}: unexpected or missing sponsored fields`;
    if (Object.hasOwn(r, "leaseOutcome") && !(r.leaseOutcome === null || isText(r.leaseOutcome, 300))) return `${key}: invalid lease outcome`;
    if (!["claim", "renew", "release"].includes(r.fn) || !H32.test(String(r.id)) || !key.startsWith(`s:${r.fn}:${r.id}:`)) return `${key}: operation does not match its key`;
    if (!SPONSORED_STATES.has(r.state) || !isInt(r.posts) || !(r.refused === null || isText(r.refused, 300))) return `${key}: invalid sponsored state`;
    if (!exactCanon(r.bindings?.canonical, r.bindings?.sha256) || !onlyKeys(r.bindings, ["canonical", "sha256"])) return `${key}: invalid recorded bindings`;
    for (const [list, states] of [[r.authorizations, AUTH_STATES], [r.signings, SIGNING_STATES]]) {
      if (!Array.isArray(list) || list.length > MAX_ENTRIES) return `${key}: too many or invalid signing entries`;
      for (const s of list) {
        if (!onlyKeys(s, ["at", "state", "request", "sha256", "signer", "signature"]) || !states.has(s.state) || !isInt(s.at, 1) || !exactCanon(s.request, s.sha256) || !ADDR.test(String(s.signer)))
          return `${key}: invalid signing entry`;
        if (!(s.signature === null || HEX.test(String(s.signature)))) return `${key}: invalid recorded signature`;
      }
    }
    if (!Array.isArray(r.intents) || r.intents.length > MAX_ENTRIES || !r.intents.every((i) => onlyKeys(i, ["intent", "sha256"]) && exactCanon(i.intent, i.sha256))) return `${key}: invalid signed intents`;
    return null;
  }
  return `${key}: unknown record type`;
}

function validateState(j, domain) {
  if (!onlyKeys(j, ["schema", "domain", "seq", "records"]) || j.schema !== STATE_SCHEMA || !isInt(j.seq)) throw Error("operator-effects state malformed");
  if (j.domain?.account !== domain.account || j.domain?.chainId !== domain.chainId) throw Error(`operator-effects store belongs to ${j.domain?.account} on chain ${j.domain?.chainId}, not this operator domain: refused`);
  if (!j.records || typeof j.records !== "object" || Array.isArray(j.records) || Object.keys(j.records).length > MAX_RECORDS) throw Error("operator-effects records malformed or over bound");
  for (const [k, r] of Object.entries(j.records)) { const p = recordProblem(k, r, domain); if (p) throw Error(`operator-effects record refused: ${p}`); }
  if (Buffer.byteLength(JSON.stringify(j)) > HARD_BYTES) throw Error("operator-effects state above its hard bound");
  return j;
}

function backendOf({ backend, platform }) {
  const b = backend ?? (platform === "win32" ? "windows-owned-log" : platform === "linux" ? "linux-owned-state" : null);
  if (b !== "windows-owned-log" && b !== "linux-owned-state") throw fail(`no owned operator-effects storage on platform ${platform}: refused (never treated as success)`, "UnsupportedPlatform");
  return b;
}
async function windowsStorage(file, storage, platform) {
  if (platform !== "win32") return;
  if (typeof storage?.run !== "function" || !storage.sddl || !storage.parentSddl) throw fail("Windows operator-effects storage needs its ACL/NTFS/fixed-volume check (storage.run/sddl/parentSddl): refused", "StorageUnqualified");
  await checkWindowsStorage(storage.run, file, { sddl: storage.sddl, parentSddl: storage.parentSddl });
}
/** Legacy operator-obligations JSON files that still hold records block initialization (their obligations must be settled first). */
function legacyRefusal(files = [], fsImpl = fs) {
  for (const f of files) {
    let text; try { text = fsImpl.readFileSync(f, "utf8"); } catch (e) { if (e.code === "ENOENT") continue; return `legacy obligation file ${f} unreadable (${e.code || e.message})`; }
    let j; try { j = JSON.parse(text); } catch { return `legacy obligation file ${f} malformed`; }
    if (!j?.records || typeof j.records !== "object" || Object.keys(j.records).length) return `legacy obligation file ${f} holds unresolved records`;
  }
  return null;
}

/**
 * EXPLICIT install/migration step. Creates the store for exactly this domain and refuses an existing one (or one whose Linux marker,
 * intent or lock state exists) and any legacy file still holding records. Never called by the Host.
 * options: { domain, backend?, platform?, exclusion?, fsImpl?, storage?, legacy?: [files], flockPath? }
 */
export async function initializeOperatorEffects(file, { domain, backend, platform = process.platform, exclusion = WINDOWS_EXCLUSION, fsImpl = fs, storage, legacy = [], flockPath } = {}) {
  if (!path.isAbsolute(String(file))) throw fail("operator-effects store needs an absolute path", "BadPath");
  const d = normalizeDomain(domain), b = backendOf({ backend, platform });
  const why = legacyRefusal(legacy, fsImpl);
  if (why) throw fail(`${why}: settle or migrate them explicitly first; nothing initialized`, "LegacyObligations");
  const empty = { schema: STATE_SCHEMA, domain: { ...d }, seq: 0, records: {} };
  if (b === "windows-owned-log") {
    initializeOwnedLog(file, { purpose: OPERATOR_EFFECTS_PURPOSE, fsImpl });   // wx: refuses an existing file
    await windowsStorage(file, storage, platform);
    const log = openOwnedLog(file, { purpose: OPERATOR_EFFECTS_PURPOSE, exclusion, fsImpl, platform });
    try {
      if (log.failed() || log.ambiguous()) throw Error(`new operator-effects log not usable: ${log.failed() || "torn"}`);
      log.append("operator-effects-established", { schema: STATE_SCHEMA, domain: { ...d } });
    } finally { log.release(); }
    return { backend: b, file, domain: d };
  }
  for (const p of [file, `${file}.established`, `${file}.intent`, `${file}.commit`, `${file}.history`])
    if (fsImpl.existsSync(p)) throw fail(`operator-effects store already exists or left evidence (${p}): not re-initialized`, "AlreadyEstablished");
  const owner = await openOwnedLock(file, { flockPath });
  const h = openDurableState(file, { format: STATE_SCHEMA, validate: (j) => validateState(j, d), empty, fsImpl, established: false, owner });
  try { if (h.failed()) throw Error(h.failed()); void h.state; }
  finally { await h.release("operator-effects initialized"); }
  return { backend: b, file, domain: d };
}

/**
 * Normal open of an ESTABLISHED store by its one physical owner. Refuses (throws) absent/foreign/torn/uncertain/malformed stores and a
 * second owner. -> Promise<store> (see the object returned at the end).
 */
export async function openOperatorEffects(file, { domain, backend, platform = process.platform, exclusion = WINDOWS_EXCLUSION, fsImpl = fs, storage, flockPath, timeoutMs } = {}) {
  if (!path.isAbsolute(String(file))) throw fail("operator-effects store needs an absolute path", "BadPath");
  const d = normalizeDomain(domain), b = backendOf({ backend, platform });
  let records = {}, seq = 0, size = 0, latched = null, released = false, io;
  if (b === "windows-owned-log") {
    await windowsStorage(file, storage, platform);
    let log;
    try { log = openOwnedLog(file, { purpose: OPERATOR_EFFECTS_PURPOSE, exclusion, fsImpl, platform }); }
    catch (e) { throw fail(`operator-effects store unavailable: ${e.message}`, e.code === "JOURNAL_OWNED" ? "OwnedElsewhere" : "StoreUnavailable"); }
    try {
      if (log.failed()) throw Error(log.failed());
      if (log.ambiguous() || log.quarantined()) throw Error("log torn or quarantined: obligations unknown until explicit owner reconciliation");
      let established = false;
      for (const row of log.rows()) {
        size += Buffer.byteLength(JSON.stringify(row)) + 1;
        if (row.kind === "genesis" || row.kind === "open-verified") continue;
        if (row.kind === "operator-effects-established") {
          if (established) throw Error("established twice");
          if (row.data?.schema !== STATE_SCHEMA || row.data?.domain?.account !== d.account || row.data?.domain?.chainId !== d.chainId)
            throw Error(`log is established for ${row.data?.domain?.account} on chain ${row.data?.domain?.chainId}, not this operator domain`);
          established = true; continue;
        }
        if (row.kind !== "operator-effect" || !established) throw Error(`unexpected record ${row.kind}${established ? "" : " before establishment"}`);
        const ev = row.data;
        if (ev?.op === "put") { const p = recordProblem(ev.key, ev.record, d); if (p) throw Error(p); records[ev.key] = ev.record; }
        else if (ev?.op === "remove" && Object.hasOwn(records, ev.key) && isText(ev.outcome, 300)) delete records[ev.key];
        else throw Error("malformed operator-effect event");
        if (Object.keys(records).length > MAX_RECORDS) throw Error("replay exceeds the record bound");
        seq++;
      }
      if (!established) throw Error("log was never explicitly established for an operator domain");
    } catch (e) { log.release(); throw fail(`operator-effects store refused: ${e.message}`, "StoreRefused"); }
    // r2: the held handle (fstat) does not see the PATH being deleted or replaced; the path must still name the file we hold
    let opened = null;
    try { opened = fsImpl.statSync(file); } catch (e) { log.release(); throw fail(`operator-effects store refused: ${e.message}`, "StoreRefused"); }
    const samePath = () => {
      let st; try { st = fsImpl.statSync(file); } catch { throw Error("the established operator-effects log path is gone"); }
      if (opened.ino && st.ino && (st.ino !== opened.ino || st.dev !== opened.dev)) throw Error("the established operator-effects log path names another file");
    };
    io = {
      exclusion: log.exclusion,
      assertLive: () => { log.assertLive(); samePath(); if (log.ambiguous() || log.quarantined()) throw Error("log torn or quarantined"); },
      commit(ev, _next, { admission }) { const row = log.append("operator-effect", ev, { admission }); size += Buffer.byteLength(JSON.stringify(row)) + 1; },
      bytes: (_next, ev) => size + Buffer.byteLength(JSON.stringify(ev)) + 512,
      release: async () => { log.release(); return { released: true }; },
      failedReason: () => log.failed(),
    };
  } else {
    let owner;
    try { owner = await openOwnedLock(file, { flockPath, timeoutMs }); }
    catch (e) { throw fail(`operator-effects owner lock unavailable: ${e.message}`, /in use/.test(e.message) ? "OwnedElsewhere" : "StoreUnavailable"); }
    const empty = { schema: STATE_SCHEMA, domain: { ...d }, seq: 0, records: {} };
    const h = openDurableState(file, { format: STATE_SCHEMA, validate: (j) => validateState(j, d), empty, fsImpl, expectExisting: true, established: true, owner });
    try {
      if (h.failed()) throw Error(h.failed());
      if (!h.verification()) throw Error("owned boot verification did not run");
      const s = h.state; records = structuredClone(s.records); seq = s.seq; size = Buffer.byteLength(JSON.stringify(s));
    } catch (e) { await h.release("refused at open"); throw fail(`operator-effects store refused: ${e.message}`, "StoreRefused"); }
    io = {
      exclusion: "linux-flock",
      // r2: the primitive's ACTUAL continuity check (h.state -> check(): owner lock, durability latch, the state file is still the
      // one we last wrote, the established marker is present). Any loss latches there; h.assertLive alone was lock-only.
      assertLive: () => { void h.state; if (h.failed()) throw Error(h.failed()); },
      commit(_ev, next) { h.store(next); size = Buffer.byteLength(JSON.stringify(next)); },
      bytes: (next) => Buffer.byteLength(JSON.stringify(next)),
      release: (why) => h.release(why),
      failedReason: () => h.failed(),
    };
  }
  const production = io.exclusion === "windows-exlock" || io.exclusion === "linux-flock";
  const latch = (why) => { latched ??= why; return fail(`operator-effects store failed: ${latched}`, "OperatorEffectsUncertain", { uncertain: true }); };
  function live() {
    if (released) throw fail("operator-effects owner released: no read or change without ownership", "OwnerReleased");
    if (latched) throw fail(`operator-effects store failed: ${latched}`, "OperatorEffectsUncertain", { uncertain: true });
    try { io.assertLive(); } catch (e) { throw latch(`ownership lost or storage failed: ${e.message}`); }
  }
  function change(ev, nextRecords, { admission = false, newRecord = false } = {}) {
    live();
    const open = Object.keys(records).length;
    if (newRecord && open >= MAX_RECORDS) throw fail(`operator-effects store is full (${MAX_RECORDS} unresolved obligations): no new effect until some settle`, "StoreFull");
    const next = { schema: STATE_SCHEMA, domain: { ...d }, seq: seq + 1, records: nextRecords };
    if (Buffer.byteLength(JSON.stringify(ev)) > MAX_RECORD_BYTES + 1024) throw fail("operator-effects event above its bound: refused", "StoreFull");
    const bytes = io.bytes(next, ev), reserve = (open + (newRecord ? 1 : 0)) * SETTLE_RESERVE;
    if (ev.op !== "remove" && bytes + reserve > (newRecord ? ADMISSION_BYTES : HARD_BYTES))
      throw fail("operator-effects store near capacity: no new admission or growth (settlement space is reserved; explicit maintenance required)", "StoreFull");
    try { io.commit(ev, next, { admission }); }
    catch (e) { throw latch(`write/flush outcome unknown (${e.message}): the record may or may not have landed`); }
    records = nextRecords; seq++;
  }
  return Object.freeze({
    backend: b, file: path.resolve(file), domain: d, exclusion: io.exclusion,
    /** every unresolved record (clones); proves the owner first */
    records() { live(); return Object.values(structuredClone(records)); },
    get(key) { live(); return Object.hasOwn(records, key) ? structuredClone(records[key]) : null; },
    /** durable before return; a NEW key needs admission space; any failure latches and throws */
    put(key, record) {
      const p = recordProblem(key, record, d);
      if (p) throw fail(`operator-effects record refused: ${p}`, "BadRecord");
      const newRecord = !Object.hasOwn(records, key);
      change({ op: "put", key, record: structuredClone(record), at: Date.now() }, { ...structuredClone(records), [key]: structuredClone(record) }, { admission: newRecord, newRecord });
    },
    /** settle exactly one record with its outcome (exact evidence only: receipt, nonce fence, deadline fence, provably unsent) */
    remove(key, outcome) {
      live();
      if (!Object.hasOwn(records, key)) throw fail(`no unresolved record ${key}`, "NoSuchRecord");
      const nextRecords = structuredClone(records); delete nextRecords[key];
      change({ op: "remove", key, outcome: String(outcome).slice(0, 300), at: Date.now() }, nextRecords);
    },
    assertLive: live,
    failed: () => latched ?? io.failedReason() ?? null,
    released: () => released,
    /** read-only diagnostics; never throws */
    status() {
      let ownership = "live";
      try { live(); } catch (e) { ownership = e.message; }
      return { backend: b, file: path.resolve(file), domain: { ...d }, exclusion: io.exclusion, production, ownership, unresolved: Object.keys(records).length,
        note: production ? (io.exclusion === "windows-exlock" ? "Windows EXLOCK cross-process and power-loss behaviour: root qualification pending" : "Linux flock owner") : "TEST exclusion: NOT production, NOT cross-process" };
    },
    /** ends ownership; on-disk records stay for the next owner. The caller fences new effects first. */
    async release(why = "operator-effects owner released") { if (released) return { released: true }; released = true; return io.release(why); },
  });
}
