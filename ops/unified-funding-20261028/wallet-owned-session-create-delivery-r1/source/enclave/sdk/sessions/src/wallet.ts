import { hashTypedData, type Address, type Hex } from "viem";
import { TYPES, type Grant } from "./typed.js";

/** wallet-owned-session-create-r1 (NEW, not built, not exported from index.ts, not in the shipped dist bundle):
 *  EIP-712 shapes of contracts/WalletSessionVault.sol. A SEPARATE domain name, so nothing signed for a legacy
 *  SessionVault ("Enclave Sessions") verifies here or the reverse. Callers must select the version explicitly. */
export const WALLET_DOMAIN_NAME = "Enclave Wallet Sessions";
export const WALLET_DOMAIN_VERSION = "1";
export const WALLET_SESSION_VERSION = "wallet-v1" as const;
export type SessionVersion = "legacy-v2" | typeof WALLET_SESSION_VERSION;

const grantFields = TYPES.SessionGrant.filter((f) => f.name !== "grantNonce" && f.name !== "signBefore");
export const WALLET_TYPES = {
  WalletSessionGrant: [...grantFields, { name: "ledger", type: "address" },
    { name: "grantNonce", type: "bytes32" }, { name: "signBefore", type: "uint64" }],
  SessionCall: TYPES.SessionCall,
  ApproveContent: [
    { name: "deployment", type: "bytes32" }, { name: "appRef", type: "string" }, { name: "configCid", type: "string" },
    { name: "revision", type: "uint64" }, { name: "opNonce", type: "bytes32" }, { name: "signBefore", type: "uint64" }],
  SetEnvironment: [
    { name: "deployment", type: "bytes32" }, { name: "environment", type: "string" }, { name: "revision", type: "uint64" },
    { name: "opNonce", type: "bytes32" }, { name: "signBefore", type: "uint64" }],
  Detach: [
    { name: "deployment", type: "bytes32" }, { name: "revision", type: "uint64" }, { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" }],
} as const;
export type WalletPrimaryType = keyof typeof WALLET_TYPES;

export interface WalletGrant extends Grant { ledger: Address }

/** A verified wallet-session deployment the caller chose: never a default, never inferred from a legacy handle. */
export interface WalletSessionDeployment { version: typeof WALLET_SESSION_VERSION; chainId: number; factory: Address; ledger: Address }

export function walletDomain(chainId: number, vault: Address) {
  return { name: WALLET_DOMAIN_NAME, version: WALLET_DOMAIN_VERSION, chainId, verifyingContract: vault } as const;
}

export function walletTypedData<P extends WalletPrimaryType>(chainId: number, vault: Address, primaryType: P,
  message: Record<string, unknown>) {
  return { domain: walletDomain(chainId, vault), types: { [primaryType]: WALLET_TYPES[primaryType] }, primaryType, message };
}

export function walletDigestOf<P extends WalletPrimaryType>(chainId: number, vault: Address, primaryType: P,
  message: Record<string, unknown>): Hex {
  return hashTypedData(walletTypedData(chainId, vault, primaryType, message) as never);
}

/** The grant the WALLET signs; `ledger` must be the selected deployment's ledger (the vault refuses any other).
 *  Named apps must be "0x<appId>" or "*": this version resolves no slugs. app.publish is refused here, as on chain. */
export function walletGrantTypedData(dep: WalletSessionDeployment, vault: Address, g: WalletGrant) {
  assertWalletDeployment(dep);
  if (g.ledger.toLowerCase() !== dep.ledger.toLowerCase()) throw new Error("wallet grant names another ledger");
  if (g.actions.includes("app.publish")) throw new Error("app.publish is not supported by wallet-session vaults yet");
  for (const a of g.apps) if (a !== "*" && !/^0x[0-9a-f]{64}$/.test(a)) throw new Error(`wallet grants name apps by 0x appId, not "${a}"`);
  return walletTypedData(dep.chainId, vault, "WalletSessionGrant", g as unknown as Record<string, unknown>);
}

/** Refuse a handle/version mix-up before anything is signed: a legacy handle is never reinterpreted as wallet-v1. */
export function assertWalletDeployment(dep: { version?: string } | null | undefined): asserts dep is WalletSessionDeployment {
  if (!dep || dep.version !== WALLET_SESSION_VERSION) throw new Error("select a verified wallet-v1 deployment explicitly");
}

/** The SessionCall a wallet-v1 session key signs (same struct as legacy, the wallet domain). */
export function walletCallDigest(dep: WalletSessionDeployment, vault: Address, call: { sessionId: Hex; nonce: bigint;
  action: number; argsHash: Hex; fee: bigint; deadline: bigint }): Hex {
  assertWalletDeployment(dep);
  return walletDigestOf(dep.chainId, vault, "SessionCall", call as unknown as Record<string, unknown>);
}
