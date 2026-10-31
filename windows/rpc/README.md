# Owned RPC lifecycle primitives

These sources are unfinished and are not loaded by the host manager or installed
as services. The finite inert SYSTEM path passed on the actual minipc host at
2026-10-31 00:42 UTC; VM authority and RPC startup remain unimplemented. They do not admit or start a VM. The production activation gate stays
closed until the native worker, independent guardian, durable provider-operation
journal, protected namespace, storage attachment and resource admission pass.

`BoundedWorker.cs` is a C# 5 / 64-bit Windows candidate for running one trusted,
pinned observation or submission worker. It creates an unnamed Job Object with
commit-memory, active-process and CPU-affinity limits and kill-on-last-handle-close.
The process enters that job at creation through `PROC_THREAD_ATTRIBUTE_JOB_LIST`,
before its suspended first thread is resumed. There is no create-then-assign
fallback and no inherited job handle. This avoids leaving a suspended process
outside containment if the supervisor dies during setup.

The primitive uses held process handles and creation time, never a PID lookup for
termination. Normal completion also terminates leftover descendants. A termination
request is followed by an exact process wait and an empty-job observation; timeout
or cleanup failure is reported without claiming death. The caller must keep a
reservation on any uncertain result. Job memory is Windows committed memory, not
an assertion about resident memory or pagefile policy.

Dispatch passes an absolute same-boot monotonic deadline with at most 30 seconds
remaining, capped by the original immutable lifecycle deadline. The worker does
not restart that budget after setup or process creation. The trusted child must
also check its bound contract deadline immediately before submitting any provider
operation. `LocalSuccess` requires known creation/exit identity, exit code zero,
no timeout/failure, observed process exit and an empty job, and confirmed handle
cleanup. A default exit-code field is never a success receipt. Local success still
does not establish a provider fence or VM readiness.

Disposable Windows CI run41137680341 at source f5bb2df8ff8d9967068ca5f5909bef1719761904
compiled successfully and passed all eight inert cases in 2.706 seconds. Cases
cover normal/distinct exit, timeout, memory refusal, descendant cleanup, supervisor
death, invalid executable and expired deadline. The original five-pass/one-fail
run is retained: its fixture incorrectly required a nonzero kill-on-close code.
The corrected fixture observed exact child death at95ms, before natural deadlines.
This is not production-host qualification. Native setup failure paths, target-host
nested jobs and independent guardian integration remain unqualified. It is a low-level trusted primitive, not an authorization boundary:
the caller must independently pin the executable, arguments, environment,
directory, script/module closure and protected ancestor namespace. No production
caller is wired to it. An independent supervisor must bound the primitive itself,
including setup and native calls; its internal stopwatch alone does not prove
those native calls cannot hang. Fresh whole-host admission is required before
even the inert native qualification run.

Killing a local worker does **not** cancel a Hyper-V operation already accepted by
VMMS. Both `ProviderOperationFenced` and `ReservationMayRelease` always return false.
The production protocol needs an exclusive durable start intent before submission,
the exact returned provider operation persisted before acknowledgment, an
independent deadline owner, and a closed start gate. Lost submission responses stay
ambiguous and must never trigger automatic retry. Only settled native operations,
fenced workers and a subsequent original-owned Off/zero-memory observation can
contribute to a release decision; storage writer/export fencing is separate.

Native qualification must cover normal exit, a hung worker, descendants left after
parent exit, supervisor death before resume and during execution, memory exhaustion,
failed job setup, unsupported job-list attributes, nested job restrictions and
forced cleanup failure. It must use inert processes only, independently verify
death, preserve failed evidence and respect a reviewed aggregate resource bound.
No VM, WMI/CIM state-change call, production disk or production credential belongs
in those cases.

Windows API references used for this candidate:

- [Process creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Microsoft SDK job-list constant](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/WinBase.h)
- [Job memory limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)
- [Job accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)
- [Job termination](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)

## Supervisor envelope (hosted CI only)

`EnterSupervisorEnvelope` optionally applies a one-shot private job to the current
process before any `Run` attempt. It retains the noninheritable job handle until
process teardown; there is no detach, close or retry operation. Limits and exact
self membership are checked after assignment. Any failed envelope permanently
blocks subsequent `Run` calls in that process. The fixed choices are128MiB or
256MiB committed-memory limit, four processes including the caller, and CPU1
placement. This is not a CPU-time quota. Descendant jobs consume the same parent
aggregate; their caps must not be counted twice.

The current private-memory snapshot must be at most64MiB before assignment. This
is neither a startup peak measurement nor a hard bound on earlier allocations.
[Microsoft documents that assignment does not examine earlier memory operations](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).
A separate bootstrap reservation and external deadline owner remain necessary.
The candidate does not solve observer-loss termination or provider settlement.
A separate observer job cannot kill an independently scheduled owner merely by
exiting. Task Scheduler duration settings are a potential backstop, not an exact
process-death receipt or a memory limit.

CI run41138722624 at cbe3ac565d6f3e3fc40a37f0c84839b609491fdc passed all11 cases:
eight existing cases inside a256MiB supervisor job plus membership/readback,
one-shot refusal and failed-entry work-gate checks. The observed bootstrap private
snapshot was12488704B; the harness completed in2.956s. Its inner128MiB allocation
test does not behaviorally prove exhaustion of the outer256MiB cap. This is hosted
CI evidence, not target-host or independent guardian qualification.

## Pre-resume binding (hosted CI only)

`RunGuarded` requires a trusted callback after creation-time job assignment and
exact child identity acquisition, while the first thread is still suspended. The
callback receives a borrowed process handle, PID, creation time and original
absolute deadline. It may inspect or duplicate the process handle for an observer;
it must not close or retain the borrowed handle. No thread/job handle is exposed.
Refusal or exception enters exact job termination/wait cleanup without resume.
Late acceptance consumes the original budget and also leaves the child suspended.
`GuardAccepted` records only the caller assertion, not independent observer proof.
`Resumed` records successful ResumeThread; LocalSuccess now requires it.

The callback may block; this primitive does not supply an independent watchdog.
The observer-owned owner job, authenticated handshake, observer-loss/deadline
termination, protected namespace and target SYSTEM qualification are not yet
implemented here. Default Run remains available for existing inert callers;
future guarded owner code must never fall back to it. Five new finite CI cases
cover identity before resume, refusal, exception, late acceptance and null guard.
CI41139614293 at6f876d2af8918ec2d7cb2cd828524e6610caeb57 passed all16 cases
in3.636s, including those five. They do not prove a cross-process observer exists.
The late acceptance case confirmed timeout without resume and exact cleanup.


## Independent owner job candidate

`OwnerObserver.cs` adds a one-shot observer-owned private job distinct from the
observer's own128MiB envelope. Its sole noninheritable owner-job handle stays in
the observer process until OS teardown; the owner never receives that handle.
The gated owner is assigned to the256MiB/four-process/CPU1 job before it creates
children. Assignment readback and exact owner incarnation precede admission.
An independent thread is armed before job setup and terminates the observer at
the original absolute deadline. Closing the sole owner-job handle on observer
exit is the owner-tree backstop, including when the binding thread is blocked.
All native handles are retained until process exit; there is no detach/close API
or concurrent close/query race. This is a finite process-lifetime primitive.

The owner transfers only one noninheritable query/synchronize child handle into
the held observer process. Observer-side validation checks exact PID/creation,
owner-job membership, original deadline and nonce/boot/contract token before
release. The trusted owner rechecks the held observer and original deadline
before returning from RunGuarded's callback. Duplicate acknowledgment loss is
ambiguous: never transfer again or guess which remote handle to close.
[IsProcessInJob accepts limited-query process handles](https://learn.microsoft.com/en-us/windows/win32/api/jobapi/nf-jobapi-isprocessinjob).

The original observer fixture has no production IPC or SYSTEM task entry point. That CI fixture
uses bounded atomic files in its disposable directory and synthetic boot/digest
context; token shape is not authentication or target boot proof. The trusted
owner must have no children before assignment: job assignment does not capture
preexisting children. Bootstrap allocations, task startup, protected paths,
current admission and durable provider settlement remain separate requirements.
Six new finite cases use an external controller holding exact owner/observer/
child handles before intentional observer death: normal release, wrong child
identity, late binding, observer loss before release, observer loss during Run,
and a blocked owner callback interrupted by the independent original deadline.
They are not target qualification until separately executed and reviewed.

The timing validator rejects negative/overflowing origins before arithmetic. A
separate finite helper regression rejects Int64.MinValue/Int64.MaxValue before
arming any watchdog; expected hosted CI count is23 including the original16.

Hosted CI41142703119 atadd959e74fa76cc839455ed8c752bb6c7348aae4 passed
all23 cases (compiler10.483s, harness9.862s). Killing the observer before release
terminated owner+child7ms later; killing it during Run terminated both9ms later.
The blocked callback was terminated by the original2500ms observer deadline
(all exact handles signaled by2513ms), before its natural5000ms return. These
are actual hosted process-death observations, not SYSTEM target admission or
provider-operation settlement.


## Protected SYSTEM inert entry candidate

`InertEntry.cs` is an explicit, finite SYSTEM-only entry point for `owner`,
`observer`, and the inert child. It has no provider/VM/network/DB operation or
arbitrary command argument. Original CLI monotonic timing is validated and an
independent process deadline thread is armed before filesystem or native boot
queries; the immutable contract must contain the same origin/deadline. The
qualification window is at most30s with a5s bootstrap cutoff, not permission to
extend the900s RPC startup policy. SYSTEM primary identity is mandatory.

`ProtectedAttempt.cs` holds every existing ancestor without delete sharing,
refuses reparse points and foreign owner/ACL mutation rights, and requires a
protected SYSTEM/Administrators leaf and file DACL. TrustedInstaller is accepted
only for OS ancestors. Contract and executable are opened read-only with write/
delete sharing denied, bounded and hashed. The fixed UTF-8 line contract binds
nonce, actual native boot GUID, original clock and executable hash to inert-v1.
The boot-query class/layout fails closed on unsupported Windows; it still needs
qualification on the actual target. No synthetic boot identity is accepted here.

Each role consumes its own durable CreateNew record before work. An explicit
protected `admit` message keeps both roles gated until the controller admits the
attempt. Messages are at most4096bytes, flushed and atomically renamed without
replacement; pending files or prior final records prevent replay. Published
incarnations are re-opened, file-ID checked and held read-only. This is not a
provider start journal or a proof of filesystem power-loss durability.

The observer validates the peer's held process incarnation, SYSTEM token and
pinned image path before owner-job assignment. Existing child binding/observer
loss behavior is reused. The entry executable never registers its own task or
admits current host resources. Hosted CI adds exact separate SYSTEM tasks and
negative hash/boot/ACL/write/rename/replay fixtures. Task state and LastTaskResult
are diagnostics only; PASS requires held process handles and explicit results.
No target task, namespace, current physical/pending admission or VM is qualified
by source or hosted results alone.

Hosted CI41147895076 at cd7df8876873f5f30fc259b5891e9b7e48f3fc33 passed
all nine selected SYSTEM-entry checks (compilers1.826s/0.154s, harness1.578s).
Separate SYSTEM owner/observer processes completed in925ms with exact held
process death and explicit success/empty-job receipts. Wrong digest, writable
namespace, wrong boot, held-file write, directory rename and consumed-record
replay were rejected. Direct system-drive owned namespace passed ancestry checks;
the CI gate now publishes a closed pending file atomically. Prior ACL and gate
publication failures are preserved. This is hosted qualification only; target
resource/namespace admission and durable provider/VM integration remain absent.

## Managed target qualification controller

`InertQualification.cs` is the explicit operator-only controller for a finite
SYSTEM owner/observer qualification. It has no VM/provider mutation path. The
controller enters its128MiB envelope and arms its original30s deadline before
WMI/COM reads. Task creation retains the original5s bootstrap cutoff.
`ProtectedAttempt.PinController` separately requires a nonimpersonating primary
administrator and holds the entire validated namespace and exact image/contract
BEFORE scheduling. The normal child constructor still always requires SYSTEM.

Target mode requires a root-pinned resource observation no older than300s, same
boot/physical host, and matching LIVE listener PID/creation/executable identities.
Its fixed62,709,039,104-byte threshold includes39388MiB possible app growth,18GiB
host floor,1GiB variation and960MiB for qualification roles/controller/bootstrap/
transport. These bootstrap/transport allowances are not hard memory caps. This
qualifies only the inert task, never the proposed20GiB RPC stack.

A PowerShell wrapper was rejected before task creation in actual CI41149421939
because interpreter bootstrap exceeded the64MiB allowance. Its exact source and
failure remain in the evidence. The managed replacement passed hosted integration
CI41149985211 at2d0970a3aa02761f45c1980d2d79db942157c9dd in1.166s
(controller1.022s), without cap or timeout changes. Hosted mode is explicitly
disposable-CI-only and uses3GiB headroom; it is never a target admission substitute.
Actual target invocation b9d2f1cb6c744aff8e7e5608a6a3aed6 passed in3.130s,
with hostedCi=false, separate SYSTEM roles, exact process exits, explicit owner
success/observer empty-job receipts and associated task cleanup. It used the
parent-clock-bound source c2f513dd0d05d4d64eced238ac0d6525fd951360 and
independently hashed artifacts from CI41151421474. No VM/provider call occurred.
This supersedes earlier historical statements that the inert target path was
unqualified; it does not admit VM memory, provider operations or the RPC stack.

## Provider start transaction

`ProviderStart.cs` is a separate unactivated library. A prepared intent, exclusive
submission marker and native-call marker prevent automatic resubmission after a
lost return. Returned local job references are persisted before queries or ACK;
job incarnation changes, failed writes and uncertain provider states stay held.
The actual Hyper-V adapter has only a fixed local RequestStateChange(2) operation.
No production entrypoint calls it. `IStartRuntime` still requires a real guarded
VM authority/admission implementation. `OwnedVmPermit.cs` now binds the original
VM, boot, image, admission digest, 900-second deadline and proposed whole-stack
budget to a held protected namespace. Journal reopening uses a separate short
worker lease; reconciliation cannot create intent/submission/native/response
records. This is source integration, not a live guardian or native VM admission. See [provider integration](PROVIDER-LIFECYCLE.md).
CI41152666323 passed22 fault/adapter cases; provider calls were fake, so this
is not native VM-operation qualification. CI41152911185 then passed25 cases, including bounded post-startup reads
without extending the original start deadline.

CI41154097230 passed37 cases including original25 and12 VM permit/reopening
cases. Native protected-file access was exercised; provider calls were fake.
First run41153903059 compiled but failed after29 cases because administrator
controller writes attempted SYSTEM owner assignment. That failure is retained;
explicit administrator pins now use Administrators record ownership, while
SYSTEM worker pins retain SYSTEM ownership and the same protected DACL.

## Guarded provider worker (not activated)

`ProviderWorkerEntry.cs` connects the start/read transaction to separately
scheduled SYSTEM owner/observer roles and a suspended child. Its explicit
provider-worker profile is rejected by the original inert constructor. The owner
persists the exact child-bound intent before releasing the work gate. The real
`IStartRuntime` implementation holds and rechecks owner/observer/self process
identities, protected release records and immutable VM binding. Reconciliation
retains the original submitter identity.

Start also requires a distinct live pinned SYSTEM VM guardian and original
900-second armed/bound records. That guardian producer and native VM lifecycle
are still unfinished; this entrypoint has not been activated.
`WindowsStartAdmission.cs` requires current node commitments and complete current
manager reservations before and after native host checks, within two seconds.
Missing legacy reservation fields refuse admission; stable PIDs or historical
free memory cannot substitute for current pending commitments. This remains a
read-based check, not an atomic host reservation.

The fixed provider adapter additionally requires an exact Msvm_Memory row proving
zero current allocation before starting the owned Off VM. These native provider
schema/semantics still require target qualification. Hosted qualification uses
only a synthetic VM permit: one real SYSTEM read-held path and one exact guardian
image-mismatch refusal, with no valid native start guardian or VM creation.

Hosted CI41155763134 qualified the actual new SYSTEM worker composition: one
response-lost-held read and one exact guardian-image-mismatch start refusal, with
known owner/observer exits, empty owner job and associated task cleanup. It also
retained37 transaction tests and passed6 pending-authority parser cases. No valid
native guardian or actual VM was supplied. The earlier fixture compilation error
in41155564998 is retained; the worker entry had compiled successfully. These
results do not qualify current target capacity, native provider operations or the
900-second VM guardian.


The explicit guardian entry now pins the original 900-second VM permit and owns a private kill-on-close job containing both gated start-worker roles. It publishes the one-shot binding before opening their gate. Guardian death or the original deadline kills that local worker group. The guardian storage profile cannot write provider records or act as a short journal lease. This is local start containment only: Hyper-V may outlive its submitting worker. The guardian does not itself settle provider operations or stop the VM; those require the separate cleanup worker described below. Automatic cleanup scheduling, storage fencing and reservation release remain unimplemented; all release/fence flags remain false. No production activation is supplied.


The v2 VM permit explicitly includes fixed owned-VM disable and reconciliation; v1 start-only permits are rejected rather than silently gaining stop authority. The guarded worker now has separate `stop` and `stop-reconcile` operations. They require the original startup deadline to have elapsed, exact original start child/observer death on the same boot, and settlement of the exact persisted start operation. Unknown start responses remain held. Stop has independent immutable intent, exclusive submit/native markers, returned-reference persistence and exact job reconciliation. Preparation alone may resume only for an exact complete intent while every submission/outcome record is definitely absent. Cleanup journal scope cannot write start authority; stop-reconcile cannot submit stop.

The fixed native adapter uses `RequestStateChange(3)` only for the exact original owned VM, then independently observes Off and zero assigned memory under a current read guard. It never saves or deletes a VM. These implementation paths remain unqualified against real Hyper-V; automatic cleanup scheduling, export/write fencing and reservation release are still missing. All release/fence flags remain false. Microsoft documents Disabled(3), v1-only ShutDown(4), returned asynchronous job references and warns that repeated requests can overwrite earlier requests: https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/requeststatechange-msvm-computersystem . Cancellable is not a cancellation guarantee: https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-concretejob .
# Shared physical reservations (source integration; not activated)

`HostPhysicalPool.cs` serializes all enrolled allocators through one pre-created
protected Windows `pool.lock` opened with `FileShare.None`. The immutable
`pool.txt` binds a pool nonce, actual host boot and total capacity in bytes. It
must be provisioned and enrolled by the host owner after a fresh capacity review;
the library never creates an empty ledger to recover from a missing one.
Capacity is a configured shared ceiling, **not measured free RAM or proof of fit**.

Claims bind the configuration hash, boot, allocator role, operation identity and
integral MiB amount. Claims are durable before acknowledgment. A separate durable
dispatch record is consumed before a native start. An identical acquire can be
read again after a lost response; it cannot grant another dispatch. Partial or
unknown records, conflicting claims, a different boot, and over-budget ledgers
refuse admission. Kernel lock-owner death permits another transaction but never
releases a durable reservation. There is deliberately no timeout-based release,
automatic reset, cancellation assumption or provider-fence claim.

The RPC runtime reads `sharedPhysicalPool` from the immutable reviewed
`admission.json`: exactly `schema: "host-physical-pool-binding/1"`, `configPath`,
`configHash`, and `capacityBytes`. It acquires its entire permit budget, including
support, and the fixed native provider adapter consumes that reservation
immediately before `RequestStateChange`. Existing host/pending/guardian checks
remain required. Pool configuration does not bypass them.

The native RPC adapter also reads the exact realized VM setting's associated
`Msvm_MemorySettingData` before and after consuming the dispatch. It requires
static guest RAM equal to the permit, matching reservation/limit and MiB units,
automatic allocation enabled and no swap file in use. Missing settings or a
different configured size refuse before the native call. This check follows the
[Microsoft memory-setting schema](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-memorysettingdata);
the real target's WMI behavior remains unqualified.

The maintained Windows app manager has an optional trusted local
`physicalReservations` adapter (`poolHash`, `boot`, `acquire`, `consumeStart`).
It holds its local physical reservation before awaiting the shared acquire,
rechecks local identity/capacity after each await, and consumes a dispatch before
`backend.start`. Spawn bodies cannot choose or shrink this claim. Uncertain
acquire, dispatch, or native outcomes retain reservations.

`PhysicalPoolCommand.cs` and the manager's `physical-reservations.mjs` provide
the fixed local command transport. The maintained manager entrypoint accepts an
all-or-nothing operator configuration: `ENCLAVE_PHYSICAL_POOL_COMMAND`,
`ENCLAVE_PHYSICAL_POOL_COMMAND_SHA256`, `ENCLAVE_PHYSICAL_POOL_CONFIG`,
`ENCLAVE_PHYSICAL_POOL_SHA256`, and `ENCLAVE_PHYSICAL_POOL_BOOT`. No request body
can supply these values. The only accepted executable is
`physical-pool-command.exe` beside the manager's own transport module. Before
enabling these pins, enrollment must verify the **entire existing manager code
installation**, helper file and ancestors: SYSTEM/admin ownership, protected
mutation rights, no reparse points or untrusted parent replacement. This is a
deployment prerequisite, not a property proved by a hash check or by the child
checking itself after launch. An unprotected source checkout is not eligible.
The command validates its protected image and the
pool namespace, uses a 128 MiB post-entry job, and arms an independent original
five-second deadline before native setup. Reserve another 64 MiB for bootstrap;
this allowance is not a pre-entry hard cap. Each manager allows one command in
flight. A timeout/unknown worker poisons that client and retains all claims.
The helper never creates, starts, stops or releases a VM. Transport success
requires the exact command process to close successfully with a matching
operation, nonce, boot, image and claim. A kill request is not death proof.

**Remaining activation work:** this transport needs actual target qualification
and enrollment. The installed managers do not use this ledger, existing VM
and pending commitments have not been seeded, and no production pool exists.
Qualified reclaim requires conclusive provider settlement, original-owned Off,
and relevant write fencing; there is no reclaim API yet. An optional adapter or
passing isolated ledger tests does not establish that every real allocator uses
the same pool. No target VM, service restart or capacity admission is authorized
by this source alone.


Native manager enrollment compatibility (2026-10-31): the maintained manager
now has optional pinned native-instance admission, fixed native VM scope, and an
explicit native-24g-in-32g-v1 sizing profile supplied to both reservation and WMI
allocation. This preserves the installed 24-GiB app / 32-GiB partition exception;
the generic default is unchanged. Hosted 80-case qualification includes fake
Hyper-V definitions, not target capacity or activation.

Do not replace the installed manager/router from this tree yet. The installed
router uses the same exception in its pending journal, while the maintained
generic default remains 36 GiB for a 24-GiB app. Its explicit profile still needs
propagation when repackaging the router. Installed CPU share/guest quota and WMI
processor readback behavior also require reconciliation. A legacy manager restart
loses relay/readiness state and the node retires recovered VMs, so stopping a
listener is not a guest-preserving upgrade or a release of its reservations.

### Retained legacy template fence candidate

`LegacyTemplateFence.Apply` durably denies content reads on one exact protected
VMGS master after writing a consumed intent. It changes no template bytes and
has no unfence API. Parent handles, object identity, single-link count, hash,
boot, finite deadline and protected DACL are checked. Denial persists after
worker exit; an ephemeral exclusive lock alone would reopen old creation when
its holder dies. A lost response remains held, never retried or rolled back.

The captured old launcher hashes and copies this master before DefineSystem;
preflight reads metadata only, and existing VMs use independent run copies.
This candidate ONLY blocks future reads on that exact object. Prior copies,
definitions, starts and native provider jobs are NOT settled by it. Every old
master/issuer and new-master distinct object must be qualified on target; no
production wiring or activation is provided. Existing-operation accounting,
shared pool seeding and durable front-end transition are still required. Do not
use its receipt as the router admission callback or as permission to release RAM.

The `rpc-template-system.yml` qualification compiles an explicitly selected
`TEMPLATE_FENCE_QUALIFICATION` entry/controller pair. It exercises the maintained
read barrier as a separately scheduled SYSTEM owner/observer child against fixed
four-byte files inside its protected attempt only. Default inert binaries retain
their prior behavior. The fixture accepts no target paths or operations and leaves
its consumed intent and denied dummy file intact. This establishes neither complete
old-issuer coverage nor settlement of preexisting native starts. Production master
files remain untouched; target-context qualification still needs fresh admission.

Inherited template rules are copied to explicit rules before adding the read deny.
Readback compares the exact DACL bytes and protected flag plus unchanged owner/group,
not inheritance-history flags in the enclosing descriptor. Windows documents the
assignment normalization in [ACE inheritance](https://learn.microsoft.com/en-us/windows/win32/secauthz/ace-inheritance).
The changed ACL operation requires both the original 13-case regression and the
fixed SYSTEM inherited/untrusted-rights fixture before target qualification.

`LegacyLaunchCohort.ApplyAndDrain` is the concrete memory-only transition cut for
one shared old master and one or two pinned direct-PowerShell manager issuers.
It holds the exact issuer PID/creation time/image, captures and holds their shell
children before the fence, applies the persistent barrier, and captures again
afterward. It waits for those exact process handles to signal, within the original
10-second operation window. It does not kill managers or launch children. Any
capture, identity, wait or deadline failure retains the fence and consumed intent;
there is no automatic retry or rollback. The caller must independently supervise
the worker and qualify complete installed issuer/config/module coverage.

The exact installed `hyperv.psm1` and `utilities.psm1` show no hidden start or retry:
New-CustomVM defines and configures the VM; later JavaScript continuations issue
Start-VM against its returned GUID. The utilities helper polls only JobState4 and
can return for a different nonterminal state with ErrorCode0, so a successful helper
return is NOT provider settlement. Successful outer definition JSON nevertheless
requires the already-existing GUID and configured-memory readback. After the cut,
reserve ALL defined VMs' configured maxima (including Off/Starting), unresolved
claims and overhead before admitting RPC. Later successful JS continuations are
covered by those GUID reservations; a late definition with a dead failed caller
has no path to a later JS Start. No reservation is released on API absence or a
missing provider job. This argument is same-boot and specific to the pinned old
mandatory fresh-copy path, not a general Hyper-V cancellation guarantee.

`rpc-legacy-cohort.yml` qualifies the changed process-cut implementation with
bounded disposable Windows children and dummy files. It does not enumerate target
VMs, establish loaded issuer coverage, seed the shared pool or activate production.

### Protected legacy handoff entrypoint (candidate)

`LegacyHandoffController` publishes a separately typed immutable contract and starts
`LegacyHandoffEntry` as independently scheduled SYSTEM owner/observer processes.
The exact held child, owner and observer identities, original deadline and one-shot
release must agree before `LegacyHandoff` runs. This does not reuse the inert or
provider contract profiles.

The explicit `legacy-memory-inspect-v1` operation reads loaded manager bindings and
all realized VM maximum memory twice without changing the template, VMs or pool.
The distinct `legacy-memory-cut-v1` operation additionally requires held source
inputs and exact native issuer creation times, consumes the handoff, applies the
persistent template barrier and waits for the captured direct PowerShell cohort.
Failures retain intent and any applied barrier; there is no automatic retry or
rollback. All receipts continue to deny provider settlement, capacity admission,
reservation release and pool seeding. Existing managers stay alive.

The controller accepts exactly:
`--target entry.exe entrySha nonce operation observation.json observationSha handoff.json handoffSha origin deadline`.
It checks fresh physical/listener evidence before scheduling. The finite operation
retains the original 30-second controller deadline and five-second bootstrap gate;
this is not the RPC's separate 900-second startup admission. The handoff manifest
is `legacy-memory-handoff/1` with exact boot/topology/master/issuers/inputs fields.
The operator must independently establish complete old-issuer and source coverage;
a digest-shaped manifest alone is not that evidence.

The read-only entrypoint passed actual target SYSTEM inspection in 9.260 seconds,
with five complete static VM records totaling 18,301,845,504 bytes (17.044921875 GiB),
following 17 hosted contract/memory checks. This proves that specific inspected
context and schema, not a production cut, shared-pool seed or RPC allocation. The
cut still requires complete pinned legacy source coverage and fresh admission.

Actual target inspection exposed a dormant 1TiB `Limit` on each static VM. The
updated result schema `/2` accounts fixed `VirtualQuantity` only after explicitly
refusing dynamic memory and contradictory quantities; it publishes all raw quantity,
reservation and limit fields with the accounting rule. This follows Microsoft's
[Msvm_MemorySettingData documentation](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-memorysettingdata).
Future explicit memory modification needs a new admission; this receipt does not
reserve every possible privileged operator reconfiguration. Neither inspected nor
post-cut rows grant admission themselves.

### Conditional NTFS ancestor custody

The legacy handoff candidate now has a separate `AncestorCustody` check for ordinary metadata/create permissions on a non-leaf ancestor such as `ProgramData`. Ordinary `ProtectedAttempt.Authority` is unchanged. The exception requires a local fixed NTFS volume, a native handle-relative open of one immediate child, matching volume/object identities, no reparse points, a protected SYSTEM/Administrators-owned child DACL, and retained no-delete handles. Only the ancestor WRITE_EA/WRITE_ATTRIBUTES bits receive conditional treatment; deletion, delete-child, owner/DACL mutation and generic-write/all remain refused. Both input pinning and template fencing use the same proof and recheck it. This candidate is not target-qualified or activated.

The Windows fixture uses a genuinely restricted token, verifies actual metadata/EA access, supplies successful empty junction and privileged symlink controls, checks protected nonempty refusal and delete/rename refusal, and verifies that child deletion remains denied after handles close. It also exercises the template fence on disposable bytes. A successful source fixture is not production filesystem admission, and the proof does not claim availability against a trusted administrator or kernel/filter compromise. The protected child must keep the absolute legacy master pathname bound; relative file opens alone would be insufficient.

Primary API references: [NtCreateFile relative RootDirectory](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile), [restricted token access checks](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken), and [NTFS reparse restrictions and directory/name-surrogate bits](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points).
