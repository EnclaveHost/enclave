# rpcservice (candidate)

Package `enclave.host/isolation/m3/rpcservice`: a fixed supervisor for the RPC
companion's native chain wrappers. It runs **inside** the attested dedicated
CPU app domain. It is never a host launcher or an external provider proxy. It
is a real, callable process-control adapter. It is **not** a complete attested
deployment. Nothing calls it yet. There is no CLI activation and no monitor
default.

Source only. The author did not build, vet, or run any of it, including the tests.

## What it does

- Fixed role graph. Each role runs
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
- Reported states: `new`, `starting-l1`, `probing-l1`, `starting-base`,
  `clients-started`, `terminated`. `ClientsStarted` means the three wrapper
  processes were launched before the deadline. It does not mean Base passed
  its checks, and it is not serving readiness. Outcomes: `deadline`,
  `stopped`, `failed`.
- If EL, CL or Base exits on its own, all groups are killed (`failed`).
  `Stop`, or cancelling the `Run` context, also kills all groups.
- Launches use `SysProcAttr{UseCgroupFD, CgroupFD, Pdeathsig: SIGKILL}`
  (clone3 `CLONE_INTO_CGROUP`). There is no fallback when this is
  unsupported. The environment is fixed (`PATH=/usr/bin:/bin`,
  `LANG=C.UTF-8`), the working directory is `/`, and stdio is `/dev/null`, so
  there are no pipes.
- Watchdog: `Run`'s select loop and the deadline context are armed before
  the first launch. Launching happens on a separate goroutine, so a `Start`
  stuck in the kernel cannot block termination.
- Cleanup sequence:
  1. Revoke the start permit (it is held under the same mutex as cleanup).
  2. Write `cgroup.kill` to all four role groups.
  3. Wait, within the bound, for any in-flight `Start` to return.
  4. Kill again.
  5. Report `CleanupConfirmed` only when every role group's `cgroup.events`
     shows `populated 0`.

  Anything else is `CleanupUncertain`: an unresolved start, a kill error, a
  read error, or a group still populated after 15 s.
- One-shot. A second `Run` returns `ErrUsed`. There is no reset, reuse or
  restart.

## API

`New(Request{Origin, Groups{Parent, EL, CL, Base, Probe *os.File}})`, then
`Run(ctx) (State, error)`, `Stop()`, `State()`. The request carries no
commands, paths or budgets.

`New` validates through the **same held FDs**:
- cgroup2 `fstatfs` and directory type.
- Distinct dev/inode for parent and each role.
- Each role's `..` is the parent.
- Exact `Openat(O_NOFOLLOW)` readback:
  - Parent: `memory.max=20401094656` (19 GiB), `memory.swap.max=0`,
    `cpu.max=400000 100000`.
  - Roles: `memory.max` EL 5 GiB, CL 7 GiB, Base 5 GiB, probe 128 MiB;
    `memory.swap.max=0`; `memory.oom.group=1`; `cpu.max=max 100000`;
    `pids.max` 1024 for clients and 64 for the probe.
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
- Creating and configuring the five cgroups with the exact values above
  (controllers enabled in the parent's `subtree_control`). Kernel ≥ 5.14
  (`cgroup.kill`) with clone3 cgroup support.

## Missing production integration (exact)

1. No monitor call site. The monitor must create the cgroups and hold their
   FDs, pass the original admission `time.Time` origin, call `Run`, and act on
   `Cleanup`. Nothing is wired or enabled by default.
2. No credential reduction. Wrappers inherit the caller's UID, capabilities
   and seccomp state. There is no dedicated UID, `no_new_privs`, capability
   drop or seccomp profile.
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
8. Tests use only an internal fake backend. There is no real subprocess or
   cgroup test. The Linux backend (`backend_linux_amd64.go`) needs separate
   privileged qualification on the target kernel.
