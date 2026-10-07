import type { Address } from "viem";
/** Session action table: names the owner signs, bits the vault stores.
 *  0-9 are on-chain actions; 128+ are off-chain API scopes the relay and the
 *  hosts enforce from the same on-chain mask. Mirrors SessionVaultLib.actionBit. */
export declare const ACTIONS: {
    readonly "deploy.create": 0;
    readonly "deploy.fund": 1;
    readonly "deploy.setAppRef": 2;
    readonly "deploy.setConfig": 3;
    readonly "deploy.setShares": 4;
    readonly "deploy.setMaxRate": 5;
    readonly "deploy.setActive": 6;
    readonly "deploy.refund": 7;
    readonly "app.publish": 8;
    readonly "api.status": 128;
    readonly "api.logs": 129;
    readonly "api.restart": 130;
    readonly "api.upload": 131;
    readonly "api.appAccess": 132;
    readonly "api.placement": 133;
    readonly "api.account": 134;
};
export type ActionName = keyof typeof ACTIONS;
export type OnChainAction = "deploy.create" | "deploy.fund" | "deploy.setAppRef" | "deploy.setConfig" | "deploy.setShares" | "deploy.setMaxRate" | "deploy.setActive" | "deploy.refund" | "app.publish";
export type ApiScope = Exclude<ActionName, OnChainAction>;
export declare const ENVIRONMENTS: {
    readonly staging: 1;
    readonly prod: 2;
};
export type Environment = keyof typeof ENVIRONMENTS;
/** Plain-language descriptions, for grant review pages and CLI output. */
export declare const ACTION_TEXT: Record<ActionName, string>;
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
export declare const NETWORKS: Record<"base" | "base-sepolia", NetworkConfig>;
export declare const BOOK_KEY_FACTORY = "sessionVaultFactory";
export declare const ZERO_HASH: "0x0000000000000000000000000000000000000000000000000000000000000000";
