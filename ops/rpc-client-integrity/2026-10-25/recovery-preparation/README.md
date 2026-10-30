# M7 recovery: shared test queue 1792 MiB extension (candidate, NOT installed)

> **Current status (2026-10-25, after root's runs):**
> - **Installed:** root INSTALLED this candidate queue. The live `work/claude-test-queue.py` == `b7de4344154fdd9f…`; see
>   `root-installed.sha256`. Its tests: 8/8 pass, and the negative control fails 5 of 6 as expected (below).
> - **Superseded:** `control-rerun.sh` is SUPERSEDED and was NOT EXECUTED. It expected four control failures; the
>   correct number is five. It has been moved to `superseded-not-executed/` with a NOTE.
> - **M7 result:** the M7 negative control was instead run with `../m7-control-recovery/test-offline-r3.sh`: full PASS,
>   rc 0. The text below is kept as the history of this preparation.

## Why

In root's M7 `test-offline` run:
- the `base-consensus-cli` test **link** was stopped by the 1536 MiB guard: exit 99, tree RSS 1565 MiB, made up of rust-lld 952 + rustc 316 + cargo 287 (root log `finality-stage/client-integrity-next/logs/root-test-offline-1.out` (not published));
- the negative control never ran;
- the providers filter `chain_provider::` passed 14/14. **That filter also matches pre-existing tests:** it is 7 new M7 provider tests, 1 pre-existing `chain_provider` test (`test_from_alloy_chain_provider_error`) and 6 pre-existing `l2_chain_provider` tests, not 14 new cases. The CLI filter `l1::` has 1 new test among 5.

A retry at 1792 was refused by argparse (root log `root-test-offline-1792.out` (not published)).

## Change (`queue-1792.patch`)

**Hashes:** original `456aa7ced332b08b82a3f740abe072d33fb8cddaba2f59c74694a503b98ae586`; candidate `b7de4344154fdd9f4e000059cc0d130426e67d5a34474cc714407c2f7e656c00`.

One constant, `MAX_LARGE_MIB = 1792`, is used for:
- the `--mib` choices (1792 is added; 256–1536 are unchanged);
- the reservation a small job makes when it joins an occupied large lane (was 1536);
- the threshold at which a large job yields to a reserved small job (`floor + MAX + 256 + 256`, was `+1536`).

**Unchanged:**
- 16 GiB floor and 256 MiB headroom;
- the full small-lane reservation by a large job;
- the cgroup `MemoryMax=<cap>M` and `MemorySwapMax=0`;
- guard arguments, signal cleanup, locks and file names, and the 60 s deadline / exit-98 semantics.

**Deliberate stricter effect:** while a small job holds its lane, any large job (including 1536) now yields until `MemAvailable ≥ 18688` (was 18432). The small job's admission assumes a 1792 neighbour.

## Tests (shared queue, 256 MiB): `logs/test-queue-1792.{out,guard,rc}`, rc 0

`run-tests.sh` runs `test_queue_1792.py`.

**Harness:** copies of the queue run in private `/tmp` directories with their own lock files. Exactly two substitutions are made, each asserted to occur once: the meminfo path becomes a fixture, and the 60 s deadline becomes 3 s. A fake `systemd-run` on PATH records the argv. Lanes are occupied by holding the real flocks.

**Candidate: 8/8 OK.**

| Case | Requirement | Result |
|---|---|---|
| 1792 choice | accepted; 2048 → rc 2 | ok |
| 1792 alone | `available=18431` → rc 98 with `required=18432`; 18432 → START | ok |
| Child limits at 1792 | `MemoryMax=1792M`, `MemorySwapMax=0`, `--max-rss-mib 1792`, `--floor-available-mib 16384` | ok |
| Small joining an occupied large lane | 18687 → rc 98; 18688 → START with `concurrentLargeReserve=1792MiB` | ok |
| Existing small→large at 1792 | 18687 → `yielding to reserved small allocation`; 18688 → START with `concurrentSmall=256MiB` | ok |
| 1536 with a small job running | yields at 18432 (stricter); starts at 18688 with `required=18432` | ok |
| Small alone | unchanged: 16895 → rc 98, 16896 → START | ok |
| Original baseline | refuses 1792; reserves only 1536 | ok |

**Negative control:** the same Candidate1792 tests against the **original** queue: 5/6 FAIL, as expected. Only `small_alone_unchanged` passes, which is correct.

`logs/test-queue-1792.try1-warnings.*` is an earlier valid 8/8 run with harness ResourceWarnings; it was superseded after the harness file handles were fixed.

**Not tested:** a real `systemd-run` scope or guard at 1792 (the fakes stand in), and the real M7 link. Those need root's install and rerun.

## Root install (atomic replace; jobs already running keep the old code in memory)

```
W=/home/steven/Documents/Codex/2026-10-18/wo/work
R=$W/rpc-production-final-20261025/finality-stage/client-integrity-next/queue-recovery
cd "$W"
echo "456aa7ced332b08b82a3f740abe072d33fb8cddaba2f59c74694a503b98ae586  claude-test-queue.py" | sha256sum -c -
echo "b7de4344154fdd9f4e000059cc0d130426e67d5a34474cc714407c2f7e656c00  $R/claude-test-queue.py" | sha256sum -c -
cp -p claude-test-queue.py claude-test-queue.py.bak-456aa7ce
install -m 0644 "$R/claude-test-queue.py" .claude-test-queue.py.new && mv -f .claude-test-queue.py.new claude-test-queue.py
sha256sum claude-test-queue.py            # expect b7de4344…
```

**Rollback:**
```
cd "$W" && install -m 0644 claude-test-queue.py.bak-456aa7ce .claude-test-queue.py.new && mv -f .claude-test-queue.py.new claude-test-queue.py
```

## Rerun of the unchanged, root-pinned test-offline (foreground; existing `build/` cache; no other large job)

```
WS=$W/rpc-production-final-20261025/finality-stage/client-integrity-next
python3 -c "import json,hashlib;p=json.load(open('$WS/root-queue/pins.json'));assert all(hashlib.sha256(open(k,'rb').read()).hexdigest()==v for k,v in p.items());print('pins ok')"
CARGO_BUILD_JOBS=1 python3 "$W/claude-test-queue.py" --mib 1792 --log "$WS/logs/root-test-offline-1792-2.guard" \
  -- unshare -rn bash "$WS/jobs/test-offline.sh" > "$WS/logs/root-test-offline-1792-2.out" 2>&1; echo $? > "$WS/logs/root-test-offline-1792-2.rc"
```

**Admission** needs `MemAvailable ≥ 18432 MiB`, or 18688 if a small job is running. rc 98 means not started, not a pass. Exit 99 means the guard stopped it again: report that honestly, do not raise the cap silently.

**Margin:** at `CARGO_BUILD_JOBS=1` the observed peak was 1565 MiB, leaving about 227 MiB of headroom under 1792. That margin is not guaranteed.

## Update: root's 1792 rerun (`root-test-offline-1792-r2`) and the INVALID negative control

Root installed the candidate queue before this report (live `work/claude-test-queue.py` = `b7de4344…`, mtime 12:05:59 -0700). I did not install it. Root then reran the unchanged pinned `test-offline.sh` at 1792 MiB. Peak 1528 MiB; overall **rc 1**.

| Part | Result |
|---|---|
| Patched providers | 14/14 ok (7 new M7 tests, 1 pre-existing chain_provider test, 6 L2 tests) |
| Patched cli `l1::` | 5/5 ok (1 new test) |
| **Negative control** | Passed 14/14 instead of failing, so the job printed "CONTROL DID NOT FAIL AS EXPECTED". |

**The control result is INVALID, not evidence that the tests are vacuous.**
- The control step shows **no `Compiling base-consensus-providers`** ("Finished … in 0.58s"). It ran the patched binary `build/target/debug/deps/base_consensus_providers-36019c953d96440f`.
- Both trees share one `CARGO_TARGET_DIR`. Cargo's unit hash for workspace path packages is workspace-relative, so `src/` and `src-control/` map to the same unit.
- The control source mtime (11:28:58, from `git apply`) is older than that binary (11:33:16), so cargo judged it fresh.
- The control source itself is correct: it has exactly two `if false && !self.trust_rpc {` lines.

This is a defect in my pinned `jobs/test-offline.sh` design. It stays unchanged because root froze it.

**`control-rerun.sh`: SUPERSEDED, NOT EXECUTED** (sha256 `1e22e897…`; now `superseded-not-executed/control-rerun.sh`,
mode 0644).
- **Why superseded:** it expected the control to fail *four* tests. Verified against the provider source, the correct
  number is *five*: `forged_header_cannot_vouch_for_forged_receipts` also fails, because the header fetch it relies on
  sits inside the disabled receipts check.
- **Its root command:** removed here, so it is not shipped as an active instruction.

**M7 status (updated):** the patched tests pass. The negative control was completed by
`../m7-control-recovery/test-offline-r3.sh`: five named failures, 9 passed, rc 0 overall.

## Publication note
The candidate queue is published as `claude-test-queue.candidate-1792.py`. The tests expect it under the name
`claude-test-queue.py` next to `original-claude-test-queue.py`, so they run from the private stage directory. The
original (sha `456aa7ce…`) is not copied here. Root's own run logs are not published here.
