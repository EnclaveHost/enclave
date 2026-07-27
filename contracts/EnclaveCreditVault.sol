// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// EnclaveCreditVault - per-customer, passkey-gated, CLOSED-LOOP credit on Base.
///
/// A vault holds USDC that can only ever move TOWARD the platform:
///   - deployAndFund / fundDeployment: pay EnclaveDeployments (resolved through
///     the address book on every call, never a stored copy) for runtime the
///     vault then owns on-chain.
///   - refundToTreasury: the ONLY other outflow, to the factory-pinned company
///     treasury - used for the manual refund flow (customer signs the request,
///     the company refunds the card off-chain).
/// There is NO withdraw, NO arbitrary call, NO upgrade, NO owner. The company
/// cannot move funds: every operation requires a fresh WebAuthn P-256
/// signature from the customer's passkey (verified via the RIP-7212 precompile
/// at 0x…0100, live on Base since Fjord), and the destinations above are the
/// complete list. The customer cannot exit funds either: this is prepaid
/// service credit with on-chain accounting, not a wallet.
///
/// Anyone may SUBMIT a signed operation (the relay does, paying gas) - the
/// signature authorizes, the sender is irrelevant. Replay is stopped by a
/// per-vault nonce inside the signed digest; staleness by a deadline.
///
/// WebAuthn verification uses the spec's serialization guarantee
/// (CollectedClientData, Â§5.8.1.1: type, then challenge, then origin), so an
/// authenticator's clientDataJSON begins exactly with
///   {"type":"webauthn.get","challenge":"<base64url>","origin":"<origin>"
/// The vault requires that literal prefix - digest AND origin, the origin
/// terminated by its closing quote - then verifies sha256(authenticatorData ||
/// sha256(clientDataJSON)) against the registered P-256 public key. The UP flag
/// (authenticatorData[32] & 0x01) must be set.
///
/// The origin is not decoration. rpId "enclave.host" means every tenant app at
/// <label>.app.enclave.host may ask the same authenticator to sign, under a
/// prompt that names the RP as "enclave.host" - so type+challenge alone would
/// let a hostile app harvest a signature over ANY op digest, addKey included.
///
/// Deviations from EnclavePay conventions are deliberate and load-bearing:
/// no owner, no pause, no rescue - immutability IS the custody story.

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address who) external view returns (uint256);
}

interface IAddressBook {
    function addr(bytes32 key) external view returns (address);
}

contract EnclaveCreditVault {
    IERC20  public immutable usdc;
    IAddressBook public immutable book;
    address public immutable treasury;      // company cold wallet (refund destination)
    address public immutable factory;

    /* The ORIGIN a signing page must have been served from.
       A passkey's rpId is "enclave.host", and WebAuthn lets ANY origin under
       that registrable domain ask the authenticator to sign - which includes
       every tenant app, since deployments are served at
       <label>.app.enclave.host. A hostile app could therefore call
       navigator.credentials.get() with a vault-op digest as the challenge, and
       the OS prompt would name the RP as "enclave.host": indistinguishable from
       a real one. One tap on OP_ADDKEY registers the attacker's own passkey
       forever, so a single phish becomes permanent control of the vault.
       Checking type+challenge is not enough to stop that; only the origin
       distinguishes our page from a tenant's. The relay's own verifier has
       always passed expectedOrigin - this one had no equivalent.
       Two slots so an apex + www pair both work (slot 1 empty = unused); each
       is the origin's bytes left-aligned in a word, which fits every real
       origin ("https://enclave.host" is 20 bytes) and avoids parsing JSON. */
    bytes32 private immutable origin0;  uint256 private immutable origin0Len;
    bytes32 private immutable origin1;  uint256 private immutable origin1Len;

    // "deployments" as ascii-right-padded bytes32 (the address-book key)
    bytes32 private constant BOOK_KEY_DEPLOYMENTS =
        0x6465706c6f796d656e7473000000000000000000000000000000000000000000;
    address private constant P256_VERIFY = 0x0000000000000000000000000000000000000100;

    // deployment CONTROL selectors the vault will proxy (move no funds):
    bytes4 private constant SEL_SET_APP_REF = bytes4(keccak256("setAppRef(bytes32,string)"));
    bytes4 private constant SEL_SET_ACTIVE  = bytes4(keccak256("setActive(bytes32,bool)"));
    bytes4 private constant SEL_SET_SHARES  = bytes4(keccak256("setShares(bytes32,uint16,uint16)"));
    bytes4 private constant SEL_SET_CONFIG  = bytes4(keccak256("setConfig(bytes32,string)"));
    bytes4 private constant SEL_SET_MAX_RATE = bytes4(keccak256("setMaxRate(bytes32,uint256)"));
    // multicall is allowed ONLY when every inner call is itself an allowed
    // control selector (checked below) - a version change + share resize ride
    // one passkey signature without widening what a signature can move
    bytes4 private constant SEL_MULTICALL   = bytes4(keccak256("multicall(bytes[])"));

    // op type tags inside the signed digest (never reuse a value)
    bytes32 private constant OP_DEPLOY  = keccak256("EnclaveVault.deployAndFund.v1");
    bytes32 private constant OP_FUND    = keccak256("EnclaveVault.fundDeployment.v1");
    bytes32 private constant OP_CONTROL = keccak256("EnclaveVault.controlDeployment.v1");
    bytes32 private constant OP_REFUND  = keccak256("EnclaveVault.refundToTreasury.v1");
    bytes32 private constant OP_ADDKEY  = keccak256("EnclaveVault.addKey.v1");
    bytes32 private constant OP_DELKEY  = keccak256("EnclaveVault.removeKey.v1");

    mapping(bytes32 => bool) public keyActive;   // keccak256(x,y) -> registered passkey
    uint256 public keyCount;
    uint256 public nonce;                        // increments on every executed op
    bool private initialized;

    event KeyAdded(bytes32 indexed keyHash);
    event KeyRemoved(bytes32 indexed keyHash);
    event Deployed(bytes32 indexed id, uint256 funded6);
    event Funded(bytes32 indexed id, uint256 amount6);
    event Refunded(uint256 amount6);

    struct WebAuthnSig {
        bytes authenticatorData;   // >= 37 bytes, UP flag set
        string clientDataJSON;     // {"type":"webauthn.get","challenge":"<b64url(digest)>","origin":"<ours>"
        uint256 r;
        uint256 s;
        uint256 x;                 // public key - must hash to a registered key
        uint256 y;
    }

    constructor(IERC20 _usdc, IAddressBook _book, address _treasury,
                string memory _origin0, string memory _origin1) {
        usdc = _usdc; book = _book; treasury = _treasury; factory = msg.sender;
        // validate the locals: immutables cannot be READ during construction
        (bytes32 w0, uint256 n0) = _packOrigin(_origin0);
        require(n0 != 0, "origin required");           // never silently unchecked
        (bytes32 w1, uint256 n1) = _packOrigin(_origin1);   // "" = unused
        origin0 = w0; origin0Len = n0; origin1 = w1; origin1Len = n1;
        initialized = true;        // the implementation itself is never used directly
    }

    /// origin bytes, left-aligned in a word. Capped at 32 - long enough for any
    /// real origin, and a cap beats a loop over storage on every verify.
    function _packOrigin(string memory s) private pure returns (bytes32 w, uint256 n) {
        bytes memory b = bytes(s);
        n = b.length;
        require(n <= 32, "origin too long");
        for (uint256 i = 0; i < n; i++) w |= bytes32(b[i]) >> (i * 8);
    }

    function initialize(uint256 x, uint256 y) external {
        require(msg.sender == factory, "factory only");
        require(!initialized, "initialized");
        initialized = true;
        bytes32 kh = keccak256(abi.encode(x, y));
        keyActive[kh] = true; keyCount = 1;
        emit KeyAdded(kh);
    }

    // ---- operations (all passkey-signed; anyone submits) ------------------------

    /// create a deployment OWNED BY THIS VAULT on the current ledger and fund it.
    /// createCall is the abi-encoded create(...) calldata - the vault pins the
    /// SELECTOR and the ledger address, not the arg shape, so schema revisions
    /// (7-arg rev-3 vs 9-arg rev-4) need no vault redeploy. The deployment id
    /// comes from the ledger's return value, never from the caller.
    function deployAndFund(bytes calldata createCall, uint256 fund6, uint256 deadline, WebAuthnSig calldata sig)
        external returns (bytes32 id)
    {
        _auth(keccak256(abi.encode(OP_DEPLOY, address(this), block.chainid, nonce, keccak256(createCall), fund6, deadline)), deadline, sig);
        address dep = _deployments();
        require(bytes4(createCall[:4]) == bytes4(keccak256("create(string,uint16,uint16,uint32,string,bool,string)"))
             || bytes4(createCall[:4]) == bytes4(keccak256("create(string,uint16,uint16,uint32,string,bool,string,address,uint256)"))
             || bytes4(createCall[:4]) == bytes4(keccak256("create(string,uint16,uint16,uint32,string,bool,string,address,uint256,uint256)")),
             "not create()");
        (bool ok, bytes memory ret) = dep.call(createCall);
        require(ok, "create failed");
        id = abi.decode(ret, (bytes32));
        if (fund6 > 0) _fund(dep, id, fund6);
        emit Deployed(id, fund6);
    }

    function fundDeployment(bytes32 id, uint256 fund6, uint256 deadline, WebAuthnSig calldata sig) external {
        require(fund6 > 0, "amount=0");
        _auth(keccak256(abi.encode(OP_FUND, address(this), block.chainid, nonce, id, fund6, deadline)), deadline, sig);
        _fund(_deployments(), id, fund6);
    }

    /// owner-only ledger control calls for deployments this vault owns
    /// (setAppRef / setActive / setShares / setConfig / setMaxRate, or a
    /// multicall composed solely of them) - these move no funds. setShares
    /// re-prices the record at the serving enclave's posted prices; the balance
    /// it re-burns is the deployment's own prepaid accounting number, never
    /// vault USDC. setConfig rewrites the options envelope (waf/config
    /// namespaces), so a vault deployment gains rate limiting or a config
    /// override post-create. setMaxRate moves the deployment's spend ceiling -
    /// which enclaves may pick it up, and at what price - and can only ever
    /// change what the deployment's OWN prepaid balance buys.
    function controlDeployment(bytes calldata callData, uint256 deadline, WebAuthnSig calldata sig) external {
        _auth(keccak256(abi.encode(OP_CONTROL, address(this), block.chainid, nonce, keccak256(callData), deadline)), deadline, sig);
        bytes4 sel = bytes4(callData[:4]);
        if (sel == SEL_MULTICALL) {
            // the batcher passes ONLY when every inner call is an allowed
            // control selector - decode the bytes[] and check each head
            bytes[] memory calls = abi.decode(callData[4:], (bytes[]));
            require(calls.length > 0, "empty multicall");
            for (uint256 i = 0; i < calls.length; i++) {
                bytes memory c = calls[i];
                require(c.length >= 4, "short inner call");
                bytes4 inner;
                assembly { inner := mload(add(c, 32)) }
                require(inner == SEL_SET_APP_REF || inner == SEL_SET_ACTIVE || inner == SEL_SET_SHARES
                        || inner == SEL_SET_CONFIG || inner == SEL_SET_MAX_RATE, "inner selector not allowed");
            }
        } else {
            require(sel == SEL_SET_APP_REF || sel == SEL_SET_ACTIVE || sel == SEL_SET_SHARES
                 || sel == SEL_SET_CONFIG || sel == SEL_SET_MAX_RATE, "selector not allowed");
        }
        (bool ok, ) = _deployments().call(callData);
        require(ok, "control failed");
    }

    /// the manual-refund flow's on-chain half: customer-signed, funds go to the
    /// company treasury ONLY (the card/bank refund happens off-chain).
    function refundToTreasury(uint256 amount6, uint256 deadline, WebAuthnSig calldata sig) external {
        require(amount6 > 0, "amount=0");
        _auth(keccak256(abi.encode(OP_REFUND, address(this), block.chainid, nonce, amount6, deadline)), deadline, sig);
        require(usdc.transfer(treasury, amount6), "transfer failed");
        emit Refunded(amount6);
    }

    function addKey(uint256 x2, uint256 y2, uint256 deadline, WebAuthnSig calldata sig) external {
        _auth(keccak256(abi.encode(OP_ADDKEY, address(this), block.chainid, nonce, x2, y2, deadline)), deadline, sig);
        bytes32 kh = keccak256(abi.encode(x2, y2));
        require(!keyActive[kh], "key exists");
        keyActive[kh] = true; keyCount += 1;
        emit KeyAdded(kh);
    }

    function removeKey(bytes32 keyHash, uint256 deadline, WebAuthnSig calldata sig) external {
        _auth(keccak256(abi.encode(OP_DELKEY, address(this), block.chainid, nonce, keyHash, deadline)), deadline, sig);
        require(keyActive[keyHash], "no such key");
        require(keyCount > 1, "last key");
        keyActive[keyHash] = false; keyCount -= 1;
        emit KeyRemoved(keyHash);
    }

    // ---- ERC-1271: future session-auth for vault-owned deployments --------------
    // sig = abi.encode(WebAuthnSig); valid when a registered passkey signed a
    // WebAuthn assertion whose challenge is `hash`.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        WebAuthnSig memory sig = abi.decode(signature, (WebAuthnSig));
        if (_verify(hash, sig)) return 0x1626ba7e;
        return 0xffffffff;
    }

    // ---- internals --------------------------------------------------------------

    function _deployments() private view returns (address dep) {
        dep = book.addr(BOOK_KEY_DEPLOYMENTS);
        require(dep != address(0), "no deployments in book");
    }

    function _fund(address dep, bytes32 id, uint256 amount6) private {
        // spender is the BOOK-RESOLVED ledger, the only address ever approved
        if (usdc.allowance(address(this), dep) < amount6)
            require(usdc.approve(dep, type(uint256).max), "approve failed");
        (bool ok, ) = dep.call(abi.encodeWithSignature("fund(bytes32,uint256)", id, amount6));
        require(ok, "fund failed");
        emit Funded(id, amount6);
    }

    function _auth(bytes32 digest, uint256 deadline, WebAuthnSig calldata sig) private {
        require(block.timestamp <= deadline, "expired");
        WebAuthnSig memory m = sig;
        require(_verify(digest, m), "bad signature");
        nonce += 1;
    }

    function _verify(bytes32 digest, WebAuthnSig memory sig) private view returns (bool) {
        if (!keyActive[keccak256(abi.encode(sig.x, sig.y))]) return false;
        bytes memory auth = sig.authenticatorData;
        if (auth.length < 37 || (uint8(auth[32]) & 0x01) == 0) return false;   // UP flag
        // WebAuthn's serialization guarantee (CollectedClientData, §5.8.1.1):
        // type, then challenge, then origin, in that order. The first two say
        // this is an assertion over OUR digest; the third says it was our page
        // that asked - see the origin0/origin1 note above for why a tenant
        // subdomain can otherwise ask for the very same signature.
        bytes memory head = abi.encodePacked('{"type":"webauthn.get","challenge":"', _b64url(digest), '","origin":"');
        bytes memory cdj = bytes(sig.clientDataJSON);
        if (!_originIs(cdj, head, origin0, origin0Len) &&
            !(origin1Len != 0 && _originIs(cdj, head, origin1, origin1Len))) return false;
        bytes32 message = sha256(abi.encodePacked(auth, sha256(cdj)));
        (bool ok, bytes memory ret) = P256_VERIFY.staticcall(abi.encodePacked(message, sig.r, sig.s, sig.x, sig.y));
        return ok && ret.length == 32 && ret[31] == 0x01;
    }

    /// cdj starts with `head` followed by exactly this origin and its CLOSING
    /// quote. The quote is the whole point: without it "https://enclave.host"
    /// also matches "https://enclave.host.evil.example", which is a domain an
    /// attacker can simply register.
    function _originIs(bytes memory cdj, bytes memory head, bytes32 w, uint256 n) private pure returns (bool) {
        uint256 h = head.length;
        if (cdj.length < h + n + 1) return false;
        for (uint256 i = 0; i < h; i++) if (cdj[i] != head[i]) return false;
        for (uint256 i = 0; i < n; i++) if (cdj[h + i] != w[i]) return false;
        return cdj[h + n] == '"';
    }

    function _b64url(bytes32 v) private pure returns (bytes memory out) {
        bytes memory tab = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        out = new bytes(43);   // 32 bytes -> ceil(32/3)*4 = 44, unpadded = 43
        uint256 bits; uint256 nbits; uint256 j;
        for (uint256 i = 0; i < 32; i++) {
            bits = (bits << 8) | uint8(v[i]); nbits += 8;
            while (nbits >= 6) { nbits -= 6; out[j++] = tab[(bits >> nbits) & 0x3f]; }
        }
        out[j] = tab[(bits << (6 - nbits)) & 0x3f];   // final 4 bits, left-aligned
    }
}

/// Deploys one implementation, then CREATE2 EIP-1167 clones keyed by the first
/// passkey - so a customer's vault address is knowable (and fundable) before
/// it exists on-chain. Anyone may instantiate; initialize() is factory-gated
/// and the salt binds the address to the key, so there is nothing to front-run.
contract EnclaveCreditVaultFactory {
    EnclaveCreditVault public immutable implementation;
    event VaultCreated(bytes32 indexed keyHash, address vault);

    /// origin0 is the site's canonical origin (e.g. "https://enclave.host");
    /// origin1 is an optional second (a www pair), "" when unused. These bind
    /// what a passkey assertion must have been signed from - see the note on
    /// EnclaveCreditVault.origin0. A local rig passes its own origin.
    constructor(IERC20 usdc, IAddressBook book, address treasury,
                string memory origin0, string memory origin1) {
        implementation = new EnclaveCreditVault(usdc, book, treasury, origin0, origin1);
    }

    function vaultFor(uint256 x, uint256 y) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff), address(this), keccak256(abi.encode(x, y)), keccak256(_cloneCode()))))));
    }

    function createVault(uint256 x, uint256 y) external returns (address vault) {
        bytes32 salt = keccak256(abi.encode(x, y));
        bytes memory code = _cloneCode();
        assembly { vault := create2(0, add(code, 0x20), mload(code), salt) }
        require(vault != address(0), "exists");
        EnclaveCreditVault(vault).initialize(x, y);
        emit VaultCreated(salt, vault);
    }

    function _cloneCode() private view returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
            address(implementation),
            hex"5af43d82803e903d91602b57fd5bf3");
    }
}
