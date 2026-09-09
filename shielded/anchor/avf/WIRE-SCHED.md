`SHIELDED_WIRE_SCHED=1` adds bounded scheduling-counter records around each
profiled FIELD request write, reply-header read, and reply-body read. It requires
`SHIELDED_PROFILE=1`; it does not enable the general source sampler. Default off.
The payload accepts the flag through `shenv`.

`WS` rows contain tag, TID, call ordinal, phase start/wall/CPU nanoseconds,
runqueue-wait delta, the two observer wall durations, voluntary/involuntary
context-switch deltas, and scheduler/usage errors. `WS_COUNT` reports retained,
dumped and dropped rows. Records contain no payload data and are exported through
the existing serial timing snapshot. Capacity is 16,384 rows. An incomplete trace
or nonzero counter error must not be interpreted as zero cost.

The phase interval excludes its own counter collection. Counter snapshots bracket
that interval, so runqueue attribution has uncertainty bounded by the combined
observer wall durations. `getrusage` switch counts and schedstat delay are distinct
measurements; a voluntary switch is not proof of a particular I/O operation.
Wall minus caller CPU includes scheduling and blocking. A bounded scheduling
estimate can narrow the remainder, but does not identify a guest-kernel function.
Other profiler work and interference can still perturb inference.

The protected Pixel capability probe established readable, increasing per-thread
schedstat counters and working RUSAGE_THREAD. The schedstats sysctl is unreadable
and tracefs is absent in that payload domain. No permissions or kernel settings
are changed. Check capability again on another platform; a readable zero counter
alone is not proof that scheduling delay collection is active.

Semantics: https://www.kernel.org/doc/html/v6.12/scheduler/sched-stats.html
The focused fixture uses real socket exchanges with delayed, fragmented replies,
checks phase/call identity and blocking switches, strict counter parsing, default
off, idempotent export, and explicit trace overflow under ASan/UBSan.
