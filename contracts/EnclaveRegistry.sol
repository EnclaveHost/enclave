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
///   - PAYOUT WALLET (schema 4): the seller's own wallet — where this box's
///     earnings are swept (metal/config.json `payoutAddress`), published here
///     so it is part of the enclave's public record rather than private
///     supervisor config. It is DECLARED BY THAT WALLET, not by the operator:
///     setPayoutWallet takes no address argument and simply records msg.sender.
///     That direction is load-bearing, not a style choice. EnclaveDeployments
///     rev 12 hosts a deployment for FREE when this wallet is the deployment's
///     owner (a seller running their own app on their own box), and a free
///     lease is one the tenant's rate cap can no longer evict — so if an
///     operator could name any address here, it could push a stranger's
///     deployment into the free tier and squat its lease at zero cost. Making
///     the declaration a transaction FROM the wallet means the only address a
///     box can put here is one whose owner agreed, and clearPayoutWallet lets
///     that owner revoke it at any time.
///   - PROOF KEY (schema 3): the address half of a secp256k1 keypair MINTED
///     INSIDE the CVM at boot (like the TLS-bridge key and the ES256 session
///     key - the operator never sees the private half). EnclaveProofOfTime
///     verifies proof-of-time checkpoints against it: the enclave signs "app X
///     was running here at time T, anchored to block N", and the ledger pays
///     for PROVEN service instead of held lease time. Registering it is a
///     CLAIM like `measurement` is - anyone can fetch /v1/attestation over the
///     enclave's attested origin and check that the key served there is the
///     key on-chain. A mismatch is public, provable misbehavior (the ledger's
///     bond exists to price exactly that). The key rotates on every CVM
///     relaunch, because the CVM has no persistent disk to keep it on: the
///     enclave re-publishes with setProofKey at boot, and checkpoints are
///     always verified against the CURRENT entry.
///   - CAPABILITIES (schema 5): a registered box is no longer assumed to run
///     code. `caps` says what it does — CAP_HOST for an enclave that runs
///     tenants, the relay bits for one that carries traffic to them. A RELAY
///     NEED NOT BE A TEE, and that is not a compromise: it terminates nothing
///     and holds no key, so the browser's TLS still ends inside the enclave
///     that holds the lease and a relay is never handed anything to betray.
///     Demanding attestation of relays would shrink the relay set and buy no
///     privacy. What a relay unavoidably sees is the pair (client address,
///     SNI) — who you talk to, never what you say — so a relay that IS measured
///     is strictly better and says so by carrying CAP_HOST's neighbours plus a
///     real `measurement`. Routers may prefer those; nothing requires them.
///     Region is the latency lever: a relay is only worth using near the
///     enclave it fronts.
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
        // ---- proof of time (schema 3; APPENDED, same reason as the prices) --
        address proofKey;         // in-CVM secp256k1 signer for EnclaveProofOfTime checkpoints
                                  // (0x0 = this enclave posts no proofs and, once the ledger's
                                  // proof cutover has passed, cannot claim work)
        // ---- payout wallet (schema 4; APPENDED, same reason as the others) --
        address payoutWallet;     // the seller's own wallet, SET BY THAT WALLET (setPayoutWallet).
                                  // 0x0 = undeclared. Never written by register(): the operator
                                  // cannot set it, so re-registering at every boot leaves it alone.
        // ---- capabilities (schema 5; APPENDED, same reason as the others) ---
        uint64  caps;             // what this box DOES — see CAP_* below. 0 on every pre-schema-5
                                  // row, which is why 0 MUST read as CAP_HOST: those entries
                                  // predate the question and every one of them runs code.
        string  region;           // free-form routing hint ("us-west"), only meaningful to relays
    }

    // What a box does. Registering says WHERE you are; these say WHAT you are,
    // and the two are no longer the same question — a box with no TEE at all
    // can still carry the network's traffic, and one registry is where the
    // network looks for both.
    //
    // Read 0 as CAP_HOST. Every row written before schema 5 has caps == 0 and
    // every one of them is a running enclave, so a consumer that treats 0 as
    // "no capabilities" would silently empty the fleet the moment this deploys.
    uint64 public constant CAP_HOST       = 1 << 0;  // runs tenant code (needs a TEE; the thing `measurement` is about)
    uint64 public constant CAP_APP_SNI    = 1 << 1;  // carries app-zone traffic: SNI passthrough on the 443 data path
    uint64 public constant CAP_TCP_PORTS  = 1 << 2;  // carries declared raw tcp ports
    uint64 public constant CAP_UDP        = 1 << 3;  // carries declared udp ports
    uint64 public constant CAP_TUNNEL_HUB = 1 << 4;  // accepts reverse tunnels from boxes with no inbound
                                                     // (a CGNAT seller's only way onto the network)
    /// @dev every bit that makes a box a RELAY rather than a host.
    uint64 public constant CAP_RELAY_ANY  = CAP_APP_SNI | CAP_TCP_PORTS | CAP_UDP | CAP_TUNNEL_HUB;

    /// @dev Struct-shape revision, sniffed by consumers exactly as
    ///      EnclaveDeployments.deploymentsSchema is: rev 1 (no getter — the
    ///      call reverts there) had no prices and a three-argument register();
    ///      rev 2 appends the two per-machine prices and grows register() to
    ///      carry them, so an enclave states its price as it joins the network.
    ///      Rev 3 appends the proof key (and grows register() again), so an
    ///      enclave states WHICH in-CVM key signs its proof-of-time
    ///      checkpoints. A rev-9 EnclaveDeployments requires this field; the
    ///      two contracts deploy as a pair, exactly as rev 2 / rev 8 did.
    ///      Rev 4 appends the seller's payoutWallet and grows the surface by
    ///      setPayoutWallet/clearPayoutWallet — register() is UNCHANGED, since
    ///      the operator is deliberately not the party that may set it. A
    ///      rev-12 EnclaveDeployments requires this field (it charges nothing
    ///      when the wallet is the deployment's owner); the pair ships together
    ///      once more.
    ///      Rev 5 appends `caps` + `region` and grows the surface by
    ///      registerRelay/setCaps. register() is UNCHANGED and now also sets
    ///      CAP_HOST, so a box that re-registers at boot declares what it is
    ///      without anyone editing a call site. This is the revision that stops
    ///      assuming a registered box runs code: a relay has no measurement, no
    ///      proof key and no price, and belongs in this registry anyway.
    uint256 public constant registrySchema = 5;

    bytes32[] private _ids;                       // all endpoint ids ever registered
    mapping(bytes32 => Enclave) private _enclaves;
    mapping(bytes32 => bool)    private _exists;

    event Registered(bytes32 indexed id, address indexed operator, string endpoint, string repo);
    event Updated(bytes32 indexed id, string repo, bytes32 measurement);
    event PricesSet(bytes32 indexed id, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6);
    event ProofKeySet(bytes32 indexed id, address indexed proofKey);
    event PayoutWalletSet(bytes32 indexed id, address indexed payoutWallet);
    event CapsSet(bytes32 indexed id, uint64 caps, string region);
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
    /// @param proofKey the address half of the enclave's in-CVM proof-of-time
    ///        signer (schema 3). Registering at boot is how a freshly relaunched
    ///        CVM publishes the key it just minted; 0x0 is accepted (an enclave
    ///        that posts no proofs), but a rev-9 ledger refuses its claims once
    ///        the proof cutover has passed.
    function register(string calldata endpoint, string calldata repo, bytes32 measurement,
                      uint64 cpuPricePerSec6, uint64 gpuPricePerSec6, address proofKey)
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
        e.proofKey = proofKey;
        e.caps |= CAP_HOST;                          // OR, never assign: a box that also relays
                                                     // re-registers every boot and must not lose it
        emit Updated(id, repo, measurement);
        emit CapsSet(id, e.caps, e.region);
        emit PricesSet(id, cpuPricePerSec6, gpuPricePerSec6);
        emit ProofKeySet(id, proofKey);
    }

    /// @notice Join the network as a RELAY — a box that carries traffic rather
    ///         than running it. No price, no measurement, no proof key: none of
    ///         them mean anything for this job, and demanding them is what a
    ///         separate relay registry existed to avoid.
    /// @dev Deliberately a distinct name rather than an overload of register():
    ///      the artifact builder refuses overloaded selectors, and the two calls
    ///      genuinely say different things. A box that does BOTH calls both —
    ///      register() ORs in CAP_HOST and leaves the relay bits alone, this ORs
    ///      in the relay bits and leaves CAP_HOST alone — so the order it boots
    ///      in cannot cost it a role.
    ///
    ///      A relay does not have to be a TEE and this function is where that is
    ///      enforced by omission: it never touches `measurement`. It CAN be one,
    ///      and then it registers both ways, and a router reading this row sees a
    ///      relay whose routing code is measured — the only kind that cannot log
    ///      the (client address, SNI) pair it necessarily sees.
    /// @param region free-form routing hint, e.g. "us-west". Free-form because
    ///        the useful granularity is "near which enclaves", which no enum
    ///        survives; a wrong value costs the operator traffic, which is the
    ///        right incentive.
    /// @param caps which relay bits this box serves. At least one is required —
    ///        a relay that carries nothing is not a relay.
    function registerRelay(string calldata endpoint, string calldata region, uint64 caps)
        external
        returns (bytes32 id)
    {
        require(bytes(endpoint).length > 0, "endpoint required");
        require(caps & CAP_RELAY_ANY != 0, "relay caps required");
        require(caps & ~CAP_RELAY_ANY == 0, "relay caps only");   // CAP_HOST is register()'s to give
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
            emit Registered(id, msg.sender, endpoint, "");
        }
        e.caps |= caps;
        e.region = region;
        e.lastSeen = uint64(block.timestamp);
        e.active = true;
        emit CapsSet(id, e.caps, region);
    }

    /// @notice Set this box's capabilities and region ABSOLUTELY — the way to
    ///         give a role up. register()/registerRelay() only ever OR bits in,
    ///         because a box re-announcing one role must never silently drop the
    ///         other; dropping is a deliberate act and this is it.
    /// @dev Clearing CAP_HOST does not retract the measurement or the price, and
    ///      should not: they stay as the public record of what this box claimed
    ///      while it was hosting. What changes is that placement stops
    ///      considering it, which is the only thing the bit controls.
    function setCaps(bytes32 id, uint64 caps, string calldata region) external {
        Enclave storage e = _enclaves[id];
        require(_exists[id], "unknown");
        require(e.operator == msg.sender, "not operator");
        require(caps != 0, "caps required");          // 0 reads as CAP_HOST fleet-wide; deregister() is how you leave
        e.caps = caps;
        e.region = region;
        e.lastSeen = uint64(block.timestamp);
        emit CapsSet(id, caps, region);
    }

    /// @notice Publish the in-CVM key that signs this enclave's proof-of-time
    ///         checkpoints, without re-registering. Called at every boot: the
    ///         key lives only in the CVM's memory, so a relaunch mints a new
    ///         one and the entry must follow it or the ledger stops accepting
    ///         this enclave's proofs (and stops paying it).
    /// @dev Rotation is safe mid-lease. EnclaveProofOfTime verifies each
    ///      checkpoint against the key registered AT VERIFICATION TIME, and a
    ///      checkpoint is only redeemable for ~256 blocks after it is signed
    ///      (its block anchor), so rotating cannot invalidate proofs already
    ///      accepted and cannot revive proofs signed by the retired key.
    ///
    ///      Setting this to an address whose private half is NOT in the CVM is
    ///      the one lie this contract cannot catch - and the one anybody can:
    ///      the enclave serves its live proof key over the attested origin
    ///      (/v1/attestation), so a watcher compares the two and has public
    ///      evidence if they differ.
    function setProofKey(bytes32 id, address proofKey) external {
        Enclave storage e = _enclaves[id];
        require(_exists[id], "unknown");
        require(e.operator == msg.sender, "not operator");
        e.proofKey = proofKey;
        e.lastSeen = uint64(block.timestamp);
        emit ProofKeySet(id, proofKey);
    }

    /// @notice Declare that this enclave pays the CALLER — the seller's own
    ///         wallet, on-chain (schema 4). One transaction from that wallet
    ///         per box; the supervisor keeps sweeping earnings to it exactly as
    ///         before (this contract moves no money and redirects none).
    /// @dev Deliberately takes NO address parameter and does NOT check
    ///      msg.sender against the operator. Both follow from what the field is
    ///      for: EnclaveDeployments rev 12 stops charging a deployment whose
    ///      owner is this wallet, so the field is a consent record. Recording
    ///      msg.sender is what makes it unforgeable — an operator cannot name a
    ///      wallet it does not control, and therefore cannot pull a stranger's
    ///      deployment into the free (rate-cap-immune) tier. The mirror risk —
    ///      declaring for a box you do not operate, or once sold — is undone by
    ///      clearPayoutWallet below, which the declaring wallet may always call.
    ///
    ///      Callable before the entry has ever been claimed by anyone else's
    ///      declaration: a second wallet simply overwrites the first, which is
    ///      correct, because only the OPERATOR chooses which box carries the
    ///      declaration and only the WALLET chooses to be named. Neither can
    ///      act alone: a box with a hostile declaration earns the declaring
    ///      wallet nothing and can be cleared by its operator.
    function setPayoutWallet(bytes32 id) external {
        require(_exists[id], "unknown");
        _enclaves[id].payoutWallet = msg.sender;
        emit PayoutWalletSet(id, msg.sender);
    }

    /// @notice Withdraw the declaration. Either side may: the wallet (revoking
    ///         its consent — the escape hatch above) or the operator (a box
    ///         changing hands, or clearing a declaration it never wanted).
    function clearPayoutWallet(bytes32 id) external {
        Enclave storage e = _enclaves[id];
        require(_exists[id], "unknown");
        require(e.payoutWallet == msg.sender || e.operator == msg.sender, "not payee");
        e.payoutWallet = address(0);
        emit PayoutWalletSet(id, address(0));
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
