# SHIELDED_PAD_PREPARE_THREADS

Default off. Prepares the mod-M pad-check vector `stM` on several threads by
splitting the **output column range** `[0,K)` into disjoint pieces.

`SHIELDED_PAD_PREPARE_THREADS` absent leaves `pad_check_prepare` exactly as it
was. Accepted values are canonical decimal `1`..`16`; `1` is also the serial
path. Anything else - including the empty string, `0`, `17`, `08`, signs and
trailing bytes - is rejected and fails registration, so a malformed value can
never quietly change the preparation policy or skip the check.

The effective count is `min(requested, online CPUs, 16, ceil(K/128))`, at least
1. An unknown CPU count (`sysconf` failure) means 1.

## Relationship to the other knobs

| Knob | Role | Changed here |
|---|---|---|
| `SHIELDED_PAD_CHECK` | whether preparation happens at all | no |
| `SHIELDED_PAD_PREPARE_TILED` | **which** kernel prepares `stM` (tiled int64 or `__int128` reference) | no |
| `SHIELDED_PAD_PREPARE_THREADS` | **how many** disjoint column ranges that kernel runs on | new |
| `SHIELDED_PAD_CHECK_TILED` | `dealt_import`'s per-cell online check | no |

`TILED` and `THREADS` are orthogonal; all four combinations are legal and must
produce identical `stM`.

## Why the split is safe

Each worker writes only `stM[k]` for `k` in its own range and reads `W` (with
the original row stride `K`) and `sM` read-only. There is no shared accumulator,
so this partitions the *output*, not a sum: no partial buffers and no reduction
pass, unlike `fv_prepare_parallel`, which partitions rows.

Results are unchanged for two independent reasons. Split points snap down to
whole 128-column tiles, so each worker's tile sequence is a contiguous
sub-sequence of the serial one. And separately, the row chunking (`j0`,
`ROWS = 32768`) does not depend on where a column tile starts, so a column's
reduction sequence is invariant under any partition.

Accumulator bounds are unchanged because neither the chunk size nor the
reduction order changed: per row chunk the tiled kernel stays within
`32768 * 128 * 2^31 = 2^53`, and the combine step stays under `3M < 2^26`.

## Failure behaviour

* `pthread_create` fails for one range: that range runs inline at the point of
  failure. Its columns belong to no other job, so it cannot race a worker, and
  no second serial pass is written over live workers.
* `pthread_join` fails: impossible for a private, joinable, singly joined thread,
  and there is no safe way to return - `sh_link_add_weight`'s error path frees
  the node's check buffers immediately and the caller may then release `W`. The
  process fails closed with `abort()`.
* No allocation is performed, so there is no allocation-failure path.

## Testing

`test/shielded-pad-parallel.test.mjs` builds `test/fixtures/shielded-pad-parallel.c`
plain and with ASan/UBSan. The fixture compares every dispatch against an
independent `__int128` reference, asserts the thread bookkeeping (so an
always-serial implementation fails even when its output matches), and requires
the injected join failure to raise `SIGABRT`.

No performance claim is made here. Whether this reduces registration time is a
measurement, not a property of this document.
