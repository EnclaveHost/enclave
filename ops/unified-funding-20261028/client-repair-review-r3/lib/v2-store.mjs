// UNREVIEWED SOURCE (unified-funding client-repair-r2). Storage and key handling for SUCCESSOR (domain "2") gas
// sessions, kept apart from the original SDK on purpose:
//   - its own IndexedDB database ("enclave-funding-v2"), never the SDK's "enclave-sessions", so IndexedDbStore.list(),
//     currentSession() and sessionFromRecord() can never pick a successor key up and sign domain-1 data with it;
//   - records are { v: 2, kind, domainVersion: "2" } and carry NO `handle` (sessionFromRecord refuses a record without one);
//   - the private key is a fresh NON-extractable WebCrypto P-256 CryptoKey; no export path exists in this module.
// The legacy (domain "1") key is never touched here: the migration reuses it inside the SDK store by reference.
// casJournal(id, mutate) is the one admission primitive: get + mutate + put inside ONE readwrite transaction, so two tabs
// on this origin are serialised by IndexedDB and only one can move a step out of "planned".
import { bytesToHex, hexToBytes } from "../../../source/node_modules/viem/_esm/index.js";
import { keyHashOf, DOMAIN_VERSION } from "../../client-r1/funding-codec.mjs";
import { fail, assertPublic, canon } from "./util.mjs";

export const V2_DB = "enclave-funding-v2";
export const V2_DB_VERSION = 1;
export const KEYS = "gas-keys";
export const JOURNAL = "journal";
export const RECORD_KIND = "enclave-funding-gas-session";
export const RECORD_VERSION = 2;
export const LEGACY_DB = "enclave-sessions";      // the SDK's database: named only so tests can assert we never use it

const ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };

function subtleOf(subtle) {
  const s = subtle ?? globalThis.crypto?.subtle;
  if (!s) fail("webcrypto_missing", "WebCrypto is not available");
  return s;
}

/** A fresh non-extractable P-256 key. Only the PUBLIC half is exported (raw point -> x, y). */
export async function newGasKey(subtle) {
  const s = subtleOf(subtle);
  const kp = await s.generateKey(ALG, false, ["sign", "verify"]);
  if (!kp?.privateKey || kp.privateKey.extractable !== false) fail("key_extractable", "the session key must be non-extractable");
  const raw = new Uint8Array(await s.exportKey("raw", kp.publicKey));
  if (raw.length !== 65 || raw[0] !== 4) fail("key_encoding", "unexpected P-256 public key encoding");
  const x = BigInt(bytesToHex(raw.slice(1, 33)));
  const y = BigInt(bytesToHex(raw.slice(33, 65)));
  return Object.freeze({ privateKey: kp.privateKey, x, y, keyHash: keyHashOf(x, y) });
}

/** Same signing semantics as sdk/sessions/src/keys.ts: WebCrypto ECDSA-SHA256 over the 32 digest bytes, i.e. P-256 over
 *  sha256(eip712Digest), which is what the vault verifies. */
export function signerFor(privateKey, x, y, subtle) {
  const s = subtleOf(subtle);
  if (!privateKey || privateKey.extractable !== false) fail("key_extractable", "refusing to sign with an extractable key");
  const keyHash = keyHashOf(x, y);
  return Object.freeze({
    x: BigInt(x), y: BigInt(y), keyHash,
    async signDigest(digest) {
      if (typeof digest !== "string" || !/^0x[0-9a-f]{64}$/.test(digest)) fail("digest_format", "digest must be lowercase 0x + 64 hex");
      const sig = new Uint8Array(await s.sign(SIGN, privateKey, hexToBytes(digest)));
      if (sig.length !== 64) fail("signature_format", "expected a 64-byte P1363 signature");
      return { r: bytesToHex(sig.slice(0, 32)), s: bytesToHex(sig.slice(32, 64)) };
    },
  });
}

export const gasRecordId = (keyHash) => `gas-${keyHash.slice(2)}`;

/** A new, not-yet-granted record. Status: reviewed -> submitted -> open -> ended (records are never deleted). */
export function newGasRecord({ key, chainId, relay, owner, vault, factory, implementation, label, now }) {
  return {
    v: RECORD_VERSION, kind: RECORD_KIND, domainVersion: DOMAIN_VERSION, id: gasRecordId(key.keyHash), status: "new",
    chainId: Number(chainId), relay: String(relay), owner, vault, factory, implementation, label: String(label),
    x: key.x.toString(), y: key.y.toString(), keyHash: key.keyHash, privateKey: key.privateKey,
    grant: null, grantDigest: null, sid: null, open: null, createdAt: Number(now),
  };
}

export function validateGasRecord(rec) {
  if (!rec || typeof rec !== "object") fail("record_type", "record must be an object");
  if (rec.v !== RECORD_VERSION || rec.kind !== RECORD_KIND || rec.domainVersion !== DOMAIN_VERSION) {
    fail("record_version", "not a version-2 successor gas record");
  }
  if ("handle" in rec) fail("record_shape", "a successor record must not carry a v1 `handle`");
  if ("pkcs8" in rec) fail("record_secret", "successor records never hold exportable key bytes");
  if (!rec.privateKey || rec.privateKey.extractable !== false) fail("key_extractable", "successor keys must be non-extractable CryptoKeys");
  if (keyHashOf(BigInt(rec.x), BigInt(rec.y)) !== rec.keyHash) fail("key_hash_mismatch", "stored public key does not match its key hash");
  if (rec.id !== gasRecordId(rec.keyHash)) fail("record_id", "record id is not derived from its key hash");
  if (rec.grant !== null) canon(rec.grant);          // grant is stored as plain JSON (decimal strings)
  return rec;
}

const checkJournal = (e) => { assertPublic(e); canon(e); return e; };

/** Browser storage (IndexedDB; structured clone keeps the CryptoKey usable, never readable). */
export class IndexedDbV2Store {
  constructor(name = V2_DB, idb = globalThis.indexedDB) {
    if (!idb) fail("indexeddb_missing", "IndexedDB is not available");
    if (name === LEGACY_DB) fail("store_collision", "the successor store must not share the SDK's database");
    this.name = name;
    this.idb = idb;
  }
  _db() {
    return new Promise((ok, bad) => {
      const r = this.idb.open(this.name, V2_DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(JOURNAL)) db.createObjectStore(JOURNAL, { keyPath: "id" });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error);
    });
  }
  async _tx(store, mode, f) {
    const db = await this._db();
    return new Promise((ok, bad) => {
      const t = db.transaction(store, mode);
      const req = f(t.objectStore(store));
      t.oncomplete = () => { db.close(); ok(req.result); };
      t.onerror = () => { db.close(); bad(t.error); };
      t.onabort = () => { db.close(); bad(t.error ?? new Error("transaction aborted")); };
    });
  }
  async saveKey(rec) {
    validateGasRecord(rec);
    const prior = await this.loadKey(rec.id);
    if (prior && prior.keyHash !== rec.keyHash) fail("record_key_changed", "a record id never changes its key");
    await this._tx(KEYS, "readwrite", (s) => s.put(rec));
  }
  async loadKey(id) { return (await this._tx(KEYS, "readonly", (s) => s.get(id))) ?? null; }
  async listKeys() { return this._tx(KEYS, "readonly", (s) => s.getAll()); }
  async putJournal(e) { checkJournal(e); await this._tx(JOURNAL, "readwrite", (s) => s.put(e)); }
  async getJournal(id) { return (await this._tx(JOURNAL, "readonly", (s) => s.get(id))) ?? null; }
  async listJournal() { return this._tx(JOURNAL, "readonly", (s) => s.getAll()); }
  /** Atomic read-modify-write. `mutate(current|null)` is SYNCHRONOUS and returns the next entry or throws (abort). */
  async casJournal(id, mutate) {
    const db = await this._db();
    return new Promise((ok, bad) => {
      const t = db.transaction(JOURNAL, "readwrite");
      const st = t.objectStore(JOURNAL);
      let next, err;
      const req = st.get(id);
      req.onsuccess = () => {
        try {
          next = mutate(req.result ? structuredClone(req.result) : null);
          if (!next || next.id !== id) fail("cas_shape", "mutate must return the entry with the same id");
          checkJournal(next);
          st.put(next);
        } catch (e) { err = e; t.abort(); }
      };
      t.oncomplete = () => { db.close(); ok(next); };
      t.onabort = () => { db.close(); bad(err ?? t.error ?? new Error("transaction aborted")); };
    });
  }
}

/** TESTS ONLY: an in-memory stand-in. It keeps object references (no structured clone), so it proves call order and
 *  record contents, not IndexedDB persistence. casJournal is atomic because it never awaits between read and write. */
export class MemoryV2Store {
  constructor() { this.keys = new Map(); this.journal = new Map(); }
  async saveKey(rec) {
    validateGasRecord(rec);
    const prior = this.keys.get(rec.id);
    if (prior && prior.keyHash !== rec.keyHash) fail("record_key_changed", "a record id never changes its key");
    this.keys.set(rec.id, { ...rec });
  }
  async loadKey(id) { const r = this.keys.get(id); return r ? { ...r } : null; }
  async listKeys() { return [...this.keys.values()].map((r) => ({ ...r })); }
  async putJournal(e) { checkJournal(e); this.journal.set(e.id, JSON.parse(canon(e))); }
  async getJournal(id) { const e = this.journal.get(id); return e ? JSON.parse(JSON.stringify(e)) : null; }
  async listJournal() { return [...this.journal.values()].map((e) => JSON.parse(JSON.stringify(e))); }
  async casJournal(id, mutate) {
    const cur = this.journal.get(id);
    const next = mutate(cur ? JSON.parse(JSON.stringify(cur)) : null);
    if (!next || next.id !== id) fail("cas_shape", "mutate must return the entry with the same id");
    checkJournal(next);
    this.journal.set(id, JSON.parse(canon(next)));
    return JSON.parse(canon(next));
  }
}
