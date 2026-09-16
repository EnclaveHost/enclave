# Pixel large-transfer diagnostic

The 256 KiB bridge test completed correctly, but four long pauses made its
performance result invalid. This is a transport diagnostic, not a model tok/s result.

| Request frame | Wait for request body | Request bytes still outstanding |
|---|---:|---:|
| 11 | 13.240 s | 4,112 |
| 35 | 11.347 s | 4,112 |
| 130 | 10.090 s | 4,112 |
| 160 | 16.841 s | 4,112 |

All 210 frames and 55,051,088 wire bytes in each direction passed. The VM exited
successfully. The instrumented test ran from 22:36:03 to 22:37:15 UTC on September 8,
2026, using the same version 6 APK as the preceding comparison.

Across 514 socket observations inside those pauses, the host receive and send
queues were empty; its advertised receive window stayed at 879,616 bytes.
The completed previous replies had been acknowledged. The observation intervals
cover the measured window, with no gap greater than 0.093 seconds.

Phone-wide counters increased by 26 retransmitted segments, 22 TCP timeouts and 18
lost retransmissions. Neither interface reported a new transmit/receive drop or
error. These aggregate counters support a retransmission hypothesis but do not
attribute it to this socket. The retained kernel window contained no USB/NCM event.
The repeated 4,112-byte remainder is a direct observation from this socket.

The direct TCP control completed at 22:46:03 UTC. It bypassed the VM and app
pump while sending the same 210 checked frames. Its median round trip was
3.971 ms, the marked frame window was 1.223 seconds, and its own socket's
retransmission count stayed at zero. Phone-wide timeout/retransmission counters
also stayed unchanged. All capture checks passed.

This comparison narrows the issue to forwarding or its traffic pattern, UID,
socket behavior and CPU placement. It does not rule out the USB driver bug:
different traffic can trigger the bug differently. One control run does not
establish a universal throughput ceiling or a model token rate.

The bounded ping intervention described below was then tested. It is intended
to flush stranded aggregates; it also changes interrupt and CPU activity, which
must be considered when interpreting a gain.

[Direct TCP control evidence](pixel-direct-tcp-control-evidence.json)

A strong source-level lead is a known NCM flush-timer bug: when no USB request
is available, pending data can be left buffered without another timer retry.
The source matching this phone's kernel has that path. Original upstream
[July proposal and independent test](https://patchew.org/linux/20260727165441.1969927-1-flavra@baylibre.com/)
and [August proposal](https://lists.openwall.net/linux-kernel/2026/08/17/1825)
describe the issue. The controlled interventions below support this mechanism, but do not prove
which kernel branch caused the stall. Neither source proves a fix is installed
on this phone.

[Joined evidence and source hashes](pixel-large-transfer-evidence.json)


First background-traffic intervention, 23:06 UTC
-----------------------------------------------

The same v6 native bridge completed all 210 frames with exact payloads and
no phase exceeding one second. Its marked transfer window was 6.900176 seconds;
the earlier instrumented native run took 57.949278 seconds. The median roundtrip
was 22.767 ms (previously 21.617 ms): ordinary latency did not improve.

The owned host ping stream used 1400-byte payloads every 5 ms. Its captured
liveness check brackets the entire frame window, with actual exit 0 and 4309
packets sent / 4308 received. Whole-phone retransmitted segments increased by 1,
with no TCP timeout or lost-retransmit increase. Host retransmissions were zero.
All measured interface error/drop deltas were zero.

This first leg added both ping traffic and a phone-side socket sampler, so it
cannot isolate the ping effect. The phone sampler was incomplete: it captured
96 uptime blocks but no matching IPv4-table socket, and was interrupted during
the final block. Missing rows are not evidence of zero queued bytes. The next
control captures both IPv4 and IPv6 socket tables; the Android Java socket path
can use IPv4-mapped IPv6 even for an IPv4 destination.

These are transport diagnostics, not model token-throughput measurements.
The ping intervention remains experimental; the subsequent controls follow.

Evidence: [independently joined capture](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/pixel-ping-intervention-evidence.json).

Matched controls completed through 23:17 UTC
--------------------------------------------

All rows below completed the same 210 checked frames, 55,051,088 bytes in each
direction, using the unchanged v6 native bridge. Times are the marked frame
window, excluding the deliberate START/END control waits.

| Leg | Ping interval / payload | Phone socket sampler | Frame window | Pauses over 1 s |
|---|---|---|---:|---:|
| Native baseline | Off | Off | 57.949 s | 4 |
| Ping 1 | 5 ms / 1400 B | IPv4 only, incomplete | 6.900 s | 0 |
| Off control | Off | IPv4 + IPv6 | 21.405 s | 1 |
| Ping 2 | 5 ms / 1400 B | IPv4 + IPv6 | 6.661 s | 0 |
| Slower candidate | 50 ms / 1400 B | IPv4 + IPv6 | 6.463 s | 0 |

The off control retained 2,808 bytes in the phone socket's transmit queue during
a 14.640-second host request-body wait. The missing host byte count matched
exactly. Fifty phone samples with conservative clock bounds lay wholly within
that wait; all retained the same queue length and a retransmission timer. This
is direct evidence of outstanding phone TCP data, beyond whole-phone counters.

Both later ping legs observed zero unrecovered RTO timeouts on the app socket.
The second ping leg's phone capture has an incomplete final block; its valid
interior rows can still be joined, but the full capture is labelled partial.
The slower candidate's phone capture is complete. The second ping leg also
had 182 whole-host retransmissions; absent socket-specific totals cannot assign
those events to this route or exclude it.

Ordinary median roundtrip latency stayed near 22–23 ms. The improvement removes
long pauses; it does not show faster cryptographic matrix operations. The next
actual 27B diagnostic uses the repeated 5 ms profile. The 50 ms profile has only
one completed observation, and neither profile guarantees a particular maximum
flush delay or sustained model token rate.

[Control evidence](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/pixel-transport-controls-evidence.json).
