# Root result: failed native disposable fixture

Invocation d8db9cd65b8b46448cea76bda1d36768 terminated with exit 2, MainPID 0. All 10 content and 18 external pins remain unchanged. The recorded inner scope is empty or gone; recorded exporter 2754722 and tunnel 2754728 are gone. No live PID start times were captured; none are fabricated.

Remote write failed before NBD client process creation with EACCES executing the sealed /run client. A noexec mount is a hypothesis, not yet observed mount evidence. Private export negotiation, exact size and unknown-name rejection passed. Both parent and overlay second writers were rejected by QEMU write locks. No attach, write durability, reopen, disconnect-read or abrupt-kill qualification was achieved.

Remote ExecStopPost and independent cleanup/verification passed. The fixture-loaded module was unloaded, no owned device/mount/unit process remained, exporter and tunnel were reaped. Chain disks were untouched and no chain client started. Inner peak 71 MiB, outer 139 MiB, host available minimum 30424 MiB. Preserve original artifacts and never rerun this invocation.

Late source finding: acquire the O_DIRECT fd before triggering tunnel loss, so successful early kernel detach cannot prevent the intended held-fd read check. Requires a separate reviewed revision.
