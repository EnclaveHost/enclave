# Passkey account selection and the first account foundation

Workspace: `work/enclave`.
- Nothing was committed, deployed or published, and no key was created on any chain.
- No transaction, purchase, sponsorship sign-up or dependency installation was made.
- All chain access was read-only (`eth_getCode`, `eth_call`, `eth_getStorageAt`, `eth_getLogs`, `eth_blockNumber`) through public Base RPCs.
- Downloaded sources were treated as untrusted text, kept in `/tmp/aa-research`, and used only to read and to hash.
- No CLI, shared management, Windows, Go, custody or SDK file, and no Solidity, was changed.
- No Chromium. No anvil this round.
- Memory stayed at 16.9–17.4 GiB available.

The plan is updated in `work/passkey-independence-interface.txt`: new sections C1b, E (selection) and F (legacy vault).

## Selection

**Selected (preferred): Safe v1.4.1 + Safe passkey signers v0.2.1 + Safe4337Module v0.3.0** (EntryPoint v0.7).
**Supported, not preferred: Coinbase Smart Wallet v1.1** (EntryPoint v0.6).

Both meet the non-negotiables:
- no Enclave RP, relay, bundler or paymaster;
- owner-controlled keys, any number, from any RP;
- ERC-1271 with a replay-safe hash, which the pinned SessionVault accepts;
- USDC EIP-3009 accepts ERC-1271 too, so `openWithDeposit` works;
- no admin key over existing accounts.

Safe is preferred because only Safe gives:
- recovery that no institution controls (an M-of-N threshold);
- immutable code with every change made by the owners at their threshold;
- required user verification;
- audits on the exact versions.

| | Safe passkey (selected) | Coinbase Smart Wallet v1.1 |
| --- | --- | --- |
| Upgrade / admin authority | Singleton immutable. Master copy, modules, fallback handler and guard change only by the Safe's owners at their threshold. Passkey signer proxies immutable. No Safe or Enclave admin. | Factory immutable, no owner. Each account is UUPS, and **any one owner can upgrade** it; owner changes and upgrades are replayable across chains by design. No Coinbase admin key in the code. |
| Owners and recovery | M-of-N mixing passkeys, EOAs and other Safes. Threshold recovery; spare keys. | Unlimited owners, **1-of-N**: any single key can act alone, including removing every other owner. No threshold or timelock. |
| WebAuthn check | Type and challenge fixed in a contract-built clientDataJSON; **UV required**; RIP-7212 with optional Daimo fallback. No origin or rpIdHash check. | Low-s; type and challenge at caller-given indices; UP; **UV not required** (`requireUV: false`); explicitly skips origin, rpIdHash and crossOrigin; RIP-7212 then FCL. |
| ERC-1271 | Fallback handler, over a SafeMessage hash bound to the Safe and chain. | `replaySafeHash`: EIP-712 domain "Coinbase Smart Wallet"/"1", bound to the account and chain. |
| Audits (repo-listed) | Passkey v0.2.1: Hats Finance, Certora, Nethermind (shared signer included). 4337 v0.3.0: Ackee, Certora, Nethermind. | Cantina (Dec 2023, Apr 2024), Certora (Feb 2024), Code4rena (Mar 2024), all **before** v1.1. The v1.0→v1.1 source delta is small (an upgrade-target code check, a factory event and guard). |
| Costs and tradeoffs | More contracts and gas. Safe-format contract signatures. Authenticator data (AAGUID) is public on chain. A first deployment needs a submitter or a bundler. | Simpler and widely used, but one stolen key is total loss. Older EntryPoint. |

**Common limit, stated:** neither checks origin or RP on chain. A single RP is therefore not independence, and is
unsafe when that RP's domain serves untrusted subdomains (the enclave.host tenant lesson). An account should hold keys
under at least two unrelated RPs, or one RP plus a security key or EOA.

## Evidence (primary sources, pinned revisions)

**Sources read:**
- Coinbase:
  - `github.com/coinbase/smart-wallet` at `a4e83fd36c47b64cb4e21e1fa6bb9b04181a66da` (2026-07-17; its source equals the v1.1.0 tag). Files: `src/CoinbaseSmartWallet.sol`, `MultiOwnable.sol`, `ERC1271.sol`, `CoinbaseSmartWalletFactory.sol`, `audits/`.
  - The v1.0.0 and v1.1.0 tags, diffed.
  - The v1.1.0 release notes, which name factory `0xBA5ED110…5842` and implementation `0x00000110dC…534d`.
  - `github.com/base-org/webauthn-sol` at `619f20ab0f074fef41066ee4ab24849a913263b2` (the submodule pin): `src/WebAuthn.sol`.
- Safe:
  - `github.com/safe-fndn/safe-modules` (the moved `safe-global/safe-modules`) at `9e5f3d0701c4bd5d5fa4ce8ff7d5206f2ccc4acc` (2026-09-02):
    - `modules/passkey`: README, `contracts/libraries/WebAuthn.sol`, signer factory, proxy and singleton, `4337/SafeWebAuthnSharedSigner.sol`, `docs/v0.2.1/audit.md`;
    - `modules/4337`: `contracts/Safe4337Module.sol` (`contract Safe4337Module is IAccount, HandlerContext, CompatibilityFallbackHandler`), `docs/v0.3.0/audit.md`;
    - release `passkey/v0.2.1`.
  - `github.com/safe-global/safe-modules-deployments` at `bc4d80f7de099b8926edc211d65d86b053ff6b85`: `safe-passkey-module/v0.2.1/*.json`, `safe-4337-module/v0.3.0/*.json`.
  - `github.com/safe-global/safe-deployments` at `e9cc9798ab834e7fe515d361566eb4a28c65387f`: `v1.4.1/safe_l2.json`, `safe_proxy_factory.json`, `compatibility_fallback_handler.json`, which carry the canonical `codeHash`.
- Circle: `github.com/circlefin/stablecoin-evm` tag `v2.2.0` (`405efc100c016ed1a437063b6274b4e24ea7b8b1`): `contracts/util/SignatureChecker.sol`, `contracts/v2/EIP3009.sol`.

**Base, read-only, three RPCs agreeing (block 52,836,800):**
- **Code hashes.**
  - Every pinned contract's runtime code hash was recorded.
  - Safe L2 1.4.1, SafeProxyFactory and CompatibilityFallbackHandler **equal Safe's published codeHash**.
  - Recorded in `site/js/core/account-providers.js`.
- **Wiring.**
  - `Safe4337Module.SUPPORTED_ENTRYPOINT()` is EntryPoint v0.7.
  - `CoinbaseSmartWallet.entryPoint()` is v0.6.
  - The v1.1 factory's `implementation()` is `0x00000110…534d`.
  - The implementation's own EIP-1967 slot is 0.
- **RIP-7212 is live.** `eth_call` to `0x…0100` with a P-256 signature made locally with `node:crypto` returns `1` on all three RPCs; a tampered key returns empty.
- **USDC.**
  - `0x8335…2913` → implementation `0x2ce6…d779`, `version()` "2".
  - It exposes `receiveWithAuthorization(…, bytes)`, `transferWithAuthorization(…, bytes)` and `permit(…, bytes)`.
  - In Circle's v2.2.0 source, `SignatureChecker` uses ECDSA for EOAs and ERC-1271 for contracts.
- **Real accounts** (from `eth_getLogs` on the pinned factories):
  - Safe proxies on the pinned singleton: 6,277 in the scanned window;
  - Coinbase v1.1 accounts: 537;
  - two Safe passkey signers. For both, `getConfiguration()` re-derives exactly through the pinned factory's `getSigner`. One uses the precompile only; the other the precompile plus the pinned Daimo fallback.

## Implemented foundation (browser account files; no new crypto, no Solidity)

**`site/js/core/account-providers.js` (new).**
- `PROVIDERS`: pinned addresses plus code hashes, EntryPoints, sources and audits for `safe-passkey` (preferred) and `coinbase-smart-wallet`.
- `verifyProviderDeployment(id)` re-checks every pin at a quorum-agreed block.
- `identifyAccount(address)` reads everything at ONE agreed block. It recognizes:
  - **A Safe on the pinned singleton.** It reads owners, threshold, modules (via `getModulesPaginated`) and the fallback-handler and guard slots (via `getStorageAt`). A passkey owner counts only if the pinned factory re-derives that signer's address, or it is the pinned shared signer with a key configured for this Safe.
  - **A Coinbase Smart Wallet on the pinned v1.1 implementation.** It reads address and passkey owners, and skips removed slots.
  - **Anything else:** an EIP-7702-delegated EOA, an EOA, or an unrecognized contract.

  It gives plain warnings for:
  - one key, or threshold 1, or no spare key;
  - no passkey owner;
  - an unknown module, or a fallback handler other than the pinned handler or 4337 module (both are reviewed);
  - a guard;
  - CBSW's 1-of-N upgrade power, its lack of UV, and an upgraded (unpinned) implementation;
  - "no origin/RP binding".

  It never throws for an unrecognized contract. Contracts that answer every call with empty data (found live on WETH) are treated as unrecognized.
- `validateAccountTransport({provider, entryPoint, bundlers, paymaster})` validates an owner-chosen ERC-4337 transport:
  - the provider's own EntryPoint;
  - 1–8 plain HTTPS bundlers on distinct hosts, never only Enclave-operated;
  - an optional paymaster `{erc20|verifying, address, https url}`;
  - a plain statement of who pays gas.

  No user operation is sent yet.
- **`/grant`** (independent): next to the owner kind it shows the recognized account (provider and version, owners, passkeys, threshold) and its warnings.
- **Live validation of this code** against real Base accounts, read-only:
  - a real Safe, decoded as 1-of-1 EOA plus the pinned 4337 module plus one unknown module, correctly warned;
  - two real Coinbase v1.1 accounts, each with two address owners;
  - USDC and WETH, classified as unrecognized contracts;
  - an EOA.

  The live run also caught two bugs, both fixed:
  - empty-data answers decoded as addresses;
  - the pinned 4337 module, as fallback handler, misflagged as unreviewed. Its source shows it is a CompatibilityFallbackHandler.

The 1271 simulation foundation from the previous round (`owner-signature.js`) is unchanged and still decides signatures.

## Tests

- **`test/site-independent-account-providers.test.mjs`: 6 pass, plus 1 opt-in live test that passed.**
  - **Safe 2-of-3:** a factory-derived passkey, a configured shared signer (Daimo fallback decoded) and an EOA, with the pinned module and handler. Only the origin/RP warning is given, and every read is at one block.
  - **Safe warnings:**
    - a forged passkey proxy (the factory derives another address) is a plain contract owner;
    - threshold 1, an unknown module, an unreviewed handler and a guard are each warned;
    - a single owner, no spare key, and no handler are each warned;
    - a Safe on another singleton is not described.
  - **Coinbase:** address and passkey owners; a removed slot is skipped; the 1-of-N and no-UV warnings; an upgraded implementation is flagged.
  - **Other kinds:** EOA, 7702 delegation, an unknown contract, and a permissive-fallback contract.
  - **Deployment pins:** match, mismatch and missing code all at one block; the shipped pins are well-formed.
  - **Transport:** the EntryPoint must match; HTTPS only; distinct hosts; never Enclave-only; the paymaster shape; unknown fields refused.
  - **Opt-in live (`ENCLAVE_LIVE_READS=1`):** the real Base deployments still match every pin. Passed.
- **Mutations: 8 of 8 killed.** The mutants:
  - a passkey trusted without the factory re-derivation;
  - unknown modules not flagged;
  - short answers accepted;
  - Enclave-only bundlers allowed;
  - the deployment check always OK;
  - any fallback handler accepted;
  - a CBSW upgrade not flagged;
  - an EntryPoint mismatch allowed.

  Run in an isolated `/tmp/mut-ap` copy, since removed.
- **Focused regressions (single job): 61 pass, 0 fail, 1 skipped (the opt-in live test).** The files: `site-independent-account-providers`, `-owner-signature`, `-bundle`, `-names`, `-profile`, `-review`, `site-session-auth`, `vault-digest`.

## Legacy credit vault (honest limits; see interface section F)

- **Locked:**
  - existing vault deployments cannot leave the vault (no `transferDeployment` in the allowlist);
  - vault USDC goes only to the ledger or the company treasury;
  - every operation needs a passkey assertion from `enclave.host` (an immutable origin).

  Nothing here promises to move locked assets.
- **Owner-consented path the contract permits** (designed, not built):
  1. The owner creates a replacement deployment from their independent account.
  2. On an enclave.host page, the owner's passkey signs `fundDeployment(newId, amount)` from the vault. This works for any id, and the credit becomes runtime on the independent deployment.
  3. Optionally, it is preceded by `controlDeployment(refund(oldId))`, which returns an old vault deployment's unused runtime to vault credit.
- **Under the HEAD ledger it stays closed-loop:** refundable owner escrow is credited only when `payer == owner`, and here the payer is the vault.
- **Before offering it to anyone:** re-verify that rule on the deployed rev 16d ledger, which differs from HEAD.

## What remains (each needs a coordinator decision or a later slice; none asked of the user now)

1. **Owner-account panel** on the dashboard with the same recognition. The transport stays validation-only until the AA slice: profile `aa` wiring, viem account-abstraction user operations, Safe passkey account creation (signer factory or shared signer plus SafeModuleSetup) and Safe-format ERC-1271 signatures for SessionVault grants. That needs the browser + anvil allocation for real tests (a Chromium virtual authenticator against a forked Safe deployment).
2. **Concrete lists for later approval:**
   - bundler and paymaster suggestions with their fees (e.g. a USDC ERC-20 paymaster, provider-verified ones);
   - on-ramps.

   No vendor was contacted.
3. **Device flow via QR, SSO via SIWE/1271, and billing-into-account:** owners as in the plan (CLI, app SDK, billing).
4. **Passkey parity is still not complete:**
   - account creation, user operations, recovery set-up flows, the device flow and SSO are planned, not built;
   - legacy credit-vault customers remain dependent on enclave.host as described.
