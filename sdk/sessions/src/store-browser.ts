import type { KeyStore, StoredSession } from "./store.js";

/** Browser key storage: IndexedDB holding a NON-extractable CryptoKey (structured
 *  clone keeps it usable across reloads; no script can ever read its bytes). */
export class IndexedDbStore implements KeyStore {
  constructor(private readonly dbName = "enclave-sessions") {}

  private db(): Promise<IDBDatabase> {
    return new Promise((ok, bad) => {
      const r = indexedDB.open(this.dbName, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("keys", { keyPath: "id" }); };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error);
    });
  }

  private async tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db();
    return new Promise((ok, bad) => {
      const t = db.transaction("keys", mode);
      const req = f(t.objectStore("keys"));
      t.oncomplete = () => { db.close(); ok(req.result); };
      t.onerror = () => { db.close(); bad(t.error); };
    });
  }

  async save(rec: StoredSession) {
    if (rec.pkcs8) throw new Error("browser sessions never store exportable key bytes");
    if (rec.privateKey?.extractable) throw new Error("browser session keys must be non-extractable");
    await this.tx("readwrite", (s) => s.put(rec));
  }
  async load(id: string) { return (await this.tx<StoredSession | undefined>("readonly", (s) => s.get(id))) ?? null; }
  async list() { return this.tx<StoredSession[]>("readonly", (s) => s.getAll()); }
  async remove(id: string) { await this.tx("readwrite", (s) => s.delete(id)); }
}
