# Receive-operation diagnostic

`SHIELDED_RECV_PROFILE=1` adds deferred operation timing to FIELD reply reads.
It requires `SHIELDED_PROFILE=1` to select FIELD spans. Use it alongside
`SHIELDED_WIRE_PROFILE=1` and `SHIELDED_WIRE_SCHED=1` to join records to source
and caller scheduling measurements. The production default is off.

The profiler distinguishes `getsockopt`, low-water `setsockopt`, `poll`,
`recv`, restoration `setsockopt`, and legacy `read`. Each read records call
counts, returned bytes, errors, EINTR/EAGAIN, elapsed and caller CPU clocks,
and the longest individual operation. All records contain counters and public
frame metadata only; no payload bytes are logged. It preserves errno and the
existing read, retry, EOF, error, and close-on-failed-restoration behavior.

Records are bounded to 8192 header/body reads and published atomically to the
existing deferred wire-timing dump. Overflow and clock failures are explicit
and must invalidate the diagnostic. These records do not replace output,
verification, pad lifecycle, worker identity, or whole-stream checks.

`RP_READ` fields after the prefix are kind, thread, call, requested bytes,
receive cap, function result, final errno, clock errors, cumulative CPU-over-wall
boundary discrepancy, and the bitwise union of observed poll flags.

`RP_OP` fields are kind, thread, call, operation, count, elapsed ns, CPU ns,
peak elapsed ns, CPU ns at that peak, peak start monotonic ns, maximum CPU ns,
returned bytes, errors, EINTR, EAGAIN, and zero returns. `RP_COUNT` reports
recorded, dumped, and dropped read records. A zero errno is not required after
a successful operation; errno may retain an earlier retry value.

Timing includes clock-boundary overhead and changes the measured execution.
Guest-accounted thread CPU is not a direct physical-core measurement. Peak CPU
and peak elapsed may describe different operation occurrences. Syscall counts
are not transport-packet counts. Elapsed time inside a syscall does not identify
the responsible kernel function without further evidence.

The actual-wire sanitizer fixture checks profiling off/on through fragmented
replies, tail handling, EINTR/EAGAIN, EOF and socket-option failures. Its capture
mode verifies that known injected retries and exact byte counts are recorded.
