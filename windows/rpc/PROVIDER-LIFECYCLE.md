# Durable Hyper-V operation boundary

`ProviderStart.cs` now implements the fixed transaction and local Hyper-V adapter
as an unactivated library. It consumes separate intent, submission and native-call
records, persists the returned reference before follow-up reads, binds job identity,
and retains uncertain outcomes without resubmission. `ProviderStartHarness.cs`
passed22 hosted cases in CI41152666323 (compiler1.972s/harness0.287s), including two real protected filesystem adapter checks. Provider calls were fake; actual VM behavior remains unqualified. CI41152911185 at7f1bc9f385f4d81a44613334e0d20de643ec18a1 passed all25 cases (compiler1.608s/harness0.292s), including the three bounded post-startup observation cases.

This is not installed VM authority. The guarded VM entrypoint, persistent journal
reopening beyond a short worker lease, actual owned VM permit, independent startup
watcher and native operation qualification remain required. `IStartRuntime` is a
trusted caller boundary that must validate those facts; it is not proof by itself.
The inert entrypoint cannot call the native adapter. `ProtectedStartJournal` uses
held protected files for storage only; the inert contract does not authorize VMs.

Only nonrecurring JobState=7 is currently treated as job settlement; state8/9/10
remains held. Operation settlement is separate from VM Running/Off, closed start
authority and storage fencing. Both public fence/release flags remain false.

The implementation follows the fixed [RequestStateChange interface](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/requeststatechange-msvm-computersystem)
and [job properties](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-concretejob).
The remaining integration contract is:
The bounded process worker alone cannot establish any of these provider fences.

1. Before a submission worker can run, create an exclusive, durable start intent
   in the qualified protected attempt directory. Bind the attempt, admission and
   contract digests, host boot, exact original-owned VM GUID, namespace/class/key,
   fixed `RequestStateChange` method and `RequestedState=2`, original 900-second
   deadline, one-shot generation, worker incarnation and independent guardian.
   Existing intent means consumed, even if no later receipt exists. Do not retry.
2. Revalidate the same owned VM and exact singleton `Msvm_ComputerSystem` by GUID
   in local `root\virtualization\v2`. Check the original deadline immediately
   before invocation. Invoke that fixed operation once. Preserve return value 0
   as synchronous completion, 4096 as an asynchronous returned job, a definite
   provider refusal as refusal, and every lost or ambiguous response as unknown.
3. Before acknowledging 4096, durably record the exact returned provider reference
   with validated local server, namespace, class and canonical keys, plus job
   identity and intent digest. Never accept an arbitrary caller-supplied CIM path.
   Never find a replacement by scanning jobs. A crash between submission and
   receipt persistence is unresolved submission, even if the worker is dead.
4. Observe only that operation through separately bounded reads. Bind the host
   boot and provider identity and retain native state/error fields. A missing,
   unqueryable or recycled reference is unknown unless an earlier protected
   terminal receipt already proves settlement. Persist terminal evidence before
   provider garbage collection can remove it. Define terminal states explicitly;
   “not in the old polling list” is not a terminality rule.
5. Close the one-shot start gate and independently fence the launcher. Require
   conclusive settlement of every potentially submitted native start operation.
   Only then obtain a fresh original-owned Off/zero-assigned-memory observation.
   Keep local worker death, provider terminality, closed start authority, VM
   stopped state and storage-writer/export fencing as distinct facts.

Retained disposable-VM evidence demonstrates exact-GUID `RequestStateChange`
targeting and the returned-job mechanism. One returned job reached state 7/error 0;
another reached state 10/error 32768. The final VM observation was Off even in the
successful-job case. Operation completion therefore cannot stand in for sustained
Running state, RPC readiness, sync, finality or consumer cutover.

That historical wrapper used wall-clock polling, unbounded individual CIM calls,
and no durable intent/reference record. It is not reusable wholesale. The
synchronous return-0 path, full reference persistence/rehydration, terminal-state
classification, provider garbage collection and crash/reconnect behavior still
need actual qualification. No cancellation guarantee has been established.

Reconciliation after the startup deadline uses a separate bounded read-worker
authority checked before and after the native query. It never renews start
authority or permits a second submission; Submit still enforces the immutable
900-second startup deadline. A fresh read guard is necessary to settle a job
after the startup guardian has stopped its caller.


## Immutable VM permit and journal reopening

`OwnedVmPermit.cs` separates the long-lived VM identity from each short worker
lease. The permit binds the exact VM GUID, derived owner markers, boot, image,
admission digest, original 900-second startup window and proposed 19 GiB guest
plus 1 GiB support allocation (21,474,836,480 bytes total). These fields describe
the authorized proposal; they do not prove available resources or native VM
configuration. The configuration path must be the owned attempt's `vm` child.

Opening holds the original permit, executable and protected ancestor/file
identities using the existing namespace validator. A separate original inert
worker lease bounds access and must match the boot and executable. Disposing or
expiring that lease makes journal access fail. The later lease cannot change the
permit's startup deadline. Reconciliation mode can read fixed start records and
publish only job identity and terminal observations. It cannot publish a new
intent, submission, native call or returned start response. Pending records remain
consumed across reopening. `StartIdentity.Decode` preserves the original worker
identities; the new observation worker does not replace them in the intent.

These APIs are not an independent supervisor. They still need composition with
the live worker/observer handle checks, actual admission, a guarded fixed native
entrypoint and the 900-second VM guardian. No existing inert entrypoint gains a
VM operation, and no provider fence or reservation release is asserted.


The explicit provider-worker lease binds operation, permit path/hash and (for
start only) a distinct guardian PID/creation time. The original inert lease never
accepts this schema. The new SYSTEM worker composes actual held process identity
checks with the one-shot protected release, original consumed intent and fixed
provider adapter. A short worker observer is not accepted as the 900-second VM
guardian. Guardian armed/bound records must come from a separately qualified
producer, which is not implemented or activated yet.

Start admission retains the reviewed manager/node snapshot but also reads current
manager reservations and current node deployment memory/status/isolation identity
before and after host observations. Missing or unknown reservation authority
fails closed. Installed legacy managers have previously omitted these fields, so
this must be resolved before production start; there is no assumption of zero.
The three managers are counted conservatively; stable current reads are not an
atomic cross-manager reservation lock. The prospective39388MiB allowance,18GiB
floor,20GiB stack,1GiB variation and512MiB extra transient startup allowance all
remain in the native free-memory threshold. Disk checks preserve16GiB plus256MiB
remaining support space; original boot allocation/growth qualification is separate.

Microsoft documents Msvm_Memory as the currently allocated memory, with fixed
1048576-byte blocks. The start adapter requires the exact VM's row with zero
NumberOfBlocks; absence or null fields do not prove zero. This is a native API
requirement, not yet observed on the new RPC VM:
https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-memory


The explicit guardian entry now pins the original 900-second VM permit and owns a private kill-on-close job containing both gated start-worker roles. It publishes the one-shot binding before opening their gate. Guardian death or the original deadline kills that local worker group. The guardian storage profile cannot write provider records or act as a short journal lease. This is local start containment only: Hyper-V may outlive its submitting worker. The guardian does not itself settle provider operations or stop the VM; those require the separate cleanup worker described below. Automatic cleanup scheduling, storage fencing and reservation release remain unimplemented; all release/fence flags remain false. No production activation is supplied.


The v2 VM permit explicitly includes fixed owned-VM disable and reconciliation; v1 start-only permits are rejected rather than silently gaining stop authority. The guarded worker now has separate `stop` and `stop-reconcile` operations. They require the original startup deadline to have elapsed, exact original start child/observer death on the same boot, and settlement of the exact persisted start operation. Unknown start responses remain held. Stop has independent immutable intent, exclusive submit/native markers, returned-reference persistence and exact job reconciliation. Preparation alone may resume only for an exact complete intent while every submission/outcome record is definitely absent. Cleanup journal scope cannot write start authority; stop-reconcile cannot submit stop.

The fixed native adapter uses `RequestStateChange(3)` only for the exact original owned VM, then independently observes Off and zero assigned memory under a current read guard. It never saves or deletes a VM. These implementation paths remain unqualified against real Hyper-V; automatic cleanup scheduling, export/write fencing and reservation release are still missing. All release/fence flags remain false. Microsoft documents Disabled(3), v1-only ShutDown(4), returned asynchronous job references and warns that repeated requests can overwrite earlier requests: https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/requeststatechange-msvm-computersystem . Cancellable is not a cancellation guarantee: https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-concretejob .


## Completed legacy handoff admission

The current provider runtime also accepts an explicitly bound completed
`legacyCutSeed` admission. This supersedes the reservation-fields-only limitation
above for the exact retained-fenced-rpc-only mode. It holds protected historical
cut/seed records under the current short worker lease, original issuer/source
identity and persistent old-master denial through the final native pre-submit
check. Initial consumed claims and the exact RPC claim are the only admitted
allocators; missing fields do not become zero. Old strict health mode is unchanged.

Actual Windows CI41178310807 compiled the composition and passed71 cases; protected
reader lifetime, producer/consumer schemas and pool transitions were exercised.
No full production handoff completion or native VM start was executed. Production
activation, independently scheduled failure cleanup, VM definition, boot/storage,
client synchronization and consumer cutover remain required.
