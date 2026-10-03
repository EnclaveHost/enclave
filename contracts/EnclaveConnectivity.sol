// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EnclaveDeployments, IEnclaveRegistry} from "./EnclaveDeployments.sol";

/// Qualification gates direct service and TUNA service identically. It grants
/// no compute entitlement. Direct payment uses the current app lease, an owner
/// allowance, and a receipt from the host's attested meter key.
contract EnclaveConnectivity {
    EnclaveDeployments public immutable ledger;
    IEnclaveRegistry public immutable registry;
    address public immutable administrator;
    uint16 public constant ALL_CHECKS = 511;
    uint256 private constant GIB = 1 << 30;
    mapping(address => bool) public probeSigner;
    struct Host { bool direct; bool tuna; uint64 pricePerGiB6; uint64 qualifiedUntil; bytes32 addressHash; address operator; address qualifier; }
    struct Policy { address owner; uint64 nonce; uint64 expires; uint64 maxPricePerGiB6; uint128 budget6; uint128 spent6; uint16 providerBps; }
    struct Receipt { bytes32 id; bytes32 hostId; uint64 policyNonce; uint64 leaseUntil; uint64 issuedAt; uint64 anchor; uint128 cumulativeBytes; uint64 pricePerGiB6; }
    mapping(bytes32 => Host) public hosts;
    mapping(bytes32 => Policy) public policies;
    mapping(bytes32 => uint256) public units;
    mapping(bytes32 => uint128) public bytesServed;
    mapping(bytes32 => uint256) public policyUnits;
    event HostConfigured(bytes32 indexed hostId, bool direct, bool tuna, uint64 pricePerGiB6);
    event Qualified(bytes32 indexed hostId, bytes32 addressHash, uint64 expires);
    event DirectAuthorized(bytes32 indexed id, uint64 nonce, uint64 expires, uint64 maxPricePerGiB6, uint128 budget6);
    event BandwidthCharged(bytes32 indexed id, bytes32 indexed hostId, uint256 amount6, uint256 cumulativeUnits);

    constructor(EnclaveDeployments deployments, address[] memory signers) {
        ledger = deployments; registry = deployments.registry(); administrator = msg.sender;
        require(signers.length > 0);
        for (uint256 i; i < signers.length; ++i) {require(signers[i] != address(0));probeSigner[signers[i]] = true;}
    }
    function setProbeSigner(address signer, bool active) external {
        require(msg.sender == administrator && signer != address(0));probeSigner[signer] = active;
    }
    function qualificationDigest(bytes32 hostId, bytes32 addressHash, uint64 issuedAt, uint64 expires, uint16 checks) public view returns (bytes32) {
        return keccak256(abi.encode("EnclaveConnectivity.qualification.v1", block.chainid, address(this), hostId,
            registry.get(hostId).operator, addressHash, issuedAt, expires, checks));
    }
    function qualify(bytes32 hostId, bytes32 addressHash, uint64 issuedAt, uint64 expires, uint16 checks, bytes calldata signature) external {
        IEnclaveRegistry.Enclave memory h = registry.get(hostId);
        require(h.active && addressHash != bytes32(0) && checks == ALL_CHECKS && issuedAt <= block.timestamp &&
            expires > block.timestamp && expires > issuedAt && expires - issuedAt <= 300);
        address signer = _recover(qualificationDigest(hostId,addressHash,issuedAt,expires,checks),signature);
        require(probeSigner[signer] && signer != h.operator);
        Host storage state = hosts[hostId];
        require(expires > state.qualifiedUntil || state.operator != h.operator);
        state.qualifiedUntil = expires;state.addressHash = addressHash;state.operator = h.operator;state.qualifier = signer;
        emit Qualified(hostId,addressHash,expires);
    }
    function qualified(bytes32 hostId) public view returns (bool) {
        IEnclaveRegistry.Enclave memory h = registry.get(hostId);
        return probeSigner[hosts[hostId].qualifier] && h.active && h.operator == hosts[hostId].operator && hosts[hostId].qualifiedUntil > block.timestamp;
    }
    function setHost(bytes32 hostId, bool direct, bool tuna, uint64 pricePerGiB6) external {
        require(registry.get(hostId).operator == msg.sender);
        if (direct || tuna) require(qualified(hostId));
        Host storage h = hosts[hostId];h.direct = direct;h.tuna = tuna;h.pricePerGiB6 = pricePerGiB6;
        emit HostConfigured(hostId,direct,tuna,pricePerGiB6);
    }
    function capabilities(bytes32 hostId) external view returns (bool direct, bool tuna) {
        bool q = qualified(hostId);return (q && hosts[hostId].direct,q && hosts[hostId].tuna);
    }
    function policyDigest(bytes32 id, uint64 expires, uint64 maxPricePerGiB6, uint128 budget6) public view returns (bytes32) {
        return keccak256(abi.encode("EnclaveConnectivity.policy.v1",block.chainid,address(this),address(ledger),id,
            ledger.get(id).owner,policies[id].nonce + 1,expires,maxPricePerGiB6,budget6));
    }
    function authorizeDirect(bytes32 id, uint64 expires, uint64 maxPricePerGiB6, uint128 budget6, bytes calldata signature) external {
        EnclaveDeployments.Deployment memory d = ledger.get(id);
        require(d.active && expires > block.timestamp && expires <= block.timestamp + 30 days);
        require(_signedBy(d.owner,policyDigest(id,expires,maxPricePerGiB6,budget6),signature));
        uint64 nonce = policies[id].nonce + 1;
        policies[id] = Policy(d.owner,nonce,expires,maxPricePerGiB6,budget6,0,ledger.runnerBps());
        emit DirectAuthorized(id,nonce,expires,maxPricePerGiB6,budget6);
    }
    function revokeDirect(bytes32 id) external {
        require(ledger.get(id).owner == msg.sender);policies[id].expires = 0;
    }
    function quote(bytes32 id) public view returns (uint64 pricePerGiB6, bool selfHosted) {
        EnclaveDeployments.Deployment memory d = ledger.get(id);
        Policy memory p = policies[id];Host memory h = hosts[d.runner];
        require(d.active && d.leaseUntil > block.timestamp && p.owner == d.owner && p.expires > block.timestamp && h.direct && qualified(d.runner));
        IEnclaveRegistry.Enclave memory provider = registry.get(d.runner);
        require(provider.operator == d.runnerOperator);
        selfHosted = provider.payoutWallet != address(0) && provider.payoutWallet == d.owner;
        pricePerGiB6 = selfHosted ? 0 : h.pricePerGiB6;
        require(pricePerGiB6 <= p.maxPricePerGiB6);
    }
    function receiptDigest(Receipt calldata r) public view returns (bytes32) {
        return keccak256(abi.encode("EnclaveConnectivity.receipt.v1",block.chainid,address(this),address(ledger),r,blockhash(r.anchor)));
    }
    function settle(Receipt calldata r, bytes calldata signature) external {
        (uint64 rate, bool free) = quote(r.id);
        require(!free && rate == r.pricePerGiB6);
        EnclaveDeployments.Deployment memory d = ledger.get(r.id);
        Policy storage p = policies[r.id];
        require(r.hostId == d.runner && r.leaseUntil == d.leaseUntil && r.policyNonce == p.nonce &&
            r.issuedAt <= block.timestamp && block.timestamp - r.issuedAt <= 60 &&
            r.anchor < block.number && block.number - r.anchor <= 256 && blockhash(r.anchor) != bytes32(0));
        require(_recover(receiptDigest(r),signature) == registry.get(r.hostId).proofKey);
        bytes32 key = keccak256(abi.encode(r.id,r.hostId,r.policyNonce));
        uint128 previous = bytesServed[key];require(r.cumulativeBytes > previous);
        // Meter units are sum(bytes * the accepted USDC/GiB rate); retaining the
        // numerator prevents packet rounding and retroactive price changes.
        bytes32 policyKey = keccak256(abi.encode(r.id,r.policyNonce));
        uint256 previousUnits = policyUnits[policyKey];
        uint256 added = uint256(r.cumulativeBytes - previous) * rate;
        uint256 nextUnits = previousUnits + added;
        uint256 delta6 = (nextUnits + GIB - 1) / GIB - (previousUnits + GIB - 1) / GIB;
        require(uint256(p.spent6) + delta6 <= p.budget6);
        // Snapshot the compute provider/platform split when the owner opts in.
        // Cumulative rounding prevents receipt fragmentation changing the split.
        uint256 provider6 = (uint256(p.spent6) + delta6) * p.providerBps / 10000 - uint256(p.spent6) * p.providerBps / 10000;
        bytesServed[key] = r.cumulativeBytes;units[key] += added;policyUnits[policyKey] = nextUnits;p.spent6 += uint128(delta6);
        if (delta6 > 0) ledger.chargeBandwidth(r.id,delta6,provider6);
        emit BandwidthCharged(r.id,r.hostId,delta6,units[key]);
    }
    function _signedBy(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        bytes32 hash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32",digest));
        if (signer.code.length > 0) {
            (bool ok,bytes memory result) = signer.staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)",hash,signature));
            return ok && result.length >= 32 && bytes4(result) == 0x1626ba7e;
        }
        return _recover(digest,signature) == signer;
    }
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        require(sig.length == 65);bytes32 r;bytes32 s;uint8 v;
        assembly {r := calldataload(sig.offset) s := calldataload(add(sig.offset,32)) v := byte(0,calldataload(add(sig.offset,64)))}
        require(uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 && (v == 27 || v == 28));
        signer = ecrecover(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32",digest)),v,r,s);require(signer != address(0));
    }
}
