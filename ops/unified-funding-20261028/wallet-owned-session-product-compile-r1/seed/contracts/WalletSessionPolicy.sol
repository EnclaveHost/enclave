// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// WalletSessionPolicy - the environment/content binding of a deployment a WalletSessionVault created
/// and handed to its owner's wallet. Custody (the ledger's d.owner) is the WALLET; this binding is what
/// the executor, the relay, the hosts and the three secret-release paths read instead of "who holds it".
///
/// Provenance: NEW in wallet-owned-session-create-r1 (2026-10-29). Not deployed, not compiled, not tested.
/// The legacy SessionVault (deployed v2) and its Held record are untouched; nothing here reads or writes them.
///
/// Discovery (relay/wallet-session-policy.mjs): a pinned WalletSessionVaultFactory (address + runtime code hash
/// + ledger) answers creatorOf(id) -> the vault that created it; that vault's immutable owner must be the row's
/// current ledger owner and its policyOf(id) is the binding. creatorOf == 0 on every pinned factory is the
/// PROOF that a wallet row is legacy-unbound; an unreadable answer is never that proof.
library WalletSessionPolicy {
    uint8 internal constant ENV_STAGING = 1;
    uint8 internal constant ENV_PROD = 2;

    uint8 internal constant UNBOUND = 0;    // this vault never created it
    uint8 internal constant BOUND = 1;      // created by a session under the owner's grant; policy applies
    uint8 internal constant DETACHED = 2;   // the OWNER explicitly removed the policy (sessions can never do this)

    bytes32 internal constant PROTOCOL = keccak256("enclave.wallet-session.v1");

    struct Binding {
        uint8   env;        // ENV_STAGING | ENV_PROD while BOUND; 0 otherwise
        uint8   state;      // UNBOUND | BOUND | DETACHED
        uint64  revision;   // bumps on every owner change: consumers can tell a stale read from a fresh one
        bytes32 approved;   // contentHash the OWNER approved for PROD (0 = none: no prod secrets)
        bytes32 createdBy;  // the session id whose deploy.create made it
    }

    /// what an owner approves and what the ledger row must still carry for PROD secrets to flow
    function contentHash(string memory appRef, string memory configCid) internal pure returns (bytes32) {
        return keccak256(abi.encode(appRef, configCid));
    }

    /// may a session holding env mask `envs` act on `b` at all
    function sessionMayAct(Binding storage b, uint8 envs) internal view returns (bool) {
        return b.state == BOUND && (b.env == ENV_STAGING || b.env == ENV_PROD) && (envs & b.env) != 0;
    }

    /// a session may re-point WHAT runs only in staging; production content is the owner's alone
    function contentMutable(Binding storage b) internal view returns (bool) {
        return b.state == BOUND && b.env == ENV_STAGING;
    }
}
