import type { KeyStore, StoredSession } from "./store.js";
/** Browser key storage: IndexedDB holding a NON-extractable CryptoKey (structured
 *  clone keeps it usable across reloads; no script can ever read its bytes). */
export declare class IndexedDbStore implements KeyStore {
    private readonly dbName;
    constructor(dbName?: string);
    private db;
    private tx;
    save(rec: StoredSession): Promise<void>;
    load(id: string): Promise<StoredSession | null>;
    list(): Promise<StoredSession[]>;
    remove(id: string): Promise<void>;
}
