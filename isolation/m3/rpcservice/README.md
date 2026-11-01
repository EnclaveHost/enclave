# RPC native service runner

Package `enclave.host/isolation/m3/rpcservice`: a fixed supervisor for the RPC
companion's portable controller and native chain wrappers. It runs **inside** the attested dedicated
CPU app domain. It is never a host launcher or an external provider proxy. It
is a real, callable process-control adapter. It is **not** a complete attested
deployment. The explicit `cmd/rpc-native-init` namespace entry calls it; no
monitor launch path or default enables it yet. It refuses ordinary host execution.

The author supplied source without execution. Root review corrected cleanup
quiescence, bounded caller waits for stalled kernel controls, and privilege
reduction. Actual qualification results are recorded separately.

## What it does

- Fixed role graph. The dedicated TLS front starts once first under UID/GID1053577,
  in its own 256 MiB cgroup. A successful owner-direct bootstrap must approve the
  exact private inherited start binding before any controller or chain launch.
  The controller then starts once under UID/GID2105,
  using the measured `/plat/rt` loader and Wasmtime to run `/app.wasm`. It
  receives TCP access only to the app network namespace, no DNS/UDP/filesystem
  preopens/environment forwarding or compiled cache, and a 64 MiB Wasm linear
  memory limit. Its separate 256 MiB cgroup includes runtime compilation.
  The native chain roles run
  `/usr/bin/python3 -I -B /opt/enclave-rpc/chain_service.py <el|cl|l1-ready|base>`.
  - EL starts once, then CL starts once.
  - The `l1-ready` probe repeats at a 10 s interval while the original window
    remains. Each attempt is bounded (150 s, and cut off by the deadline).
    Between attempts, the probe cgroup must be empty.
  - Exactly one Base launch follows a probe that exited 0.
  - No start is ever retried. The wrapper keeps all client flags, chain
    identity, snapshot/pruning, Base coverage and local-L1-only checks. Base
    rechecks coverage and `l1_ready()` by itself.
- Deadline is exactly `origin + 900s`. The origin is the caller's
  `time.Time`. It must carry this process's monotonic reading and lie inside
  the window. Nothing resets the deadline. At the deadline everything is
  killed, because no handoff is implemented.
- Reported states: `new`, `authorizing-owner`, `starting-controller`, `starting-l1`, `probing-l1`, `starting-base`,
  `clients-started`, `terminated`. `ClientsStarted` means the three wrapper
  processes were launched before the deadline. It does not mean Base passed
  its checks, and it is not serving readiness. Outcomes: `deadline`,
  `stopped`, `failed`.
- If the front, controller, EL, CL or Base exits on its own, all groups are killed (`failed`).
  `Stop`, or cancelling the `Run` context, also kills all groups.
- Launches use `SysProcAttr{UseCgroupFD, CgroupFD, Pdeathsig: SIGKILL}`
  (clone3 `CLONE_INTO_CGROUP`). There is no fallback when this is
  unsupported. The environment is fixed (`PATH=/usr/bin:/bin`,
  `LANG=C.UTF-8`), the working directory is `/`, and stdio is `/dev/null`, so
  there are no stdio pipes. Only the front receives a private approval writer
  and sealed identity binding, never the chain roles or controller.
- Watchdog: `Run`'s select loop and the deadline context are armed before
  the first launch. Launching happens on a separate goroutine, so a `Start`
  stuck in the kernel cannot block termination.
- Cleanup sequence:
  1. Revoke the start permit (it is held under the same mutex as cleanup).
  2. Write `cgroup.kill` to all six role groups.
  3. Wait, within the bound, for any in-flight `Start` and the entire
     launch/probe routine to return; no backend operation may remain in flight.
  4. Kill again.
  5. Report `CleanupConfirmed` only when every role group's `cgroup.events`
     shows `populated 0`.

  Anything else is `CleanupUncertain`: an unresolved start, a kill error, a
  read error, or a group still populated after 15 s.
- One-shot. A second `Run` returns `ErrUsed`. There is no reset, reuse or
  restart.

## API

`New(Request{Origin, Groups{Parent, EL, CL, Base, Probe, Controller, Front *os.File}})`, then
`Run(ctx) (State, error)`, `Stop()`, `State()`. The request carries no
commands, paths or budgets.

`New` validates through the **same held FDs**.

The monitor-side `PrepareGroups(heldParent, claimNonce)` constructs these
groups exclusively with the same limit definitions and exact readback. It
also constructs the supervisor control sibling. The caller must already own
the consumed app claim; the nonce's shape alone is not authority. Its one-shot
`Take()` transfers the handles; `Abandon()` can close them only before transfer.
Failed/abandoned group directories remain consumed. No process is launched,
existing group adopted, or reservation released by this constructor.

Validation covers:
- cgroup2 `fstatfs` and directory type.
- Distinct dev/inode for parent and each role.
- Each role's `..` is the parent.
- Exact `Openat(O_NOFOLLOW)` readback:
  - Parent: `memory.max=20401094656` (19 GiB), `memory.swap.max=0`,
    `cpu.max=400000 100000`, `memory.oom.group=1`, `pids.max=4096`,
    `cgroup.type=domain`. All directories must be root-owned and not writable
    by group/others.
  - Roles: `memory.max` EL 5 GiB, CL 7 GiB, Base 5 GiB, probe 128 MiB, controller and front 256 MiB each;
    `memory.swap.max=0`; `memory.oom.group=1`; `cpu.max=max 100000`;
    `pids.max` 1024 for native clients, 64 for the probe and 128 each for controller/front.
  - Each role: `cgroup.type=domain`, `populated 0`, and `cgroup.kill`
    present.
- The interpreter and wrapper paths are on a read-only mount. This is only a
  sanity check.

The FDs are borrowed and never closed. The caller may release them only after
`CleanupConfirmed`. After `CleanupUncertain` the caller must keep them and
permanently poison the domain, as `poisonNative` does.

## Preconditions the caller owns (not proven here; no flags pretend to)

- The measured read-only root pins `/usr/bin/python3`, its stdlib,
  `/opt/enclave-rpc/**` (wrapper, manifest, pinned binaries),
  `/etc/enclave-rpc/**` and `/etc/enclave-rpc-vm/disks.json`. The read-only
  check is not measurement.
- Authenticated mounts and storage. That includes binding `contract.RPC`
  `L1VolumeID`/`BaseVolumeID` and `ProfileSha256` to the actual volumes and
  runtime descriptor.
- An independent owner death guard that kills the parent cgroup if the
  monitor dies. `Pdeathsig` is per OS thread and is only defence in depth.
- Creating and configuring the eight cgroups with the exact values above
  (controllers enabled in the parent's `subtree_control`). Kernel ≥ 5.14
  (`cgroup.kill`) with clone3 cgroup support.

## Missing production integration (exact)

1. No monitor call site. The monitor must create the cgroups and hold their
   FDs, carry the original admission clock in the sealed entry contract, and
   invoke the measured namespace entry. Nothing is enabled by default.
2. The image must create role UIDs/GIDs 2101 (EL), 2102 (CL), 2103 (Base),
   2104 (probe), 2105 (controller), 1053577 (front), and bind only the matching writable data subtrees. The backend
   drops supplementary groups and selects these fixed unprivileged credentials.
   It requires inherited no_new_privs and zero ambient/inheritable capabilities.
   Per-role mount setup and the complete seccomp policy still need integration.
3. No network policy. Peer-port exposure and loopback-only engine/beacon
   access depend on the domain's network setup.
4. No log capture. Stdout/stderr are discarded. Reth logs to its datadir;
   Lighthouse and wrapper messages are lost.
5. No deadline handoff or long-running service mode. The portable
   controller's whole-stack readiness is not integrated. Because of this, the
   supervisor always ends at `origin+900s`. It is a startup-qualification
   adapter only.
6. Budgets and the 150 s probe timeout are unmeasured proposals. Neither the
   role `cpu.max`/`pids.max` choices nor the 1 GiB support reserve outside
   the 19 GiB parent are validated against real clients.
7. The `-I -B` interpreter flags are this package's choice. Check them
   against how the maintained wrapper is invoked elsewhere.
8. Lifecycle tests use an internal fake backend. Entry tests additionally use
   real sealed memfds and an owned helper process with a held pidfd. There is
   no positive privileged cgroup test. The Linux backend
   (`backend_linux_amd64.go`) needs separate qualification on the target kernel.

Cleanup confirmation covers process containment, not clean database shutdown,
fsync, writer fencing or reservation release. A kill may leave recovery work.
The creating OS thread remains locked through child Wait so parent-death
signaling is not tied to a disposable runtime thread. Cleanup timeout returns
uncertainty while retaining all borrowed descriptors; the independent monitor
must terminate the parent domain and settle any outstanding operations.
No callback success or timed-out operation supplies authority to release storage.

Root qualification: 25 bounded Go checks passed; the Linux backend compiled.
These exercise simulated lifecycle failure paths and actual refusal of ordinary
directory descriptors, not privileged native containment. The image must also
provision JWT read access only for EL/CL without granting cross-role writes.

## Explicit namespace entry

`cmd/rpc-native-init` is a separate amd64 ELF for the measured bootstrap. It is
not part of the client root image and exposes no command/path configuration.
It requires UID/EUID 0 and namespace PID1, with exactly these inherited FDs:

| FD | Capability |
| --- | --- |
| 3 | The trusted monitor's own live pidfd |
| 4 | Fully sealed 40-byte original deadline contract |
| 5 | Aggregate parent cgroup |
| 6–9 | EL, CL, Base and probe cgroups |
| 10 | Supervisor control cgroup, a sibling of the role groups |
| 11 | WASI controller cgroup, another direct child of the aggregate |
| 12 | TLS front cgroup, another direct child of the aggregate |
| 13 | Held monitor-composed read-only namespace root |
| 14 | Verified executable inode used by the child exec |

The entry frame magic is now `ERPCONE4`; older topology frames are
refused rather than accepting a missing root, front or controller capability. Existing entry
binaries/profiles must be rebuilt and explicitly qualified before activation.

The control cgroup must contain only PID1, with memory.max=128 MiB,
memory.swap.max=0, memory.oom.group=1, pids.max=128, domain type and inherited
CPU limit. It is inside the existing 19 GiB aggregate. Keeping the aggregate
node empty permits its domain controllers to remain enabled.

The monitor captures `MonotonicNow()` before preparation and passes that same
origin to `NewEntryContract`. The memfd binds the kernel boot UUID and original
monotonic origin/deadline; both sides require zero Linux time-namespace offsets.
Full seals prevent mutation, not replay or unauthorized monitor substitution.
The monitor must own the one-shot deployment claim and transfer its own pidfd.

After validating the contract, an independent locked-thread watchdog is armed
before cgroup validation or client startup. Owner death, descriptor error or
the original deadline exits PID1 with status124, letting the kernel terminate
its namespace descendants. It never signals an external process. SIGTERM and
SIGINT enter the existing cleanup path; the watchdog remains armed. Borrowed
FDs remain alive for the entire process. An outer guardian must cover bootstrap
before the watchdog arms, kernel stalls and exact final domain death.

This entry does not independently authenticate mounts, accepted root measurement,
JWT access, writer ownership or network policy. Those remain monitor release
requirements. Process exit is not a clean database or storage-release receipt.

## Controller composition status

Before launching any process the namespace adapter reads immutable bounded
`/app.bundle`, `/app.wasm`, `/app.sha256` and `/plat/native-rpc/profile.json`.
It checks actual V9 loaded bytes, the complete AppID statement and canonical
profile/controller binding. This consistency check does not independently
authenticate the runtime, wallet or state-volume authority. Read-only loader
and Wasmtime paths also remain part of the trusted measured composition.

Controller death or failed startup now enters the same cleanup path as a chain
client failure. In-flight controller starts and population prevent cleanup
confirmation. It is never restarted and receives the same original deadline.
Total role/control maxima are 17.75 GiB inside the 19 GiB aggregate, leaving
1.25 GiB unallocated for guest overhead. This is not evidence that the full
runtime fits. The namespace handoff is implemented, but monitor load/root assembly,
report-socket registration, role write/network isolation and authenticated storage
wiring remain incomplete; no endpoint is deployed.


## Private owner start gate

The supervisor checks the actual immutable bundle and runtime identity, generates
a fresh 256-bit nonce, and creates a fully sealed 136-byte binding containing
AppID, RuntimeID, full deployment ID and nonce. Only the exact front child inherits
its read descriptor (front FD4) and the private pipe writer (front FD3). These
are different from the entry executable's FD3/4 owner/deadline contract. Parent
copies of the writer/binding close only when front Start settles. No other role
receives either descriptor. The front checks them against its loaded identities
before key creation and writes once only after owner-direct startup succeeds.

Approval is consumed before a single nonblocking atomic-sized write. The parent
requires the entire exact frame and EOF before starting the controller. Refusal,
wrong identity/nonce, incomplete/trailing bytes, a writer that never closes or
front loss cannot reset the original deadline. Cleanup drains the approval driver
as well as in-flight starts. If they remain blocked, the domain stays uncertain
and the independent entry watchdog remains responsible for ending PID1.

This is trusted local component communication, not a transferable authorization
certificate, storage writer lease, attestation or permanent service grant. The
existing owner bootstrap still reads legacy lease state; it does not implement
the replacement event-driven protocol. The complete measured monitor must
register the fixed front UID, mount its private report/TLS directory, bind the
correct eight groups and immutable platform, establish authenticated exclusive
state attachments and arm the outer guard before invoking ERPCONE4.

The ERPCONE4 entry additionally consumes monitor-composed root FD13 and pinned
executable FD14. The original watcher is armed before root switching. It closes
FD14, validates control membership, makes mounts private, switches to the held
read-only/nosuid/nodev root, closes its outside-root FD and mounts new read-only
proc with hidepid=2. All Go threads receive no_new_privs (CGO builds refuse this
operation). Namespace creation and clone-time control placement are supplied by
`rpcdomain.Prepared.Command`. The actual monitor load/root assembly/state
authority path remains incomplete; neither command construction nor this root
switch is an attestation or a writer-fence proof. No target activation is enabled.
