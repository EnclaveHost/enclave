# Browser independent mode, parity round 2: result

**Snapshot.**
- Worktree `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`, branch `decentralize/nan-retirement`, base `78acfcc6`.
- Nothing was committed or pushed.

**Constraints followed.**
- No SSH, private configuration, production change or chain write. The only network access was read-only `eth_*`
  calls to public Base RPCs: publicnode, base.org and drpc.
- No subagents, new windows or Wine. Builds ran one job at a time.
- Mutation testing ran only in an isolated copy (`/tmp/indtest/mut`), which has been removed.
- The previous round's pending browser changes are kept intact and extended.
- I did not edit CLI, `management-*`, directory, naming/routing, custody, isolation, Windows or contract files, nor the
  authority-profile files.

## 1. Session owner operations without a relayer

**SessionVault semantics checked.** The deployed pinned vault implementation `0x87bc…` is byte-identical to
`contracts/SessionVault.sol` at HEAD: source SHA-256 `a447add6…` equals the reviewed profile's
`independent-authorities` build. In `_ownerAuth`:
- `msg.sender == owner` is authorized in the executing block, and nonce and expiry are ignored;
- otherwise the call is checked in order:
  1. `block.timestamp > signBefore` → `Expired`;
  2. a reused `opNonce` → `NonceUsed`;
  3. the EIP-712 digest is checked against the vault's own domain (name, version, `block.chainid`, the vault address).
     The signature must be an ECDSA signature from the owner (low-s, v 27/28) or pass ERC-1271 → otherwise
     `BadSignature`.

`topUpWithAuthorization` calls USDC `receiveWithAuthorization(owner, vault, …, nonce = TopUp digest)`. It therefore
pulls only from the vault's current owner, and only for that exact `(sessionId, amount, opNonce, validBefore)`.

**SDK (`sdk/sessions/src/client.ts`; `dist` and `site/vendor/sessions.js` regenerated).**
- **`prepareOwnerOperation({publicClient, chainId, vault, op, mode: "direct"|"signed", owner?, expectOwner?, validSeconds?})`**
  - Encodes `topUp`, `extend`, `terminate`, `revokeAll`, `withdraw`, `promote`, `adopt`, `setEnvironment` and `release`
    in exactly the relay's argument order.
  - It requires the RPC's chain ID to equal the requested chain, then reads `vault.owner()`. A known wrong wallet fails
    before anything is signed.
  - `signBefore` is chain time plus 1–3600 s, and `opNonce` is fresh randomness.
  - In signed mode the owner signs the vault's typed operation. In direct mode no signature is made.
- **`prepareTopUpFromWallet(…)`**: the owner's EIP-3009 authorization bound to the TopUp digest, encoded as
  `topUpWithAuthorization`.
- Both return portable `{chainId, to, data, value}`. Any gas payer may submit; the vault decides.

**Browser (`site/js/core/sessions.js`, `site/js/core/independent-ui.js`, `site/js/pages/dashboard.js`).**
- **Owner operations.** In independent mode `ownerOp(op)` prepares the operation in direct mode, against the vault
  derived for the wallet at an agreed block. The connected wallet sends it.
- **Budget top-up.** `topUpSession` uses `prepareTopUpFromWallet`. The USDC domain is read at an agreed block.
- **Production records the vault holds.**
  - `ledgerSend` reads the vault's `held(id)` and the record at an agreed block.
  - A version or config change on a production record becomes the owner's `promote`. The label comes from the catalog,
    and the vault refuses a wrong one with `LabelMismatch`.
  - An unadopted record is refused with the hosted mode's message.
- **Dashboard session panel.** Start, **Add budget**, **Extend**, **End session** and **End all sessions**
  (`revokeAll`). Modal wording says the wallet sends a transaction.
- **Hosted mode is unchanged.** The relayer's `ownerOperation` and `topUpFromWallet` paths are untouched; the hosted
  e2e passes.

## 2. ETH funding, host choice, native-client instructions

**ETH funding.** The deployed ledger is rev 16d (commit `4b7419bb`, blob `3f3d2c3a`). I read it from
`profile-source-verification/origin-history.git`. Its `fundEth` calls `EnclaveLedgerBandwidth.ethCredit`, which:
- requires a nonzero feed;
- requires `answer > 0`;
- requires `block.timestamp - updatedAt <= 2 h`;
- requires `answeredInRound >= roundId`;
- credits `value * answer / 1e20` (that is, an 8-decimal answer).

`ethFundingQuote()` (`site/js/core/independent-chain.js`) reads, at one agreed block:
- the ledger's `ethUsdFeed()`;
- the feed's `decimals()`;
- the feed's `latestRoundData()`.

It refuses:
- a zero feed;
- a feed other than the profile's reviewed `ethUsdFeed`;
- decimals ≠ 8;
- a non-positive answer;
- an unfinished round;
- an answer older than 2 h − 10 min;
- a feed or ledger whose deployed code lacks those methods.

`fundingTerms()` (`fund.js`) passes the price into the existing `usdToWei` rounding (9 decimals). On refusal,
`payForRuntime` names the reason, and no value is sent.

**Host choice (deploy dialog, independent mode).**
- Lists registered hosts that sent a heartbeat within the last hour, with their posted prices, from the registry at an
  agreed block.
- Choosing one writes the existing strict placement pin `placement: {hostId}` (the format `supervisor.js`
  `placementRefusal` reads) and sets the ceiling to **that host's** price.
- The UI states that posted prices and heartbeats are chain facts, free capacity is not, and only hosts that follow
  placement pins honor the pin.
- The hosted service's preferred-host-with-fallback (an API store) is not reproduced.

**Connect tab (`site/js/core/native-instructions.js`).**
- A starting native-client trust profile built only from the network profile's pins: deployment, registry and session
  factory pins, HTTPS RPCs, directories, and startup gateways from the storage plan.
- The decisions it leaves to the user are listed explicitly: checker keys, SNP firmware floor, reviewed release,
  `stateDir`, connectivity.
- Shows the exact `native-profile.mjs` and `native-get.mjs` commands. Nothing comes from a host, and nothing is
  presented as verified.

## 3. Origins and the profile converter

**`wallet.js` (independent mode).**
- **Wallet-failure reads:** balance reads the wallet cannot answer use only the profile's RPC pool, never
  `mainnet.base.org`.
- **Adding the chain:** `wallet_addEthereumChain` offers only the profile's HTTPS RPCs.
- **WalletConnect is off.** Its transport is Reown's relay, a third party. `WALLETCONNECT_PROJECT_ID` is "" in
  independent mode.
- **Other files:** the deployments component no longer fetches the GitHub mobile index in independent mode.
- **Result:** after activation, the browser test asserts that no request leaves the local rig. A source scan finds
  remaining literal origins only in links, hidden features, hosted-only paths, and `verify.js`'s `API_ORIGIN`. That last
  one is reached only from the Verify tab, which is hidden in independent mode.

**`scripts/network/browser-profile.mjs`.**
- **Inputs:**
  - the reviewed `enclave.authority-profile`;
  - `--expect-digest` and `--expect-pins`, both obtained out of band;
  - explicit HTTPS `--rpc`, and optional `--storage-plan` and `--directory`.
- **Checks:** uses `network/authority-profile.mjs` `parseProfile`: exact digest and canonical encoding. Requires all
  eight contract pins to equal the expected pin document. Nothing is discovered from the book or from observations.
- **Output:**
  - `usdc` and `ethUsdFeed` come from the reviewed file, and `source` records its digest and review block;
  - the result is validated with the dashboard's own validator;
  - it refuses to overwrite and prints the SHA-256 fingerprint;
  - `--verify-chain` optionally runs `verifyProfileOnChain`.
- **On the current reviewed profile:** with `--expect-digest sha256:ee957827…4cb8` and
  `contracts/deployments/contract-pins-base.json` it produces a browser profile with fingerprint
  `sha256:af7e827e…d54b` (three public RPCs, no storage or directories).

**Stronger fingerprint confirmation.**
- **Import:** **Use** stays disabled until the full publisher fingerprint is entered and matches; a mismatch is shown
  in red.
- **New tab:** confirming a saved profile requires typing at least the first 16 hex characters of the publisher's
  fingerprint.
- **Profile format:** gains optional `ethUsdFeed` and `source`.

## 4. Deployed-code evidence

Read-only checks against the live Base runtimes at blocks 52,832,137–52,832,384 (`claude-browser-parity-live-reads.log`):

| Check | Result |
| --- | --- |
| Registry | **Schema 4**, 11 registered, 10 active. Rows decode with schema-4 fields only, no `caps`. Only 2 hosts sent a heartbeat within the hour; the cheapest posted CPU price is **2 µUSDC/s** for a whole node. |
| Ledger | Rev 16. `count`/`getPage`/`get` decode. The reviewed owner holds 15 records. |
| ETH quote | Uses the reviewed feed `0x71041ddd…` (8 decimals, an answer about 396–1136 s old), with a plausible price. |
| Other reads | USDC domain "USD Coin"/"2"; `vaultFor` on the pinned factory works. |
| Ledger selectors | Every one the dashboard sends is present in the deployed ledger: create, fund, fundWithAuthorization, fundEth, get, setActive, setAppRef, maxGpuMilli, feeOf, setShares, setConfig, setMaxRate, capOf, refund, refundableOf, ownerEscrow6, earnOf, transferDeployment, multicall, deploymentsSchema. The pre-rev-8 create shapes are absent, as they should be. |
| Other selectors | All present in the catalog (13), the factory (`vaultFor`, `openFor`, `openWithDepositFor`) and the vault implementation (all owner operations, `held`, `execute`, `terminateBySession`). |
| Precise refusal | `registerRelay` and `setCaps` are refused: "the pinned registry does not implement registerRelay(string,string,uint64), setCaps…". |

**Unsupported-method refusal in the dashboard.** Before relying on a method it checks the agreed runtime for that
method's PUSHn selector (handling leading zero bytes), and caches the result per address:
- listing: ledger `count`/`getPage`;
- hosts: registry `registrySchema`/`count`/`getPage`;
- ETH: ledger `ethUsdFeed`/`fundEth`, feed `latestRoundData`/`decimals`.

**Correction to my earlier audit.** It called `registerRelay` and the capability bits permissionless, describing
HEAD source. The deployed registry `0x868e…` has neither.

## Tests (logs in `work/`)

**`claude-browser-parity-tests.log`: 66/66 pass.**
- **`site-independent-profile`**, **`site-independent-quorum`**, **`site-independent-storage`** (includes the
  owner-names compatibility check), **`site-independent-network`**, **`site-independent-bundle`**: the earlier unit
  tests, rerun.
- **`browser-profile`** (new, 6):
  - conversion from the real reviewed profile, accepted by the dashboard validator;
  - refusals for a wrong or missing digest, non-canonical bytes, a swapped pin, too few RPCs, HTTP RPCs or directories,
    and a bad storage plan;
  - the CLI refuses to overwrite and prints the fingerprint;
  - ETH quote refusals for each unsafe feed state;
  - the PUSH3 selector check.
- **`sessions-owner-ops`** (new, 4; anvil, the real `PinnedSessionVaultFactory` over the schema-16 ledger and catalog):
  - **Wallet top-up:** applied once, replay refused, and a stranger's authorization refused before signing and on
    chain.
  - **Signed operations:** a valid extend from a third-party payer; replay → `NonceUsed`; a forged signer →
    `BadSignature`; a late submission → `Expired`; a tampered session ID → `BadSignature`.
  - **Direct operations:** another account submitting the owner's calldata → `BadSignature`; the owner may repeat;
    wrong expected owner and wrong chain refused.
  - **Promote:** wrong label → `LabelMismatch`; signed promote sets production; a session can no longer change the
    production version; `revokeAll` ends the session; a later signed terminate → `NotLive`.
- **`sessions`** (existing hosted/relay-free session suite, 14): unchanged and passing.
- **`site-independent-browser`** (Chromium plus anvil rig, 13). Every `*.enclave.host` request and upload-token call is
  refused. Coverage:
  - the earlier 9 steps, now with fingerprint-gated import and confirmation;
  - **Owner operations from the dashboard UI:** start with a $2 budget, **Add budget** brings it to $3, **Extend**,
    a session-created record moved to production, a version change through `ledgerSend` becoming the owner's Promote
    (the vault records the promotion), and **End all sessions** (`revokeAll`) leaving the session not live;
  - **ETH funding:** the credit equals `416667 gwei × 2400e8 / 1e20`; a stale feed refuses with the reason and the
    record stays unfunded;
  - **Host choice:** the registry lists the second host at its posted price; the pinned record carries
    `placement.hostId = keccak(endpoint)` and a ceiling of 300, which is that host's price and not the cheapest;
  - **Connect:** the starter profile carries the pins, with checkers left to the user.

  After activation the browser contacted only local origins.
- **`models-read-only`**: 5, passing.

**`claude-browser-parity-regression.log`: 343/343 pass.** Covers the 28 existing site test files that touch changed
modules, plus `authority-profile`, `mcp-sessions` and `cli-session`, which consume the SDK.

**`claude-browser-parity-e2e-hosted.log`: 10/10 pass.** The hosted Playwright suite: passkey, SIWE session, device
flow, credit vault, orders, relayed sessions and top-up, and catalog.

**`claude-browser-parity-live-reads.log`: 6/6 pass.** Read-only, against the deployed runtimes on Base.

**Mutation tests (isolated copy): 17/17 mutants killed.**
- **Feed checks:** decimals, unfinished round, reviewed feed, staleness.
- **Quorum:** call agreement, block floor.
- **Profile:** book rebinding, the per-tab confirmation bypass.
- **Storage:** readback byte comparison, the answer's CID check.
- **Converter:** pin comparison.
- **Activation:** removal of legacy config.
- **SDK:** the expected-owner precheck, the top-up commitment, the `signBefore` window, the signed `opNonce` binding.

## Remaining gaps (not hidden; parity is not complete)

1. **Custom names** are read back and preserved in committed startup settings but cannot be edited in the browser
   yet. That needs the naming worker's final schema and routes.
2. **Management** (logs, restart, live status, in-browser Verify) is not implemented. That waits for the management
   worker's final authorization routes.
3. **Preferred host with fallback** (the hosted placement API) has no ledger equivalent. Only the strict on-chain pin is
   offered.
4. **Actual free capacity is not chain-visible.** The dialog shows posted prices and heartbeats only.
5. **Other hosted-only features:** card and credit payments, passkey accounts, relay-held secrets (custody v2 is
   another workstream), BYO WireGuard, paid-provider authorization (the pin document has no `connectivity` key),
   phone downloads, and WalletConnect.
6. **Sessions.**
   - **Gas:** each owner and session action costs the wallet gas.
   - **No owner-signed path in the UI yet:** that form (for a third-party payer) exists in the SDK but is not used by
     the UI.
   - **Contract-wallet owners:** owners whose wallet carries code rely on `msg.sender == owner` from that wallet; this is
     not tested with a Safe.
   - **No `/sessions` page support:** `site/js/pages/sessions.js` was not in my files and still uses the relay index.
     In independent mode the dashboard session panel is the supported surface.
7. **The browser rig's ledger is HEAD's schema-16 source, not deployed rev 16d.**
   - **What covers deployed rev 16d:** write paths are covered by selector presence and the reviewed fundEth/ethCredit
     source; live writes were not exercised.
   - **Not done:** compiling 16d for the rig, or a mainnet fork run.
8. **RPC agreement is not a light client.** Today the cheapest live posted price comes from whichever host posts it
   (2 µUSDC/s observed). The user's ceiling then follows that host, and the default ceiling can be very low.
9. **Not activated or published:** no browser profile is published, and no operator storage adapters or HTTPS
   directories exist for it. No independent operators are involved.

## Next safe tasks

1. **Custom names UI** on the Startup tab, once the naming schema is final (the browser's `validateNames` mirror is
   already in place).
2. **Management panel**, behind the same gate, once its routes are final.
3. **`/sessions` page support for independent mode.** That file must be reassigned to me.
4. **A rig variant on the deployed rev-16d ledger source**, compiled single-job from the origin history, run as an
   opt-in test.
5. **An optional "third-party payer" mode** that exports owner-signed calldata.
