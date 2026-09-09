# Direct pad write experiment

`--ei pads_direct 1 --ei pads_direct_fill 1` gathers short HTTP reads before each
VM-bound body write. The buffer is 1 MiB, or 4096 bytes when the existing
`padwrite` cap is selected. The last write contains only the declared remainder.
Both options default to zero; cached downloads and cached VM copies are unchanged.
The app records `PADS direct fill: enabled=1` for capture verification.

The existing path writes every HTTP read immediately. Short reads therefore
produce many VM writes even with a 1 MiB allocated buffer. With 8 KiB fragments,
the experiment makes one write per MiB instead of 128. This is a write-count
reduction, not a demonstrated inference throughput gain. An HTTP delay can now
delay a gathered write; existing HTTP/receiver timeouts and fallback still apply.

Only a complete declared body is forwarded, followed by the existing EOF check;
extra bytes fail without being forwarded. A truncated final buffer is discarded.
Session cancellation is checked between reads and before emitting each gathered
buffer. Tracked descriptor closure still interrupts blocked I/O. Neither outcome
accepts a shipment: only the existing K/H receiver acknowledgments do. VM receipt,
verification, fsync/publication, signed acknowledgment, and one-attempt cached
fallback are unchanged.

Validation: fragmented and zero-length reads, final tails, both write caps,
default behavior, cached-copy isolation, truncated/oversized input, cancellation,
and the real loopback receiver acknowledgment fixture under both settings.
Phone comparisons must retain model, workload, APK, pad chunk, initial stock, and
instrumentation identities and include live refill and complete cleanup within
the 600-second test budget. A short run with stock ahead is not a sustainable
pad-supply measurement.
