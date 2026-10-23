# rpc-receipt-witness: can a complete event-derived index replace fresh `eth_getProof`? (RESULT, 2026-10-23 ~02:00Z)

**Scope**
- Source audit plus a small offline prototype.
- Read-only public network research: about 50 paced requests to keyless Base endpoints.
- No production change, no transaction, no key, no node DB.
- The trees of workers A (Helios/Base EVM) and B (gossip listener) were neither edited nor duplicated.
- The storage VM restore was not touched.

**Status (root, after review):** the conclusion is accepted. Events cannot replace full control state, because silent
admin writes and external state remain.
- The audit and the subset verifier are **diagnostic evidence only**. They are not wired as authoritative policy and
  must never substitute for admin or contract authorization.
- No full receipt index, large backfill or peer census is authorized.

## 0. Answer

1. **No: with the existing contracts, fresh `eth_getProof` cannot be removed for Enclave's full read set.** The
   deployed contracts are not event-complete (§2). Some control-critical state cannot be derived from events at all:
   * It is written with **no event**: ledger `retire()` gates every claim, renewal and funding.
   * It is written by an event that **omits it**: `create`'s `ports`, `configCid`, `appPort` and `isPublic`; catalog
     version specs, `ports` and `config`.
   * It is **recomputed** from `block.timestamp` and other contracts' state: `setShares` rewrites `leaseUntil`,
     `balance6` and the escrow.

   Native ETH balances, EOA nonces and account code (EIP-7702) are **never** in events (§3).
2. **Yes, partially. A real, verifiable subset needs no state proof.** Lease state `(runner, leaseUntil)` for a
   deployment is fully determined by its last `Claimed`/`Renewed`/`Released` event, unless a `SharesSet` follows.
   The same is true of:
   * catalog moderation (`VersionApprovalSet`/`Yanked`/`Verified`, `AppActiveSet`);
   * registry prices, keys and payout;
   * key attestations, payments and HostOwnership.

   The prototype proves such a view from **real Base mainnet data** (§6):
   * header hashes are recomputed and hash-linked to an anchor;
   * every receipt list is checked against its `receiptsRoot`;
   * completeness over the window comes from header blooms or verified receipts;
   * tampering, omission, injection, a withheld bloom-positive block, a missing header, a hidden bloom and a forked
     chain are all refused (11/11 tests; 4/4 mutants killed).
3. **"Light" does not survive the measurement.** Base blocks carry 240–485 transactions. Their 2048-bit
   `logsBloom` had 56–84% of bits set (11 samples), so one contract address was bloom-positive in 10–30% of blocks
   with no real log.
   * A *complete* index of one contract must download and verify full receipt lists for roughly that share of
     **every** block: 120–340 KB per block on eth/69, measured.
   * That is about **3 GB/day** forward for the ledger alone, and hundreds of GB to backfill the 75-day-old registry.
   * A single deployment's lease view over one lease window is cheap: about 135 positive blocks, about 30 MB.
4. **Base execution peers can serve receipts with snap disabled.** That is true in source (§4). snap only gates
   state ranges; eth `GetReceipts` (eth/66-70) and `GetBlockHeaders`/`GetBlockBodies` are always served.
   * Only archive peers serve history (`--full` keeps 10,064 blocks: about 5.6 h now, about 34 min after Denim).
   * Live peer availability is **UNVERIFIED**: the earlier TCP refusals were inconclusive, and no Hello or Status has
     ever been observed.
   * A peer client must also present Base's exact fork-id. That fork-id includes Base-only forks *and* a schedule
     read from an **L1 upgrade-signal contract**, which is a further L1 state dependency.
5. **Sia** can hold authenticated, immutable inputs (signed heads, verified headers and receipt lists, verified
   checkpoint proofs) for cold recovery and backfill. It cannot make up missing fresh evidence, and a cache hit
   proves nothing about freshness or canonicality.

## 1. What was examined (pins)

**Deployed contract sources.** The 10 files recovered by the git blobs pinned in
`contracts/deployments/source-verification-base.json` all match the manifest sha256 (`sources/deployed/MANIFEST.json`):

| unit | build commit |
|---|---|
| registry | b17db9a3 |
| ledger + EnclaveLedgerBandwidth | 4b7419bb |
| catalog | f2e9a71d |
| proof of time | 44d5b928 |
| pay | cf6022cc |
| verification fees | 28dd23c2 |
| connectivity | 4b7419bb |
| payment router | 09ccf9cd |
| key attestations | ee28c686 |
| SessionVault v2 | 4aea7d89 |

These are exactly the runtimes `outputs/contract-change-audit/live.json` matched at block 52848117.

**Other sources and references:**
- **Consumers:** `work/source-checkpoint-20261022/main-repo` @ `1316ad2c`. Every `functionName` literal and raw RPC
  method, with file:line, is in `inventory/consumer-reads.json`: 164 functions; tests, scripts' fixtures and bundles
  excluded.
- **Base protocol references:** base/base `5476069f` (v1.5.1) and base/reth `7134be3b`, read from the
  rpc-peer-audit worker's untrusted extraction (`/tmp/rpa-src`, read only). Citations are paths and lines in those
  trees.
- **Verification library:** op-geth **v1.101702.3** (`7da4560d`, Optimism's maintained fork), fetched through
  proxy.golang.org and recorded in `verifier/go.sum`.

## 2. Event-completeness of the deployed contracts

**Classes** (a projection is valid only where every transition is complete, provable and canonical):
- **E**: complete from events plus the authenticated block timestamp.
- **C**: needs the transaction's calldata. That is sound **only** for a successful *top-level* call to the contract,
  or its own `multicall`. It is unprovable through Safe, ERC-4337, SessionVault or the 7702 lease executor.
- **R**: needs exact replay of contract arithmetic over complete prior state.
- **S**: silent; nothing on chain names it.

| contract (deployed source) | E | gaps (exact) |
|---|---|---|
| Registry | prices, proofKey, payout, measurement, heartbeat, operator, deregister | **C**: re-`register` emits the same `Updated+PricesSet+ProofKeySet` sequence (:156-162) as three setters in one internal tx, yet only `register` sets `active=true` (:156); `setMeasurement` (:252-259) does not. `active` is ambiguous for contract operators. |
| Ledger | lease fields via `Claimed`/`Renewed`/`Released` (:534-536); appRef, config (after `setConfig`), shares, active, transfer, fee/cap/runner rate, bond, escrow, admin scalars; claim rate = burned/(until−ts) | **C**: `create` (:625-660) stores `ports`, `configCid`, `appPort`, `isPublic`, but `Created` (:525,747) has none of them; `importDeployments` (:1472-1522) the whole struct. **C**: `fundFor(payer≠sender)` credits `payer`'s escrow, while `Funded` names `msg.sender` (:1006-1012). **R**: `balance6`/`spent6`/`escrow6`/`creditedUntil`; `setShares` rewrites `leaseUntil` (:868) and the balance; library `credit` advances `creditedUntil` (:1894) and returns with no event when amount is 0 (:1895). **S**: `retire()` (:1733-1736), `setFeeRouter` (:383), `setBandwidthRouter` (:365); `creditProven` → `provenUntil` (:1282-1292). |
| Catalog | app create, edit, active, transfer; version approval/yank/verified/fee/configCid | **C**: `VersionPublished` (:254,448) omits `vramMb`/`gpuGflops`/`memMb`/`cpuGflops`, `ports` and `config` (struct :100-127; set :426-447). `AppCreated` omits `description`. **S/C**: every `publishVersion` silently overwrites app `name`/`description` (`_touchApp` :503-504). Imports (:676-787) are C. |
| Connectivity | host config, policies' main fields, tuna providers | **C**: `Qualified` (:101) omits the recovered **signer**, which is the storage key `attestations[hostId][signer]`. **S**: `revokeDirect` (:131); constructor bootstrap signers (:48). **C**: `bytesServed` holds cumulative bytes, but the event carries units (:169). |
| KeyAttestations | all | none found |
| Pay, PaymentRouter | all (stateless or log-only) | none |
| ProofOfTime, VerificationFees | most | **S**: `stopJob` end-of-job effects and the `returnUnused` balance sweep (VerificationFees); not exhaustively read |
| SessionVault v2 (custody sessions) | session events | **S**: `ownerCall` deletes `held[...]` after an arbitrary call (:851-859); `initialize` sets `owner` (:563). **C+wrapper**: vaults create ledger deployments *internally* (`SessionVaultLib.create` :255-267 → `ledger.create`), so those deployments' `create` fields are unprovable from logs or top-level calldata. |
| Current-tree contracts (deployed source not pinned here) | HostOwnership (events complete), LeaseGasReserve (events plus transient storage), HostPaymaster, ServiceIndex | LeaseGasReserve gates on `extcodehash(operator) == delegationCodeHash` (:163-167): **7702 code, never an event**. Paymaster `hardwareSponsored`/`operatorSponsored` are set in validation (no event). **AddressBook: the deployed runtime predates every source in this history (no `pendingOwner`), so its event behaviour is UNVERIFIED.** SecretVaultV2 (custody) was **not** audited here. |
| External: USDC proxy, Chainlink feed, EntryPoint, Safe, L1 GasPriceOracle, ENS (L1) | USDC balances from `Transfer` (full history of each account, and the proxy's `Upgraded` must be watched); EntryPoint nonces/deposits from its events | the USDC implementation is admin-replaceable; Chainlink, oracle and Safe state are external; **ENS is Ethereum L1** |

## 3. Consumer reads → coverage (`inventory/consumer-reads.json` has every site)

| need (example sites) | reads | event-derived? |
|---|---|---|
| **Claims and renewals: runners** (`supervisor.js:11820` claimableBy, `windows/node/chain.mjs:351,385,762`, `relay/api-relay.js:2085-2086,2659`) | ledger `get`/`getPage` (whole struct), `claimableBy`, `rateFor`, `capOf`, `feeOf`, `bondOf`, `claimBond6`, `proofRequired`, `earned6`; registry `get`; catalog `getVersion`, `versionConfigCid`, `catalogSchema` | **Partly.** E: lease fields, runner, appRef, configCid-after-set, shares, owner, active, cap/fee/bond. **Not**: create-time `ports`/`appPort`/`isPublic`/`configCid` (C), `balance6` (R; needed for "unfunded"), `retired` (S), catalog version specs/ports/config (C), view functions that mix registry, ledger and time (R). |
| **Catalog and moderation (admin)** (`network/host-admission-runtime.mjs:116-117`, `relay/measurement-predict.mjs:738-761`) | `getApp`, `getVersion`, approval, yank, verified | Moderation fields **E**. Version specs/config **C**. App description is overwritten silently (C/S). |
| **Identity, attestation, host admission** (`relay/sessions.mjs:930,966,1015`, `network/onchain-qualification.mjs:26-68`, `network/host-admission-policy.mjs:10`) | `bindingOf`, `isAttestor`, Connectivity `hosts`/`attestations`/`qualificationDigest`, book `addr` (incl. `hostPolicyDigestLo/Hi`), HostOwnership | KeyAttestations **E**. Connectivity attestations **C** (signer not in event). Book **UNVERIFIED** source. HostOwnership E (unpinned source). |
| **Custody** (`custody/chain.mjs:117-125`) | `epochOf`, `committeeOf`, `dealsOf` (SecretVaultV2) | **not audited**: needs the same pass |
| **Sessions and UI wallets** (`relay/sessions.mjs:489-1157`, `sdk/sessions/src/client.ts:140,274`) | `sessionOf`, `seqOf`, `vaultFor`, `isVault`, `held`, `policies`, `epoch`, `implementation` | SessionVault **S/C** paths (`ownerCall`); factory and implementation are code reads |
| **Cost, gas, sponsor** (`client/lease-executor-client.mjs:133-664`, `windows/node/sponsor.mjs:56,78`, `windows/node/chain.mjs:241`, `relay/sessions.mjs:509`) | `getL1FeeUpperBound`, `l1Oracle`, `latestRoundData`, `reserveOf`, `statusOf`, `limits`, EntryPoint `getNonce`/`getUserOpHash`, `estimateFeesPerGas`, `estimateGas` | **No**: L1 fee oracle and base fee are per-block chain parameters (gossip/header carry the base fee); `estimateGas` is execution; Chainlink is external; reserve status checks 7702 code |
| **Native account state** (`eth_getBalance` 32 sites, `getTransactionCount` 31, `getCode`/`eth_getCode` 97, `getStorageAt` 8) | balances, nonces, code, raw slots | **Never from events.** Nonces can be tracked locally by the only signer and confirmed by inclusion; balances, code and slots need state proofs. |
| **Inclusion and submission** (`waitForTransactionReceipt` 77, `sendRawTransaction` 16) | receipt, broadcast | inclusion: receipt in a verified block (the prototype's primitive). Broadcast: only the sequencer HTTP endpoint or an L1 deposit (rpc-peer-audit §4). |
| **Discovery and history** (`relay/indexer.js:101`, `availability/chain-observation.mjs:36`, `relay/lease-generation.mjs:110`, `mcp/independent.mjs:216`) | `eth_getLogs` | Replaceable by verified receipts plus bloom completeness (§6), at §5's cost |
| **Site (UI)** | the above, plus Safe, ENS (L1), EIP-712 domains, ERC-20 metadata | Safe and ENS are external; ENS is L1 |

## 4. Base data availability and integrity: the five things kept apart

| property | source today | status |
|---|---|---|
| **Data availability: receipts, headers, bodies** | Base devp2p eth: `on_headers_request`, `on_bodies_request`, `on_receipts_request`/`69`/`70` (base/reth `crates/net/network/src/eth_requests.rs:192-330`), each capped at 1024 items / 2 MiB (`:49,54,81`). snap is a separate opt-in (`config.rs:283,564`, default off) and does not gate these. | **AVAILABLE in code.** History: a default node is an archive node (`PruneConfig::default()` = all segments `None`: `crates/config/src/config.rs:559-566`, `prune/types/src/target.rs:45-48`, unless `--full`); `--full` keeps receipts for 10,064 blocks (`crates/node/core/src/args/pruning.rs:70-79`, `prune/types/src/target.rs:12`). eth/69 `Status` advertises the earliest/latest block (`eth-wire-types/src/status.rs:81-90`), so a client can pick archive peers. **Live peer count and archive share: UNKNOWN** (no Hello or Status ever observed). |
| **Peer admission (fork-id)** | Base fork-id covers OP plus Base-only forks Azul…Denim (base/base `crates/common/chains/src/chain.rs:140-184`). The schedule is **contract-backed on L1** (`crates/execution/cli/src/upgrade_signal.rs`: "L1 RPC URL used to read the upgrade signal contract", runtime fork-filter refresh). | A light peer must track that L1 contract (L1 light client plus an L1 storage proof), or it will be refused at the next upgrade |
| **Cryptographic integrity** | header hash (keccak RLP) → parentHash chain → `receiptsRoot` (MPT of consensus receipts) and `logsBloom` | **AVAILABLE and verified here** with op-geth (§6). Bodies would add `transactionsRoot` for calldata (class C). |
| **Unsafe vs settled roots** | unsafe: the sequencer-signed v4 gossip payload carries `blockHash`, `receiptsRoot`, `logsBloom` **and the transactions**, but **no receipts** (rpc-peer-audit §3; B's listener). Settled: the L1 `AnchorStateRegistry` anchor (days behind). | The prototype takes the anchor as an **input**. Unsafe ⇒ reorgable: the verifier refuses any window not linked to the given anchor. |
| **Historical backfill** | archive peers (GetBlockHeaders/GetReceipts), or any JSON-RPC as **untrusted** DA, plus Sia archives of verified objects | integrity no longer depends on the provider; availability still depends on *some* holder |
| **Broadcast / inclusion** | Base devp2p drops txs (`tx_gossip_disabled`); sequencer HTTP endpoint or L1 `OptimismPortal` deposit | inclusion = a verified receipt (or the tx in a signed gossip payload, *unsafe*) |

## 5. Measurements (bounded, paced; `probe/`)

- **mainnet.base.org:** refused this site's very first request with "request limit reached", even paced at 2 s. The
  shared egress is already at its limit, so I stopped.
- **Tenderly:** gave one block before its rate limit. **Polkachu:** served everything.

| sample | txs/block | bloom bits set (of 2048) | address bloom-positive, no real log |
|---|---|---|---|
| block 52965176 (tenderly) | 269 | 1139 | 1 of 6 contracts |
| 52965182–191 (polkachu, `bloom-density-5.json`) | 424 mean | 1218–1714 (mean 1435) | ledger 3/10, registry 3/10, catalog 1/10, connectivity 2/10, PoT 2/10, book 3/10; true positives 0 |
| capture window 52965266–293 (`fixture-1.json.gz`) | 242–485 | n/a | (ledger ∧ deployment id) positive in 4 of 27 later blocks, all false |

**Receipt payload per bloom-positive block** (consensus encoding, measured from the verified fixture):
- 181–467 KB;
- on eth/69 (no per-receipt bloom), 120–342 KB;
- JSON from RPC is 0.7–1.8 MB.

**Cost model** (2 s blocks = 43,200/day; Denim makes blocks 10× more frequent with roughly proportionally fewer
transactions each, so daily bytes are of the same order):

| target | cost |
|---|---|
| complete forward index of one contract (~30% positive) | **≈ 3 GB/day** download + MPT verification |
| several contracts | approaching every block's receipts |
| ledger backfill since rev 16d (2026-10-12) | ≈ 30 GB |
| registry backfill (schema 4, 2026-08-09) | ≈ 200+ GB (rough) |
| one deployment's lease view over one 1800 s lease (~900 blocks × ~15%) | **≈ 30 MB** |

## 6. Prototype: a verified real lease view (`verifier/`, Go + op-geth v1.101702.3)

**`probe/capture.mjs`** fetches untrusted raw JSON from one endpoint (polkachu, 36 requests at 2.5 s):
- the newest ledger lease event in the last 1000 blocks;
- every header from that block E to anchor A;
- full receipts of E and of every block whose header bloom admits both the ledger address and the deployment id.

**`verifier.go`** trusts none of it:
1. It recomputes every header hash (keccak of the RLP) and requires a contiguous parentHash chain whose top equals
   the **anchor input**.
2. It recomputes every receipt's bloom from its logs and requires op-geth `DeriveSha` to equal `receiptsRoot` and
   the OR of the blooms to equal `logsBloom`.
3. Every block in (E, A] is either bloom-negative for (ledger ∧ id) or receipt-verified and scanned.
4. It applies `Claimed`/`Renewed`/`Released`, treats a `SharesSet` while leased as "leaseUntil unknown", and names
   what it cannot know.

**Real result** (`go test -v`, and CLI `cli-ok.json`):

| field | value |
|---|---|
| deployment | `0xda09d0f2…68d9` |
| runner | `0x4dde6d1b…68be` |
| leaseUntil | **1792721679** |
| leased | at anchor block **52965293** `0x14e87db3…8bf0` (timestamp 1792719933) |
| from | `Renewed` at 52965266 (`0x8534c846…aa56`), receipt 139, log 361 (= provider's `0x169`) |
| checked | 28 blocks: 23 bloom-negative, 5 receipt-verified (1,824 receipts) |
| runnerOperator | **not determined** (only `Claimed` names it, and it precedes the window) |
| caveats | `retired` not covered (silent); anchor canonicality is an input |

**Tests** (`verifier/run-tests.sh`, queue 1024, offline `unshare -rn`, `GOPROXY=off`; run `t-7`: 11/11 PASS, peak
155 MiB). Each case is refused for the stated reason:
- an altered log, an omitted receipt, an omitted log, an injected later event: receipts root;
- withheld receipts of a bloom-positive block;
- a missing header;
- an altered header field: recomputed hash;
- a zeroed bloom with a re-hashed header: link break;
- a self-consistent forked chain from block 3: anchor;
- a wrong anchor.

The CLI accepts the true anchor and refuses `0x01` with exit 1.

**Mutants** (each a one-line change; all killed):

| check removed | tests that fail |
|---|---|
| receipts-root | 4 |
| withheld-receipt refusal | 1 |
| parent link | 1 |
| anchor | 2 |

### 6a. Input hardening (root review `../ROOT-RECEIPT-REVIEW.txt`)

**Findings held:**
- `receiptsFor` dereferenced each receipt (`CreateBloom` ranges `receipt.Logs` and `log.Address`), so a JSON `null`
  receipt or log would panic.
- The CLI used an unbounded `io.ReadAll` (a gzip bomb included).

**Fixed** (successful-proof semantics unchanged):
- **`Limits` / `DefaultLimits`, all checked *before* parsing:** window ≤ 10,000; the header count equals the window;
  receipt lists ≤ headers; header ≤ 64 KiB; receipt list ≤ 32 MiB; ≤ 20,000 receipts per block; ≤ 10,000 logs per
  receipt; ≤ 512 MiB total.
- **Null refusal:** `null` receipts and logs are refused, and a header without a number is refused.
- **`ReadFixtureFile(path, max)`:** caps both the file and the decompressed stream at max+1 bytes read.
- **CLI bound:** `WITNESS_MAX_FIXTURE_BYTES` (default 600 MiB, above the total limit).

**Tests** (run `t-12`: 18 tests, 24 PASS lines with subtests, 0 FAIL):
- null receipt, null log and null header each refused (no panic);
- the header count checked before parsing;
- surplus receipt lists refused;
- each of the six limits refused;
- the default limits reproduce the real proof exactly (leaseUntil 1792721679, 1,824 receipts);
- `ReadFixtureFile`: oversize refused, exact size accepted, a 64 MiB gzip bomb refused at 1 MiB;
- **CLI:** true anchor → accepted; a 2 MiB sparse file at a 1 MiB bound → exit 2; wrong anchor → exit 1.

**Root's negative binary probe:** it could not run earlier because the temporary binary had been removed. The built
binary is now kept at `verifier/witness-verify` (`sha256` in §9; not in the allowlist, rebuildable with
`run-tests.sh`).

**Still true:** these limits are prototype bounds. Any serving integration must set its own bounds before
allocation. Small fixtures do not prove that limits plus proof are complete.

## 7. Exact missing inputs, and why

1. **A canonical anchor.**
   - From B's sequencer-signed v4 listener (unsafe, seconds), or an L1-finalized output root (days; needs an L1
     light client, the ASR proof and its layout).
   - The prototype cannot authenticate it.
2. **Receipt and header data without public RPC.** A Base eth-wire client (Status with Base fork-id, GetReceipts69,
   GetBlockHeaders) that tracks the L1 upgrade-signal schedule. A live peer census is needed: Hello/Status `Caps`,
   and eth/69 `earliest` to identify archive peers. Not built, not probed.
3. **Calldata for class-C fields.** Block bodies (`transactionsRoot`) plus a decoder valid **only** for successful
   top-level calls.
   - Unknown: the share of existing deployments and versions created through SessionVault, Safe or 4337. Those are
     unprovable without traces, which means execution with pre-state, which means state proofs.
4. **Silent and replay state** cannot be produced by any receipt index: `retired`, routers, `provenUntil`,
   `revokeDirect`, Connectivity signers, the `balance6`/escrow arithmetic, ETH balances, nonces, 7702 code.
   The only options are:
   * (a) a state proof against an authenticated root;
   * (b) local tracking where the reader is the only writer;
   * (c) a contract change.

   (c) is not proposed: existing contracts first. Adding events would also not recover past history.
5. **USDC** balances: the full `Transfer` history per account, plus watching proxy `Upgraded`/`AdminChanged`
   (Circle can change semantics).

## 8. Concrete next implementation (viable, bounded)

1. **Lease-view witness as an opt-in verifier authority, not a replacement.**
   - Wire `receiptwitness.Verify` behind the keeper's "is my lease due / still mine" check.
   - Anchor from B's listener; receipts from any untrusted source; Sia stores verified `(blockHash, receipts)` keyed
     by hash.
   - It refuses on any gap.
   - It does **not** decide claimability: balance, `retired` and the catalog version still need proofs.
2. **Gossip-first forward filter.** B's signed payloads already carry each block's `logsBloom` and transactions, so
   the forward scan needs EL peers only for bloom-positive blocks. Direct-call calldata (class C) comes free from the
   signed payload.
3. **A verified checkpoint plus forward index for the E/C subset.**
   - One state-proof snapshot of the needed slots at an anchored block, verified locally from any untrusted provider
     and archived on Sia.
   - Then forward from receipts and payloads.
   - A field is marked dirty, needing a new proof, when any transaction to the contract in a verified body uses a
     class-C/S selector, or the contract is touched by a non-top-level caller. That detection is itself only
     possible for top-level calls, so dirty-detection is incomplete for internal calls, and those fields stay
     "unknown" rather than stale.
4. **Root-run census** (needs authorization): eth/69 Status from Base peers via discv5 — caps, earliest block,
   fork-id acceptance — to turn §4's UNKNOWN into a number.

Not proposed: an address-book-only witness, a cache or quorum presented as independence, new contracts, or any
bypass of moderation or ownership.

## 9. Files (allowlist in `ALLOWLIST.txt` / `ALLOWLIST.sha256`)

- **`sources/deployed/`:** 11 pinned deployed sources plus `MANIFEST.json`.
- **`inventory/consumer-reads.json`:** every read site.
- **`silent-writers.py`:** the first-pass heuristic; its output was read by hand.
- **`probe/`:**
  - `bloom-density.mjs` and `capture.mjs` (paced, bounded);
  - results `bloom-density-4.json` (1 block), `bloom-density-5.json` (10) and `fixture-1.json.gz` (sha256
    `921a72e6…`; the 6.96 MB raw was `da7cd4c1…`).
- **`verifier/witness-verify`** (built by `t-12`, kept for root's probe, not allowlisted): sha256 `d27feaae23b599ec061f746bc112c35c08c0ecd9f6b1bca9ea50294b0583eae2`.
- **`verifier/`:** `go.mod` (`5f6122a5`), `go.sum` (`7f065332`), `verifier.go` (`16a9d8ec`), `verifier_test.go`
  (`a192cb2b`), `cmd/witness-verify/main.go` (`efabb561`), `run-tests.sh`.

Logs (`verifier/logs/`, `probe/*.out`) and guard logs are excluded.

**Scans** on exactly the 26 allowlisted files (queue 256), all clean:
- repository `.githooks/scan-crypto-keys.py --files`: exit 0;
- `gitleaks dir --config .gitleaks.toml`: 0 findings. It skips the binary gzip, so the decompressed fixture (6.96 MB) was scanned separately: 0 findings.

`probe/fixture-1.json.gz` is binary: a publisher whose capture requires UTF-8 must allow it or carry it base64-encoded.

**Commands:**

```bash
cd work/resume-after-checkpoint-20261022/rpc-receipt-witness
# offline tests (no network; Go module cache)
python3 -u ../../claude-test-queue.py --mib 1024 --log $PWD/verifier/logs/t.guard.log -- verifier/run-tests.sh
# fresh capture (public endpoint, paced; viem from an existing node_modules)
RPC_URL=https://base-rpc.polkachu.com PACE_MS=2500 VIEM_DIR=<…/node_modules/viem> node probe/capture.mjs fixture-N.json
verifier/witness-verify fixture-N.json <ANCHOR_HASH from a head source, not from the same provider>
```
