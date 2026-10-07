import type { Hex } from "viem";
import { Session, type SessionHandle } from "./client.js";
import type { Grant } from "./typed.js";
import { importPrivateKey, signerFromKeys } from "./keys.js";

/** One stored session key. `privateKey` is a live non-extractable CryptoKey in
 *  browsers; `pkcs8` is set only for file/env storage (agents). */
export interface StoredSession {
  v: 1;
  id: string;                 // sid once open; "pending-<keyHash>" before
  handle?: SessionHandle;     // set once the session is open
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

export class MemoryStore implements KeyStore {
  private m = new Map<string, StoredSession>();
  async save(r: StoredSession) { this.m.set(r.id, r); }
  async load(id: string) { return this.m.get(id) ?? null; }
  async list() { return [...this.m.values()]; }
  async remove(id: string) { this.m.delete(id); }
}

export const pendingId = (keyHash: Hex) => `pending-${keyHash.slice(2, 18)}`;

/** Re-hydrate a usable Session from a stored record. */
export async function sessionFromRecord(rec: StoredSession, opts: { fetch?: typeof fetch } = {}): Promise<Session> {
  if (!rec.handle) throw new Error(`session ${rec.id} is not open yet`);
  const key = rec.privateKey ?? (rec.pkcs8 ? await importPrivateKey(rec.pkcs8) : undefined);
  if (!key) throw new Error(`session ${rec.id} has no private key`);
  const signer = await signerFromKeys(key, BigInt(rec.x), BigInt(rec.y));
  if (signer.keyHash !== rec.keyHash) throw new Error("stored key does not match its key hash");
  return new Session(rec.handle, signer, opts);
}
