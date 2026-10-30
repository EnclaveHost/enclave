/* ============================================================
   Wallet release journal: one durable record per exact identity
   (chain, ledger, vault, deployment, owner), in IndexedDB. Every write
   is ONE readwrite transaction that reads, compares and writes (CAS);
   a write counts only once the transaction COMPLETES. An abort, a quota
   error or no IndexedDB at all rejects - the controller then stops at
   the last proven durable boundary (no signing, no dispatch).

   States:  intent -> signed -> dispatching -> submitted -> included -> finalized
            intent|signed -> cancelled   (never dispatched: durable evidence)
            dispatching -> uncertain     (sent or maybe sent: never restarted)
            dispatching|uncertain|submitted|included -> conflict
   The signature itself is never stored; only its keccak (sigHash).
   ============================================================ */

export const JOURNAL_SCHEMA = 1;
export const DB_NAME = "enclave-wallet-release";
const STORE = "journal";
const MAX_RECORD_BYTES = 16384;

export const NEXT = Object.freeze({
  intent: ["signed", "cancelled"],
  signed: ["dispatching", "cancelled"],
  dispatching: ["submitted", "uncertain", "included", "finalized", "conflict"],
  uncertain: ["submitted", "included", "finalized", "conflict"],
  submitted: ["included", "finalized", "conflict"],
  included: ["finalized", "conflict", "submitted"],      // back to submitted when a reorg drops the inclusion
  finalized: [],
  conflict: [],
  cancelled: [],
});
export const PRE_DISPATCH = new Set(["intent", "signed"]);
export const IN_FLIGHT = new Set(["dispatching", "uncertain", "submitted", "included"]);

const lower = (a) => String(a || "").toLowerCase();
export function journalKey({ chainId, ledger, vault, deployment, owner }){
  const k = ["wr" + JOURNAL_SCHEMA, Number(chainId), lower(ledger), lower(vault), lower(deployment), lower(owner)];
  if (!(k[1] > 0) || !/^0x[0-9a-f]{40}$/.test(k[2]) || !/^0x[0-9a-f]{40}$/.test(k[3]) || !/^0x[0-9a-f]{64}$/.test(k[4]) || !/^0x[0-9a-f]{40}$/.test(k[5]))
    throw new Error("journal: malformed identity");
  return k.join(":");
}

/* Promote records live in the SAME object store (no IndexedDB version change; schema-1 Release records are never
   rewritten). Their own key prefix keeps the two kinds from colliding; the owner nonce is NOT namespaced by kind. */
export const PROMOTE_KIND = "promote";
export function promoteKey(identity){ return "wp" + JOURNAL_SCHEMA + journalKey(identity).slice(("wr" + JOURNAL_SCHEMA).length); }
const keyOf = (r) => r && r.kind === PROMOTE_KIND ? promoteKey(r.identity) : journalKey(r.identity);
/** Only these outcomes free the vault owner's nonce fence; everything else (incl. conflict) stays reserved. */
export const RESOLVED = new Set(["cancelled", "finalized"]);
/** Key ranges holding every record (both kinds) of one chain + ledger + vault; the owner is filtered from identity. */
export function vaultRanges(identity){
  const parts = journalKey(identity).split(":").slice(1, 4).join(":") + ":";
  return ["wr" + JOURNAL_SCHEMA + ":" + parts, "wp" + JOURNAL_SCHEMA + ":" + parts];
}
/** The shared owner-nonce fence, evaluated on rows read in the SAME transaction that writes `rec`:
 *  - no record of any kind, deployment or state may already carry rec.nonce (one ownerNonceUsed mapping);
 *  - a Promote may not start while any Release or Promote of this vault owner is unresolved;
 *  - a Release may not start while any Promote of this vault owner is unresolved (Release-vs-Release unchanged). */
export function fenceConflict(rows, rec){
  const owner = lower(rec.identity.owner), promote = rec.kind === PROMOTE_KIND;
  for (const r of rows){
    if (!r || !r.identity || lower(r.identity.owner) !== owner || r.key === rec.key) continue;
    if (r.nonce && lower(r.nonce) === lower(rec.nonce)) return "This owner nonce is already recorded for another operation (" + (r.kind || "release") + ", " + r.state + ").";
    if (RESOLVED.has(r.state)) continue;
    if (r.kind === PROMOTE_KIND) return "A promotion signed by this owner is unresolved (" + r.state + "); no other owner operation starts until the chain settles it.";
    if (promote) return "A release signed by this owner is unresolved (" + r.state + "); no promotion starts until the chain settles it.";
  }
  return null;
}

export class JournalError extends Error {
  constructor(code, message){ super(message); this.code = code; }
}

/** Bounded shape: no signature field, known states, bounded size. */
export function validateRecord(r){
  if (!r || r.schema !== JOURNAL_SCHEMA || typeof r.key !== "string" || !(r.state in NEXT) || !Number.isInteger(r.rev)) throw new JournalError("shape", "journal: bad record");
  if ("sig" in r || "signature" in r) throw new JournalError("shape", "journal: a signature never goes in the journal");
  if (r.kind !== undefined && r.kind !== PROMOTE_KIND) throw new JournalError("shape", "journal: unknown operation kind");
  if (r.key !== keyOf(r)) throw new JournalError("shape", "journal: key does not match identity");
  if (JSON.stringify(r).length > MAX_RECORD_BYTES) throw new JournalError("quota", "journal: record too large");
  return r;
}

/** The transition rule shared by both stores: expected state + rev (+ writer for pre-dispatch moves). */
function applyCas(cur, key, expect, patch, now){
  if (!cur) throw new JournalError("missing", "journal: no record " + key);
  if (cur.state !== expect.state || cur.rev !== expect.rev) throw new JournalError("cas", "journal: changed elsewhere (" + cur.state + "@" + cur.rev + ")");
  if (PRE_DISPATCH.has(cur.state) && patch.state !== "cancelled" && cur.writer !== expect.writer) throw new JournalError("writer", "journal: another tab owns this operation");
  if (patch.state && patch.state !== cur.state && !NEXT[cur.state].includes(patch.state)) throw new JournalError("transition", "journal: " + cur.state + " -> " + patch.state + " not allowed");
  const { key: _k, identity: _i, nonce: _n, deadline: _d, typed: _t, writer: _w, ...rest } = patch;   // the operation's identity is immutable
  return validateRecord({ ...cur, ...rest, rev: cur.rev + 1, updatedAt: now });
}
const replaceable = (cur, replaceRev) => cur && cur.state === "cancelled" && replaceRev === cur.rev;

/* ---- IndexedDB (production) --------------------------------------------------------------------------------------- */
export class IdbJournal {
  constructor(idb = globalThis.indexedDB, name = DB_NAME){ this.idb = idb; this.name = name; this._db = null; }
  async _open(){
    if (this._db) return this._db;
    if (!this.idb) throw new JournalError("unavailable", "This browser has no durable storage (IndexedDB) for the release journal.");
    this._db = await new Promise((res, rej) => {
      const q = this.idb.open(this.name, JOURNAL_SCHEMA);
      q.onupgradeneeded = () => { if (!q.result.objectStoreNames.contains(STORE)) q.result.createObjectStore(STORE, { keyPath: "key" }); };
      q.onsuccess = () => { q.result.onversionchange = () => { q.result.close(); this._db = null; }; res(q.result); };
      q.onerror = () => rej(new JournalError("unavailable", "Could not open the release journal: " + (q.error && q.error.message)));
      q.onblocked = () => rej(new JournalError("unavailable", "The release journal is blocked by another tab."));
    });
    return this._db;
  }
  /** One readwrite transaction: `step(current) -> next | undefined`; resolves with next only after `complete`. */
  async _tx(key, step){
    const db = await this._open();
    return new Promise((res, rej) => {
      let t, out, err = null;
      try { t = db.transaction(STORE, "readwrite", { durability: "strict" }); } catch(e){ return rej(new JournalError("unavailable", String(e && e.message || e))); }
      const os = t.objectStore(STORE);
      const g = os.get(key);
      g.onsuccess = () => {
        try { out = step(g.result || null); if (out) os.put(out); }
        catch(e){ err = e; t.abort(); }
      };
      t.oncomplete = () => res(out === undefined ? null : out);
      t.onabort = () => rej(err || new JournalError(t.error && t.error.name === "QuotaExceededError" ? "quota" : "abort", "Release journal write failed: " + (t.error && t.error.message || "aborted")));
      t.onerror = () => {};   // reported through onabort
    });
  }
  async get(key){
    const db = await this._open();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, "readonly"), g = t.objectStore(STORE).get(key);
      g.onsuccess = () => res(g.result || null);
      t.onabort = () => rej(new JournalError("abort", "Could not read the release journal."));
    });
  }
  /** Put-if-absent (or replace a CANCELLED record at exactly `replaceRev`). Throws "exists" otherwise. */
  putIfAbsent(rec, { replaceRev } = {}){
    validateRecord(rec);
    return this._tx(rec.key, (cur) => {
      if (cur && !replaceable(cur, replaceRev)) throw new JournalError("exists", "A release for this deployment is already recorded (" + cur.state + ").");
      return rec;
    });
  }
  cas(key, expect, patch){ return this._tx(key, (cur) => applyCas(cur, key, expect, patch, Date.now())); }
}

/* ---- MOCK, NOT DURABLE: an in-memory stand-in with fault injection, for node:test only ----------------------------
   `faults[op]` (op: "putIfAbsent" | "cas:<toState>" | "get") = an Error thrown INSTEAD of writing. Two controllers
   sharing one MemoryJournal model two tabs sharing one database; it says nothing about real browser IndexedDB. */
export class MemoryJournal {
  constructor(){ this.rows = new Map(); this.faults = {}; this.log = []; }
  _fault(op){ const f = this.faults[op]; if (f){ this.log.push("fault:" + op); throw f; } }
  async get(key){ this._fault("get"); const r = this.rows.get(key); return r ? structuredClone(r) : null; }
  async putIfAbsent(rec, { replaceRev } = {}){
    await null; this._fault("putIfAbsent"); validateRecord(rec);
    const cur = this.rows.get(rec.key);
    if (cur && !replaceable(cur, replaceRev)) throw new JournalError("exists", "A release for this deployment is already recorded (" + cur.state + ").");
    this.rows.set(rec.key, structuredClone(rec)); this.log.push("put:" + rec.state);
    return structuredClone(rec);
  }
  async cas(key, expect, patch){
    await null; this._fault("cas:" + (patch.state || "same"));
    const next = applyCas(this.rows.get(key) || null, key, expect, patch, Date.now());
    this.rows.set(key, structuredClone(next)); this.log.push("cas:" + next.state);
    return structuredClone(next);
  }
}
