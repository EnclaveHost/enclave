# RPC monitor domain preparation

`Prepare(bundle, originalOrigin)` composes the real V9 parser, installed RPC
platform verification, original deadline transport and fixed cgroup creation.
It is a monitor library, not a host launcher. The distinct `native_rpc` monitor load path now invokes it; no production
build default enables that path. `Command(composedRoot)` now supplies the fixed namespace
launch handoff after preparation, without starting it. `ComposeCommand` now
constructs the filesystem described below from held code/state capabilities.
The next monitor integration must supply accepted bootstrap identity,
authenticated persistent storage and the launch together; there is no partially authorized launch fallback.

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
controller, front and control children, using the exact limits checked by `rpcservice`. Each
control is read back through its held directory FD. Creation cannot adopt an
existing group. The parent stays empty with cpu/memory/pids enabled beneath it.
All roles together remain under the fixed 19 GiB/four-CPU parent; control uses
128 MiB within that parent; the controller and front use 256 MiB each in their own children. The guest must have at least four CPUs and 20 GiB
total physical memory. This check is not a measured capacity test or host
admission and does not account for external host pending commitments.

`Take()` transfers the resource, owner/deadline, claim and cgroup capabilities
exactly once while the original startup window remains open. `Abandon()` is
allowed only before transfer or any composition attempt; it closes unused handles but never clears the
claim or deletes groups. After transfer, the monitor retains the handles
through any in-flight clone, control, cleanup or uncertain writer operation.

Before invocation of `rpc-native-init`, the monitor still must establish:

- Accepted kernel/bootstrap/root composition and app authorization.
- An independently armed outer guardian covering preparation and kernel stalls.
- Authenticated app-owned L1/Base attachments with exclusive writer fencing.
- Role-specific writable subtrees, UID/JWT access and network isolation.
- Authenticated root assembly before the implemented namespace/cgroup handoff.
- Controller/front identity, readiness and the persistent-serving transition.

Nothing here starts clients, opens block devices, changes original chain data,
releases reservations or claims that RPC is serving. The deadline remains
900 seconds. No GPU worker or desktop model-volume assumptions are reused.

The current entry topology is ERPCONE4: front group FD12, composed root FD13,
verified executable FD14. Before Start, the monitor additionally transfers the
original readiness pipe at FD15 and the distinct broker lifecycle socket at
FD16 using one-shot `BindReadiness` / `BindServing`. `Prepared.Command` consumes preparation once and
executes `/proc/self/fd/14` with exactly these capabilities in new mount, PID,
network, IPC and UTS namespaces, at creation in the control cgroup. No user
namespace is added in production. It returns a command and retained capabilities;
the monitor must register the front, arm its independent guardian and establish
authenticated state/network policy before starting it. There is no automatic
cleanup/retry API or claim that command construction equals launch authority.

The PID1 entry arms its owner/deadline watcher before the root switch, closes
the executable descriptor, requires a read-only/nosuid/nodev held root, makes
mount propagation private, chroots and closes the outside-root descriptor. It
mounts fresh private read-only proc with hidepid=2 and sets no_new_privs on every
Go thread. The trusted assembled root must already have an empty nonsymlink
`/proc`; this bootstrap does not infer writable-state authority from root ownership.
ERPCONE1/2/3 frames are incompatible with this new handoff. The
entry supervises the front and waits for its bound one-shot owner approval
before controller or chain execution. This closes the local process start gate;
it does not supply the missing monitor load or storage authority.

## Filesystem composition

`ComposeCommand(actualBundle, l1, base)` consumes the composition attempt before
work and constructs `/domains/rpc-<claim>` exclusively. It compares the actual
bundle/deployment/logical-volume IDs with the consumed preparation, copies the
bounded bundle bytes, and retains all source handles and partial mounts on
failure. `Take`, `Abandon` and another composition refuse incomplete construction.
No cleanup/retry or capacity-release assertion is made.

The source capabilities must come from the monitor's authenticated exclusive
writer workflow. A `StateVolume` has a held filesystem descriptor and logical ID;
these are **not** authentication or an exclusive writer lease. The caller must
retain the real lease and terminate the domain when authority is lost. This
integration still has no implementation that acquires that authority.

The existing verified client root supplies `/usr`, `/lib64`, `/opt`, CA files and
public chain configuration. Immutable `/plat` supplies the front, WASI runtime
and updated maintained wrapper. Profile schema 2 separately pins this wrapper;
the immutable version-1 client image is unchanged. Both construction and the
in-namespace supervisor verify the overlay pin before clients. A schema-1
profile is incompatible; no production profile has been activated.

Each state capability must be a writable ext4 filesystem root (inode 2), owned
by root without group/other write access. L1 and Base must have different device
identities. Existing subdirectories must already have the fixed owners and
private permissions: EL data/tmp 2101, CL cl/tmp-cl 2102, Base data/tmp 2103.
The composer never chowns chain state. Reusing older data requires a separately
authorized exclusive-COW ownership migration; originals stay untouched.

Nonrecursive bindings expose volume roots read-only, nosuid/nodev/noexec, with
only those held subdirectories rebound writable. Generated immutable metadata
binds the actual AppID/claim/logical volumes to device/inode/owner tuples. The
wrapper checks those tuples and actual `findmnt --mountpoint` flags before a
client uses state. This proves consistency of local bindings, not remote
storage identity, coverage, freshness, owner consent or writer fencing.

Fixed accounts include controller 2105 and front 1053577. A fresh private JWT
is generated into read-only metadata with owner 2101/group 2102/mode 0440;
its bytes are never emitted. Root metadata uses at most 32 MiB tmpfs; the front
gets 16 MiB private runtime space, shared temporary space 64 MiB and minimal
character devices 1 MiB. These 113 MiB mount limits fit within the proposed
platform allowance on paper, **not** a measured whole-stack capacity result.
Explicit directory modes keep configuration traversable under umask 0077.
The exact held monitor socket is rebound into the front's private directory.
Source handles and mounts remain retained in `Launch.Composition`.

Qualification covers actual private-namespace binding of dummy directories,
read-only parent/writable child flags, inode identity and unchanged source mount
flags; Python state observations are mocked. No full positive ComposeCommand,
production ext4/role-UID/JWT/device policy, accepted platform, network policy,
monitor registration, chain start or persistent-serving transition is proven.
The distinct monitor load path now calls this API, gated by its required
measured storage broker; that broker is not implemented or installed. DNS and Base coverage
artifacts are not synthesized: accepted network/coverage provisioning remains
necessary before live use. The original 900-second window is unchanged.
