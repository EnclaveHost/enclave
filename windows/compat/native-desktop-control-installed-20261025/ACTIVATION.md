# Native desktop control activation

Status: **preparation only; production native activation has not happened**.
The API transaction accepts an integer per-image SVN floor from 13 through the
uint32 maximum, allowing the signed SVN15 candidate without weakening the original
minimum. Its manifest and additive-policy checks still pin the exact new image and
preserve every existing image. Apply/rollback tests cover both the historical SVN13
payload and the SVN15 payload; invalid types and floors below 13 fail before writes.

The 23:16 UTC inventory now contains the Sia storage application and the readiness
witness. The historical retirement and recovery allowlists name the earlier upload
adapter. They are not a current maintenance plan and must not be used to retire
Sia. Its current ownership, persistent storage and recovery path must be reviewed
before changing the shared production manager.

The code, runner-file and API-file transactions are tested. On October 25,
19:09–19:21 UTC, the combined Windows task/configuration handoff passed normal
activation, manager-start failure, and partial-launch recovery in isolation.
All six transactions rolled back, and the final 19:23 readback verified 109
code paths and both runners. Production task/process/VM snapshots were unchanged.
See [the rehearsal scope](qualification/COMBINED.md) and
[its qualification record](qualification/combined-v9.json). Admissions and VM
operations were simulated; production recovery and owner desktop acceptance
remain required. This is not an unattended production activation procedure.

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

1. Preserve the qualified task/configuration handoff and failure recovery order
   demonstrated by the isolated rehearsal. Keep the existing worker, networking, lease relay, storage
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
   and the existing CPU/application RAM pools. `runner_config.py` provides the narrow two-file configuration transaction
   and fixture-tested rollback described below. The combined service handoff
   passed with isolated SYSTEM tasks and simulated VM operations; actual app
   recovery still requires verification during the maintenance window.
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
mutations in these tests occur in new temporary fixture directories. The combined
isolated service handoff subsequently passed all three scenarios, including an
injected manager exit before its listener opened. Hardware failure recovery and
final owner-provisioned app acceptance remain untested.

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
local fixture fetcher does not establish either. The isolated service/configuration
handoff is now qualified; production maintenance, recovery, and acceptance gates
above remain open.

## Runner configuration transaction

`runner_config.py` prepares exactly two inserted lines per runner: a CALL of the
permanent `native-desktop-env.cmd`, immediately followed by `if errorlevel 1 exit
/b 1`. The call follows the existing base-config CALL and precedes the service
loop. The captured custom RPC/gateway settings, command paths, logging and mixed
line endings remain byte-identical. The three original base configuration files
are only hash-checked, never copied or rewritten by this tool.

The prepared manifest pins both before/after runner files and six unchanged
inputs: three base configs plus the permanent native config, release identity and
environment file. Preparation validates the capture and release identity. Apply
independently strips the proposed hook and requires the reconstructed original
hash, so a modified RPC setting cannot be hidden behind an updated payload hash.
Only `run-node.cmd` and `run-shield.cmd` can be modified; arbitrary paths and added
files are rejected. The existing code transaction supplies atomic file replacement,
backup verification and interrupted-apply recovery. Both apply and rollback require
Node, Shield and Update tasks disabled/stopped with their processes absent. The
live guard was called read-only and refused the running services without writes.

Preparation takes the public runner capture, config hash/size inventory and
permanent release metadata. It does not read private base-config contents:

```sh
python runner_config.py prepare --capture runners.json --config-pins config-pins.json \
  --release durable-release-v9.json --environment native-desktop-env.cmd --output new-runner-preparation
```

During an authorized, rehearsed maintenance window, after the service controls
have stopped and disabled the three tasks, the runner-file commands are:

```powershell
python runner_config.py inspect --installed 'C:\ProgramData\Enclave' --manifest .\prepared\manifest.json
python runner_config.py apply --installed 'C:\ProgramData\Enclave' --manifest .\prepared\manifest.json --payload .\prepared\payload --journal 'C:\ProgramData\Enclave\native-runner-backup-v9'
python runner_config.py rollback --installed 'C:\ProgramData\Enclave' --journal 'C:\ProgramData\Enclave\native-runner-backup-v9'
```

Neither transaction starts services. Restore both code and runners before starting
the original stack after a failed activation. Keep distinct journals for the code
and runner transactions. Retired VM memory/session state is not restored by either.

`runner-config-v9.json` records 16 passing tests on Windows Python 3.14.5 and 13
passes plus three Windows-only skips on Linux. Temporary fixtures use the exact
captured public runners, copies of public release files and synthetic base configs;
no private production configuration is copied. The live read-only inspection
checks the actual six config pins. Real `cmd.exe` tests execute only the inserted
hook against a disposable environment copy and a harmless probe. They prove
successful propagation of all five native values, preservation of an existing
variable, and refusal to launch the probe after a missing or failed environment
script. A marker before the hook prevents a broken test launcher from counting as
a successful refusal. Actual production runners, scheduled-task restarts and app
recovery are not exercised by these fixture tests.

## API overlay transaction

`api_overlay.py` applies exactly eight modified API modules, four new modules and
the public Shield policy. Four dependencies must stay byte-identical: the API
entrypoint, network bundle, package manifest and lockfile. It uses the same
backed-up atomic replacement and interrupted-transaction recovery as the control
transaction, with a separate journal on the Linux API host. It neither reads nor
backs up private environment files, signer seeds, wallet keys or mutable app state.

The prepared v9 policy has SHA256
`74d7e5d2e992dfb974904fb5e125191307213029c15512ed39de57efec61e5ba`.
All 12 existing image entries and every other existing policy field are preserved;
one native image and one matching desktop release are added. The adapter checks
that additive relationship independently of the payload hash, requires native SVN
13 and verifies agreement between the image and desktop release identities.
Do not use the older v4 policy hash from the original relay-overlay manifest.

Apply and rollback require root on the actual Linux `/` filesystem and the exact
`enclave-api-relay` unit loaded, inactive/dead, with MainPID 0, KillMode
`control-group`, and its expected service user/group. Before each write it also
requires root-owned 0755 source/policy directories and root-owned 0644 files,
rejecting symlinked paths. The tools issue `systemctl show` only; stopping and
starting the service are explicit maintenance operations outside the transaction.
They do not silently stop a live API to make an installation succeed.

Use the exported `native-api-activation-v9` evidence directory. It includes the
exact `prepared/manifest.json`, 13-file payload and public baseline used by the
tests. The manifest SHA256 is
`9d23f546807e10ed6341d26a453e6ab52e1d28f91f12da32170d8330d1e92ca8`.
The corresponding API fixture archive is separately hashed in `api-overlay-v9.json`.
Stage this reviewed package in a new root-owned directory outside `/opt/nan-relay`
and `/etc/nan-relay`. Inspect the live files first:

```sh
sudo python3 api_overlay.py inspect --installed / --manifest prepared/manifest.json
```

Every changed path must report `before`, and dependency/metadata validation must
pass. A changed production baseline requires investigation, not regeneration of
the expected hashes to accept it. The API source tests described by the earlier
relay-overlay qualification still apply; these transaction tests do not replace
the source or sealed-release tests.

After the full service handoff has been rehearsed and the shared-service
interruption arranged, the API-specific maintenance sequence is:

1. Capture the API unit state, actual app-route results and fresh lease validity.
   Keep a root-only journal location on the same host. Quiesce any independent
   updater for these files. Do not proceed while lease/RPC instability prevents
   meaningful verification of recovery.
2. Explicitly stop only `enclave-api-relay`. Its current stop timeout is three
   minutes. Wait for the stopped-state readback; a timeout is not permission to
   write or force-kill unrelated processes. Do not start the inactive old relay.
3. Apply from the pinned staged directory:

   ```sh
   sudo python3 api_overlay.py apply --installed / --manifest prepared/manifest.json --payload prepared/payload --journal /var/lib/native-api-backup-v9
   sudo python3 api_overlay.py inspect --installed / --manifest prepared/manifest.json
   ```

   Require all 13 changed paths to report `after`. The journal path must not
   already exist; never delete or reuse a previous journal to bypass this check.
4. Explicitly start `enclave-api-relay`. Require a new running PID, stable restart
   count, correct on-disk hashes, `/health` JSON `ok: true`, and restoration of the
   same real app paths observed before maintenance. `/health` alone only proves
   the relay handler is alive. Actual fresh attestation and the new app's normal
   catalog/owner-release flow remain separate required checks.
5. If application/startup verification fails, stop that same unit and restore
   from this transaction's journal:

   ```sh
   sudo python3 api_overlay.py rollback --installed / --journal /var/lib/native-api-backup-v9
   sudo python3 api_overlay.py inspect --installed / --manifest prepared/manifest.json
   ```

   Require all paths `before`, then start and verify the original service. If
   rollback refuses unrelated drift, leave the service stopped and investigate;
   do not overwrite the drift or start a mixture of modules. An incomplete
   apply may already have restored the original bytes automatically; inspect
   the journal and readback before choosing recovery. Repeating rollback is safe.

The API is a separate transaction boundary from the Windows code and runner
journals. API rollback restores its public policy and modules only; it does not
undo Windows activation, preserve live API connections, revive retired VM memory,
release leases, provision an owner or publish an app.

Seventeen API transaction tests pass both locally and in temporary fixtures on
the actual Linux API host (Python version recorded in `api-overlay-v9.json`).
Coverage includes exact 13-file apply/repeated rollback, failure after rename,
process death before journal advancement, service restart during an apply,
corrupt backups, source drift, attempts to edit legacy policy, forbidden paths,
metadata and symlink refusal. A separate read-only call to the real guard refused
the running production API. All 17 source/policy/dependency checks and service
PID/restart readbacks matched before and after. No production service was stopped
and no real service activation/rollback was exercised. Combined handoff, recovery
and final desktop acceptance remain open.

## Scoped retirement and scheduled-task rehearsal

`retire_managed.py` supplies the narrow retirement step between stopping Node and
stopping Shield. `prepare` accepts the read-only activation inspection and binds
the two reviewed app/witness records to their manager epoch, manager PID/start
time, manager instance IDs, names, app IDs and Hyper-V IDs. It refuses additional
apps, unready records, unmatched host inventory or an unverified code baseline.
The initial plan must be prepared from a new inspection during maintenance
preparation; the historical plans in the evidence are not current authorization.

```powershell
python retire_managed.py prepare --inspection inspection.json --plan retirement-plan.json
```

After the interruption has been arranged, disable Update, disable and stop Node,
and confirm the node/updater processes are absent. Keep the original Shield task
and manager alive for scoped removal. The retirement command checks those
conditions itself; it never changes a task's state:

```powershell
python retire_managed.py retire --plan retirement-plan.json --journal 'C:\ProgramData\Enclave\native-retirement-v9.json'
```

It rechecks the process identity, manager epoch and full manager inventory before
each request. It sends DELETE only to the fixed loopback manager endpoint, without
proxies or redirects, for the reviewed app first and witness second. A successful
HTTP response must contain `ok: true`. A subsequent manager listing and independent
successful `Get-VM` enumeration must both establish absence before the journal
marks that target complete. No `Remove-VM`, lease-release, wallet or signing
operation is part of this tool. Concurrent maintenance by another operator must
still be excluded: the installed DELETE endpoint has no atomic epoch precondition.

A failed request, missing response, epoch change, unexpected new record or failed
host enumeration halts the sequence with a `needs-inspection` journal. It does
not retire the next target, start services, guess that a timeout means removal,
or automatically repeat an uncertain request. A lost response can mean the VM
was actually removed; inspect the owning manager and Hyper-V before recovery.
An existing journal is never overwritten/reused. This journal records retirement;
it cannot restore a guest's memory/session state.

After both targets are explicitly confirmed gone, disable/stop Shield and use
the already-tested code and runner transactions. Start the updated manager before
Node. Before enabling Node, require the new epoch, empty attributed inventory,
`canStart: true`, `desktop.ready: true`, the exact v9 identity hashes, the unchanged
16-CPU/98304-MiB app pools, physical pool 84992 MiB, zero allocated CPU/GPU/physical
memory, and the expected worker readiness. If startup fails before Node is enabled,
leave admissions stopped, restore both file journals under their stopped-task
guards, and start the original manager before Node. Restore Update's captured
enabled state only after verification.

Failure after Node is enabled requires a new inventory and a recovery plan for
the instances that the new manager created. The original retirement plan must
not be reused. The initial retirement preparer intentionally refuses partial or
unready inventories; `recover_managed.py`, described below, handles reviewed
partial records under the updated manager. Do not stop a manager with ambiguous
managed instances and then assume their reservations/relays can be recovered by
restarting. Combined file/task handoff and real app recovery remain unqualified.

`qualification/rehearse-task-lifecycle.ps1` was executed on NucBox with three
disposable SYSTEM scheduled tasks in a separate task folder. Harmless Node
workers ran through CMD loops shaped like the installed runners. Five recorded
steps exercised original startup, stopping admissions while the manager stays
alive, stopping the manager with no remaining descendants, refusal after a failed
environment hook, and restoration with manager-before-node ordering. All fixture
tasks/processes were removed without needing an explicit process kill. Production
process/task/VM inventories matched across that 18:09:31–18:09:45 UTC rehearsal.
The script refuses reuse of its fixture directory/task path and never executes
the real production runners. It is task-lifecycle evidence, not VM or app recovery.

Eleven retirement tests pass locally and on Windows Python 3.14.5. They use the
actual hash-pinned installed Manager/HTTP server with a simulated Hyper-V backend:
they prove protocol handling and refusal boundaries, not hardware removal. The
real Windows guard also refused the running production Node/Update tasks. The
first Windows fixture run failed because stdin used CRLF; the fixture parser was
corrected, and the final run passed with zero remaining fixture processes. The
failed run is retained in the evidence. `handoff-boundaries-v9.json` records pins
and the scope of both rehearsals.

At 18:17 UTC the production code pins still matched and the node/manager retained
their original PIDs/start times. The application VM had nevertheless changed from
`3b3a309a-7d6c-4ee4-bf68-e6d0ddd858fe` to
`3adac528-f53f-48fb-a445-11533476e688`. Node logs show RPC renewal failures followed
by automatic lease-expiry retirement at 18:11:30, after the task rehearsal ended.
The replacement was app-ready at inspection. This is another continuity exception,
not a claim that production availability was uninterrupted or that the RPC cause
has been established. Lease/RPC reliability still needs resolution before a
controlled cutover and meaningful recovery acceptance.

## Cleanup after a failed updated-manager launch

`recover_managed.py` provides the scoped removal component of rollback after Node
has been started. It requires the updated control hashes, Node and Update already
disabled/stopped, and the exact updated manager process still running. It accepts
zero, one or both of the existing reviewed app/witness records. It refuses new
apps, launching or recovered records, duplicate identities and unknown ownership.
This scope is the maintenance handoff before the new desktop app is published;
it is not a general cleanup command for arbitrary marketplace apps.

Capture new evidence with both inspection scripts beside each other:

```powershell
.\inspect-activation.ps1 -ManifestPath .\manifest.json -ExpectedState after | Set-Content -Encoding UTF8 recovery-inspection.json
python recover_managed.py prepare --inspection recovery-inspection.json --plan new-recovery-plan.json
python recover_managed.py recover --plan new-recovery-plan.json --journal 'C:\ProgramData\Enclave\native-recovery-v9.json'
```

The plan binds manager epoch/process, record ID, deployment name, app ID, instance
ID and host VM ID. A failed launch may retain its VM handle privately while its
public record has no VM ID. `inspect-managed-inventory.ps1` independently decodes
only public manager ownership fields from candidate VM Notes, so that case can be
bound without guessing a name. It also handles confirmed host absence, including
a launch that never created a VM. Bare/malformed ownership markers, an unmarked
`enclave-app-` name, an orphan VM or conflicting ownership all prevent removal.
Unrelated Notes are never exported. The complete unrelated VM ID set is checked
before and after each request; any change stops the sequence.

Every DELETE goes through the still-owning loopback manager, which holds the
worker, egress and launcher handles. The helper never directly deletes a VM or
controls tasks, leases, wallets, code or configuration. HTTP success must be
followed by manager absence and independent host absence. Completion additionally
requires zero allocated CPU, physical RAM and GPU reservations. A host removal
followed by bridge-cleanup failure remains an uncertain failed record; a successful
reply with a surviving VM is also a failure. Neither permits the next removal.

Failures leave a `needs-inspection` journal with the interrupted phase and the
confirmed completed targets. Existing journals cannot be reused. After a lost
response, inspect fresh manager/host state and prepare a new plan only when all
remaining ownership is unambiguous. A restarted manager, orphan VM, running launch
or unknown allocation requires investigation; this tool does not bypass those
refusals. DELETE still has no atomic epoch/VM-incarnation precondition, so exclude
concurrent operators and keep admissions disabled throughout maintenance.

Only after cleanup reaches `cleared` may the maintenance procedure stop/disable
Shield, verify all service descendants absent, roll back the runner and code
journals, and start the original manager before Node. Restore the captured updater
state after actual app/witness route checks. This procedure recreates instances;
it cannot restore guest memory or an interrupted session.

`recovery-boundaries-v9.json` records 20 recovery tests on Linux and Windows Python
3.14.5 against the actual staged Manager/HTTP source with an in-memory Hyper-V
boundary. The tests exercise retained private handles, actual manager ownership
survey, no-VM launches, partial/empty inventories, reservation release, failed
cleanup, lost responses, stale epochs and unrelated VM changes. Eight PowerShell
inspection checks cover empty/single inventories, decoded ownership, redaction
and malformed candidates. Initial Windows fixture failures exposed array-wrapping,
mock-variable scope and test-expression grouping issues; those failed logs are
retained alongside the passing run. Live inspection separately verifies the
original 109 source/absence pins, the two public ownership bindings and unchanged
process identities. The updated-state inspection correctly fails against the
unmodified production tree. No production DELETE or task operation was executed.
These are component tests; combined service/file handoff, actual failed-launch
hardware cleanup and final provisioned app acceptance remain to be qualified.
