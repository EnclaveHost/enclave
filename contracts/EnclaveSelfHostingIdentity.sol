// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

interface ISelfHostVaultFactory {
    function isVault(address vault) external view returns (bool);
    function vaultFor(address owner) external view returns (address);
}
interface ISelfHostVault { function owner() external view returns (address); }

/// Resolve only clones from explicitly pinned, immutable SessionVault factories.
/// Calling arbitrary owner() functions would let an attacker impersonate the
/// hardware owner and obtain free compute. No generic owner() fallback exists.
contract EnclaveSelfHostingIdentity {
    struct FactoryPin { address factory; bytes32 codeHash; }
    FactoryPin[] private _factories;
    constructor(FactoryPin[] memory pins) {
        require(pins.length > 0 && pins.length <= 8, "factory pins required");
        for (uint256 i; i < pins.length; ++i) {
            require(pins[i].factory.code.length > 0 && pins[i].factory.codehash == pins[i].codeHash, "factory code differs");
            for (uint256 j; j < i; ++j) require(pins[j].factory != pins[i].factory, "duplicate factory");
            _factories.push(pins[i]);
        }
    }
    function principal(address account) public view returns (address) {
        if (account == address(0)) return address(0);
        for (uint256 i; i < _factories.length; ++i) {
            FactoryPin memory pin = _factories[i];
            if (pin.factory.codehash != pin.codeHash) continue;
            try ISelfHostVaultFactory(pin.factory).isVault(account) returns (bool known) {
                if (!known) continue;
                try ISelfHostVault(account).owner() returns (address owner) {
                    if (owner == address(0)) continue;
                    try ISelfHostVaultFactory(pin.factory).vaultFor(owner) returns (address expected) {
                        if (expected == account) return owner;
                    } catch {}
                } catch {}
            } catch {}
        }
        return account;
    }
    function sameOwner(address a, address b) external view returns (bool) {
        return a != address(0) && b != address(0) && principal(a) == principal(b);
    }
}
