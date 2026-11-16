// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnclaveLeaseExecutor, IEnclaveLeaseGasReserve} from "./EnclaveLeaseExecutor.sol";

/// @title EnclaveHostExecutor - a host's proofs carried by anyone, paid out of the earnings they unlock.
/// @notice The EIP-7702 delegate of a host's operator key, in the place EnclaveLeaseExecutor holds (a key has one
///         delegation, so this contract IS that one, unchanged, plus one function). `lease` is inherited byte for
///         byte: claim, renew and release paid by the app's reserve, as before, with the same signatures and nonces.
///
///         `carry` is new. The ledger credits a host's earnings to its operator key, and only that key can withdraw
///         them, so until now a host needed ETH on that key to send its own proofs: an empty key stopped being
///         credited. With `carry` the host signs, with the operator key and no ETH, an order that says:
///
///           - these exact calls to this prover (its checkpoints, and with EnclaveProofOfCapacity its reports, its own
///             proof of capacity, the epoch's seed), in this order, all of which must succeed;
///           - this fee, in the ledger's USDC, to this carrier (or to whoever carries it);
///           - the rest of what the key has earned to this payout address (or left on the ledger).
///
///         Anyone sends it. The code runs AS the operator key: it makes the calls, reads how much the key's earned
///         balance on the ledger grew, and unless that growth covers the fee the whole transaction reverts and the
///         host is charged nothing. Then it withdraws the key's earnings, pays the fee and forwards the rest.
///
///         So the fee comes out of what the call itself unlocked, never out of earlier earnings, and a carrier that
///         simulates first risks nothing. The host names the fee; nothing here prices gas, and there is no oracle.
///
/// What it does NOT do:
///   - It does not decide what a fair fee is, and a carrier is free to ignore an order whose fee does not cover its gas.
///   - It cannot carry calls that unlock nothing in the same transaction (a duty report sent alone): bundle them with
///     the checkpoints of the same round, or pay for them.
///   - Calls go to the one address the order names. That address is the host's choice and signature; a host that signs
///     an order for a hostile contract loses, at most, what that order can move: the fee and the payout of its earnings.
///   - The first transaction of a key through a new delegate carries its EIP-7702 authorization, which costs the
///     carrier 25,000 gas more; the host's fee for that order should say so. Nothing here adds it.
contract EnclaveHostExecutor is EnclaveLeaseExecutor {
    struct Carry {
        address target;        // the prover the calls go to
        bytes32 callsHash;     // keccak256(abi.encode(calls)): these calls, in this order
        uint64 nonce;          // this key's next carry nonce
        uint64 deadline;       // unix seconds
        address payee;         // the carrier paid; 0: whoever sends the transaction
        uint256 fee6;          // the fee, in the ledger's USDC (6 decimals)
        address payout;        // where the rest of the key's earnings go; 0: they stay on the ledger
    }

    IERC20Min public immutable usdc;

    bytes32 private constant HOST_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant CARRY_TYPEHASH = keccak256(
        "Carry(address ledger,address target,bytes32 callsHash,uint64 nonce,uint64 deadline,address payee,uint256 fee6,address payout)");
    // in the operator key's own storage, away from anything a layout would place
    bytes32 private constant CARRY_NONCE_SLOT = bytes32(uint256(keccak256("enclave.host.executor.carry.nonce")) - 1);

    error CallFailed(uint256 index, bytes reason);
    error FeeNotCovered(uint256 unlocked6, uint256 fee6);
    error NothingToCarry();

    event Carried(address indexed target, address indexed payee, uint256 unlocked6, uint256 fee6, uint256 paidOut6);

    constructor(IEnclaveLeaseGasReserve _reserve) EnclaveLeaseExecutor(_reserve) {
        usdc = IERC20Min(IHostLedger(_reserve.ledger()).usdc());
    }

    function hostDomainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(HOST_DOMAIN_TYPEHASH, keccak256("EnclaveHostExecutor"), keccak256("1"), block.chainid, address(this)));
    }

    function carryDigest(Carry calldata c) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", hostDomainSeparator(),
            keccak256(abi.encode(CARRY_TYPEHASH, ledger, c.target, c.callsHash, c.nonce, c.deadline, c.payee, c.fee6, c.payout))));
    }

    function carryNonce() public view returns (uint64 n) {
        bytes32 slot = CARRY_NONCE_SLOT;
        assembly { n := sload(slot) }
    }

    /// @notice Make the calls the operator key signed for, and pay the carrier out of what they unlocked.
    function carry(Carry calldata c, bytes[] calldata calls, bytes calldata signature) external {
        if (calls.length == 0 || c.target == address(0)) revert NothingToCarry();
        if (block.timestamp > c.deadline) revert Expired();
        if (keccak256(abi.encode(calls)) != c.callsHash || _recoverHost(carryDigest(c), signature) != address(this)) revert BadSignature();
        uint64 next = carryNonce();
        if (c.nonce != next) revert BadNonce(next);
        bytes32 slot = CARRY_NONCE_SLOT;
        assembly { sstore(slot, add(next, 1)) }

        IHostLedger l = IHostLedger(ledger);
        uint256 before = l.earned6(address(this));
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = c.target.call(calls[i]);
            if (!ok) revert CallFailed(i, ret);
        }
        uint256 total = l.earned6(address(this));
        uint256 unlocked = total > before ? total - before : 0;
        // the fee comes out of what THIS transaction unlocked: never out of what the key had earned before it
        if (unlocked < c.fee6) revert FeeNotCovered(unlocked, c.fee6);

        address payee = c.payee == address(0) ? msg.sender : c.payee;
        uint256 paidOut = 0;
        bool forward = c.payout != address(0) && c.payout != address(this);
        if (total != 0 && (c.fee6 != 0 || forward)) {
            // one withdrawal of everything the key has earned, to the key itself (the ledger has no partial one);
            // then the fee; then the rest to the payout, or, with none named, it stays with the key as USDC
            l.withdrawEarnings(address(this));
            if (c.fee6 != 0) _pay(payee, c.fee6);
            if (forward) { paidOut = total - c.fee6; if (paidOut != 0) _pay(c.payout, paidOut); }
        }
        emit Carried(c.target, payee, unlocked, c.fee6, paidOut);
    }

    function _pay(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20Min.transfer, (to, amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "usdc transfer failed");
    }

    function _recoverHost(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(digest, v, r, s);
    }
}

interface IHostLedger {
    function usdc() external view returns (address);
    function earned6(address operator) external view returns (uint256);
    function withdrawEarnings(address to) external;
}

interface IERC20Min {
    function transfer(address to, uint256 value) external returns (bool);
}
