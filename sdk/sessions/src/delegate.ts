import {
  encodeAbiParameters, encodeFunctionData, getAddress, keccak256, toFunctionSelector, type Address, type Hex, type PublicClient,
} from "viem";
import { ledgerDelegateAbi } from "./abi.js";

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
export const DELEGATE_SLOT = 23n;
/** setDelegate(address,bool) */
export const SET_DELEGATE_SELECTOR: Hex = toFunctionSelector("setDelegate(address,bool)");

/** The storage word holding isDelegate[owner][delegate]: keccak256(abi.encode(delegate, keccak256(abi.encode(owner, 23)))). */
export function delegateSlot(owner: Address, delegate: Address): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getAddress(owner), DELEGATE_SLOT]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [getAddress(delegate), inner]));
}

/** Does this runtime code dispatch setDelegate? (Its selector pushed as PUSH4: 0x63 ++ selector.) */
export function codeHasDelegation(code: Hex | undefined): boolean {
  return !!code && code.toLowerCase().includes("63" + SET_DELEGATE_SELECTOR.slice(2).toLowerCase());
}

// a ledger's code never changes (no proxy): cache the answer per chain + ledger. "No code" is never
// cached - a lagging node or a ledger not deployed yet must be asked again.
const supportedCache = new Map<string, boolean>();

/** Whether `ledger` is a revision with owner-approved delegates (cached per ledger address). */
export async function ledgerSupportsDelegation(pc: PublicClient, ledger: Address): Promise<boolean> {
  const key = `${pc.chain?.id ?? "?"}:${ledger.toLowerCase()}`;
  const hit = supportedCache.get(key);
  if (hit !== undefined) return hit;
  const code = await pc.getCode({ address: ledger });
  if (!code || code === "0x") return false;
  const ok = codeHasDelegation(code);
  supportedCache.set(key, ok);
  return ok;
}

export interface DelegationStatus {
  /** the ledger has setDelegate (rev 15d or later) */
  supported: boolean;
  /** `owner` has let `vault` act on the records its wallet holds */
  granted: boolean;
}

/** Has `owner` let its session vault act on the records its wallet holds on `ledger`? */
export async function delegationStatus(pc: PublicClient, ledger: Address, owner: Address, vault: Address): Promise<DelegationStatus> {
  if (!(await ledgerSupportsDelegation(pc, ledger))) return { supported: false, granted: false };
  const word = await pc.getStorageAt({ address: ledger, slot: delegateSlot(owner, vault) });
  return { supported: true, granted: !!word && BigInt(word) === 1n };
}

/** Calldata for the owner's WALLET transaction to the ledger: grant (`allowed`) or revoke the vault. */
export function setDelegateCall(vault: Address, allowed: boolean): { data: Hex } {
  return { data: encodeFunctionData({ abi: ledgerDelegateAbi, functionName: "setDelegate", args: [getAddress(vault), allowed] }) };
}
