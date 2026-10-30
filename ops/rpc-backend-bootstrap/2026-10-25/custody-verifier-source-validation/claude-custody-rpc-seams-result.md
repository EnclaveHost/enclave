# CURRENT STATUS (r4, 2026-10-25): tests fixed only; production candidate unchanged; NOT RUN by Claude; root has NOT approved

- **Design (r3, current):**
  - **v1 custodian:** an explicit, opt-in local-verifier mode (`CUSTODY_CHAIN_SOURCE=verifier`). The legacy RPC quorum
    stays the default.
  - **v2 custody: any verifier client is REFUSED** (`chain_verifier_unsupported`). The pinned Helios ignores
    `requireCanonical` on block-hash reads, and the r2 hash→number translation was withdrawn after root's A-B-A finding.
  - v2 production and measured mode are untouched; v2 stays on its RPC quorum.
- **Root r3 run** (`logs/root-custody-r3-2237.out`, `custody-rpc-stage/logs/root-r3-20261025T223625Z/`): the new suite was
  **7/11**.
  - Four tests still built a v2 quorum reader over the verifier, contradicting the intended r3 refusal: tests 3 (quorum
    message), 5 (stale/checkpoint), 6 (outage) and 7 (finality/chain pin). **Test error, not a product error.**
  - The base and patched regression failures were a **HARNESS ERROR**: `lo` was not brought up inside `unshare -rn`. That
    is not attributed to the patch, and no product code was changed for it.
  - Preserved: `custody-rpc-stage/logs/r3-root-failed/` (root `.out`, plus the r3 test file as run) and the root r3
    directory, unchanged.
- **r4 fix (test file only, `src/test` = `tree-patched/test`, sha256 `5543ad2c…`):**
  - **Test 3:** the v1 one-authority guards are unchanged; v2 is refused alone and mixed.
  - **Test 5:** v1 stale head → `chain_stale` (`readState` and `readRelease`); confirmations past the head →
    `chain_unconfirmed`.
    - v1 has **no** sealed-checkpoint API. Its restart protection is the custodian's high-water marks
      (`custody/custodian.mjs`), and they are not exercised here.
    - A v2 checkpoint reader over the verifier is refused before any contact.
  - **Test 6:** an outage fails every v1 read (`readState`, `readRelease`, `readCommittee`, `readEpoch`) closed, and only
    the verifier is ever contacted.
  - **Test 7:** the authority refuses `safe`/`finalized` for `eth_getBlockByNumber` and `eth_call`; v1 reads use only
    numbered blocks; the v1 verifier source is pinned to Base.
  - **No security case was deleted.**
    - The v2 stale/checkpoint/rollback, wrong-chain and agreement rules remain covered by the **inherited v2 RPC-quorum
      regression** (`test/custody-v2-chain-quorum.test.mjs` and the other v2 suites in `logs/regression-list.txt`).
    - The new suite covers only the **new, unsupported v2 verifier mode (refusal)** and the v1 verifier mode.
- **Production candidate files are SHA-pinned and unchanged since r3:**
  - `custody/chain-source.mjs` `125b1ff0…`
  - `custody/chain.mjs` `85301d29…`
  - `custody/custodian-config.mjs` `78e82cb5…`
  - `custody/custodian-daemon.mjs` `cb2848ad…`
  - `custody/v2/quorum.mjs` `5464a7a9…`

  `custody-rpc-stage/MANIFEST.sha256` pins src + tree-patched + patch + job + regression list.
- **Patch:** `custody-rpc-stage/custody-verifier-mode.r4.patch`, 6 files against `deab17485`; its sha256 is in
  `MANIFEST.sha256` (`9209e2c8…`).
- **Root job (prepared, not run): `custody-rpc-stage/jobs/root-r4.sh`.**
  - **Harness checks:** brings up `lo` (and checks it is UP), verifies `MANIFEST.sha256`, and checks that
    tree-base/tree-patched differ by exactly the 6 pinned paths.
  - **Per suite:** runs each suite FILE separately with TAP. A suite passes only with rc 0, fail 0, skipped 0, todo 0,
    cancelled 0 and pass > 0.
  - **Outputs:** `summary.tsv`/`summary.json`, separating patched-only failures from pre-existing base failures.
  - **Exit codes:** 1 if ANY suite fails, 2 on harness/pin errors, via an explicit `exit $rc`.
  - **Command:** `python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/r4.guard -- unshare -rn bash $S/jobs/root-r4.sh`
- **Still unsupported:**
  - v2 custody on the verifier;
  - `custody/v2/host.mjs`'s public default;
  - v1 verifier mode has no L1 finality and changes the trust model (root decision);
  - the compiled Helios runtime was never exercised with a block-hash `eth_call`.

---
(History below; the r2 `blockHashPinnedClient` sections describe the WITHDRAWN design.)

# Custody consumers off public RPC: seam audit + explicit verifier mode (STAGE ONLY; IN PROGRESS)

**Scope**
- **Where:** new `custody-rpc-stage/`.
  - `base/` holds pristine copies from `relay-consumer-source` HEAD `ab371cbc2`; custody had no uncommitted changes there.
  - `src/` holds the candidate files.
- **Not done:** no git worktree, no edits to any other worktree, no live config, services, wallets or measured image, no
  native build, no commit.
- **Reference only:** `relay-consumer-source` (another Claude owns its public-directory and wg-qualify work) and
  `attested-route-source`.
- **Cutover:** NONE authorised. The own Base node is still downloading.

## Call-method inventory (observed source) vs the reviewed verifier authority (`network/chain-authority.mjs` METHODS)

| consumer | JSON-RPC methods | verifier support |
|---|---|---|
| v1 `custody/chain.mjs` `createChainReader` (`readRelease`, `readState`, `readEpoch`, `readCommittee`, `readDeals`) | `eth_blockNumber`, `eth_call` at a block number (`readContract`), `eth_getBlockByNumber` | **all verified**: proven state at that block; the block is on the signed head chain or its authenticated ancestry |
| v1 `custodian-daemon` write commands (`approve-epoch`, `deal`, `receive`) | `eth_chainId`, `eth_getTransactionCount` (pending), `eth_estimateGas`, fee hints, `eth_sendRawTransaction` | **own backend only, bound to the verifier's head.** Refused without `ENCLAVE_CHAIN_TX_BACKEND`, never another server |
| v2 `custody/v2/chain.mjs` via `quorum.mjs` (custodian/member, rewrap guest, host binding) | `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`; `eth_call` and `eth_getCode` with **EIP-1898 `{blockHash, requireCanonical:true}`** | the methods are verified. **The verifier's support for the block-hash object form is NOT established**, so the verifier mode translates it: the hash must be known to and canonical on the verifier's chain, the read is made at that number, and the hash is re-checked after the read |
| v2 `custody/v2/host.mjs` `pub` | `waitForTransactionReceipt` over `cfg.rpc \|\| "https://mainnet.base.org"` | receipts are verified, BUT this host path has a **hard-coded public RPC default**. It is not migrated here (host/measured config); flagged |
| `network/platform-host-policy.mjs` `readPolicyFacts` (v2 `hostPolicy`) | through the same reader `rd` (`eth_call` + block hash) | as v2 |

**Finality:** no custody reader uses `safe`/`finalized`. All read `head − confirmations`, with the freshness limit
(`maxAgeSec`), high-water marks (v1) and checkpoint/rollback refusal (v2). The verifier is the unsafe tier (no L1
finality), the SAME tier as today's quorum. Its `safe`/`finalized` requests are refused, never downgraded.

**Trust change (root decision):** a quorum assumes a majority of the configured RPCs is honest. The verifier relies on its
own proof checks plus the sequencer's unsafe-block signature. That is not "plain RPC", and it is not a quorum: the
verifier is ONE authority, never one vote among RPCs.

## Implementation (`src/`; legacy defaults unchanged)
- **`custody/chain-source.mjs`** (new): `custodyChainSource(cfg)`.
  - **`quorum` (default):** rpcs and minAgree pass through exactly as today. Verifier keys are refused.
  - **`verifier` (explicit):** the reviewed `createChainAuthority` (loopback verifier, optional own backend), minAgree
    1, `clients: [blockHashPinnedClient]`.
  - **Refused:**
    - in verifier mode, any of `rpcs`, `rpc`, `bindingRpcs`, `fallbackRpcs` or `minAgree`;
    - an unknown mode;
    - a missing verifier URL;
    - a chainId other than Base.
- **`custody/chain.mjs` and `custody/v2/quorum.mjs`:** refuse a verifier client inside a multi-client quorum, with
  minAgree ≠ 1, or alongside RPC URLs (v1).
- **`custody/custodian-daemon.mjs`:**
  - new env `CUSTODY_CHAIN_SOURCE=verifier`, `CUSTODY_CHAIN_VERIFIER`, `CUSTODY_TX_BACKEND`; in verifier mode,
    `CUSTODY_RPCS` and `CUSTODY_MIN_AGREE` must be unset;
  - writes use the authority transport, so they are sent only to the bound own backend;
  - the default path is unchanged.
- **v2 daemon, rewrap guest, host:** NOT rewired. They take `MEASURED.rpcs` from the measured config, and changing that
  is a measured-image change, out of scope. `createChainReaderV2({clients})` already accepts the verifier client, and the
  quorum guard applies.

## Tests (actual; shared queue at 256 MiB, foreground)

Tests run in `custody-rpc-stage/run/`: a `git archive HEAD` of `custody/`, `network/` and `test/`, with `src/` overlaid
and `node_modules` symlinked to the reference.

**New `test/custody-chain-source.test.mjs`: 8/8 PASS** (`logs/t2-new.out`; guard `t2.guard`: peak 153 MiB, EXIT 0).
- The verifier side is the REAL `network/chain-authority.mjs` client; only its HTTP peer is faked, through an injected
  `fetch`.
- **Cases:**
  - legacy default unchanged;
  - mixed or public-fallback config refused: `rpcs`, `rpc`, `bindingRpcs`, `fallbackRpcs`, `minAgree`, a public
    verifier URL, a wrong chain;
  - a verifier is never a quorum vote (v1 and v2);
  - v1 reads at head − confirmations see a revoked (paused) policy at the next block, and every read is pinned to that
    block;
  - stale head → `chain_stale`; a checkpoint ahead of the verifier → `chain_rollback`;
  - outage → `chain_unconfirmed`, with no other URL contacted;
  - `safe`/`finalized` refused; wrong chain-id pin refused;
  - v2 block-hash reads: an unknown hash, a sibling-fork hash, `requireCanonical:false` and extra block fields are all
    refused.
- **Failure history (kept in `logs/failed-r1/`):**
  - **r1:** 7/8. The test asserted `e.code` on a viem-wrapped transport error; the adapter itself refused correctly. Only
    the test helper changed (`codeIn` walks the cause chain).
  - **r1 regression run:** killed by the queue (EXIT −15), most likely the 256 MiB cap with parallel test files. Rerun
    serially in r2.

**Regression, existing suites against the patched files** (`--test-concurrency=1`, `logs/t2-regression.out`): 46 pass,
8 fail.
- **The 8 failures are all whole-file `ERR_MODULE_NOT_FOUND` or ENOENT.** The partial overlay lacks `availability/`,
  `cli/`, `client/`, `isolation/`, `relay/`, `scripts/` and `windows/`.
  - This is NOT a regression result for those files; it is **not established**.
  - The output never shows the new guard firing ("one chain authority": 0 matches).
  - Affected: `chain-authority`, `custody-owner-read-transport`, `custody-rewrap-unit`, `custody-v2-book-vault`,
    `custody-v2-capacity`, `custody-v2-shield-daemon`, the custody vectors test, and `rpc-identity-common`.
  - **Next:** root should run those suites in a full tree with the patch applied.
- **The ones that ran passed:** `custody-v2-chain-quorum`, `custody-v2-host-ownership`, `custody-v2-release-authority`,
  `custody-registry-schema`, `platform-host-policy` and the other runnable custody files.

## Artefacts (sha256)
- `custody-rpc-stage/custody-verifier-mode.patch`: `d8cc8790252b1d581a6601b1a12bbefa42cf8c5822600ebfaa8b361033c78fed`
  (5 files, against `relay-consumer-source` `ab371cbc2`).
- `src/custody/chain-source.mjs`: `28cec667…`
- `src/custody/chain.mjs`: `85301d29…`
- `src/custody/v2/quorum.mjs`: `8ff824a8…`
- `src/custody/custodian-daemon.mjs`: `69eb8394…`
- `src/test/custody-chain-source.test.mjs`: `778a0e62…`

## Status: PARTIAL. Not a cutover; nothing is activated.
- **Migrated in source (opt-in only):**
  - v1 custodian reads, through `CUSTODY_CHAIN_SOURCE=verifier`;
  - v1 writes, sent only through the bound own backend;
  - v2 readers when given `clients` from `custodyChainSource`.
- **Not migrated:**
  - the v2 daemon, rewrap guest and host binding, which take `MEASURED.rpcs` (a measured-config change);
  - `custody/v2/host.mjs`'s public default `https://mainnet.base.org`, which must be removed or refused before any
    verifier cutover.
- **Admin controls are unchanged.** Owner pause and revocation, policy revision, committee and epoch, and the book/pinned
  host authority with its mismatch refusals all come from the same reads, now pinned to a verified block.
- **Root still decides** on the trust-model change (k-of-n RPCs → the single verifier, unsafe tier). The custodian-daemon
  `config()` and `readerFor` wiring has no direct test (it is an env-driven CLI); it is covered only through
  `custodyChainSource`.
- **Also needed:** the full-tree regression run above, plus the readiness and attestation gates, before any cutover.

---
# Round 3 (after root review): r2 translation design WITHDRAWN; v2 verifier mode REFUSES; r3 tests PENDING (queue 98 twice)

## Root finding accepted
`blockHashPinnedClient` (r2) translated EIP-1898 `{blockHash, requireCanonical}` to a block number, with before and after
checks. An A-B-A reorg between those calls returns another block's state while the canonical hash looks unchanged, which
breaks v2's strict same-block evidence. **It is removed.**
- The r2 patch and logs are kept under `custody-rpc-stage/logs/r2-rejected-design/`; r1 is under `logs/failed-r1/`.

## Pinned Helios BlockId support: established from local source only
- **Source checked:** `resume-after-checkpoint-20261022/witness-failover/helios` at `ef32029`.
  - `rpc-runtime.mjs` pins the compiled helios `eeffcc9`, described as "CLI source identical in function to ef320298".
  - `rpc-base-evm-export/helios-enclave-base-evm-eeffcc9` contains only opstack patches.
- **Parsing:** `core/src/jsonrpc/mod.rs` declares `eth_call` and `eth_getCode` with `block: BlockId`, so the EIP-1898 object
  is accepted.
- **State is hash-pinned:** `core/src/execution/cache/provider.rs` maps `BlockId::Hash(hash) => hash.into()`.
  `verifiable_api.rs` `get_account` resolves the block by id and verifies the account proof against THAT block's state
  root.
- **`require_canonical` is never read anywhere in Helios** (`grep -rn require_canonical`: 0 hits). The flag is accepted
  and silently dropped, so a known but non-canonical (reorged-away) hash can still be served. **v2's strict semantics are
  NOT supported.**
- **The compiled runtime was NOT exercised.** It needs the full listener, gateway and witness sources, which wasn't
  feasible offline in this round. The refusal does not depend on that run: it follows from the source.

## r3 candidate (`custody-rpc-stage/src`, patch `custody-verifier-mode.r3.patch`)
- **Patch:** sha256 `18b21ca78f84bf3dee08be469902cd6c66200e1ee2d50d8656fa6b880d4c7a54`, 6 files, against
  `relay-consumer-source` `deab17485`. The custody files are byte-identical between `ab371cbc2` and `deab17485`.
- **`custody/v2/quorum.mjs`** (`5464a7a9…`): ANY verifier client is refused, alone or mixed, with
  `chain_verifier_unsupported`. That covers `createChainReaderV2` and every v2 consumer. **v2 production paths are
  otherwise byte-identical**, and v2 measured mode stays on its RPC quorum until the verifier enforces canonical
  hash-pinned reads AND a measured-config release carries the change.
- **`custody/chain-source.mjs`** (`125b1ff0…`): verifier mode is v1-only and passes the reviewed authority client through
  unchanged. There is no translation layer.
- **`custody/chain.mjs`** (`85301d29…`, unchanged since r2): the v1 one-authority guard. v1 semantics are unchanged and
  number-based in both modes; v1 has never been hash-pinned (inherited limitation).
- **`custody/custodian-config.mjs`** (new, `78e82cb5…`): the pure v1 daemon config.
  - **Legacy path:** identical rules and result.
  - **Verifier mode:** `CUSTODY_RPCS` and `CUSTODY_MIN_AGREE` must be ABSENT; a present-but-blank value is refused. A
    blank `CUSTODY_TX_BACKEND` is refused.
  - **Quorum mode:** verifier variables are refused.
  - **`CUSTODY_CHAIN_SOURCE`:** blank or unknown values are refused.
- **`custody/custodian-daemon.mjs`** (`cb2848ad…`): `config()` calls the pure function and turns a throw into `die()`.
- **Tests** (`test/custody-chain-source.test.mjs`, `d24171fa…`, 11 tests). On top of r2's config, quorum, stale,
  rollback, outage, finality and revoked-policy cases:
  - v2 refuses the verifier;
  - a **wrong-branch/A-B-A negative**: the fake answers a by-number read inside the A-B-A window with block B's state. The
    test asserts that the canonical hash object reaches the verifier unchanged and returns A's state, which fails under
    r2's number translation;
  - the pure daemon config, including unset vs blank;
  - the **real daemon** (`serve`) as a child process, which refuses mixed or blank config before any key, file or network
    use.

## Tests: r3 NOT RUN (pending, not passing)
- **Queue:** exit 98 twice, "NOT STARTED: small allocation held" (`custody-rpc-stage/logs/r3-not-started-1.txt`). No r3
  test has run; the r2 8/8 is for the withdrawn design and does not count.
- **Prepared full regression:** two private `git archive deab17485` trees, `tree-base` (pristine) and `tree-patched`
  (exactly the 5 custody files + the new test overlaid). `diff -rq` shows only those 6 paths. Both use the same
  `node_modules` symlinks (read-only targets). The r2 missing-import files exist in the full archive. Run when admitted:
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/custody-rpc-stage; L=$S/logs; REG=$(cat $L/regression-list.txt)
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $L/r3.guard -- bash -c "cd $S/tree-patched && node --test --test-reporter=spec test/custody-chain-source.test.mjs > $L/r3-new.out 2>&1; echo new-rc=\$? >> $L/r3-new.out; cd $S/tree-base && node --test --test-concurrency=1 --test-reporter=spec $REG > $L/r3-regression-base.out 2>&1; echo reg-rc=\$? >> $L/r3-regression-base.out; cd $S/tree-patched && node --test --test-concurrency=1 --test-reporter=spec $REG > $L/r3-regression-patched.out 2>&1; echo reg-rc=\$? >> $L/r3-regression-patched.out"
```
- **Acceptance:**
  - new tests 11/11;
  - patched regression ⊇ base regression passes;
  - any base failure is reported as pre-existing, never hidden.

## Remaining unsupported (honest)
1. **v2 custody (custodian/member, rewrap guest, host binding) on the verifier:** REFUSED. It needs Helios to enforce
   `requireCanonical` (or an atomic hash-pinned API) plus a measured-config release.
2. **`custody/v2/host.mjs`:** its public default `https://mainnet.base.org` is untouched; v2 production is untouched.
3. **v1 verifier mode** (opt-in, not activated):
   - inherits v1's number-based multi-call reads (no hash pinning), the same as legacy;
   - unsafe tier, no L1 finality;
   - the trust change from k-of-n RPCs to one verifier is root's decision.
4. **Not run:** the compiled Helios runtime with a block-hash `eth_call`.

Root has not approved the patch, and no cutover is authorised.
