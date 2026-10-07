import { type Address, type Hex, type PublicClient } from "viem";
/** Sessions acting on the records the owner's WALLET holds (docs/design/sessions.md, ledger rev 15d +
 *  SessionVault v2). The owner lets its vault act for it on the ledger ONCE, with a wallet transaction
 *  `setDelegate(vault, true)`; the vault then treats every record the wallet holds as PRODUCTION:
 *  suspend/resume, resize, fund, lower the cap and refund (to the wallet) - never re-point the version
 *  or config, never move the record. `setDelegate(vault, false)` takes it back.
 *
 *  The ledger keeps the grant in a PRIVATE mapping (no room for a getter under EIP-170), so it is read
 *  from storage. deploymentsSchema() did not change with it, so support is detected from the ledger's
 *  code, and the slot is never read on a ledger without it (there slot 23 holds something else). */
/** isDelegate's storage slot in the rev 15d ledger (recorded with the contract). */
export declare const DELEGATE_SLOT = 23n;
/** setDelegate(address,bool) */
export declare const SET_DELEGATE_SELECTOR: Hex;
/** The storage word holding isDelegate[owner][delegate]: keccak256(abi.encode(delegate, keccak256(abi.encode(owner, 23)))). */
export declare function delegateSlot(owner: Address, delegate: Address): Hex;
/** Does this runtime code dispatch setDelegate? (Its selector pushed as PUSH4: 0x63 ++ selector.) */
export declare function codeHasDelegation(code: Hex | undefined): boolean;
/** Whether `ledger` is a revision with owner-approved delegates (cached per ledger address). */
export declare function ledgerSupportsDelegation(pc: PublicClient, ledger: Address): Promise<boolean>;
export interface DelegationStatus {
    /** the ledger has setDelegate (rev 15d or later) */
    supported: boolean;
    /** `owner` has let `vault` act on the records its wallet holds */
    granted: boolean;
}
/** Has `owner` let its session vault act on the records its wallet holds on `ledger`? */
export declare function delegationStatus(pc: PublicClient, ledger: Address, owner: Address, vault: Address): Promise<DelegationStatus>;
/** Calldata for the owner's WALLET transaction to the ledger: grant (`allowed`) or revoke the vault. */
export declare function setDelegateCall(vault: Address, allowed: boolean): {
    data: Hex;
};
