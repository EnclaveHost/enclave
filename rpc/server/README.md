# Owned RPC state exports

`volume_export.py` is the maintained data-path component for a host selected by the
wallet owner. It has no Enclave discovery or control endpoint. It creates a new
exclusive COW for an explicit original chain, holds QEMU-compatible read-only
permission locks, validates the complete backing chain, and launches a pinned
foreground qemu-nbd with mandatory TLS and an attempt/role-specific client DN.
Backing nodes are explicitly read-only; only the new overlay is writable. One
connection is served at a time. The original images and failed/partial overlay
are retained. The component consumes an attempt once and provides no retry.

This is a library, not a production launcher or resource admission. Its caller
must run in a separately admitted cgroup with an independent original deadline,
continuous host/pending/disk monitoring, protected source/credential namespace,
and exact-child cleanup. A returned Popen is not a listening/readiness receipt.
`check()` enforces the supplied monotonic deadline only when called; it cannot
interrupt a hung caller. The caller must therefore have an independent guardian.
`close()` waits for its exact child but never claims clean guest filesystem state,
global writer fencing, or releases a production reservation. No READY or adoption
receipt is fabricated here. Credential generation/delivery and the protected
operator path that binds the guest to this export remain separate integration.

The finite native fixture uses private network/PID/mount namespaces and disposable
1MiB data. It tests real authenticated NBD writes, FUA/FLUSH, explicit reconnection,
authentication/name/export refusal, QEMU writer-lock refusal, original preservation
and persisted overlay readback. It does not qualify Linux kernel attachment,
production data, cross-host failures, durable cleanup, or sustained performance.

Protocol references: [QEMU NBD](https://www.qemu.org/docs/master/tools/qemu-nbd.html)
and [NBD specification](https://github.com/NetworkBlockDevice/nbd/blob/master/doc/proto.md).

Actual isolated qualification passed all13 native checks in0.534s; see
[the result](../../ops/unified-funding-20261028/rpc-volume-export-native-fixture-r1/ROOT-RESULT.md).
Production export remains unadmitted after the current storage-host resource read.
