// Node storage for a gas session that has no browser: the automatic refiller (sdk/funding-node/refill.mjs, cli/gas-refill.mjs).
//
// Same interface and rules as v2-store.mjs IndexedDbV2Store (saveKey/loadKey/listKeys, putJournal/getJournal/listJournal,
// casJournal), with one deliberate difference: a daemon must survive a restart, so the session key's PKCS#8 bytes are
// kept on disk in their own 0600 file (keys/<keyHash>.pkcs8, written once by newKey, never rewritten or journaled).
// Every load re-imports them as a NON-extractable CryptoKey, so records in memory pass validateGasRecord and signerFor
// exactly as browser records do, and a record file never holds key bytes. What this key can spend is bounded on chain
// by its grant (budget, per-period spend and ops, per-op gas/fee/price caps, expiry); the owner can end it at any time.
//
// casJournal is atomic per store directory: an exclusive lock file (O_EXCL) is held across read-mutate-write, and every
// write is tmp + fsync + rename, so a crash leaves the old or the new entry, never a torn one.
import fs from "node:fs";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { bytesToHex } from "viem";
import { keyHashOf } from "../funding/funding-codec.mjs";
import { assertPublic, canon, fail } from "../funding/util.mjs";
import { gasRecordId, validateGasRecord } from "../funding/v2-store.mjs";

const ALG = { name: "ECDSA", namedCurve: "P-256" };
const HASH = /^0x[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9:_-]{1,200}$/;
const LOCK_WAIT_MS = 10_000;

const fileOf = (id) => {
  if (!SAFE_ID.test(String(id))) fail("store_id", `unsafe store id ${String(id).slice(0, 80)}`);
  return `${String(id).replace(/:/g, "_")}.json`;
};

function writeAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w", mode);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dfd = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
}

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);

export class FileV2Store {
  constructor(dir, { subtle = webcrypto.subtle } = {}) {
    if (typeof dir !== "string" || !dir) fail("store_dir", "a store directory is required");
    this.dir = path.resolve(dir);
    this.subtle = subtle;
    for (const d of [this.dir, path.join(this.dir, "keys"), path.join(this.dir, "journal")]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    for (const d of [this.dir, path.join(this.dir, "keys")]) {
      const m = fs.statSync(d).mode & 0o077;
      if (m) fail("store_permissions", `${d} is readable by others (mode ${(fs.statSync(d).mode & 0o777).toString(8)}); chmod 700 it`);
    }
  }

  #secretFile(keyHash) {
    if (!HASH.test(keyHash)) fail("key_hash", "bad key hash");
    return path.join(this.dir, "keys", `${keyHash.slice(2)}.pkcs8`);
  }

  async #import(keyHash) {
    const f = this.#secretFile(keyHash);
    const st = fs.statSync(f);
    if (st.mode & 0o077) fail("key_permissions", `${f} is readable by others; refusing to use it`);
    return this.subtle.importKey("pkcs8", fs.readFileSync(f), ALG, false, ["sign"]);
  }

  /** A fresh P-256 session key: its PKCS#8 goes to its own 0600 file once; the caller gets a non-extractable key. */
  async newKey() {
    const kp = await this.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const raw = new Uint8Array(await this.subtle.exportKey("raw", kp.publicKey));
    if (raw.length !== 65 || raw[0] !== 4) fail("key_encoding", "unexpected P-256 public key encoding");
    const x = BigInt(bytesToHex(raw.slice(1, 33))), y = BigInt(bytesToHex(raw.slice(33, 65)));
    const keyHash = keyHashOf(x, y);
    const f = this.#secretFile(keyHash);
    const fd = fs.openSync(f, "wx", 0o600);
    try { fs.writeSync(fd, new Uint8Array(await this.subtle.exportKey("pkcs8", kp.privateKey))); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return Object.freeze({ privateKey: await this.#import(keyHash), x, y, keyHash });
  }

  async saveKey(rec) {
    validateGasRecord(rec);
    if (!fs.existsSync(this.#secretFile(rec.keyHash))) fail("key_missing", "a record is saved only for a key this store created");
    const prior = await this.loadKey(rec.id);
    if (prior && prior.keyHash !== rec.keyHash) fail("record_key_changed", "a record id never changes its key");
    const { privateKey: _secret, ...pub } = rec;
    assertPublic(pub);
    writeAtomic(path.join(this.dir, "keys", fileOf(rec.id)), canon(pub));
  }

  async loadKey(id) {
    const pub = readJson(path.join(this.dir, "keys", fileOf(id)));
    if (!pub) return null;
    if (pub.id !== gasRecordId(pub.keyHash)) fail("record_id", "record id is not derived from its key hash");
    return validateGasRecord({ ...pub, privateKey: await this.#import(pub.keyHash) });
  }

  async listKeys() {
    const names = fs.readdirSync(path.join(this.dir, "keys")).filter((n) => n.endsWith(".json"));
    return Promise.all(names.map((n) => this.loadKey(n.slice(0, -5))));
  }

  async putJournal(e) { await this.casJournal(e?.id, () => e); }
  async getJournal(id) { return readJson(path.join(this.dir, "journal", fileOf(id))); }
  async listJournal() {
    return fs.readdirSync(path.join(this.dir, "journal")).filter((n) => n.endsWith(".json"))
      .map((n) => readJson(path.join(this.dir, "journal", n)));
  }

  /** Atomic read-modify-write; `mutate(current|null)` is synchronous and returns the next entry or throws (nothing written). */
  async casJournal(id, mutate) {
    const file = path.join(this.dir, "journal", fileOf(id));
    const release = await this.#lock();
    try {
      const cur = readJson(file);
      const next = mutate(cur ? JSON.parse(JSON.stringify(cur)) : null);
      if (!next || next.id !== id) fail("cas_shape", "mutate must return the entry with the same id");
      assertPublic(next);
      const text = canon(next);
      writeAtomic(file, text);
      return JSON.parse(text);
    } finally { release(); }
  }

  async #lock() {
    const f = path.join(this.dir, "journal.lock");
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(f, "wx", 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return () => fs.rmSync(f, { force: true });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (Date.now() > until) fail("store_locked", `${f} is held (another refiller, or a crash left it: check no refiller runs, then remove it)`);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
}
