# Worker exchange diagnostics

Compile `worker.cu` with `-DSH_XPROF` to enable the existing opt-in diagnostic
build. The normal worker has no phase profiler or added clock reads. Deploying
a diagnostic binary requires a separate, coordinated worker run; building it
does not instrument a running worker.

Each connection owns its own clocks and counters. Closing a different connection
cannot reset them. Connection-close lines report sample count, cumulative host
microseconds, and the maximum observed host interval for these phases:

- `lock_wait`: waiting to acquire the shared GPU mutex.
- `staging`: ensuring input/output buffers have sufficient capacity.
- `graph_lookup_capture`: constructing the cache key and looking it up, including
  capture/instantiation and any capacity eviction on a miss.
- `graph_launch_call`: the host CUDA graph-launch call.
- `stream_sync`: waiting for that stream to finish.
- `host_pack`: CPU packing when selected; otherwise the branch/marker overhead.
- `tcp_reply_write`: writing the response header and body to the socket.

These are **host elapsed intervals, not CUDA kernel durations or GPU utilization**.
The separate graph-cache `capture` total is contained in `graph_lookup_capture`;
those two values must not be added together.
Stream synchronization includes device work still pending, driver overhead and
host scheduling. Socket write completion does not prove the phone has consumed
the reply. Header/body input reads, request parsing and time waiting for the next
request are outside this breakdown. Ring exchanges contribute compute phases
but do not contribute TCP reply samples. Legacy `RECOMPUTE` is not phase-profiled.

Only a phase that reaches its end marker contributes a sample. A failed exchange
or write can therefore leave different sample counts across phases. Never divide
all totals by a common exchange count. `invalid_intervals` must be zero; any
nonzero value makes the profile unsuitable for attribution.

This build adds clock/aggregation overhead. Label its timings as diagnostic and
measure any throughput claim on a matched build without `SH_XPROF`. For actual
device execution time, use a separate CUDA activity trace; driver utilization
samples and these host intervals do not substitute for one.

## Kernel and exchange benchmarks (diagnostic build only)

The same `-DSH_XPROF` build carries three standalone modes; none is compiled
into the shipped worker. Each sets the device's real SM count itself, since it
returns during argument parsing, before `main` reads it.

- `--kbench27`: the 27B's decode exchanges as ONE card of a two-card column
  split sees them (each node's N halved to a 32-column boundary), Y in mapped
  host memory, clocks warmed before timing, the planner's G against forced
  G=1/2/4/8, and a per-pass total. `KB_ROT_MB` sets how much weight memory is
  rotated (default 256; the real pass walks ~12.8 GB per card); `KB_GAP_US`
  launches one kernel at a time with that much idle time between.
- `--kbench-x`: one exchange end to end as the worker runs it (host graph
  launch to stream sync, the card idle `KB_GAP_US`, default 130, between
  exchanges), the current copy-engine upload against an SM pull kernel, with a
  byte-identity check of the two outputs. `KB_GRAPHS` rotates that many
  distinct graph executables.
- Ring-served exchanges now record `WORKER_SP` rows like socket exchanges;
  `at` is when the ring thread noticed the request.

A kernel timing taken first after an idle gap reads up to 20% slow: the clock
ramp. Warm before timing, and time a reference twice.
