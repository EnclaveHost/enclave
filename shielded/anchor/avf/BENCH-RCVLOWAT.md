# Paired VSOCK receive threshold experiment

Default off. Use `ANCHOR_BENCH_RCVLOWAT=off-on` (or `on-off`),
`SHIELDED_RCVLOWAT=131072` and `ANCHOR_BENCH_TRIALS=2` together.
Parking must be disabled and `SHIELDED_SPIN_US` unset or zero.
The cap is canonical decimal, 1..131072. A cap without an order is refused.

The engine leaves registration, prefill, prompt observation, snapshot and restore
unchanged, then selects the cap before each measured trial and clears it immediately
after the decode clock stops. Prompt-state restoration never restores spent pads.
The backend serializes selection against graph execution and requires one live
card/socket. It refuses non-VSOCK sockets, shared-memory rings, insufficient receive
buffers and unsupported option/readback. It never resizes a socket buffer.

`read_reply` sets `SO_RCVLOWAT=min(remaining,cap)` before each poll, then uses
`recv(MSG_DONTWAIT)`. A plain blocking read is not safe: the configured Android
kernel can consume an already queued prefix and then sleep with the original
socket mark while fewer bytes remain. Nonblocking receive returns partial reads
to the outer loop so it can lower the mark. The original option is restored on
success and failure; failure to restore closes and invalidates the descriptor.
EOF, violation, frame-size limits and verification remain enforced.

Configured Microdroid source evidence: Android kernel/common commit a95f39af1cac,
`net/vmw_vsock/af_vsock.c` vsock_data_ready and vsock_poll, and
`virtio_transport_common.c` notify_poll_in / notify_set_rcvlowat. This Android
branch gates wakeups and poll readiness by the socket mark. Vanilla 6.6 behavior
is not interchangeable; configured image identification is not guest attestation.

Record the per-trial cap and receive-buffer readback, matching complete BENCH
records/text/work and existing WS body/header switches and wall/CPU time. Only a
complete matched inference trial can establish tok/s. Fewer wakeups alone do not
establish a speed improvement. A reverse-order pair is needed to assess drift.

Host sanitizer fixtures execute the actual wire implementation over TCP, including
fragmented frames/tails, EOF, EINTR/EAGAIN, violations, size bounds, disabled-mode
socket behavior, option failures and failed restoration. VSOCK admission metadata
is explicitly mocked there; the actual kernel mechanism requires a phone trial.
