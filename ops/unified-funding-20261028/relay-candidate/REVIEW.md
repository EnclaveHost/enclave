# relay-r1 — successor funding relay integration (UNREVIEWED SOURCE)

Status: **source only**. I (the authoring agent) executed nothing in this stage: I ran no tests, no `prepare.py`, no
node, no forge, no RPC. I claim no test results, no deployment, and no production readiness. The Base fork run is
still in progress elsewhere, and nothing here relies on it.

## Files

| file | role |
|---|---|
| `funding-route.mjs` | `createFundingRoute(...)`: `/funding/config`, `/funding/quote`, `/funding/execute`, `/funding/open` |
| `prepare.py` | checks the exact source hash; generates `generated/funding-abi.mjs` from the compiled artifacts; writes the PATCHED COPY `patched/relay/sessions.mjs` plus drop-in copies `patched/relay/funding-route.mjs` and `patched/relay/funding-abi.mjs`; writes `generated/PREPARE-MANIFEST.json` |
| `test/fake-chain.mjs` | OFFLINE harness: a real viem public client over a **mocked JSON-RPC transport** |
| `test/funding-route.test.mjs` | offline route tests |
| `test/prepare.test.mjs` | static insert-only proof of the patched copy |

Root run order:

```
python3 prepare.py            # writes only inside relay-r1/
python3 prepare.py --check    # must say "all outputs current"
node --test test/
```

`prepare.py` refuses to run (exit 1) in any of these cases:
- `source/relay/sessions.mjs` does not hash to `457e8647…d0682d`;
- the vault, factory or library artifacts were not built with `runs 1 / viaIR / osaka / bytecodeHash none`;
- the artifact Grant tuple lacks `maxGasUsdcPerOp`, `maxUsdcPerEth6` or `maxEthPerOp`;
- any patch anchor does not occur exactly once;
- an output path resolves outside the stage.

It never opens source for writing.

## What the host patch does (patched copy only; source untouched)

There are five marked, insert-only blocks (`// >>> funding-r1` … `// <<< funding-r1`). Deleting them reproduces the
pinned original byte for byte, and `test/prepare.test.mjs` asserts this.

1. A header comment.
2. `import { createFundingRoute, fundingManifestFromEnv } from "./funding-route.mjs"`.
3. Inside `createSessionsService`: `createFundingRoute({ manifest: o.funding, quotePolicy: o.fundingQuotePolicy, ownerManagement: false, pc, relayer: account.address, store, log, now, simulateAndSend })`.
4. At the top of `route()`: paths `/funding` and `/funding/*` go to the funding route. No original path starts with `/funding`.
5. In `initSessions`: `funding: fundingManifestFromEnv(process.env)` (`SESSIONS_FUNDING_MANIFEST` = path of a JSON manifest).

What the patch does not touch:
- every original route: `/config`, `/attest`, `/quote`, `/execute`, `/open`, `/owner` (topUp, extend, terminate, revokeAll, withdraw, promote, adopt, setEnvironment, release), `/end`, `/by-key`, `/owner/:addr`, `/session/...`;
- the original factory, the book's `sessionVaultFactory`, the index, the keeper, `TxQueue`, `verifyApiRequest` and `createCustodyGate`.

The patch adds no wallet client, key, `TxQueue`, nonce manager or signer. Every write goes through the host's
existing `simulateAndSend`, which simulates, uses the existing journaled queue and waits for the receipt.

## Guards implemented in `funding-route.mjs`

**Disabled by default.** The route answers 503 `funding_disabled` and makes no chain reads unless all of the following are present:
- a manifest that passes `parseFundingManifest`;
- a host quote policy `{ fee, accept }`;
- `simulateAndSend`, `pc`, the relayer address and the store.

The patched host passes **no** quote policy. So even with `SESSIONS_FUNDING_MANIFEST` set, the funding surface stays disabled until reviewed host code supplies one. No request body field enables anything, and unknown manifest fields such as `ownerManagement` or `enabled` are refused.

**Manifest.**
- `schema: "enclave-funding-activation-r1"` and `chainId: 8453` exactly.
- `notAfter` (a stale manifest is refused) and `maxBlockAgeSec` (a stale node is refused).
- Explicit address **and** exact runtime keccak256 for each of: `factory`, `implementation`, `fundingGasLib`, `fundingSessionVaultLib`, `adapter`, `legacyFactory`, `legacyImplementation`, `usdc`, `weth`, `book`, `ledger`, `reserve`, `swapRouter`, `dexFactory`, `quoter`.
- Per-tier pool address + code hash, and `feeTiers` drawn from 100/500/3000/10000.
- `maxSlippageBps` ≤ 500 (integer) and `deadlineSec` between 30 and 900.
- All identities pairwise distinct. A zero or empty-code hash is refused.
- No address or hash is defaulted or invented. The tests use synthetic addresses only.

**Pins.** Every request that does more than parse reads one latest block, then checks everything at that block number before any simulation or submission:
- `eth_chainId` = 8453.
- For every pin: code is present and its code hash matches.
- Both library addresses are embedded in the implementation runtime.
- `factory.implementation()`.
- `implementation.{factory, usdc, book, gasAdapter, legacyFactory}()`.
- `book.addr("deployments")` = ledger.
- `adapter.{usdc, weth, swapRouter, factory, ledger, reserve}()`.
- `reserve.ledger()`.
- `legacyFactory.implementation()`.
- `adapter.poolFor(tier)`.
- `quoter.{factory, WETH9}()`.
- `adapter.maxEthOut()`.

**Vault identity.** A vault must pass four checks:
- `factory.isVault(vault)`;
- `predictVault(factory, implementation, vault.owner()) == vault`, an offline CREATE2 check that is cross-checked against the client-r1 codec in the tests;
- `factory.vaultFor(owner) == vault`;
- its code is exactly the EIP-1167 runtime for the pinned implementation.

`owner()` alone is never trusted.

**Quote.**
- Uses the real QuoterV2 `quoteExactOutputSingle(USDC→WETH, exact ethOut, pinned tier)` as an `eth_call` at the pinned block.
- `maxUsdcIn6 = ceil(amountIn × (1 + slippage))`, capped by the grant's `maxGasUsdcPerOp` and its price cap (`maxUsdcPerEth6 × ethOut / 1e18`). The quote is refused if the cap falls below `amountIn`.
- The fee comes from the host `quotePolicy.fee` and must be ≤ the session's `maxFee6`.
- `maxUsdcIn6 + fee` must fit the session balance and the period limit (period reset is computed at the block timestamp).
- A missing quote, a zero quote or a missing policy means no price. Nothing is faked.
- The record holder must be one of:
  - the vault;
  - the owner's wallet;
  - the owner's **original** vault, proven via `legacyFactory.isVault` + `vaultFor(owner)` + `owner()`.

  Records stay where they are.

**Execute.**
- `action` must be exactly 10; 9 and every other action are refused.
- The 224-byte canonical intent is decoded strictly, and `intent.payer` must equal the vault.
- The fee tier must be pinned, and the call deadline must be ≤ the intent deadline.
- The host's shared off-chain revocation `store.data.revoked[sid]` is checked **before any chain read**, then again after simulation.
- Then pins, vault identity, adapter `maxEthOut`, deadline vs block time, a fresh quote ≤ signed maximum, and `quotePolicy.accept` (it must return exactly `true`).
- The real vault `execute` is simulated at the pinned block with the relayer as `from`. A revert means 409 `revert` (with `errorName`) and nothing is sent.
- After that, `simulateAndSend` is called **once** with exactly `{to: vault, abi, functionName: "execute", args: [sid, nonce, 10, args, fee, deadline, x, y, r, s], label}`.

**Settlement.** The receipt must have `status === "success"`. Its logs must contain exactly one of each of:
- `SessionOp` (this sid and nonce, action 10, `argsHash`);
- vault `GasFunded`;
- adapter `GasFunded`.

They must agree on deployment, holder, ethOut, maximum and the actual amount. `GasFunded.relayer` must be this relayer. Following the root correction, `SessionOp.amount6` must equal the **actual** amount (`usdcSpent6`). `result` must decode to `(used, refund)` with `used + refund = maximum`.

The return value reports `maximum` and `actual` separately. The index (`store.data.fundingOps`, a separate namespace) stores `amount6` = actual and `maxUsdcIn6` separately. The action-10 fee goes directly to the relayer (`msg.sender`) inside the vault. The original actions' fees still go to the treasury via `PaymentRouter`, and that path is unchanged.

**Open.** `/funding/open` answers 503 `funding_open_disabled` unless the host constructs the route with `ownerManagement: true`. The patched host hard-codes `false`, because no reviewed successor owner-management route exists in the relay (see Limitations 1).

When the host does enable it (tests only):
- the Grant must carry all 20 artifact fields, explicitly including the three gas limits. An original-shaped grant is refused (`grant_missing_gas_limits`); it is never filled in, widened or migrated;
- the predicted vault, `vaultFor`, existing code, `isVault` and `owner` are all checked;
- `openFor` or `openWithDepositFor` (with the owner signature and the USDC EIP-3009 authorization) is simulated by the real factory at the pinned block, then sent once;
- exactly one `SessionOpened` with the expected sid must appear.

The original vault is never read or written by open.

## Exact limitations

1. **No relayed successor owner controls.** The successor's owner controls are all present on chain: topUp, topUpWithAuthorization, extend, terminate, revokeAll, withdraw, promote, adopt, setEnvironment, release, close and ownerCall. The owner can use them directly, or anyone can submit a signed domain-v2 owner op. But this relay does **not** relay them. The original `/owner` route resolves vaults through the ORIGINAL factory, so it answers 404 for successor vaults: no misuse, but no service either. For this reason `/funding/open` stays disabled in the patched host, which is not rollout-ready.
2. **No funding activation in the patched host.** `initSessions` passes no `fundingQuotePolicy`, so the funding surface is disabled even with a manifest. Reviewed host code must supply `fee` and `accept`. This stage invents no oracle, margin or fairness rule.
3. **Off-chain revocation covers only what the host store records.** The host's `ingestLogs` ignores successor vaults (they are deliberately not added to `store.data.vaults`), so successor `SessionEnded`/`RevokedAll` are not folded into `store.data.revoked`. The original `/end` route also does not serve successor sessions. The contract simulation still refuses ended, expired or epoch-revoked sessions.
4. **Not supported here:**
   - `verifyApiRequest` / API scopes for successor sessions;
   - `/by-key`, `/owner/:addr` and `/session/...` views for successor sessions;
   - keeper `close` of expired successor sessions (anyone may call `close` on chain).
5. **Simulation timing.** The host `simulateAndSend` re-simulates at *latest*, not at the pinned block, and the queue estimates gas at latest. Pinned identities are code hashes, so they cannot drift (no selfdestruct post-Cancun); pool price, session state and nonce can. The contract remains the authority.
6. **Tests are OFFLINE.** The JSON-RPC transport is mocked. No EVM runs, and no P-256, EIP-712, ERC-1271 or EIP-3009 signature is verified; "BadSignature" is a scripted revert. Code blobs are synthetic, not real bytecode. Passing tests would prove the module's control flow against scripted answers, nothing about contract behaviour.
7. **The patched `sessions.mjs` is never executed.** It imports bare `viem` and `./snp-verify.mjs`, which resolve only inside `source/relay/`. `prepare.test.mjs` proves insert-only text and hunk content. The runtime wiring (hoisted `simulateAndSend`, `now`, `store`, `account`) has been checked by reading only. The source relay's own test suite has not been run against the patched copy.
8. **Hand-written ABIs.** The QuoterV2 ABI is hand-written from Uniswap's published `IQuoterV2`, not from an artifact. Book, reserve and legacy-factory/vault are also hand-written minimal ABIs. All of these need confirmation against the deployed Base contracts on a fork.
9. **Proxies.** USDC on Base is a proxy, so its code-hash pin covers the proxy only, not the implementation behind it.
10. **Library-linking check.** The check is "the address appears in the implementation runtime" plus the code-hash pins. It does not prove each call site.
11. **Fee tier 10000.** The adapter source serves only 100/500/3000. A manifest naming 10000 parses, then fails closed at `adapter.poolFor(10000)`.
12. **Settlement uses receipt logs only.** It does not re-read the session balance or the vault/relayer USDC deltas at the receipt block. The contract itself enforces exact deltas.
13. **Relayer USDC.** Action-10 fees accumulate as USDC in the relayer EOA. Accounting and sweeping are not handled.
14. **Rate limiting.** The host's per-owner `rateOwner` is not reachable from the module, which is a further reason `/funding/open` stays off. Execute relies on the host's IP rate limit in `handle()`.
15. **Manifest trust.** The manifest is a plain JSON file read once at init. It is unsigned; trust comes from file-system control and review.
16. **Original sessions untouched.** The module never releases, terminates or withdraws anything on original vaults, including the existing $30. The only original-vault reads are `legacyFactory.isVault`/`vaultFor` and `oldVault.owner()`, made when a quoted record is held there.

## Further work needed before any rollout claim

- Fork tests on a Base fork (anvil `--fork-url`) covering: real successor deployment, real QuoterV2 and pools, real USDC EIP-3009 open, real P-256 precompile signatures, the full execute→receipt→settlement path through the actual host `simulateAndSend`/`TxQueue`, plus failure cases (expired, bad nonce, wrong scope, legacy-vault record).
- Integrating the patched copy into a source tree branch, then running the full original relay test suite unchanged (old-route regression) plus these tests through the real `createSessionsService`.
- A reviewed successor owner-management route (domain v2 owner ops, off-chain revocation after simulation, the `rateOwner` rules incl. the terminate/revokeAll exemption). Only after that may host code set `ownerManagement: true`.
- Ingesting successor events into the host index (revocation, ops, views), plus keeper close and `verifyApiRequest` support, if API scopes are wanted.
- A reviewed host quote policy (fee floor/margin, accept rule).
- A reviewed activation manifest (addresses and runtime hashes read from the actual deployment, checked independently).
- Client/SDK/UI wiring (client-r1 codec for building grants and calls).
- An operator runbook for relayer USDC.
- New-grant UX: owners sign a fresh v2 grant; nothing is auto-migrated from original grants.
