`--ei bridgebatch 65536` with `--ez nativebridge true` batches only Shielded
responses traveling from worker TCP to the protected VM. Default `0` keeps the
existing opaque byte pump. The app reports the selected value.

The native bridge reads the public nine-byte response header, then waits for up
to 64 KiB of the current frame before forwarding. It flushes the final frame tail
as soon as those bytes arrive, even while the peer remains connected. Small
frames flush when complete. The existing circular buffer is reused; no allocation
is sized from a peer length. A body over the existing 256 MiB protocol limit is
rejected. EOF forwards a truncated header/body so the guest sees the original
short-stream failure. Cancellation abandons pending bytes as before.

Incomplete batches do not subscribe to writable-socket polling, which avoids a
busy loop. Reads retain the same backpressure and no-progress deadline. The
request direction, buffer capacities, descriptor ownership, verification,
masking, and wire bytes are unchanged. The optional 4 KiB send cap is independent.
This mode expects Shielded framing; the older four-byte bridgebench protocol is
not compatible with it.

The candidate targets measured 4–6 KiB median VM sends during actual 27B inference.
Its performance is unmeasured until a full comparison completes. Large batches
may increase contiguous-allocation cost or reduce overlap, so both throughput
and the captured kernel/transport costs must be checked before retaining it.

Host ASan/UBSan tests cover fragmented frames, wraparound and partial writes,
zero/small/large frames, batch thresholds and immediate tails without EOF,
truncated headers/bodies, oversized lengths, cancellation and idle timeout while
waiting for a batch, unchanged default forwarding, and restored descriptor flags.
