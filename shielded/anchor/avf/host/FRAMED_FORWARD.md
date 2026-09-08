# Framed forwarding diagnostics

`framed-forward.py` is a separate, opt-in diagnostic proxy. No existing forwarder
is replaced and no worker is restarted. Its listener and target must be supplied
explicitly. `--port 0 --one-connection` is for owned loopback fixtures.

The observer parses the actual 9-byte protocol header across arbitrary TCP
chunks. It counts requests and replies separately, preserving pipelined request
order. For FIELD_GEMM/24 it also records the row count, node IDs and derived K.
It retains at most 9 header bytes and 264 bytes of public request metadata;
operands, products and error payloads are never retained in parser state or
written to the log. The forwarding buffer is bounded to 64 KiB reads.

The diagnostic enforces 256 MiB per frame, 200,000 frames per direction per
connection, four concurrent/32 total connections, 64 MiB per log and
explicit read/write, frame receive and overall deadlines. Exceeding a connection
limit stops the listener and fails the capture. Partial frames, mismatched
request/reply totals, deadline expiry and log failures make the capture fail.
All connections and both pumps are closed before finalization. Output paths
must be new; the completion sidecar binds the exact JSONL byte count and SHA-256.

`frame_received` records first/header/complete observation times on THIS HOST's
monotonic clock. Multiple frames in one read can have the same timestamp.
`frames_forwarded` records completion of a stream-writer drain through a frame
ordinal. Neither event is a packet delivery timestamp or proof of consumption
by the peer. Clock reads, JSON serialization and file writes add overhead, so
these legs are diagnostic. They cannot establish an uninstrumented speed gain.

`framed-window.py TRACE --connection C --first-field F --last-field L` verifies
the complete trace and pairs request/reply ordinals. It selects the host window
from the first byte observed for request F through the final byte observed for
reply L. F and L count FIELD_GEMM/24 exchanges only and MUST be reconciled with
engine counters and connection topology. Never assume that model group count
alone identifies the range, or combine counters from different connections.

Its `start` and `end` can be passed to `gpu-util-window.py --clock recv_mono`
when both tools ran on this same GPU host. Name the result a **worker-exchange
observation window**. It excludes phone work before the first request and after
the final reply, and does not solve the separate VM-to-host clock alignment.
The request-complete to reply-first interval includes forwarding, worker
scheduling and compute; it is not GPU kernel duration.

A future real-model run also needs a record of the target worker's binary,
process, GPU UUID and configuration, plus the APK/model/calibration and engine
counter snapshots. A target TCP port by itself does not establish GPU identity.
