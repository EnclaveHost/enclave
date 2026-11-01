// SPDX-License-Identifier: UNLICENSED
// TEST DOUBLES ONLY (lifecycle-chain-adapter-stage r5; r4 doubles corrected to the ACTUAL ABIs, proven by test/deployment-chain-adapter-r5-abi.test.mjs). The LEDGER, CONTROLLER and IDENTITY in the r4 suites are the REAL candidate
// artifacts (deploy/lifecycle/artifacts/*.json); these doubles reproduce only external surfaces around them:
//   - registry / catalog / address book / L1 oracle views (34a3c0d6 shapes, as the r2 doubles),
//   - a 6-decimals USDC (approve/transfer/transferFrom) for the real ledger's fund(),
//   - EnclaveHostOwnership.authority(bytes32) (the production host-admission-policy read),
//   - the seven closure members with EXACTLY the address getters of KVM dependencies-r1/abi.json (deb51211); a SessionVault factory whose
//     authorityPins[3] / implementation / isVault / vaultFor match the PinnedSessionVaultFactory surface, and a legacy-ledger stand-in.
pragma solidity 0.8.35;
struct Enclave {
    string endpoint; string repo; bytes32 measurement; address operator; uint64 registeredAt; uint64 lastSeen; bool active;
    uint64 cpuPricePerSec6; uint64 gpuPricePerSec6; address proofKey; address payoutWallet; uint64 caps; string region;   // 34a3 EnclaveRegistry ABI: 13 fields
}
struct App { bytes32 appId; address publisher; string slug; string name; string description; uint32 versionCount; uint64 createdAt; uint64 updatedAt; bool active; }
struct Version { string cid; string version; uint32 vramMb; uint32 gpuGflops; uint32 memMb; uint32 cpuGflops; uint64 createdAt; bool verified; bool yanked; string ports; uint8 approval; string config; }
contract TestRegistry {
    mapping(bytes32 => Enclave) internal _e;
    function set(bytes32 h, Enclave calldata e) external { _e[h] = e; }
    function get(bytes32 h) external view returns (Enclave memory) { return _e[h]; }
    function registrySchema() external pure returns (uint256) { return 4; }
}
contract TestCatalog {
    App internal _a; Version internal _v;
    function set(App calldata a, Version calldata v) external { _a = a; _v = v; }
    function getApp(bytes32) external view returns (App memory) { return _a; }
    function getVersion(bytes32, uint256) external view returns (Version memory) { return _v; }
}
contract TestAddressBook {
    address public owner; address public pendingOwner; bytes32[] internal _n; address[] internal _a;
    constructor(address o) { owner = o; }
    function put(bytes32 n, address a) external { _n.push(n); _a.push(a); }
    function all() external view returns (bytes32[] memory, address[] memory) { return (_n, _a); }
    function addr(bytes32 n) external view returns (address) { for (uint256 i; i < _n.length; ++i) if (_n[i] == n) return _a[i]; return address(0); }
    function setPendingOwner(address p) external { pendingOwner = p; }
}
contract TestL1Oracle { function getL1FeeUpperBound(uint256) external pure returns (uint256) { return 1000; } }
contract TestUSDC {
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
    function decimals() external pure returns (uint8) { return 6; }
    function mint(address to, uint256 v) external { balanceOf[to] += v; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; return true; }
}
contract TestHostOwnership {
    struct A { address owner; address pendingOwner; uint64 revision; bytes32 policyHash; }
    mapping(bytes32 => A) internal _a;
    function set(bytes32 h, address o, uint64 rev, bytes32 ph) external { _a[h] = A(o, address(0), rev, ph); }
    function authority(bytes32 h) external view returns (address owner, address pendingOwner, uint64 revision, bytes32 policyHash) {
        A memory a = _a[h]; return (a.owner, a.pendingOwner, a.revision, a.policyHash); }
}
contract LegacyLedgerStandIn { uint256 public constant legacy = 1; }
// closure members: address getters exactly as dependencies-r1/abi.json
contract R4Connectivity { address public immutable ledger; address public immutable registry; constructor(address l, address r) { ledger = l; registry = r; } }
contract R4PinnedSessionAuthority {
    address public immutable appCatalog; address public immutable deployments; address public sessionVaultFactory;
    constructor(address c, address l) { appCatalog = c; deployments = l; }
    function init(address f) external { require(sessionVaultFactory == address(0)); sessionVaultFactory = f; }
}
contract R4ProofOfTime {
    address public immutable deployments; address public immutable registry; address public owner; address public pendingOwner;
    constructor(address l, address r, address o) { deployments = l; registry = r; owner = o; }
}
contract R4SecretVaultV2 {
    address public immutable book; address public immutable deploymentLedger; address public immutable enclaveOwner; address public immutable hostOwnership;
    address public immutable hostRegistry; address public immutable sessionVaultFactory;
    constructor(address b, address l, address e, address h, address r, address f) { book = b; deploymentLedger = l; enclaveOwner = e; hostOwnership = h; hostRegistry = r; sessionVaultFactory = f; }
}
contract R4VerificationFees { address public immutable ledger; address public immutable proof; address public immutable token;
    constructor(address l, address p, address t) { ledger = l; proof = p; token = t; } }
contract R4SessionVaultImplementation {
    address public book; address public factory; address public immutable keyAttestations; address public immutable router; address public immutable usdc;
    address public owner;                       // the implementation itself is ownerless (zero)
    constructor(address k, address r, address u) { keyAttestations = k; router = r; usdc = u; }
    function init(address b, address f) external { require(factory == address(0)); book = b; factory = f; }
}
contract R4Vault {
    address public owner; constructor(address o) { owner = o; }
    function exec(address t, bytes calldata d) external returns (bytes memory r) { require(msg.sender == owner); bool ok; (ok, r) = t.call(d); require(ok); }
}
contract R4VaultFactory {
    address internal immutable pinLedger; address internal immutable pinCatalog; address internal immutable pinAuthority; address public immutable implementation;
    mapping(address => bool) public isVault; mapping(address => address) public vaultFor;
    constructor(address[3] memory p, address impl) { pinLedger = p[0]; pinCatalog = p[1]; pinAuthority = p[2]; implementation = impl; }
    // dependencies-r1 PinnedSessionVaultFactory: authorityPins() returns (address ledger, address catalog, address authority)
    function authorityPins() external view returns (address ledger, address catalog, address authority) { return (pinLedger, pinCatalog, pinAuthority); }
    function make(address o) external returns (address v) { v = address(new R4Vault(o)); isVault[v] = true; vaultFor[o] = v; }
}
