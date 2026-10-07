import { type Hex } from "viem";
import { type Environment, type OnChainAction } from "./constants.js";
/** Typed arguments for each on-chain action, encoded exactly as
 *  SessionVault.execute decodes them (one tuple per struct-shaped action). */
export interface CreateArgs {
    appRef: string;
    gpuMilli: number;
    cpuMilli: number;
    appPort: number;
    ports: string;
    isPublic: boolean;
    configCid: string;
    maxRate6: bigint;
    env: Environment;
    fund6: bigint;
}
export interface PublishArgs {
    slug: string;
    name: string;
    description: string;
    version: string;
    cid: string;
    res: [number, number, number, number];
    ports: string;
    config: string;
    configCid: string;
}
export type ActionArgs = {
    "deploy.create": CreateArgs;
    "deploy.fund": {
        id: Hex;
        amount6: bigint;
    };
    "deploy.setAppRef": {
        id: Hex;
        appRef: string;
    };
    "deploy.setConfig": {
        id: Hex;
        configCid: string;
    };
    "deploy.setShares": {
        id: Hex;
        gpuMilli: number;
        cpuMilli: number;
    };
    "deploy.setMaxRate": {
        id: Hex;
        maxRate6: bigint;
    };
    "deploy.setActive": {
        id: Hex;
        active: boolean;
    };
    "deploy.refund": {
        id: Hex;
    };
    "app.publish": PublishArgs;
    "order.pay": {
        amount6: bigint;
        orderRef: Hex;
    };
};
export declare function encodeArgs<A extends OnChainAction>(action: A, a: ActionArgs[A]): Hex;
/** What an action spends from the session budget (before the relay fee). */
export declare function amountOf<A extends OnChainAction>(action: A, a: ActionArgs[A]): bigint;
/** Decode an action's raw args (the relay re-derives amounts from the bytes it is asked to submit). */
export declare function decodeArgs(action: OnChainAction, data: Hex): Record<string, unknown>;
export declare const actionIndex: (a: OnChainAction) => number;
export declare const actionByIndex: (i: number) => OnChainAction | undefined;
