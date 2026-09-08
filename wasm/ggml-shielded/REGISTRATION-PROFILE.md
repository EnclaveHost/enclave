# Registration timings

Set `SHIELDED_PROFILE=1` to emit per-weight startup timings. With the variable
unset, these additional clocks and log lines are disabled. The existing profile
option treats any present value as enabled. Timings use a monotonic clock and
report elapsed milliseconds, including scheduling and I/O waits; they are not
CPU utilization or isolated disk throughput measurements.

The `profile registration <weight>` line divides successful registration into:

- `source`: private source allocation, read/copy and authentication. Its `read`
  and `auth` values are subsets of this total, not additional phases. `read`
  measures the source callback or memory copy; it need not represent physical
  storage traffic. Without a source verifier these subsets are zero.
- `encode`: encoded-row allocation and threaded quantization, then release of
  the private source buffer.
- `local_setup`: retained outlier columns, scales, bounds and link configuration.
- `cache`: authenticated encoded cache creation, including block hashing,
  writes and synchronization; zero-cost paths still include branch overhead.
- `link`: entry publication and the link's verification setup.
- `commit`: reader installation, encoded-buffer release and group bookkeeping.

The six outer phases sum to `total` before rounding. The nested
`profile registration checks <weight>` line breaks down link setup into weight
range scanning/allocation, Freivalds setup (`fv`), dealt-pad verification setup
(`pad`), optional public cache identity hashing, and final node publication.
These nested timings are already included in `link`; do not add them again.

These lines are written to engine stderr. The phone engine's current summary
filter forwards selected exchange summaries, not every registration line;
capture the full stderr or explicitly extend its filter to inspect registration.
Failed registrations keep their existing error messages and do not emit a
successful-registration timing line. Compare the same model, calibration,
placement and knobs before attributing a change.

## Socket exchange timings

The backend's `mask`, `wire`, `refill`, `lhs` and `rhs` phase totals belong to
the individual card's link. `sh_link_profile_snapshot` reads those cumulative
totals and completed-call/pad counters; a fresh link starts at zero and replacing
its socket preserves them. Serialize snapshots with operations on that link.
Different links own independent counters. Earlier builds used one global set
of phase totals and printed it for every card, so those historical multi-card
lines cannot establish per-card time.

These are host elapsed phases, not GPU kernel durations. `wire` subtracts RHS
verification performed while waiting for a reply; `rhs` counts that work once.
Failed exchanges can contribute elapsed phases and consume pads without adding
a completed call. This change adds no clock reads and changes no computation.

With `SHIELDED_PROFILE=1`, `wire phases` counts successful single-frame socket
FIELD_GEMM calls. Unlike some older profile checks, this collector treats an
unset, empty or `0` value as disabled. The counters are cumulative for the pipe;
subtract additive snapshots taken before and after an interval. A prefill
snapshot is not a per-round or steady-decode measurement. Successful shared
memory ring calls and failed socket exchanges are outside these counters.

`wire slowest` retains one bounded record of the longest successful profiled
socket call. It reports its call ordinal, command, public first-node id/name,
node count, row count and K, request/reply byte counts including frame headers,
and write/overlap/header/body durations. The four phases sum to `total` before
rounding. It reads only the request's public metadata; no activations, pads,
keys or products enter the record. `metadata=0` means the fixed request prefix
could not establish valid dimensions; `name=unknown` means the link could not
resolve a node name. A later faster call leaves the record unchanged.

The maximum is not additive: never subtract two peak records. Its ordinal is
among successful profiled calls on that pipe, not model nodes, tokens or MTP
rounds. Header wait includes remote compute and scheduling; body time includes
reply allocation. Neither is isolated network latency. These details localize
a slow call for the next experiment without establishing its ultimate cause.

`test/shielded-wire-peak.test.mjs` uses real socket framing and an injected
monotonic clock to distinguish header/body stalls, retain the earlier peak,
parse split metadata, and leave evidence unchanged on disabled/non-GEMM/failed
calls. The real-tee overlap fixture also checks bounded node-name resolution.
