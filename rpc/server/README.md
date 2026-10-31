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

## Guarded lifecycle candidate

`guarded_export.py` now composes the COW worker with an independent guardian
process. The worker waits on a closed socket gate until the guardian has a fresh,
authenticated resource observation. The guardian owns the original monotonic
startup deadline, polls exact child pidfds, and continues resource checks while
the worker performs disk/network operations. A stalled observer, expired resource
reading, changed authority, low reserve, dead worker or missed startup deadline
stops the owned process group. Group leaders remain unreaped until signals have
been sent, preventing PID-reuse cleanup errors.

The CLI additionally requires an exact user-systemd unit named
`enclave-rpc-export-ATTEMPT.service` with these properties before creating children:
Type=notify, NotifyAccess=main, KillMode=control-group, Restart=no,
WatchdogSec=2, WatchdogSignal=SIGKILL, TimeoutStartSec=3, TimeoutStopSec=1,
SendSIGKILL=yes, FinalKillSignal=SIGKILL, MemoryMax=384M, MemorySwapMax=0,
CPUQuota=100%, TasksMax=32 and LimitCORE=0. The caller must hold the separate
128MiB bootstrap/collector allowance (512MiB total) and reviewed host admission.
The CLI rechecks main PID, invocation, cgroup and kernel memory limits, then waits
for an acknowledged active watchdog before forking. This is a required backstop
for a guardian that itself stalls; Python time checks alone are insufficient.
The unit and config are not installed or started by importing this module.

The protected0600 contract binds attempt, guest instance, host boot, original created/deadline
UTC nanoseconds separated by exactly900seconds, role-specific original chains,
TLS locations and endpoint names, state directory, runtime source hashes and the
maintained resource reader command. Runtime pins include both Python components,
`observe_resources.mjs`, its protected configuration, the shared `../storage_protocol.py`,
and the Node executable.
The resource reader verifies the installed local control client hash and performs
two authenticated GET /health requests. It never invokes VM operations. Pending
RAM includes growth still reserved for **running guests**; it is not a queue that
can simply be waited out. The explicit startup floor remains27648MiB and the
installed host floor is also honored if higher.

Before publishing export readiness, the worker performs exact-binary TLS
negotiation and checks the export name, size and writable/FLUSH/FUA flags.
`ready.json` explicitly says rpcReady=false. The operator can adopt only after the
separate RPC workload/readiness review, by delivering a protected receipt bound
to attempt, boot, contract hash and readiness hash. Adoption must be observed
before the original deadline; a delayed callback cannot extend it. The worker
also rejects late adoption. Once adopted, resource monitoring continues, and
removing or modifying the receipt stops the export. No receipt producer or
implicit RPC approval is included. Startup failure never deletes or reuses a COW.

Qualification so far:10 finite real-process guardian tests,14 native dummy COW/TLS
checks including the actual supervisor probe, and one authenticated invocation of
the maintained resource reader. The original probe-format failure is preserved.
The final CLI adds stricter unit timeout/escalation and acknowledged-watchdog
checks; the tested guard/probe/owner functions remain byte-equivalent as ASTs.
The final CLI as a whole has **not** run in production or passed composed native
activation. Two real target user-systemd dummy tests separately froze the main
process and verified exact main/child pidfd exits, watchdog termination and empty
cgroups in about2.2seconds, including a child configured to ignore SIGTERM. Those
used128MiB actor units; they do not qualify the production384MiB supervisor or
whole-stack admission. Guest credential delivery, full composed lifecycle,
kernel attachment, sustained workload and actual production cutover remain open.


## Guest receipt binding

`storage_protocol.py` is shared by the server emitter, owner-side
`prepare_attachment.py`, and guest attachment helper. The server emits
`owned-rpc-server-ready/1` only after both real TLS probes return the expected
export, size and writable/FLUSH/FUA metadata. The receipt binds guest instance,
server boot, exact server contract hash, supervisor invocation, and the original
900-second window. It deliberately does not assert a filesystem UUID, global
writer fence, or RPC readiness that the probe has not established.

The owner-side preparer reads protected, explicitly hash-pinned server contract,
server receipt and credential receipt files. It creates an exclusive directory
containing `attachment.json` (schema2), the byte-identical `server-ready.json`, and
a public result. It never creates a later deadline, invents an export receipt,
starts services, copies private keys, or performs network calls. The expected guest
boot/instance must come from the owner's authenticated SSH channel using the pinned
host key. File hashes check bindings; they do not authenticate an arbitrary file's
origin. Source/namespace admission and the actual exporter process remain the
operator's responsibility.

The guest checks those same identities and times, then verifies live TLS,
filesystem UUID and directory ownership before READY. The old per-role flat
receipt with `exclusiveCow`/`originalsReadOnly` boolean assertions is no longer
accepted; it was never production-qualified. Existing schema1 seed artifacts
must not be combined with these schema2 contracts.
