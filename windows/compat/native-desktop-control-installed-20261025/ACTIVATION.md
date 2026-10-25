# Native desktop control activation

Status: **preparation only; production has not been changed**. The code transaction
is tested. The complete service/configuration handoff and rollback have not yet
been rehearsed and are not ready for unattended execution.

## Verified current impact

The October 25 inspection at approximately 17:16 UTC finds the installed Node
and Shield tasks running as SYSTEM, with their expected launchers. The Update
task is enabled and idle. Node PID 4716 and manager PID 5180 retain their October
23 start times. All 92 source hashes and 17 absent paths still match this package.

The manager serves two VMs: application `10c44a8a…` (deployment `0x7ae476a3…`)
and the readiness witness. Both report ready at the final inspection. The application VM was automatically
replaced between inspections: renewals failed at 17:04:46, 17:05:41 and
17:08:01 UTC; the node logged lease expiry and retirement at 17:11:29 UTC.
The old VM was `9e79e765-f7d4-48ce-9bbd-73bc312dbeba`; the replacement
`3b3a309a-7d6c-4ee4-bf68-e6d0ddd858fe` was ready by the 17:16:25 inspection.
Thus this checkpoint does not claim uninterrupted app availability. The
underlying RPC failure is unresolved. The storage and control VMs are
outside that manager's inventory. The API relay remains PID 73131; its 16
source/absence checks and existing policy hash also match the separate prepared
API overlay. These are point-in-time observations, not authorization to overwrite
later changes.

Restarting this manager **interrupts the hosted app and witness**. The current
launcher owns per-process report keys and connections. `Manager.recover()` marks
old VMs non-serving, and the node normally replaces them. The shared RAM/CPU
admission code refuses new allocations while any recovered VM has an unknown
allocation. Restarting both services and merely waiting is therefore not a
complete recovery procedure. No estimated outage duration is guaranteed.

## Code transaction

`transaction.py` installs only the 14 modified and 17 added public control
modules in `manifest.json`. It never stops/restarts tasks, removes VMs, changes
configuration, releases secrets, accesses wallets, or publishes an app. It is
one component of activation, not an activation orchestrator.

The CLI's apply/rollback operations require the actual Windows installed control
root. Each mutation is gated by readback that Node, Shield and Update tasks are
disabled and stopped, with no installed node, manager or updater process. It
verifies the 78 unchanged dependencies, all original/absent paths and every
payload byte before its first installed write. Backups and a manifest-bound
journal are saved first. Individual files are replaced via a temporary file in
the destination directory; rollback classifies all files by hash, including a
replacement completed just before a process died without updating its journal.

Rollback refuses changed backups, changed manifests and unrelated later source
changes before restoring anything. It is repeatable. If service quiescence is
lost, the tool stops and leaves the journal for explicit recovery after services
are stopped again. It does not restart a partially changed tree. Unneeded empty
module directories can remain after rollback. Backups contain public code only;
existing task/configuration state needs its own local backup during the future
handoff. This is a coordinated maintenance tool, not a defense against a hostile
administrator or an unrelated updater that ignores the maintenance window.

Read-only inspection is safe while services run:

```powershell
python transaction.py inspect --installed 'C:\Program Files\Enclave\control' --manifest .\manifest.json
.\inspect-activation.ps1 -ManifestPath .\manifest.json
```

After all maintenance prerequisites below are satisfied, the code-only commands
are:

```powershell
python transaction.py apply --installed 'C:\Program Files\Enclave\control' --manifest .\manifest.json --payload .\prepared\control --journal 'C:\ProgramData\Enclave\native-code-backup-v9'
python transaction.py rollback --installed 'C:\Program Files\Enclave\control' --journal 'C:\ProgramData\Enclave\native-code-backup-v9'
```

Never reuse a journal or point the transaction at the whole upstream checkout.
Neither command restores the memory/session state of a retired VM. Rolling back
code still requires a fresh, policy-authorized app launch.

## Handoff work that remains

1. Rehearse the complete task/configuration handoff and its failure paths on
   isolated services. Keep the existing worker, networking, lease relay, storage
   VM, control VM and host boot untouched. Pause the scheduled updater during
   the actual maintenance window; restore its original enabled state afterward.
2. Use fresh read-only inventory and source/configuration hashes to bind the
   exact app and witness affected. Arrange the interruption before performing
   any task stop or VM retirement. Resolve recurring lease/RPC renewal failures
   or establish enough verified lease validity for recovery first.
3. Stop the node's admission/renewal process before retiring only the captured
   managed instances through their owning manager. Require explicit removal
   confirmation and independent VM absence; an unanswered request is not
   removal. This avoids carrying unknown recovered allocations into startup.
   Do not send lease-release transactions or broadly delete Hyper-V VMs.
4. Stop the old manager only after that scoped cleanup. Verify disabled/stopped
   tasks and absent processes. Apply the pinned code transaction and separately
   pinned public native config/release inputs, preserving unrelated configuration
   and the existing CPU/application RAM pools. The configuration transaction and
   its rollback are still to be implemented/rehearsed.
5. Start the manager first and require correct legacy and native pins, worker
   readiness, complete inventory and zero stale reservations. Start the node
   afterward. Require the existing app and witness to regain serving status and
   test their actual paths. If startup fails, restore code and configuration
   while the tasks are stopped, then recover the original deployment using the
   original policy. Do not loop blindly through app restarts.
6. Activate the separate additive API overlay/policy with a tested rollback.
   Its entrypoint, network bundle and old image selection are preserved. Use the
   legitimate catalog, wallet and sealed owner-release path for the new app;
   the fixture catalog/component fetcher is not production evidence.
7. Validate the final provisioned desktop, OpenGL/Vulkan workloads, FreeDoom,
   Firefox, llama.cpp, sd.cpp and local Moonlight before branded public release.
   General graphics still uses trusted CPU Mesa plus bounded masked operations;
   this installer establishes no broader GPU or game-compatibility claim.

## Live allocation difference

The live machine advertises 16 CPUs and 96 GiB of application RAM in a coupled
pool. Consequently a 25% CPU purchase gives 4 CPUs and **24 GiB app / 36 GiB VM**;
a 37.5% purchase gives 6 CPUs and **36 GiB app / 54 GiB VM**. The previous hardware
fixture used a 32 GiB app pool and qualified 6 CPUs with 12 GiB app / 18 GiB VM.
That fixture must not be described as testing the exact production allocation.

The captured host has 120,070,115,328 usable bytes and 12 GiB assigned to the two
unmanaged VMs. Reserving another 16 GiB for Windows/other host work gives a
proposed whole-GiB physical manager pool of 83 GiB. This is a planning calculation,
not an applied setting. Recompute it from current inventory and qualify the
selected allocation before activation; do not silently shrink the existing
96 GiB application pool to match a test fixture.

## Tests

`test_transaction.py` passes 16 tests on Linux and on the actual Windows Python
3.14.5 runtime. It includes a full 31-file apply/rollback in a temporary copy of
the pinned installed tree, a real Windows junction refusal, partial-write and
process-death recovery, source/payload/backup drift, journal preservation and
loss of service quiescence. The live quiescence guard separately refused the
running production tasks without attempting any writes or service actions.

Use `NATIVE_COMPAT_INSTALLED_SNAPSHOT` and `NATIVE_COMPAT_PREPARED` to run the
exact-package case; otherwise that case is explicitly skipped. All filesystem
mutations in these tests occur in new temporary fixture directories. The full
service handoff, rollback after an actual service failure and final app
acceptance remain untested.

## Subsequent live-pool and permanent-release checkpoint

At 17:23–17:25 UTC the exact staged manager launched a separate signed v9 VM
using the live 16-CPU/96-GiB app pools, a 25% purchase, and the proposed 83-GiB
physical pool. The 4-CPU, 400% quota, 24-GiB app allowance and 36-GiB partition
read back correctly. Two fresh app challenges and 26 negatives passed, along
with a fresh host TPM challenge. The real readiness judge verified the document
and correctly refused readiness before owner provisioning. Cleanup removed the
fixture VM and released all reservations. The four production VM inventories,
worker and host boot were unchanged across that run. `hardware-livepool-v9.json`
records this evidence. It does not exercise an owner-provisioned app workload;
the 6-CPU/54-GiB live-pool alternative remains unqualified.

The signed image, three media, bridge, controller and public release/configuration
files now reside in the dedicated permanent directory recorded in
`durable-release-v9.json`. All nine files were rehashed there; configuration
identity and worker protocol/budget validation passed. The directory allows
SYSTEM and Administrators only. Its inactive environment file supplies the new
config pin and release path, but the existing runners do not call it. Source,
runner and configuration hashes and processes remain unchanged. Use this permanent
configuration for the future handoff, rather than the older test-directory config.

The public controller gateway request returned 404. Normal wallet-authorized
artifact upload and actual catalog/component retrieval are still required; the
local fixture fetcher does not establish either. The service/configuration
handoff and rollback gates above remain open.
