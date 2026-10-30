/** @enclavehost/sessions - one session system for browser sign-in and agents.
 *
 *  Key holder (browser tab or agent):   newSessionKey -> buildGrant -> (owner signs) ->
 *                                       Session.call / Session.terminate / Session.apiAuthorization
 *  Owner (wallet):                      openSession, ownerOperation, topUpFromWallet,
 *                                       setDelegateCall / delegationStatus (sessions on wallet-held records)
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
export * from "./delegate.js";
export * from "./wallet.js";   // [wallet-owned-session-repair-r2] explicit wallet-v1 version (never a default)

import type { Address, Hex } from "viem";
import { exportPrivateKey, generateKeyPair, publicKeyXY, signerFromKeyPair, type SessionSigner } from "./keys.js";
import { pendingId, type KeyStore, type StoredSession } from "./store.js";
import { sessionIdOf, type Grant } from "./typed.js";
import { WALLET_SESSION_VERSION, assertWalletDeployment, type WalletSessionDeployment } from "./wallet.js";

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
  grant: Grant; rpc?: string; version?: typeof WALLET_SESSION_VERSION; deployment?: WalletSessionDeployment }): Promise<StoredSession> {
  const sid: Hex = sessionIdOf(p.vault, p.grant.sessionKey, p.grant.grantNonce);
  // [wallet-owned-session-repair-r2] a wallet-v1 record keeps its verified deployment; absent version stays legacy
  if (p.version !== undefined) {
    assertWalletDeployment({ version: p.version, ...p.deployment });
    if (p.deployment!.chainId !== record.chainId) throw new Error("the wallet-v1 deployment is for another chain");
  }
  const open: StoredSession = {
    ...record, id: sid, grant: p.grant,
    handle: { chainId: record.chainId, vault: p.vault, sid, owner: p.owner, label: record.label, relay: record.relay, rpc: p.rpc,
      ...(p.version !== undefined ? { version: p.version, deployment: p.deployment } : {}) },
  };
  await store.save(open);
  if (record.id !== sid) await store.remove(record.id);
  return open;
}
