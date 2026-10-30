# Wallet release UI r1: source only

Status: I wrote the source and tests but **did not run anything**: no tests, build, browser, RPC, relay, signature or transaction. Nothing has been deployed. Nothing here is evidence about live chain state, and no row is shown to qualify. Root owns final qualification, live conditions and any production migration.

## Changed files

| file | change |
|---|---|
| `enclave/site/js/pages/sessions.js` | Imports the view module. `heldCard` appends `releaseSlot(h)` after each held row's facts. `render` calls `startWalletRelease(...)` after `wire(...)`. `mount` disposes the previous release UI. Promote, withdraw, revoke-all, delegation grant/revoke, top-up, extend, terminate and log are unchanged. |
| `enclave/site/js/core/wallet-release-chain.js` (new) | Pins and exact ABIs. Builds one coherent fresh snapshot, evaluates the gate, guards the typed data, encodes and decodes release calldata, and verifies outcomes read-only. |
| `enclave/site/js/core/wallet-release-store.js` (new) | IndexedDB journal with atomic CAS, plus `MemoryJournal`, a mock with fault injection used only by tests. |
| `enclave/site/js/core/wallet-release-controller.js` (new) | Guarded signer and relay around the actual SDK `ownerOperation`, and read-only recovery. |
| `enclave/site/js/core/wallet-release-view.js` (new) | Pure `slotHtml(state)` renderer and per-row wiring with dispose. |
| `enclave/test/wallet-release/controller.test.mjs`, `chain-store.test.mjs`, `view.test.mjs`, `held-card.fixture.html` (new) | Authored tests and a browser fixture. None have been run. |

`core/sessions.js` is not changed. The page passes the existing `sdk()` module, `cfg`, `Enclave.provider` and `Enclave.address` into the view. The vendor bundles are untouched. Funding, prices, grants, session authority and the signing paths for other operations are untouched. The release does not go through the unguarded core `ownerOp`, which re-resolves the vault from the relay.

## Send seam (SDK-SEAMS.md)

`controller.release()` calls the **actual** `S.ownerOperation({ relay: guardedRelay, owner: guardedSigner, chainId: 8453, vault, op: { op: "release", deployment, to: wallet } })`. The steps are:

1. **Before the call:** check the provider with `eth_chainId` and `eth_accounts` only (never `eth_requestAccounts`). Do a fresh coherent snapshot, require full eligibility, and refuse if a non-cancelled journal record already exists.
2. **`guardedSigner.signTypedData(td)`:**
   - Validate the SDK-generated typed data exactly: domain `Enclave Sessions`/`1`/8453/vault with no salt, only the `Release` type with the exact fields, the exact message keys, `deployment == id`, `to == wallet`, a non-zero 32-byte nonce, and a deadline in (now, now+3600].
   - Re-check the provider, then `putIfAbsent` the intent. The intent holds the exact typed data, the SDK nonce and deadline, the identity, the full prestate and its hash, and the start block number and hash.
   - Only then call the real `ownerFromProvider(...).signTypedData`.
   - After the signature, check liveness (unmount/dispose, `accountsChanged`/`chainChanged`) and the provider again. If either fails, CAS to `cancelled` and nothing is sent. Otherwise CAS `intent→signed` with `sigHash = keccak(sig)`. The signature is held only in memory.
3. **`guardedRelay.request`:**
   - Accept only `POST /owner` with exactly `{owner, vault, op:"release", args:{deployment,to,opNonce,signBefore}, sig}`, matching the journaled message, the in-memory signature and `sigHash`.
   - Redo the full fresh revalidation: provider, snapshot, eligibility, the same prestate hash, at least 30 s left before the deadline, and an `eth_call` simulation of the exact signed `release` calldata. The simulation is a preflight only and is **not** atomic.
   - CAS `signed→dispatching`, which is the last durable boundary. Then make exactly one real `RelayClient.request`.
   - A thrown error or a missing txHash leads to `uncertain`. A valid txHash leads to `submitted`. Nothing retries anywhere.

## Pins actually enforced (from the inventory, re-read every check)

- **Chain:** 8453.
- **Factory** `0x1f5c…9c9c`: code hash `0xc9b6…4f6c`; `isVault(vault)` must be true and `vaultFor(wallet) == vault`.
- **Vault:** code hash `0x3028…2a30`; `factory()` is the pinned factory, `owner()` is the connected wallet, `book()` is `0xab21…0907`.
- **Book:** `addr("deployments")` must be ledger `0xb178…117b`.
- **Ledger:** code hash `0x71d5…6682` and `deploymentsSchema() == 16`.
- **Reserve** `0x12a3…3639`: code hash `0xcc00…a979` and `ledger()` is the pinned ledger.

Every read happens at one block. Its timestamp must be within 120 s of now, and its hash is re-checked at the end of the read; a reorg mid-read blocks. There is no fallback to relay data. Any other chain or vault is shown as unsupported.

## Gate (this first path)

The release is enabled only if all of these hold:

- The ledger owner is the verified vault.
- The app is not active.
- runner, operator and leaseUntil are all zero. An expired lease that is still attached is blocked, with its own message.
- The held record has env 1 or 2.
- `ownerEscrow6 == 0 || earn.escrow6 == 0`, which is the deployed OR gate.
- Both gas reserve records, `(id,vault)` and `(id,wallet)`, are entirely zero or false.
- The environment and content continuity check passes (next section).

A positive runtime balance on its own does not block. The authored test `cab8fb59` checks that only `staging` and `continuity` block that historical row. KVM `9a28642b` and DNS `59f1273d` evaluate as active, leased, escrow-blocked and old-reserve-blocked.

## Environment / content / session continuity: the concrete gap (root decision required)

The checks, in order:

- env 1 (staging) is blocked: once wallet-held, the row is PROD to sessions (`_requireHeldEnv` 1104-1109) and to hosts.
- env 2 with `promoted == 0` is blocked as unpromoted.
- `promoted != keccak(abi.encode(appRef, configCid))` is blocked as content drift.
- After those, the row still needs an entry in `ROOT_QUALIFIED_CONTINUITY` that exactly matches the fresh read (vault, wallet, appRef, configCid, promoted, delegation state). That list is **empty in source**.

Why the list is empty: no deployed interface the browser can read proves that host session API authorization and secret release for a wallet-held row keep the vault's promoted-content and environment restrictions. Those live off-chain, for example in `session-api-auth.mjs` and the relay's custodyRefusal.

The UI shows both the old and new effective authority, including whether the wallet's ledger delegation is granted. The delegation is read from ledger storage slot 23 at the same block. An existing delegation is shown explicitly as **not** proof.

**Consequence:** as shipped, every current row stays blocked, including the three staging rows and the unpromoted production row that root observed. Root has to either qualify specific rows and add pinned entries, or build a coordinated access-policy migration. This code never calls setDelegate, claimPolicy, revoke or any environment change.

## Durable journal and failure handling

- **Key and writes:** the key is `wr1:chainId:ledger:vault:deployment:owner`. Every write is one IndexedDB readwrite transaction that does get, compare and put. It counts only after `oncomplete` (requested with `durability:"strict"` where supported).
- **New operations:** a new operation uses put-if-absent. It may replace a record only when that record is `cancelled` at its exact revision.
- **Writers:** moves before dispatch (`intent→signed→dispatching`) require the creating tab's writer token. This gives one writer across tabs; a second tab gets `exists` before any prompt.
- **Record shape:** bounded to 16 KB with a fixed state machine. Identity fields are immutable, and a signature field is rejected outright.
- **Storage unavailable, quota or abort:**
  - before the intent: no signature;
  - before `signed`: the signature exists but is never sent, and the record is cancelled;
  - before `dispatching`: nothing is sent, and the record is cancelled;
  - after the POST: the record stays `dispatching`, which recovery treats as uncertain.
- **Pre-dispatch records left by a closed tab:** these become `cancelled` only once the **chain's** latest block timestamp is past the signed deadline, when the signature can no longer execute.
- **Uncertain records:** the release is never restarted automatically. A record that is `uncertain`, `dispatching` or `submitted` blocks a new release for that identity until recovery resolves it.

## Read-only recovery

- **Lookup:** use the persisted txHash. If it was lost, scan the vault's `Released(bytes32,address)` logs filtered by id, from the persisted start block for 2000 blocks in chunks of 500. Every candidate transaction's calldata is decoded canonically and must carry the **exact nonce**. Events alone are not enough. Two matches is a conflict. A used nonce with no matching transaction is a conflict. No match is `unresolved`; an expired deadline is explicitly not permission to sign again.
- **Transaction and receipt checks:**
  - the transaction targets the vault, and its calldata has the same id, destination, nonce, deadline and sigHash;
  - the receipt status is success;
  - the receipt's block hash equals the canonical hash at that height; otherwise the state is pending/reorg and goes back to `submitted`;
  - there is exactly one vault `Released(id, wallet)` and exactly one ledger `DeploymentTransferred(id, vault, wallet)`.
- **Poststate at the inclusion block:**
  - `ownerNonceUsed(nonce)` is set and `held(id)` is deleted;
  - the ledger row, ownerEscrow6, earn, cap, fee and both reserve records equal the journaled prestate, except that `owner` is now the wallet. Anything else is a `conflict`.
- **Labels:** `included` until the RPC's `finalized` block reaches the inclusion block, then `finalized`. Late results update only the exact key at the exact expected revision.

## Authored tests (NOT RUN) and root plan

What is mocked: in `controller.test.mjs` the RPC/chain, provider and relay are inert in-memory fakes, and the journal is `MemoryJournal` (a **mock, not IndexedDB**). `chain-store.test.mjs` is pure. `view.test.mjs` checks string markup plus the page source text, with no DOM.

**Coverage:**
- positive release with the ordering assertions put-intent < provider sign < cas:signed < cas:dispatching < relay POST < cas:submitted, followed by included and then finalized;
- refusals: staging, unpromoted, content drift, missing continuity, existing delegation insufficient, continuity drift;
- escrow: either side zero passes, both nonzero blocks; active, expired-but-attached lease, old reserve and new reserve all block;
- drift: 15 identity/code/chain/stale/reorg drifts; provider on the wrong chain or account;
- changes after signature (account switch, chain switch, unmount, state drift, simulation revert, env change): nothing sent and a durable cancel;
- double-click and two controllers sharing one journal;
- a journal fault at each boundary;
- relay accepted then timed out, then reload, then nonce lookup;
- relay rejected: stays unresolved;
- refusals of a wrong event, a failed receipt, a changed poststate, a foreign nonce, and a reorg;
- pre-dispatch resolution only after the deadline;
- view states, escaping, no address input, held-card wiring, other controls preserved;
- the typed-data guard, canonical calldata, and the `abi.encode(string,string)` commitment.

**Exact vendored SDK:** the last controller test is skipped unless `WALLET_RELEASE_SDK_FIXTURE=/abs/path/copy-of-vendor-sessions.js` (sha256 `b61255778aa3…08e9`) is set. It asserts that the real `ownerOperation` hands the generated `Release` to the wrapped signer before the provider signs, and posts only after `dispatching`. `core/sessions.js` notes that Node may not be able to import the vendored bundle. If it can't, run the same assertions in the browser fixture with the real `/vendor/sessions.js` substituted for the fixture's SDK stand-in.

**Minimal root plan:**
1. Run `node --test candidate/enclave/test/wallet-release/` (Node ≥ 18, needs global `crypto`/`structuredClone`; no new dependencies). It relies on the existing `site/js/core/keccak.js` and on `.js` files under `site` loading as ESM, the same as the existing site tests.
2. Run once more with `WALLET_RELEASE_SDK_FIXTURE` set.
3. Bounded browser DOM test: serve `candidate/enclave/` statically and open `test/wallet-release/held-card.fixture.html`. Then repeat with `?store=idb` (real IndexedDB: sign, reload, confirm a journal state and no new prompt) and `?relay=timeout`. Also open two tabs with `?store=idb` and click both.
4. Read-only against Base: confirm the pins with fresh reads, and confirm that `isDelegate` is at slot 23 for the deployed ledger.

**Dependency closure:** the new modules import only `./keccak.js` and each other. `sessions.js` imports `../core/wallet-release-view.js`. At runtime the page uses SDK exports `ownerOperation`, `ownerFromProvider`, `chainClient` and `RelayClient`, plus the viem PublicClient methods `getChainId`, `getBlock` (latest, number, finalized), `getBytecode`, `readContract` with `blockNumber`, `getStorageAt`, `call`, `getTransactionReceipt`, `getTransaction`, and `request` for `eth_getLogs`.

## Leftover gaps and honest limits

- **Not atomic.** The deployed `release(id,to,opNonce,signBefore,sig)` takes no expected state. Between the post-signature check and inclusion, someone else can change the row. Examples: a prod session calls `setActive`/fund, a host claims after activation, the book admin repoints `deployments`, or someone deposits into or configures a reserve. Recovery detects this afterwards as `conflict`; nothing prevents it. Fixing it needs a guarded contract or relay primitive that does not exist today. The simulation is not atomicity either.
- The **book's code hash is not pinned**: the inventory has none. Only its `addr("deployments")` result is pinned.
- The relay has **no idempotency or status lookup** for `/owner`. Outcomes are known only from chain reconciliation, and an uncertain result can stay unresolved indefinitely. Root decides how to resolve it.
- The scan window is 2000 blocks from the start block, which is well past the 600 s SDK deadline on Base. It still depends on the RPC serving `eth_getLogs` over that range.
- The `isDelegate` slot-23 read is taken from a source comment and is valid only with the pinned ledger code. Root should verify it.
- On page load, each held row does about 25 read calls. There are no sends or loops across apps.
- Durability, quota and multi-tab behaviour of real IndexedDB are only tested by root's browser run. The node tests use a mock.
- This slice migrates nothing on its own. Blocked apps (active or leased rows, escrow, reserves, staging/unpromoted, missing continuity) need separate coordinated paths, and catalog publisher ownership is out of scope. No claim is made about all 99 deployments.
