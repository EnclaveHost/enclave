import { type Hex } from "viem";
import { type ActionName, type Environment } from "./constants.js";
import type { Grant } from "./typed.js";
/** A policy: everything in a grant except the key and the nonces. Presets are
 *  plain templates of this - adding one needs no backend or contract change. */
export interface Policy {
    actions: ActionName[];
    apps: string[];
    environments: Environment[];
    budget: bigint;
    spendPerPeriod: bigint;
    periodSeconds: number;
    opsPerPeriod: number;
    maxFeePerOp: bigint;
    maxAppFeePerHour: bigint;
    /** ceiling on any deployment rate cap the session sets (USDC 6dp per hour) */
    maxRatePerHour: bigint;
    /** seconds from signing */
    expiresIn: number;
    measurement?: Hex;
}
export declare const PRESETS: Record<string, Policy & {
    maxExpiresIn: number;
    description: string;
}>;
export type PresetName = keyof typeof PRESETS;
export interface BuildGrantInput {
    sessionKey: Hex;
    label: string;
    preset?: PresetName | string;
    policy?: Partial<Policy>;
    /** seconds the owner has to sign (default 24 h for links, short for in-page) */
    signWithin?: number;
    now?: number;
}
/** Build a grant from a preset (plus overrides) or a full custom policy. */
export declare function buildGrant(input: BuildGrantInput): Grant;
export declare function validatePolicy(p: Policy): void;
export declare const fmtUsd: (v: bigint) => string;
/** Plain-language lines describing a grant, for the grant page and the CLI. */
export declare function describeGrant(g: Grant, now?: number): {
    lines: string[];
    warnings: string[];
};
/** What a CLI hands the owner: the grant MINUS the vault (unknown until the owner
 *  connects), with the public key so the page can show the check code. Lives in
 *  the URL fragment, so it never reaches a server. */
export interface GrantRequest {
    v: 1;
    chainId: number;
    relay: string;
    x: string;
    y: string;
    grant: Grant;
    /** if set, only this wallet may sign it (the page refuses others) */
    owner?: Hex;
}
declare const ser: (o: unknown) => string;
declare const de: <T>(s: string) => T;
export declare function encodeGrantRequest(r: GrantRequest): string;
export declare function decodeGrantRequest(s: string): GrantRequest;
export declare function grantLink(siteOrigin: string, r: GrantRequest): string;
export { ser as serialize, de as deserialize };
