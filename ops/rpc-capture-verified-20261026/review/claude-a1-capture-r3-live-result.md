# A1 capture binding r3, after root's live retry: result (PREPARED; source only; nothing run)

**Fresh A1 qualification is NOT achieved.** Root's live capture ran (A1 exit 0), but its full verification **failed**. Nothing here re-runs or re-labels it, and no new live pass is claimed.

**What Claude did:** read root's live outputs (file sizes and safe summaries only; no credentials), wrote files, and ran static checks (Python `ast.parse`, `node --check`, `bash -n`, sha256). No tests, builds, queue jobs, network or SSH access, live actions or source commits.

**Frozen and unaltered:**
- r1 (`0a5c0bd1…`) and r2 (`100eb666…`), both of which still verify;
- the finished live capture `outputs/rpc-production-final-20261025/a1-capture-live-0252` (read only);
- the accepted runtime pins: node `7af789e5…`, python `375532f8…`, libpython `0a5be42f…`.

**HOLD flags** stay False. No malicious-root resistance is claimed.

## Root's live retry (`a1-capture-live-0252/root-result.json`, 538 B)

| Field | Value |
|---|---|
| `startedAt` / `finishedAt` | 2026-10-26T02:52:55Z / 02:54:20Z |
| `sourceSha256` | `2352df7b…` (r2 `a1_capture.py`) |
| `captureOk` | `true` |
| `error` | `Refused: input: …/initial/capture/capture.json exceeds 1048576 bytes` |
| `localIdentity` | "user namespace root mapped to existing operator user; not host-root or attested identity" |

**The real initial capture** (`…/initial/capture`, its result record):
- `a1Exit` 0, `processStopped` true, `copiesBeforeExec` and `copiesAfterRun` true;
- capture id `f9e9cb02…`, `captureSha256` `31e72ac7…`, evidence sha `6174f380…`.

These are records only; the capture is **unverified**.

## Cause (traced)

- **The record is 4 MB.** `capture.json` is **4,125,348 B** because it binds **11,880 files**: 4 modules, the launcher, the node binary, 7 inputs and records, and **11,866 dependency files** of the pinned `@noble/hashes` + `viem` closure. Each entry (sha256, size, role, source) takes 167–442 B of JSON (median 344); paths are ≤ 113 chars and sources ≤ 188.
- **Capture and verify disagreed.** r2's capture wrote that record with no bound, while r2's verifier read it with the generic 1 MiB input cap. Other loaders used the same generic cap or a blanket 512 MiB `CAP_BIN`.

**Other observed sizes:**

| File | Size (B) |
|---|---|
| node | 56,530,480 |
| largest dependency file | 881,554 |
| package-lock | 99,531 |
| `result.json` | 1,589 |
| `evidence.json` | 3,950 |
| root's earlier recheck | 3,765 |
| `a1.stderr` | 0 |
| `helios.out` | 1,161 |
| inputs | ≤ 10,238 |

## r3 (`a1-capture-binding-stage/r3/`, `SHA256SUMS` sha256 `2b8d4ffe3c1736d0c1fed4a01967030e568bba05f4f22e00891a2a43cd556ac2`, 24 files)

| File | sha256 |
|---|---|
| `src/a1_capture.py` | `663038c89c9f3767eb441082700c0a08bc8aea7e48643b32c80bddff64c2a3ad` |
| `tests/test_a1_capture.py` (exactly 45) | `378ece719dc4c811c12db0d3d16ac0b81033785e31c5a3e048b133556d9a73a9` |
| `jobs/root-capture-tests.sh` | `b53f5ed5cb289ed661c4a5edb516edbc8d9d8fccac2f285360d59a0ac584279c` |
| `tests/stubs/initial/a1-read.mjs` (adds an optional pad for the oversized-evidence test) | `1735af92e311a20d9e1035d533896267303bd27c467947e96d923b2048de1bac` |
| `R3-CHANGES.md` | `73d5b2b33ad0b9dbac1d571803c07a70a4cc32c5c5e5274fa657688255435d0f` |

**Explicit limits, identical at capture and verify; none unlimited.** Every reader stops at its bound plus one byte.

| Limit | Value | Observed |
|---|---|---|
| `MAX_FILES` | 16,384 | 11,880 |
| `MAX_REL` / `MAX_SOURCE` / `MAX_ENTRY` | 192 / 384 / 768 | 113 / 188 / 442 |
| `CAP_CAPTURE` | 65,536 + MAX_FILES × MAX_ENTRY = **12,648,448 B** (about 3.1× observed) | 4,125,348 |
| `CAP_RESULT` | 256 KiB | 1,589 |
| `CAP_EVIDENCE` | 1 MiB (= the harness `A1_FILE_CAP`) | 3,950 / 3,765 |
| `CAP_LOG` | 16 MiB | 0 / 1,161 |
| `CAP_DEP_FILE` | 4 MiB | 881,554 |
| `CAP_LOCK` | 2 MiB | 99,531 |
| `CAP_NODE` | 128 MiB, also enforced while hashing the fd before exec | 56,530,480 |
| `CAP_RUNTIME` | 64 MiB | python 14,424 / libpython 6,344,456 |
| other bound roles | 1 MiB | ≤ 10,238 |

**How the limits are applied:**
- **One table check:** `check_files()` checks count, known role, per-role size, path, source and entry length. It runs at capture **before anything executes**, and again at verify.
- **Capture refuses unreadable records:** it refuses a `capture.json` above `CAP_CAPTURE`, so it can no longer produce a record its own verifier cannot read.
- **Oversized output never verifies:** oversized child output (evidence, logs) is published with the error. An oversized `result.json` is reduced, with an error.
- **Everything else is unchanged:** the record format (`v2`, so r3 can verify the real r2 capture in place), the code, dependency and runtime pins, file, process, receipt, authentication and freshness gates, and the `recheck-capture` consumer binding.

**Tests (45 = r2's 36 unchanged + 9 new; prepared, NOT run):**
1. Every limit covers the observed real values and stays narrow (< 8× observed for the primary caps).
2. The exact read boundary at `CAP_CAPTURE`, and refusal one byte above.
3. A generated production-shape table (11,880 entries at the observed lengths; more than 1 MiB of JSON; nothing committed) passes. Each violation refuses.
4. An end-to-end capture and verify with a **generated 12,000-file dependency package**. Its `capture.json` is above 1 MiB, which r2 would have refused.
5. Oversized child evidence never verifies.
6. An oversized `capture.json` is refused at verify.
7. A re-bound record whose table breaks the limits is refused.
8. Capture refuses an unreadable table before anything executes.
9. **The real live record** (read only): 4,125,348 B and 11,880 files. It fits r3, r2's generic cap refuses it, and its format is unchanged.

## Root command (local, offline, exact)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/a1-capture-binding-stage/r3
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-capture-tests.guard -- unshare -rn bash $ST/jobs/root-capture-tests.sh > $ST/logs/root-capture-tests.out 2>&1; echo $? > $ST/logs/root-capture-tests.rc
```

- **PASS requires all of:**
  - `SHA256SUMS` verifies before and after;
  - no network route;
  - exactly `Ran 45 tests` + final `OK`, no skips, rc 0;
  - the three HOLD flags False;
  - `## capture rc=0`.
- **The runner** passes `A1_LIVE_CAPTURE=…/a1-capture-live-0252/initial`, read only.
- **Anything else fails.** Queue exit 98 means the job did not start.

## Limits and next steps

1. **Unrun.** The new end-to-end test copies and fsyncs about 12,000 files per capture, so it is slower. Its time has not been measured.
2. **Verify the existing live capture.** After a pass, root can run r3's `verify` on the existing live capture in place, without a new capture. Only that root step could establish whether the captured receipt verifies. It is **not** claimed here.
3. **Unchanged trust model:**
   - root and the host are trusted to run this honestly;
   - the runtime policy covers executable images only;
   - configs and the checkpoint are bound, not reviewed constants;
   - the dependency digests are observations of the installed tree.
4. **Not integrated.** No consumer uses this yet, and R-A remains blocked on 8505's and root's changes. No fresh newer A1 qualification exists.
