# Paired VSOCK receive credit experiment

Default off. Set `ANCHOR_BENCH_RCVBUF=off-on` or `on-off`,
`SHIELDED_RCVBUF=4194304`, `SHIELDED_RCVLOWAT=131072` and
`ANCHOR_BENCH_TRIALS=2`. Other paired experiments, idle parking and reply
spinning must be disabled. The engine requires an original 262144-byte window.

Both trials use the same 131072-byte receive wake threshold. Only the enabled
trial grows the receive credit window to 4 MiB. Registration, prefill, prompt
observation, snapshot and restore use original options. Selection occurs before
the decode timer; low-water is disabled and original size/max restored after it.
Early exits also attempt restoration; an uncertain socket mutation closes the
pipe. The backend serializes changes with graph execution and requires one card.
Every trial consumes fresh pads; prompt restoration does not restore pad state.

The setter saves size/max, raises max before size, checks both readbacks, and
restores size before max. It refuses non-VSOCK sockets, rings, active low-water,
spinning, shrinking, repeated enablement and sizes over 8 MiB. The engine exposes
only the fixed 4 MiB diagnostic. No wire framing, verification or packet buffer
size changes. A larger credit window is not a larger kernel packet allocation.

Motivation: four completed 27B trials had 29,133 guest-send EAGAIN attempts,
all on replies larger than 256 KiB and after at least that many bytes had been
sent. EAGAIN-to-progress windows totaled 0.67–1.34 seconds per 16-token trial;
they include scheduling and other bridge work and are not pure credit waits.
Compare exact text/work, window readbacks, EAGAIN episodes, receive wall/CPU and
whole decode throughput. Use both orders; the existing short trials vary widely.

Host sanitizer tests use mocked VSOCK options with the actual wire setter to
check admission, ABI sizes, option order, restoration and partial failures.
Only a phone run establishes actual kernel acceptance and inference performance.
