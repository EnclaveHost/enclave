OPTIONAL, UNAPPROVED CANDIDATE: signature-bound owner actions for EnclaveLeaseGasReserve (claude, 2026-10-20)
=========================================================================================================
Not a production source. Not deployed, bound, or referenced by any ready setup. The ready11 app-gas setup uses the
unmodified reserve (main contracts/EnclaveLeaseGasReserve.sol 1d173473, owned by Claude40c909).

WHY
  A deployment owned by an existing EnclaveCreditVault (production build d36100ae) cannot be enrolled in app-funded
  lease gas: configure/setClaimant need msg.sender == owner of record, withdraw is keyed to msg.sender, and the vault
  can originate no such call. Proven on a real EVM in ../forge/test/CreditVaultReserveGap.t.sol (9 tests: production
  vault bytecode, live rev-16d ledger, main reserve, real P-256 WebAuthn assertions; positive controls included).
  The only existing compatibility surface is the vault's ERC-1271 isValidSignature (a view). Nothing in the reserve
  consumes a signature. Existing credit vaults are immutable, and the vault and ledger are not to be modified.

WHAT (EnclaveLeaseGasReserve1271.sol; diff against 1d173473 = reserve.diff)
  - Every original function keeps its behaviour. The bodies of configure/setClaimant/withdraw moved into internal
    _configure/_setClaimant/_withdraw, which the msg.sender path and the signature path share.
  - Added: configureBySig(id, policy, deadline, sig), setClaimantBySig(id, operator, allowed, deadline, sig),
    withdrawBySig(id, owner, amountWei, to, deadline, sig); the three digest views; sigNonce(budgetKey); SignedAction.
  - Digest = keccak256(abi.encode(TAG_<action>, this reserve, block.chainid, id, owner, args..., sigNonce, deadline)),
    with one tag per action.
  - Protections:
      replay (per-(id, owner) nonce, consumed in order);
      domain (reserve address + chain id + per-action tag);
      deadline;
      CURRENT owner of record for configure and claimant (re-read at execution);
      owner must be a contract (EOAs keep the direct path);
      the owner's own isValidSignature via staticcall is the verifier. For a credit vault this is a passkey assertion
      at its pinned origin, by an active key, so a removed key or a foreign origin fails.
  - Size 15,876 B runtime (EIP-170 margin 8,700) at the ledger's settings (solc 0.8.35, viaIR, runs 1, prague).

TESTED (../forge/test/CandidateReserve1271.t.sol, 12 tests, against the production vault bytecode + live ledger + the
unmodified EnclaveLeaseExecutor)
  - The vault's passkey enrolls its own deployment. A zero-ETH host then claims it through an EIP-7702 delegation, and
    the vault-owned app's reserve pays the relayer exactly (vault nonce and USDC untouched).
  - Refused: replay, expiry, another chain, another reserve instance, a removed passkey (the remaining key works), an
    assertion from another origin, a tampered policy, the signature reused for another record, a tampered withdraw
    recipient, and an EOA owner on the signature path.
  - The original surface is kept: every selector of 1d173473 is present, and exactly 10 functions are added.

OPEN DECISIONS FOR ROOT / OWNER OF THE RESERVE
  - withdrawBySig sends the reserve's ETH to an owner-signed recipient. That ETH was gifted to the owner's reserve and is
    not closed-loop USDC credit, but counsel should confirm that a credit vault directing it elsewhere is acceptable.
    Dropping withdrawBySig leaves deposits enabled but unwithdrawable for vault owners.
  - Deploying it means a NEW reserve address (reserves are immutable): a governance and pinning decision, plus a client
    change in lease-gas-owner (kind "credit-vault" → configureBySig requests prepared for the /credit/ page to sign).
