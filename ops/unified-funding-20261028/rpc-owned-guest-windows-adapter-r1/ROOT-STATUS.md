# Windows native adapter source: incomplete, unexecuted

Root capability read13dfd2bb645c4742a5cc19e4e7fdcacf: actual Windows PowerShell5.1.26100.9711, Hyper-V2.0 and ScheduledTasks1.0 command parameter sets. Stop-VM supports default shutdown, TurnOff and AsJob; there is no Shutdown switch. Actual stopwatch frequency10,000,000, administrator role true. Only Get commands/CIM reads were executed; no tasks or VMs changed.

Partial owned-vm.psm1 implements monotonic time, protected SYSTEM/admin-only contract ACL/root/digest/boot validation, exact GUID+name+admission Notes+Path matching, bounded-shape observations, asynchronous stop requests and stop evidence. Mutating exported entrypoints reread the pinned protected contract; arbitrary caller dictionaries cannot select a VM. No function runs on import except defining/exporting functions and StrictMode.

Actual parser-only7abfbf1fbb29419ab7295c0ed72bd51b returned0/errors0 for all7 function definitions on the installed Windows PowerShell. Module was NOT imported and its functions were NOT executed. This is syntax evidence only.

Still missing: exclusive create/configure/start transaction, independently registered guardian/deadline tasks, native service-operation/late-start fence and authenticated readiness/attachment. Stop evidence deliberately returns lateStartFenced=false and reservationMayRelease=false: a PowerShell job exit or current Off observation cannot prove the Hyper-V service cannot later complete a pending start. No mutation helper may be activated until that dependency is resolved and bounded native qualification passes. Neither parser success nor returned cmdlet parameter sets establish runtime behavior.

Fresh21:36:37 host read free84,053,594,112B, C:22,572,228,608B. This is not native admission: actual complete pending workload/growth/guardian prerequisites remain. Existing19GiBguest+1GiBsupport proposal unchanged; no existing VM changes, funds or production RPC claims.
