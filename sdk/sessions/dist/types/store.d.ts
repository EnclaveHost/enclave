import type { Hex } from "viem";
import { Session, type SessionHandle } from "./client.js";
import type { Grant } from "./typed.js";
/** One stored session key. `privateKey` is a live non-extractable CryptoKey in
 *  browsers; `pkcs8` is set only for file/env storage (agents). */
export interface StoredSession {
    v: 1;
    id: string;
    handle?: SessionHandle;
    relay: string;
    chainId: number;
    x: string;
    y: string;
    keyHash: Hex;
    label: string;
    grant?: Grant;
    createdAt: number;
    privateKey?: CryptoKey;
    pkcs8?: string;
}
export interface KeyStore {
    save(rec: StoredSession): Promise<void>;
    load(id: string): Promise<StoredSession | null>;
    list(): Promise<StoredSession[]>;
    remove(id: string): Promise<void>;
}
export declare class MemoryStore implements KeyStore {
    private m;
    save(r: StoredSession): Promise<void>;
    load(id: string): Promise<StoredSession | null>;
    list(): Promise<StoredSession[]>;
    remove(id: string): Promise<void>;
}
export declare const pendingId: (keyHash: Hex) => string;
/** Re-hydrate a usable Session from a stored record. */
export declare function sessionFromRecord(rec: StoredSession, opts?: {
    fetch?: typeof fetch;
}): Promise<Session>;
