# Durable Hyper-V operation boundary

`ProviderStart.cs` now implements the fixed transaction and local Hyper-V adapter
as an unactivated library. It consumes separate intent, submission and native-call
records, persists the returned reference before follow-up reads, binds job identity,
and retains uncertain outcomes without resubmission. `ProviderStartHarness.cs`
contains fault-injection coverage; compilation and execution are pending.

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
