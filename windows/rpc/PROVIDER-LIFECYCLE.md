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
