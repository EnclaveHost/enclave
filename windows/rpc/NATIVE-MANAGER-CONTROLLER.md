# Original native RPC manager controller

NativeRpcControllerEntry is an explicit candidate executable connected to the
optional app-manager transport. It is not installed or production-qualified.
NativeRpcWorkerEntry creates an owned Off shell and then configures guest TPM
and security through a separately journaled operation. There is no VM start,
media setup, adoption, deletion, reservation release, retry or payment API.

The protected operator configuration retains schema native-rpc-manager-controller/1
with exactly these other fields: ledgerRoot, attemptsRoot, workersRoot, runtimeId,
profileSha256, admissionSha256, firmwareSha256, initialStateSha256, workerSha256,
admissionPath, firmwarePath, initialStatePath, profilePath, workerPath. Configured
roots must already exist with qualified private local Windows ACLs. Ledger setup
requires a protected empty manager.lock plus private transport directory. Setup is
a separate admitted operator action; the controller never creates a replacement
empty ledger. The JS caller pins this exact configuration and executable. Local
pins are not hardware attestation or target admission.

Commands after the executable name:

- begin CONFIG CONFIG_SHA EPOCH INSTANCE DEPLOYMENT: records actual entry QPC
  origin and origin+900000 before acknowledgment. No VM/child/provider. A protected
  exclusive lock serializes writers. Durable attempt.json stores original identity,
  config, boot and 20480 MiB/400000 CPU reservation intent; it does not acquire the
  shared pool. Existing history or partial pending records refuse another begin.
- stage CONFIG CONFIG_SHA ORIGINAL_SHA: consumes stage.json before reading stdin.
  Input is uint32 little-endian header length (2..196608), strict UTF-8 JSON with
  exactly launch/record strings (each <=65536 encoded bytes) and integer bundleBytes
  (1..9MiB), then exactly that many binary bytes and EOF. After original binding it
  consumes launch.json, writes private inputs, validates hashes and fsyncs before
  stage-ready. Truncated/changed/trailing/blocked input cannot produce stage-ready
  or authorize a retry. No deployment-controlled filesystem paths are accepted.
- define-staged CONFIG CONFIG_SHA ORIGINAL_SHA: consumes define-request.json and
  uses only the original complete staged inputs. It copies/hash-pins private
  runtime/initial VMGS/profile/bundle/record under the original plan, performs full
  current native admission, consumes dispatch.json before task registration/Run,
  and schedules exact SYSTEM roles. Old arbitrary input-path define CLI is removed.
- inspect CONFIG CONFIG_SHA: validates protected ledger/transport and returns empty
  or original held history, including across deadline expiry/reboot. Unknown/partial
  inventory refuses. It does not scan Hyper-V or grant mutation/adoption/release.
- current CONFIG CONFIG_SHA ORIGINAL_SHA: reads only the original current boot/window.
- hold CONFIG CONFIG_SHA ORIGINAL_SHA: closes the original local gate even after
  expiry, without provider stop/cancellation/fencing/release. Subsequent mutation
  checks refuse. It is itself one-shot.
- inventory CONFIG CONFIG_SHA: retains the explicit empty-ledger-only check.

Replies use native-rpc-manager-controller-result/2. Begin returns both original
and originalSha256 computed from exact durable native bytes; callers must not
recompute it from reordered JSON response fields. All replies retain false
rpcReady/providerOperationFenced/reservationMayRelease.

Each command arms a native 30-second independent termination watchdog and enters
its 128 MiB self envelope before blocking files/COM/WMI/stdin. This is not a
prior-allocation bound. Actual startup/controller/registration/collector overhead
must be admitted separately. Definition's worker phase is <=20 seconds, clipped
to the original 900-second deadline and controller deadline-1 second. Preparation
never resets the original clock. Existing owner256/observer128/child128 job limits
and five-second bootstrap cutoff remain. Node transport collection limits are
additional controls, not native process-tree death evidence.

Complete current admission precedes task scheduling and repeats in the child
before provider mutation. Exact held owner/observer process handles/creation/image
are required before opening the work gate. Success requires known exits plus
original observer empty-job/exact-owner-death receipts and verification against
the original system/ownership journals. Task stop/delete is never proof of death.
Unknown response/cleanup remains held; no original VM capability is reconstructed
from a supplied GUID or a Notes scan.

Qualification covers new administrator-owned actual ledger/input files and a
separate JS client/manager fixture suite. The production task producer, actual
Windows Node-to-controller-to-SYSTEM composition, provider and target hardware are
not qualified by those component tests. Conditional main integration remains off
without explicit pins, and V9 health remains unadvertised. Complete target
qualification, accepted current image, device/start stages, original owner offer,
TPM/AF_HYPERV/NBD/verity/whole-fit/sync/finality/consumer cutover before production.

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

## Original guest security stage

After the original DefineSystem operation has settled and produced its exact
owned-Off receipt, the same supervised worker and original lease call
`NativeRpcSecurity`. The immutable security intent binds the original plan,
VM GUID, ownership receipt and fixed Type1 Linux-direct recipe. It is consumed
before `Msvm_SecurityService.ModifySecuritySettings`; the returned code and exact
job reference are persisted before any observation or acknowledgment. Only the
security service associated with that original VM is selected. The operation
sets guest `TpmEnabled` and `VirtualizationBasedSecurityOptOut` to true, preserving
other properties and the Type1 partition. It does not change host VBS.

A 4096 reply is observed only through its original persisted job and submission
time. A successful state7/one-run/zero-error job, or a synchronous zero result,
then requires fresh exact owned-Off, zero-memory, unchanged definition and
security readbacks. The controller verifies the completed security receipt
against the protected journal before accepting the worker result. Lost responses,
partial writes, failed jobs and mismatched observations remain held; no resubmit,
provider cancellation or reservation release is inferred. A read-only reconcile
lease can record observations but cannot create intent/invocation/response records.
The original900-second and worker20-second limits remain unchanged.

The worker currently makes one observation after each provider response. A pending
job is retained for explicit original-reference reconciliation; it is not a
successful configuration, nor permission for the manager to repeat `start`.
This stage is an implementation candidate, not proof of actual SYSTEM WMI/TPM
behavior. Optical containers (exactly two for the native RPC root and verity
tree), device restrictions, accepted image, bootstrap, start and RPC readiness
remain required. The ordinary Linux-direct no-disk recipe cannot boot this RPC
profile. The historical CLI composition result above predates this source change.

Provider reference: [Microsoft security service](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-securityservice)
and [security settings](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-securitysettingdata).

Security qualification now has18distinct new checks:15mocked-provider transaction
cases passed in run41329154635 before an oversized fixture blocked the protected
file cases. Run41329387293 compiled a smaller required fixture closure and ran
only those3remaining administrator namespace cases, allPASS. Production
controller245248B SHA901f9df5ba12db1614b15895b3430a6ce1ca97d39cb6a8d90bc6c3734c96047c
was compiled, not executed; sourcepins and both R2executable hashes verified.
No SYSTEM/WMI/VM/TPM execution or production boot was established. Failure details
and unchanged bounds are in
`../../ops/unified-funding-20261028/rpc-native-security-ci-r2/ROOT-RESULT.md`.

## Profile-bound optical media preparation

The same fixed operator `profilePath` now selects `image.container` and
`hash.container` from its private parent directory. No added app-supplied paths,
configuration switches, geometry overrides or unrelated image copy exist.
The canonical profile/2 already binds the client image and verity payload
hashes, fixed sizes, kernel and wrapper. The controller validates that complete
profile and exclusively copies both optical containers into the original
attempt after consuming the original launch/define request. A 64 KiB all-zero
prefix and exact payload size/hash are mandatory. Copies stream through a
1 MiB buffer, fsync before publication, retain partial pending files on failure,
and never overwrite or retry. The source namespace and files stay held against
write/replacement during copying. The prepared receipt is descriptive and says
`attached=false`; it grants no provider or boot authority.

Before any native mutation, the original supervised worker independently reads
the exact profile and validates both full containers, holding single-link,
protected, non-reparse file handles without write/delete sharing through its
lifetime. SHA-256 uses Windows CNG for streamed media; no media-sized allocation
or whole-file `ReadAllBytes` is used. Existing original900s/controller30s/worker20s
limits include the copy and verification work. This implementation does not
qualify target I/O speed, disk growth, persistent custody after worker exit, or
whole-stack capacity. Required read access for the original VM SID and journaled
SCSI/DVD attachment/readback remain separate prerequisites before boot.

The source qualification builds both actual native entry points separately:
`NativeRpcControllerEntry` and `NativeRpcWorkerEntry`. A controller executable is
not a substitute for the worker configured in `workerPath`. Neither is activated
by a successful hosted build. Previous hosted component results remain scoped to
their original revisions. Device configuration/start, original owner bootstrap,
accepted complete image and actual RPC readiness remain unproven.

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

Cleanup qualification41338127976 passed23new methods:20mockedprovider/runtime/
clock/deathwitness plus3actualadministratornamespace. ActualSYSTEMhandletransfer/
cleanupentrypoints onlyCOMPILED. Independent lifecycleowner/startlease producer
stillmissing; productionRPC OFFLINE. Sourcepins/binaryhashes/resultlimits:
`../../ops/unified-funding-20261028/rpc-native-cleanup-ci-r1/ROOT-RESULT.md`.

Native lifecycle/start composition candidate (not activated)

Explicit start-owner/start-observer/start-child roles now use a protected start
lease, independently armed SYSTEM lifecycle peer and a second pre-resume gate.
The owner prepares the original start intent before creating its suspended child.
It publishes exact worker contract registration after observer binding and waits
for the lifecycle process to pin the original worker image, boot, nonce, PID,
creation and SYSTEM identity for all three peers. The lifecycle process publishes
workers/bound records before the owner resumes; the child rechecks those records
and fresh physical admission before one NativeRpcStart.Submit. Definition commands
still end owned-Off; manager default behavior is unchanged.

NativeRpcLifecycleEntry is a separate SYSTEM entrypoint with an independent watch
thread armed before publishing authority. Original deadline or failed original
worker triggers one cleanup dispatch independent of a blocked caller/main loop.
A dedicated short cleanup owner/observer receives query/sync-only duplicates of
the retained original peers, after exact death. It invokes the existing original
stop-only worker. Task creation and Run are one-shot, no retry on ambiguity.
Cleanup time is clipped to original D+30s, never a start extension. All result
fence/release claims remain false; no adoption or readiness claim is added.

Still missing: trusted manager launcher that prepares/schedules the lifecycle
contract and worker copy, secondary protection if the lifecycle process itself
dies after a successful start, actual SYSTEM scheduler/process-transfer/provider
qualification, and original bootstrap/enrollment. A successful short worker exit
only keeps the watch until original D; there is no persistent-service adoption.
The independent callback cannot establish VM death if provider response is lost.
Target activation remains unadmitted. Start asset checks still require original
VMGS hash; definition/TPM may mutate that file, so real mutable VMGS custody must
be qualified/implemented before target start rather than relaxing that check.

Shared strict NativeControllerFiles extracted byte-identically into its maintained
file. Native-only compiler symbol excludes unused ordinary ProviderStart reducer
and ordinary HyperVStartProvider.Start entrypoint; shared exact provider helpers
and all native provider behavior remain. Legacy compilation without the symbol
is unchanged. No cap increase.

Lifecycle keeper and explicit start roles are now compiled. Hosted41339640102 passed the six remaining namespace methods; earlier41339385931 passed seven independent-watch methods before size refusal. Aggregate13 distinct checks; SYSTEM scheduling/provider/VM unqualified. Manager launch, keeper-death protection and mutable VMGS custody remain missing; production RPC OFFLINE. See `../../ops/unified-funding-20261028/rpc-native-lifecycle-ci-r3/ROOT-RESULT.md`.

Native mutable state custody candidate, not deployed.

Definition authenticates pristine private VMGS bytes and consumes native-state.initial before native-definition.submit. It records original plan, template digest, file volume/index/creation, initial size and exact protected owner/group/DACL hash. Start requires that immutable original receipt, same file incarnation, exact permissions and observed1..64MiB size, allowing provider in-place updates instead of rehashing against pristine template. Both runtimes reobserve the retained handle on later checks. No delete sharing; duplicate/torn/missing/foreign custody refuses. Only original definition may write the initial record; start/cleanup/lifecycle/reconcile cannot. This is not continuous handle custody between worker processes, a kernel-enforced growth cap, actual VMGS format validation or hardware attestation. Actual provider compatibility remains unqualified. No historical attempt without receipt can be adopted.

NATIVE_RPC_ONLY additionally excludes unused ordinary VerifyGuestMemory/GuardPhysicalStart/constructor/ReadJob implementation. Native WMI keeps its own exact job reader and shared memory/reference helpers. Legacy build without symbol is unchanged. No imagecap increase.

12 new actual Windows administrator file/journal cases: initial-before-submit; updated bytes/bounded growth; missing receipt; wrong template; identical-byte replacement; held rename/delete exclusion with permitted writes; empty/oversize observation; ACL drift; foreign plan; duplicate/torn custody; role write separation; late capture. Production keeper and SYSTEM worker compile only, no WMI/VM/task mutation. Same20s each/CPU1/self256MiB/observed512private450RSS/image262144/output65536/aggregate1MiB/hosted3min. No previous suite replay. Source integration does not admit target start. Manager launcher and keeper-death protection still required.
