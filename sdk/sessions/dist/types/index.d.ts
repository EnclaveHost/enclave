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
import type { Address } from "viem";
import { type SessionSigner } from "./keys.js";
import { type KeyStore, type StoredSession } from "./store.js";
import { type Grant } from "./typed.js";
/** Make a fresh session key and park it in `store` as pending. `extractable`
 *  only for file/env storage (agents); browsers keep it non-extractable. */
export declare function newSessionKey(store: KeyStore, p: {
    relay: string;
    chainId: number;
    label: string;
    extractable: boolean;
}): Promise<{
    signer: SessionSigner;
    record: StoredSession;
}>;
/** Promote a pending record to an open session once the grant has landed. */
export declare function completeSession(store: KeyStore, record: StoredSession, p: {
    vault: Address;
    owner: Address;
    grant: Grant;
    rpc?: string;
}): Promise<StoredSession>;
