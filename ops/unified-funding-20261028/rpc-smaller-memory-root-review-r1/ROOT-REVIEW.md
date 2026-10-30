# Root review: reduced-memory owned RPC preparation

Reviewed 2026-10-30 05:42 UTC. Root independently verified all three delivered artifact hashes and all 20 source pins with zero drift. This is source/captured-evidence review only, not fresh runtime qualification.

The 64 GiB guest is preallocated; the 54 GiB sum of client limits is not measured usage. Historical 12.7 GiB used excluded a running Base client. No smaller combined allocation is proven. Keep host reserve, pending commitments, custody/blob verification and trust-RPC=false. Current database history coverage is also unproven: the 140,000-block configured minimum is shorter than the 758,259-block observed ledger interval; the 1,800-block proof window is not historical ownership proof.

Root read original maintenance QMP implementation and failed RESULT. The recorded BlockingIOError has no phase or traceback; connection backlog is only a hypothesis. Source currently lacks constructor exception-close, absolute per-operation deadlines across partial frames/events and correlated responses; the launch result records no error phase. Original 13 offline tests do not directly exercise QMP transport. No source was edited or test run.

Peer is preparing ONE isolated source-author input package for bounded QMP transport/diagnostics and offline regression coverage, preserving exact prelaunch/cleanup, all original tests and failed evidence. PREPARE ONLY: no author/test/build/VM/image/DB/remote/financial action delegated. Root must review exact package and current Max account before any invocation. New maintenance execution requires separate technical admission; this report does not authorize retrying the old consumed attempt or normal boot.

Restore SAME funded DNS and KVM remains first. No new runtime payment/refund, migration action, relay renewal or consumer switch occurred. Own RPC and both apps remain unproven running. Current funding-renewal preparation remains unexecuted.
