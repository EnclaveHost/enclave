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
