# A2–A4: authenticated start state at N for the self-hosted Base node: PREPARED procedure (NOT executed; publication refreshed 2026-10-25 after root's 13/13 mutant run, see §7)

**Status: preparation only.**
- **Not done:** no live DB read or mutation, no SSH, no download, no compile, no commit.
- **Not validated:** full real validation waits until the snapshot download finishes, the native binary is pinned and
  its ABI passes, and root reviews this procedure.
- **Tested (mock suite only, not reth integration):** stage unit run `unit-rr2` OK (`test_a2a4` 20, `test_receipt_writer`
  2, `test_pinned_manifest` 1). Root's mutation run `root-a2-mutants-2140` rc 0: baseline 20 + 2 + 1 OK, and exactly the
  13 expected mutants KILLED by assertion failures. Failed earlier runs are kept (§7).
- **Production stays BLOCKED:**
  - `OPEN_GAPS = ['bytecodes-content-unverified']`: the native bytecode checker is source only and unbuilt (G-a);
  - the original-game A1 re-check (G-h) is NOT integrated, so `release` cannot pass once the anchor has advanced.
- **Source references:**
  - `R` = base-reth 2.5.2 `7134be3` (the reth that base v1.5.1 links);
  - `B` = base v1.5.1 `5476069f`;
  - the trust model: `finality-investigation/anchor-bootstrap-review/REVIEW.md` §2.

## 0. Inputs (bound, never assumed)

| input | value / rule |
|---|---|
| A1 | `outputs/.../l1-a1-live-1958`: N **52,866,960**, output root `0xa996c517…6700`, game `0x343b3a99…21ac`, ASR `0x909f6cf4…4e72`, game type 621. **The file is NOT accepted by existing**: `plan`, `a2` and `release` (not `a3`/`a4`) each require an A1 re-run ≤ `a1MaxAgeSec` (60–3600) old, with the pinned mainnet ASR and code hashes, the same N, output root and game, every read `helios-call`/`mpt-proof`, and an L1 finalized age ≤ 1800 s. **A fresh re-run of the CURRENT A1 tool is necessary but NOT sufficient for `release`:** by then the ASR anchor normally has advanced past N, and the gate refuses with `a1_anchor_advanced`, because the current tool re-checks only the latest anchor. The original-game re-check (G-h, §3) is NOT integrated, so no plain A1 re-run makes `release` pass |
| snapshot | manifest `1792886410` (sha `1f0c4e6c…`), head **53,048,526**. Unwind depth **181,566** |
| state floor | changesets held from **52,500,000** (root `stateHistoryFromBlock`). N ≥ floor (asserted) |
| binary | pinned `base` `9c44836d…`. **Root's capture of the PINNED guest binary's help** (`outputs/.../base-cli-help-2025/help.out`) replaces the earlier upstream-2.8.0 evidence. It confirms `--config` on db/unwind/run/drop, the `--offline` meaning ("all stages except headers, bodies, and sender recovery"), `--skip-unwind`, `-c/--commit`, and **`--checkpoints` ("Save stage checkpoints")**: A4 now passes it, because without it `merkle-execute` is never saved. `db get --help` was NOT captured, so `plan` checks it live |
| download completion | **not the marker's content.** `stage_backend.py:89` touches an EMPTY root-owned `snapshot-complete`. `plan` requires a root-written receipt `base-snapshot-completion-receipt/v1` (uid 0, not g/o-writable) binding the pinned manifest `/opt/enclave-rpc/snapshots/base-1792886410-manifest.json` sha `1f0c4e6c…` (root-owned), block/chain/storage version, the unit `enclave-rpc-base-snapshot.service` `Result=success`/`ExecMainStatus=0` (also re-read live), exactly the archives selected by the pinned retention profile, and the datadir dev/ino. **Only the final profile `final-h48000000-s52500000` (134 archives) is accepted;** a receipt for the 116-archive first-pass download is refused (`first_pass_only`). The marker must exist, root-owned and EMPTY. **Full-verification condition:** the client verifies every extracted file against the manifest's per-file BLAKE3 after each extraction (`download/archive.rs:180-186`, `verify.rs:40`), but only files LISTED (`output_files`/`chunk_output_files` are `#[serde(default)]`). So every selected archive must have a non-empty, well-formed list, and the archives covering N and the 52.5M floor (headers and account/storage changesets chunks 105–106, plus state) must be selected. **A missing receipt refuses** |

## 1. Audited client semantics (the reason for each rule)

| fact | source | rule in `a2a4.py` |
|---|---|---|
| `base reth` re-exposes reth `db`/`stage`; `--datadir` is per subcommand; `BASE_CHAIN` set ⇒ refuses | `B/bin/base/src/commands/reth.rs:14-59`, `B/bin/base/src/config.rs:149-156` | `BASE_CHAIN` removed from the env; `--datadir` on every call |
| **v2 storage: `HashedAccounts`/`HashedStorages` ARE canonical state**; hashing stages are no-ops (`hashing_account.rs:168-169`); `stage run hashing` hits `_ => Ok(())` (`run.rs:329`); `stage drop hashing`/`execution` deletes canonical state | `R/.../metadata.rs:85-87`, `drop.rs:51-55,157-173` | **refused** on v2. A4 = merkle only. The legacy (non-v2) layout is refused, not prepared |
| merkle `stage run --from 0 --to N` ⇒ full trie rebuild, then `validate_state_root(root, header N)`; mismatch ⇒ exit 1. **`--from N --to N` passes trivially** | `R/.../stages/merkle.rs:211-247,367,216-217`; `run.rs:370` | always `--from 0 --to N --commit --skip-unwind` after `stage drop merkle` (a mutant that uses `--from N` is killed) |
| `stage drop merkle` clears `AccountsTrie`/`StoragesTrie`, resets `MerkleExecute`/`MerkleUnwind` | `drop.rs:174-185` | drop before the run |
| `stage unwind … to-block T` keeps T. **Non-offline** unwinds all stages, truncating headers, transactions, senders, receipts and changeset static files, RocksDB `TransactionHashNumbers`/`AccountsHistory`/`StoragesHistory`, prune checkpoints, and lowering `ChainState` finalized/safe. **`--offline` leaves headers, bodies and Finish above N** | `R/.../stage/unwind.rs:94-129,150-181`; `headers.rs:361-363`; `provider.rs:3033-3117,3797-3818`; `pipeline/mod.rs:389-411` | non-offline only; after it: every checkpoint == N, `db get static-file headers N+1` empty, labels ≤ N, header N re-authenticated |
| the non-offline unwind runs ONE unthrottled execution batch | `unwind.rs:105-129` | chunked descending targets (`unwindChunk` 1,000–50,000), checkpoint verified after each |
| every external command is **bounded** | — | its own session/process group, stdout/stderr to files (never memory), a per-class time and output cap (help 60 s/1 MiB; reads 900 s/64 MiB; merkle drop 3600 s; unwind chunk/merkle run/bytecode check from the **declared** `timeouts` 600–86,400 / 3600–604,800 / 600–172,800 s, 256 MiB log cap). On a bound: SIGTERM to OUR group only (pgid == the live child's pid), 120 s grace, SIGKILL our group; no kill by name. **Zombie-held cleanup (`settle_owned`):** the exited leader is left an UNREAPED zombie (`waitid(WNOWAIT)`), which keeps our pgid reserved while any remaining group members are sent TERM, grace, then KILL. Only then is the leader reaped, and no signal is sent after reaping. A leader still alive after SIGKILL is not reaped and the command refuses. Descendants that left the group are not tracked |
| **mutation journal** | — | `mutation-journal.jsonl` (fsync): `started` before and `finished`/`interrupted` + rc after every unwind/drop/run. **Any step refuses if the last entry is not `finished` rc 0** (`interrupted_mutation`): no automatic resume |
| **the unwind commits per stage step: NO rollback** | `pipeline/mod.rs:415-419` | `inPlaceReviewed` required; recovery = re-download (§4) |
| MerkleUnwind validates the incremental trie against the LOCAL header N (consistency, not canonicity) | `merkle.rs:429-437,457-474` | not relied on: A2 authenticates header N; A4 does a full rebuild |
| the prune guard acts only for `PruneMode::Distance` on account/storage history; modes come from `--config` or `<datadir>/reth.toml` (no `--prune.*` flags on `stage`/`db`) | `R/crates/prune/types/src/target.rs:130-170`; `common.rs:113-118,211-212` | `rethConfig` must set `account_history`/`storage_history` = `{ before = ≤52500000 }` and is passed as `--config` to every call. **The downloader's `Distance(140000)` `reth.toml` would refuse N (181,566 > 140,000)** |
| `db get` of a missing key logs and **exits 0 with empty output** | `R/.../db/get.rs:290-292,490-497` | every read requires non-empty, parsed output (`empty_read`; a mutant without it is killed) |
| `db get static-file headers N` prints `Header\n{json}\n\nBlockHash\n{json}` | `get.rs:257-264` | the JSON header is parsed and **the hash is recomputed** (anchor module); the printed BlockHash is ignored |
| `stage-checkpoints get` prints Rust Debug `stage: Some(StageCheckpoint { block_number: N, .. })` | `stage_checkpoints.rs:37-53,110-126` | parsed per stage (`headers`, `bodies`, `execution`, `merkle-execute`, `finish`) |
| the `proofs` store is never unwound (`ExExManagerHandle::empty()`); it is only used with `--proofs-history` | `unwind.rs:128`; `B/crates/execution/node/src/args.rs:394-421` | `<datadir>/proofs` must be absent; never enable `--proofs-history` |

## 2. Steps (root, inside the RPC guest, as the service user, Base node AND consensus units stopped)

```
python3 a2a4.py plan    CONFIG   # read-only: all gates; prints the exact a3/a4 argv; mutates nothing (tested)
python3 a2a4.py a2      CONFIG   # header N from the datadir -> authenticateAnchor (recomputed hash + output root)
python3 a2a4.py a3      CONFIG   # inPlaceReviewed: chunked `stage unwind --config F to-block T_i`, last T = N; post-checks
python3 a2a4.py a4      CONFIG   # inPlaceReviewed: `stage drop merkle`; `stage run --from 0 --to N --commit --skip-unwind merkle`
python3 a2a4.py bytecodes CONFIG # after a4: the pinned checker binary (NOT built: G-a open)
python3 a2a4.py release CONFIG   # fresh A1 again; writes m10-launch.json ONLY when no gap is open (currently REFUSES)
```

- **Gates before any DB access.** Every DB-touching step (`plan`, `a2`, `a3`, `a4`, `bytecodes`, `release`) runs
  `gate_static` first. It checks, in this order:
  1. units stopped and no datadir openers;
  2. the completed-download receipt (final profile);
  3. the binary pin;
  4. the prune config;
  5. no proofs store;
  6. capacity and backup;
  7. the pinned `--help` capabilities.

  Only then does the first DB read (`db settings get`) and the v2 check run. The runner refuses any non-help `db`/`stage`
  call before that point in the process (`ungated_db_access`). `a4` also refuses with `not_unwound` if the DB is no
  longer at N after A3.

- **Records:** every invocation writes `run-<step>-<ts>.json` with each argv, rc and timing in a 0700 workdir, never
  overwritten. The step outputs are `a2-authenticated.json`, `a3-unwound.json`, `a4-rebuilt.json` and `m10-launch.json`.
- **Order** is enforced (`order`).
- **What release hands on:** M10 `--bootstrap.anchor N:hash`, used only after `release`. Then the base-consensus
  derivation restart: M10's EL-head check, the anchored reset, and the SafeDB wipe.

## 3. Real missing client capabilities and liveness (reported; NOT bypassed)

| id | gap | status |
|---|---|---|
| **G-a** | `Bytecodes` content. No load path checks keccak(code) == key, and a tag-2 (LegacyAnalyzed) row is decoded with its STORED padding, `original_len` and jump table trusted (`reth-primitives-traits-0.6.0/src/account.rs:180-224` → revm `new_analyzed`, "only for restoring trusted… undefined behavior"). A forged jump-table bit changes JUMP/JUMPI validity (`revm-interpreter-42.0.0 control.rs:41`, `jump_map.rs:173-175`), and `original_len` drives CODESIZE/CODECOPY/EXTCODE*, **even when the hash matches**. A missing row silently becomes empty code (`crates/revm/src/database.rs:153-155`). `db list --json --raw` re-encodes and panics on junk, so it is unusable | **Prepared, NOT built:** `bytecode-check/` (Rust, the locked revm-bytecode 42.0.0 and reth 2.5.2). It walks ALL raw rows through a `RawTable` cursor, so no panicking decode is involved. **tag 2:** `L>0`, `O≤L`, keccak(B[..O]) == key, zero padding, revm's OWN fresh `new_legacy` analysis (padding ≤ L, non-canonical counted), every stored jump bit == fresh for i<O and 0 for i≥O, table covers the decoded bit length, no 7702 bytes stored as legacy. **tag 4:** canonical 23-byte `ef0100` and keccak. **tag 0:** keccak. **Others:** error. **Completeness:** every non-empty `HashedAccounts.bytecode_hash` has a row. **Step `bytecodes`** runs the pinned checker binary (sha pin) only after A4, with clients stopped and the DB at N, and binds the receipt to the `mdbx.dat` dev/ino/size/mtime, the checkpoints sha and the header-N hash, before == after. `release` requires that binding for the current DB **and still refuses on `OPEN_GAPS`** until the checker is built, its tests pass and a live run passed under review (a source change, not a config switch). API names (`bytes_slice`, `legacy_jump_table`, `is_valid`, `open_db_read_only`) must be confirmed at build |
| **G-h (liveness)** | `release` re-runs A1 hours after A2. The current A1 tool reads only the LATEST ASR anchor. If the anchor advanced past N (normal: new games keep finalizing), the result is `a1_anchor_advanced`, a refusal, not a pass | **Exact recovery, no relaxation:** extend A1 with a reviewed **game-specific re-check**: for the ORIGINAL game G at a fresh Helios-finalized L1 block, `isGameFinalized`, `!isGameBlacklisted`, `!isGameRetired`, `isGameRespected`, `!paused`, `status == DefenderWins`, `rootClaim == output root` and `l2SequenceNumber == N`. Until then release refuses. **Never** re-anchor to the new N' by accepting blocks N+1..N' from the DB, and never relax the policy. (After a correct release, N+1.. are executed by our own EL.) |
| G-d | the unwind and rebuild memory/time on the HDD are unmeasured | measure (G6); the declared timeouts are root's choice |
| G-e | history indices and tx-lookup below N are snapshot-derived | the serving layer refuses historical state below N |
| G-f | `proofs` store / slot-preimage DB | `proofs` absent and never enabled; preimage pre-Cancun only |
| G-g | the header JSON and checkpoint Debug formats are inferred | parsers refuse on any missing field |

## 4. Capacity, backup and recovery (in place only after explicit root review AND the completion receipt)

- **Size, with provenance:** the first-pass download is **116 archives, 827.64 GB compressed / 1,274.29 GB extracted**. The required final profile is **134 archives**: the 18 missing txs/receipts archives (files 96–104) add a modeled 221.6 GB compressed / 410.0 GB extracted, about **1,049 GB / 1,684 GB** in total (`retention-review/bootstrap-state-candidate/`; the cached download's preflight measures free space at run time). The first-pass figures come from
  `retention-review/manifest-measurements.txt`, read from the pinned manifest. `state` is 1,138.2 GB of that.
  - `rocksdb_indices` (715.7 GB extracted in the manifest) was **not selected**. The download then resets the history and
    tx-lookup checkpoints (`download/config_gen.rs:116-136`), so the node rebuilds those indices later: **future size is
    unknown, upper reference ≈ 0.7 TB.**
  - Growth after first start is unknown.
  - My earlier "2.1 TB" figure was wrong.
- **Copy:** none is prepared (`backup` refuses). A copy needs ≥ the measured datadir size plus a reserve on another
  filesystem. Its time on this QD1 USB HDD is **unmeasured**: no duration is promised.
- **Interrupted mutation:** the unwind commits per stage, so an interrupted or failed step leaves an UNKNOWN state. The
  journal blocks all later steps. Then:
  1. inspect read-only (`db stage-checkpoints get`, `db stats`);
  2. root decides;
  3. the default recovery is a re-download of the final-profile archives (134, about 1,049 GB compressed). Preserve the manifest, the receipt and the
     recovery metadata.
- **Do not edit the datadir `reth.toml`:** pass the reviewed `--config`.

## 5. Tests (shared queue 256, foreground; current results in §7)

- **Test double:** a fake `base` (`test/fake_base.py`) implements only the audited surface: fail-open `db get`, `to-block`
  keeps T and truncates above, merkle `--from 0` exits 1 on a root mismatch, and a v2 hashing drop destroys state.
- **Real hashing:** header N and its output root are built and checked with the REAL published `anchor-bootstrap.mjs`.
- **Covered:**
  - plan is read-only with exact argv;
  - stale, foreign-ASR, wrong-N or unproven A1 refused;
  - Distance prune config, proofs dir, unfinished snapshot, running unit, missing capability, binary pin, backup,
    legacy layout and capacity refused;
  - A2 accepts the real header and refuses a forged root, a missing header and a missing field;
  - A3 requires review, unwinds in chunks to exactly N with labels ≤ N, and refuses a short unwind and surviving
    headers;
  - A4 runs the full rebuild, with no hashing drop, and refuses a mismatch;
  - release is blocked on G-a and needs a fresh A1;
  - steps are refused out of order;
  - *(added in the real-test repair)*:
    - every DB step (`a2`, `a3`, `a4`, `bytecodes`, `release`) with NO plan run is refused by its specific gate, and
      ZERO `db`/`stage` argv reaches the binary (wrong pin, no or first-pass receipt, non-empty marker, active or failed
      unit, bad prune config);
    - a v1 layout makes only `settings get`;
    - a direct ungated `Base.db` call is refused (`ungated_db_access`);
    - an interrupted real `stage unwind` journals `started`/`interrupted` and blocks later steps;
    - an anchor at N+1 gives `a1_anchor_advanced`, and N−1, a wrong outputRoot or a wrong game give `a1_anchor`;
    - `a4` refuses `not_unwound` if the DB moved after A3;
    - the bytecode receipt binds the post-A4 DB (`failures`/`missingCode` refused; stale on changed checkpoints or a
      changed `mdbx.dat`), and `release` still refuses on `open_gaps`.
- **Not covered:** the real binary, the real datadir, real timings, and the native bytecode checker (not built).


## 6. Second root review (2026-10-25): what changed

1. **Selection: exact, derived, profile-pinned** (`selection.py`, shared with the writer).
   - The selection is derived from the pinned manifest and a pinned retention profile, by the client's own rules (pinned
     reth `download/mod.rs:721-777`, `planning.rs:190-200`):
     - State and Headers are `All`;
     - txs, receipts and changesets are `Since`/`Distance` mapped to whole chunks;
     - Senders and RocksDB are never selected (their flags are refused).
   - **`first-pass-distance-140000` → 116 archives**, which reproduces root's measurement exactly. **`final-h48000000-s52500000`
     → 134 archives**, root's approved option-B cached download (`base-retention-stage/v2/cached_download_preflight.py`
     `command`).
   - The receipt must list exactly the derived set:
     - entries are `{component: str, chunk: null|int}`, with chunk ≥ 0, in range and not bool;
     - null only for single archives;
     - unique.
   - The receipt's `downloadArgv` must be that profile's invocation: the pinned manifest path, the datadir, the exact
     selection flags, and no `--force`, `--prune-unlisted`, `--with-senders`, `--with-rocksdb`, `--all`, `--archive`,
     `--minimal`, `--full`, `--url` or `--proofs`.
   - **A first-pass receipt is refused** (`first_pass_only`): distinguishable, never final readiness.
   - **Writer:** `write_download_receipt.py` (root, after the unit finished). It reads systemd's record of the LAST
     invocation (`Result=success`, `ExecMainStatus=0`, `InvocationID`, and the recorded `ExecStart` argv with
     `code=exited status=0`), then:
     - checks the argv against the profile;
     - re-derives the selection from the pinned manifest (sha `1f0c4e6c…`) and requires per-file checksums for every
       planned archive;
     - requires the empty root-owned marker and binds the datadir dev/ino;
     - writes the receipt with `O_EXCL`, never overwriting.

     It never starts or downloads anything.
   - **BLAKE3 evidence:** there is no per-file log. The evidence is the client's own semantics, plus `ExecMainStatus=0` of
     that exact invocation:
     - the plan bails without checksums;
     - an archive completes only through VerifyOutputs;
     - outputs are reused only after verifying.

     An independent re-hash pass is NOT prepared.
2. **Stopped before any DB open** (`gate_stopped`, the first gate).
   - **Required units** (config may only add):
     - `enclave-base-holder.service`: the Base node, with consensus EMBEDDED (`base --chain mainnet rpc` from
       `chain_service.py base`);
     - `enclave-base-holder.path`: `PathExists=…/snapshot-complete` would auto-START the node;
     - `enclave-rpc-base-snapshot.service`: the downloader.
   - **No opener:** no process may hold a file under the datadir (a `/proc/*/fd` scan). It refuses if any fd table is
     unreadable, so run as root.
   - **v2 is enforced** at the generic static gate.
3. **Runner:**
   - mutating commands' stdout is never read into memory (path plus stderr tail only);
   - the output size is re-checked after a quick exit;
   - after the session leader exits it is kept as an UNREAPED zombie (`waitid(WNOWAIT)`), so its pgid cannot be reused;
     any process still in that group is ours: TERM, grace, KILL. The leader is reaped last, and the command fails with
     the journal marked interrupted for mutations. *(Superseded wording, 2nd review: "a pgid stays reserved while a member
     lives"; the current code holds it with the zombie leader, see §7.)*
   - **Limit:** descendants that left the group (`setsid`/`setpgid`) are not tracked. Reth is not expected to do this.
     This is not a stronger guarantee.
4. **Bytecodes helper** (`bytecode-check/`, SOURCE ONLY; G-a stays open).
   - **Constructors:** tags 0 and 4 use revm's canonical fallible constructor `new_raw_checked`, so a raw EIP-7702 row
     decodes as the client decodes it, and a malformed `ef01…` row is refused, not a panic.
   - **Trailing bytes** after the tag are refused (fail-closed; the client ignores them).
   - **Bounds:** rows over 64 KiB are refused before any slice.
   - **Tag 2:**
     - the decoded `bit_len` follows the client exactly (L if `rest·8 ≥ L`, else O);
     - a table shorter than that is refused (the client would panic);
     - every bit < `bit_len` must equal revm's fresh analysis (and be 0 at ≥ O);
     - bits beyond `bit_len` are never read, so they are only non-canonical;
     - `canonical` = the padded length and table bytes equal fresh.
   - **Completeness** is factored as a pure function, with no unbounded hash collection.
   - **Inline tests:** a canonical row; key, padding and `original_len` forgeries; added and removed JUMPDEST bits; a
     short table; a set bit inside [O, L); a delegation (tag 4, raw tag 0, trailing, wrong version, non-7702 under
     tag 4, 7702 stored as legacy); unknown tags; completeness.
   - **The API names were confirmed in the pinned source** (revm-bytecode 42.0.0 `new_legacy`, `new_raw_checked`,
     `is_eip7702`, `bytes_slice`, `legacy_jump_table`, `JumpTable::{is_valid, as_slice}`; reth 7134be3
     `open_db_read_only`, `DatabaseArguments::with_max_read_transaction_duration`, `MaxReadTransactionDuration`,
     `RawKey/RawValue::{raw_key, raw_value}`; alloy-primitives 1.6.1 `KECCAK256_EMPTY`).
   - **NOT compiled; no compile or test pass is claimed.**
5. **The mock suite is not reth integration.** The fake `base` implements the audited surface only; the real binary,
   datadir, unwind, merkle rebuild and bytecode check have never run.

## 7. Root review publication (2026-10-25): current frozen code and actual evidence

This section records what the published files ARE and what the retained logs SHOW. It adds no implementation claims.

**Frozen code** (copied unchanged from `finality-stage/a2-a4-execution/`):

| File | sha256 |
| --- | --- |
| `a2a4.py` | `85b4fc92bb7b778946ae494a69f19d88c3b47c92fa92937f0a48cfd52f9eb047` |
| `test/test_a2a4.py` | `5a84ac201fe64c6ba563cfd6fb06a118596b1a6164f25629ef13bbaf987492d1` |
| `test/fake_base.py` | `6ee6df6b8e0cedc77330738f583c2ac6f352777549b59b14becb1971887a947a` |
| `mutants.sh` | `38b4d44dff7a45e68fe07047dffca00f1a47efec24c62506888bd23e5c87be5a` |

The other files are listed in `SHA256SUMS`. This PROCEDURE is the only file corrected for publication: the stage copy
still carries the stale second-review wording.

**Test history** (all kept, in `logs/`):

| Run | Log | Result |
| --- | --- | --- |
| stage unit-1 / unit-2 | `logs/stage/unit-{1,2}.log` | FAILED (errors=9) / FAILED (failures=1, errors=3): first round |
| stage unit-3 / unit-4, mutants / mutants-2 | `logs/stage/`, `logs/superseded/` | OK (10 tests) / OK; mutants rc 1 (anchor not found) then 4/4: earlier code, superseded |
| unit-r1, unit-r2, unit-s1, mutants-rr1, root-tests-2104 | `logs/*not-started*`, `logs/stage/unit-{r1,r2,s1}.log`, `logs/root/root-tests-2104.*` | NOT STARTED (queue exit 98); not results |
| **root unit 2132** | `logs/root/root-unit-2132.{out,guard,rc}` | **rc 1: 19 tests, 4 FAILED.** Interrupted-mutation fake, A1 N+1 expectation, a2 reading the DB without `gate_static` (a real bug), and the bytecode-test fixture reset |
| stage unit-rr1 | `logs/stage/unit-rr1.log` | FAILED (failures=1): the bytecode test before the a4 `not_unwound` and fixture fix |
| **stage unit-rr2** | `logs/stage/unit-rr2.log` | **OK: 20 + 2 + 1** |
| **root mutants 2140** | `logs/root/root-a2-mutants-2140.{out,guard,rc}`, `logs/root/mutants-20261025T214030Z/` | **rc 0, `MUTANTS rc=0`:** baseline 20 + 2 + 1 OK. Exactly the 13 expected mutants KILLED by assertion failures (0 errors): `merkle-from-n`, `no-empty-read-check`, `no-open-gaps`, `no-a1-age`, `no-journal-guard`, `no-blake3-list-check`, `no-checkpoints-flag`, `no-final-profile-check`, `no-exact-selection`, `db-before-units`, `no-v2-enforcement`, `no-orphan-reap`, `no-post-exit-size`. Peak 105 MiB |

**What the code does now** (see §0, §1 and §2 for detail):
- **Profile:** only the final profile (134 archives) is accepted.
- **Gate order:** stopped and static gates run before any DB access, with a runner-level `ungated_db_access` refusal.
- **Process cleanup:** a zombie-held process group, cleaned up before the leader is reaped.
- **A1:** a fresh A1 at `plan`, `a2` and `release`; an advanced anchor gives `a1_anchor_advanced`.

**Still OPEN and blocking production (not claimed done):**
- **G-a.** `OPEN_GAPS = ['bytecodes-content-unverified']`. The native bytecode checker `bytecode-check/` is source only,
  unbuilt and untested here. A separate validation stage is in progress elsewhere and is not part of this publication.
  `release` refuses with `open_gaps`.
- **G-h.** The original-game A1 re-check is NOT integrated. Re-running the current A1 tool is not a path to `release`
  once the anchor has advanced.
- **No reth integration.** No real binary, datadir, unwind, merkle rebuild or bytecode check has run. The mock suite is
  not reth integration.
- **Not done:** no live action, deployment or commit by the worker. Root reviews and commits.

