export declare const sessionVaultAbi: readonly [{
    readonly type: "constructor";
    readonly inputs: readonly [{
        readonly name: "_usdc";
        readonly type: "address";
        readonly internalType: "contract ISVToken";
    }, {
        readonly name: "_book";
        readonly type: "address";
        readonly internalType: "contract ISVBook";
    }, {
        readonly name: "_router";
        readonly type: "address";
        readonly internalType: "contract ISVRouter";
    }, {
        readonly name: "_ka";
        readonly type: "address";
        readonly internalType: "contract ISVKeyAttestations";
    }, {
        readonly name: "_maxVault6";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "ACT_CREATE";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "ACT_FUND";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "ACT_PAY";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "ACT_PUBLISH";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "ACT_REFUND";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "ACT_SET_ACTIVE";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "ACT_SET_APPREF";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "ACT_SET_CONFIG";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "ACT_SET_MAXRATE";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "ACT_SET_SHARES";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "ADOPT_TYPEHASH";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "CALL_TYPEHASH";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "END_TYPEHASH";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "ENV_PROD";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "ENV_STAGING";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "EXTEND_TYPEHASH";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "GRANT_TYPEHASH";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "PROMOTE_TYPEHASH";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "RELEASE_TYPEHASH";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "REVOKE_TYPEHASH";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "SETENV_TYPEHASH";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "TERMINATE_TYPEHASH";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "TOPUP_TYPEHASH";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "WITHDRAW_TYPEHASH";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "adopt";
    readonly inputs: readonly [{
        readonly name: "id";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "environment";
        readonly type: "string";
        readonly internalType: "string";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }, {
        readonly name: "sig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "book";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
        readonly internalType: "contract ISVBook";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "close";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "domainSeparator";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "epoch";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "execute";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "nonce";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "action";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }, {
        readonly name: "args";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }, {
        readonly name: "fee";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "deadline";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }, {
        readonly name: "x";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "y";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "r";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "sv";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly outputs: readonly [{
        readonly name: "result";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "extend";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "expiresAt";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }, {
        readonly name: "sig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "factory";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
        readonly internalType: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "free";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "grantDigest";
    readonly inputs: readonly [{
        readonly name: "g";
        readonly type: "tuple";
        readonly internalType: "struct SessionVault.Grant";
        readonly components: readonly [{
            readonly name: "label";
            readonly type: "string";
            readonly internalType: "string";
        }, {
            readonly name: "preset";
            readonly type: "string";
            readonly internalType: "string";
        }, {
            readonly name: "sessionKey";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "actions";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "apps";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "environments";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "budget";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "spendPerPeriod";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "periodSeconds";
            readonly type: "uint32";
            readonly internalType: "uint32";
        }, {
            readonly name: "opsPerPeriod";
            readonly type: "uint32";
            readonly internalType: "uint32";
        }, {
            readonly name: "maxFeePerOp";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "maxAppFeePerHour";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "expiresAt";
            readonly type: "uint64";
            readonly internalType: "uint64";
        }, {
            readonly name: "measurement";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "grantNonce";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "signBefore";
            readonly type: "uint64";
            readonly internalType: "uint64";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "held";
    readonly inputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly outputs: readonly [{
        readonly name: "env";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }, {
        readonly name: "promoted";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "createdBy";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "initialize";
    readonly inputs: readonly [{
        readonly name: "owner_";
        readonly type: "address";
        readonly internalType: "address";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "isLive";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
        readonly internalType: "bool";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "keyAttestations";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
        readonly internalType: "contract ISVKeyAttestations";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "locked6";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "maxVault6";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "open";
    readonly inputs: readonly [{
        readonly name: "g";
        readonly type: "tuple";
        readonly internalType: "struct SessionVault.Grant";
        readonly components: readonly [{
            readonly name: "label";
            readonly type: "string";
            readonly internalType: "string";
        }, {
            readonly name: "preset";
            readonly type: "string";
            readonly internalType: "string";
        }, {
            readonly name: "sessionKey";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "actions";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "apps";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "environments";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "budget";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "spendPerPeriod";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "periodSeconds";
            readonly type: "uint32";
            readonly internalType: "uint32";
        }, {
            readonly name: "opsPerPeriod";
            readonly type: "uint32";
            readonly internalType: "uint32";
        }, {
            readonly name: "maxFeePerOp";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "maxAppFeePerHour";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "expiresAt";
            readonly type: "uint64";
            readonly internalType: "uint64";
        }, {
            readonly name: "measurement";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "grantNonce";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "signBefore";
            readonly type: "uint64";
            readonly internalType: "uint64";
        }];
    }, {
        readonly name: "ownerSig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "openWithDeposit";
    readonly inputs: readonly [{
        readonly name: "g";
        readonly type: "tuple";
        readonly internalType: "struct SessionVault.Grant";
        readonly components: readonly [{
            readonly name: "label";
            readonly type: "string";
            readonly internalType: "string";
        }, {
            readonly name: "preset";
            readonly type: "string";
            readonly internalType: "string";
        }, {
            readonly name: "sessionKey";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "actions";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "apps";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "environments";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "budget";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "spendPerPeriod";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "periodSeconds";
            readonly type: "uint32";
            readonly internalType: "uint32";
        }, {
            readonly name: "opsPerPeriod";
            readonly type: "uint32";
            readonly internalType: "uint32";
        }, {
            readonly name: "maxFeePerOp";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "maxAppFeePerHour";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "expiresAt";
            readonly type: "uint64";
            readonly internalType: "uint64";
        }, {
            readonly name: "measurement";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "grantNonce";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "signBefore";
            readonly type: "uint64";
            readonly internalType: "uint64";
        }];
    }, {
        readonly name: "ownerSig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }, {
        readonly name: "validAfter";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "validBefore";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "authSig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "owner";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
        readonly internalType: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "ownerCall";
    readonly inputs: readonly [{
        readonly name: "target";
        readonly type: "address";
        readonly internalType: "address";
    }, {
        readonly name: "data";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "ret";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "ownerNonceUsed";
    readonly inputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
        readonly internalType: "bool";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "promote";
    readonly inputs: readonly [{
        readonly name: "id";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "appRef";
        readonly type: "string";
        readonly internalType: "string";
    }, {
        readonly name: "configCid";
        readonly type: "string";
        readonly internalType: "string";
    }, {
        readonly name: "versionLabel";
        readonly type: "string";
        readonly internalType: "string";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }, {
        readonly name: "sig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "release";
    readonly inputs: readonly [{
        readonly name: "id";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "to";
        readonly type: "address";
        readonly internalType: "address";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }, {
        readonly name: "sig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "revokeAll";
    readonly inputs: readonly [{
        readonly name: "alsoWithdraw";
        readonly type: "bool";
        readonly internalType: "bool";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }, {
        readonly name: "sig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "router";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
        readonly internalType: "contract ISVRouter";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "seqOf";
    readonly inputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "";
        readonly type: "uint192";
        readonly internalType: "uint192";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "sessionIdOf";
    readonly inputs: readonly [{
        readonly name: "sessionKey";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "grantNonce";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "sessionOf";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly outputs: readonly [{
        readonly name: "s";
        readonly type: "tuple";
        readonly internalType: "struct SessionVault.Session";
        readonly components: readonly [{
            readonly name: "keyHash";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "measurement";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "actions";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "expiresAt";
            readonly type: "uint64";
            readonly internalType: "uint64";
        }, {
            readonly name: "epoch";
            readonly type: "uint64";
            readonly internalType: "uint64";
        }, {
            readonly name: "envs";
            readonly type: "uint8";
            readonly internalType: "uint8";
        }, {
            readonly name: "state";
            readonly type: "uint8";
            readonly internalType: "uint8";
        }, {
            readonly name: "anyApp";
            readonly type: "bool";
            readonly internalType: "bool";
        }, {
            readonly name: "balance6";
            readonly type: "uint128";
            readonly internalType: "uint128";
        }, {
            readonly name: "spent6";
            readonly type: "uint128";
            readonly internalType: "uint128";
        }, {
            readonly name: "perPeriod6";
            readonly type: "uint128";
            readonly internalType: "uint128";
        }, {
            readonly name: "maxFee6";
            readonly type: "uint128";
            readonly internalType: "uint128";
        }, {
            readonly name: "maxAppFeeHour6";
            readonly type: "uint128";
            readonly internalType: "uint128";
        }, {
            readonly name: "periodStart";
            readonly type: "uint64";
            readonly internalType: "uint64";
        }, {
            readonly name: "period";
            readonly type: "uint32";
            readonly internalType: "uint32";
        }, {
            readonly name: "opsPerPeriod";
            readonly type: "uint32";
            readonly internalType: "uint32";
        }, {
            readonly name: "periodSpent6";
            readonly type: "uint128";
            readonly internalType: "uint128";
        }, {
            readonly name: "periodOps";
            readonly type: "uint32";
            readonly internalType: "uint32";
        }];
    }, {
        readonly name: "live";
        readonly type: "bool";
        readonly internalType: "bool";
    }, {
        readonly name: "apps";
        readonly type: "bytes32[]";
        readonly internalType: "bytes32[]";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "setEnvironment";
    readonly inputs: readonly [{
        readonly name: "id";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "environment";
        readonly type: "string";
        readonly internalType: "string";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }, {
        readonly name: "sig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "terminate";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }, {
        readonly name: "sig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "terminateBySession";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "deadline";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }, {
        readonly name: "x";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "y";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "r";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "sv";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "topUp";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }, {
        readonly name: "sig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "topUpWithAuthorization";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "validAfter";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "validBefore";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }, {
        readonly name: "authSig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "usdc";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
        readonly internalType: "contract ISVToken";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "withdraw";
    readonly inputs: readonly [{
        readonly name: "amount";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "opNonce";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "signBefore";
        readonly type: "uint64";
        readonly internalType: "uint64";
    }, {
        readonly name: "sig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "event";
    readonly name: "Extended";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly indexed: true;
        readonly internalType: "bytes32";
    }, {
        readonly name: "expiresAt";
        readonly type: "uint64";
        readonly indexed: false;
        readonly internalType: "uint64";
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "HeldSet";
    readonly inputs: readonly [{
        readonly name: "id";
        readonly type: "bytes32";
        readonly indexed: true;
        readonly internalType: "bytes32";
    }, {
        readonly name: "env";
        readonly type: "uint8";
        readonly indexed: false;
        readonly internalType: "uint8";
    }, {
        readonly name: "createdBy";
        readonly type: "bytes32";
        readonly indexed: false;
        readonly internalType: "bytes32";
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "Promoted";
    readonly inputs: readonly [{
        readonly name: "id";
        readonly type: "bytes32";
        readonly indexed: true;
        readonly internalType: "bytes32";
    }, {
        readonly name: "promoted";
        readonly type: "bytes32";
        readonly indexed: false;
        readonly internalType: "bytes32";
    }, {
        readonly name: "appRef";
        readonly type: "string";
        readonly indexed: false;
        readonly internalType: "string";
    }, {
        readonly name: "configCid";
        readonly type: "string";
        readonly indexed: false;
        readonly internalType: "string";
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "Released";
    readonly inputs: readonly [{
        readonly name: "id";
        readonly type: "bytes32";
        readonly indexed: true;
        readonly internalType: "bytes32";
    }, {
        readonly name: "to";
        readonly type: "address";
        readonly indexed: false;
        readonly internalType: "address";
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "RevokedAll";
    readonly inputs: readonly [{
        readonly name: "epoch";
        readonly type: "uint64";
        readonly indexed: false;
        readonly internalType: "uint64";
    }, {
        readonly name: "withdrawn6";
        readonly type: "uint256";
        readonly indexed: false;
        readonly internalType: "uint256";
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "SessionEnded";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly indexed: true;
        readonly internalType: "bytes32";
    }, {
        readonly name: "reason";
        readonly type: "uint8";
        readonly indexed: false;
        readonly internalType: "uint8";
    }, {
        readonly name: "refund6";
        readonly type: "uint256";
        readonly indexed: false;
        readonly internalType: "uint256";
    }, {
        readonly name: "fee6";
        readonly type: "uint256";
        readonly indexed: false;
        readonly internalType: "uint256";
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "SessionOp";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly indexed: true;
        readonly internalType: "bytes32";
    }, {
        readonly name: "nonce";
        readonly type: "uint256";
        readonly indexed: false;
        readonly internalType: "uint256";
    }, {
        readonly name: "action";
        readonly type: "uint8";
        readonly indexed: true;
        readonly internalType: "uint8";
    }, {
        readonly name: "argsHash";
        readonly type: "bytes32";
        readonly indexed: false;
        readonly internalType: "bytes32";
    }, {
        readonly name: "amount6";
        readonly type: "uint256";
        readonly indexed: false;
        readonly internalType: "uint256";
    }, {
        readonly name: "fee6";
        readonly type: "uint256";
        readonly indexed: false;
        readonly internalType: "uint256";
    }, {
        readonly name: "result";
        readonly type: "bytes";
        readonly indexed: false;
        readonly internalType: "bytes";
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "SessionOpened";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly indexed: true;
        readonly internalType: "bytes32";
    }, {
        readonly name: "keyHash";
        readonly type: "bytes32";
        readonly indexed: true;
        readonly internalType: "bytes32";
    }, {
        readonly name: "expiresAt";
        readonly type: "uint64";
        readonly indexed: false;
        readonly internalType: "uint64";
    }, {
        readonly name: "actions";
        readonly type: "uint256";
        readonly indexed: false;
        readonly internalType: "uint256";
    }, {
        readonly name: "envs";
        readonly type: "uint8";
        readonly indexed: false;
        readonly internalType: "uint8";
    }, {
        readonly name: "budget6";
        readonly type: "uint256";
        readonly indexed: false;
        readonly internalType: "uint256";
    }, {
        readonly name: "label";
        readonly type: "string";
        readonly indexed: false;
        readonly internalType: "string";
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "ToppedUp";
    readonly inputs: readonly [{
        readonly name: "sid";
        readonly type: "bytes32";
        readonly indexed: true;
        readonly internalType: "bytes32";
    }, {
        readonly name: "amount6";
        readonly type: "uint256";
        readonly indexed: false;
        readonly internalType: "uint256";
    }, {
        readonly name: "fromWallet";
        readonly type: "bool";
        readonly indexed: false;
        readonly internalType: "bool";
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "Withdrawn";
    readonly inputs: readonly [{
        readonly name: "amount6";
        readonly type: "uint256";
        readonly indexed: false;
        readonly internalType: "uint256";
    }];
    readonly anonymous: false;
}, {
    readonly type: "error";
    readonly name: "AllowanceLeft";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "AppFeeTooHigh";
    readonly inputs: readonly [{
        readonly name: "perHour";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "max";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "AppNotAllowed";
    readonly inputs: readonly [{
        readonly name: "appId";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
}, {
    readonly type: "error";
    readonly name: "BadNonce";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "BadPolicy";
    readonly inputs: readonly [{
        readonly name: "code";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
}, {
    readonly type: "error";
    readonly name: "BadRef";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "BadSignature";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "BadTarget";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "BudgetExceeded";
    readonly inputs: readonly [{
        readonly name: "need";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "have";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "EnvNotAllowed";
    readonly inputs: readonly [{
        readonly name: "env";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
}, {
    readonly type: "error";
    readonly name: "Exists";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "Expired";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "FeeTooHigh";
    readonly inputs: readonly [{
        readonly name: "fee";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "max";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "Initialized";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "Insolvent";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "LabelMismatch";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NoAttestation";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NoContract";
    readonly inputs: readonly [{
        readonly name: "key";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
}, {
    readonly type: "error";
    readonly name: "NonceUsed";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotAllowed";
    readonly inputs: readonly [{
        readonly name: "action";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
}, {
    readonly type: "error";
    readonly name: "NotExpired";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotFactory";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotHeld";
    readonly inputs: readonly [{
        readonly name: "id";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
}, {
    readonly type: "error";
    readonly name: "NotLive";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotMine";
    readonly inputs: readonly [{
        readonly name: "id";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
}, {
    readonly type: "error";
    readonly name: "NotOwner";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "OverCap";
    readonly inputs: readonly [{
        readonly name: "balance";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "cap";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "PeriodLimit";
    readonly inputs: readonly [{
        readonly name: "need";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "left";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "RateLimit";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "Reentrant";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "TransferFailed";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "UnknownAction";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "UnknownEnvironment";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "WrongEnvironment";
    readonly inputs: readonly [{
        readonly name: "id";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }, {
        readonly name: "env";
        readonly type: "uint8";
        readonly internalType: "uint8";
    }];
}];
export declare const sessionVaultFactoryAbi: readonly [{
    readonly type: "constructor";
    readonly inputs: readonly [{
        readonly name: "usdc";
        readonly type: "address";
        readonly internalType: "contract ISVToken";
    }, {
        readonly name: "book";
        readonly type: "address";
        readonly internalType: "contract ISVBook";
    }, {
        readonly name: "router";
        readonly type: "address";
        readonly internalType: "contract ISVRouter";
    }, {
        readonly name: "keyAttestations";
        readonly type: "address";
        readonly internalType: "contract ISVKeyAttestations";
    }, {
        readonly name: "maxVault6";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "createVault";
    readonly inputs: readonly [{
        readonly name: "owner";
        readonly type: "address";
        readonly internalType: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "vault";
        readonly type: "address";
        readonly internalType: "address";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "implementation";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
        readonly internalType: "contract SessionVault";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "isVault";
    readonly inputs: readonly [{
        readonly name: "";
        readonly type: "address";
        readonly internalType: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
        readonly internalType: "bool";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "openFor";
    readonly inputs: readonly [{
        readonly name: "owner";
        readonly type: "address";
        readonly internalType: "address";
    }, {
        readonly name: "g";
        readonly type: "tuple";
        readonly internalType: "struct SessionVault.Grant";
        readonly components: readonly [{
            readonly name: "label";
            readonly type: "string";
            readonly internalType: "string";
        }, {
            readonly name: "preset";
            readonly type: "string";
            readonly internalType: "string";
        }, {
            readonly name: "sessionKey";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "actions";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "apps";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "environments";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "budget";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "spendPerPeriod";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "periodSeconds";
            readonly type: "uint32";
            readonly internalType: "uint32";
        }, {
            readonly name: "opsPerPeriod";
            readonly type: "uint32";
            readonly internalType: "uint32";
        }, {
            readonly name: "maxFeePerOp";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "maxAppFeePerHour";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "expiresAt";
            readonly type: "uint64";
            readonly internalType: "uint64";
        }, {
            readonly name: "measurement";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "grantNonce";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "signBefore";
            readonly type: "uint64";
            readonly internalType: "uint64";
        }];
    }, {
        readonly name: "ownerSig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "vault";
        readonly type: "address";
        readonly internalType: "address";
    }, {
        readonly name: "sid";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "openWithDepositFor";
    readonly inputs: readonly [{
        readonly name: "owner";
        readonly type: "address";
        readonly internalType: "address";
    }, {
        readonly name: "g";
        readonly type: "tuple";
        readonly internalType: "struct SessionVault.Grant";
        readonly components: readonly [{
            readonly name: "label";
            readonly type: "string";
            readonly internalType: "string";
        }, {
            readonly name: "preset";
            readonly type: "string";
            readonly internalType: "string";
        }, {
            readonly name: "sessionKey";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "actions";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "apps";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "environments";
            readonly type: "string[]";
            readonly internalType: "string[]";
        }, {
            readonly name: "budget";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "spendPerPeriod";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "periodSeconds";
            readonly type: "uint32";
            readonly internalType: "uint32";
        }, {
            readonly name: "opsPerPeriod";
            readonly type: "uint32";
            readonly internalType: "uint32";
        }, {
            readonly name: "maxFeePerOp";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "maxAppFeePerHour";
            readonly type: "uint256";
            readonly internalType: "uint256";
        }, {
            readonly name: "expiresAt";
            readonly type: "uint64";
            readonly internalType: "uint64";
        }, {
            readonly name: "measurement";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "grantNonce";
            readonly type: "bytes32";
            readonly internalType: "bytes32";
        }, {
            readonly name: "signBefore";
            readonly type: "uint64";
            readonly internalType: "uint64";
        }];
    }, {
        readonly name: "ownerSig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }, {
        readonly name: "validAfter";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "validBefore";
        readonly type: "uint256";
        readonly internalType: "uint256";
    }, {
        readonly name: "authSig";
        readonly type: "bytes";
        readonly internalType: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "vault";
        readonly type: "address";
        readonly internalType: "address";
    }, {
        readonly name: "sid";
        readonly type: "bytes32";
        readonly internalType: "bytes32";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "vaultFor";
    readonly inputs: readonly [{
        readonly name: "owner";
        readonly type: "address";
        readonly internalType: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
        readonly internalType: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "event";
    readonly name: "VaultCreated";
    readonly inputs: readonly [{
        readonly name: "owner";
        readonly type: "address";
        readonly indexed: true;
        readonly internalType: "address";
    }, {
        readonly name: "vault";
        readonly type: "address";
        readonly indexed: false;
        readonly internalType: "address";
    }];
    readonly anonymous: false;
}];
export declare const usdcAbi: readonly [{
    readonly type: "function";
    readonly name: "name";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "string";
    }];
}, {
    readonly type: "function";
    readonly name: "version";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "string";
    }];
}, {
    readonly type: "function";
    readonly name: "balanceOf";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "a";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}];
export declare const addressBookAbi: readonly [{
    readonly type: "function";
    readonly name: "addr";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "key";
        readonly type: "bytes32";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}];
