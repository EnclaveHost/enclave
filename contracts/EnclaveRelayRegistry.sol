// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title EnclaveRelayRegistry — permissionless discovery for the boxes that CARRY traffic.
/// @notice Hosts run apps; relays carry bytes to them. Two jobs, two trust
///         models, two registries. EnclaveRegistry answers "who will run my
///         code, and what code do they claim to run" — a question about
///         CONFIDENTIALITY, which is why every answer there is checked against a
///         live attestation. This contract answers "who will carry my bytes,
///         and from where" — a question about AVAILABILITY and METADATA, which
///         is a different thing and needs a different set of guarantees.
///
/// Why a relay does not have to be a TEE:
///   A relay terminates nothing and holds no key. It buffers a ClientHello,
///   reads the SNI, and splices ciphertext to the enclave that holds the lease;
///   the browser's TLS terminates INSIDE that enclave, against a certificate
///   whose private half never left it. So a relay cannot read a request, cannot
///   forge a response, and cannot impersonate an app — not because we trust it,
///   but because it is never handed anything to betray. Requiring attestation
///   here would make the relay set smaller and the traffic no more private.
///
/// What a relay CAN do, and what this contract is therefore built around:
///   - It sees the pair (client address, SNI) plus timing and volume. It cannot
///     read who you are talking ABOUT, but it knows who you are talking TO.
///     That is the real exposure, and it is why `attested` is recorded even
///     though it is not required: a router may PREFER relays that run in a TEE,
///     and an operator who wants that traffic has a reason to build one.
///   - It can refuse. Dropping a specific SNI is censorship that no amount of
///     cryptography prevents, and the answer is plurality — many registered
///     relays, enumerable by anyone from any RPC, so a client that is refused
///     has somewhere else to go. Discovery being on-chain is the whole point:
///     a relay set curated by one operator can be shrunk by that operator.
///   - It can accept a connection and blackhole it, which is indistinguishable
///     from being slow. Hence the bond.
///
/// On slashing, stated plainly: none of the misbehavior above is provable
/// on-chain. A censoring relay and an unreachable relay produce the same
/// silence, and a metadata harvester produces no evidence at all. `slashBond`
/// is therefore a GOVERNANCE action carrying public evidence in its reason
/// string, bounded by the bond — exactly the framing EnclaveDeployments uses
/// for its claim bond. It PRICES misbehavior; it does not detect it. Anyone
/// choosing relays should read the slash events as testimony, not as proof.
///
/// Registration is open, like the enclave registry's. The bond is not an entry
/// gate but a bar CONSUMERS apply: `minBond6` is the canonical number to filter
/// on, and a router that wants a higher one is free to demand it. Fail closed
/// when you consume this — a fresh entry is a claim, not a credential.
contract EnclaveRelayRegistry {
    struct Relay {
        string  endpoint;     // public address clients/DNS reach, e.g. "relay-sjc.enclave.host"
        string  region;       // free-form routing hint, e.g. "us-west" — the LATENCY lever:
                              // a relay is only worth using if it is near the enclave it fronts,
                              // so this is the field a router sorts on before anything else
        string  repo;         // attestation source if this relay runs measured code; "" = not attested
        bytes32 measurement;  // 0x0 = not attested. A CLAIM, checked against the live quote, never here
        address operator;     // controls this entry
        uint64  registeredAt;
        uint64  lastSeen;     // last heartbeat/update; readers judge staleness themselves
        uint64  caps;         // capability bits — see CAP_* below
        bool    active;       // operator-set; deregister flips to false
    }

    /// @dev Struct-shape revision, sniffed by consumers the way registrySchema
    ///      and deploymentsSchema are. New fields APPEND so earlier offsets
    ///      survive; a reader that decodes a short tail drops it rather than
    ///      misreading the next field.
    uint256 public constant relayRegistrySchema = 1;

    // Capability bits. A relay advertises what it will carry; a router matches
    // them against what a deployment declared. They are claims like everything
    // else here — the check that matters is whether the bytes actually flow.
    uint64 public constant CAP_APP_SNI    = 1 << 0;  // app-zone SNI passthrough (the 443 data path)
    uint64 public constant CAP_TCP_PORTS  = 1 << 1;  // declared raw tcp ports
    uint64 public constant CAP_UDP        = 1 << 2;  // declared udp ports
    uint64 public constant CAP_TUNNEL_HUB = 1 << 3;  // accepts reverse tunnels from enclaves with no inbound
                                                     // (the CGNAT seller's only way onto the network)

    struct Bond { uint192 amount6; uint64 exitAt; }

    address public owner;              // sets the bond bar and slashes; NOT a custodian
    address public pendingOwner;       // two-step handoff, mirroring the ledger
    address public payout;             // where slashed bond lands
    IERC20  public immutable usdc;

    uint256 public minBond6;           // advisory bar consumers filter on; 0 = bonding inert
    uint64  public bondExitDelay;      // timelock on leaving, so misbehavior can be priced before the bond walks

    bytes32[] private _ids;
    mapping(bytes32 => Relay) private _relays;
    mapping(bytes32 => bool)  private _exists;
    mapping(address => Bond)  private _bonds;

    event Registered(bytes32 indexed id, address indexed operator, string endpoint, string region);
    event Updated(bytes32 indexed id, string region, string repo, bytes32 measurement, uint64 caps);
    event Heartbeat(bytes32 indexed id, uint64 at);
    event Deregistered(bytes32 indexed id);
    event BondPosted(address indexed operator, uint256 amount6, uint256 total6);
    event BondExitRequested(address indexed operator, uint64 exitAt);
    event BondWithdrawn(address indexed operator, address indexed to, uint256 amount6);
    event BondSlashed(address indexed operator, uint256 amount6, string reason);
    event BondBarSet(uint256 minBond6, uint64 bondExitDelay);
    event OwnerChanged(address indexed owner);
    event PayoutChanged(address indexed payout);

    constructor(address _usdc, address _payout) {
        require(_usdc != address(0) && _payout != address(0), "zero addr");
        owner = msg.sender;
        payout = _payout;
        usdc = IERC20(_usdc);
    }

    /// @dev id is derived from the endpoint, so re-registering the same endpoint
    ///      updates its entry in place — and only its original operator may.
    function idOf(string calldata endpoint) public pure returns (bytes32) {
        return keccak256(bytes(endpoint));
    }

    /// @notice Create or update the caller's relay entry.
    /// @param region a routing hint a client can sort on. Free-form on purpose:
    ///        the useful granularity is "near which enclaves", and that is a
    ///        moving target no enum would survive. Wrong or stale values cost
    ///        the operator traffic, which is the right incentive.
    /// @param repo / measurement the attestation claim, or "" / 0x0 for a relay
    ///        that does not run measured code. NOT required — see the header.
    /// @param caps what this relay will carry (CAP_* bits).
    function register(string calldata endpoint, string calldata region, string calldata repo,
                      bytes32 measurement, uint64 caps)
        external
        returns (bytes32 id)
    {
        require(bytes(endpoint).length > 0, "endpoint required");
        require(caps != 0, "caps required");        // a relay that carries nothing is not a relay
        id = keccak256(bytes(endpoint));
        Relay storage r = _relays[id];
        if (_exists[id]) {
            require(r.operator == msg.sender, "not operator");
        } else {
            _exists[id] = true;
            _ids.push(id);
            r.operator = msg.sender;
            r.registeredAt = uint64(block.timestamp);
            r.endpoint = endpoint;
            emit Registered(id, msg.sender, endpoint, region);
        }
        r.region = region;
        r.repo = repo;
        r.measurement = measurement;
        r.caps = caps;
        r.lastSeen = uint64(block.timestamp);
        r.active = true;
        emit Updated(id, region, repo, measurement, caps);
    }

    /// @notice Change what this relay advertises without re-registering: it
    ///         moved region, started running measured code, or stopped carrying
    ///         udp. The endpoint itself is the identity and cannot change —
    ///         register the new one and deregister the old, so a client that
    ///         cached the old address learns it is gone rather than being
    ///         silently pointed somewhere new.
    function update(bytes32 id, string calldata region, string calldata repo,
                    bytes32 measurement, uint64 caps) external {
        Relay storage r = _relays[id];
        require(_exists[id], "unknown");
        require(r.operator == msg.sender, "not operator");
        require(caps != 0, "caps required");
        r.region = region;
        r.repo = repo;
        r.measurement = measurement;
        r.caps = caps;
        r.lastSeen = uint64(block.timestamp);
        emit Updated(id, region, repo, measurement, caps);
    }

    /// @notice Refresh liveness. Cheap; call on an interval.
    function heartbeat(bytes32 id) external {
        Relay storage r = _relays[id];
        require(_exists[id], "unknown");
        require(r.operator == msg.sender, "not operator");
        r.lastSeen = uint64(block.timestamp);
        r.active = true;
        emit Heartbeat(id, r.lastSeen);
    }

    /// @notice Mark this relay down (graceful shutdown). The entry is kept, so
    ///         its history — including any slash — stays readable.
    function deregister(bytes32 id) external {
        Relay storage r = _relays[id];
        require(_exists[id], "unknown");
        require(r.operator == msg.sender, "not operator");
        r.active = false;
        emit Deregistered(id);
    }

    // ----- bond ------------------------------------------------------------
    // Inert while minBond6 == 0 (the deploy default): nothing here needs
    // calling and no route depends on it. Turning it on does not gate
    // registration — it gives routers a number to filter on, and gives an
    // operator something to lose for carrying traffic badly.

    /// @notice Lock USDC as the caller's relay bond (adds to any existing bond;
    ///         cancels a pending exit — posting re-commits).
    function postBond(uint256 amount6) external {
        require(amount6 > 0, "amount=0");
        require(usdc.transferFrom(msg.sender, address(this), amount6), "USDC transfer failed");
        Bond storage b = _bonds[msg.sender];
        b.amount6 += uint192(amount6);                       // cast safe: real USDC received
        b.exitAt = 0;
        emit BondPosted(msg.sender, amount6, b.amount6);
    }

    /// @notice Start the timelocked exit. A bond in exit no longer meets the
    ///         bar (meetsBond goes false immediately), so a relay that is
    ///         leaving stops attracting new traffic while it drains.
    function requestBondExit() external {
        Bond storage b = _bonds[msg.sender];
        require(b.amount6 > 0, "no bond");
        b.exitAt = uint64(block.timestamp) + bondExitDelay;
        emit BondExitRequested(msg.sender, b.exitAt);
    }

    /// @notice Reclaim the whole bond once the timelock has passed.
    function withdrawBond(address to) external {
        require(to != address(0), "zero addr");
        Bond storage b = _bonds[msg.sender];
        require(b.exitAt != 0 && block.timestamp >= b.exitAt, "exit pending");
        uint256 amt = b.amount6;
        require(amt > 0, "no bond");
        delete _bonds[msg.sender];                           // effects before interaction
        require(usdc.transfer(to, amt), "USDC transfer failed");
        emit BondWithdrawn(msg.sender, to, amt);
    }

    /// @notice Slash (part of) an operator's bond, with public evidence in the
    ///         reason string. Owner-gated and bounded by the bond: a relay's
    ///         exposure to a hostile registry owner is the bond and never more,
    ///         which is the same bargain the ledger offers a host.
    function slashBond(address operator, uint256 amount6, string calldata reason) external {
        require(msg.sender == owner, "!owner");
        Bond storage b = _bonds[operator];
        require(amount6 > 0 && amount6 <= b.amount6, "range");
        b.amount6 -= uint192(amount6);
        require(usdc.transfer(payout, amount6), "USDC transfer failed");
        emit BondSlashed(operator, amount6, reason);
    }

    /// @notice The bar routers filter on: is this operator's bond at or above
    ///         the minimum and not on its way out? False while minBond6 is 0
    ///         only if a bond was never posted — with bonding inert everyone
    ///         passes, which is the correct reading of "the network does not
    ///         require one yet".
    function meetsBond(address operator) external view returns (bool) {
        Bond storage b = _bonds[operator];
        if (b.exitAt != 0) return false;
        return b.amount6 >= minBond6;
    }

    function bondOf(address operator) external view returns (uint256 amount6, uint64 exitAt) {
        Bond storage b = _bonds[operator];
        return (b.amount6, b.exitAt);
    }

    // ----- governance ------------------------------------------------------
    function setBondBar(uint256 _minBond6, uint64 _bondExitDelay) external {
        require(msg.sender == owner, "!owner");
        minBond6 = _minBond6;
        bondExitDelay = _bondExitDelay;
        emit BondBarSet(_minBond6, _bondExitDelay);
    }

    function setPayout(address _payout) external {
        require(msg.sender == owner, "!owner");
        require(_payout != address(0), "zero addr");
        payout = _payout;
        emit PayoutChanged(_payout);
    }

    function transferOwnership(address to) external {
        require(msg.sender == owner, "!owner");
        pendingOwner = to;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "!owner");
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerChanged(owner);
    }

    // ----- reads (off-chain discovery) -------------------------------------
    function count() external view returns (uint256) { return _ids.length; }
    function idAt(uint256 i) external view returns (bytes32) { return _ids[i]; }
    function get(bytes32 id) external view returns (Relay memory) { return _relays[id]; }

    /// @notice Paginated dump for clients (read the whole set with a few calls).
    function getPage(uint256 start, uint256 n) external view returns (Relay[] memory page) {
        uint256 len = _ids.length;
        if (start >= len) return new Relay[](0);
        uint256 end = start + n; if (end > len) end = len;
        page = new Relay[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = _relays[_ids[i]];
    }
}

/*
FUTURE (deliberately not implemented — the registry is useful without it):
  - PAYMENT. Relays are unpaid here, and that is the honest state of the art:
    bandwidth cannot be metered trustlessly, and a relay proving its own work is
    unsolvable. The tractable shape is host-signed receipts — the enclave is
    already an attesting party that already signs proof-of-time checkpoints, so
    it can attest "relay R carried my traffic across this window" — with the
    bond above making host/relay collusion expensive rather than impossible.
    That belongs in its own contract, against a settled receipt format.
  - REPUTATION. Derivable off-chain from Heartbeat/Deregistered/BondSlashed
    without any new storage. Keep it out of consensus until the metric is
    settled; an on-chain score is a number people optimize instead of behave.
  - ATTESTED RELAYS as a first-class tier (a proof key, verified quotes) once
    there is a measured relay image to point at. The field is here so the
    network can start preferring them the day one exists.
*/
