// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclaveFeatured — the app store's featured slot, sold by per-view bid.
/// @notice The Apps page shows ONE featured listing. Any publisher (or fan —
///         anyone may fund) opens a campaign for a catalog app, names a USDC
///         price they'll pay PER VIEW, and escrows a budget here. Readers (the
///         site) rank standing campaigns and show the highest funded bid whose
///         app is approved + listed in the EnclaveAppCatalog; the contract
///         itself does not rank — ranking is a read-side rule, so it can
///         evolve (ties, rotation, category slots) without a migration.
///
///         Views are counted OFF-chain: the site beacons each featured
///         impression to the API gateway, which dedupes per client per day.
///         The owner periodically settles a campaign's metered count here,
///         drawing bid × views from its escrow to `payout`. The advertiser's
///         protections are structural: the spend can never exceed what they
///         escrowed, the per-view price is theirs, and the unspent balance is
///         withdrawable at ANY time — an advertiser who distrusts the meter
///         exits whole. (The meter can under-charge an advertiser, never
///         over-charge beyond their own deposit.)
///
///         What may be featured is the CATALOG's law, not this contract's:
///         readers only surface campaigns whose app is currently approved and
///         listed, and the owner can setActive(false) a campaign outright
///         (policy), leaving its balance withdrawable.
///
/// Funding (two paths, mirroring EnclaveDeployments):
///   - fundWithAuthorization: EIP-3009 receiveWithAuthorization — one
///     signature, no allowance left behind, relayable (the payer needs no
///     gas). The authorization's nonce must start with the first 16 bytes of
///     the campaign's appId, binding the signature to ONE campaign so a
///     relayer can't credit a different one with the payer's money.
///   - fund: plain approve + transferFrom, for payers whose address carries
///     code (smart wallets / EIP-7702 delegations, which USDC's EIP-3009
///     signature checker rejects).
interface IERC20Auth {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    /// EIP-3009 (FiatTokenV2_2 bytes-signature variant). Reverts unless to == msg.sender.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

contract EnclaveFeatured {
    struct Campaign {
        bytes32 appId;        // EnclaveAppCatalog app this campaign features
        address advertiser;   // opened the campaign; sole withdrawer / re-bidder
        uint256 bidPerView6;  // USDC (6dp) offered per metered view
        uint256 balance6;     // escrowed budget still unspent
        uint256 spent6;       // lifetime settled spend (accounting)
        uint64  createdAt;    // block time the campaign opened (read-side tie-break)
        bool    active;       // advertiser pause / owner policy switch
    }

    /// @notice Struct-schema revision, for readers: 1 = this layout.
    uint256 public constant featuredSchema = 1;

    address public owner;             // settles metered views; policy switch; can hand off
    address public pendingOwner;      // two-step handoff: must acceptOwnership()
    address public payout;            // where settled USDC lands (the Enclave cold wallet)
    IERC20Auth public immutable usdc; // USDC token (Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)

    /// @notice Sanity cap on a bid (fat-finger guard, owner-adjustable like the
    ///         catalog's maxFeePerSec6). 10000 = $0.01 per view.
    uint256 public maxBidPerView6 = 10000;

    mapping(bytes32 => Campaign) private _campaigns;   // appId -> campaign (one per app)
    bytes32[] private _ids;                            // append-only, for paging

    event CampaignPlaced(bytes32 indexed appId, address indexed advertiser, uint256 bidPerView6);
    event CampaignFunded(bytes32 indexed appId, address indexed payer, uint256 amount6);
    event CampaignWithdrawn(bytes32 indexed appId, uint256 amount6);
    event CampaignSettled(bytes32 indexed appId, uint256 views, uint256 charge6);
    event CampaignActiveSet(bytes32 indexed appId, bool active);
    event MaxBidSet(uint256 maxBidPerView6);
    event PayoutChanged(address indexed payout);
    event OwnerChanged(address indexed owner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    constructor(address _usdc, address _payout) {
        require(_usdc != address(0) && _payout != address(0), "zero addr");
        owner = msg.sender;
        usdc = IERC20Auth(_usdc);
        payout = _payout;
        emit PayoutChanged(_payout);
        emit OwnerChanged(msg.sender);
    }

    /// @notice Open a campaign for `appId`, or re-price your existing one.
    ///         The first caller becomes the campaign's advertiser; re-pricing
    ///         applies to future settlements only (already-metered views are
    ///         settled at whatever the bid is WHEN the owner settles — an
    ///         advertiser who lowers a bid mid-window pays the lower price,
    ///         which errs against the platform, never the advertiser).
    function place(bytes32 appId, uint256 bidPerView6) external {
        require(appId != bytes32(0), "zero app");
        require(bidPerView6 > 0 && bidPerView6 <= maxBidPerView6, "bid out of range");
        Campaign storage c = _campaigns[appId];
        if (c.advertiser == address(0)) {
            c.appId = appId;
            c.advertiser = msg.sender;
            c.createdAt = uint64(block.timestamp);
            c.active = true;
            _ids.push(appId);
        } else {
            require(msg.sender == c.advertiser, "!advertiser");
        }
        c.bidPerView6 = bidPerView6;
        emit CampaignPlaced(appId, c.advertiser, bidPerView6);
    }

    /// @notice Escrow budget into a campaign via allowance (approve first).
    ///         Anyone may fund any campaign; only the advertiser withdraws.
    function fund(bytes32 appId, uint256 amount6) external {
        Campaign storage c = _campaigns[appId];
        require(c.advertiser != address(0), "no campaign");
        require(amount6 > 0, "zero amount");
        require(usdc.transferFrom(msg.sender, address(this), amount6), "transferFrom failed");
        c.balance6 += amount6;
        emit CampaignFunded(appId, msg.sender, amount6);
    }

    /// @notice Escrow budget with a signed USDC authorization (EIP-3009).
    ///         Callable by anyone (relayable); the nonce's first 16 bytes must
    ///         equal the appId's first 16 bytes, binding the signature to this
    ///         campaign (USDC itself already requires to == this contract).
    function fundWithAuthorization(
        bytes32 appId,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        Campaign storage c = _campaigns[appId];
        require(c.advertiser != address(0), "no campaign");
        require(value > 0, "zero amount");
        require(bytes16(nonce) == bytes16(appId), "nonce not bound to app");
        usdc.receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, signature);
        c.balance6 += value;
        emit CampaignFunded(appId, from, value);
    }

    /// @notice Pull unspent budget back out — the advertiser's any-time exit.
    ///         amount6 = 0 withdraws the whole remaining balance.
    function withdraw(bytes32 appId, uint256 amount6) external {
        Campaign storage c = _campaigns[appId];
        require(msg.sender == c.advertiser, "!advertiser");
        uint256 amt = amount6 == 0 ? c.balance6 : amount6;
        require(amt > 0 && amt <= c.balance6, "bad amount");
        c.balance6 -= amt;                       // effects before interaction
        require(usdc.transfer(c.advertiser, amt), "transfer failed");
        emit CampaignWithdrawn(appId, amt);
    }

    /// @notice Settle a metered view count: draw bid × views from the escrow
    ///         to `payout`, capped at the campaign's balance. Owner-only (the
    ///         gateway's deduped counter is the meter; see the contract-level
    ///         note on why the advertiser is safe from over-charging).
    function settle(bytes32 appId, uint256 views) external {
        require(msg.sender == owner, "!owner");
        Campaign storage c = _campaigns[appId];
        require(c.advertiser != address(0), "no campaign");
        uint256 charge = views * c.bidPerView6;
        if (charge > c.balance6) charge = c.balance6;
        if (charge > 0) {
            c.balance6 -= charge;
            c.spent6 += charge;
            require(usdc.transfer(payout, charge), "transfer failed");
        }
        emit CampaignSettled(appId, views, charge);
    }

    /// @notice Pause/resume a campaign. The advertiser manages their own;
    ///         the owner's switch is the policy lever (a delisted campaign's
    ///         balance stays withdrawable — moderation never confiscates).
    function setActive(bytes32 appId, bool active) external {
        Campaign storage c = _campaigns[appId];
        require(msg.sender == c.advertiser || msg.sender == owner, "!advertiser/owner");
        c.active = active;
        emit CampaignActiveSet(appId, active);
    }

    /* ---- reads ---- */
    function campaignCount() external view returns (uint256) { return _ids.length; }
    function getCampaign(bytes32 appId) external view returns (Campaign memory) { return _campaigns[appId]; }
    function getCampaignsPage(uint256 start, uint256 n) external view returns (Campaign[] memory page) {
        uint256 total = _ids.length;
        if (start >= total) return new Campaign[](0);
        uint256 end = start + n; if (end > total) end = total;
        page = new Campaign[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = _campaigns[_ids[i]];
    }

    /* ---- admin ---- */
    function setMaxBid(uint256 _maxBidPerView6) external {
        require(msg.sender == owner, "!owner");
        require(_maxBidPerView6 > 0, "zero cap");
        maxBidPerView6 = _maxBidPerView6;
        emit MaxBidSet(_maxBidPerView6);
    }
    function setPayout(address _payout) external {
        require(msg.sender == owner, "!owner");
        require(_payout != address(0), "zero addr");
        payout = _payout;
        emit PayoutChanged(_payout);
    }
    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "!owner");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "!pendingOwner");
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerChanged(owner);
    }
}
