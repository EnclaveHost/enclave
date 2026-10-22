# Independent passkey account (Safe) and ERC-4337: browser slice

Workspace: `work/enclave`. The interface was published first: `work/passkey-aa-interface.txt`.
- Nothing was committed, deployed or published. No real key or fund, no financial transaction, no on-ramp or sponsor sign-up, no production.
- No CLI, Windows, Go, custody or shared-management file was edited. No new Solidity, and no new signature or curve verifier.
- All chain use was either read-only against public Base RPCs, or local on an anvil fork whose upstream reads are read-only.

## What is built

**Path:** Safe v1.4.1 (SafeL2) + Safe passkey signers v0.2.1 (one SafeWebAuthnSignerProxy per passkey, from the pinned
factory) + Safe4337Module v0.3.0 + EntryPoint v0.7. Only the already-deployed, hash-pinned code from
`account-providers.js` is used.

- **`site/js/core/passkey-account.js` (new).**
  - **Profile.** The owner-selected account profile (`enclave_account_profile:v1:<chainId>`) holds the owners
    (passkeys, each with its own RP id and pinned verifiers; recovery keys), the threshold, the salt and an optional
    owner transport.
    - Strict validation. It is saved only on an explicit owner action.
    - `verifyAccountProfile` re-derives every passkey signer through the pinned factory, and checks the Safe address
      (CREATE2 from an agreed read of `proxyCreationCode`) or the deployed owners and threshold.
    - `accountCapabilities` gives plain statements: no recovery with one key; any single owner controls at threshold
      1; no spare owner; "every passkey is under <rp> … whoever runs <rp> decides"; who pays gas; no Enclave
      component.
  - **Creation.**
    - `createPasskey` uses ox `WebAuthnP256.createCredential` (resident key preferred, UV required, ES256). The
      private key never leaves the authenticator.
    - `passkeySigner` gives the factory-predicted signer and its `createSigner` call.
    - `safeInitializer` builds Safe.setup with the pinned SafeModuleSetup enabling the 4337 module, which is also the
      fallback handler.
    - `prepareSafeCreation` gives the `createProxyWithNonce` call and the predicted address.
  - **Signatures.**
    - `safeMessageHash` is the SafeMessage EIP-712 hash Safe's ERC-1271 path asks owners to sign.
    - `passkeyContractSignature` turns an ox assertion into the signer's `abi.encode(authenticatorData,
      clientDataFields, r, s)`. It refuses one that is not over exactly this challenge, or lacks UP or UV.
    - `safeSignatures` builds Safe v1.4.1 bytes in ascending owner order: contract signatures as `r = signer`,
      `s = offset`, `v = 0`, then `len ‖ data`; ECDSA verbatim.
    - `passkeySafeOwnerSigner` is an OwnerSigner for the sessions SDK, so `prepareSessionOpen` signs the
      SessionGrant and the USDC ReceiveWithAuthorization as the Safe, unchanged.
  - **Recovery.**
    - `prepareOwnerChange` builds add, remove or swap owner and change threshold, with `safeTxHash` from an agreed
      read.
    - `execOwnerChange` builds `execTransaction`, sendable by any submitter.
  - **ERC-4337 v0.7.**
    - `prepareUserOperation` builds `executeUserOp` and optional `initCode`, with the nonce from EntryPoint and the
      operation hash from the module, both agreed reads. Gas comes only from the caller, nothing is guessed, and it
      refuses with no owner transport.
    - `signUserOperation` produces `validAfter ‖ validUntil ‖ signatures`.
    - `sendUserOperation` sends only to the owner's bundlers, in the owner's order, with the v0.7 RPC form (factory
      and paymaster fields split). If all fail: "Nothing else was tried". There is never an Enclave fallback.
- **`site/js/core/account-ui.js` (new), mounted on the dashboard in independent mode.**
  - **Create.** A passkey on this site's RP (shown, editable); import a passkey from a dashboard on another RP (public
    description only); recovery keys; threshold; salt; live capability text; compute; explicit Save.
  - **Deploy.** Each call is offered as "Send with my connected wallet (it only pays gas)" or "Copy calldata for any
    submitter".
  - **Sign in.** Approvals come from the ticked passkeys, plus a co-signature from the connected wallet when it is a
    recovery key (eth_sign form). Then the vault check through owner-signature.js simulation, then the gas-payer
    choice; the session is stored with the Safe as owner.
  - **Owners & recovery**, **Gas transport** (validated; never suggested by default), and **Forget**.
- **`site/vendor/aa.js` + manifest (new), `scripts/build-aa-vendor.mjs`, `scripts/vendor/aa-entry.mjs`.**
  - A 106 KB bundle of viem 2.53.1 ABI/EIP-712 helpers and ox 0.14.29 `WebAuthnP256`, from the repository's own
    node_modules; nothing was installed.
  - The manifest records the entry sha256, versions and output sha256.
  - It is wired into `scripts/build-vendor.mjs` with an exports check.
- **`site/js/core/account-providers.js`:** an owner with an EIP-7702 designator is now reported as a delegated EOA.
  Found on the fork, see below.
- **Docs:** `docs/network/independent-dashboard.md` (passkey account, and what is not built).

## Tests

**`test/site-independent-passkey-aa.test.mjs` (new): 6 of 6 pass.**
- Run under the guard (peak 394–400 MiB of 768; host available ≥ 16.8 GiB).
- Setup:
  - anvil `--fork-url mainnet.base.org --fork-block-number 52836800 --optimism`; `--optimism` is what enables
    RIP-7212, as on Base, and plain anvil returns empty;
  - the pinned Safe, passkey, 4337, EntryPoint and USDC v2.2 code comes from the fork;
  - only the repository's ledger and pinned session factory are deployed locally;
  - the software WebAuthn authenticator in `test/helpers/software-authenticator.mjs` answers the very ox calls the
    browser makes. It uses standard authenticatorData and clientDataJSON with DER signatures, and refuses an
    assertion for a credential under another RP.
1. Every provider pin matches on the fork, and RIP-7212 verifies a locally made P-256 signature (wrong message →
   empty).
2. **Create.**
   - Two passkeys are created under two RP ids (`dash-a.example`, `dash-b.example`, UV required), plus a fresh
     recovery key.
   - The signer proxies are deployed; unpinned verifiers are refused.
   - The Safe is created at exactly its predicted address.
   - `identifyAccount` gives 2 passkeys + 1 EOA, threshold 1, with the pinned module and handler.
   - `safeMessageHash` equals the deployed handler's `getMessageHashForSafe`.
   - Capability text is checked, and the profile is saved and loaded.
3. **Sign in, funded.**
   - The SessionGrant and the USDC ReceiveWithAuthorization are each signed by ONE passkey, as the Safe.
   - Each assertion happens on its key's own RP, with UV required.
   - owner-signature.js simulates `openWithDepositFor` at an agreed block.
   - A genuine passkey signature over another message is refused by the contracts in simulation.
   - The submitted session is live with 2 USDC, taken from the Safe through USDC's ERC-1271 path, and recorded with
     the Safe as owner.
4. **Refusals.**
   - Before anything is sent: a wrong challenge, and no UV, are refused by the page.
   - With the page's check bypassed, the deployed passkey signer itself does not return the ERC-1271 magic value
     for a UV-less assertion.
   - No transport means no user operation.
5. **Recovery.**
   - One passkey raises the threshold to 2.
   - Removing the other passkey with one approval is refused by the Safe (simulated).
   - With a passkey plus the recovery key's ECDSA it succeeds: 2-of-2 remains, and the profile still verifies.
6. **ERC-4337 v0.7.**
   - A 2-of-2 user operation (passkey + recovery key) moves 1 USDC through the owner's bundler only.
   - A local bundler stand-in exists only in the test: it decodes the v0.7 RPC form and calls `handleOps`.
   - A refusing bundler gives "Nothing else was tried".
   - **A passkey-only account is CREATED by a user operation** (`initCode` = the Safe creation), and is recognized
     as 1-of-1 with the "one owner" warning.

**`test/site-independent-passkey-account.test.mjs` (new): 8 of 8 pass.**
- the vendored `aa.js` equals a fresh build, and its exports exist;
- profile rules: exact fields; pinned verifiers; distinct owners; threshold; transport with the provider's
  EntryPoint and never Enclave-only; an invalid stored profile is ignored;
- capability text, including that one RP is never called independence;
- exact Safe signature bytes (ascending order, offsets, mixed ECDSA);
- `safeMessageHash` equals Safe's literal-constant construction, and is bound to chain and account;
- assertion refusals: challenge, type order, create-type, UP, UV;
- user operations: only the owner's transport; bundlers in order; exactly two calls when both fail; Enclave-only
  refused; paymaster fields split;
- panel invariants: gas-payer choice, explicit save, no relay or hosted-account call, check before offer.

**Mutations: 10 of 10 killed** (isolated `/tmp/mut-pk`, since removed). The mutants:
- unsorted signatures;
- a wrong dynamic offset;
- the challenge not checked;
- UV not required;
- any verifiers accepted;
- the single-RP warning dropped;
- the no-transport check dropped;
- an extra Enclave fallback bundler;
- the SafeMessage domain unbound from the account;
- paymaster fields misread.

**Regressions (guarded, single job): 83 pass, 1 skipped (opt-in live), 1 fail.** The files: passkey-account,
account-providers, owner-signature, bundle, session-auth, profile, management-unit, names, review.
- The failure is the management-bundle equality check.
- The coordinator has uncommitted changes in `network/management-routes.mjs` and `management-outcome.mjs`: new
  `release`/`claimHint` operations for the move feature, +17 −2.
- The committed bundle still equals its committed sources. Per the provenance rule I did not rebuild from
  uncommitted sources; it needs a rebuild after that change is committed.

## Chromium virtual-authenticator UI test: written, not passing within the allocation

`test/site-independent-passkey-ui.test.mjs` drives the real panel in headless Chromium with Chrome's CDP virtual
authenticator (CTAP2, internal, resident key, UV), against the same Base fork:
1. create a passkey and add a recovery key;
2. compute and save the account;
3. deploy the signer and Safe, with the wallet as gas payer only;
4. sign in, which opens a session the Safe owns.

It could not complete under the 768 MiB process-tree cap. The guard stopped **only my own job** each time; there was
no blind retry, and each change was evidence-based:

| Run | Change | Peak tree RSS | Breakdown at peak | Where it stopped |
| --- | --- | --- | --- | --- |
| 1 | (`node --test`) | 786 MiB | — | setup |
| 2 | `node` direct + lean Chromium flags | 782 MiB | node 281, anvil 160, Chromium ≈340 | setup |
| 3 | deploy moved to a helper process, SDK dropped, V8 heap 160 MB | 800 MiB | node 235, anvil 208, Chromium ≈357 | — |
| 4 | anvil `--prune-history 4` | 851 MiB | node 238, anvil 212, Chromium ≈400 | dashboard page load |

The host's available memory stayed ≥ 16.5 GiB throughout. No processes of mine remain.

The browser + fork + driver stack needs roughly **0.9–1 GiB**. The test is ready to run with that allocation:
`node test/helpers/memory-guard.mjs --max-rss-mib 1024 --floor-available-mib 16384 -- node --max-old-space-size=160 test/site-independent-passkey-ui.test.mjs`.
Until then the UI's logic is covered by the Node integration (the same module functions) and by static panel
checks, but **no real browser has rendered or exercised the panel**.

New test helpers:
- `test/helpers/memory-guard.mjs`: the allocation guard (tree RSS, host floor, peak breakdown; stops only its own
  tree);
- `test/helpers/software-authenticator.mjs`;
- `test/helpers/fork-deploy.mjs`.

## Found on the way

- **Anvil's well-known dev-key addresses carry code on Base mainnet**, presumably EIP-7702 delegations made with
  their public keys. A fork therefore shows them as contracts.
  - The tests use freshly generated keys.
  - `identifyAccount` now reports an owner with a 7702 designator as a delegated EOA.
  - Never treat a dev key as an EOA on a fork of a real chain.
- **Ordering bug, fixed.** `prepareUserOperation` created its chain reader before refusing for "no transport", so the
  owner saw a reader error instead.

## Legacy credit vault: read-only confirmation done; still not offered

Confirmed on the deployed code:
- the live address book's `deployments` is `0xb1783b61…` (two RPCs agree);
- earlier work recorded it as a **full bytecode match** to commit `4b7419bb` / blob `3f3d2c3a` (rev 16d);
- in that source, `fund()` is `fundFor(id, value, msg.sender)`, and `splitFunding` credits refundable owner escrow
  only `if (payer == d.owner)`.

So a credit vault funding a deployment owned by the user's new account buys runtime that is **not** refundable to
the new owner: closed-loop credit stays closed-loop.

Limits, unchanged:
- vault deployments cannot leave the vault;
- each step needs a passkey assertion from an `enclave.host` page (immutable origin);
- unspent credit stays reachable only through enclave.host or the manual refund process;
- the credit-vault implementation's own bytecode was **not** re-verified in this task (the book's `vaultFactory` is
  `0xa891e439…`).

It is designed only, and offered to no one.

## Remaining for full passkey parity (stated, not hidden)

1. **Dashboard identity.**
   - The deployment list, row actions and session-driven operations still follow the connected wallet.
   - Making the passkey account the dashboard's identity is next. That means listing `[safe, vaultFor(safe)]`, acting
     through the account's session, and sending gas via the owner's transport or a chosen payer.
2. **First deployment with no gas payer at all.**
   - A user operation has one factory, so the passkey signer proxy must already exist.
   - A passkey-only user with no ETH and no helper needs the Safe shared signer path, configured in setup through
     MultiSend, so the first user operation can deploy everything. Not built.
3. **Bundler and paymaster suggestions and fees** (e.g. a USDC ERC-20 paymaster): a concrete list for later approval.
   Nothing was contacted.
4. **Device flow** (CLI QR → `/grant` as the passkey account) and **tenant SSO** (SIWE / ERC-1271): other owners per
   the plan.
5. **The Chromium virtual-authenticator run**, at ≈1 GiB.
6. **The management bundle rebuild**, after the coordinator commits the move operations.
