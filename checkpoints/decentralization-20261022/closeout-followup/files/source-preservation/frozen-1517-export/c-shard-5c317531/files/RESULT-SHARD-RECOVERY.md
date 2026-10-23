# Shard recovery after storage-endpoint loss (RESULT-SHARD-RECOVERY, 2026-10-23)

**Status.** Local source, a recipe-built candidate, and fixture evidence only.
- Nothing was deployed, published, signed or activated.
- No SSH, production, host/VM restart, wallet, contract, catalog or active-indexer change.
- Root reviews; D publishes separately.
- Offline fixtures prove no production independence.

**Repository.** `work/resume-after-checkpoint-20261022/storage-shard-recovery`, branch `storage/shard-recovery`, author and
committer SteveDeFacto:

| commit | what |
|---|---|
| `5c9717fc747db9ae2125e74e000bc15eea7c091e` | baseline: the exact C2 candidate source (`storage-clone-privacy-review/candidate/sia-s3`, verified 115/115 against its `AFTER.sha256` `c218c9fd…`, kept as `BASELINE-AFTER.sha256`) |
| `ac84cbb057ccc97a880902722f23e6afb29bdfa9` | sia_storage unit-test harness + two TEST-ONLY call fixes (artifact unchanged, below) |
| `e99498e917c1d266c2f806c00992a3ff282808a0` | **the fix** (`sia_storage/src/download.rs`) and its regression tests. Patch `download-shard-topology.patch` (`git format-patch -1 e99498e`), sha256 `b59492600c8066f7f484a92978fec844e228c14a732594b644f42e42dbafb764` |
| `9eb65336aff6bf69d3678e1f645153c33d0a9a52` | the fence test correction (root's ROOT-FENCE-NEGATIVE-REVIEW; test only) |
| (the commit after it) | the C2 fixture driver, run evidence, the unit harness opt-level, this report |

## 1. Provenance of the C2 artifact 00e9cde0 (established, not guessed)

- `work/claude-storage-privacy-result.txt` §6 and §9 name the candidate:
  - tree `storage-clone-privacy-review/candidate/sia-s3`;
  - `AFTER.sha256` = `c218c9fd6858031f8f24cf9635c51907736d473917567f6f63389c52a822dbc5`, 115 files;
  - "candidate wasm32-wasip2 release: 00e9cde0…, 4555871 bytes, isolated target".
- The build receipt is `candidate/wasm-step.sh`: `cargo build --offline --release --target wasm32-wasip2`,
  `CARGO_BUILD_JOBS=1`, into `candidate/target`. Its output `candidate/target/wasm32-wasip2/release/sia-s3.wasm` is
  `00e9cde0…`.
- `storage-wasm-validation/EVIDENCE.sha256` pins the copy every later fixture used:
  `artifacts/candidate-00e9cde0.wasm` = 00e9cde0.
- The tree still verifies against `AFTER.sha256` (115/115). That manifest pins `vendor/sia-sdk-rs/sia_storage/src/download.rs`
  = `aa8b415a4849c637110a892883db71e410c3ca11f0477f3cbda55e16e24d03d9`: the panicking source.
- **Rebuilt here:**
  - with the local crates' wasm release outputs removed (`repro-step.sh`), the baseline tree rebuilt in a new
    directory to **byte-identical 00e9cde0** (run w2, queue EXIT 0, 1041 MiB);
  - with commit ac84cbb (test-only edits) it rebuilt to 00e9cde0 again (run w3).
- The same `download.rs` (sha256 `aa8b415a…`) is in every vendored sia-sdk-rs copy in the workspace.

## 2. The defect and the trigger (traced with evidence)

**Code** (`sia_storage/src/download.rs`, baseline line numbers):
- `SlabRecovery::new` numbers each sector with its slab position (`shard_index: i`, 174-183).
- Then `client.prioritize(&mut sectors, …)` (185) runs `items.retain(|item| host_info.contains_key(..))`
  (`hosts.rs:117`): every sector whose host the SDK does not currently know is DROPPED. This is intended (it fails early
  when hosts are gone).
- `recover_shards` then used `let mut shards = vec![None; self.state.sectors.len()]` (290): the REMAINING count. It stored
  `shards[task.shard_index] = …` (336) by the ORIGINAL index.
  - An index at or past the remaining count panics. A wasm panic traps: the whole sia-s3 component dies.
  - `decode` (415) also took `parity = shards.len() - min_shards`, so the erasure code had the wrong shape. With only
    trailing hosts missing it happened to decode correctly (test `trailing_hosts_unknown` passed on the old code).
- The SDK's host list is the indexer's USABLE list: `Hosts::refresh` → `replace(all_hosts)` (`hosts.rs:443-457`), and
  indexd's app `GET /hosts` = `usableHosts`. indexd's usability filter (`persist/postgres/hosts.go:75-91`) includes
  `recent_uptime >= 0.9`; its `blockhosts` maintenance (`contracts/manager.go:350-375`) blocks unusable hosts.
- So any host that leaves indexd's usable set shortens every slab it holds a shard of. **One** lost endpoint at shard
  index < 29 can make the read panic (index 29 ≥ 29).

**The observed r1 panic** (storage-write-release `rehearsal/runs/r1-failed`), traced:
- `harness/harness.log`, `00:59:36` (indexer r1 being stopped, `indexer-stopped` at 00:59:37):
  - "failed to unblock usable hosts after scanning: context canceled";
  - then three `contracts.blockhosts` "blocking unusable host" entries, usability `["Uptime"]`, for hosts
    `c68b79a1…`, `23312f36…`, `404fa860…`.
- After the restart (01:00:23), the redeployed 0.1.8 became ready at 01:00:25. Its first GET panicked at
  `download.rs:336:35` "index out of bounds: the len is 27 but the index is 28" (`S-v018-redeploy.log`).
- 27 = 30 − the 3 blocked hosts.
- **Limit of the trace:** "Uptime" means `recent_uptime < 0.9`. Fixture hosts start AT the 0.9 default, so one recorded
  failed scan suffices. A scan cancelled by the shutdown returns early without being recorded (`hosts/manager.go:771`).
  The log does not show which scan failure lowered these three; production hosts with long histories need many failures.
  indexd was NOT changed. The SDK defect does not depend on why a host became unusable.

## 3. The fix (`e99498e`, `download.rs` only in non-test code)

- `AwaitingRecovery.total_shards` = `slab.slab.sectors.len()`, read BEFORE `prioritize`.
- `recover_shards` sizes the shard vector by it, so every recovered shard sits at its original slab index and `decode`
  keeps the slab's real 10+20 shape.
- A recovered shard is stored only at an in-range index that is not already filled. Otherwise the recovery fails with
  `DownloadError::InvalidSlab`: no panic, no overwrite, no miscount.
- **Unchanged:**
  - sector reads and their proofs (`recover_shard`);
  - per-shard decryption (`encrypt_recovered_shards`, by index);
  - `ErasureCoder` reconstruction;
  - retries (`MAX_SECTOR_ATTEMPTS`) and racing;
  - `NotEnoughShards`;
  - the object layer and `min_shards` validation.
- Upload, fencing/CAS, keys and metadata code are untouched.
- `git diff 5c9717f e99498e -- …/download.rs`:
  - 25 non-test lines, 2 removed and 23 added, comments included (one struct field, one capture, one constructor field,
    the vector size, the guarded store);
  - the rest are tests.

**Candidate artifact** (recipe `wasm-step.sh`, unchanged from the candidate's; run w4, queue EXIT 0, 1021 MiB):
`candidate-55888a41.wasm` = **`55888a41033c5c913f64adc7dc601d314cbe387b377445a23e5475643bea7918`**, 4556225 bytes.
- Built from e99498e with the same Cargo.lock (`9ea317cf…`) and the same offline toolchain and target dir.
- Rebuilt from 9eb6533 (test-only change) to the identical 55888a41 (run w5, queue EXIT 0, 1017 MiB).
- Not deployed, not signed, not catalogued.

## 4. Tests (all through `work/claude-test-queue.py`)

**Unit, sia_storage's own tests on the vendored sources** (`unit-step.sh`). These tests had never compiled in this tree
before ac84cbb: two test calls predated the C2 `delete_object`/`pin_object` signature, and the mock feature was needed.

New `download::test::shard_topology` tests, each on a real 10+20 slab uploaded through the mock network, checked through
BOTH `SlabRecovery` and the public `Download` reader (sia-s3's GET path):

| test | fixed (e99498e) | baseline (negctl: 5c9717f download.rs + the same tests) |
|---|---|---|
| parity-only, non-contiguous: hosts of shards 0-2 unknown, 3-19 unreadable, so only 20-29 survive | exact bytes | **panic** `download.rs:336:35` len 27 index 27 |
| trailing hosts unknown (27-29), data shards 0-4 unreadable | exact bytes | exact bytes (the shortened code happens to agree) |
| ONE unknown host (shard 0) + out-of-order completion (1-19 slow) | exact bytes | **panic** len 29 index 29 |
| single-host loss at shard 0, 5, 9, 10, 19, 20, 28, 29 | exact bytes, every position | **panic** len 29 index 29 (via Download: `JoinError::Panic`) |
| insufficient: 15 unknown + 6 unreadable; then 21 unknown | `NotEnoughShards`, the reader returns an error; `NotEnoughShards(9,10)` at construction | **panic** len 15 index 21 |
| malformed: an index outside the slab; two tasks for one index | `InvalidSlab` ("outside", "twice") | **panic** len 10 index 30 |

Runs:
- **t1** (fixed): the whole `download::` module, existing + new, **19/19 ok**. Queue EXIT 0, 834 MiB, 843 s.
- **n1** (baseline): **1 passed, 5 failed**, every failure the 336:35 panic. Queue EXIT 101, the expected negative result.
- **t2, t3, t4:** the rest of the suite. Each ended with its guarded scope OOM-killed at the 1024 MiB cap. NOT counted.
  - Provenance (`evidence/scope-provenance.txt`, from the user journal): each scope's `Started` line carries that run's
    own `--log` path. t2 = `run-p3761232-i33077846.scope`, t3 = `run-p3881779-i33272160.scope`, t4 =
    `run-p3907775-i33312842.scope`, and each ends with "The kernel OOM killer killed some processes in this unit /
    Failed with result 'oom-kill'" at the run's end (05:40:49, 07:01:01, 07:15:42).
  - systemd then stopped the scope, so the queue printed `[queue] EXIT -15` (the systemd-run child's status).
  - Nothing outside these jobs terminated them; an earlier note here saying so was wrong.
  - Active computation, not a deadlock: t2 used 30.5 CPU-minutes over 15.9 wall-minutes, about two busy cores, at
    opt-level 0. At opt-level 2 t4 reached the OOM in under 3 minutes.
  - The test is `upload::tests::test_overwrite_object`: base upload, overwrite upload and download of multi-slab
    objects in the in-memory mock.
- **t5** (the whole suite, `download::` included, except that one test; opt-level 2 as sia-s3's test profile builds the
  SDK; debug assertions and overflow checks on): **173 passed, 1 failed** (the fence test below, before its correction),
  38 s. Queue EXIT 101, 721 MiB.
- **t6** (`upload::tests::test_overwrite_object` alone, 1536 lane, fixed tree): **ok** in 6.66 s, queue EXIT 0, peak
  1089 MiB.
- **ob** (the same test on the BASELINE negctl tree): **ok** in 6.55 s, peak 1061 MiB. Its need for more than 1024 MiB
  predates the fix; the fix does not touch upload/overwrite, and the shard vector has the same length when every host
  is known.
- **The fence test:** `fence::tests::tokens_order_by_generation_counter_iid_and_parse_strictly` failed identically on
  both trees (run fb, "uppercase is not canonical", `fence.rs:309`).
  - Root's review (ROOT-FENCE-NEGATIVE-REVIEW) was right, and my first note blaming `hex::decode` was wrong.
    `strict_hex` already refuses anything but lowercase hex. The TEST's token `a` (generation 16<<48, counter 5, iid
    0x09…) has an all-decimal hex form, so `to_uppercase()` returned the same string, which parses.
  - Corrected, test only, in the next commit:
    - `a`'s lowercase round trip is kept;
    - `b` (iid 0x0a…) round-trips;
    - its uppercase form is asserted to DIFFER, then refused.
  - The parser is unchanged. Focused rerun (run fo): **ok**.
- So the complete sia_storage unit suite on the fix is **175 of 175**: t5's 173, t6, and the corrected fence test (fo).

**sia-s3's own suite on the fixed tree** (`run-suite.sh`, the candidate's one-test-per-process runner; run s1):
**115 passed, 0 failed, 19 ignored**, the same as the candidate's recorded 115/19. Queue EXIT 0, 938 MiB.

**Actual C2 read/download** (`fixture/shardloss.sh` + `main_shardloss.py`, run **f3**: **18/18 PASS**, queue EXIT 0, peak
1183 MiB, 99 s, cleanup complete).

Setup (storage-write-release's interop16 helpers `_base.py` `bd92f094…`, read-only):
- the REAL indexd (c2-enclave source, harness-block c2e `cac66513…`), one indexer, on a private PostgreSQL 18;
- 30 loopback RHP4 hosts, the egress front, wasmtime;
- artifacts: old = 00e9cde0 (pinned copy, identical to the rebuild), fixed = 55888a41, legacy = the live 0.1.8 `d1ddecfe`;
- C2 config f6b48940, lease16.
- With 30 hosts every host holds one shard of every slab, so indexd cannot migrate a lost shard elsewhere.
- **Fixture-only mutation:** `recent_uptime = 0.01` for chosen hosts in the private indexer database (below the 0.9
  usability bound, so `/hosts` omits them).
- Every reader is a fresh instance.

| step | result |
|---|---|
| P: the live 0.1.8 writes a 3 MiB legacy object (unenrolled) | 200 |
| W: the fixed C2 enrols (CAS) and writes `one` (2 MiB) and `big` (44 MiB, two slabs); all three read exactly | PASS |
| S1: ONE storage endpoint lost (shard 0's host of `one`) | the old 00e9cde0 panicked in **3 of 3** fresh instances (len 29 index 29, recorded); the fixed C2 reads all three objects byte-exact, including ranged reads across the slab boundary, and listings are exact |
| D: 15 endpoints lost (`one` from parity shards 15-29 only; every slab 15/30) | old: **trap** at `download.rs:336` (len 15 index 19), GET gets 0 of 46137344 bytes, the process is dead (negative control). Fixed: all three byte-exact, stays up |
| I: 21 lost (9 of 30 left) | each GET signals failure: status 200 and Content-Length are already sent, then the body is 0 bytes, a short body, which is sia-s3's documented signal (`src/s3.rs`: "the head is already out"). C2 logs "not enough shards: 9/10", keeps running, `/healthz` ready |
| custody | fence generation, CAS enrolment, `seq_enabled`, `event_seq` and the object count are unchanged by the readers. The same-generation ballot counter rose by exactly 7 = the reader starts (C2 installs counter+1 at every start) |

Retired runs (kept, not counted):
- f1: setup only (the catalog path under this tree);
- f2: 16/18, two driver expectations. A short body was not compared with Content-Length, and the whole fence was
  compared instead of generation + counter rule. `fixture/runs/f2/RETIRED.txt`.

**Evidence files** (`evidence/`):
- the queue outputs `<run>.queue.out` of w2, w3, w4, t1, n1, fb, t5, t6, fo, ob, s1, f3;
- `scope-provenance.txt` (the t2-t6 scopes from the user journal);
- the cargo test logs `unit-n1-negctl.out`, `unit-t5.out`, `unit-fence-{fixed,baseline,corrected}.out`,
  `unit-overwrite-baseline.out`;
- `s1-suite-progress.txt`;
- `fixture-f3/`: results.json plus every component's log; the old artifact's panic lines are in `S1-old-*.log` and
  `D-old.log`.

Retired runs keep their `RETIRED.txt` and results under `fixture/runs/`.

## 5. Does this close one-storage-endpoint-loss read availability?

**For C2 with the candidate 55888a41: closed in source and in the fixture.**
- A slab stays readable through the loss of up to 20 of its 30 storage hosts.
- One lost endpoint (S1) and 15 lost endpoints (D) read byte-exact through the actual component on real indexd and RHP4
  hosts.
- Fewer than 10 survivors fail cleanly (I), and the component keeps serving.

**What it does NOT close:**
- **The deployed artifacts still have the defect.**
  - The live legacy 0.1.8 (`d1ddecfe`) traps on a read when ANY host holding a shard of that slab leaves indexd's usable
    set, unless it happens to be the slab's last host. This is the r1 panic.
  - 00e9cde0 (the C2 candidate in the release pins) has the same defect.
  - Only an artifact built from e99498e (or later) is fixed. The legacy rollback path (LEGACY_REDEPLOY_SAFE → 0.1.8)
    therefore still has it: a 0.1.8 rollback is not read-available under host loss.
- **Endpoint loss here means a storage HOST leaving indexd's usable set.** The SDK's read failures for an unreachable host
  (retries, `NotEnoughShards`) are existing behaviour covered by the existing tests. Indexer/replica endpoint loss (N = 1
  today) is a separate T2 matter.
- The indexd behaviour that blocked three hosts around a stop (fresh hosts at the 0.9 uptime threshold) was traced, not
  changed.

**Production drill that remains** (root; not run):
1. Review e99498e. Rebuild with the recipe and expect 55888a41. Replace 00e9cde0 in the C2 release pins.
2. Live read drill on the C2 deployment: read a known object, with root watching the deployment's logs. Then, at a time
   root chooses, take ONE host holding a shard of that object out of the usable set and read again. Expect byte-exact,
   no component restart. Mechanisms:
   - an admin host block (a production mutation that affects every account's data placement and triggers repair);
   - or an organic host loss observed in the live usable list.
3. Repeat after an indexd restart (r1's path): confirm blocked-host counts, and that reads succeed.

## 6. Limits

- Fixture backend:
  - loopback hosts, a fixture chain and contracts, mock online/explorer;
  - host loss simulated through indexd's usability state, not network death;
  - one indexer;
  - no live Sia host behaviour, no TEE, no WAN.
- The old artifact's S1 panic is probabilistic in principle: index 29 must finish among the first 10 completions. It was
  3 of 3 here. D makes it deterministic.
- `sia_storage`'s unit suite: 175/175 across t5, t6 and fo (focused, by root's direction; not one single run).
- `test_overwrite_object` needs the 1536 lane on both trees.
- t1/n1 ran at opt-level 0 and t5/t6 at opt-level 2. Optimization does not change what the tests assert.
- No change to fencing/CAS, keys, catalog or indexd. Legacy objects read exactly with the fix (P → S1/D).
