# Existing credit vaults without the Enclave service

Customers who bought credit by card hold it in an **EnclaveCreditVault**. This is an immutable clone per passkey, minted
by the credit-vault factory. The live factory is `0xa891e439…4e91`, built from source `d36100ae`. Every operation on
the vault carries a WebAuthn P-256 assertion from the customer's passkey, and **anyone may submit it**. The hosted
`/v1/billing/vault/prepare` + `/exec` endpoints use an account session. They prepare the digest and pay the gas, but
they hold no authority. This page describes the path that needs neither them nor the account database. The hosted path
is unchanged and stays the default.

| Piece | File |
|---|---|
| Shared core (browser, CLI, relay) | `site/js/core/credit-vault-independent.js` |
| Page at the vault's origin | `site/credit/` (`index.html`, `credit.js`, `credit-config.json`), shipped like `/recover/` |
| Browser primitives | `site/vendor/credit-vault.js`: viem ABI, ox WebAuthn, @noble P-256/SHA-256; built by `scripts/build-credit-vault-vendor.mjs` |
| CLI and untrusted relay | `cli/credit-vault.mjs`, also `enclave credit-vault …` |
| Tests | `test/credit-vault-core.test.mjs`, `test/credit-vault-independent.test.mjs`, `test/credit-vault-browser.test.mjs`, runner `test/run-credit-vault.sh` |

## What the owner does

1. **Choose chain endpoints.** Give 2-8 Base RPC URLs and a quorum. Every read is taken at one block that a quorum agrees
   on, through `js/core/quorum.js` (site) or the same reader in the CLI. This is RPC agreement, not a light client.
2. **Find the vault.** Any of these works:
   - the passkey alone: two taps, after which the public key is recovered from the two signatures (P-256 recovery);
   - a saved vault profile;
   - the hosted account's EAB1 migration file.

   The address is CREATE2 of the key at every pinned factory. It is checked against the factory's own `vaultFor`, the
   exact EIP-1167 runtime code and `keyActive`. A passkey added after minting does not derive the address. It needs the
   vault address, which is then checked the same way.
3. **Prepare an operation.** The page builds it locally from its own form input:
   - `deployAndFund`: no publisher fee, the owner's rate cap, and an amount up to what the owner typed, capped at the balance;
   - `fundDeployment`;
   - `controlDeployment`: suspend, resume, version, resize (with an optional version and active flag in one multicall),
     options, rate cap, or cancel (the ledger's `refund`, which pays the unused runtime back into the vault);
   - `refundToTreasury`: requires an explicit acknowledgement that the credit goes to the company treasury and the card
     refund is processed off-chain;
   - `addKey` and `removeKey`.

   The ledger is `book.addr("deployments")` as the vault reads it, so the platform address book stays authoritative for
   ledger versions.
4. **Sign.** This works only when `location.origin` equals the vault's pinned origin; anywhere else is refused before
   any prompt. The form is read again at signing time and must match the prepared operation exactly. The assertion is
   then checked locally, both its shape (the contract's prefix rule and the UP flag) and the P-256 signature under the
   profile's key. The result is a **SignedVaultRequest** `{chainId, vault, op, nonce, deadline, digest, to, data}`. It
   contains no secret and is valid for one nonce until its deadline (at most 10 minutes of chain time).
5. **Send.** The payer is always explicit. The transport is replaceable:
   - the owner's wallet (EIP-1193);
   - the CLI with the owner's payer key, sending the same signed bytes to every RPC;
   - an untrusted relay (`enclave credit-vault relay`), which can submit those exact bytes or drop them, never change them.

   A request is written to the owner's journal **before** it leaves the device. If its outcome is unknown, it is held
   and nothing new is prepared for that vault. `reconcile` decides it from an agreed read of the vault nonce and chain time:
   - **executed**: a transaction carrying exactly these bytes succeeded. It is found by hash, or, when the reply was
     lost, in the vault's or ledger's logs within the request's lifetime;
   - **superseded**: the nonce went to another operation;
   - **expired**: the nonce is unchanged after the deadline;
   - **pending**: still undecided. Hold it; resending the same bytes is the only safe repeat.

   One nonce means each request executes at most once, so a retry never spends twice.

## Honest limits

- **Origin.** Existing passkeys are bound to their RP and origin. Signing needs a browser at `https://enclave.host`,
  served by any front or IPFS gateway under that name. If the domain is seized, vaults whose keys are all platform
  passkeys cannot get new signatures. The vault's origins are immutable, and a key added later must also sign at that
  origin.
- **Gas.** Closed-loop credit pays Enclave runtime only and never transaction fees. The payer needs ETH.
- **Card top-ups.** These still need Enclave's processor: Stripe, plus the relay's USDC float deposit. Nothing here sells
  credit or moves balances. The $2,000 closed-loop cap and the no-exit rule are unchanged.
- **Historical factories.** Both factories the platform book has ever named are pinned. The current one is `0xa891…`
  (from block 49,500,388, 2026-08-03). The older one is `0x848a…0c08` (from block 48,910,315, 2026-07-21; the book was
  zero before that). This was read from the book's history on Base, and for each factory the on-chain `vaultFor` equals
  the local derivation. The older implementation predates the origin binding and the 10-argument `create()`. Its vaults
  accept an assertion from **any** origin under `enclave.host` and cannot deploy on today's ledger. The client signs
  only at the pinned origin and warns the owner to move that credit. A factory configured only through the relay's env,
  never the book, would not be found; it is never guessed.
- **Vaults from before the create() reshape.** These cannot deploy on a rev-8+ ledger, and the client refuses that up
  front. Fund, control, refund and key management still work.
- **App lease gas.** This is unavailable for vault-owned deployments. See the next section.

## App lease gas and credit vaults (tested finding)

`EnclaveLeaseGasReserve` (main `1d173473`) requires `msg.sender ==` the ledger's owner of record for `configure` and
`setClaimant`. `withdraw` is keyed to `msg.sender`, and reserves start disabled. A production credit vault can originate
none of those calls:

- its `controlDeployment` allowlist reaches only the ledger's `setAppRef`, `setActive`, `setShares`, `setConfig`,
  `setMaxRate` and `refund`, or a multicall of only those;
- `transferDeployment` is excluded;
- it has no `ownerCall` or `execute`;
- its ERC-1271 `isValidSignature` is a view, and no reserve function takes a signature;
- even repointing the book's `deployments` key at the reserve does not open a path, because the allowlisted selectors
  do not exist there.

So a deposit for a vault-owned deployment can never be enabled or withdrawn, and clients refuse to build one
(`reserveRefusal`, `enclave credit-vault gas`). The real-EVM proof uses the production vault bytecode, the live rev-16d
ledger source, main's reserve and real P-256 WebAuthn assertions:
`work/credit-vault-independence/forge/test/CreditVaultReserveGap.t.sol`.

An **optional, unapproved** candidate (`work/credit-vault-independence/proposal/EnclaveLeaseGasReserve1271.sol`) adds
`configureBySig`, `setClaimantBySig` and `withdrawBySig`, verified through the owner's own `isValidSignature`. The
signature is bound to the reserve address, chain, deployment, current owner of record, nonce and deadline. It is tested
end to end, including a zero-ETH host's EIP-7702 claim paid by a vault-owned app's reserve. It is not deployed and does
not change the ready reserve setup.

## Lease gas for vault-owned apps: reconciliation, proposal and clients (work/credit-vault-final-integration)

**Deposit stranding, reconciled without any contract.**
- `network/lease-gas-owner.mjs` lists both factories the platform book has named. The older build is
  `originBound: false`. A deployment owned by an older-build vault used to be classified as a plain contract, and
  `lease-gas deposit` would build a deposit for it. That deposit is now refused, exactly as for the current build.
- For an owner contract the CLI cannot identify:
  - `lease-gas deposit` requires `--owner-can-act`, where the payer confirms the contract can send configure and
    withdraw itself;
  - `plan` lists the app as refused instead of aborting;
  - `status` warns instead of advising a deposit.

**Proposed parallel reserve (unapproved, not deployed).**
- `EnclaveLeaseGasReserveSig` is the live reserve's source plus `configureBySig`, `setClaimantBySig` and
  `withdrawBySig`, verified through the owner's own ERC-1271 check.
- The live reserve and its enrollments stay as they are.
- The older vault build has no on-chain origin check, so its signatures are refused by a code hash pinned in the
  constructor.
- A host serves the parallel reserve's apps only while its key is delegated to that reserve's executor.
- The exact runtime, constructor, admin, gas, deployment, funding and migration effects are in
  `work/credit-vault-final-integration/proposal/README.md`.

**Clients.**
- `site/js/core/credit-vault-reserve.js`, the `/credit/` page's App lease gas section and the submitter relay are all
  inert until a reviewed parallel-reserve record is configured. In production, `leaseGasReserve` is `null`.
- With a record configured:
  1. The reserve is verified against the platform book's ledger.
  2. Each policy field is the owner's own; withdrawals go to an explicit recipient only.
  3. The digest is computed locally and also read from the reserve.
  4. Signing happens at the pinned origin.
  5. The request is held until the reserve's signature nonce or its deadline decides it.

**The submitter as an Enclave host-service role.**
- The role is defined in `network/host-services/credit-vault-submitter.mjs`, run by `network/credit-vault-submitter.mjs`
  and packaged by `scripts/build-host-service-packages.mjs` (registered in `network/host-services/roles.mjs`; the shared
  runner launches it behind the argv guard, `network/host-services/entries/credit-vault-submitter.mjs`).
- It holds no key: the operator's loopback external signer pays the gas.
- Concurrent requests (`createRelay`, shared with `enclave credit-vault relay`):
  - one request digest has one flight: its agreed checks, its send and its outcome. Identical requests arriving meanwhile
    join it, so it is validated, signed and broadcast once and every caller gets the same transaction;
  - the payer sends one transaction at a time, so different requests never race for its nonce;
  - a refusal that leaves nothing pending (refused before signing, or every RPC definitely rejected the bytes) is forgotten
    once complete, and the same bytes may be tried again;
  - a transaction is held while the relay runs: sent, of unknown outcome, or mined and reverted. The relay never re-signs or
    re-sends one.
  - Across restarts, the external signer's durable intent journal refuses new sends while an intent is unresolved.
  - The raw-key `enclave credit-vault relay` keeps this memory only while it runs.
  - Run one relay per payer account: separate processes do not serialize with each other.
- It refuses to run on DigitalOcean machines.
- It is advertised by the host operator in the service index as an untrusted candidate: kind 8 `credit-vault-submitter`,
  outside the default listing like `policy` (6); `relay` (7) is the lease relay.
