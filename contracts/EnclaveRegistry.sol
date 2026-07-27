// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclaveRegistry — transparent, gateway-free discovery for Enclave enclaves.
/// @notice The on-chain source of truth for "which enclaves exist, where they
///         are, and what code they claim to run." There is NO trusted gateway:
///         a caller reads this registry from any RPC, then connects to an
///         enclave DIRECTLY and verifies its live attestation (Tinfoil's
///         SecureClient does the SEV-SNP/TDX + Sigstore checks). This contract
///         publishes the *slow-moving* truth (endpoint, repo, measurement,
///         liveness); live capacity is read from each enclave's /availability
///         off-chain. Nothing here is trusted — it is verified at connect time.
///
/// Trust model:
///   - Each entry is owned by the operator address that first registered its
///     endpoint. Only that operator can update / heartbeat / deregister it.
///     Registering does NOT make an enclave trusted — the `repo` + `measurement`
///     are CLAIMS a caller checks against the enclave's live attestation.
///   - PRICE is part of the entry (schema 2): an operator states what its
///     WHOLE machine costs per second — cpuPricePerSec6 for the node's
///     vCPU+RAM, gpuPricePerSec6 for one card's GPU+VRAM, USDC 6dp. That is
///     what a TENANT pays (the ledger pays the operator its runnerBps share of
///     it); a deployment buying gpuMilli/cpuMilli thousandths pays that
///     fraction of each. EnclaveDeployments reads these numbers when the
///     operator claims work, so the price an enclave advertises here is the
///     price it can actually charge — and a deployment's own rate cap is
///     checked against it. Re-pricing (setPrices) affects FUTURE claims only:
///     a live lease was bought at the price in force when it was claimed.
///   - Liveness is advisory: operators heartbeat; readers treat entries whose
///     lastSeen is older than a window of their choosing (e.g. 1h) as down.
///   - Open registration (anyone may register). Sybil resistance via
///     stake-to-register + slashing is a deliberate FUTURE addition (see notes);
///     it is not needed for correctness because attestation, not registration,
///     is what gates trust.
contract EnclaveRegistry {
    struct Enclave {
        string  endpoint;     // e.g. "https://svalbard.enclave.containers.tinfoil.dev"
        string  repo;         // attestation source, e.g. "EnclaveHost/enclave" (Sigstore-measured; exact casing)
        bytes32 measurement;  // optional cross-check digest (0x0 if unset); the live quote is authoritative
        address operator;     // controls this entry
        uint64  registeredAt;
        uint64  lastSeen;     // last heartbeat/update; readers judge staleness
        bool    active;       // operator-set; deregister flips to false
        // ---- price (schema 2; APPENDED so the first seven fields keep their
        // offsets — readers still sniff registrySchema before decoding) ------
        uint64  cpuPricePerSec6;  // USDC 6dp per second for the WHOLE node (vCPU+RAM)
        uint64  gpuPricePerSec6;  // USDC 6dp per second for ONE WHOLE card (GPU+VRAM); 0 on a CPU-only box
    }

    /// @dev Struct-shape revision, sniffed by consumers exactly as
    ///      EnclaveDeployments.deploymentsSchema is: rev 1 (no getter — the
    ///      call reverts there) had no prices and a three-argument register();
    ///      rev 2 appends the two per-machine prices and grows register() to
    ///      carry them, so an enclave states its price as it joins the network.
    uint256 public constant registrySchema = 2;

    bytes32[] private _ids;                       // all endpoint ids ever registered
    mapping(bytes32 => Enclave) private _enclaves;
    mapping(bytes32 => bool)    private _exists;

    event Registered(bytes32 indexed id, address indexed operator, string endpoint, string repo);
    event Updated(bytes32 indexed id, string repo, bytes32 measurement);
    event PricesSet(bytes32 indexed id, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6);
    event Heartbeat(bytes32 indexed id, uint64 at);
    event Deregistered(bytes32 indexed id);

    /// @dev id is derived from the endpoint, so re-registering the same endpoint
    ///      updates its entry in place (and only the original operator may).
    function idOf(string calldata endpoint) public pure returns (bytes32) {
        return keccak256(bytes(endpoint));
    }

    /// @notice Create or update the caller's enclave entry for `endpoint`, at
    ///         the per-second price it sells its whole machine for.
    /// @param cpuPricePerSec6 USDC 6dp/sec for the WHOLE node (vCPU+RAM). Must be
    ///        > 0: an enclave that sells compute states what it costs. Every
    ///        deployment buys some cpuMilli, so this price always applies.
    /// @param gpuPricePerSec6 USDC 6dp/sec for ONE WHOLE card. 0 on a CPU-only
    ///        box (and then GPU work simply prices at cpu-only, which no GPU
    ///        deployment can be served by anyway — runners refuse GPU work
    ///        without a card).
    function register(string calldata endpoint, string calldata repo, bytes32 measurement,
                      uint64 cpuPricePerSec6, uint64 gpuPricePerSec6)
        external
        returns (bytes32 id)
    {
        require(bytes(endpoint).length > 0, "endpoint required");
        require(cpuPricePerSec6 > 0, "cpu price required");
        id = keccak256(bytes(endpoint));
        Enclave storage e = _enclaves[id];
        if (_exists[id]) {
            require(e.operator == msg.sender, "not operator");
        } else {
            _exists[id] = true;
            _ids.push(id);
            e.operator = msg.sender;
            e.registeredAt = uint64(block.timestamp);
            e.endpoint = endpoint;
            emit Registered(id, msg.sender, endpoint, repo);
        }
        e.repo = repo;
        e.measurement = measurement;
        e.lastSeen = uint64(block.timestamp);
        e.active = true;
        e.cpuPricePerSec6 = cpuPricePerSec6;
        e.gpuPricePerSec6 = gpuPricePerSec6;
        emit Updated(id, repo, measurement);
        emit PricesSet(id, cpuPricePerSec6, gpuPricePerSec6);
    }

    /// @notice Re-price this enclave without re-registering. Affects FUTURE
    ///         claims only — a lease already taken was bought at the price in
    ///         force when it was claimed, and the ledger snapshotted it there.
    function setPrices(bytes32 id, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6) external {
        Enclave storage e = _enclaves[id];
        require(_exists[id], "unknown");
        require(e.operator == msg.sender, "not operator");
        require(cpuPricePerSec6 > 0, "cpu price required");
        e.cpuPricePerSec6 = cpuPricePerSec6;
        e.gpuPricePerSec6 = gpuPricePerSec6;
        e.lastSeen = uint64(block.timestamp);
        emit PricesSet(id, cpuPricePerSec6, gpuPricePerSec6);
    }

    /// @notice Refresh liveness. Cheap; call on an interval (e.g. every 15 min).
    function heartbeat(bytes32 id) external {
        Enclave storage e = _enclaves[id];
        require(_exists[id], "unknown");
        require(e.operator == msg.sender, "not operator");
        e.lastSeen = uint64(block.timestamp);
        e.active = true;
        emit Heartbeat(id, e.lastSeen);
    }

    /// @notice Update the claimed code (on redeploy) without re-registering.
    function setMeasurement(bytes32 id, string calldata repo, bytes32 measurement) external {
        Enclave storage e = _enclaves[id];
        require(_exists[id], "unknown");
        require(e.operator == msg.sender, "not operator");
        e.repo = repo;
        e.measurement = measurement;
        e.lastSeen = uint64(block.timestamp);
        emit Updated(id, repo, measurement);
    }

    /// @notice Mark this enclave down (graceful shutdown). Entry is kept for history.
    function deregister(bytes32 id) external {
        Enclave storage e = _enclaves[id];
        require(_exists[id], "unknown");
        require(e.operator == msg.sender, "not operator");
        e.active = false;
        emit Deregistered(id);
    }

    // ----- reads (off-chain discovery) -------------------------------------
    function count() external view returns (uint256) { return _ids.length; }
    function idAt(uint256 i) external view returns (bytes32) { return _ids[i]; }
    function get(bytes32 id) external view returns (Enclave memory) { return _enclaves[id]; }

    /// @notice Paginated dump for clients (read the whole set with a few calls).
    function getPage(uint256 start, uint256 n) external view returns (Enclave[] memory page) {
        uint256 len = _ids.length;
        if (start >= len) return new Enclave[](0);
        uint256 end = start + n; if (end > len) end = len;
        page = new Enclave[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = _enclaves[_ids[i]];
    }
}

/*
FUTURE (not implemented — open registry is correct without it):
  - stake-to-register: require msg.value/ERC20 bond on register(); refundable on
    clean deregister; slashable by a challenge if the enclave fails attestation
    or lies about liveness. Adds sybil resistance + economic skin-in-the-game.
  - challenge/slash: a watcher proves an entry's live attestation != its claimed
    measurement and claims part of the bond.
  These layer on top; they do not change that ATTESTATION (checked at connect by
  the caller's Tinfoil SecureClient), not registration, is what gates trust.
*/
