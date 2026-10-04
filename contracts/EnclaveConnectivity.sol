// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EnclaveDeployments, IEnclaveRegistry} from "./EnclaveDeployments.sol";

/// Qualification gates direct service and TUNA service identically. It grants
/// no compute entitlement. Direct payment uses the current app lease, an owner
/// allowance, and a receipt from the host's registered compute proof key.
contract EnclaveConnectivity {
    EnclaveDeployments public immutable ledger;
    IEnclaveRegistry public immutable registry;
    uint16 public constant ALL_CHECKS = 511;
    uint256 private constant GIB = 1 << 30;
    // Bootstrap trust is immutable. Anyone can publish an attestation, and an
    // app owner can replace the bootstrap set without asking a global operator.
    address[] private _bootstrapSigners;
    struct Trust { address owner; uint8 threshold; address[] signers; }
    struct Attestation { address operator; bytes32 addressHash; uint64 expires; }
    mapping(bytes32 => Trust) private _probeTrust;
    mapping(bytes32 => mapping(address => Attestation)) public attestations;
    event ProbeTrustAuthorized(bytes32 indexed id,uint64 nonce,address[] signers,uint8 threshold);
    struct Host { bool direct; bool tuna; uint64 pricePerGiB6; uint64 qualifiedUntil; bytes32 addressHash; address operator; address qualifier; }
    struct Policy { address owner; uint64 nonce; uint64 expires; uint64 maxPricePerGiB6; uint128 budget6; uint128 spent6; uint16 providerBps; }
    struct Receipt { bytes32 id; bytes32 hostId; uint64 policyNonce; uint64 leaseUntil; uint64 issuedAt; uint64 anchor; uint128 cumulativeBytes; uint64 pricePerGiB6; }
    // One owner authorization covers the complete paid provider path. Its
    // aggregate price, rather than each individual hop, is capped by the owner.
    struct TunaReceipt { bytes32 id; bytes32 runnerId; bytes32 providerId; uint64 policyNonce; uint64 leaseUntil; uint64 issuedAt; uint64 anchor; uint128 cumulativeBytes; uint64 pricePerGiB6; }
    mapping(bytes32 => bool) public viaTuna;
    mapping(bytes32 => bytes32[]) private _tunaProviders;
    event TunaAuthorized(bytes32 indexed id,uint64 nonce,bytes32[] providers);
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
        ledger = deployments; registry = deployments.registry();
        require(signers.length > 0 && signers.length <= 8);
        for (uint256 i; i < signers.length; ++i) {
            require(signers[i] != address(0));
            for(uint256 j;j<i;++j)require(signers[i]!=signers[j]);
        }
        _bootstrapSigners=signers;
    }
    function probeTrust(bytes32 id) public view returns(address[] memory signers,uint8 threshold) {
        Trust storage trust=_probeTrust[id];
        if(id!=bytes32(0)&&trust.owner==ledger.get(id).owner&&trust.threshold>0)return(trust.signers,trust.threshold);
        return(_bootstrapSigners,uint8(_bootstrapSigners.length>1?2:1));
    }
    function probeTrustDigest(bytes32 id,address[] calldata signers,uint8 threshold,uint64 expires) public view returns(bytes32) {
        return keccak256(abi.encode("EnclaveConnectivity.probe-trust.v1",block.chainid,address(this),address(ledger),id,
            ledger.get(id).owner,policies[id].nonce+1,signers,threshold,expires));
    }
    function authorizeProbeTrust(bytes32 id,address[] calldata signers,uint8 threshold,uint64 expires,bytes calldata signature) external {
        address owner=ledger.get(id).owner;
        require(owner!=address(0)&&signers.length>0&&signers.length<=8&&threshold>0&&threshold<=signers.length);
        require(expires>block.timestamp&&expires<=block.timestamp+1 days);
        for(uint256 i;i<signers.length;++i){require(signers[i]!=address(0));for(uint256 j;j<i;++j)require(signers[i]!=signers[j]);}
        require(_signedBy(owner,probeTrustDigest(id,signers,threshold,expires),signature));
        _probeTrust[id]=Trust(owner,threshold,signers);
        // Changing trust invalidates spending authorizations and unused signed
        // intents. An explicit new spending authorization is required afterward.
        policies[id].nonce+=1;policies[id].expires=1;
        emit ProbeTrustAuthorized(id,policies[id].nonce,signers,threshold);
    }
    function qualificationFor(bytes32 hostId,bytes32 id) public view returns(bool ok,uint64 expires,bytes32 addressHash,address operator) {
        IEnclaveRegistry.Enclave memory h=registry.get(hostId);operator=h.operator;
        if(!h.active)return(false,0,bytes32(0),operator);
        (address[] memory signers,uint8 threshold)=probeTrust(id);
        // A quorum must agree on the actual address and current operator. Pick
        // the longest interval supported by a quorum, not the newest report.
        for(uint256 i;i<signers.length;++i){
            Attestation memory candidate=attestations[hostId][signers[i]];
            if(signers[i]==operator||candidate.operator!=operator||candidate.expires<=block.timestamp||candidate.expires<=expires)continue;
            uint256 votes;
            for(uint256 j;j<signers.length;++j){
                Attestation memory report=attestations[hostId][signers[j]];
                if(signers[j]!=operator&&report.operator==operator&&report.addressHash==candidate.addressHash&&report.expires>=candidate.expires)++votes;
            }
            if(votes>=threshold){ok=true;expires=candidate.expires;addressHash=candidate.addressHash;}
        }
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
        require(signer != h.operator);
        Attestation storage previous=attestations[hostId][signer];
        require(expires>previous.expires||previous.operator!=h.operator);
        attestations[hostId][signer]=Attestation(h.operator,addressHash,expires);
        emit Qualified(hostId,addressHash,expires);
    }
    function qualified(bytes32 hostId) public view returns (bool ok) {
        (ok,,,)=qualificationFor(hostId,bytes32(0));
    }
    function qualifiedFor(bytes32 hostId,bytes32 id) public view returns(bool ok){(ok,,,)=qualificationFor(hostId,id);}
    function setHost(bytes32 hostId, bool direct, bool tuna, uint64 pricePerGiB6) external {
        require(registry.get(hostId).operator == msg.sender);
        Host storage h = hosts[hostId];h.direct = direct;h.tuna = tuna;h.pricePerGiB6 = pricePerGiB6;
        emit HostConfigured(hostId,direct,tuna,pricePerGiB6);
    }
    function capabilities(bytes32 hostId) external view returns (bool direct, bool tuna) {
        return capabilitiesFor(hostId,bytes32(0));
    }
    function capabilitiesFor(bytes32 hostId,bytes32 id) public view returns(bool direct,bool tuna) {
        bool q=qualifiedFor(hostId,id);return(q&&hosts[hostId].direct,q&&hosts[hostId].tuna);
    }
    function policyDigest(bytes32 id, uint64 expires, uint64 maxPricePerGiB6, uint128 budget6) public view returns (bytes32) {
        return keccak256(abi.encode("EnclaveConnectivity.policy.v1",block.chainid,address(this),address(ledger),id,
            ledger.get(id).owner,policies[id].nonce + 1,expires,maxPricePerGiB6,budget6));
    }
    function authorizeDirect(bytes32 id, uint64 expires, uint64 maxPricePerGiB6, uint128 budget6, bytes calldata signature) external {
        EnclaveDeployments.Deployment memory d = ledger.get(id);
        require((expires == 0 && maxPricePerGiB6 == 0 && budget6 == 0) || (d.active && expires > block.timestamp && expires <= block.timestamp + 30 days));
        require(_signedBy(d.owner,policyDigest(id,expires,maxPricePerGiB6,budget6),signature));
        uint64 nonce = policies[id].nonce + 1;
        policies[id] = Policy(d.owner,nonce,expires,maxPricePerGiB6,budget6,0,ledger.runnerBps());
        viaTuna[id] = false;delete _tunaProviders[id];
        emit DirectAuthorized(id,nonce,expires,maxPricePerGiB6,budget6);
    }
    function revokeDirect(bytes32 id) external {
        require(ledger.get(id).owner == msg.sender);policies[id].expires = 0;policies[id].nonce += 1;
    }
    function quote(bytes32 id) public view returns (uint64 pricePerGiB6, bool selfHosted) {
        EnclaveDeployments.Deployment memory d = ledger.get(id);
        Policy memory p = policies[id];Host memory h = hosts[d.runner];
        require(!viaTuna[id] && d.active && d.leaseUntil > block.timestamp && p.owner == d.owner && p.expires > block.timestamp && h.direct && qualifiedFor(d.runner,id));
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
        if (delta6 > 0) ledger.chargeBandwidth(r.id,delta6,provider6,d.runnerOperator);
        emit BandwidthCharged(r.id,r.hostId,delta6,units[key]);
    }
    function tunaProviders(bytes32 id) external view returns(bytes32[] memory) {return _tunaProviders[id];}
    function tunaPolicyDigest(bytes32 id,bytes32[] calldata providers,uint64 expires,uint64 maxPricePerGiB6,uint128 budget6) public view returns(bytes32) {
        return keccak256(abi.encode("EnclaveConnectivity.tuna-policy.v1",block.chainid,address(this),address(ledger),id,
            ledger.get(id).owner,policies[id].nonce+1,providers,expires,maxPricePerGiB6,budget6));
    }
    function authorizeTuna(bytes32 id,bytes32[] calldata providers,uint64 expires,uint64 maxPricePerGiB6,uint128 budget6,bytes calldata signature) external {
        EnclaveDeployments.Deployment memory d=ledger.get(id);
        require(d.active&&expires>block.timestamp&&expires<=block.timestamp+30 days&&providers.length>0&&providers.length<=6);
        require(_signedBy(d.owner,tunaPolicyDigest(id,providers,expires,maxPricePerGiB6,budget6),signature));
        uint256 total;
        for(uint256 i;i<providers.length;i++){
            require(providers[i]!=bytes32(0)&&hosts[providers[i]].tuna&&qualifiedFor(providers[i],id));
            for(uint256 j;j<i;j++)require(providers[j]!=providers[i]);
            total+=hosts[providers[i]].pricePerGiB6;
        }
        require(total<=maxPricePerGiB6);
        uint64 nonce=policies[id].nonce+1;
        policies[id]=Policy(d.owner,nonce,expires,maxPricePerGiB6,budget6,0,ledger.runnerBps());
        viaTuna[id]=true;_tunaProviders[id]=providers;
        emit TunaAuthorized(id,nonce,providers);
    }
    function quoteTuna(bytes32 id,bytes32 providerId) public view returns(uint64 pricePerGiB6) {
        EnclaveDeployments.Deployment memory d=ledger.get(id);Policy memory p=policies[id];
        require(viaTuna[id]&&d.active&&d.leaseUntil>block.timestamp&&p.owner==d.owner&&p.expires>block.timestamp);
        bool included;uint256 total;bytes32[] storage providers=_tunaProviders[id];
        for(uint256 i;i<providers.length;i++){
            bytes32 h=providers[i];
            total+=hosts[h].pricePerGiB6;if(h==providerId)included=true;
        }
        require(included&&hosts[providerId].tuna&&qualifiedFor(providerId,id)&&total<=p.maxPricePerGiB6);
        return hosts[providerId].pricePerGiB6;
    }
    function tunaReceiptDigest(TunaReceipt calldata r) public view returns(bytes32) {
        return keccak256(abi.encode("EnclaveConnectivity.tuna-receipt.v1",block.chainid,address(this),address(ledger),r,blockhash(r.anchor)));
    }
    function settleTuna(TunaReceipt calldata r,bytes calldata runnerSignature,bytes calldata providerSignature) external {
        uint64 rate=quoteTuna(r.id,r.providerId);require(rate>0&&rate==r.pricePerGiB6);
        EnclaveDeployments.Deployment memory d=ledger.get(r.id);Policy storage p=policies[r.id];
        require(r.runnerId==d.runner&&r.leaseUntil==d.leaseUntil&&r.policyNonce==p.nonce&&r.issuedAt<=block.timestamp&&
            block.timestamp-r.issuedAt<=60&&r.anchor<block.number&&block.number-r.anchor<=256&&blockhash(r.anchor)!=bytes32(0));
        IEnclaveRegistry.Enclave memory runner=registry.get(d.runner);
        IEnclaveRegistry.Enclave memory provider=registry.get(r.providerId);
        require(runner.active&&runner.operator==d.runnerOperator&&provider.active);
        bytes32 digest=tunaReceiptDigest(r);
        require(_recover(digest,runnerSignature)==runner.proofKey&&_recover(digest,providerSignature)==provider.proofKey);
        bytes32 key=keccak256(abi.encode(r.id,r.providerId,r.policyNonce));
        uint128 previous=bytesServed[key];require(r.cumulativeBytes>previous);
        bytes32 policyKey=keccak256(abi.encode(r.id,r.policyNonce));uint256 oldUnits=policyUnits[policyKey];
        uint256 added=uint256(r.cumulativeBytes-previous)*rate;uint256 nextUnits=oldUnits+added;
        uint256 delta6=(nextUnits+GIB-1)/GIB-(oldUnits+GIB-1)/GIB;
        require(uint256(p.spent6)+delta6<=p.budget6);
        uint256 share6=(uint256(p.spent6)+delta6)*p.providerBps/10000-uint256(p.spent6)*p.providerBps/10000;
        bytesServed[key]=r.cumulativeBytes;units[key]+=added;policyUnits[policyKey]=nextUnits;p.spent6+=uint128(delta6);
        if(delta6>0)ledger.chargeBandwidth(r.id,delta6,share6,provider.operator);
        emit BandwidthCharged(r.id,r.providerId,delta6,units[key]);
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
