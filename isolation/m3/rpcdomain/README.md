# RPC monitor domain preparation

`Prepare(bundle, originalOrigin)` composes the real V9 parser, installed RPC
platform verification, original deadline transport and fixed cgroup creation.
It is a monitor library, not a host launcher. No monitor load path or build
default invokes it yet. The next integration must supply the distinct RPC
bootstrap, controller/front, authenticated persistent storage and namespace
launch together; there is no partially authorized launch fallback.

The original timestamp comes from `rpcservice.MonotonicNow()` before download,
authentication and preparation. `Prepare` never creates a new startup interval.
It checks the actual installed kernel release, profile/controller identity,
live executable ext4 dm-verity root and immutable entry ELF. It retains file
descriptors for the verified resources. Kernel release and hashes are only
part of accepted-platform derivation; they are not independent attestation.

The trusted monitor must authorize the wallet/deployment before calling this
API. The bundle fixes the app identity, deployment and two distinct logical
volume IDs. A per-boot tmpfs claim records these, the profile, random nonce
and original monotonic origin. It is created exclusively, fsynced, read back
and retained through a read-only descriptor. The claim remains consumed after
failure or monitor restart; it is never unlinked by this library. This local
claim is not a durable cross-host storage writer lease.

Preparation opens a pidfd for the current monitor process itself. No supplied
PID is accepted. It creates an exclusive parent cgroup plus EL, CL, Base, probe
controller and control children, using the exact limits checked by `rpcservice`. Each
control is read back through its held directory FD. Creation cannot adopt an
existing group. The parent stays empty with cpu/memory/pids enabled beneath it.
All roles together remain under the fixed 19 GiB/four-CPU parent; control uses
128 MiB within that parent; the controller uses 256 MiB in its own child. The guest must have at least four CPUs and 20 GiB
total physical memory. This check is not a measured capacity test or host
admission and does not account for external host pending commitments.

`Take()` transfers the resource, owner/deadline, claim and cgroup capabilities
exactly once while the original startup window remains open. `Abandon()` is
allowed only before transfer; it closes unused handles but never clears the
claim or deletes groups. After transfer, the monitor retains the handles
through any in-flight clone, control, cleanup or uncertain writer operation.

Before invocation of `rpc-native-init`, the monitor still must establish:

- Accepted kernel/bootstrap/root composition and app authorization.
- An independently armed outer guardian covering preparation and kernel stalls.
- Authenticated app-owned L1/Base attachments with exclusive writer fencing.
- Role-specific writable subtrees, UID/JWT access and network isolation.
- Namespace entry at creation in the control cgroup and fixed FD transfer.
- Controller/front identity, readiness and the persistent-serving transition.

Nothing here starts clients, mounts devices, changes original chain data,
releases reservations or claims that RPC is serving. The deadline remains
900 seconds. No GPU worker or desktop model-volume assumptions are reused.
