// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// WalletSessionProfile - the immutable dependency snapshot a WalletSessionVaultFactory hands its vaults in place of a
/// mutable address book. NEW in wallet-owned-session-repair-r2 (2026-10-29); not compiled, not deployed, not tested.
///
/// The linked, already-deployed SessionVaultLib reads exactly two book keys - "deployments" (SessionVault.sol 149) and
/// "appCatalog" (155) - through ISVBook.addr. This contract answers those two with values fixed at construction, so no
/// later change of anyone's book (retirement, re-pointing, a platform migration) can redirect or freeze a vault the
/// owner chose. Every other key is the zero address, which the library already refuses (NoContract). No owner, no admin,
/// no setter. Consumers verify it by code (relay/wallet-session-manifest.mjs) and by address: it is CREATE(factory, 1).
contract WalletSessionProfile {
    address public immutable deployments;
    address public immutable appCatalog;

    constructor(address deployments_, address appCatalog_) {
        require(deployments_ != address(0), "ledger");
        deployments = deployments_;
        appCatalog = appCatalog_;
    }

    function addr(bytes32 key) external view returns (address) {
        if (key == "deployments") return deployments;
        if (key == "appCatalog") return appCatalog;
        return address(0);
    }
}
