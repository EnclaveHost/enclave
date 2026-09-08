# Native echo comparison

The Android 16 `virtmgr` implementation of `connectVsock` returns the connected
`VsockStream` descriptor via Binder. It does not copy each byte through an
additional userspace forwarding loop. A Java echo measurement therefore
includes both the app's Java stream loop and the vsock transport; it cannot
attribute all measured overhead to either one.

Source: [Android 16 virtmgr, connectVsock and vsock_stream_to_pfd](https://android.googlesource.com/platform/packages/modules/Virtualization/+/refs/heads/android16-release/android/virtmgr/src/aidl.rs).
The installed device's implementation still needs to be checked against this
source; native echo logs the actual descriptor's socket domain/type/buffers.

Build the usual `engine-pvm`, then `anchor`. Use the existing engine
`ANCHOR_LINK_ECHO=1` diagnostic with `worker=echo`. The default uses the existing
Java loop. Add the intent extra `--ez nativeecho true` for the native loop.
Use the same APK, guest probe, pump priority, burners and device state for both
legs, preferably Java/native/native/Java. Compare identical message sizes and
latency distributions; report any errors or incomplete legs.

The native loop uses a 64 KiB buffer, handles short reads/writes and EINTR,
uses per-call nonblocking socket flags with poll for backpressure, and has a
ten-minute overall deadline. It retains no descriptor after returning and
leaves closure to Java. It logs negative errno on failure; it does not silently
fall back to Java. The native mode only affects `worker=echo`; the ordinary
inference bridge is unchanged. This is an experiment, not a claimed speedup.
