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

Both lines retain the `[shielded] profile` prefix accepted by the phone engine's
existing summary filter. Failed registrations keep their existing error
messages and do not emit a successful-registration timing line. Compare the
same model, calibration, placement and knobs before attributing a change.
