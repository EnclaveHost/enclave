/** @enclavehost/sessions - one session system for browser sign-in and agents.
 *
 *  Key holder (browser tab or agent):   newSessionKey -> buildGrant -> (owner signs) ->
 *                                       Session.call / Session.terminate / Session.apiAuthorization
 *  Owner (wallet):                      openSession, ownerOperation, topUpFromWallet
 *
 *  Design: docs/design/sessions.md. */
export * from "./constants.js";
export * from "./typed.js";
export * from "./args.js";
export * from "./keys.js";
export * from "./grant.js";
export * from "./client.js";
export * from "./store.js";
export * from "./abi.js";
export * from "./attest.js";

import type { Address, Hex } from "viem";
import { exportPrivateKey, generateKeyPair, publicKeyXY, signerFromKeyPair, type SessionSigner } from "./keys.js";
import { pendingId, type KeyStore, type StoredSession } from "./store.js";
import { sessionIdOf, type Grant } from "./typed.js";

/** Make a fresh session key and park it in `store` as pending. `extractable`
 *  only for file/env storage (agents); browsers keep it non-extractable. */
export async function newSessionKey(store: KeyStore, p: { relay: string; chainId: number; label: string;
  extractable: boolean }): Promise<{ signer: SessionSigner; record: StoredSession }> {
  const kp = await generateKeyPair(p.extractable);
  const signer = await signerFromKeyPair(kp);
  const { x, y } = await publicKeyXY(kp.publicKey);
  const record: StoredSession = {
    v: 1, id: pendingId(signer.keyHash), relay: p.relay, chainId: p.chainId, x: x.toString(), y: y.toString(),
    keyHash: signer.keyHash, label: p.label, createdAt: Math.floor(Date.now() / 1000),
    ...(p.extractable ? { pkcs8: await exportPrivateKey(kp.privateKey) } : { privateKey: kp.privateKey }),
  };
  await store.save(record);
  return { signer, record };
}

/** Promote a pending record to an open session once the grant has landed. */
export async function completeSession(store: KeyStore, record: StoredSession, p: { vault: Address; owner: Address;
  grant: Grant; rpc?: string }): Promise<StoredSession> {
  const sid: Hex = sessionIdOf(p.vault, p.grant.sessionKey, p.grant.grantNonce);
  const open: StoredSession = {
    ...record, id: sid, grant: p.grant,
    handle: { chainId: record.chainId, vault: p.vault, sid, owner: p.owner, label: record.label, relay: record.relay, rpc: p.rpc },
  };
  await store.save(open);
  if (record.id !== sid) await store.remove(record.id);
  return open;
}
