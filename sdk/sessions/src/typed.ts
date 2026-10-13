import { encodeAbiParameters, hashTypedData, keccak256, type Address, type Hex } from "viem";

/** EIP-712 shapes. Every string here must match SessionVault.sol's typehashes
 *  byte for byte - test/typed.test.mjs pins them against the compiled vault. */
export const DOMAIN_NAME = "Enclave Sessions";
export const DOMAIN_VERSION = "1";

export const TYPES = {
  SessionGrant: [
    { name: "label", type: "string" },
    { name: "preset", type: "string" },
    { name: "sessionKey", type: "bytes32" },
    { name: "actions", type: "string[]" },
    { name: "apps", type: "string[]" },
    { name: "environments", type: "string[]" },
    { name: "budget", type: "uint256" },
    { name: "spendPerPeriod", type: "uint256" },
    { name: "periodSeconds", type: "uint32" },
    { name: "opsPerPeriod", type: "uint32" },
    { name: "maxFeePerOp", type: "uint256" },
    { name: "maxAppFeePerHour", type: "uint256" },
    { name: "maxRatePerHour", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
    { name: "measurement", type: "bytes32" },
    { name: "grantNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  SessionCall: [
    { name: "sessionId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "action", type: "uint8" },
    { name: "argsHash", type: "bytes32" },
    { name: "fee", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  SessionEnd: [
    { name: "sessionId", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
  TopUp: [
    { name: "sessionId", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  Extend: [
    { name: "sessionId", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  Terminate: [
    { name: "sessionId", type: "bytes32" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  RevokeAll: [
    { name: "withdraw", type: "bool" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  Withdraw: [
    { name: "amount", type: "uint256" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  Promote: [
    { name: "deployment", type: "bytes32" },
    { name: "app", type: "string" },
    { name: "publisher", type: "address" },
    { name: "appRef", type: "string" },
    { name: "configCid", type: "string" },
    { name: "versionLabel", type: "string" },
    { name: "isPublic", type: "bool" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  Adopt: [
    { name: "deployment", type: "bytes32" },
    { name: "environment", type: "string" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  SetEnvironment: [
    { name: "deployment", type: "bytes32" },
    { name: "environment", type: "string" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  Release: [
    { name: "deployment", type: "bytes32" },
    { name: "to", type: "address" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
} as const;

export type PrimaryType = keyof typeof TYPES;

export interface Grant {
  label: string;
  preset: string;
  sessionKey: Hex;
  actions: string[];
  apps: string[];
  environments: string[];
  budget: bigint;
  spendPerPeriod: bigint;
  periodSeconds: number;
  opsPerPeriod: number;
  maxFeePerOp: bigint;
  maxAppFeePerHour: bigint;
  maxRatePerHour: bigint;
  expiresAt: bigint;
  measurement: Hex;
  grantNonce: Hex;
  signBefore: bigint;
}

export function domain(chainId: number, vault: Address) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: vault } as const;
}

/** A complete eth_signTypedData_v4 payload for one primary type. */
export function typedData<P extends PrimaryType>(chainId: number, vault: Address, primaryType: P,
  message: Record<string, unknown>) {
  return {
    domain: domain(chainId, vault),
    types: { [primaryType]: TYPES[primaryType] } as { [K in P]: (typeof TYPES)[P] },
    primaryType,
    message,
  };
}

export function grantTypedData(chainId: number, vault: Address, g: Grant) {
  return typedData(chainId, vault, "SessionGrant", g as unknown as Record<string, unknown>);
}

export function digestOf<P extends PrimaryType>(chainId: number, vault: Address, primaryType: P,
  message: Record<string, unknown>): Hex {
  // viem's generic typing for arbitrary primary types is too narrow to express here
  return hashTypedData(typedData(chainId, vault, primaryType, message) as never);
}

export function grantDigest(chainId: number, vault: Address, g: Grant): Hex {
  return digestOf(chainId, vault, "SessionGrant", g as unknown as Record<string, unknown>);
}

/** sid = keccak256(abi.encode(vault, sessionKey, grantNonce)) - knowable before the open lands. */
export function sessionIdOf(vault: Address, sessionKey: Hex, grantNonce: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }], [vault, sessionKey, grantNonce]));
}

/** keyHash = keccak256(abi.encode(x, y)) - what the grant names and the vault stores. */
export function keyHashOf(x: bigint, y: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [x, y]));
}

/** The short code shown by the CLI, the grant page AND (as the leading hex of
 *  sessionKey) on the hardware wallet, so a human can match all three. */
export function checkCode(keyHash: Hex): string {
  const h = keyHash.slice(2, 10).toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
}
