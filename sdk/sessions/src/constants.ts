import type { Address } from "viem";

/** Session action table: names the owner signs, bits the vault stores.
 *  0-9 are on-chain actions; 128+ are off-chain API scopes the relay and the
 *  hosts enforce from the same on-chain mask. Mirrors SessionVaultLib.actionBit. */
export const ACTIONS = {
  "deploy.create": 0,
  "deploy.fund": 1,
  "deploy.setAppRef": 2,
  "deploy.setConfig": 3,
  "deploy.setShares": 4,
  "deploy.setMaxRate": 5,
  "deploy.setActive": 6,
  "deploy.refund": 7,
  "app.publish": 8,
  "order.pay": 9,
  "api.status": 128,
  "api.logs": 129,
  "api.restart": 130,
  "api.upload": 131,
  "api.appAccess": 132,
  "api.placement": 133,
} as const;

export type ActionName = keyof typeof ACTIONS;
export type OnChainAction =
  | "deploy.create" | "deploy.fund" | "deploy.setAppRef" | "deploy.setConfig" | "deploy.setShares"
  | "deploy.setMaxRate" | "deploy.setActive" | "deploy.refund" | "app.publish" | "order.pay";
export type ApiScope = Exclude<ActionName, OnChainAction>;

export const ENVIRONMENTS = { staging: 1, prod: 2 } as const;
export type Environment = keyof typeof ENVIRONMENTS;

/** Plain-language descriptions, for grant review pages and CLI output. */
export const ACTION_TEXT: Record<ActionName, string> = {
  "deploy.create": "create deployments",
  "deploy.fund": "add runtime to your deployments (spends the session budget)",
  "deploy.setAppRef": "change which version a STAGING deployment runs",
  "deploy.setConfig": "change a STAGING deployment's options",
  "deploy.setShares": "resize deployments",
  "deploy.setMaxRate": "change deployments' price ceilings",
  "deploy.setActive": "suspend and resume deployments",
  "deploy.refund": "cancel deployments (unused runtime returns to your vault)",
  "app.publish": "publish new versions of the named apps",
  "order.pay": "pay platform orders (spends the session budget)",
  "api.status": "read deployment status",
  "api.logs": "read deployment logs",
  "api.restart": "restart deployments",
  "api.upload": "upload app bundles and configs",
  "api.appAccess": "open private apps in the browser",
  "api.placement": "choose which host serves a deployment",
};

export interface NetworkConfig {
  chainId: number;
  name: string;
  usdc: Address;
  /** EnclaveAddressBook: resolves sessionVaultFactory, deployments, appCatalog. */
  book?: Address;
  /** Default relay API base. */
  relay: string;
  rpc: string;
}

export const NETWORKS: Record<"base" | "base-sepolia", NetworkConfig> = {
  base: {
    chainId: 8453,
    name: "Base",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    book: "0xab214342d5A490150A4A977063A2f88E21F80907",
    relay: "https://api.enclave.host",
    rpc: "https://base-rpc.publicnode.com",
  },
  "base-sepolia": {
    chainId: 84532,
    name: "Base Sepolia",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    relay: "https://api.enclave.host",
    rpc: "https://base-sepolia-rpc.publicnode.com",
  },
};

export const BOOK_KEY_FACTORY = "sessionVaultFactory";
export const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
