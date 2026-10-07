# Sessions for enclave.host: design spec

Status: **implemented** (sessions/spec branch). Decisions D1-D8 were taken as recommended below, and §15 records where the build deviates from this text. §16 adds delegated access to the deployments the owner's wallet holds (ledger rev 15d + vault v2, live on Base since 2026-10-07); it supersedes D2's "sessions can't control wallet-owned deployments".
Branch: `sessions/spec`, cut from main 405133117.
Live chain state in §1 was read on 2026-10-06. The ledger has moved since (§16.4).

A session is a P-256 delegate key, plus a policy, plus an optional escrowed USDC budget.
The owner's wallet approves it once. Sign-in opens a session and sign-out terminates it.
Everything in between is signed by the session key and submitted by a relayer.
Browser tabs and agents use the same contracts, relayer, auth and SDK. They differ only in two things:

- where the key is stored;
- which policy preset the owner picks.

---

## 0. Decisions I need from you

Each item has a recommendation. Section numbers point to the detail.

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Signatures needed to open a session that has money.** One readable EIP-712 grant cannot also move USDC: USDC only moves on its own signature (EIP-2612 permit or EIP-3009). So "readable on the Trezor" and "one signature" conflict whenever there is a deposit. See §3.7. | Use **two signatures** (readable grant + USDC authorization, submitted in one transaction) when opening a funded session from a link. Browser sign-in defaults to a **zero budget** (one signature). Top-ups are **one signature** each. An optional "quick" mode does it in one signature, but the device shows only the amount, not the policy. Recommend it for browser sign-in only, or not at all. |
| D2 | **Custody.** The ledger authorizes by `msg.sender == d.owner` and is 309 bytes under the EIP-170 limit (24,267 bytes live). Trusting a forwarder there means a size refactor plus a full ledger migration. Sessions can therefore only manage deployments the owner's vault holds. Moving an existing deployment in requires `refund()` first (which stops it) whenever it holds refundable escrow. See §2.2. | Accept. New deployments created by a session are born inside the vault. Existing wallet-owned deployments stay wallet-managed: sessions can top them up but not control them. Moving one in is an explicit owner action. **Superseded 2026-10-07 (§16):** the ledger was migrated after all (rev 15d, owner-approved delegates), so once the owner grants their vault, sessions covering production can suspend, resume, resize, fund, lower the cap of and refund wallet-held deployments in place. Version, config and transfer stay the wallet's. |
| D3 | **How staging relates to apps.** Pick a pattern. See §2.3. | Use a **separate staging app** (e.g. `eyesoff-staging`) held by the vault. Agents publish there. Promotion = the owner republishes the tested CID/config under the prod app and points the prod deployment at it. Staging and prod then have different AppIDs, so different measurements. No catalog change is needed. |
| D4 | **Where relayer fees go.** | **Through PaymentRouter to the treasury**, tagged with a fee ref. The vault's outflows are then exactly {ledger, PaymentRouter, owner}, and the relay's hot wallet never holds USDC. The relayer's ETH keeps being topped up from the treasury as today. |
| D5 | **Upgrade policy.** | **Immutable** EIP-1167 clones: no proxy, no admin, no pause. New versions are new factories with owner opt-in migration. Add a per-vault balance cap in the implementation for the beta (e.g. $1,000), lifted by a later factory. See §3.11. |
| D6 | **The supervisor must change** (session login, owner resolution for vault-held deployments, scope checks). supervisor.js is a measured release surface, and release surfaces are currently held: any push to main cuts a release from the stale deploy base 9594a969. See §6.3. | Build phases a–c and e without touching the supervisor. Ship the supervisor part of phase d as its own release when you lift the hold. |
| D7 | **Legal.** The runbook's "money flows in only / no customer balances" invariant was written for company-held balances. SessionVault holds wallet users' own USDC in a contract the company cannot move, and refunds go back to the owner automatically. | Ask counsel to confirm the non-custodial escrow is outside the invariant before mainnet. The relayer should also OFAC-screen owners before submitting deposits, as orders are screened today. |
| D8 | **Passkey/card users** stay on the credit-vault path (as you scoped). See §9.4. | Keep the split, but share one header indicator component with two data sources. |

---

## 1. What exists today (step 1 findings)

### 1.1 Contracts

Live addresses come from the address book `0xab214342…0907`. Governance is the Trezor `0x0b2d…eE61`, which owns the book, the ledger and the catalog. There is no timelock, no proxy and no multisig anywhere.

| Contract | Live | Facts that shape this design |
|---|---|---|
| EnclaveDeployments (ledger) | `0xb36D…4830`, schema 15, 24,267 bytes | Every owner action uses `_requireOwned` (`msg.sender == d.owner`): `setAppRef`, `setConfig`, `setShares`, `setActive`, `setMaxRate`, `refund`, `transferDeployment`. `create` makes the caller the owner. Funding is open to anyone: `fund`, `fundFor(id, value, payer)` (where `payer` only sets refund attribution) and `fundWithAuthorization` (EIP-3009, the nonce must start with the id). No forwarder, no EIP-712. `transferDeployment` is one step and reverts `"refund first"` while the owner has refundable escrow. `create` stores the caller's `feeRecipient`/`feePerSec6` **without checking them against the catalog**. `multicall` delegatecalls to itself and is non-payable. Main's source is schema 16, at 24,575 bytes (one byte of headroom), and not deployed. **Retired 2026-10-07**: replaced by rev 15d at `0x606C…eAe9` (rev 15 plus `setDelegate`; `_requireOwned` also passes an approved delegate, `transferDeployment` does not), §16. |
| EnclaveAppCatalog | `0x1841…26e3`, schema 9, 22,733 bytes | `appId = keccak(publisher, slug)`. Only `a.publisher == msg.sender` can publish, yank, delist or edit. Only governance can call `transferApp`. Versions are append-only and immutable, and a deployment pins `catalog://<appId>/<index>`. Versions start **Pending** unless governance published them (rev 9). Pending versions still run on **private** deployments (`forPrivate`). The catalog moves no money. |
| PaymentRouter | `0xf171…d56A` | Immutable and holds nothing. `pay(amount, orderRef)` pulls from `msg.sender` to the treasury and emits `PaymentReceived`. `payWithPermit` permits `msg.sender`, so it can't be relayed. **Compute funding does not go through it**: deployments are funded on the ledger, which splits each payment into runner escrow, publisher cut and payout/feeRouter. On the site, `pay.js` has no callers. |
| EnclaveCreditVault + factory | `0xa891…4E91` | Prior art for this design. It is a per-customer EIP-1167 clone, every operation is P-256 WebAuthn-signed and checked through the `0x100` precompile, and the relay submits. Ledger calls are limited to an allowlist of selectors; it is closed-loop, with no withdraw and no owner. It **owns the deployments it creates**, which is the custody pattern this design reuses. It approves the book-resolved ledger for `max`, which this design deliberately does not repeat. |

Contracts already own deployments in production (the credit vault and `VerificationFeeWallet`). Nothing on-chain checks for EOAs or uses `tx.origin`.

### 1.2 How signing works today

- **Site.** Every ledger and catalog action is an `eth_sendTransaction` from the user's wallet, and the user pays ETH gas: deploy, fund, resize, version, config, suspend/resume, cancel, transfer, move, publish, promote/featured, reviews. That is about 25 call sites, mostly in `site/components/deployments/deployments.js` and `site/js/pages/apps.js`, all going through `sendTx` (`site/js/core/wallet.js:676`).
  - Funding signs an EIP-3009 authorization and then sends `fundWithAuthorization` itself.
  - Off-chain `personal_sign` messages:
    - `enclave-upload:`
    - `enclave-secrets:put/get:`
    - `enclave-domains:`
    - the placement message
    - the connectivity policy digest
    - SIWE
    - the encrypted-volume key message. Its signature *is* the key material, which requires a deterministic EOA.
- **CLI** (`cli/enclave.mjs`). It signs with a raw key from `~/.config/enclave/key` or `ENCLAVE_KEY`. An agent therefore runs `enclave … --yes` with full wallet authority, which is exactly what sessions replace.
- **MCP** (`relay/mcp.js`). It holds no keys and returns unsigned transactions for the agent to sign with its own key.
- **Link pages.** `link.html` (device-flow approval) is the natural host for a grant-from-link page. No current page signs from a link.

### 1.3 Authentication today

There are three separate token domains and **no server-side session records anywhere**.

1. **Enclave session.** SIWE → ES256 JWT minted by the in-enclave key in `supervisor.js`. It lasts 7 days, is issued per enclave (a token from one enclave isn't accepted by another) and has **no revocation**: it dies at expiry or when the CVM relaunches. Login verification is ECDSA-only, so a contract owner cannot get one. Logs, restart, delete/move, app-token and private-app access all check `rec.owner === req.address` inside the supervisor.
2. **Relay account session** (`acct_*`). Passkey, SIWE (handles 1271/6492) or device flow. It lasts 7 days and is signed by a key on the relay's disk. The only revocation is deleting the account.
3. **SSO EST1 tokens** for tenant apps.

Secrets, domains and placement are owner-checked **at the relay** against the ledger's `d.owner`. Secrets already have an ERC-1271 path (`relay/contract-owner-signature.mjs`), but no client uses it.

### 1.4 Secret release

Four paths deliver secrets to a guest:

- (A) plaintext fetch by the lease holder;
- (B) a sealed SNP release, gated on the measurement the relay predicts from the confirmed `appRef`;
- (C) Shield/VBS release;
- (D) TLS keys, which never leave the guest.

**None has a notion of environment or promotion.** (A) checks only that the caller holds the lease. (A), (B) and (C) all let **Pending** versions get secrets on private or owner-served deployments. Measurements are never stored on-chain.

The natural "promoted for production" signal is the deployment's `appRef`/`configCid`, which only the owner can change. Running instances depend on no login session: leases are held by runners, secret fetches are authorized by host operators, and Shield evidence is renewed by the relay.

### 1.5 Relay transaction infrastructure

- **One hot key.** `PROVISIONER_PRIVATE_KEY` is used by two modules, `provisioner.js` and `vaultsvc.js`, **each with its own serial queue**, so they can race on the same nonce (a bug today).
- **No nonce manager or fee bumping.** There is no nonce manager, no fee bumping and no stuck-transaction replacement. Robustness comes from write-ahead records and receipt polling.
- **State and supervision.**
  - State lives in `JsonStore` files under `AUTH_DATA_DIR`, with no backups.
  - Background loops are `setInterval`s inside the relay process; systemd restarts the process if it dies.
  - Alerts go to `ALERT_WEBHOOK_URL`.
- **Deploy.yml contract handling.** Deploy.yml auto-deploys only five named contracts on pushes to main; a new `contracts/X.sol` triggers nothing. Pushes to other branches run only the secret scan.
- **Relay modules.** A new relay module ships only if it is listed in `relay/deploy.sh`.
- **Mainnet-only paths.** `api-relay.js`'s chain client and its agreement RPCs are hard-coded to Base mainnet. Only billing and vault code honour `BILLING_NETWORK=base-sepolia`.

### 1.6 Confirmed outside the repo

- **P-256 precompile on Base.** `P256VERIFY` is at **`0x0000000000000000000000000000000000000100`**.
  - **Gas:** **6,900** since Base's **Azul** upgrade (mainnet 2026-05-28, Sepolia 2026-04-20), aligned with L1's EIP-7951. Before that it was RIP-7212 at 3,450 gas, live since Fjord (2024-07-10). Every session operation pays the 6,900.
  - **Input and output:** the input is 160 bytes (`hash ‖ r ‖ s ‖ x ‖ y`). On success it returns 32 bytes holding 1; on failure it returns nothing.
  - **Later upgrades:** Beryl (06-25) and Cobalt (09-30) don't affect this design. Azul also caps a single transaction at 2^24 gas (EIP-7825).
- **ERC-7715** is still a Draft. The method is now `wallet_requestExecutionPermissions`:
  - Request: `{chainId, from, to, permission{type, isAdjustmentAllowed, data}, rules[]}`.
  - Response: adds `context`, `dependencies` and `delegationManager`.
  - It defines no exhaustive list of permission types, so §8.3 maps our grant onto that shape without depending on it.
- **USDC on Base** (FiatTokenV2_2) supports EIP-2612 and EIP-3009 (`receiveWithAuthorization` requires `msg.sender == to`), with ERC-1271 for contract signers. Base Sepolia USDC is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
- **Trezor and EIP-712.** The Trezor firmware shows every EIP-712 field, nested structs included, but **does not support nested arrays**. Hence the flat grant in §3.6.

### 1.7 Found along the way (not fixed here)

1. `provisioner.js` and `vaultsvc.js` share one key through separate queues, so they can race on the nonce.
2. The credit-vault **Cancel** button can't work. The site sends `control/cancel`, but the relay's allowlist omits it (`relay/billing.js:903`) and `vault.js:169` throws.
3. CLI `--signer` (Frame) can't sign messages (`cli/enclave.mjs:419-427`). So SIWE, upload, secrets, encvol and EIP-3009 all fail through it, even though the help text says they work.
4. Supervisor SIWE burns a nonce only after a successful login (`supervisor.js:5198`). The relay burns it on the first attempt.
5. Stale docs:
   - `DEPLOYMENTS.md` gives `create` 9 arguments; it has 10.
   - The README describes `cidStatus` as the deploy gate, which it no longer is.
   - Ledger size figures disagree across five docs.

---

## 2. Design overview

```
owner wallet ── signs grant (EIP-712, once) ──┐
                                               ▼
session key ── signs intents ──► relayer ──► SessionVault (per owner, clone)
 (P-256: IndexedDB             (submits,        │ policy check · budget · rate · expiry
  or agent file/env)            pays ETH)       │ builds the call itself (no generic execute)
                                               ├──► EnclaveDeployments   (create/fund/control vault-held;
                                               │                          wallet-held as prod via delegation, §16)
                                               ├──► EnclaveAppCatalog    (publish to vault-held apps)
                                               ├──► PaymentRouter        (orders + relayer fee → treasury)
                                               └──► owner                (refunds, withdrawals)
```

### 2.1 Why a per-owner vault, and why not ERC-4337, ERC-7579 or EIP-7702

The platform contracts authorize by `msg.sender`. Whatever acts for the owner must therefore *be* the owner or publisher on-chain. Options considered:

- **Single shared vault.** Catalog app ids are `keccak(publisher, slug)`, so every owner's apps would collide in one namespace. Every held resource would also need a per-owner side mapping, and off-chain checks couldn't answer "whose is this?" from `d.owner` alone. Rejected.
- **Per-owner vault (chosen).** An EIP-1167 clone at a CREATE2 address derived from the owner's address. The vault's owner is unambiguous: anything it holds belongs to `vault.owner()`. Funds are never mixed between owners. Like the credit vault, it is a restricted custody contract with a fixed action table, not a general-purpose account.
- **ERC-4337 smart accounts with ERC-7579 session modules** (e.g. Smart Sessions). Rejected because:
  - the owner would have to move every deployment and app into a general-purpose account;
  - we would run or rent bundlers and paymasters, which billing deliberately avoided;
  - session validators in that ecosystem authorize *generic* execution plus policy plugins, which is the opposite of "no generic execute";
  - the attack surface we'd need audited is far larger.
- **EIP-7702** (the owner's EOA delegates to session code). Attractive because `msg.sender` stays the EOA, so the platform contracts wouldn't change. Rejected because:
  - a bug in the delegate puts **the whole wallet** at risk, not just a budget;
  - mainstream wallets only let users delegate to their own vetted implementations;
  - hardware-wallet support for signing an arbitrary 7702 authorization is limited.

  The spec requires that damage be bounded by an escrow, and 7702 can't bound it.

No case for 4337 or 7579 holds up, so this design doesn't stop on that question.

### 2.2 Custody: acting on platform contracts without changing them

The vault is `d.owner` of the deployments sessions manage, and `publisher` of the apps sessions publish to. The ledger and catalog stay as they are.

- **Created by a session:** the vault calls `create`, so it owns the deployment from the start. Same for `publishVersion` on a new slug.
- **Existing wallet-owned deployment:**
  - Sessions can **fund** it with `fundFor(id, value, payer = d.owner)`, so refundable escrow stays attributed to the owner's wallet. (Vault v1 as built refused this; vault v2 allows it for grants covering `prod`, §16.)
  - Control (resize, suspend, version) stays a wallet transaction until the owner moves the deployment in. **Changed 2026-10-07 (§16):** once the owner grants their vault on the ledger (`setDelegate`), sessions covering `prod` suspend, resume, resize, lower the cap and refund it where it is. The version and config stay wallet transactions, and so does any transfer.
  - Moving it in takes `transferDeployment(id, vault)` from the wallet, then an owner `Adopt`. A deployment holding refundable escrow must be `refund()`ed first, which stops it; the ledger refuses the transfer otherwise. A Ledger `multicall` can move many deployments in one wallet transaction.
- **Existing wallet-published app:** stays wallet-managed. Sessions publish to a vault-held staging app (D3). A governance `transferApp` can move an app into the vault if you want pattern P2 (§2.3).
- **Unsolicited transfers:** anyone can transfer a deployment to a vault (a gift, or an attack). The vault treats an unknown held id as **unadopted**: no session may touch it until the owner `Adopt`s it.
- **What changes downstream:** for vault-held deployments, `d.owner` on-chain is the vault, not the EOA. Every off-chain owner check must resolve the *beneficial owner*:

  ```
  owner(d) = isSessionVault(d.owner) ? SessionVault(d.owner).owner() : d.owner
  ```

  `isSessionVault` is true when `factory.isVault(addr)` returns true for a factory listed in the book.
  - **Relay:** secrets, domains, placement, upload and listings. Phase c/d.
  - **Supervisor:** logs, restart, app token, private access. Phase d, D6.

  The vault also implements ERC-1271 for the **owner's** signature only. Existing 1271-aware verifiers, such as the secrets path and connectivity, then accept the owner's wallet signature for vault-held deployments. Session keys never satisfy the vault's `isValidSignature`, so they can't pass 1271-based owner checks.

### 2.3 Environments and promotion

Environment is a property of a **vault-held deployment**: `staging` or `prod`. The vault stores it in `held[id].env`.

| | staging | prod |
|---|---|---|
| Created by a session whose policy allows the env | yes | yes. Starts **unpromoted**: no prod secrets until the owner promotes it. |
| Session may | create, fund, setAppRef, setConfig, setShares, setMaxRate, setActive, refund (per policy) | create, fund, setShares, setMaxRate, setActive, refund (per policy) |
| Owner only | change env, release | **setAppRef/setConfig = promotion**; change env; release |
| Secret release (§7) | that deployment's own (staging) secrets | only when `held[id].promoted == keccak(appRef, configCid)` at the confirmed row |

**Promotion** is an owner operation (`Promote`, §3.6). It sets the prod deployment's `appRef`/`configCid` through the vault and records `promoted = keccak(appRef, configCid)`. It also verifies a version label against the catalog, so the Trezor screen shows `"eyesoff 1.0.79"` and not just an index. A session can never write `promoted`. Wallet-held deployments need no new rule: a session never changes what they run. Through the ledger delegation (§16) it reaches them as `prod`, so `setAppRef`/`setConfig` stay the wallet's.

App patterns for staging (D3):

- **P1, recommended: a separate staging app.** The agent publishes `eyesoff-staging` versions in the vault, and a private staging deployment runs them (Pending is fine on private deployments).
  - **Promotion takes two owner signatures:**
    1. republish the tested CID and config under the prod app, which a wallet-published app auto-approves;
    2. `Promote`, or `setAppRef` on a wallet-held prod deployment.
  - **Measurements:** the AppID derivation includes the catalog app and version, so a staging version and its prod twin have **different measurements**. That is the hard rule ("a measurement published via a session is staging-only") made structural.
  - **CID claims:** the staging listing stays Pending, so its CID claim never binds and the prod app can always re-list the same bytes.
- **P2: one app in the vault.** Sessions publish versions of the real app, and promotion is just `Promote`. But no version the vault publishes is auto-approved, so public prod deployments need a governance `setApproval` for every version.
- **P3, later: catalog rev 10 per-app delegates.** The app stays wallet-owned, and the catalog records which versions a delegate published. A catalog migration for a convenience; not needed for v1.

---

## 3. SessionVault contract (phase a)

Files:

- `contracts/SessionVault.sol`: the implementation, the factory and the action library.
- `contracts/foundry/test/SessionVault*.t.sol`.
- `scripts/deploy-session-vault.mjs`.

### 3.1 Factory and addresses

- **`SessionVaultFactory(usdc, book, paymentRouter, keyAttestations)`** deploys one implementation. `keyAttestations` may be zero until phase g. Its functions:
  - `vaultFor(owner)`: CREATE2 with `salt = bytes32(uint160(owner))`. The address is known before deployment, so EIP-712 grants can name it.
  - `createVault(owner)`: anyone may call it. `initialize(owner)` is restricted to the factory, and the salt binds the owner, so there is nothing to front-run.
  - `isVault(addr)`.
- **Address-book key `sessionVaultFactory`** points at the current factory. The vault resolves `deployments` and `appCatalog` **through the book on every session call**, so ledger and catalog migrations need no vault redeploy. PaymentRouter is pinned as an immutable, because it is immutable itself.
- **Owner paths never read the book.** A bad book entry cannot block recovery.

### 3.2 Storage (per clone)

```
address owner;                         // set once by initialize
uint64  epoch;                         // bumped by revokeAll
uint256 locked6;                       // Σ balance6 of live sessions (USDC 6dp)
uint256 _lock;                         // reentrancy guard
mapping(bytes32 => Session) sessions;  // sid → session
mapping(bytes32 => mapping(uint192 => uint64)) seq;  // per-session nonce lanes (2D nonces)
mapping(bytes32 => bool) usedOwnerNonce;
mapping(bytes32 => Held) held;         // deployment id → custody record
mapping(bytes32 => bytes32[]) appsOf;  // sid → allowed appIds (≤ 8)

struct Session {                       // packed into 8 slots
  bytes32 keyHash;      // keccak256(abi.encode(x, y)); x,y arrive in calldata and are hashed
  bytes32 measurement;  // 0 = no TEE requirement (phase g)
  uint256 actions;      // bitmask over the action table (§3.4); bits ≥128 are off-chain API scopes
  uint64  expiresAt;  uint64 epoch;  uint8 envs;  uint8 state;  bool anyApp;
  uint128 balance6;   uint128 spent6;
  uint128 perPeriod6; uint128 maxFee6;
  uint128 maxAppFeeHour6;              // publisher-fee ceiling for create()
  uint64  periodStart; uint32 period; uint32 opsPerPeriod;
  uint128 periodSpent6; uint32 periodOps;
}
struct Held { uint8 env; /*0 unadopted, 1 staging, 2 prod*/ bytes32 promoted; bytes32 createdBy; }
```

- **Session id.** `sid = keccak256(abi.encode(vault, x, y, grantNonce))`, so clients can compute it before the session opens.
- **Free balance.** It is derived, not stored: `free = usdc.balanceOf(vault) − locked6`. It collects ledger refunds (those pay `d.owner`, i.e. the vault), plus any USDC sent to the vault. Only the owner can withdraw it, and a session can never spend it.
- **Effective balance.** A session's effective balance is `balance6` while it is live and its `epoch` is current, and 0 otherwise.

### 3.3 Policy

The grant fields map one-to-one onto `Session`:

- **actions:** the bitmask, built from action names (§3.4). An unknown name reverts.
- **apps:** up to 8 entries. Each is either a slug under this vault (resolved with `catalog.appIdOf(vault, slug)` when the session opens) or `0x<appId>` for someone else's app (deploy only). `"*"` means any app (`anyApp`), and is still bounded by `maxAppFeeHour`.
- **environments:** `staging`, `prod`, or both.
- **budget:** the amount escrowed now.
- **Spend limits:**
  - `spendPerPeriod` over `periodSeconds`;
  - `opsPerPeriod` (the rate limit);
  - `maxFeePerOp` (the per-transaction gas cap, in USDC);
  - `maxAppFeePerHour` (the publisher-fee ceiling on `create`).
- **expiresAt:** after this, no operation passes and anyone may `close`.
- **measurement:** phase g.

### 3.4 Action table

The vault **builds every call itself** from typed arguments. It never forwards caller calldata, never calls an address that isn't a target below, and never grants an allowance that outlives the call.

| bit | action | target | built call | extra checks |
|---|---|---|---|---|
| 0 | `deploy.create` | ledger | `create(appRef, gpu, cpu, port, ports, isPublic, cfg, feeTo, feeSec, maxRate)`, then an optional `fundFor` | Parse `appRef` as `catalog://<appId>/<idx>` (the same parser as `EnclaveReviews._refAppId`), with the appId in the policy. `feeSec` must equal `catalog.versionFee(appId, idx)`, and `feeTo` must equal the app's `publisher` whenever `feeSec > 0` (the ledger checks neither). Also `feeSec*3600 ≤ maxAppFeeHour`. The environment must be in the policy. Records `held[id] = {env, promoted: 0, createdBy: sid}`. |
| 1 | `deploy.fund` | ledger | `fundFor(id, v, payer)` | `d.owner ∈ {vault, owner}`. `payer = d.owner`, so refund attribution follows the owner (wallet or vault). As built: v1 vault-held only; v2 adds wallet-held records as `prod`, a paid one only when its app is named (§16). |
| 2 | `deploy.setAppRef` | ledger | `setAppRef(id, ref)` | Held **staging** only; appId in policy. |
| 3 | `deploy.setConfig` | ledger | `setConfig(id, cfg)` | Held **staging** only. |
| 4 | `deploy.setShares` | ledger | `setShares(id, g, c)` | Held, with its environment in the policy. v2: also wallet-held records, as `prod`, once the owner delegates (§16); the same applies to bits 5-7. |
| 5 | `deploy.setMaxRate` | ledger | `setMaxRate(id, r)` | Same. |
| 6 | `deploy.setActive` | ledger | `setActive(id, b)` | Same. |
| 7 | `deploy.refund` | ledger | `refund(id)` | Same. Proceeds land in the **free balance** (owner's), never the session's. |
| 8 | `app.publish` | catalog | `publishVersion` / `publishVersionCfg` | The slug must be a vault slug in the policy. Publisher fee must be 0 in v1. |
| 9 | `order.pay` | PaymentRouter | `pay(amount, orderRef)` | — |
| 128+ | `api.status`, `api.logs`, `api.restart`, `api.upload`, `api.appAccess`, `api.placement` | — (off-chain) | — | Enforced by the relay and supervisor from the on-chain mask (§6). |

- **Spending:** for every money-moving action, `amount + fee` is debited from `balance6` and checked against the period counters before any external call.
- **Self-termination:** every session may terminate *itself*. It isn't a grantable bit.

**Never possible for a session**, whatever the policy. These are owner-only, matching your list:

- top-up, extend, withdraw;
- `Promote` (setAppRef or setConfig on prod), changing environment, adopt, release (`transferDeployment`);
- open, modify or revoke any session, including `revokeAll`;
- secrets (off-chain, still checked against the owner's wallet signature);
- catalog yank, delist and edit; app transfer or approval (governance);
- anything touching the treasury or billing config (the vault has no such surface).

### 3.5 Owner operations

Each owner operation is available two ways:

- **Direct:** `msg.sender == owner`. Needs ETH; this is the path that requires no platform cooperation.
- **Signed:** an EIP-712 signature from the owner, which anyone may submit, so it can be gasless. Signatures are checked by ecrecover with low-s, or by ERC-1271 when the owner has code (e.g. a Safe). Each signed operation carries `opNonce` (unordered, single-use) and `signBefore`.

| op | effect |
|---|---|
| `open(grant)` / `openWithDeposit(grant, auth3009)` | §3.7 |
| `TopUp(sid, amount)` | From the free balance (EIP-712), **or** from the wallet with an EIP-3009 `receiveWithAuthorization` whose `nonce` is the TopUp digest. Either way it is one signature. |
| `Extend(sid, expiresAt)` | Only moves expiry. |
| `Terminate(sid)` | Refunds the session's balance to the owner wallet now. |
| `RevokeAll(withdraw)` | `epoch++` and `locked6 = 0`, so every session dies in O(1) and its balance becomes free. If `withdraw` is set, the vault's whole balance goes to the owner in the same call. |
| `Withdraw(amount)` | Free balance to the owner **only**: there is no recipient field. |
| `Promote(id, appRef, configCid, versionLabel)` | Sets the ref and config through ledger `multicall` (unchanged fields are skipped) and records `promoted`. `versionLabel` must equal `catalog.getVersion(appId, idx).version`. |
| `Adopt(id, env)` / `SetEnvironment(id, env)` | Staging→prod sets `promoted` to the current state. |
| `Release(id, to)` | `transferDeployment(id, to)` with `to ∈ {owner, vaultFor(owner) at the book's current factory}`. A derived destination, as in the credit vault's `migrateToSuccessor`. |
| `ownerCall(target, data)` | **Direct path only.** `target ∈ {book ledger, book catalog}`. The owner's full authority over held resources (yank, delist, edit, anything not covered by a typed op). It is never signable, so a phished signature can't reach it. |

### 3.6 Typed data (EIP-712)

- **Domain:** `{name: "Enclave Sessions", version: "1", chainId, verifyingContract: vault}`. The vault address is used even before the vault exists, via CREATE2.
- **No nested arrays:** structs are flat, because the Trezor rejects nested arrays.
- **Raw numbers:** amounts are USDC with 6 decimals and times are unix seconds. The device shows them raw (e.g. `5000000`), so the grant page prints the same raw values next to their readable form for comparison.

```
SessionGrant(
  string label, string preset, bytes32 sessionKey,
  string[] actions, string[] apps, string[] environments,
  uint256 budget, uint256 spendPerPeriod, uint32 periodSeconds, uint32 opsPerPeriod,
  uint256 maxFeePerOp, uint256 maxAppFeePerHour,
  uint64 expiresAt, bytes32 measurement, bytes32 grantNonce, uint64 signBefore)

SessionCall(bytes32 sessionId, uint256 nonce, uint8 action, bytes32 argsHash, uint256 fee, uint64 deadline)
  // signed by the P-256 session key; nonce = (lane << 64) | seq

TopUp(bytes32 sessionId, uint256 amount, bytes32 opNonce, uint64 signBefore)
Extend(bytes32 sessionId, uint64 expiresAt, bytes32 opNonce, uint64 signBefore)
Terminate(bytes32 sessionId, bytes32 opNonce, uint64 signBefore)       // owner OR session key
RevokeAll(bool withdraw, bytes32 opNonce, uint64 signBefore)
Withdraw(uint256 amount, bytes32 opNonce, uint64 signBefore)
Promote(bytes32 deployment, string app, address publisher, string appRef, string configCid, string versionLabel,
        bool isPublic, bytes32 opNonce, uint64 signBefore)                // as built, §15
Adopt(bytes32 deployment, string environment, bytes32 opNonce, uint64 signBefore)
SetEnvironment(bytes32 deployment, string environment, bytes32 opNonce, uint64 signBefore)
Release(bytes32 deployment, address to, bytes32 opNonce, uint64 signBefore)
```

**Session-key signatures.**
- WebCrypto and Node both sign `SHA-256(message)`, so the vault verifies `P256VERIFY(sha256(eip712Digest), r, s, x, y)`.
- These are raw P1363 `r‖s` signatures, not WebAuthn: a session key signs silently, which is the point of a session.
- `keccak256(abi.encode(x, y))` must equal `session.keyHash`.
- Malleability doesn't matter, because replay protection is the nonce lane, not the signature bytes.

### 3.7 Flows

**Open (zero budget).** Once the owner has signed the `SessionGrant`:
1. The relayer calls `factory.openFor(owner, grant, sig)`, which creates the vault if needed and then calls `vault.open`.
2. The vault verifies the owner's signature, checks the policy against the action table, resolves the apps and stores the session.
3. It emits `SessionOpened(sid, keyHash, label, expiresAt, actions, envs)`.

That is **1 signature**.

**Open with deposit (D1).**
- **Readable (default).** Two signatures, both readable typed data: the `SessionGrant`, and a USDC `ReceiveWithAuthorization(from = owner, to = vault, value = budget, nonce = grantDigest)`.
  - One transaction: `openWithDeposit` verifies the grant, then calls `usdc.receiveWithAuthorization`. Making the nonce the grant digest means the USDC authorization can't be reused for anything else.
- **Quick (optional).** **1 signature**: only the USDC authorization, with `nonce = grantDigest`. The vault accepts the grant that the nonce commits to. The device shows the amount and the vault address, **but not the policy**.

**Top-up.** One signature: either `TopUp` from the free balance, or a USDC authorization from the wallet with nonce = the TopUp digest.

**Session operation.**
1. The SDK reads the vault state and checks policy, budget, expiry and rate *before* signing.
2. It asks the relayer for a fee quote.
3. It signs `SessionCall` with `args`.
4. The relayer simulates the call, then submits `vault.call(sid, nonce, action, args, fee, deadline, x, y, r, s)`.

Inside the vault, in this order: `nonReentrant` → expiry, state and epoch → `seq[sid][lane]++` (must match) → signature → period roll and counters → action checks → debit `amount + fee` → **approve exactly the amount** → external call → **assert the allowance is back to 0** → pay the fee via `router.pay(fee, keccak("enclave.session.fee", vault, sid, nonce))` → emit `SessionOp(sid, nonce, action, argsHash, amount, fee)`.

Errors are typed custom errors: `Expired`, `Revoked`, `NotAllowed(action)`, `EnvNotAllowed`, `AppNotAllowed`, `BudgetExceeded(need, have)`, `PeriodLimit`, `RateLimit`, `FeeTooHigh`, `BadNonce`, `BadSignature`. The UI maps them to prompts (§9.3).

**Terminate.**
- **By the session key:** it signs `Terminate`. On sign-out the SDK sends it to the relayer, which revokes API access *first* (§6.2) and then submits.
- **By the owner:** a signed `Terminate`, or a direct call.
- **Either way:** the remaining balance goes **to the owner's wallet** and the session ends.

**Close.**
- Anyone may call `close(sid)` once a session has expired. It refunds the owner, minus a closing fee of at most `maxFeePerOp`, paid to the router.
- The keeper (§5.2) calls it.
- Sessions killed by `revokeAll` have nothing left to close.

### 3.8 Money

- **Outflows** go to exactly three places:
  - the book-resolved ledger, via `fundFor`/`create`+`fundFor` with exact approvals;
  - the pinned PaymentRouter (orders and fees, which reach the treasury);
  - `owner` (terminate, close, withdraw, revokeAll).
- **No arbitrary recipient.** No function takes an arbitrary recipient, and no allowance survives a call.
- **What a leaked key can do with money.** It can only push budget *into the platform*, and most of that is recoverable: unused ledger balance refunds to the vault. The exceptions are publisher fees, which are bounded by `maxAppFeeHour` and bound to the catalog's recipient, and runner earnings, which are paid for runtime actually served.
- **Invariants** (tested, §12):
  1. Σ effective balances of live sessions = `locked6`.
  2. `usdc.balanceOf(vault) ≥ locked6`.
  3. A session's lifetime spend never exceeds what was deposited into it.
  4. Every period counter stays within its limit.
  5. The allowance of every spender is 0 between transactions.
  6. The owner can always `terminate`, `revokeAll` and `withdraw`, even if the book is broken or reverts.

  Your stated invariant, "sum of session balances == vault USDC balance", becomes invariant 1 plus `balanceOf = locked6 + free`. A ledger refund lands in the vault on purpose, and USDC sent to the vault can't be refused, so an exact equality isn't possible.
- **Reentrancy.** A guard on every external entry, and checks-effects-interactions throughout. The ledger and catalog are external code controlled by governance, so the guard is not optional.
- **Beta cap (D5).** `balanceOf(vault)` after any deposit must be ≤ `MAX_VAULT_6`, an immutable per factory.

### 3.9 Size and gas

- **Size.** The implementation must fit under 24,576 bytes. If it doesn't, the call builders and the appRef parser move to a linked library, the same way the ledger uses `EnclaveLedgerBandwidth`. Clones are 45 bytes.
- **Gas (estimates, to be measured in phase a).**
  - Opening a session: about 150–250k gas, plus about 60k the first time for the clone.
  - A session operation: about 6.9k for P-256, plus about 10–25k for policy and counters, plus the target call, plus about 35k when a fee is paid through the router.
  - At Base's current fee levels this is cents or less per operation. The fee quote (§5.1) passes the real cost through.

### 3.10 Upgrade policy (D5)

- **Immutable.** There is no proxy, no admin, no pause and no recovery key, so nothing exists that could freeze or move funds.
- **How a new version ships:**
  1. Deploy a new factory and repoint `sessionVaultFactory` in the book.
  2. Frontends open new sessions there.
  3. Old vaults keep working for their owners forever, because owner paths don't read the book.
- **How an owner migrates:**
  - Close sessions and withdraw (or let them expire).
  - Move held deployments with `Release(id, vaultFor(owner) at the new factory)`.
  - Vault-held catalog apps can't be moved by the vault, since `transferApp` is governance-only. The old vault can still publish to them through `ownerCall`, or the owner creates a new staging app.
- **Responding to a critical bug:**
  1. The relayer stops accepting the affected factory.
  2. The keeper closes every session, which refunds owners.
  3. The site shows a banner.

  Owners can always withdraw directly.

  An admin pause would protect funds only by creating exactly the freeze power your rules forbid, so there is none.

Why immutable rather than an upgradeable proxy: anyone holding an upgrade key can take the funds. A timelocked upgrade only delays that, and it adds proxy and storage-collision surface to audit. The platform's custody contracts are already immutable (PaymentRouter, credit vault), so this follows the same rule.

---

## 4. Platform contract integration (phase b)

1. **Ledger: no change.** Custody (§2.2) covers control, and `fundFor` covers funding wallet-held deployments. Schema 16 is still unmerged and is one byte under the limit, so revisit forwarder support only if the ledger is ever split or refactored. **Changed 2026-10-07:** the live rev 15 gained owner-approved delegates and was migrated as rev 15d (§16). Rev 16 on main does not have them yet.
2. **Catalog: no change for v1** with pattern P1 (§2.3). Optional rev 10 adds per-app delegates (P3).
3. **Address book:**
   - Add `sessionVaultFactory`.
   - Add a `DEFS` entry in `scripts/build-contract-artifacts.mjs` with `deployable: false` until audited, so the admin console can't deploy it by accident.
   - Add `deploy.yml` mapping only after the audit. New contracts don't auto-deploy today, which is the behaviour wanted until then.
4. **Off-chain owner resolution** (`owner(d)`, §2.2) is added in one shared helper. The relay part ships in phase c; the supervisor part in phase d.
5. **Indexer.** Indexes `VaultCreated` from the factory, then vault events for the known vault addresses. It recognises fee refs on PaymentRouter so they don't open `unmatched_payment` reviews.

---

## 5. Relayer and keeper (phase c)

### 5.1 Relayer (`relay/sessions/`, added to `relay/deploy.sh`)

- **Its own hot key.** `SESSIONS_RELAYER_KEY` is never `PROVISIONER_PRIVATE_KEY`. It has its own nonce manager, which also fixes §1.7#1 for this path.
- **Its own network config.** `SESSIONS_NETWORK=base|base-sepolia` with its own RPC pool, because `api-relay.js` is mainnet-only.
- **Submission:**
  - One serial queue with a durable write-ahead journal (`JsonStore`, `durable: true`) that records `{intent, nonce, hash, fees}` before broadcast.
  - If a transaction isn't mined within 30 s, it is replaced at the same nonce with fees +15%, up to a cap.
  - Dropped transactions are detected by re-reading nonce and receipt.
  - Every submission is simulated first (`eth_call`), and one that would revert is refused with the decoded error and never sent.
- **Fees:** the quote is `estimateGas × (2·baseFee + tip) × ETH/USD × (1 + margin)`, valid until the intent's deadline (≤ 120 s).
  - ETH/USD comes from the feed the ledger already uses (`setEthUsdFeed`), or the relay's price source if that feed is unset.
  - The SDK refuses a quote above `maxFeePerOp`, or above its own estimate × 2.
  - Owner operations are free (fee 0) and rate-limited per owner (e.g. 50 a day), because the grant shows no fee field.
- **Endpoints:**
  - `POST /v1/sessions/quote`
  - `POST /open`
  - `POST /intent`
  - `POST /owner-op`
  - `POST /terminate`
  - `GET /v1/sessions?owner=0x…`
  - `GET /v1/sessions/:vault/:sid`, which returns the record, events, action log and spend versus limits
- **Abuse limits:** per vault, per session and per IP. A cap on pending intents per session. OFAC screening of `owner` before any deposit or top-up (D7).
- **Alerts** go through the existing `ALERT_WEBHOOK_URL`:
  - `sessions_relayer_low_gas`;
  - `sessions_stuck_tx`;
  - `sessions_close_overdue` (an expired session still holding more than $0 an hour after expiry).
- **What the relayer is trusted for:** liveness only. It can't forge signatures, change amounts or redirect funds. If it censors, the owner can submit an owner-signed operation from any wallet, or call directly. `@enclave/sessions` takes `submitDirect(walletClient)` for that.

### 5.2 Keeper

- A relay loop every 60 s closes expired sessions that still hold a balance, reimbursed by the closing fee.
- It is idempotent: `close` on an ended session reverts, and the keeper treats that as success.
- **If it fails:** nothing is at risk. Expired sessions can't spend (expiry is checked on every operation), and their funds stay the owner's. The owner, or anyone, can close or withdraw at any time. API access ends at expiry on its own (§6.2). The `sessions_close_overdue` alert flags the backlog.

---

## 6. Session-bound API auth (phase d)

### 6.1 Request signing

- **Relay routes** accept:

  ```
  Authorization: EnclaveSession v1 vault=<addr>,sid=<0x…>,ts=<unix>,n=<nonce>,x=<b64url>,y=<b64url>,sig=<b64url>
  ```

  `sig` is a P-256 signature over:

  ```
  "enclave-api-v1\n" + method + "\n" + host + path + "\n" + sha256(body) + "\n" + ts + "\n" + n
    + "\n" + lowercase(vault) + "\n" + lowercase(sid)                   // as built (§15)
  ```

  The relay checks, in order:
  1. `ts` is within 60 s and `n` hasn't been seen (replay cache);
  2. the key hashes to `session.keyHash`;
  3. the session is live (§6.2);
  4. the endpoint's scope bit is set;
  5. the beneficial owner owns the target deployment.

  No bearer token is issued.

- **Supervisor routes** (logs, restart, app token, private access, WebSocket log streams) need a token. `POST /v1/auth/session-login` takes a session-signed challenge. The supervisor verifies it **itself**, reading the vault over its own RPCs: it never trusts the relay's word, matching today's rule that the operator can't mint sessions. It then mints its usual in-enclave ES256 token with:
  - `sub` = owner;
  - `sid` and `scope`;
  - `exp = min(now + 15 min, expiresAt)`.

  Every request carrying a `sid` re-checks liveness (§6.2).

- **Never via a session:** `/v1/secrets/*` put and get stay owner-wallet signatures (`personal_sign` from the EOA, or 1271 through the vault for vault-held deployments). So do domains and encrypted-volume keys.

### 6.2 On-chain and off-chain never diverge

1. **Off-chain is never more permissive than on-chain.** Every check needs `vault.isLive(sid)` (state, epoch, expiry):
   - mutations read it fresh;
   - reads may use a cache of at most 5 s, kept warm by indexed events.
2. **Terminate revokes off-chain first.** The relay marks the `sid` revoked before submitting the on-chain terminate. If that transaction fails, the session stays revoked off-chain (fail closed) and the relay retries.
3. **Owner-direct terminates** (bypassing the relay) are caught by the event index and by liveness checks within 5 s.
4. **Supervisor tokens last ≤ 15 min** and re-check `sid`. Expiry needs no message at all.

### 6.3 Release coupling (D6)

The relay half ships with the relay. The supervisor half needs a measured release:

- session login;
- `owner(d)` for vault-held deployments;
- scope checks;
- the Windows node agent's copy of SIWE.

Until that release, vault-held deployments have no logs, restart or private access in the dashboard. Credit-vault rows have the same gap today.

---

## 7. Secret release changes (phase d; **STOP for your review before merge**)

For any deployment whose `d.owner` is a SessionVault, read with the existing quorum readers at the confirmed row:

- `held.env == 0` (unadopted): **refuse** all secrets.
- `held.env == staging`: release that deployment's secrets. These are staging secrets by construction: secrets are per deployment, and only the owner sets them.
- `held.env == prod`: release only if `held.promoted == keccak(appRef, configCid)` of the confirmed row. Otherwise refuse with `"awaiting owner promotion"`.

This applies to:

- path A (plaintext fetch, which today checks only the lease);
- path B (sealed SNP);
- path C (Shield).

Wallet-held deployments are unchanged. Sessions reach them only through the delegation of §16, which never changes what they run, so the wallet alone decides the code their secrets go to.

Every secret is still set only by the owner's wallet. A session can neither set nor read one, nor make a prod deployment run code the owner hasn't promoted. Instances already running keep their secrets, because the check runs at release and nothing depends on a live session (§1.4). Tests must also show that terminating or expiring a session changes no release decision.

---

## 8. SDK and CLI (phase e)

### 8.1 SDK: `sdk/sessions/`, TypeScript, built to ESM

- **Consumers:** the site (vendored like other libraries), the CLI, and agents (`@enclavehost/sessions`).
- **Dependencies:** `@noble/curves` and `@noble/hashes` only, plus a small EIP-712 encoder tested against viem in development, to keep the site bundle small.
- **Keys:**
  - `generateKey(storage)` → `{x, y, sign()}`.
  - `IndexedDbStorage`: WebCrypto `ECDSA P-256`, **non-extractable**, with the `CryptoKey` stored by structured clone.
  - `FileStorage`: `~/.config/enclave/sessions/<sid8>.json`, mode 0600, PKCS#8. It refuses paths inside a git working tree.
  - `EnvStorage`: `ENCLAVE_SESSION`, base64url JSON `{chainId, vault, sid, pkcs8}`.
- **Grants:**
  - `buildGrant({preset | policy, label, budget, expiresIn})`.
  - `grantTypedData(grant)` and `requestOwnerSignature(walletClient, grant)`. With a deposit, the latter also builds the EIP-3009 authorization.
  - `grantLink(grant)` → `https://enclave.host/grant#<b64url>`. The request lives in the **fragment**, so it never reaches a server.
- **Operations:**
  - `session.call(action, args)`: check locally, quote, sign, submit, wait. Raises typed errors (`BudgetExceeded`, `Expired`, `NotAllowed`, …).
  - `session.status()`: budget, spent, period window, expiry.
  - `session.terminate()`.
  - `ownerOps.*` for the wallet side: top-up, extend, terminate, revoke-all, withdraw, promote, adopt, release.
- **Presets:** plain policy templates in `sdk/sessions/presets.ts`. Adding one needs no backend or contract change.

| preset | actions | envs | apps | budget / period | expiry |
|---|---|---|---|---|---|
| `browser` (sign-in default) | `deploy.*`, `app.publish`, `order.pay`, `api.status/logs/restart/upload/appAccess/placement` | staging, prod | `*` (`maxAppFeePerHour` $1) | user-chosen, default $0 | user-chosen, default 12 h |
| `staging-publish` (agent) | `app.publish`, `deploy.create/fund/setAppRef/setConfig/setActive`, `api.status/logs/restart/upload` | staging | named slugs only | $5–$20; $5/day | 7 days (1–28) |
| `auth-only` | `api.status` | — | — | $0 | 12 h |

### 8.2 CLI: `enclave session …` in `cli/enclave.mjs`

```
enclave session new --preset staging-publish --app eyesoff-staging --budget 10 --days 7 --label "Claude Code"
  → prints the grant link and a 4-word check phrase (derived from the key hash; the grant page shows the same phrase)
  → waits for SessionOpened, then stores the key (FileStorage, or --env to print ENCLAVE_SESSION)
enclave session status | list | terminate [--sid] | top-up-link --amount 5
enclave session delegate [--revoke] [--status [--owner 0x…]]   (§16: the owner's one wallet transaction to the ledger)
```

Session-aware commands (`publish`, `deploy`, `fund`, `upgrade`, `config`, `stop`/`resume`, `logs`, `restart`) use the active session, if there is one, instead of the key file. Since §16 they also act on deployments the owner's wallet holds, as production, once the owner has delegated. A command outside the session's policy fails with the policy reason and a hint (`ask the owner for a session with deploy.setAppRef`). It never falls back to the wallet key.

### 8.3 ERC-7715 alignment

`toErc7715Request(grant)` emits:

- `{chainId, from: owner, to: vault, permission: {type: "enclave-session-v1", isAdjustmentAllowed: false, data: <policy>}, rules: [{type: "expiry", data: {timestamp}}]}`;
- a `signer: {type: "p256", publicKey}` extension;
- `context = abi.encode(vault, sid)` in the response.

Nothing depends on wallets supporting it. The signature the wallet produces is our EIP-712 grant.

---

## 9. Frontend (phase f, built on the SDK)

### 9.1 Sign-in

1. The sign-in modal asks for **budget** (default $0) and **duration** (1 h / 12 h / 7 d).
2. Connect the wallet.
3. Sign one `SessionGrant`, or two with a deposit (D1).
4. The key goes into IndexedDB.

This session replaces SIWE for wallet users. Existing SIWE tokens keep working until they expire, then the user is asked to open a session.

### 9.2 Indicator and actions

- **Header indicator:** balance, spent, time left, **Top up** and **Sign out**.
- **Call sites:** every `sendTx` call site in §1.2 becomes `session.call` for vault-held resources. Owner-only actions still prompt the wallet, but as gasless typed data, not ETH transactions: Promote, secrets, environment changes, Release, Withdraw, Adopt, yank or delist. Wallet-held deployments keep their wallet transactions, with a **Manage with sessions** move-in flow that explains the refund-first constraint. (As built, §16: no move-in. Once the owner grants the delegation, suspend, resume, resize, cancel and a lowered cap on a wallet-held row go through the session; version and config changes still ask the wallet.)
- **Sign-out:**
  1. The session key signs `Terminate`.
  2. The relayer revokes API access, then submits.
  3. The UI shows "refund of $X landed" with a transaction link.
  4. The key is deleted.

### 9.3 Running out mid-action

The SDK's checks run before signing, and the vault's typed errors back them up. The UI never fails silently:

- **BudgetExceeded / PeriodLimit:** a modal shows what's needed and offers **Top up (1 signature)**.
- **Expired:** **Extend (1 signature)**, or sign in again.
- **NotAllowed:** the user is told which owner action is needed.

The pending action resumes after the owner signs.

### 9.4 Pages

- `/grant#…` (the grant-from-link page, reusing `link.html`'s anti-phishing pattern). It shows:
  - the policy in plain language;
  - prominent warnings for `prod`, `*` apps, large budgets or long expiry;
  - the CLI's check phrase;
  - the label, shown as untrusted text.

  Then the owner signs.
- `/sessions` lists every live and recent session: this browser, other devices and agents. For each:
  - label and policy summary;
  - action log from `SessionOp` events;
  - spend versus limits;
  - **Terminate** (owner signature: works for lost keys and other devices);
  - **Revoke all**.
- **Passkey/card users (D8):** the same header component, sourced from credit-vault data ("Credit $X"). Their relay account sessions appear on `/sessions` read-only. A later option is to let a credit vault own a SessionVault for zero-budget, auth-only sessions through its ERC-1271 passkey check. No platform-held balance is introduced.

---

## 10. Attested session keys (phase g; **STOP for your review**)

- **The policy field.** `measurement ≠ 0` in a grant means the key must have been generated inside an enclave running that measurement. This is a policy field, not a different kind of session.
- **Key generation.** The guest makes the key and puts `sha256("enclave-session-key-v1" ‖ chainId ‖ x ‖ y)` in its attestation `report_data`. The vault is not part of it: the key exists before any vault is chosen, and a binding is keyed by the key alone.
- **Verification off-chain.** The relay verifies the quote with the verifiers it already has (`snp-verify`, `vbs-verify`, `hvnode-verify`, `avf-verify`), then writes `(keyHash → measurement, attestedAt)` to a new small contract, `EnclaveKeyAttestations` (book key `keyAttestations`). Only attestor addresses that governance names can write; the binding can be revoked, for example after a TCB advisory.
- **Enforcement in the vault.**
  - At `open`, it requires the key's recorded measurement to equal `grant.measurement`.
  - On every operation it checks the binding hasn't been revoked, a cheap external view.
- **Re-approval.** A changed image means a new measurement and a new key, so the owner signs a new grant.
- **Removing an attestor revokes everything it recorded.** Governance's `setAttestor(key, false)` makes every binding that attestor wrote read as revoked. A stolen attestor key is therefore cut off in one transaction. Re-adding the same address brings its bindings back, so a compromised attestor address must never be re-added.
- **What this trusts.** The attestor (the relay operator) is trusted to verify quotes honestly. A later step could verify on-chain, or use a quorum of attestors. This is exactly the attestation surface you asked to review by hand.

---

## 11. Threat model

| Threat | Bound or mitigation |
|---|---|
| **Leaked session key** (assumed) | Only actions in the policy, on the policy's apps and environments. Spend ≤ budget, per period ≤ limit, ≤ N operations per period, fee ≤ cap, until `expiresAt`. It **cannot**: withdraw, promote prod, read or set secrets, open/extend/top-up sessions, move custody, or send money anywhere except the owner's deployments, PaymentRouter and the catalog-bound publisher fee. Unused ledger balance it spends refunds to the owner's vault. The owner sees every operation on `/sessions` and kills it with `Terminate` or `RevokeAll`. **With §16 delegation and a `prod` grant**, the key can also suspend, downsize, cancel (refund to the wallet) and lower the cap of *any* app the wallet holds (the grant's `apps` list narrows only funding of paid apps), which is a denial-of-service lever on production. Revoking the delegation (one wallet transaction) removes it for every session at once. |
| **Prompt injection of an agent** | It acts within policy, so presets are narrow: staging only, named apps, $5/day, a week. Promotion needs the owner's device signature showing a *catalog-verified* version label. Agent sessions get no secrets and no prod access (the `staging-publish` preset's grant has no `prod`, so the §16 delegation never reaches it; the MCP server's broader `agent` preset does have `prod`, §16.5). Staging secrets should hold non-production values (the `/sessions` and secrets UIs say so). An injected agent can produce a grant link asking for a broad policy; the grant page flags breadth, and the device shows the real policy (D1 readable mode). Key exfiltration by an injected agent is the leaked-key row. |
| **Relayer compromise** | It can't forge or redirect funds (everything is signed and destinations are fixed). It can censor or delay: the SDK submits directly, and the owner can always act on-chain. A stolen hot key loses the relayer's ETH only; vaults are untouched. It can quote inflated fees: they're capped by policy and checked by the SDK. The relay can never vouch for a session to the supervisor, which verifies on-chain itself. A compromised relay can forge auth on relay-served routes it already controls, as today. |
| **Keeper failure** | Funds are not at risk (§5.2). Expiry is enforced on-chain and off-chain without the keeper. |
| **Compromised site / XSS** | A non-extractable key can still be *used* by script in the page, within policy. Readable on-device grants stop silent policy swaps. CSP, and no third-party script on the sign-in and grant pages. |
| **Grant phishing** (another site asks for a `SessionGrant`) | The same class as permit phishing. The domain name "Enclave Sessions" and the vault address show on the device. The browser wallet shows the requesting origin. Grants are readable, so a phished grant still shows its policy. |
| **Governance or address-book compromise** | A repointed ledger or catalog can receive session calls, but only exact, single-use allowances: at most one operation's amount. Owner paths never read the book. PaymentRouter is pinned. |
| **Gifted or hostile deployments** | Inert until the owner `Adopt`s them. |
| **Replay and cross-chain replay** | The EIP-712 domain includes `chainId` and the vault. Nonces are per-session lanes and single-use owner nonces. |
| **Reentrancy** via the ledger or catalog | Guard plus CEI. Invariant tests run hostile mock targets. |
| **On-chain/off-chain divergence** | §6.2: fail closed, revocation off-chain first, liveness checks. |
| **Owner key compromise** | Out of scope. The owner is the root, as today. |

---

## 12. Testing and audit plan

- **Foundry, unit tests:**
  - every action's allow and deny matrix;
  - every typed error;
  - the appRef parser;
  - fee binding to the catalog;
  - environment rules;
  - 2D nonces;
  - signatures (`vm.signP256`, wrong key, wrong domain, expired, replay);
  - EIP-3009 deposit with `nonce = grantDigest` (wrong nonce, wrong `from`);
  - 1271 owner;
  - the beta cap.
- **Foundry, fuzz:** policies times intents, period rollovers, amount edges, and dust gifts to the vault.
- **Foundry, invariants** (handler-based): the invariants in §3.8, against the **real** `EnclaveDeployments` and `EnclaveAppCatalog`, plus hostile mocks that re-enter, revert, return garbage, and pull more than approved.
- **Mutation testing** of the policy checks, in the style of earlier ledger work: every deleted check must fail a test.
- **Node:** the relayer against the stub RPC and anvil (journal recovery, replacement, simulation refusals), auth headers, and the liveness cache.
- **Playwright end to end:** sign-in at zero budget, top-up, deploy via session, budget exhaustion prompt, sign-out refund, revoke-all, and the grant-link flow.
- **External audit** before mainnet, scoped to SessionVault, the factory, the action library and (phase g) EnclaveKeyAttestations, then a bug bounty. Mainnet launches with the beta cap. Base Sepolia runs a full rehearsal first: `scripts/deploy-session-vault.mjs` with `NETWORK=base-sepolia` (the default), its own book, ledger and catalog, and Sepolia USDC.

---

## 13. Phases and stop points

| Phase | Content | Stop |
|---|---|---|
| a | SessionVault, factory, action library and Foundry suite. `deploy-session-vault.mjs` for Base Sepolia. | **Fund custody: stop for your review before merge.** |
| b | Book key, artifacts entry (`deployable: false`), off-chain `owner(d)` helper, indexer and fee-ref recognition. | — |
| c | Relayer and keeper (`relay/sessions/`, its own key, network and journal). | — |
| d | API auth on the relay; supervisor session login (release, D6); secret release gate (§7). | **Secret release: stop for review.** The supervisor release waits for your hold decision. |
| e | SDK, CLI, and the guide `docs/guides/claude-code-staging-session.md`. | — |
| f | Site: sign-in, indicator, call-site migration, `/grant`, `/sessions`. | — |
| g | Attested keys (EnclaveKeyAttestations, attestor service, vault check). | **Attestation: stop for review.** |

Nothing merges to main while the deploy base is stale (any push to main currently cuts a release). Work stays on `sessions/*` branches, and only the secret scan runs on them.

## 14. Open questions (beyond D1–D8)

1. **Default browser sign-in duration.** 12 h proposed. Should `/sessions` let the owner set a maximum for each preset?
2. **Should `deploy.refund` be in the browser preset for prod?** It stops a running prod deployment, which is a denial-of-service lever if the key leaks. Proposed: in for staging, opt-in for prod. (As built, the browser preset includes it for both, and with the §16 delegation it reaches wallet-held apps too.)
3. **Domains and placement.** Placement is proposed as a session scope; domains as owner-only. Agree?
4. **Should `order.pay` exist in v1?** The site has no PaymentRouter order flow wired up today, so it could wait until one exists.

## 15. As built (deltas from the text above)

**Code map**

| Area | Files |
|---|---|
| Contracts | `contracts/SessionVault.sol` (SessionVault, SessionVaultLib (linked), SessionVaultFactory); `contracts/EnclaveKeyAttestations.sol`; `deploy/ledger/EnclaveDeployments.sol` (ledger rev 15d, §16) |
| Tests | `contracts/foundry/test/SessionVault*.t.sol` (unit, fuzz, handler invariants; `SessionVaultDelegate.t.sol` runs on the rev 15d ledger); `contracts/foundry/test/session-vault-mutants.py` (67 mutants) |
| Relay | `relay/sessions.mjs` (relayer, keeper, index, API verifier, custody gate), wired in `relay/api-relay.js`; `relay/auth.js` (`/v1/account/session-login`); custody gate in `relay/secrets.js`, `secrets-release.mjs`, `shield-secrets.mjs`; beneficial owner in `relay/domains.js`, `placement.mjs` |
| SDK | `sdk/sessions/` (TypeScript; `dist/node.mjs`, `dist/browser.mjs` -> `site/vendor/sessions.js`); delegation in `src/delegate.ts` |
| CLI | `cli/enclave.mjs` `enclave session …` |
| Site | `site/js/core/sessions.js`, `ledger-calls.js`; `/grant`, `/sessions`; wallet popover + button indicator; deployments panel routing |
| Deploy | `scripts/deploy-session-vault.mjs`, `scripts/deploy-key-attestations.mjs`; ledger cutover `scripts/migrate-ledger-delegates.mjs`, `scripts/ledger-cutover-rehearsal.mjs` |
| Records | `contracts/deployments/sessions-base.json` (v1), `contracts/deployments/ledger-15d-base.json` (ledger 15d + vault v2) |
| Tests (node / e2e) | `test/sessions.test.mjs`, `test/cli-session.test.mjs`, `test/sessions-attest.test.mjs`, `test/site-ledger-calls.test.mjs`, `e2e/tests/sessions.spec.mjs` |
| Guide | `docs/guides/claude-code-staging-session.md` |

**Deltas**

- **No ERC-1271 on the vault** (changes §2.2). USDC honours 1271 for `permit` and EIP-3009. If the vault vouched for owner signatures, a phished owner signature over a USDC permit naming the VAULT as owner would drain escrow around the session accounting. Off-chain owner checks resolve `vault.owner()` instead; that is the relay custody gate's `beneficialOwner`.
- **`ownerCall`** is direct-only (never signable) and may target any contract except USDC and the vault itself, not just the book's ledger and catalog. The owner then keeps full control of held resources even if the book is repointed or broken. A post-call check refuses any state where `balanceOf < locked6`.
- **D1:** only the readable path exists: a funded open is the grant plus a USDC authorization whose nonce is the grant digest. There is no "quick" single-signature open. A top-up is one signature: a USDC authorization whose nonce is the TopUp digest.
- **`create()` publisher fee:** the vault never takes `feeRecipient` or `feePerSec6` from the caller. It reads them from the catalog (`versionFee`, plus the app `publisher` when the fee is non-zero), capped by the grant's `maxAppFeePerHour`.
- **Browser preset** omits `app.publish`: a browser user's apps are wallet-published, and `app.publish` only ever reaches vault-held apps. Fee ceilings were calibrated against measured gas, so a session op costs 0.16M–0.68M gas, about $0.004–0.015 at Base fees on 2026-10-06.

| Preset | Max fee per op | Daily spend |
|---|---|---|
| browser | $0.25 | $100 |
| staging-publish | $0.10 | $5 |

- **Relay endpoints** (§5.1) as built, under `https://api.enclave.host/v1/sessions`: `GET /config`, `POST /quote`, `POST /execute` (was `/intent`), `POST /open`, `POST /owner` (was `/owner-op`; `op` is one of `topUp`, `topUpWithAuthorization`, `extend`, `terminate`, `revokeAll`, `withdraw`, `promote`, `adopt`, `setEnvironment`, `release`), `POST /end` (was `/terminate`; the session key's own sign-out), `GET /by-key/<keyHash>`, `GET /owner/<address>` (was `?owner=`; it also reports `delegation`, §16), `GET /session/<vault>/<sid>`, `POST /attest` (phase g). Responses carry bigints as `"123n"` strings; requests accept those, decimal strings, or safe integers.
- **Account token from a session** (§6): `POST /v1/account/session-login`, signed by the session key with an `EnclaveSession` header. It mints an ordinary relay account token carrying `sid` and `vault`, which expires no later than the session. Every use re-checks liveness on-chain (5 s cache), so sign-out, expiry, terminate and revokeAll all end it. Wallet sign-in in the site uses this: one wallet signature, no SIWE.
- **Hosts take the session per request (replaces D6 and §6.1's planned `session-login`):** the supervisor and the Windows node accept `Authorization: EnclaveSession v1 …` wherever they took the host's SIWE token, and verify it themselves on chain (`windows/node/session-api-auth.mjs`, shared; the supervisor image COPYs it, the Windows node ships it through `deploy-files.mjs`). No host token is minted. Each request is checked for: the signature; `ts` within 60 s; a nonce unused on THIS host (each host keeps its own replay set, so the relay's list fan-out works); a vault from a known factory (the book's `sessionVaultFactory`, else `SESSIONS_FACTORIES`, default v2 + v1); a live session holding the key, with the route's scope; and the record rule (vault-held: the session's environments; wallet-held: production and the owner's ledger delegation; anything else 403). Reads are cached ≤ 5 s, and mutations read fresh.
  - **Scopes:** list, get, `/v1/account`, top-up instructions and the attestation owner perk need `api.status`. Logs and cpu-profile need `api.logs`. Restart and DELETE need `api.restart`: DELETE stops the instance and hands the lease back, which is a restart's disruption and never a money move. App-token and a Windows private app's data path need `api.appAccess`. Legacy `POST /v1/deployments` refuses sessions; create on-chain instead.
  - **App-token:** the token is minted for the record's owner (the vault for a vault-held record), so redemption and the data path compare as before.
  - **What the signature is checked against (hostPath):** the client signs the host, path and query of the URL it called. The relay forwards `/v1/deployments/<id>/…` with the path untouched. It strips `/t/<name>` from `/t/<name>/…`. It rewrites the Host header for a direct box and passes it through on a tunnel. So a host never trusts the Host header. It accepts `base + path-as-received` for each base in a fixed list: every API front door (`SESSION_API_HOSTS`, default `api.enclave.host`), each front door with `/t/<tunnel name>` (from `PUBLIC_URL` or `SESSION_API_TUNNEL_NAMES`; the Windows node's `NODE_NAME`), and the host's own public URLs (`PUBLIC_URL`, the attested certificate SAN). On a Windows private app's data path, the app's own hostnames are added too.
  - The relay must forward `Authorization`, the raw body (byte for byte) and the path and query unchanged (or with only `/t/<name>` stripped).
  - The relay's off-chain sign-out reaches hosts only when the end is mined, usually within seconds.
- **Off-chain revocation happens after the vault accepts:** the relay revokes a session's API access only after the vault has accepted the terminate or revoke signature in simulation, then submits. A forged sign-out request can't cut anyone off.
- **Deployments panel:** every owner-gated ledger call the panel builds goes through `ledgerSend`. A row held by the wallet's vault is decoded and replayed as the matching session action; on prod, version and config changes become one owner Promote signature. Wallet-held rows send the same wallet transaction as before.
- **Beta cap (D5):** `MAX_VAULT_USD` defaults to $250 per vault in the deploy script. No deposit may lift a vault's balance above it; ledger refunds can.
- **Funding buys runtime at a price the grant allows** (second review, F1/F3). The ledger splits every funding by the record's *current* rate, not by the cap the vault checked at create. A host's zero job-rate claim followed by `release` leaves the rate at the fee (or at 0 for a free app); a funding then pays the publisher (or the platform) everything, escrows nothing for a runner, and refunds nothing. So `deploy.fund` now:
  - refuses a record whose cap is 0 or above the grant's `maxRatePerHour`;
  - re-bases a record with **no lease attached** (never claimed, or released) on its cap first (`setMaxRate(id, cap)`, the ledger's own unleased rule);
  - never re-bases a record with a lease attached, whether live or expired but not yet released or re-claimed (third review, F-A). The ledger's `setMaxRate` re-snaps the runner rate *without crediting that runner first*. A zero-rate squatter that let its lease lapse would be paid its whole unpaid tail at the cap's runner rate, out of the owner's escrow. The third review's PoC had it taking $7.20 of $10 in fundings while serving nothing. That record's own rate must pass as it is;
  - refuses (`FundRateTooLow`) when the rate the funding would split at is under twice the fee, or leaves a runner share of 0 (fifth review, F1). A job rate of 1 rounds the runner rate down to 0, so the funding would go wholly to the platform with nothing refundable. Such a lease is funded from the owner's wallet, never by a session. This assumes the ledger's `runnerBps` > 0 (8000 live on 2026-10-07); at 0, every session funding refuses.

  `deploy.setMaxRate` refuses a cap under twice the fee. It also refuses (`LeaseUnsettled`) while a lapsed lease is still attached, for the same reason. Changing the cap under a live lease, or with no lease, is unaffected.

  `deploy.setShares` under an attached lease, live or lapsed, may not raise the runner rate (fourth review, F-1; also `LeaseUnsettled`). In proof mode, production's default, the ledger credits a runner only up to its last proof before re-pricing, and pays the unproven stretch later at the *current* runner rate. A resize that raised it would pay a lagging or zero-rate host for time the tenant was charged less for. The review's PoC showed $16 of $20 taken. A downsize that lowers the rate still works. To upsize a running app: stop it, let the host release, resize, start. **Never resize or re-cap a record while a runner is attached, not even as the owner through `ownerCall`.** The ledger's owner paths have the same flaw, and the fifth review's PoC paid a squatter $8 of $10 that way. No client builds such an `ownerCall`. `contracts/foundry/test/SessionVaultProof.t.sol` runs these cases with proofs on, through the real `EnclaveProofOfTime`.

  The everyday top-up still works. When an app runs its balance down, the host can't renew and the lease lapses still attached. The session then funds it at the rate the host actually charged, and the host re-claims.

  **Known limitation (griefing, third review F-B).** Any registered operator can offer a job rate of 0, claim a free app's record, and renew for free indefinitely (on a paid app the rate is the fee). Every session funding of that record then reverts `FundRateTooLow`. No money moves, but the app isn't served. The vault can't fix this: the cause is the deployed ledger (a job rate of 0 is allowed, and `release` leaves the rate behind). It needs a ledger change, or monitoring of zero-rate claims on vault-held records. A host honestly priced under the fee also blocks session top-ups for its lease.
- **`ownerCall` refuses `multicall(bytes[])`** on any target (second review, F2): a batch could carry a `transferDeployment` that the custody cleanup can't see. The owner makes one call at a time.
- **Promote binds the publisher and the exposure** (second review, F6). Slugs are unique only per publisher, so anyone can publish a copy of an app's slug and version label. Promote now signs the app's `publisher` address and the record's `isPublic`, and the vault checks both against the catalog and the ledger. A session chooses `isPublic` at create, and the ledger can't change it afterwards. The `/sessions` promote prompt names the publisher ("you", "your vault", or the address marked NOT you), the config CID and public or private access. Ports and shares are not bound: they are routing, while the promoted code and config are what secrets are released to.
- **Custody gate needs no factory list** (second review, F4). The gate applies to any contract owner that answers `held(id)`, not just vaults of factories the relay knows. A vault from a factory rotated out of the book still has its unadopted and unpromoted records refused. An impostor contract answering `held()` only makes its own records stricter. A contract with no `held()` (it reverts or returns nothing) passes like a wallet. Any other read failure throws, and the release paths refuse. A vault of a factory the relay knows (the book's, `SESSIONS_FACTORY`, `SESSIONS_FACTORIES`) must answer `held()`: an empty result from a lagging node, or any error, refuses the release (third review, F-C). The lenient "no `held()`" reading applies only to contracts the relay doesn't know, so **list every factory ever run in `SESSIONS_FACTORIES`**.
- **Session account tokens never move a passkey credit vault's deployments** (third review, F-D). Placement's `accountOwner` refuses a session-derived account token. Sessions place vault-held records through `api.placement`.
- **SSO tokens from a session are short** (second review, F5). An `est1` token can't be recalled once an app holds it. One minted with a session-derived account token lasts at most 10 minutes and never beyond that token's expiry.
- **Known limitation, ledger migration** (second review, F7). `held` is keyed by deployment id alone. If the book ever points at a new ledger that does not import the vault's records, the new ledger re-issues `keccak(vault, n)` ids, and session `create` reverts `Exists` until the nonce passes them. The vault keeps refusing rather than overwriting a custody record. The owner recovers by creating through `ownerCall` (which advances the ledger nonce), then releasing or re-adopting those records. A migration that imports records (the ledger's `importDeployments` path) is unaffected.
- **Demoting prod to staging re-opens its secrets to session-chosen code.** `setEnvironment(id, "staging")` clears `promoted`. Secrets are stored per deployment, not per environment, so the record's existing production secrets become releasable to whatever a staging session points it at. Only the owner can do this, and it is deliberate; owner UIs must say so before signing.
- **Relay hardening after the custody review (2026-10-07):**
  - **The custody gate never fails open on a missing code answer.** Any vault in the relay's own `VaultCreated` index, or confirmed by a known factory, gets the strict `held()` read regardless of `getCode`. Nothing negative is cached on the release path, so one empty `getCode` from a lagging or lying node opens no window. Reading custody through the multi-RPC quorum that paths B and C use for rows is a follow-up; today the gate reads through the relay's `BASE_RPC`.
  - **The signed string covers the vault and the session id** (see §6.1). One key may serve several sessions, such as an attested agent key, and a request signed for one session must never verify under another.
  - **The replay cache claims `sid:n` before any await**, so concurrent copies of one signed request can't all verify.
  - **A relay-submitted `revokeAll` also covers sessions the index hasn't seen yet.** While the revoke is in flight, for at most 10 minutes, every session of that vault is refused. Once it mines, a session passes only if the index saw it open after that block. The session status route reports the same.
  - **The custody gate is optional inside each release module:** a missing hook means no gate. The relay hand-deploy therefore greps the staged files for the hook on all three paths and for `api-relay.js` passing it, and refuses to install otherwise.
  - **Known gaps.** Path A's plaintext fetch carries only the deployment id, so around a Promote on the same id, a host with a stale ledger view could launch the old staging code with secrets just set for prod. Paths B and C bind the measurement to the confirmed row. Secrets stay with a record across `adopt "staging"` as well as prod→staging. Adopting a record as staging hands its stored secrets to whatever code a session points it at.
- **In production (2026-10-07, v1; superseded for new sessions the same day by vault v2, §16.4):** contracts on Base mainnet, recorded in `contracts/deployments/sessions-base.json`: factory `0x00bB59c40768aA56E292b4E789f9f3B5826E3a8d` (block 52280280), library `0xa55729550e6508fA3D59CF5744941Db30790FBab`, key attestations `0xB49241eFE5AF6078BE6aa84850ae45eed34dF61b`. Every constructor argument and the library link were read back from the chain. The relay on nan serves `/v1/sessions` with `SESSIONS_FACTORY` set; the address book's `sessionVaultFactory` entry is not set yet (a governance transaction). The site's `/sessions` and `/grant` pages and CLI release cli-v1.3.0 are live. `scripts/sessions-prod-smoke.mjs` passed 15/15 against `api.enclave.host`. The attestation route (phase g) is off, since `SESSIONS_KEY_ATTESTATIONS` is unset.

## 16. Delegated access to wallet-held deployments (ledger rev 15d, vault v2)

Live on Base since 2026-10-07. A session can now act on the deployments the owner's **wallet** holds, without moving them into the vault. The owner grants this once, per vault, with one wallet transaction to the ledger, and can take it back the same way. This supersedes D2's "sessions can top wallet-owned deployments up but not control them" and replaces the move-in flow (§2.2, §9.2) as the way to manage existing deployments from a session.

### 16.1 Ledger: owner-approved delegates

`deploy/ledger/EnclaveDeployments.sol` is the live rev 15 source (byte-identical to `0xb36D…4830` apart from metadata) plus one feature:

```
event DelegateSet(address indexed owner, address indexed delegate, bool allowed);
function setDelegate(address delegate, bool allowed) external;   // msg.sender is the owner
```

- `isDelegate[owner][delegate]` lets `delegate` pass `_requireOwned` on **every** deployment `owner` holds: `setAppRef`, `setConfig`, `setShares`, `setMaxRate`, `setActive`, and `refund` (which still pays `d.owner`).
- It never covers `transferDeployment`: that checks `d.owner == msg.sender` itself. A delegate can't move a record.
- The owner grants and revokes alone. The ledger stores a bool, with no expiry and no per-record scope; the policy lives in the vault.
- **Reading a grant.** The mapping is private (EIP-170: 24,554 bytes with it, 22 to spare), so there is no getter. Read the storage word `keccak256(abi.encode(delegate, keccak256(abi.encode(owner, 23))))` (slot 23, recorded in `ledger-15d-base.json` as `isDelegateSlot`), or index `DelegateSet`.
- **Detecting support.** `deploymentsSchema()` still answers 15. Clients detect rev 15d from the runtime code: it contains `0x63 ‖ selector("setDelegate(address,bool)")` (the selector pushed as PUSH4). `relay/sessions.mjs` and `sdk/sessions/src/delegate.ts` both do this, and never read slot 23 on a ledger without it, where it holds something else.
- Main's `contracts/EnclaveDeployments.sol` (rev 16, undeployed) has no delegates. It must gain them before it is ever deployed, or every grant is lost at that migration.

### 16.2 Vault v2: wallet-held records are production

The core change from v1 is in `_requireHeldEnv`: a record with no custody record in this vault, whose `d.owner` is the vault's owner, is treated as held in environment **`prod`**. The rest follows from the existing rules, plus extra checks on funding (below).

| Session action | On a wallet-held record |
|---|---|
| `deploy.setActive` | Suspend and resume. Needs the ledger grant. |
| `deploy.setShares` | Resize. Needs the grant. Under an attached lease it may not raise the runner rate (§15). |
| `deploy.setMaxRate` | Lower or keep the cap only (`r ≤ capOf`, the `prod` rule), never under twice the fee, within the grant's `maxRatePerHour`. Refused while a lapsed lease is attached. Needs the grant. |
| `deploy.refund` | Cancel. The ledger pays `d.owner`, the wallet, never the vault or the session. Needs the grant. |
| `deploy.fund` | `fundFor(id, amount, payer = wallet)`: the refundable escrow is credited to the wallet. The record's cap must fit the grant's `maxRatePerHour`, and the funding-rate rules of §15 apply. A **paid** record (publisher fee > 0) also needs its app named in the grant as `0x<appId>` (`"*"` never covers it, and a bare slug names the vault's own app), a genuine fee (the catalog's `versionFee` for that version, paid to that app's publisher), and `fee × 3600 ≤ maxAppFeePerHour`. `fundFor` is open, so funding needs the ledger grant only when `prepareFund` must re-base an unleased record (that is a `setMaxRate`). |
| `deploy.setAppRef`, `deploy.setConfig` | Never: `WrongEnvironment(id, 2)`. What a wallet-held deployment runs changes only by a wallet transaction. |
| transfer | Never. The vault has no session path to `transferDeployment`, and the ledger refuses a delegate anyway. |

- **Only grants that cover `prod` reach wallet-held records.** A staging-only grant (the `staging-publish` agent preset) gets `EnvNotAllowed(2)`.
- **`apps` does not narrow control.** As for vault-held records, the grant's app list is checked on `create`, `setAppRef`, `publish` and (new) funding a paid wallet-held record. It is not checked on `setActive`, `setShares`, `setMaxRate` or `refund`. A `prod` session holding `deploy.setActive` can therefore suspend any app the wallet holds.
- **Why a paid record must be named.** Anyone can `create` a record with any fee and recipient and `transferDeployment` it into the wallet; the ledger snapshots whatever `create` was handed. Funding such a gift from a session would send budget to a stranger. Requiring the genuine catalog fee, a named app and the fee ceiling is exactly what `create` already asks of a new record.
- **Without the grant** the ledger answers `"!owner"`, which the SDK maps to error code `delegation`. The CLI and the site then say what the owner has to do.
- **Unchanged.** Vault-held records keep their custody rules (§2.3, §7). A record moved *into* the vault is unadopted and stays inert even with the delegation in place: `held[id]` is checked first. Secret release is untouched: a wallet-held record has no `held()` entry and passes the custody gate like any wallet record, and since no session can change what it runs, the wallet alone decides which code its secrets go to.

### 16.3 Granting, checking and revoking

The delegate is the owner's vault at the **v2** factory, `factory.vaultFor(owner)`. It is a CREATE2 address, so the grant can precede the vault's deployment.

| Where | Grant | Status | Revoke |
|---|---|---|---|
| Site | enclave.host → **Sessions** → "Apps your wallet owns" → **Grant**. The deployments panel also offers it once when a change to a wallet-held row could go through the session; a decline is remembered per browser. | the card's pill: granted / not granted / not supported by this ledger | **Revoke** on the same card |
| CLI | `enclave session delegate` (the wallet key, `--signer`, or `--unsigned --from 0x…`) | `enclave session delegate --status [--owner 0x…]` (no key needed) | `enclave session delegate --revoke` |
| MCP | `build_delegate {owner, grant}` returns the unsigned wallet transaction (`grant` defaults to true) | `session_status {owner}` → `delegation` | `build_delegate` with `grant: false` |
| Relay | — (a wallet transaction, never relayed) | `GET /v1/sessions/owner/<address>` → `delegation: {ledger, supported, granted}` | — |
| Contract | `ledger.setDelegate(vault, true)` | storage read (§16.1) or `DelegateSet` | `ledger.setDelegate(vault, false)` |

- Grant and revoke are wallet **transactions** to the ledger (ETH gas), not typed-data signatures. The relay can't submit them, which is deliberate: no relayed signature can widen a vault's reach.
- **Revoking** cuts every session of that vault off the wallet's apps in one transaction. The sessions themselves stay live, with their budgets and any vault-held records.
- **`RevokeAll`** on the vault ends every session but leaves the ledger grant in place, so the next session the owner opens with `prod` reaches the wallet's apps again. To cut everything, do both.
- Ending a session, by sign-out, expiry, `Terminate` or `RevokeAll`, never touches running instances: it changes what the next session operation may do, not what is deployed.

### 16.4 The migration on 2026-10-07

- **Ledger.** Rev 15d deployed at `0x606C7910acDeC5DE534FD6d16Bf71AEb0C43eAe9` with the live constructor arguments. Every live owner parameter was copied, and a fresh `EnclaveProofOfTime` (`0x3301605ac208e6d8A9711E5B3835f91Ca4Fdd946`) and `EnclaveVerificationFees` (`0x7898E8D219aA235E3b9d9132c7BE9E7BA7f12417`) were bound to it. All 70 records were imported through the admin console's migration engine and verified field by field, then imports were sealed.
- **Cutover.** Governance retired `0xb36DCE7689834D59364ca37Ade1896D0E6404830` at 08:38Z, accepted ownership of the new ledger and prover at 08:39Z, and repointed the book (`setMany(deployments, proofOfTime, verificationFees)`) at 08:40:16Z. Record: `contracts/deployments/ledger-15d-base.json`. Tooling: `scripts/migrate-ledger-delegates.mjs prepare|cutover|status`, rehearsed end to end on a Base fork by `scripts/ledger-cutover-rehearsal.mjs`.
- **Vaults followed by themselves.** Vaults resolve the ledger through the book on every session call, so v1 and v2 vaults moved with the book, with no redeploy. Records were imported with their ids, so every `held[id]` stayed valid (the F7 limitation of §15 did not arise).
- **Vault v2.** Factory `0x1F5c887c0cDF491b16AB6c449abAfDF9B2ec9C9C` (block 52286277), library `0x5510aE9fED97577d75C69545384af7d8bAD05027` (block 52286274), with the same constructor arguments as v1 (USDC, book, PaymentRouter, key attestations, $250 cap). The relay's `SESSIONS_FACTORY` points at it, so `/config`, `/open` and `/owner/<address>` use v2 vault addresses. v1 stays listed in `SESSIONS_FACTORIES` so the custody gate keeps reading its records. The book's `sessionVaultFactory` key is still unset (a governance transaction).
- **v1 vaults are retired for new sessions.** Factory `0x00bB59c40768aA56E292b4E789f9f3B5826E3a8d` opens nothing new. A v1 vault keeps working for its owner on-chain (owner paths never read the book), but its sessions never reach wallet-held records, and the owner's v2 vault is a different address, so a delegation granted to one does nothing for the other. To bring a v1 vault's record under v2 sessions, `Release(id, owner)` it to the wallet (`refund` first if it holds refundable escrow); v2 sessions then reach it as `prod` through the delegation. A release straight into the v2 vault reverts `BadTarget` until the book names the v2 factory.

### 16.5 What it changes in the threat model (§11)

- **Leaked key of a `prod` session, with the delegation granted.** Within the session's actions it can suspend, downsize, cancel and lower the cap of any app the wallet holds, and spend its budget funding them (paid apps only if named). That is a denial-of-service lever on production. A lowered cap may also leave a deployment unserved if no host will run it at that price. It still can't change what any production deployment runs, move a record, read or set secrets, or send money anywhere but the owner's deployments and the catalog-bound publisher fee. Refunds go to the wallet.
- **Mitigations.** Give `prod` only to sessions that need it, with only the actions they need, a small budget and a short expiry. The grant page and the CLI warn on `prod`. One wallet transaction (Revoke) cuts every session off the wallet's apps; `Terminate` or `RevokeAll` ends the sessions themselves. Every operation is listed on `/sessions` with its transaction.
- **Agents on `staging-publish` are unaffected.** It has no `prod`, so the delegation never reaches it. That is the CLI's agent preset. The MCP server's `session_request` defaults to a preset it calls `agent`: the browser policy without `api.account` and `api.appAccess` (every deployment action, `*` apps, staging and prod; a leaked agent key can't sign in as the owner or open their private apps) with a $20 budget for 7 days, which the delegation does reach.
- **Several sessions, one grant.** The delegation is per vault, not per session, so it covers every present and future session of that vault that holds `prod`. A session's own grant is what narrows it.
