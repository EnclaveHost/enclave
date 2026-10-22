PROPOSAL (optional, UNAPPROVED, source only): app lease gas for deployments owned by existing credit vaults
=========================================================================================================
claude, 2026-10-21. work/credit-vault-final-integration. Nothing here is deployed, bound, funded or signed. Root reviews,
and asks for a concrete wallet approval if it chooses to proceed. The live reserve and its 11 enrolled apps (the 25
confirmed enrollment operations) are untouched by everything below.

0. IS A CONTRACT NEEDED AT ALL? (reuse first)
  Proven on a real EVM (../forge/test/CreditVaultReserveGap.t.sol, 9/9). Rig: the production vault bytecode, the live
  rev-16d ledger and main's reserve 1d173473, which is the live 0x12A3f873…: runtime hash 0xcc00efe9…, 13,204 bytes,
  matches the record.
  - The live reserve's configure/setClaimant need msg.sender == owner of record, and withdraw is keyed to msg.sender.
  - A credit vault (either build) can only call the ledger's allowlisted control functions. It has no ownerCall, and
    transferDeployment is not allowlisted.
  - The vault's ERC-1271 isValidSignature is a view, and no reserve function takes a signature.
  - The reserve admin cannot touch reserves.
  - The ledger's delegates (setDelegate) are not reachable from a vault either.
  - The live executor is immutable (reserve fixed), and the live reserve's one-time bindExecutor is spent.
  => No combination of the deployed contracts lets a vault-owned app use app-funded lease gas.
  Client changes alone can only REFUSE such deposits. That is done (section 4): the deposits are refused, and the
  apps are never silently enrolled.
  Live need today (read-only, block 52,880,903, two providers): 1 of 98 ledger records is credit-vault-owned. It is
  inactive, holds 4.95 USDC of escrow and has no reserve deposit. Recommendation: do NOT deploy this until a vault-owned
  app actually needs sponsored leases. The source and clients are ready for that day.

1. WHAT IS PROPOSED: a PARALLEL reserve beside the live one, never a replacement
  EnclaveLeaseGasReserveSig.sol = the live source 1d173473 plus:
    - configureBySig, setClaimantBySig and withdrawBySig;
    - their digest views configureDigest, claimantDigest and withdrawDigest;
    - the tags TAG_CONFIGURE, TAG_CLAIMANT and TAG_WITHDRAW, sigNonce(budgetKey), and the SignedAction event;
    - signerCodeRefused(codeHash), set in the constructor only, with the SignerCodeRefused event.
  reserve.diff is the exact diff against 1d173473. Every original selector is kept; exactly 11 are added (forge
  test_originalSurfaceIsKept).
  - Original paths: configure/setClaimant (msg.sender == owner) and withdraw (keyed to msg.sender) behave exactly as
    before. Their bodies moved into internal functions that both paths share.
  - Digest: keccak256(abi.encode(TAG_<action>, this reserve, chainid, id, owner, <args>, sigNonce[budgetKey(id, owner)],
    deadline)).
    - configure args: keccak256(abi.encode(policy)).
    - claimant args: (operator, allowed).
    - withdraw args: (amountWei, to).
  - Verifier: the owner's own isValidSignature(digest, signature), by staticcall. For a credit vault that is a WebAuthn
    P-256 assertion at the vault's pinned origin by an ACTIVE key. A removed passkey or a foreign origin fails (tested).
  - Current owner: configure/claimant re-read the ledger's owner of record at execution, so a signature made under a
    previous owner is void.
  - Withdraw: keyed to the SIGNER's own reserve, like withdraw() to msg.sender, with no ledger read. It pays only to
    the `to` inside the signature: never a default, never zero, never the reserve (on-chain "to"). The client also
    refuses the vault itself, because a vault cannot receive ETH. The existing withdraw() semantics are unchanged.
  - Refused signers: constructor-pinned runtime code hashes. The proposal refuses
    keccak256(EIP-1167 runtime of 0xaf81a594…c507) = the OLDER credit-vault build (factory 0x848a…, book vaultFactory
    2026-07-21 → 2026-08-03).
    - That build's isValidSignature does NOT check the signing origin. Tested with its actual Base runtime: an assertion
      made at https://evil.app.enclave.host is VALID for it.
    - So a phished assertion could otherwise reconfigure or withdraw its reserve.
    - Its signatures are refused whatever the origin, and the clients refuse first.
    - Live: no record is owned by an older-build vault.
  - EOA owners have no signature path ("owner is not a contract"); they keep the direct one.

2. EXACT EFFECTS
  Runtime: 16,125 bytes (EIP-170 margin 8,451), built like the live one (solc 0.8.35, viaIR, runs 1, prague). The live
    reserve is 13,204 bytes. The executor is reused byte-for-byte from source dc605ffa: runtime 2,659 bytes.
  Constructor: (ledger, registry, l1Oracle, Limits, bytes32[] refusedSignerCodeHashes). To mirror production:
    - ledger 0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B (rev 16d, the book's "deployments");
    - registry 0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC;
    - l1Oracle 0x420000000000000000000000000000000000000F;
    - Limits {1 gwei, 65000, 55000, 36000, 60, 10000}, i.e. the live reserve's current limits, read at block 52,880,903;
    - refusedSignerCodeHashes [keccak256(0x363d3d373d3d3d363d73 af81a59492409ab717afce6e72a425bdb2fac507
      5af43d82803e903d91602b57fd5bf3)].
    Then deploy EnclaveLeaseExecutor(reserve) and call reserve.bindExecutor(executor) from the admin, once.
  Admin: the same model as the live reserve, nothing added.
    - owner = the deployer: the platform admin, 0x0b2d009c… for the live one.
    - Admin writes: bindExecutor (once), setLimits, setPaused, setBlockedDeployment, setBlockedOperator,
      transferOwnership and acceptOwnership.
    - The admin has no path to any reserve and cannot change the refused signer list. Platform moderation (pause, block
      a deployment, block an operator) applies to this reserve too.
  Gas (forge, production vault bytecode, real P-256; execution gas inside the call):
    - configureBySig: 575,957 (an EOA's direct configure: 163,036).
    - setClaimantBySig: 507,978.
    - withdrawBySig: 474,963.
    The difference is the vault's WebAuthn check: base64url, the clientDataJSON prefix scan, two sha256 and the RIP-7212
    precompile. The submitter of a signed request pays it; neither the reserve nor the vault pays.
    A sponsored claim through the parallel executor charges the app 396,297 gas units (measured + intrinsic + calldata +
    overhead + the first EIP-7702 authorization) plus the L1 share. Same fee model as the live reserve.
  Deployment cost (estimate; Base read-only at block 52,882,839: base fee 0.005 gwei):
    - creation gas: 3,693,637 (reserve) + 688,862 (executor) + intrinsic, CREATE and calldata
      (17,354 + 2,990 initcode bytes), about 4.9M gas in total with bindExecutor;
    - about 0.000025 ETH at that base fee, plus the oracle's L1 upper bounds of 5.42e10 + 9.68e9 wei.
    - Below 0.0001 ETH even at 3x the base fee.
    Root funds nothing until it approves.
  Funding: nothing moves.
    - The live reserve's ETH (1,026,074,617,511,503 wei at block 52,880,903) and its enrollments stay in it.
    - Vault credit (closed-loop USDC) is never touched: tested, the vault nonce and balance are unchanged by any reserve
      action.
    - Deposits into the parallel reserve are ETH from any payer, credited to the vault's reserve there.
  Migration: none for existing apps.
    - EOA, Safe and SessionVault apps stay in the live reserve.
    - A vault-owned app's owner opts in by depositing and signing configure on the /credit/ page.
  Hosts (the real operational cost, stated plainly):
    - An operator key is EIP-7702-delegated to ONE executor at a time.
    - A host serves parallel-reserve apps only while delegated to the parallel executor, and live-reserve apps only while
      delegated to the live one (forge test_hostDelegationIsExclusivePerExecutor). With the other delegation:
      - a live-signed lease fails with BadSignature;
      - a parallel-signed lease for a live-only app fails with Refused(Disabled).
    - Switching costs an authorization each time, and each executor charges its authorization to the app only on the
      key's first lease through it. Switching back is therefore not reimbursed: the relayer bears about 25,000 gas plus
      105 L1 bytes. In forge, the first live claim charged 565,000,000 wei and the claim after switching back
      460,000,000 wei of L1 share.
    - Practical deployment: dedicate (or register) a host operator key for vault-owned apps, or switch rarely.
    - The lease runtime is record-driven: a host serves this reserve by being configured with its deployment record and
      delegated to its executor. Nothing in host code changes.

3. CLIENT INTEGRATION (in the candidate patch; compatibility-preserving)
  - site/js/core/credit-vault-reserve.js (NEW), the /credit/ page "App lease gas" section and the CLI/relay.
    Everything is inert unless a REVIEWED parallel-reserve record is configured; production credit-config.json has
    leaseGasReserve: null, so the page shows the live reserve's refusal and offers no deposit.
  - With a record, the reserve is verified at one agreed block:
    - its code hash and the executor's;
    - their mutual binding;
    - that its ledger is the book's "deployments" for the vault.
  - Operations (deposit, configure, claimant, withdraw):
    - the owner gives every policy field explicitly;
    - the client recomputes the digest AND reads it from the reserve's view;
    - the passkey signs only at the pinned origin, re-checked against the owner's current input;
    - the request goes through the same replaceable transports and the same held-until-decided journal (decided by the
      reserve's sigNonce or the deadline).
  - The untrusted submitter accepts reserve requests only when its operator configured the same reviewed record.

4. ALREADY DONE WITHOUT ANY CONTRACT (the deposit-stranding reconciliation, in the candidate patch)
  - network/lease-gas-owner.mjs lists BOTH factories the book has named; the older one is flagged originBound:false.
    A deployment owned by an older-build vault was classified "contract", and `lease-gas deposit` built a deposit for
    it. It is now refused like the current build.
  - An owner contract the CLI cannot identify:
    - `deposit` requires an explicit --owner-can-act (the payer confirms the contract can configure and withdraw itself);
    - `plan` lists the app refused instead of aborting the whole plan;
    - `status` warns instead of advising a deposit.
    Live: 2 such contracts own 11 inactive records (block 52,880,903).
