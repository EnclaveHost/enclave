import { type Address, type Hex } from "viem";
/** EIP-712 shapes. Every string here must match SessionVault.sol's typehashes
 *  byte for byte - test/typed.test.mjs pins them against the compiled vault. */
export declare const DOMAIN_NAME = "Enclave Sessions";
export declare const DOMAIN_VERSION = "1";
export declare const TYPES: {
    readonly SessionGrant: readonly [{
        readonly name: "label";
        readonly type: "string";
    }, {
        readonly name: "preset";
        readonly type: "string";
    }, {
        readonly name: "sessionKey";
        readonly type: "bytes32";
    }, {
        readonly name: "actions";
        readonly type: "string[]";
    }, {
        readonly name: "apps";
        readonly type: "string[]";
    }, {
        readonly name: "environments";
        readonly type: "string[]";
    }, {
        readonly name: "budget";
        readonly type: "uint256";
    }, {
        readonly name: "spendPerPeriod";
        readonly type: "uint256";
    }, {
        readonly name: "periodSeconds";
        readonly type: "uint32";
    }, {
        readonly name: "opsPerPeriod";
        readonly type: "uint32";
    }, {
        readonly name: "maxFeePerOp";
        readonly type: "uint256";
    }, {
        readonly name: "maxAppFeePerHour";
        readonly type: "uint256";
    }, {
        readonly name: "expiresAt";
        readonly type: "uint64";
    }, {
        readonly name: "measurement";
        readonly type: "bytes32";
    }, {
        readonly name: "grantNonce";
        readonly type: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
    }];
    readonly SessionCall: readonly [{
        readonly name: "sessionId";
        readonly type: "bytes32";
    }, {
        readonly name: "nonce";
        readonly type: "uint256";
    }, {
        readonly name: "action";
        readonly type: "uint8";
    }, {
        readonly name: "argsHash";
        readonly type: "bytes32";
    }, {
        readonly name: "fee";
        readonly type: "uint256";
    }, {
        readonly name: "deadline";
        readonly type: "uint64";
    }];
    readonly SessionEnd: readonly [{
        readonly name: "sessionId";
        readonly type: "bytes32";
    }, {
        readonly name: "deadline";
        readonly type: "uint64";
    }];
    readonly TopUp: readonly [{
        readonly name: "sessionId";
        readonly type: "bytes32";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
    }];
    readonly Extend: readonly [{
        readonly name: "sessionId";
        readonly type: "bytes32";
    }, {
        readonly name: "expiresAt";
        readonly type: "uint64";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
    }];
    readonly Terminate: readonly [{
        readonly name: "sessionId";
        readonly type: "bytes32";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
    }];
    readonly RevokeAll: readonly [{
        readonly name: "withdraw";
        readonly type: "bool";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
    }];
    readonly Withdraw: readonly [{
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
    }];
    readonly Promote: readonly [{
        readonly name: "deployment";
        readonly type: "bytes32";
    }, {
        readonly name: "appRef";
        readonly type: "string";
    }, {
        readonly name: "configCid";
        readonly type: "string";
    }, {
        readonly name: "versionLabel";
        readonly type: "string";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
    }];
    readonly Adopt: readonly [{
        readonly name: "deployment";
        readonly type: "bytes32";
    }, {
        readonly name: "environment";
        readonly type: "string";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
    }];
    readonly SetEnvironment: readonly [{
        readonly name: "deployment";
        readonly type: "bytes32";
    }, {
        readonly name: "environment";
        readonly type: "string";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
    }];
    readonly Release: readonly [{
        readonly name: "deployment";
        readonly type: "bytes32";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
    }];
};
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
    expiresAt: bigint;
    measurement: Hex;
    grantNonce: Hex;
    signBefore: bigint;
}
export declare function domain(chainId: number, vault: Address): {
    readonly name: "Enclave Sessions";
    readonly version: "1";
    readonly chainId: number;
    readonly verifyingContract: `0x${string}`;
};
/** A complete eth_signTypedData_v4 payload for one primary type. */
export declare function typedData<P extends PrimaryType>(chainId: number, vault: Address, primaryType: P, message: Record<string, unknown>): {
    domain: {
        readonly name: "Enclave Sessions";
        readonly version: "1";
        readonly chainId: number;
        readonly verifyingContract: `0x${string}`;
    };
    types: { [K in P]: (typeof TYPES)[P]; };
    primaryType: P;
    message: Record<string, unknown>;
};
export declare function grantTypedData(chainId: number, vault: Address, g: Grant): {
    domain: {
        readonly name: "Enclave Sessions";
        readonly version: "1";
        readonly chainId: number;
        readonly verifyingContract: `0x${string}`;
    };
    types: {
        SessionGrant: readonly [{
            readonly name: "label";
            readonly type: "string";
        }, {
            readonly name: "preset";
            readonly type: "string";
        }, {
            readonly name: "sessionKey";
            readonly type: "bytes32";
        }, {
            readonly name: "actions";
            readonly type: "string[]";
        }, {
            readonly name: "apps";
            readonly type: "string[]";
        }, {
            readonly name: "environments";
            readonly type: "string[]";
        }, {
            readonly name: "budget";
            readonly type: "uint256";
        }, {
            readonly name: "spendPerPeriod";
            readonly type: "uint256";
        }, {
            readonly name: "periodSeconds";
            readonly type: "uint32";
        }, {
            readonly name: "opsPerPeriod";
            readonly type: "uint32";
        }, {
            readonly name: "maxFeePerOp";
            readonly type: "uint256";
        }, {
            readonly name: "maxAppFeePerHour";
            readonly type: "uint256";
        }, {
            readonly name: "expiresAt";
            readonly type: "uint64";
        }, {
            readonly name: "measurement";
            readonly type: "bytes32";
        }, {
            readonly name: "grantNonce";
            readonly type: "bytes32";
        }, {
            readonly name: "signBefore";
            readonly type: "uint64";
        }];
    };
    primaryType: "SessionGrant";
    message: Record<string, unknown>;
};
export declare function digestOf<P extends PrimaryType>(chainId: number, vault: Address, primaryType: P, message: Record<string, unknown>): Hex;
export declare function grantDigest(chainId: number, vault: Address, g: Grant): Hex;
/** sid = keccak256(abi.encode(vault, sessionKey, grantNonce)) - knowable before the open lands. */
export declare function sessionIdOf(vault: Address, sessionKey: Hex, grantNonce: Hex): Hex;
/** keyHash = keccak256(abi.encode(x, y)) - what the grant names and the vault stores. */
export declare function keyHashOf(x: bigint, y: bigint): Hex;
/** The short code shown by the CLI, the grant page AND (as the leading hex of
 *  sessionKey) on the hardware wallet, so a human can match all three. */
export declare function checkCode(keyHash: Hex): string;
