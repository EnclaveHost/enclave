# Pixel bridge copy-path check

The Android host kernel source identified as `fa1d6308d1fe` does not provide a zero-copy VSOCK sender. Its stream socket uses `sock_no_sendpage`, which maps a page and passes it through `kernel_sendmsg`. The virtio transport then allocates `pkt->buf` with `kmalloc` and calls `memcpy_from_msg`.

- [VSOCK stream operations](https://android.googlesource.com/kernel/common/+/fa1d6308d1fe/net/vmw_vsock/af_vsock.c#2225): `sendpage = sock_no_sendpage` (line2243).
- [sendpage fallback](https://android.googlesource.com/kernel/common/+/fa1d6308d1fe/net/core/sock.c#3250): page mapping to `kernel_sendmsg`.
- [virtio packet allocation](https://android.googlesource.com/kernel/common/+/fa1d6308d1fe/net/vmw_vsock/virtio_transport_common.c#74): allocation and copy (lines75/81).

A TCP→pipe→VSOCK splice might save a userspace copy, but would retain the VSOCK packet allocation/copy and require correct backpressure/cancellation handling. It is not a direct zero-copy route into the protected guest. No inference gain was measured, no kernel or device settings changed, and no splice implementation is queued.

This uses the exact Android host-kernel source revision recorded for the device, separately from the configured Microdroid guest kernel. Downloaded source hashes and URLs are retained in the work provenance record. Existing default-off ARM kernels have prior numerical validation but still need a completed27B throughput comparison, and take priority after the current receive-window pair.
