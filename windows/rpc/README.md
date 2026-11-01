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

The legacy handoff candidate now has a separate `AncestorCustody` check for ordinary metadata/create permissions on a non-leaf ancestor such as `ProgramData`. Ordinary `ProtectedAttempt.Authority` is unchanged. The exception requires a local fixed NTFS volume, a native handle-relative open of one immediate child, matching volume/object identities, no reparse points, a protected SYSTEM/Administrators-owned child DACL, and retained no-delete handles. Only the ancestor WRITE_EA/WRITE_ATTRIBUTES bits receive conditional treatment; deletion, delete-child, owner/DACL mutation and generic-write/all remain refused. Both input pinning and template fencing use the same proof and recheck it. The corrected full92-input read-only inspection passed on the actual SYSTEM target in invocation94d3fe70c1f04440a14f4952c6849e72:10300ms, exact controller and owner/observer cleanup, all pins unchanged. It exercised the real ProgramData ancestry and returned the same five static VMs totaling18301845504 bytes. CI41174301972 also passed31 cases. This qualifies installed namespace inspection; no production template fence, shared-pool seed or RPC allocation was activated. See `ops/unified-funding-20261028/rpc-legacy-handoff-input-pin-inspect-r3/ROOT-RESULT.md`.

The Windows fixture uses a genuinely restricted token, verifies actual metadata/EA access, supplies successful empty junction and privileged symlink controls, checks protected nonempty refusal and delete/rename refusal, and verifies that child deletion remains denied after handles close. It also exercises the template fence on disposable bytes. A successful source fixture is not production filesystem admission, and the proof does not claim availability against a trusted administrator or kernel/filter compromise. The protected child must keep the absolute legacy master pathname bound; relative file opens alone would be insufficient.

Primary API references: [NtCreateFile relative RootDirectory](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile), [restricted token access checks](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken), and [NTFS reparse restrictions and directory/name-surrogate bits](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points).


### Cut-to-pool initialization (unactivated candidate)

The separate `legacy-memory-cut-seed-v1` operation requires a schema2 handoff
manifest with an exact pool plan. Legacy inspect and cut retain their previous
authority. The new operation pins a distinct replacement master before denying
reads on the old master, performs the existing real cut/drain and repeated VM
inventory, and initializes a fresh protected root-level pool in the same worker.
It does not consume an inspect result or accept arbitrary JSON as proof of a cut.

The plan binds physical bytes, a non-pool reserve, at least18GiB host floor,1GiB
variation,39388MiB prospective app growth, exact capacity and a fresh namespace.
Actual WMI physical/free-memory observations must fit both before the cut and
after inventory. Per-GUID Msvm_Memory resident allocations must agree on both
sides of each host observation; absent allocations are unknown, not zero.
Configured-but-not-resident RAM is charged against free memory, and only actual
resident guest bytes are credited when checking the non-pool reserve. Every configured VM gets a deterministic claim and consumed
dispatch. The pool config is published after all initial records; complete
readback precedes activation. A separate completion digest follows the final
fence, issuer and resource checks. Consumers must require both activation and
completion, not the pool config alone. Partial initialization remains held with
no reset, retry, deletion or capacity-release API.

A held metadata handle rechecks the original fenced object and protected read
denial during initialization. This still does not prove provider settlement.
The completed-handoff RPC admission consumer is implemented below. Production
routing integration remains incomplete; source qualification alone does not
authorize a production cut, pool or new VM.

Changed Windows CI41175423495 at379e067d928a passed44 cases in1.110s,
with compiler1.485s. All19 compiled source pins and three executable hashes were
independently checked. The fixtures include actual disposable pool files,
consumed start records, interrupted initialization and missing final completion.
They do not query native Hyper-V guest residency or authorize target activation.
See `ops/unified-funding-20261028/rpc-legacy-handoff-ci-execution-r6/ROOT-RESULT.md`.

The separate read-only `legacy-memory-resident-inspect-v1` operation now exposes
the exact native residency projection used by cut-seed fit. It accepts only the
existing schema1 handoff manifest and never constructs a seed plan or applies a
fence. Complete per-GUID native Msvm_Memory rows bracket an OS memory sample;
changed rows, missing rows, wrong native types and samples over2s fail closed.
The controller rechecks the bound sample's GUID coverage, static maxima and all
byte arithmetic. The query selects only canonical GUIDs from the complete VM
inventory: an unfiltered `Msvm_Memory` query also returns physical-host memory.
The response still must contain every requested VM exactly once.

Actual target SYSTEM invocation97e35eeb7b59405bbea2cf9becf27bc1 passed in11.687s
at source2eafe081bea36e07de1f9f5297602f71c7976ff7, following57 hosted checks.
All five native resident rows matched the separate `Get-VM MemoryAssigned`
observation:18,301,845,504 bytes assigned/configured, zero latent bytes in this
sample. The protected sample reported83,787,870,208 bytes free and
17,980,399,616 bytes used outside the VM allocations. These are observations,
not a persistent allocation or permission to start RPC. Both earlier native
refusals and the diagnostic packaging/fixture failures remain preserved.
Target images now exclude the test harness and remain under the original256KiB
protected-input limit. No production fence, pool seed, VM start or RPC cutover
occurred. See `ops/unified-funding-20261028/rpc-legacy-resident-inspect-r3/ROOT-RESULT.md`.

### Completed handoff admission (not activated)

RPC admission can explicitly bind a `legacyCutSeed` object with schema
`legacy-cut-seed-admission/1`, the exact historical contract path/hash, producer
image hash, manifest hash, activation hash, and creation mode
`retained-fenced-rpc-only/1`. It also binds the existing `sharedPhysicalPool`
configuration. A completed seed now labels this mode in schema`legacy-pool-seed/2`.
This mode rests on the reviewed installed creator closure and actual persistent
cut; it does not infer authority from empty listeners or missing health fields.
The old admission mode still requires complete current manager reservations.

The runtime reopens historical evidence read-only under the current short worker
lease, without renewing the old deadline or enabling writes. It retains protected
completion/manifest/cut/cohort/inventory records, exact original issuer handles,
pinned source/replacement files, the old master denial and seeded claim records
through the final pre-submit guard and native invocation. Pool checks allow only
the initial consumed claims and this exact RPC claim, including repeat checks
after its acquisition and dispatch. Additional app or RPC claims refuse admission.
The RPC claim covers the full20GiB proposal; a defined but nonresident RPC guest
is not charged a second time as a legacy allocation. Native residency and current
physical fit are rechecked; no historical RAM sample becomes a standing permit.

This path authorizes no new app creator, manager restart, claim release or reset.
Enabling an app creator requires a separate enrolled transition. CI41178310807 compiled the full composition and passed71 tests, including
producer/consumer schema, historical read-only lifetime and repeated pool claim
checks. It did not execute a full production completion or native start. The
production cut, new VM boot, storage, client readiness and consumer cutover remain
unperformed.


### Ordinary Gen2 definition transaction (not activated)

`OwnedVmDefinition.cs` implements the fixed local definition transaction for the
planned ordinary Generation2 Ubuntu RPC guest, separate from app type1 firmware.
It records the returned system/job before observations, preserves uncertain
submissions without retry, and derives the actual GUID only from returned evidence.
The original startup clock survives definition and permit publication. It requests
static19GiB and4vCPU, no autostart/checkpoints, host shutdown and Linux Secure Boot,
then requires exact owned Off/zero and configuration readback.

This is a VM-shell stage. Boot/seed hashes are bound in the plan but attachment,
network/boot order, protected production entry/controller and independent failure
cleanup integration remain unfinished. No caller may treat defined-owned-off as
boot preparation, start authorization or RPC readiness. Hosted Windows CI41179297393 passed32 fault tests at source f58bec134.
Compilation took1540ms and the harness230ms; all7 compiled-source pins matched.
Provider calls were fakes: native property support/readback, actual VM creation
and production integration remain unqualified. No native VM has been created.


### Protected definition worker (hosted qualification passed)

`DefinitionWorkerEntry.cs` and `DefinitionWorkerController.cs` connect the Off-only
definition transaction to independently bounded SYSTEM owner/observer/child roles.
A separate immutable definition plan retains the original900s startup deadline.
The pre-definition capacity path requires the actual completed legacy cut and
exact initial pool/inventory. It never fabricates a VM GUID or zero pending work.
Definition allocates no resident RAM; the existing start path must acquire and
consume the full20GiB claim after the real GUID is returned.

The controller does not attach media, start a VM or publish a start permit.
Reconciliation cannot resubmit creation. Hosted CI41180149841 passed45 tests and compiled the13-file production worker
and controller separately; both are211968B. Existing handoff regression CI41179944577
passed71 tests. Fixtures exercised protected files under hosted Administrator,
not actual SYSTEM worker scheduling or DefineSystem. Production activation, native
settings and startup remain unqualified. Original failed fixture/compile attempts
are retained in the corresponding evidence packages.


Startup cleanup integration (not activated): `StartupCleanupController.cs` is a
separate SYSTEM process armed before the native start. The start worker holds its
exact PID/creation/image/SYSTEM identity and refuses submission without it. The
controller retains the original 900-second deadline and dispatches only the
existing stop/reconcile worker after expiry; its own watchdog ends at D+30s.
That cleanup allowance never extends start authority. A stop requires exact
original submitter death, settled native start, and fresh owned Off/zero evidence.
Lost native responses stay held; this is not a guarantee of shutdown under an
unknown start operation, cleanup-process failure, or stalled provider. Claims
are never released by this controller. No new start, refund or deletion exists.

The controller adds an explicit 192 MiB (128 MiB process plus 64 MiB startup)
reservation beyond existing admission overhead. An optional immutable operator
adoption binds the exact original permit, start intent/receipt and report digest
within the original startup window. This is an explicit owner decision, not
automatic proof of RPC readiness. Invalid/unreadable adoption is refused once;
diagnostic failure cannot disable cleanup. No automatic adoption producer exists.

Hosted qualification compiles the actual controller/entry and exercises original
deadline boundaries, adoption refusal and independent watchdog process death.
This does not qualify target SYSTEM scheduling, actual Hyper-V stop behavior,
boot/media configuration, RPC sync/finality or production consumer cutover.


The definition worker now accepts explicit `boot` and read-only `boot-reconcile`
operations against the same original definition plan. It requires an already
settled, exactly owned Off/zero definition and a `bootNetwork` object in the
hashed admission: schema `owned-rpc-boot-network/1`, canonical `switchGuid`, and
an explicit local-unicast MAC (`02` followed by ten uppercase hex digits). It
attaches the fixed owned `boot.vhdx` and `seed.iso`; paths cannot be supplied as
arbitrary per-operation arguments. Initial content hashes come from the original
definition plan. The worker streams verification within its existing deadline,
then retains exact file identities without DELETE sharing; the no-WRITE-share
hash handle closes to allow legitimate provider metadata writes while Off.
The strict existing file authority check remains unchanged. A changed file
identity, unqualified ACL, lost response or missing returned resource stays held.

The fixed order is SCSI controller, disk drive/media, disk-first firmware order,
seed drive/media, synthetic NIC, then its exact switch connection. A provider
created default SCSI controller is accepted only after unique owned readback.
No name-based resource recovery, automatic resubmission, VM Start, Save or Delete
is implemented here. Every stage must settle before its returned reference may
become the next stage's parent. Boot configuration is not guest boot/readiness,
and does not authorize a start or release a memory claim.

Native recipe references: [Microsoft AddResourceSettings](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/addresourcesettings-msvm-virtualsystemmanagementservice)
and [Microsoft Generation2 SetBootOrder sample](https://github.com/microsoft/Windows-classic-samples/blob/main/Samples/Hyper-V/Generation2VM/cs/SetBootOrder.cs).
Target WMI defaults/property support, VM disk access, converted boot image/seed
provenance, actual boot, current network reachability and integrated cleanup/start
registration still require qualification. No target VM has been changed.


The actual start worker independently requires `BootStartBinding` before physical
claim acquisition and again immediately before native Start. It binds the original
protected definition, complete boot graph, initial media file identities and
hashed network admission, then rereads the exact owned Off VM and attached graph.
A controller ready flag alone cannot authorize the start. The complete boot
transaction and this binding compiled in hosted qualification with83PASS; the
changed provider worker also passed its start/stop/pool/transport and negative
SYSTEM-role regressions. Boot tests use fake Hyper-V providers. Target WMI/ACL
behavior, actual boot and the aggregate two-second native graph read remain
unqualified. Production startup orchestration and actual artifacts are still
required; these results do not establish RPC availability or20GiB workload fit.


`StartupController` now composes the real startup path. Its explicit `--target`
entry binds the existing definition's canonical returned VM GUID, original permit
clock and exact provider/cleanup image hashes. It holds the protected definition
namespace before one-shot publication, arms independent SYSTEM cleanup and checks
its actual held process identity before scheduling the guardian and gated worker
pair. Only the guardian publishes the work gate. Independent cleanup/guardian
jobs are retained if the short controller exits or fails. No automatic retry,
claim release, readiness claim or original deadline extension is provided.

Hosted qualification compiled the actual provider, cleanup and startup images
and passed20 fixtures, including the real definition producer's encoded output
and actual protected-file custody/refusal. This has not run the complete startup
on the target host. The exact binaries belong to one compilation bundle; they
must be bound in the original definition/admission before any target operation.
Initial admission charges84,385,202,176 bytes free, including the20GiB proposal,
prospective apps,18GiB reserve, variation and transient role/controller overhead.
Older host measurements cannot admit this run. Media preparation, actual target
WMI/ACL behavior, boot, RPC workload fit/sync/finality and consumer cutover remain.

`build-boot-media.py` prepares a fresh standalone dynamic VHDX and NoCloud seed
inside an independently bounded Linux unit. Its configuration pins the source
image and tool binaries, uses a new exclusive output directory, enforces memory,
disk and time limits, compares logical disk contents and extracts the seed for
byte-for-byte verification. It accepts a public SSH key only; it neither creates
a VM nor changes a live host's packages. The source image remains unchanged.

The actual first preparation on the existing Control guest completed in24.35s
under512MiB/one CPU/no swap. Logical comparison and seed readback passed. The
VHDX file is1,933,574,144 bytes with3,758,096,384 virtual bytes; the seed is378,880
bytes. Tools were downloaded at exact reviewed Ubuntu package versions and
extracted privately, with no installation, upgrade or service restart. The local
host's proposed preparation allocation had failed its pending-aware floor check;
the Control guest had separate measured capacity and continuous guards. These
are verified media artifacts, not target boot or RPC readiness evidence. Protected
Windows staging now passed full-file hashes and native Get-VHD readback: standalone,
dynamic, unattached, with the same virtual and file sizes. The duplicate Control
preparation images were reclaimed after exact checks; the original Warden cloud
image and verified Windows copy remain. No blockchain database was copied to C:.
Current physical/disk/pending admission, integrated startup and the storage path
remain required. Public evidence is in `ops/unified-funding-20261028/rpc-boot-media-build-r1`
and `ops/unified-funding-20261028/rpc-owned-media-stage-r3`.

The operator-authorized removal of one large Steam game subsequently cleared the
Windows boot-volume constraint:147,354,484,736 bytes free at the recorded read.
This is disk-capacity evidence only; fresh complete memory/pending admission and
actual integrated boot remain required. See
`ops/unified-funding-20261028/nucbox-game-space-recovery-r1`.

Startup disk protection now charges the full4GiB boot envelope,256MiB metadata
allowance and16GiB volume floor at admission. During startup the independent
cleanup controller samples the held original boot file and system-volume free
space on a background thread. A failed or more-than-two-second-old sample
latches an abort; the supervisor does not wait on a blocked native read.
The protected abort permanently refuses new start gates and terminates only the
exact original guardian, closing its local worker group. Early cleanup still
requires exact original guardian/submitter/observer death and native start
settlement before an exact-VM Stop; a lost response remains held. Neither the
900-second start deadline nor reservation-release rules change. The early stop
worker gets at most29 seconds, bounded by the original cleanup deadline.
This is an operational startup guard, not a filesystem quota or proof against
arbitrary unrelated disk writes. Explicit operator adoption ends this startup
monitor and requires a reviewed ongoing-host lifecycle; it is not automatic.
Actual target monitoring/early Hyper-V stop are not yet qualified.

### Current activation package boundary

The current target bundle includes separately pinned legacy handoff, ordinary
VM definition, provider, startup and cleanup executables. Each keeps its exact
compiled-source revision and image digest. The handoff target excludes the
unrelated inert qualification entrypoints; the original 256KiB input limit
still applies. The actual hosted final handoff suite passed71 cases, and the
ordinary definition/boot suite passed83 cases. These tests use fake provider
calls and do not establish native target readiness.

The original `build-boot-media.py` output was an Ubuntu disk and SSH-only
NoCloud seed. It is historical and must not be used for the current RPC trial.
The replacement client image from `rpc/guest/inject_image.py` and private
40-file seed from `rpc/guest/prepare_seed.py` are staged on the target. The seed
includes storage attachment, activation delivery and mount/client startup
handlers. No live activation or runtime request is installed by staging.

The second prepared transition package binds this replacement media through
exact paths, sizes and whole-file digests, plus the independent seed and Windows
custody verification receipts. Its seven executables and handoff manifest are
unchanged from the first package; each executable retains its own compiled
source revision. `MEDIA.json` is preparation evidence, not current admission.
See `ops/unified-funding-20261028/rpc-target-transition-package-r2`.
The original 900-second startup clock remains unassigned. Fresh host and storage
admission, protected media copy into the original definition namespace, actual
guest attachment/mount/client startup, RPC sync/finality and consumer cutover
remain required. Starting the shell VM is not a successful RPC trial.
The allocator transition must not be treated as completion of app recovery or
independent hosting: its initial mode admits only the reserved RPC claim.

### Private guest-media staging

The client image comes from `rpc/guest/inject_image.py`; its separate seed comes
from `rpc/guest/prepare_seed.py`. A credential-bearing seed is private, including
its extracted user-data and readback. Never put those artifacts in Git or public
artifact hosting. Staging them does not install a live activation request or
start a VM, storage attachment, mount, or client.

`stage-private-media.ps1` creates a new exclusive namespace and precreates empty
media files under protected administrator/SYSTEM access rules. The operator
first copies a harmless mode0600 probe through the same authenticated `scp -3
-p` pipeline, then runs `probe`. This checks actual resulting file permissions,
the unchanged empty media slots, the persisted specification, and the original
manager incarnation. Only after success may the operator copy the boot image
and private seed. `verify` checks exclusive-handle hashes, lengths, private
access rules and standalone VHDX metadata. Verification never repairs an ACL
after transfer. Four in-memory refusal cases cover foreign read, write, full
control and inherit-only grants; they do not widen any real file permissions.

The base64 specification is public metadata: nonce, host boot time, original
manager identity, and exact source paths/lengths/whole-artifact digests for
`boot.vhdx`, `seed.iso` and `custody-probe.bin`. The new namespace is derived
from the nonce. The source files must already be verified, owner-only regular
files. Each phase is one-shot in the operator journal; failed or ambiguous
transfers retain their directory for inspection rather than retrying. Local
SSH/SCP timeout or exit does not prove remote process death. Preparation has
its own resource checks and is not RPC startup admission; the complete guest
and storage workflow still requires independent lifecycle and capacity checks.

### Clock sample for the cross-host startup window

`ClockSample.cs` is a read-only executable taking exactly three arguments:
`<credential-attempt-hex32> <VM-attempt-hex32> <image-sha256>`.
It arms a dedicated five-second termination thread at entry, enters the existing
128 MiB self job, verifies its image bytes, and returns one
`owned-rpc-windows-clock/1` JSON object using the same native boot identifier and
monotonic clock as the controllers. It creates no children, tasks, files, VM or
provider operations. The job does not bound allocations before assignment;
bootstrap and SSH/collector resources require separate admission. Loading an
image and checking its path hash do not prove namespace custody: the reviewed
binary must first be staged and independently checked in a protected target
namespace. The sampler does not qualify SYSTEM controller execution.

`rpc/sample_windows_clock.py` sends one request through explicit, pinned SSH
configuration. It consumes `sampling.intent` in the existing private begin
journal before transport. A timeout, malformed reply, wrong boot or wrong attempt
leaves that attempt held, with no retry. The complete handshake must fit in the
original ten-second allowance; the returned sample completes the existing
900-second clock rather than beginning another window. Local transport exit is
not remote death. Only the original operation can consume the resulting clock.

The dedicated `rpc-clock-sampler.yml` workflow compiles the exact source closure
and exercises normal output, invalid identities, wrong image, wrong arity and a
blocked-main-thread watchdog case on a disposable Windows runner. Hosted results
must be recorded separately from target qualification; this source addition alone
does not stage or run the sampler on NucBox.

Hosted run `41238669296` completed six cases successfully at runtime source
`e3215df25010cf69f003ffc8756691732d625ae7`. The blocked-main fixture exited
through its native watchdog in 5.031 seconds. The sampler binary is 44,544 bytes,
SHA-256 `57c35df39b752694a9cd420b84eed6c1f800c0331c2442dbe8fb743eacaf03f6`;
all three compiled source pins were independently checked. This is CI evidence,
not target namespace, SYSTEM execution or actual cross-host handshake evidence.
See `ops/unified-funding-20261028/rpc-clock-sampler-ci-r1/ROOT-RESULT.md`.

The first NucBox qualification wrapper refused before starting the sampler:
PowerShell exceeded the existing bootstrap private-memory allowance. Its failure
is retained; no cap or floor was relaxed. `ClockQualification.cs` replaces that
wrapper with a compiled controller using the same fixed five-second entry
watchdog and 128 MiB self job. It holds and validates namespace ancestors before
exclusive lease creation, pins both images, observes four original manager
incarnations through query/synchronize handles, and preholds the sampler process
handle through its exit. The production build retains the 62,709,039,104-byte
free-memory threshold; it performs no VM, provider, task or allocator mutation.
A separate compile-time hosted-CI build uses the disposable runner's 3 GiB floor
and omits production manager identities. Those omissions never enter the target
build. Target qualification still requires fresh complete external admission.

Actual NucBox admin-context clock qualification now passed using the production
controller (CI run41239666927, runtime69effc9). The parent self128MiB job reported
13,266,944 bytes of bootstrap private memory; its child returned a native boot
and monotonic sample inside the held303ms observation interval and exited0.
All four original manager handles stayed live. A separate exact-PID/creation
read subsequently found both parent and child absent. The immutable qualification
contract and intent are consumed and must not be replayed. This does not qualify
SYSTEM lifecycle execution or start a production900s clock, VM, exporter or RPC.

Manager incarnation inputs must use the exact decimal FILETIME read from a held
process handle. CIM CreationDate loses the final100ns digit; converting that
display value back into FILETIME caused the retained native refusal. Correcting
the input required no comparison tolerance, cap/floor change, or controller
rebuild. See `ops/unified-funding-20261028/rpc-clock-target-qualification-r3/ROOT-RESULT.md`
and the retained r1/r2 failures and independent exit-read-r1 evidence.

### Protected transition files

`TransitionFiles.cs` implements fixed `collect-cut`, `stage-inputs` and
`copy-media` operations for the owner transaction. Its command is
`--target OPERATION NONCE BOOT ORIGIN DEADLINE SELF_SHA256`, followed by one
bounded JSON request on stdin. It requires an admin token, exact native boot,
protected executable custody, the retained 62,709,039,104-byte physical-memory
threshold, a fresh worker lease of at most 30 seconds, and the immutable original
900-second window. A dedicated native termination thread is armed before stdin
or file work. Its self job is 128 MiB/CPU1; the 64 MiB bootstrap check is a
snapshot, not a prior-allocation or peak hard limit. Complete current external
admission must include its bootstrap and transport commitments.

Collection holds the exact completed cut files and compares the activation to
the native seed object already returned by the cut controller. Staging accepts
only observation and optional definition files, creates an exclusive namespace
with protected ACLs atomically, and verifies the bytes after writing. Copying
holds both protected namespaces and source handles, rejects any foreign read
grant on private media, requires the original definition journal, and refuses
existing destination media or attachment/start intents. It writes an exclusive
copy intent, streams with 64 KiB buffers, flushes and hashes destination readback,
then publishes completion. Partial copies remain consumed; it never repairs
source ACLs, overwrites files, retries or deletes evidence.

Copying retains a 16 GiB disk floor, 256 MiB artifact allowance, remaining copy
bytes and boot growth up to 4 GiB. It checks this before copying and at most
every 8 MiB of progress. This helper performs no provider call: its definition
journal binding does not prove the VM is currently Off. The boot worker remains
responsible for exact original-owned Off/zero verification before attachment.
No file operation establishes provider fencing or reservation release.

The hosted workflow builds production and a separate compile-time CI variant.
The variant requires a disposable GitHub runner and uses its 3 GiB floor; this
branch is excluded from the target binary. Fixtures contain only dummy media
and synthetic definition/cut records, never VM or production-data activation.
The first run41241600916 compiled production successfully but the CI variant
compiler received a malformed PowerShell argument. The harness grouping was
corrected without changing native source or limits; the failed run is retained.
Target staging and execution remain separate qualifications.

Hosted run41241922430 at runtimeabef7a2 passed all nine cases. Production and CI
compiles took2036ms and182ms; the blocked-stdin case exited124 through the native
watchdog in1496ms without an external kill. The dummy copy covered32796bytes.
The production executable is68608bytes, SHA-256
`2114ef029e5f5f8ec3b448edb8124b753dc641eb24b8825ee1124be95e8903d9`;
its hash and all three compiled source pins were independently recomputed.
This qualifies the hosted fixture operations, not target execution, a full-size
private copy, live VM state or RPC readiness. See
`ops/unified-funding-20261028/rpc-transition-files-ci-r2/ROOT-RESULT.md`.

The production file helper is now staged and hash/ACL verified at
`C:\EnclaveRpcFiles-495a41c7dda146ab9b27b54b7fce61a8\495a41c7dda146ab9b27b54b7fce61a8\transition-files.exe`.
An actual admin-context, nonproduction clock-and-stage qualification passed with
its128MiB self job and13414400-byte bootstrap private snapshot. Its worker lease
was736968000..736998000ms within the original900-second clock. A separate exact
PID/native-creation read confirmed the helper absent, with no sampler/helper at
the qualified paths and all four original managers and VMs unchanged.

Only `stage-inputs` has this target execution evidence. `collect-cut` and
`copy-media` retain hosted dummy-fixture evidence; full-size private copy and
actual provider/guest composition remain unqualified. The qualification input
namespace and owner attempt are consumed. Do not replay them or infer current
admission from the historical resource observation. See
`ops/unified-funding-20261028/rpc-files-target-qualification-r2/ROOT-RESULT.md`
and `rpc-files-target-exit-read-r1` beside it.

The native inert fixture preparer `test/rpc-windows-worker/PrepareFileFixture.cs`
replaces the failed PowerShell fixture setup. Hosted run41244651758 passed five
new cases: preparation, replay refusal, wrong-boot refusal, and its dummy journals
and media through unchanged collect/copy operations. The production executable
is 58368bytes, SHA-256 `f28d7deb9c9685aed2031e0133d94bfa97e506cadcf935b0a001452c190feff3`.
It is compiled but not target-qualified. It arms an independent native watchdog
before envelope/file work, retains the128MiB self job and64MiB bootstrap snapshot
allowance, and creates only fresh marked synthetic journals and tiny dummy media.
The hosted variant has an explicit CI-only resource floor. No VM/provider work
or production readiness is established. See
`ops/unified-funding-20261028/rpc-file-fixture-ci-r1/ROOT-RESULT.md`.

Actual NucBox admin-context qualification now covers `collect-cut` and
`copy-media` using the production helper with fresh synthetic journals and
32800bytes of dummy media (32768-byte boot plus32-byte seed). The native fixture
preparer and both workers entered128MiB jobs, completed within the original
clock, and were separately confirmed absent by exact PID/native creation. All
four original managers and VM identities/states/assigned memory were unchanged.
This does not prove a full-size private copy, live definition or attachment,
SYSTEM lifecycle, guest boot, or RPC readiness. The original failed PowerShell
fixture and its consumed attempt remain preserved. See
`ops/unified-funding-20261028/rpc-files-collect-copy-target-r2/ROOT-RESULT.md`.


## Exact VM endpoint reader (hosted fixtures qualified; target unqualified)

`VmEndpoint.cs` adds a read-only administrator entrypoint:
`vm-endpoint.exe <vm-permit.txt> <permit-sha256> <image-sha256> <worker-origin-ms> <worker-deadline-ms> <required-free-bytes>`.
The caller must first qualify protected executable staging and independently
admit bootstrap/transport/registration overhead. The native reader requires the
retained18GiB floor,39388MiB prospective commitments and256MiB reader allowance;
a higher supplied threshold is retained. It arms an independent native watchdog
before its128MiB/CPU1 self envelope or WMI/file work; bootstrap snapshot must be
at most64MiB. This does not prove prior allocation or peak bounds.

It pins the original protected VM permit/boot/source journal, retains the
original900s and a fresh worker lease at most30s, and reuses the full configured
boot graph readback with Running required. Existing start `Verify()` still
requires Off. The fixed NIC's `Msvm_SettingDataComponent` association supplies
`Msvm_GuestNetworkAdapterConfiguration.IPAddresses`. It checks the graph and
addresses again within an aggregate2s interval. One canonical unicast IPv4 is
returned; none means pending, multiple or changing candidates refuse. No subnet
scan, guessed address, hostname lookup, start/stop or provider mutation occurs.
[Microsoft association documentation](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-settingdatacomponent)
explains this read-only NIC association.

The receipt is a host association observation, not guest authentication,
attestation, RPC readiness, remote death or reservation release. A guest-provided
address must still pass the separately seeded pinned SSH/boot identity check;
the complete driver must preserve receipt freshness and exact original lineage.
Hosted run41246416745 compiled the84992B reader and passed13selector checks,
38boot lineage regressions and an independent blocked-main deadline test.
The held process exited124 in1027ms. No real WMI/VM lookup was exercised.
The native Running path still needs actual target-context qualification within
the original owned startup. Existing staged binaries are unchanged. Results
and prior failures are retained in `ops/unified-funding-20261028/rpc-vm-endpoint-ci-r3`.

### Deployment inventory equality and unknown memory

The startup/definition reader preserves absent and null `memMb` values separately
from numeric zero when comparing reviewed and current node inventories. Legacy
queued, refused and stopped rows can lack this field. Running or isolation-held
rows with unknown memory still refuse admission. This receipt compares identity,
status, memory and isolation flags; it never supplies a capacity estimate or
replaces complete pending reservations or a verified completed allocator handoff.
The 39,388 MiB prospective allowance and all physical floors are unchanged.
Hosted checks passed at runtime `09e10c405fdaeba36b0fe70aab689fe0ad1b0417`: 40
startup cases and 83 definition/boot cases. Five corrected executables are staged
and independently hash/ACL verified in `EnclaveRpcTransition-8fd1a2cc4ef5432cbbaabaa77efbbed0`.
The corresponding `rpc-node-inventory-target-stage-r1/BINARY-BINDINGS.json` replaces
the old definition/provider/startup/cleanup paths in the launch inputs. The old
handoff pair is unchanged and does not call this reader. Target execution and
RPC readiness remain unproven; no production startup clock has begun.

Definition worker roles now attempt a private `owner.failure`, `observer.failure` or `child.failure` receipt when an exception escapes after the protected contract opens. The receipt binds the contract, exact process identity and original deadline; type/message are base64 and bounded to128/512characters. Existing protected WriteOnce custody,4096byte bound and deadline apply. Failure to publish (including expiry) preserves the original exception and never retries. No provider settlement or reservation release follows. This addresses missing SYSTEM task stderr; pre-contract errors or hard deadline termination may still have no receipt. These private diagnostic records must not be published.

`DefinitionWorkerController --target ... admission-check ...` is an explicit
read-only diagnostic for an existing immutable definition plan. Its separate
`owned-rpc-definition-admission-v1` contract additionally pins a fresh admission
observation in the worker namespace. It uses the same independently supervised
SYSTEM roles and unchanged capacity/freshness/completed-cut checks. The child
branches before provider construction; its held definition journal rejects
all writes. It may inspect an expired plan under a current short reader lease,
but cannot renew that plan, define/start a VM, acquire a new claim, replay the
allocator cut, or release any reservation. Only private diagnostic journals and
owned temporary task/process control are written. Successful output says
`admission-observed`; it is not a reusable production admission or RPC readiness.

Actual target admission-only qualification reached the node comparison and refused with `Node commitments changed since review`. All three exact SYSTEM workers subsequently exited; the four original VMs and original8091 remained. No definition/start was submitted. This exposes a current admission blocker; the original production failure had no detailed receipt and is not retrospectively proven to have the same cause. See `ops/unified-funding-20261028/rpc-admission-only-target-execution-r1`.

With a verified completed allocation cut, historical node comparison treats
`failed` and `claiming` as the same retry state only for unchanged IDs with known
positive memory and no isolation, held allocation or failed retirement. Those
states can churn while the persistent allocation fence prevents new legacy VMs.
All other statuses and all memory/identity/isolation fields remain distinct.
Unfenced admission retains exact equality. Completed-cut admission now applies
the same narrowly scoped retry equivalence to initial and final live receipts,
with the retained cut and pool checked before the first comparison and after
the last. The user-authorized aggregate observation bound is four seconds. Pending growth, physical floors, cut
custody and shared-pool verification remain mandatory and unchanged. Unknown
memory on a claiming record is refused. This does not admit a new allocation
or treat a historical snapshot as current capacity.

The fenced historical retry comparison passed hosted startup 50 and definition 93 cases at `69d6d76af0d2e8515fdc63252e2770da05231e5e`, but the subsequent actual SYSTEM admission-only check still refused `Node commitments changed since review`. This comparison change is not target admission qualification. Exact compared field differences still need private bounded diagnostics; production remains unstarted and the consumed original attempt/cut must not be replayed.

Admission comparison failures now include bounded detail from the exact two compared receipts: total changed rows, first ordinal identity, field bitmask (status1, memory-presence2, memory4, isolation8, held16, retire32, missing identity64), and both projected rows. Long values are represented by SHA-256; unrelated host payload is excluded. This detail follows the existing private failure receipt path and does not change equality or perform a second observation.

With the bounded difference diagnostic added (`00eb826ae11898fdabc58f48e79d48dd9f0ea48b`), hosted startup 57 and definition 93 cases passed. A subsequent actual SYSTEM `admission-check` also passed, with exact role death independently observed and the four original VMs unchanged. No difference receipt was generated, so earlier mismatches remain unexplained. This is a passing admission observation only: no definition/start/release authority, no renewed original startup window, and no automatic replay of the completed allocation cut. The production driver still needs explicit verified adoption of the existing cut for a separate successor attempt.

A successor definition can bind `unsubmittedPredecessor` (`owned-rpc-unsubmitted-predecessor/1`, exact old worker contract path/hash and reviewed producer hash). Before each definition admission the worker opens both prior namespaces read-only, verifies same boot, distinct new VM identity, expired original 900-second window and enclosed short worker, exact pinned old executable, all three distinct role incarnations dead, exact consumed plan/submission, and absence of native/invoke/outcome markers including pending files. A native marker or uncertain process death remains held. This does not release the old reservation. The maintained Python owner now implements explicit retained-cut adoption and successor lineage (see `rpc/README.md`), with simulated owner composition tests. New seed/media/profile preparation and actual target qualification remain required before another production attempt.

The admission reader now uses native physical-memory/disk calls and held query/synchronize process handles, replacing four serial WMI reads. The listener/PID query remains WMI. Native boot identity must match the original protected plan and observation. Exact native process creation times are cross-bound to WMI's microsecond timestamp, then compared at full native precision. All handles stay held through the final admission check. The aggregate two-second window, original deadline, pending/capacity floors and exact node/listener checks remain enforced; timeout receipts identify the stage and elapsed time. This change requires hosted qualification and read-only target SYSTEM admission before another production attempt; the failed 25eecdee successor remains consumed.

Failed-successor recovery now follows the newest predecessor contract through every prior plan’s immutable admission observation, up to eight distinct consumed definitions. Every node retains the original expired window, exact role death and absent native/provider marker checks. All reads use the current independent short deadline; old execution authority is never renewed. Cycles, duplicate worker/VM/root identities, overlapping intervals and longer chains refuse. Local owner composition requires the chronological pinned `retainedCut.successors` list and verifies each intermediate adoption. Hosted source83f6793f passed68startup and111definition cases, including six new chain-state refusals. The full recursively held expired900s chain still requires target execution through the gated definition path; no new VM or provider submission is authorized by fixture results.

The subsequent actual third attempt `5a1f71bc826e4c5abf0166938d448c68` reached definition provider preparation after the predecessor/admission gates, then failed `SYSTEM primary execution context required`. Both `definition.native` and `definition.invoke` are present, with no returned provider receipt. Exact worker death and exporter cleanup were observed, the four original VMs stayed unchanged, and no boot/start/guest phase was submitted. This attempt is consumed and cannot use the absent-native-marker predecessor recovery path. The token change needs bounded read-only preparation diagnostics, and provider settlement remains held; no security check is relaxed or submission repeated. See `ops/unified-funding-20261028/rpc-chain-production-launch-r1/ROOT-RESULT.md`.


The explicit `preparation-check` definition worker operation is a read-only diagnostic for the consumed third attempt. It binds a fresh short lease and current admission to the original held plan, and refuses all writes to that plan’s definition/boot journal. Twelve bounded stage records in the new worker namespace capture process/effective SID and impersonation level around WMI scope, singleton, prototype, parameter and WmiDtd20 preparation. It stops before DefineSystem invocation and refuses a changed primary SYSTEM context without altering tokens. Production mutation code is unchanged. This diagnostic is source-only until separately compiled/qualified and does not settle the old native/invoke markers or authorize another attempt.

Actual qualification: definition CI41258640395 passed117 cases at d010a044; unchanged startup compiled closure passed68 at64c8fe89. Target preparation-check was attempted once and refused before WMI because KVM9a changed from reviewed stopped to the normalized unallocated-retry category. No preparation-stage trace was reached, so this does not diagnose the earlier SYSTEM-context error. Exact role deaths and unchanged original VMs/journals were observed. See ops/unified-funding-20261028/rpc-preparation-diagnostic-result-preserve-r1/ROOT-RESULT.md.

A second target diagnostic used a fresh observation and reused verified binaries. It still refused before WMI: seven status-only changes occurred across snapshot/role startup. Snapshot-to-controller submission was6.347s, including2.566s after fullread returned. Exact roles/readers/publisher deaths and unchanged original VMs/journal were verified. No further unchanged diagnostic is qualified; next work is a protected fresh-observation binding at the final work gate under the original deadline. This is not implemented. Details: ops/unified-funding-20261028/rpc-preparation-fresh-results-preserve-r1/ROOT-RESULT.md.


`preparation-gated` adds a diagnostic-only final observation handoff. The child
opens its immutable lease within the existing five-second bootstrap window,
checks its held owner/observer/child binding, and waits behind a closed work gate.
It performs no admission query or WMI preparation while waiting. The controller
holds exact live role handles, publishes `observation.request` bound to the boot,
contract, all role receipts, child binding and original deadline, then waits for
one `admission.fresh.json` plus `observation.commit` in that protected namespace.
The fresh observation must begin after readiness; original completed-cut and pool
authority must match the initial immutable observation. The controller holds the
fresh payload, checks its digest and live roles, and publishes one release. The
child independently verifies the same binding and its live peer handles before
unchanged native admission. Duplicate, mismatched, pre-gate, future, different
boot, changed authority and expired inputs refuse. The observer watchdog still
owns the original 30-second deadline, including collection. No old VM journal
writes, provider invocation or reservation release is authorized.

This handoff is source-only pending separate qualification. The external collector
must wait for the exact request, collect actual fresh host data, and atomically
publish the bound payload/commit; it must never overwrite the initial observation.
The definition and startup CI recipes now explicitly compile with `/optimize+`
and retain the 262144-byte executable cap and all resource/test limits.

The `preparation-gated` controller now collects its fresh admission observation
inside its existing 128 MiB self job and original independent 30-second watchdog.
It does so only after validating the exact child-ready record and publishing
`observation.request`. It starts no collector subprocess. Fixed loopback reads
cover the node and all three managers; native memory/disk, boot, listener and
held manager incarnations are captured again. The snapshot contains the fields
used by native admission, not fresh media hashes or VM inventory; those remain
separate preflight and completed-cut/pool checks. Node status is read last to
avoid the former SSH/staging delay. Original manager identities and immutable
cut/pool authorities must match the initial observation. Missing memory fields
remain missing, and unknown reservations remain unknown.

The controller exclusively publishes `admission.fresh.json` and its commit,
then applies the existing held-payload validation before one-shot release. The
child still performs unchanged exact live comparison, two-second aggregate
admission and resource verification before WMI preparation. Endpoint failure,
changed manager incarnation, peer death or original deadline closes the gate;
there is no retry. Its watchdog, rather than elapsed checks alone, bounds a
blocked native read. The native collector is not target-qualified yet. Synthetic
collector fixtures prove neither real endpoint latency nor successful SYSTEM
preparation, provider settlement, VM boot or RPC readiness.

Actual target evidence (2026-11-01): collector revision60fd8fd6 completed the
protected handoff in consumed diagnostic e87ec7ec. Native admission then refused
a retry-to-stopped change in one node record before any WMI preparation trace.
All exact diagnostic roles were independently absent; original VMs/8091 and
third-attempt journals were unchanged. Full admission and the original SYSTEM
failure remain unqualified. Historical resource-context construction still
occurs after snapshot release; moving that setup before readiness requires
retaining all current inventory/resource rechecks, not caching admission.

The next diagnostic revision prepares `LegacyHandoff.Completion` before
`observation.ready`, with an exclusive `admission.preparation-start` marker.
It retains the held resource context until the fresh observation is consumed.
Failure cannot publish readiness or retry context preparation under the same
lease. Initial bytes have a separate reader and never satisfy fresh admission.
The previous unprepared inspection entry explicitly refuses `preparation-gated`.

After release, the prepared context checks the fresh payload against its original
cut/pool binding and starts live admission once. Live admission refreshes the
full current VM inventory, issuer bindings and resource observations, then repeats
the exact node comparison after those checks. These checks share the unchanged
two-second aggregate limit. It does not substitute cached inventory for current
verification. The original 30-second watchdog and five-second entry bootstrap
remain unchanged. New phase receipts distinguish preparation from live admission;
this revision is not target-qualified until a new reviewed diagnostic succeeds.

Prepared diagnostic context qualification (2026-11-01): hosted definition41261683085 passed144 tests at57505b6bcecd5a55a15f68bf5d01c32aeecbe7d5; startup41261542876 passed68 with all19compiledsources unchanged. Actual target fc5570ceb1724294b3753363ed21e2ad completed context preparation before readiness and fresh observation handoff, then refused aggregate live admission at3653ms in pool-resources against the unchanged2000ms limit. No WMI preparation trace or VM/provider mutation occurred. All exact diagnostic workers were observed absent; original service and VM inventory unchanged. Further native execution requires a materially improved live query path, not a clock extension or cached inventory. The consumed third production attempt remains unsettled.

Candidate batch inventory reader: four bounded native queries replace the previous per-VM GetRelated calls. Exact local namespace/class/object references bind each realized VM to exactly one static-memory record; missing, duplicate, shared, foreign and overbound projections refuse. Unrelated snapshot/template rows cannot provide a missing realized association. Resident/issuer rechecks, clocks and floors unchanged. Uncompiled and not target-qualified at source preparation. Association schema: https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-virtualsystemsettingdatacomponent .

Batch inventory status (2026-11-01): initial runtime71ddd090 hosted298PASS but target e52b4cf7 refused missing realized coverage with projected settings query. Runtime507d59c restored full realized enumeration and hosted298PASS; target061f0523 passed realized coverage then refused memory association (missing/duplicate not distinguished). Current b4fb16c restores full memory enumeration too, retains exact bounded batch joins and distinguishes missing records; hosted definition159/startup68/legacy71 PASS with exact source pins. Current target execution refused before staging because freshfree84368392192B is below retained84385202176B. No batching latency improvement or successful native fullinventory qualification claimed. All earlierdiagnostic exactroles dead/originalservices unchanged; thirdproduction provider ambiguity remains held.

Inventory refusal diagnostics (candidate): the existing local-host, namespace, instance and class checks retain their exact acceptance conditions. Refusal reports the input source (settings path, memory path, association group or part), a bitmask (1 non-instance, 2 server, 4 namespace, 8 class), and bounded printable server/namespace/class fields. Instance keys and the complete path are excluded. This diagnoses the actual target Foreign inventory reference refusal; it does not relax validation or claim target qualification. Steam exit was authorized and completed; a subsequent full memory admission passed. The third production provider operation remains unsettled.

Target diagnosis bb714bbc (2026-11-01) identified a local `Msvm_VirtualEthernetSwitchSettingData` group in the generic association query; server and namespace checks passed, class-only refusal bit 8 caused failure. Candidate join now validates both references' local namespace and instance form, then requires the entire relative group key (class and instance) to match the independently enumerated realized-VM settings. Local switch rows are unrelated and cannot satisfy missing VM coverage. Foreign references, duplicate/shared memory and missing coverage still refuse. This is a source correction awaiting qualification, not RPC readiness or provider settlement. Microsoft describes [the association](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-virtualsystemsettingdatacomponent) in terms of the generic CIM virtual-system setting class.

Qualification update: source `2e44b432` definition CI41266641683 passed165 (harness4466ms); startup68/legacy71 retained exact runtime closures. Actual target diagnostic4e954895 completed context inventory preparation in1953ms, then stopped at the unchanged aggregate two-second live admission limit (3249ms, phase pool-resources). This fixes the observed switch-group parsing failure but does not establish fast enough admission, VM readiness or provider settlement. Exact diagnostic roles are absent, original VM state and retained third-attempt journals unchanged. No automatic retry or timeout increase.


Current policy update (2026-11-01): the user explicitly authorized a four-second aggregate Windows start-admission freshness limit. `WindowsStartAdmission.RequireFresh` now accepts elapsed time through 4000ms and refuses 4001ms, invalid origins and clock reversal. The recorded 3249ms sample is within this new time bound, but is historical evidence, not a new admission. All current node, manager, listener, inventory, resident bracketing, physical capacity and pending-allocation checks remain required. The narrower resident-sample limit remains 2000ms; the original worker and 900-second startup deadlines are unchanged. Earlier two-second aggregate qualification records above describe the previous policy. This source change still requires compiled qualification and a fresh target diagnostic; it does not settle the consumed production attempt or establish RPC readiness.

Actual four-second qualification: source`e4a72caca` passed startup68/definition165/legacy71 hosted tests. Target read-only diagnostic`ea292242` completed live admission in3391ms, then strict SYSTEM-primary context validation refused after the singleton Hyper-V service query. Process remained SYSTEM/None; effective thread changed from SYSTEM/None to SYSTEM/Impersonation. No provider invocation or RPC readiness. All exact diagnostic roles were independently absent and retained third-attempt journals unchanged. The observed context transition now determines the next native investigation.

Primary-context candidate: the fixed Hyper-V scope now explicitly disables automatic privilege enablement. Actual target evidence placed the unexpected SYSTEM impersonation transition after service enumeration with EnablePrivileges=true. Strict primary SYSTEM checks remain unchanged; there is no token-reset or alternate identity fallback. Hosted tests include a real local singleton WMI read preserving the original primary identity. Target preparation and provider-operation capability still require qualification; original consumed production settlement remains held.

Primary-context qualification update: source`26271cfe` passed306 hosted checks, including real singleton WMI context preservation. Target`c2fbb48e` refused because node commitments changed during current inventory verification, before Hyper-V preparation. Therefore the privilege change remains unqualified on target. Exact diagnostic roles are absent, existing VMs/service and original third-attempt journals unchanged. Current4s aggregate and strict node equality remain.

Live diagnostic admission now reuses its already-validated four-listener observation for the two legacy issuers. The internal witness contains fixed-port PID values, exact held read lease and original aggregate start; one-shot consumption rejects another lease, expiry, clock reversal or replay. Issuer health/master/native identity, all current VM/memory associations, resident bracketing, pool/cut and exact final node equality remain. This removes one WMI enumeration, not a current inventory or capacity check. It is trusted in-process plumbing, not cross-process authority. Target timing and primary-context preparation remain unqualified until a fresh native result.

Listener reuse qualification: source`11da9924` passed312 hosted tests; native target`0b09d316` still refused final node equality before WMI preparation. Exact roles exited, original VMs/service/journals unchanged. The final equality failure now includes the existing bounded DeploymentDifference (only already-compared receipts); this identifies the changed field without another native read or relaxing equality. Privilege fix remains unqualified on target.


The actual final comparison at source `bb48ac69` found exactly one status change,
`claiming` to `failed`, with the same explicit 128 MiB and no isolation or retained
allocation flags. Live retry comparison now requires the existing successfully
constructed `LegacyHandoff.Completion`; no operator-provided flag enables it.
The original fence object and ancestor custody, read denial, exact issuers, pool
claims, current native inventory and physical/resident checks remain mandatory.
The held completion is checked again after the final node observation. With no
completed cut, both historical and live comparisons remain exact. Known positive
memory and absence of isolation/held/retirement flags are required on both sides;
other status, memory, identity and isolation changes still refuse. This does not
settle a claim transaction, grant a provider retry, or release a reservation.
This change awaits hosted and target qualification; the primary-context WMI
candidate and the consumed production attempt remain unqualified/unsettled.


Target qualification update: runtime `d6451160` passed315 hosted checks and the
actual NucBox SYSTEM preparation-gated diagnostic `ffa015fc`. Live admission
completed in1929ms under the authorized4000ms limit. All12 Hyper-V preparation
stages retained primary/effective SYSTEM with impersonation levelNone, through
service query, settings serialization and disposal. This qualifies the scoped
live comparison and EnablePrivileges=false for that read-only path. Exact roles
exited and original VMs/service/journals were unchanged. It does not settle the
earlier consumed production attempt, prove a provider mutation or make RPC
ready. See `ops/unified-funding-20261028/rpc-fenced-live-retry-target-result-r1`.


`ProviderEventEvidenceEntry` is a separate read-only historical-event collector.
It searches only two fixed WMI/VMMS channels within a reviewed original worker
window of at most60 seconds. A five-second independent watchdog and128MiB
self-job bound the reader; bootstrap allowance and protected image staging remain
external admission requirements. It creates no child, changes no log, and invokes
no VM/provider mutation. Output is bounded and private by default. Empty logs,
unavailable channels and source-order inference cannot settle a lost response;
even a returned event requires exact operation/ownership correlation. Its output
always retains providerSettled=false and reservationMayRelease=false.
The corrected two-channel reader passed18 hosted checks on source6e4dde3f.
Initial target staging refused a changed application inventory. After a
quorum-backed lease-expiry diagnosis and a read-only admission review, the
corrected reader ran on NucBox: both enabled channels returned zero events for
the original worker's30-second window. Its exact process death was independently
verified. This supplies no original provider settlement or permission to retry.
See `rpc-provider-events-target-result-r3` for the evidence and limits.

### Host bootstrap entry (candidate, not installed)

`HostBootstrapEntry` is a separate SYSTEM executable and explicit
`owned-rpc-host-bootstrap-v1` contract profile. It preserves the existing owner /
observer / suspended-child handshake and <=30-second phase lease. Its child pins
all source and tool files before starting a fixed Node entry and TPM tool, inside
the existing 128 MiB child / 256 MiB owner tree. The four-process owner job contains
owner, native bridge, Node and TPM. The observer remains separate. Process-start
inheritance and the actual target topology still require native qualification.

`HostBootstrapChannels` connects AF_HYPERV directly to the plan's exact VM GUID,
port 9000 service GUID; it checks the returned peer and has no TCP/network scan
fallback. The socket is noninheritable and process-lifetime owned, avoiding a
close-versus-blocked-recv handle reuse race. Parent/observer loss and original
phase expiry remain independently enforced outside blocking pipe/socket calls.
The code uses [Windows job inheritance](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)
and the documented [Hyper-V socket address](https://learn.microsoft.com/virtualization/hyper-v-on-windows/user-guide/make-integration-service).
Those API contracts do not constitute target execution evidence.

The fixed plan `bootstrap-plan.txt` has these newline-separated fields, followed
by a final newline: schema `owned-rpc-host-plan-v1`, canonical VM GUID, original
startup QPC origin ms, original startup deadline ms (exactly origin+900000), pinned
Node path/hash, pinned TPM path/hash, existing host key path/hash, protected source
root, `bootstrap-source.txt` hash, base64 expected-deployment JSON, base64 EK-chain
JSON, original accepted VM ownership receipt hash. The attempt contract binds the
plan hash. The ownership hash is a binding input, **not verification of ownership**;
the admitting controller must verify the original receipt/VM association and all
previous ambiguity before producing this plan. That controller integration is
outstanding; the entry must not be used to adopt a historical ambiguous VM.

The manifest lists the exact `SourceNames` closure as `relative/path|sha256` in
that order, with final newline. Source/tool/key files and every ancestor are held
under the protected namespace rules. Executables are hashed incrementally. The
native bridge only passes the existing key to its contained Node process through
anonymous stdin, never argv/environment/enrollment/output logs. Node uses an
exclusive host journal; no key creation fallback. Do not publish private plans,
keys, raw pipes or generated journals.

Node and Windows clocks do not share an assumed epoch. Node samples before its
clock request; native samples after receiving it. Node charges the entire elapsed
roundtrip to the native sample, conservatively shortening the remaining phase.
Both the original 900-second clock and the earlier phase deadline remain bound.
The JS timer is additional transport control, not proof of native death.

The native worker persists `enrollment.json`, then awaits exactly one protected
`owner-offer.json` (the existing host sequencer's finish argument) under the same
phase deadline. An authenticated original-owner configuration producer must
consume that enrollment and publish the signed offer. That producer/caller and
full native composition are not yet integrated. Replies remain independently
checked against both pinned owner keys. Success means acquisition was requested;
RPC readiness, provider fencing and reservation release remain false. No native
VM start, provider mutation, task registration, production installation or guest
image rebuild is performed by loading or compiling this source.

Candidate source `ac187c302cfbb7098b59919e1c27e4dd8fe78345` compiled in hosted
Windows run41317386906 (1814ms,69632-byte executable). This was compile-only;
no native bootstrap execution or target admission. Six separate Node framing/clock
checks passed. Exact build receipts are preserved in
`ops/rpc-production-final-20261025/rpc-native-bootstrap-build-r1/ROOT-RESULT.md`.

Hosted native composition qualification now covers seven aggregate cases across
runs41318351499 and41318703091: normal exchange, wrong source/key pins, malformed
pipe, observer loss, blocked TPM and blocked monitor write. The corrected fixture
observed all five preheld processes dead20ms after observer kill, and28/32ms after
the original3500ms blocked-call deadline. The first observer-loss failure and its
missing-detail artifact defect are preserved; only the failed/unrun cases resumed
after atomic fixture marker/diagnostic fixes. Unchanged production/controller
binaries were reused by exact source and artifact hashes.

These execute real SYSTEM tasks, protected namespace, native pipes and job topology
with compile-time fake monitor I/O and finite C# Node/TPM stand-ins. They do **not**
execute the maintained Node JS entry, real TPM or AF_HYPERV peer channel, or prove
Node memory fit and original VM ownership. The release binary remains uninstalled.
Details: `ops/rpc-production-final-20261025/rpc-native-bootstrap-composition-r2/ROOT-RESULT.md`.

Native RPC app definition (candidate, not installed): `NativeRpcDefinition.cs`
adds the local WMI `DefineSystem` transaction for a Type 1 Linux-direct RPC VM.
The initial definition includes pinned firmware/state paths, fixed 19 GiB guest
memory/four CPUs, isolation fields and disabled automatic start/save/checkpoints.
It creates only an Off shell: TPM/security, optical/network/serial setup and start
are separate stages that are not yet connected to the manager's native driver.
The schema binds manager epoch, app/record/deployment/instance, shared claim,
admission, original 900-second clock and exact worker image. `native-definition`
is an explicit protected worker profile; an ordinary definition contract cannot
open it. Its durable journal consumes submission before the provider call,
persists returned references before follow-up queries, refuses partial pending
records and allows a new bounded reconciliation lease without renewing startup.
An ownership receipt is evidence of this transaction, not an adoption capability,
attestation, writer fence, reservation release or production readiness.

`rpc-native-definition.yml` is a separate, dispatch-only hosted qualification of
this new transaction and real administrator-owned protected journal. WMI provider
and capacity authority are fixtures. It never creates or starts a VM. Target
SYSTEM admission, a concrete independently supervised caller, native runtime
asset pins, original manager inventory/claim authority and durable cold recovery
remain required before activation.

Native definition qualification result: hosted run41322573241 passed16 new cases
(compiled runtime8a2f9dd9). It exercised real protected administrator journal
files and a mocked provider; it did not execute native WMI or establish SYSTEM
startup/production readiness. The first run's artifact-collection failure is
preserved separately; its test outcomes are unknown.

`NativeRpcWorkerEntry.cs` now supplies the native definition owner/observer/child
entrypoint. `NativeRpcAuthority.cs` binds its work to the exact live manager
record, original clock, current shared pool claim and fixed asset files before
calling the native transaction. The existing completed legacy cut remains
required; the only additional pool record admitted is the exact already-consumed
20 GiB `app-native` RPC claim. The four-second aggregate observation, prospective
commitments, floors and overheads remain unchanged. All four listener process
identities are held through admission; the original native manager record is
checked at both ends.

Firmware, bundle, record and profile are held without write/delete sharing.
The initial private single-link VMGS copy is hashed and held without delete
sharing; provider writes are permitted because guest state must change. Its
initial digest is not represented as an immutable post-definition state digest.
Local runtime pins are operator configuration, not attestation of accepted code.

This entrypoint is not installed or supplied by the manager's default main.
The original manager/controller request producer, task submission/collection,
durable inventory recovery, full target SYSTEM execution and accepted complete
image are still outstanding. Readiness, start, device configuration and storage
writer authority remain separate unfinished stages. The new hosted workflow
compiles the actual entrypoint and tests native admission/assets/pool behavior;
it never calls the WMI provider or starts the native worker against a host.

Native worker qualification: hosted run41323670407 compiled the production
entrypoint (210944 bytes, SHA256
fe2aaff8ab6c1551a880a91753e60c7b1ec6ca64b88a4a72fed797e001db5e40)
and passed nine new admission/shared-pool/asset cases. The pool and asset tests
used real protected administrator-owned Windows files; manager responses were
fixtures. The production worker and WMI were not executed. This does not qualify
target SYSTEM operation, the manager launch/recovery controller or production RPC.

`NativeRpcController.cs` now implements a concrete native manager-side ledger
and task producer, described in `NATIVE-MANAGER-CONTROLLER.md`. It captures the
actual native origin before preparation, persists the original reservation intent,
consumes launch/dispatch once, prepares protected assets, repeats full admission
before exact SYSTEM tasks, and verifies owned-Off results against original
journals. Hosted run41325035548 passed ten new administrator ledger/file cases
and compiled the controller (242176 bytes, SHA256
ae43decba8055944bbf784e9577aebf41ae239904b401a99b2882192b0b92f47).
The task producer was not executed, and target SYSTEM/provider/manager composition
remains unqualified. That earlier result covered the controller alone. The optional manager transport
and held restart inventory are now implemented as described below; production RPC
remains offline.

The concrete `rpc-native-controller.mjs` transport now connects the original app
manager to `NativeRpcControllerEntry` with asynchronous bounded stdio, durable
send intents, native original QPC/digest, protected binary staging and held restart
inventory. Full capacity is reserved before awaiting native begin. Explicit
operator pins are required; default activation and V9 advertising remain disabled.
Hosted run41327394900 passed seven new administrator staging/ledger cases and
compiled the controller237568B/SHA256
22e033958a4bbd695342b74248079ddf90b2788f1efe8f83def023710c4deb6f.
Eight distinct client methods and ten affected manager methods passed locally,
plus three syntax checks; native replies/pool are fixtures. These results do not
qualify the actual Windows Node-to-nativeMain-to-SYSTEM task composition, hardware
or a running RPC. Full runtime qualification, devices/start, current accepted
image and original storage-owner bootstrap remain required. See
`NATIVE-MANAGER-CONTROLLER.md` and `../vbslike/manager/RPC-CONTROLLER.md`.

Hosted run41328193864 subsequently exercised the actual Windows Manager/client/
native CLI process path with the same compiled controller (no rebuild). Five
composed checks passed, including actual binary staging, original QPC receipts,
held recovery and native hold. Deliberately absent inert firmware refused definition
before provider admission/task dispatch. A separate native process blocked on
stdin exited125 through its own30-second watchdog after30066.3821ms; an external
fixture held its exact process handle before expiry and verified death. CI used
Node22.23.4 (SHA256 dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f),
not targetNode24.16.0. Host inventory/shared pool were fixtures. Full target SYSTEM
scheduling/admission, device setup/start, accepted current image and actual RPC
serving remain unqualified. See
`../../ops/unified-funding-20261028/rpc-native-manager-process-ci-r1/ROOT-RESULT.md`.

The maintained native worker now connects a separately journaled guest TPM/security
configuration after its original owned-Off definition. The controller requires
the protected security receipt before accepting its result. This candidate has
not configured a target VM; media/device setup and start remain absent. See
[NATIVE-MANAGER-CONTROLLER.md](NATIVE-MANAGER-CONTROLLER.md#original-guest-security-stage).

Security qualification now has18distinct new checks:15mocked-provider transaction
cases passed in run41329154635 before an oversized fixture blocked the protected
file cases. Run41329387293 compiled a smaller required fixture closure and ran
only those3remaining administrator namespace cases, allPASS. Production
controller245248B SHA901f9df5ba12db1614b15895b3430a6ce1ca97d39cb6a8d90bc6c3734c96047c
was compiled, not executed; sourcepins and both R2executable hashes verified.
No SYSTEM/WMI/VM/TPM execution or production boot was established. Failure details
and unchanged bounds are in
`../../ops/unified-funding-20261028/rpc-native-security-ci-r2/ROOT-RESULT.md`.

Native RPC preparation now verifies and privately copies the two fixed optical
containers bound by its existing profile/2. The supervised worker revalidates
both streams and holds handles denying write/replacement before provider work.
This does not attach media or start a VM. See the optical preparation section in
[NATIVE-MANAGER-CONTROLLER.md](NATIVE-MANAGER-CONTROLLER.md).

Media custody qualification:11distinct checks across hosted41330441530 (3profile
passes beforedeadline),41330861005 (full-size copy passes, then fixturelease
freshness refusal),41331044806 (7remainingcustody/refusal passes). The copy
uses1MiBchunks withWriteThrough/finalfsync; deadlines/caps unchanged. Both
production entrypoints compiled251392B, not executed. Filesystem tests used
inert full-size zero payloads and administratorACLs; no VM attachment/boot or
production RPC proof. Sourcepins/binaryhashes/failures are preserved in
`../../ops/unified-funding-20261028/rpc-native-media-ci-r3/ROOT-RESULT.md`.

The native definition worker now sequences a fixed SCSI controller and two
DVD drives/media objects after original owned-Off and security verification.
Each immutable intent binds original ownership, security, profile and prior
returned resources. Its consumed submission precedes AddResourceSettings; exact
returned resources/job persist before readback or the next step. Lost response,
missing returned resource, failed/changed job or partial journal stays held.
Read-only reconciliation cannot invoke the next attachment. Readback checks the
original VM association, all parent/slot/path/type fields and exact storage
topology. A sole empty original default SCSI can be retained and explicitly
recorded as preexisting; no other resource adoption/scan recovery is allowed.
Controller checks the protected optical receipt. This is not boot permission:
VM SID read grants are implemented below; other device/network policy, start
and original bootstrap integration remain outstanding, as does SYSTEM/WMI qualification.
The native entrypoint build closures now exclude unrelated entrypoints while
retaining all admission/namespace/observer/provider code needed by that role.
API references: [AddResourceSettings](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/addresourcesettings-msvm-virtualsystemmanagementservice),
[storage allocation](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-storageallocationsettingdata).

First optical qualification41331724151 stopped at the legacy Framework compiler
deadline before producing a harness. No optical tests passed in that run.
The next finite build uses fixed installed Visual Studio2022 Roslyn standalone
csc, explicit Framework references and `/noconfig /nostdlib+ /langversion:5`;
no MSBuild, shared compiler server, package install, or deadline increase.
Compiler/reference hashes and CPU/wall measurements are retained. This changes
the build implementation; the first failure's root cause remains unknown.
[Standalone/compiler server behavior](https://github.com/dotnet/roslyn/blob/main/docs/compilers/Compiler%20Server.md).

The VS2022 preflight in41332109021 correctly refused before compiling: the
actual hosted image was Windows2025-VS2026/20261021.278.1. The corrected workflow
selects that named image and its published VS18 Enterprise path, plus the
installed Framework4.8 reference pack. Early missing-file diagnostics are now
preserved. Original bounds and standalone/no-server compilation stay unchanged.
Native optical inventory now queries both sibling WMI classes through the exact
original VM settings association; a base Msvm RASD query alone omits media.
[Observed runner inventory](https://github.com/actions/runner-images/blob/win25-vs2026/20261021.278/images/windows/Windows2025-VS2026-Readme.md).

Optical qualification41332339599 passed19newchecks (17provider/topology fixtures,
2actualWindowsadministratorjournal cases); both separateproductionentrypoints
compiled. ActualSYS/WMI/provider/VMattachment/start remains unqualified.
Controller251904B/450b061c16ae68f38685e648aea70e736093cd134bd9e1f45881752e2b8eb7e7;
worker218112B/fbc25004cc37edfd456087ef6881e859c01776c3038b4ce30d9fe08e915fe6d8.
Allsourcepins/binaryhashes verified; unchangedbounds and two precedingfailed
build preparations preserved in
`../../ops/unified-funding-20261028/rpc-native-optical-ci-r3/ROOT-RESULT.md`.

The native worker now grants FILE_GENERIC_READ only to the exact original VM
account on runtime.igvm, image.container and hash.container before attachment.
Forward/reverse NT VIRTUAL MACHINE account resolution must agree with the GUID
from the original protected ownership receipt; the all-VM group is refused.
Held original data pins deny writes/deletion, and ACL handles must match their
volume/file/creation identity. One durable intent binds original plan, ownership,
security, SID, exact identities/sizes and before/after security hashes before any
SetSecurityInfo operation. All three results must read back before success is
persisted. Interrupted/partial grant or lost receipt stays held without retry.
Only protected DACL bytes change; owner/group and administrator/SYSTEM ACEs stay.
No directory, VMGS, journal, credential or broader group grant is introduced.
Read-only reconciliation checks completed original receipts and actual held file
identity/ACL; it cannot replay an incomplete grant. Controller requires the exact
readGrantReceipt. VMGS provider access, directory traversal/effective VM token
access, SYSTEM account lookup and actual Hyper-V boot remain target qualification
requirements; this source is not activation or RPC readiness.
API: [held-handle SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo).

Read-access qualification now has 13 distinct passing cases across three runs.
The two failed runs are preserved: Windows added AUTO_INHERITED bookkeeping to
an otherwise exact ACL, then a metadata-only handle failed deletion exclusion.
Receipts now compare exact owner/group/protection/ACL bytes; grant and reconcile
handles include FILE_READ_DATA to enforce no-write/no-delete sharing. Actual
administrator fixture proves SetSecurityInfo/readback, unchanged file identity
and bytes, deletion/rename refusal, and consumed/partial/reconcile journal gates.
The fixture uses a synthetic SID; effective original VM token access, account
lookup under SYSTEM, VMGS/traversal and Hyper-V boot still require qualification.
Both production entrypoints compiled; no target execution or RPC proof.
Full results: `../../ops/unified-funding-20261028/rpc-native-readgrant-ci-r3/ROOT-RESULT.md`.

The native worker now observes pending definition, security and optical jobs
within its original lease rather than returning after the first pending result.
The first exact returned-reference/TimeSubmitted binding is persisted before
waiting; every further observation must match it. Only new/starting/running/
shutting-down jobs with JobRunTimes=1 and no error are eligible. This property is
the configured recurrence limit, not an observed execution counter; zero means
unlimited recurrence and is refused. Other states stay held. Actual worker waits
25ms only when both the original startup deadline and original worker deadline
have room; independent armed watchdogs still bound hung provider calls. No new
origin/lease, retry, resubmission, cancellation or capacity-release inference.
An opt-in runtime interface preserves single-observation behavior for other
callers. Read-only reconciliation can wait on existing operations but cannot
submit the next configuration step. Device policy/start/bootstrap remain pending.
Reference: [Hyper-V job state and recurrence](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-concretejob).

Pending-job progression qualification41334184727 passed12new composed cases;
provider, clock and admission were mocked. Both production entrypoints compile,
but actual SYSTEM/WMI timing and target boot remain unqualified. Exact receipts,
source pins, process exits and executable hashes are preserved in
`../../ops/unified-funding-20261028/rpc-native-progress-ci-r1/ROOT-RESULT.md`.

The original owned-Off worker now requires a fresh (at most four seconds)
closed resource inventory receipt after security, per-VM read grant and optical
attachment. It accepts exactly one CPU setting, one memory setting and the five
original optical references. Actual CPU/memory quantities and all optical
parents/slots are rechecked by the original provider guard. NICs, network
attachments, pass-through, disks, 3D/GPU and unknown allocations are refused;
there is no implicit removal or adoption. Optional default serial ports (at most
two) must have no host backing, connection or debugger mode; at most one unbacked
non-3D synthetic display is permitted. Resource inventory is bounded and queried
only through the original VM configuration's Msvm_VirtualSystemSettingDataComponent
association, requesting the CIM base so sibling resource classes are included.
The protected receipt binds prior original receipts and a canonical inventory
hash. Reconciliation rereads; changed inventory remains held. Historical receipt
verification does not authorize start: the eventual start operation must obtain
another fresh observation. No start, provider fencing or reservation release is
asserted. Target provider defaults, effective VM token access and the actual
association closure remain unqualified until a reviewed native attempt.

NativeRpcWmi.cs now contains the native provider implementation and is excluded
from the controller executable. Shared recipes and protected receipt validators
remain in NativeRpcDefinition.cs; the actual worker retains all provider methods.
This reduces controller build size without relaxing the 262144-byte image cap.

Schema references: [resource association](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-virtualsystemsettingdatacomponent),
[resource settings and serial connection](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-resourceallocationsettingdata),
[serial debugger](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-serialportsettingdata),
[synthetic display](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-syntheticdisplaycontrollersettingdata).

Device-policy qualification41335505712 passed15new cases:14mocked-provider/
inventory/clock/admission cases and one actual administrator protected-journal
case. Both production entrypoints compile; target SYSTEM/WMI/VM defaults remain
unqualified. The controller is256512B under the unchanged262144B bound. R1test API
compile failure and R2relative-path refusal are preserved; R3diagnostics confirm
WMI supplies server `.` for a relative path. The policy validates the bounded
literal grammar, not equality with parsed optional namespace/server fields.
See `../../ops/unified-funding-20261028/rpc-native-device-ci-r3/ROOT-RESULT.md`.
VM start and bootstrap/enrollment integration remain pending; production RPC OFFLINE.


Native start transaction (source candidate, not activated): `NativeRpcStart.cs`
implements one-shot RequestStateChange(2) intent/submission, exact returned job
persistence before observation, original job incarnation reconciliation, and a
fresh original Running/19GiB allocation readback. Return0/job success is not VM
running or RPC readiness. Lost response remains held; no resubmit/cancellation.
The source requires a separate `INativeRpcStartRuntime` lifecycle authority
bound to the original VM and independently owned deadline/armed VM cleanup.
The current definition-only runtime does not implement it; current protected
define/reconcile journals reject every start record. No worker/controller/manager
entrypoint invokes it. Existing definition plans retain start=false. The provider
and transaction compile in the worker closure, not the controller.

Next integration must implement that authority with actual held cleanup-owner
identity, immutable consumed intent before work-gate release, protected start
journal access, and original900s VM cleanup; process-job death does not stop a
Hyper-V VM or settle its provider job. Then wire explicit start and native
HostBootstrapEntry/owner-entry-v2 enrollment, not reinterpret define-staged as
boot permission. TargetSYSTEM admission/current accepted image/storage-owner
settlement and actual TPM/AF_HYPERV/NBD/readiness qualification remain required.
Reference: https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/requeststatechange-msvm-computersystem
(TimeoutPeriod is unused; repeated requests can overwrite earlier requests.)

Start transaction qualification41336671277 passed19new cases (18mocked-provider/
lifecycle/clock/admission,1actualadministratorprotectedjournal refusal). R1test
syntax failure preserved. Both production entrypoints compile ONLY; controller
256512B unchanged, worker240128B. No actual lifecycle authority, protected start
lease, VMboot orRPCreadiness. See
`../../ops/unified-funding-20261028/rpc-native-start-ci-r2/ROOT-RESULT.md`.

Native cleanup integration candidate (not production activation)

`NativeRpcStart.Prepare` consumes the immutable lifecycle-bound start intent
before a future independent owner releases the start work gate. `Submit` now
requires that prepared record and repeats current authority/device/admission;
it cannot create missing intent. The definition lease remains unable to start.

`NativeRpcCleanup` settles the exact original returned start operation only after
all three original owner/observer/provider-child handles prove death, then
consumes one stop intent/submission and invokes RequestStateChange(3) once.
Lost or incomplete start/stop responses remain held. Pending/abnormal/recurring
jobs do not authorize stop or release. Completed failed start jobs may require
cleanup; a successful stop still needs original owned Off/zero-memory readback.
All provider-fenced/reservation-release claims remain false.

An explicit cleanup worker profile has a separate <=30s supervised lease, clipped
to original startup deadline+30s. This cannot extend start authority. Protected
cleanup journal grants only stop submission and exact-operation observations;
reconcile grants observations only. The cleanup owner transfers query/sync-only
original process handles into its suspended child before observer release. The
child checks original protected contract, worker image, boot, nonce, PID, creation,
SYSTEM identity and all three exact deaths. No PID lookup or task-state shortcut.

**Still missing:** independent lifecycle owner/dispatcher, protected start lease
and start-group record producer, durable pre-workgate registration/handle transfer,
and manager start/bootstrap integration. The new cleanup entrypoint is not
automatically dispatched and is not target-qualified. Native VM cleanup is not
provided by merely killing local helpers. Hosted tests mock provider, runtime,
clock and worker-death witness; administrator namespace checks are real. Actual
SYSTEM topology and handle transfer remain compile-only. No target VM has started.
