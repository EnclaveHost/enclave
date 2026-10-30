import { hashTypedData, keccak256, stringToBytes, toHex, getAddress, getContractAddress, encodeAbiParameters,
  type Address, type Hex, type PublicClient } from "viem";
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

const walletFactoryAbi = [
  { type: "function", name: "PROTOCOL", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "ledger", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "profile", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "vaultFor", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
] as const;
export const WALLET_SESSION_PROTOCOL = keccak256(stringToBytes("enclave.wallet-session.v1"));

/** [wallet-owned-session-repair-r2] Check the CHOSEN deployment on chain before anything is signed: the client's chain,
 *  factory code present, PROTOCOL, the factory's immutable ledger == the deployment's ledger, a profile whose
 *  "deployments" is that ledger, and the owner's CREATE2 vault. This is consistency, not the relay/hosts' full
 *  code-template verification (relay/wallet-session-manifest.mjs), which decides whether rows are honoured. */
export async function verifyWalletDeployment(pc: PublicClient, dep: WalletSessionDeployment, owner: Address): Promise<Address> {
  assertWalletDeployment(dep);
  if ((await pc.getChainId()) !== dep.chainId) throw new Error("the client is on another chain than the wallet-v1 deployment");
  const code = await pc.getCode({ address: dep.factory });
  if (!code || code === "0x") throw new Error("the wallet-v1 factory has no code on this chain");
  const [proto, ledger, profile, vault] = await Promise.all([
    pc.readContract({ address: dep.factory, abi: walletFactoryAbi, functionName: "PROTOCOL" }),
    pc.readContract({ address: dep.factory, abi: walletFactoryAbi, functionName: "ledger" }),
    pc.readContract({ address: dep.factory, abi: walletFactoryAbi, functionName: "profile" }),
    pc.readContract({ address: dep.factory, abi: walletFactoryAbi, functionName: "vaultFor", args: [owner] })]);
  if (String(proto).toLowerCase() !== WALLET_SESSION_PROTOCOL.toLowerCase()) throw new Error("not a wallet-session v1 factory");
  if (getAddress(ledger as Address) !== getAddress(dep.ledger)) throw new Error("the factory is bound to another ledger");
  if (getAddress(profile as Address) !== getContractAddress({ from: dep.factory, nonce: 1n })) throw new Error("the factory's profile is not its own");
  const pl = await pc.readContract({ address: profile as Address, functionName: "addr", args: [toHex("deployments", { size: 32 })],
    abi: [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }] });
  if (getAddress(pl as Address) !== getAddress(dep.ledger)) throw new Error("the factory's profile names another ledger");
  return getAddress(vault as Address);
}

/** Open a wallet-v1 session: verify the chosen deployment, have the WALLET sign the WalletSessionGrant (it names the
 *  ledger), sign the deposit against the wallet-domain grant digest, and have the relay submit factory.openFor /
 *  openWithDepositFor. Returns the handle fields a store record keeps (version + deployment travel with it). */
export async function openWalletSession(p: { pc: PublicClient; relay: { request<T>(m: string, path: string, body?: unknown): Promise<T> };
  owner: { address: Address; signTypedData(td: never): Promise<Hex> }; dep: WalletSessionDeployment; grant: WalletGrant;
  signDeposit?: (vault: Address, value: bigint, nonce: Hex, validBefore: bigint) => Promise<unknown> }) {
  const vault = await verifyWalletDeployment(p.pc, p.dep, p.owner.address);
  const td = walletGrantTypedData(p.dep, vault, p.grant);
  const ownerSig = await p.owner.signTypedData(td as never);
  let deposit;
  if (p.grant.budget > 0n) {
    if (!p.signDeposit) throw new Error("a funded wallet-v1 session needs a deposit signer");
    deposit = await p.signDeposit(vault, p.grant.budget, walletDigestOf(p.dep.chainId, vault, "WalletSessionGrant",
      p.grant as unknown as Record<string, unknown>), BigInt(p.grant.signBefore));
  }
  const out = await p.relay.request<{ txHash: Hex; vault: Address; sid: Hex }>("POST", "/open",
    { version: WALLET_SESSION_VERSION, factory: p.dep.factory, ledger: p.dep.ledger, owner: p.owner.address, grant: p.grant, ownerSig, deposit });
  const expect = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }], [vault, p.grant.sessionKey, p.grant.grantNonce]));
  if (getAddress(out.vault) !== vault || out.sid !== expect) throw new Error(`relay reported ${out.vault}/${out.sid}, expected ${vault}/${expect}`);
  return { ...out, vault, version: WALLET_SESSION_VERSION, deployment: p.dep };
}

/** The SessionCall a wallet-v1 session key signs (same struct as legacy, the wallet domain). */
export function walletCallDigest(dep: WalletSessionDeployment, vault: Address, call: { sessionId: Hex; nonce: bigint;
  action: number; argsHash: Hex; fee: bigint; deadline: bigint }): Hex {
  assertWalletDeployment(dep);
  return walletDigestOf(dep.chainId, vault, "SessionCall", call as unknown as Record<string, unknown>);
}
