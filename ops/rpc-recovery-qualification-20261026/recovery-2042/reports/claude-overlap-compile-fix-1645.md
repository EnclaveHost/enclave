# Extent overlap r2: one -Wformat compile fix (root 1644). Source only; nothing compiled or run - 2026-10-26

## Stage: `extent-recovery-stage/r2`, FROZEN
**`SHA256SUMS` = `aa194df45e01e7456263fc0379e898923c852ffbc03597b639087286116a2e82`** (files `a-w`).

| file | sha256 | vs r1 |
|---|---|---|
| `src/ext4-extent-overlap.c` | `1e03854048e215db4389987c90b3123deb81d113634984a433306069345c07c3` | **one cast** plus a header comment |
| `src/overlap.py` | `3fac4a394e95de9e460789121c2968d9374553f0c5da96f3a4dfec87ca69ea27` | byte-identical |
| `tests/test_overlap.py` (10 tests) | `ef51b81eb686c4b7f994f8144bab7205dff11d8b0e6804537fae065488095df7` | byte-identical (assertions unchanged) |
| `jobs/tests.sh` | `9a5b777e05ccc261b8b54aceef05c22869219590d7a8fbe2357e321cac4d7da3` | r2 paths; also checks r1 is frozen and the tests/wrapper are byte-identical to r1 |
| `README.md` | `eb9caa64633de17296d6d7efdbe482ac7bfa02a73a7181efbb3094f14bb7e6f3` | r2 note prepended |

**Unchanged:** r1 (`916a2df1…`, re-verified). `-Werror` is kept.

## The fix
- **The error** (1644, line 120): `PRIu64` is `%lu`, but the argument `lg + (set - ph)` mixes `blk64_t` (`unsigned long long`), so it was `unsigned long long`.
- **In r2:** `(uint64_t)(lg + ((uint64_t)set - ph))`. The value is unchanged: `ph ≤ set ≤ ph + blocks − 1` (validated), so there is no underflow.

**The other format arguments, audited:**
- the other `blk64_t` printed (`set`, in the overlap line and in the error message) was already `(uint64_t)`;
- `c`, `s`, `idx`, `lg`, `ph`, `cnt`, `uw`, `n`, `blocks`, `first`, `bstart`, `bend` and every summary counter are `uint64_t`;
- `ext2fs_free_blocks_count` is cast;
- `%u` takes `fs->blocksize` (unsigned int), `%d` takes `EXT2FS_CLUSTER_RATIO` (int) and `crosscheck` (int), and `%x`/`%u` take explicitly cast `s_state`/`s_error_count`;
- `%s` takes `dev`/`error_message()`/`argv`.

**No other change:** the read-only open, every refusal, the validation and the output bound are as in r1.

## Real NBD note (no weakening)
The original NBD is currently mounted read-only by a **fuse2fs** peer. `ext2fs_check_if_mounted` reads the mount table, so it will very likely report that device as mounted, and the tool will **refuse**. That is intended and r2 does not relax it: a mounted filesystem's bitmap view is not a stable snapshot. It is root's decision (not done or proposed here as an action) how to present an unmounted read-only view. I unmount nothing.

## Exact root job
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh extent-overlap-r2 512 unshare -Urn bash extent-recovery-stage/r2/jobs/tests.sh
```
**PASS requires all of:** `## compile OK` (`-O2 -Wall -Wextra -Werror`; the binary sha256 is printed), `## test_overlap PASS (10)`, no skips, and `## extent-overlap-r2 rc=0`.

**Not claimed:** compiling or passing. Other warnings that only the actual compiler reports are possible; this is a desk audit.
