# Original book `sessionVaultFactory` activation: one administrator MetaMask handoff (SOURCE ONLY, INACTIVE)

**Status.** Source and tests only.
- Nothing has been served, signed, sent or read live from this repository.
- No funding stage, temporary contract, operator funding or delegation action. Only this one transaction.
- Root runs it: review → `node preflight.mjs` (read-only) → `node serve.mjs --serve`.

## The one transaction (frozen in `activation.mjs` `frozen()`)

`EnclaveAddressBook(0xab214342…).set("sessionVaultFactory", 0x1f5c887c…)`
- **From:** the book owner, administrator `0x0b2d009c…`. Base 8453, value 0.
- **Calldata:** byte-identical to `evidence/factory-activation-unsigned-20261023.json` (root's plan, sha256 `3b28b16f…`):
  `0xba44593c…1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c`.
- **Excluded:** `secretVaultV2`, `secretVault`, `deployments` and `registry` can never be set; a test proves it.

**Pinned from root's public evidence** (no getter guessed; see `trust.mjs`):
- runtime keccak:
  - book `0xe4f570e9…` (`existing-custody-audit/evidence/live-custody.json`);
  - factory `0xc9b6214b…` and implementation `0x66c76a47…` → `0x3dd35d4c…` (`factory-activation-unsigned`,
    `session-factory-identity`);
  - v1 vault `0x0179140a…` and v2 vault `0x4b949b37…` (`live-custody.json`);
- `factory.implementation()`;
- `book.addr("deployments")` = ledger `0xb1783b61…`;
- the four vault-held deployments and their SessionVault `0xb794…` (`evidence/consumer-review-state-impact.json`, the
  consumer review @519489c).

**Not pinned:** the ledger's runtime hash is not in that evidence. It is read, and must agree on both providers.

## Before MetaMask is asked (`prepare`, on every click; also `preflight.mjs`)

All reads are at ONE anchor (head − 2) whose block hash both providers (`mainnet.base.org`, `base.public.blockpi.network`)
agree on; every answer must be byte-identical.

1. **Code first:** chain id 8453 and the five pinned runtime hashes. Nothing is called before its code is the reviewed
   code; the ledger must have code.
2. **The book:**
   - `owner()` = administrator. The book's ABI is selected ONLY by its exact code hash (`activation.mjs` `BOOK_ABIS`):
     - the deployed book `0xe4f570e9…` is the first, single-step-owner `EnclaveAddressBook` (Projects/enclave 6c1135b0f);
     - it has no `pendingOwner()` getter and no pending-owner state, so nothing pending is read (root's live read-check:
       the selector is absent and the call reverts);
     - any other book code refuses ("no reviewed ABI");
     - every failed read names the method, contract and provider;
   - `addr(sessionVaultFactory)` = 0. If it is already the factory: "nothing to sign"; any other value: refuse;
   - `addr(deployments)` = the reviewed ledger;
   - `factory.implementation()` = the reviewed implementation;
   - the administrator nonce at the anchor = pending.
3. **Exhaustive impact.** It covers every id of the current ledger (`count`/`idAt`, at most 2000), using the review's
   `effectOf` byte-for-byte (a test compares the source).
   - **For each id:** the owner before (the ledger owner, via `beneficialOwnerOf` while the entry is 0) and after
     (`isVault` ? `owner()`), plus its v1 and v2 `policyOf`.
   - **Refusals:**
     - any `STRANDED` (a policy pinned to a SessionVault);
     - any `restored` or `claimant_changes`;
     - any vault-held deployment outside the reviewed four;
     - a reviewed one held by another vault, or resolving to another wallet than the administrator;
     - a different count.
   - **Batching:** reads use viem's own Multicall3 bytecode run deployless inside `eth_call` (keccak pinned:
     `0x0388a0d4…`, deployless `0x22296fa8…`). No on-chain helper contract is trusted.
4. **Simulation and limits:**
   - simulate and estimate `book.set` on both providers; gas = 1.2 × estimate ≤ 120000;
   - maxFee = 2 × base + tip ≤ 0.1 gwei;
   - the L1 data fee is bounded with the Base `GasPriceOracle.getL1FeeUpperBound(unsignedTxSize)` (Fjord):
     - the oracle adds a 68-byte signature allowance and assumes the worst fastlz case;
     - the code computes the exact unsigned size (113 bytes here) and the maximum signed size (180 bytes; r = s =
       2^256−1, yParity 1). It passes `max(unsigned, signedMax − 68)`, so the oracle's size always covers the signed
       transaction. A smaller argument, such as the previous unsigned-only `getL1Fee`, is refused;
     - verification refuses a wallet-added access list, which would enlarge the transaction past the bound;
   - the balance must cover gas × maxFeePerGas plus that L1 bound. The request's `feeBound.totalExcludingOperatorFeeWei` is
     NOT an all-fee cap: any OP-stack operator fee (Isthmus) is neither read nor bounded here. MetaMask shows the total;
   - the anchor must be unchanged, and the whole preparation must finish within 2 minutes.

## Transport, journal and verification

**Transport.** `handoff-server.mjs` and `rpc.mjs` are byte-identical to `custody-wallet-handoff-20261023@7b49cd99` (a test
asserts sha256 `fb189e46…` and `df00a18b…`).
- The journal (`journals/activate.json`: dir 0700, file 0600, fsync + rename) holds only the public request and, later,
  its hash. It is written as `awaiting-wallet` BEFORE the transaction reaches the browser.
- One attempt per journal. Only the wallet's explicit 4001 resets it. A recorded hash is never replaced.
- An interrupted `preparing` state is reset, because nothing reached the wallet then.
- Origin, Host, token, CSP, `no-store` and the 2 KiB body limit are enforced.

**The page** (`app.js`, the reviewed page with only its local-storage key renamed):
- It calls MetaMask only in click handlers: Connect `eth_requestAccounts`; Review → server preparation →
  `eth_sendTransaction` with exactly the prepared request; Check.
- No `eth_sign`, `personal_sign`, typed data or custom signatures. It refuses a prepared request whose sender, target,
  calldata, value or chain differ from what it displayed.

**Unknown outcome:**
- **Recording a hash:** a hash is recorded only when a provider already returns that transaction with exactly the
  request's from, to, calldata, value, nonce, chain, type and gas, and fee caps no higher.
- **Never re-sent:** an open attempt is never re-sent; a restart keeps it, and the page disables Review.
- **Fresh preparation:** a new preparation also refuses while the administrator nonce has a pending transaction.

**Verification (`verify`):**
- The journaled request must still be frozen; this is checked before any chain read.
- On both providers:
  - the receipt is at least 2 blocks deep, its block canonical, its status 1;
  - the transaction fields are exact;
  - there is exactly one log, `AddressSet(sessionVaultFactory, 0x1f5c…)` from the book;
  - the entry was 0 at `mined − 1`, and is the factory at `mined` and at the latest anchor;
  - the book owner is unchanged and the book code is unchanged;
  - all four reviewed deployments now resolve to the administrator in the v2 vault.
- Both providers' results must be identical.

## Commands (root)

```sh
npm ci --offline --ignore-scripts      # viem 2.53.1 from package-lock.json
node preflight.mjs                     # READ-ONLY: observed state, the exhaustive impact and the exact unsigned request, or why it refuses
node serve.mjs --serve                 # explicit; 127.0.0.1:39672 only; Ctrl-C after "confirmed"
```

**In the administrator's browser with MetaMask** (administrator account, Base), open `http://127.0.0.1:39672/`:
1. Connect.
2. Click Review. The server rechecks everything, journals, and only then hands the transaction to MetaMask.
3. Confirm in MetaMask without editing gas, fees or nonce.

The page polls about 2 minutes. Check repeats it, and accepts a pasted hash after a reload.

## The deployed book's ABI (evidence/book-legacy)

- **Source and settings:** `EnclaveAddressBook.sol` as committed at Projects/enclave 6c1135b0f (sha256 `124aa407…`), compiled
  with that commit's deploy settings (solc 0.8.35, optimizer runs 200, no viaIR).
- **Byte-for-byte match:** it reproduces the deployed runtime: `runtime.hex`, 1809 bytes, keccak `0xe4f570e9…`, the pinned
  live hash. Re-check with `node evidence/book-legacy/reproduce.cjs <solc 0.8.35 package dir>`.
- **Functions:** `owner`, `addr`, `set`, `setMany`, `all`, `count`, `setOwner`. Events: `AddressSet`, `OwnerChanged`.
- **The test fake uses this exact runtime as the book's code.** It answers only selectors that are both dispatched by that
  bytecode and declared in that ABI, and everything else reverts, so it cannot invent a getter such as `pendingOwner()`.
- **Counterexample:** the previous `activation.mjs` (24aac73), run against this fixture, refuses with
  `eth_call: execution reverted`, which was root's live preflight failure. The fixed code prepares.

## What the administrator is told (page text, tested)

- **One shared entry:** one shared book entry changes. Both original custody vaults, and every consumer that reads this
  entry without its own pin, then resolve a SessionVault-held deployment to the vault's owner wallet.
- **Who is affected:** at the checked block, 4 deployments are held by the administrator's SessionVault `0xb794…` and
  none has a policy, so no existing policy changes. The server re-checks this on every click.
- **No simple rollback:** once policies are created for such deployments, setting the entry back to zero would leave them
  updatable by nobody but a claimant whose claim destroys the stored secrets.
- **Off-chain effect** (consumer review @d0e9df8): the running relay's network API, which reads this book key, starts
  accepting `0x0b2d` signatures for those deployments' owner network policies. The relay's sessions and custody gate
  already pin `0x1f5c…` (root evidence `relay-session-authority.json`).
- `secretVaultV2` is not part of this transaction.

## Tests (fake chain; loopback only; through `work/claude-test-queue.py`)

- **`./q.sh 256 activation-N ./run-tests.sh activation`:** `test/activation.test.mjs` 11/11 (book-ABI review; peak 238 MiB). It covers:
  - the evidence and frozen-request equality, the excluded keys, the byte-identical transport/RPC/`effectOf`;
  - preparation and its exhaustive impact;
  - 19 refusals: code ×3, owner, already set, other value, ledger, implementation, STRANDED ×2,
    restored, claimant change, unreviewed vault-held id, other wallet, changed count, pending admin transaction, fee,
    gas, balance;
  - provider disagreement (batched reads, code), a wrong chain, a hanging provider;
  - the transport end to end with readback;
  - 4001, restart and lost-response handling;
  - verification negatives: gas, fee, calldata, value, revert, nonce, depth, tampered journal, receipt disagreement;
  - the read-only preflight;
  - `serve` usage refusals;
  - static page checks;
  - the L1 fee bound: the maximum signed size (signedMax − unsigned = 67 ≤ the oracle's 68), the oracle's bound for that
    size, unsigned-only accounting refused, a signature overhead above 68 raising the argument, a wallet-added access list
    refused, and no all-fee claim. Two fee mutants (unsigned-only argument, unsigned-only size accounting) fail the suite.
- **`./q.sh 512 browser-N ./run-tests.sh browser`:** `test/browser.test.mjs` 3/3, headless single-process Chromium with a
  fake EIP-6963 MetaMask, peak 448 MiB (book-ABI rerun). It covers:
  - no wallet call before clicks, the exact journaled transaction, pending → confirmed;
  - new stranding refused with no send;
  - 4001, and lost-response reload with the wrong hash refused, the real hash confirming, and nothing re-sent.
- **Mutants** (one change each in `activation.mjs`; all fail the suite):
  - no stranding refusal;
  - no reviewed-set check;
  - no pending-nonce guard;
  - verify without the frozen check;
  - no code pins.

## Limits

- **Providers:** two public RPC providers are an agreement check, not a light client.
- **Local access:** any local process can reach the loopback port and the page token (as in the reviewed transport). It
  cannot sign.
- **MetaMask edits:** MetaMask may let the human edit gas, fees or nonce. Verification then refuses, the journal stays
  `submitted`, and root resolves it by hand.
- **Lost hash:** a lost hash after a reload must be pasted from MetaMask's activity tab.
- **Point in time:** the impact holds at the anchor of the click. A policy created after the click and before mining is
  not covered. The window is one block plus the wallet prompt.
- **No real stack exercised:** the tests use a fake chain and a fake MetaMask. The real extension, providers and Base
  were not exercised here; root's existing Anvil proof covers the real book contract (admin set, wrong admin rejected).

Root live preflight after ABI correction exposed `CreateContractSizeLimit`: the deployless Multicall constructor returns its results as code, so 120 policy calls exceeded the EVM 24 KiB limit. The batch size is now 32. A 98-deployment fixture reproduces the old failure and passes with 32; the actual two-provider live preflight also passes (see evidence/root-live-preflight-20261023.json). All 98 IDs are still checked; no impact checks were omitted. Twelve activation tests pass. No transaction was signed or submitted by this preparation.
