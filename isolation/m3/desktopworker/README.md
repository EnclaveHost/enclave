# Native desktop worker lease

Implemented and tested across the Go guest and Node host transport. Not yet
wired into production monitor admission or the manager's desktop allocation.
This is connection authorization for the NucBox operator-trusted T0-hv tier,
not a host-excluded SNP channel, GPU attestation, or a new masking algorithm.
Only the existing masking service may send worker protocol bytes through it.

## Binding and lifetime

The host receives an already verified mapping and selected desktop RuntimeID.
The pinned per-VM Windows bridge checks the hypervisor-provided VM identity.
Its per-start loopback credential travels on stdin only. The server accepts a
single claim matching the mapping's AppID, profile SHA-256 and GPU milli. The
claim also names the guest boot and the monitor's single-use desktop claim.
No second claim can succeed, including after disconnect or failed startup.

Exact newline-terminated ASCII frames, maximum 512 bytes:

    native-worker-v1 claim <boot32> <claim64> <appID64> <profileSHA64> <gpuMilli>
    native-worker-v1 lease <token64>

The control connection then stays open and silent. Closing it or sending any
extra byte permanently revokes the lease and all streams. Each stream uses a
separate authenticated bridge connection:

    native-worker-v1 open <token64>
    native-worker-v1 stream

Opaque worker bytes follow the stream response. The token is private to the
root monitor and transport, never given to desktop/client roles. Both sides
limit simultaneous and pending opens to eight. Handshakes have a five-second
bound or the caller's shorter deadline. Late successful dials after cancellation
are closed; guest Done and host close wait for owned pending operations to
drain. Buffered stream bytes are discarded on close. No reconnect is attempted.

`AcquireHost` fixes the guest destination to CIDHost port 19595. Its caller must
already establish the dedicated native T0-hv profile. The root monitor exposes
only the shared bridge's root:1001 mode 0660 Unix socket to the masking service;
SO_PEERCRED must match UID 1001, even for root or same-group clients. Native role
seccomp/network policy must still deny raw GPU/vsock routes to application roles.

The host allocation remains reserved until VM removal is confirmed by the
manager. This transport does not allocate physical GPU memory; the existing
masked worker protocol retains its own memory negotiation. Transport health
cannot prove an untrusted worker's capacity or honesty. Masking, verification,
model/public-weight authorization and CPU fallback remain mandatory.

## Qualification

The Go race suite covers canonical bindings, exact framing, malformed replies,
caller cancellation, pending/active stream limits, concurrent open/close,
control disturbance, late dials, short writes and buffered bytes after close.
The Node suite exercises real loopback sockets: wrong credentials/bindings,
one-time claims, pending stream limits, revocation, late connection cleanup,
large coalesced output, failed workers and pinned-bridge wrapper lifecycle.
The Windows process in wrapper tests is a fake; the wrapper's real Windows
binary has not been executed by these checks.

Two actual KVM guests run the selected 6.6.87.2-enclave-kvm-box kernel. A foreign
CID is refused by the disposable carrier before any bridge authentication,
claim or worker connection. The admitted guest uses the real Go client over
vsock, the root-owned Unix broker, credential-dropped UID 1001 clients, and the
actual Node server. Root and UID 1000/GID 1001 impostors are denied. 32 successive
clients each exchange 40960 opaque public fixture bytes; a 33rd held stream is
closed by host revocation. Exactly 33 mock worker connections are opened and
all are drained. There is no GPU, NIC, host input, disk or shared filesystem.
A Linux Python carrier models per-VM routing and private bridge credentials;
this does not qualify the Windows bridge or NucBox deployment itself.

The first integrated attempt failed during a stream handshake. Investigation
found a reproducible bug in existing vsock.DialContext: its unconditional first
poll wait could lose already-delivered writability. A standalone old-pattern
reproducer times out 20/20 times on an already-connected socket. The fixed
wait checks SO_ERROR and getpeername before waiting, without treating SO_ERROR=0
as proof of a completed connection. Regression tests cover already-connected,
unconnected and refused sockets. The first failure is retained; its missing
per-reason diagnostic means that run alone does not prove the failure's cause.
Final KVM qualification uses the fixed vsock implementation.

The pinned kernel's virtio-vsock modules were built against its exact
vmlinux.symvers in an unprivileged private namespace with the kernel tree
read-only. They were loaded only in disposable guests, never on the host.
Final test initrd SHA-256:
091003ac27770e069101144edca483dde61c3954002b2dbe3cb9cb6afc2adbb4.

Existing M2 front/broker and M3 monitor regression checks pass. Evidence and
source snapshots are in outputs/kvm-box/evidence/native-worker-lease.

## Required production wiring

The manager must derive/authorize the desktop bundle, select its separate
pinned image, reserve desktop.gpuMilli atomically, and start this transport for
that exact VM before loading the app. Its pinned runtime and profile must match
the final release. It must retain capacity through failed/unknown cleanup.

The monitor must refuse ordinary workloads in the dedicated guest, verify the
profile/controller/mounted images, consume the boot claim, create the limited
cgroup, acquire this lease with those exact identities, then publish the Unix
endpoint and launch the fixed controller/native graph. Ending the domain must
revoke new worker/secret access, close the broker/lease, kill/reap/remove the
cgroup, and only then permit confirmed VM/resource release. Cleanup failure
poisons the guest. Existing owner sealed-secret delivery remains exclusive to
the Wasm controller. No production caller uses this lease yet; desktop admission
remains disabled until that integration is complete and tested.

## Host lifecycle integration follow-up

The host server now exposes terminal lease revocation independently of the
Windows bridge process. The transport's `exited` signal resolves on either
bridge exit or lease loss, so the manager cannot continue to call a revoked
transport healthy merely because its carrier remains alive. Cleanup closes
bridge stdin immediately and waits for both the actual bridge exit and all
owned worker dials; a revocation notification is not process-reaping evidence.
The regression fixture deliberately keeps the bridge alive after lease EOF
and verifies that cleanup still waits for its exit. This fixture uses real
loopback sockets and an injected child process, not Windows or GPU execution.

WMI transport hooks now receive the per-spawn mapping alongside the VM id.
Existing WMI image roles explicitly refuse desktop mappings before preflight
or VM creation, including direct callers bypassing the manager. The native
image/storage/guest lifecycle remains to be implemented before that refusal
can be replaced with qualified desktop admission.
