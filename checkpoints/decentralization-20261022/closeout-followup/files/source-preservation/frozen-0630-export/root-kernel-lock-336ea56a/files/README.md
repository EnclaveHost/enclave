# Linux RPC runtime kernel lock

Isolated source fix for the actual two-owner race reproduced in `../root-rpc-runtime-lock-review/RESULT.json`. The original runtime creates an empty lock, then writes its PID; a contender can unlink the empty file and both callers return ownership. This module never removes the shared lock inode.

The runtime parent opens a private regular lock file. A short-lived, real `flock` subprocess receives a duplicate of that open file description as fd3 and acquires a nonblocking exclusive kernel lock. Its successful exit does not release the parent-held descriptor. The returned release function closes that descriptor exactly once. Parent death closes it through the kernel, without a stale-PID deletion race or a persistent lock-guardian process. No network or wallet operations.

## Tested

Six tests passed through the existing 256MiB queue (peak165MiB), using actual Linux processes and installed `/usr/bin/flock`: parent retains the lock after acquisition subprocess exits; same-process and cross-process contention refused; four simultaneous processes yield one owner; SIGKILL owner then reacquire; release preserves inode; malformed legacy metadata and symlink refused unchanged; missing utility cleans up; pre-abort creates no file; independent directories work. A labelled executable stand-in tests utility timeout and in-flight cancellation, not kernel exclusion.

Evidence: `TEST-RESULT.json`, `tests-final.guard.log`, tool exec chunk355d59. Earlier queue attempts exited98 without starting tests, not failures/passes. The original negative-control two-owner result remains in the adjacent review directory; it was not rerun unnecessarily.

## Integration required (not done here)

1. Copy `network/runtime-lock.mjs` and its two test files into B's final composed tree. Add the named import to `network/rpc-runtime.mjs`.
2. Delete the old `takeLock` implementation. In the async start path use `await takeRuntimeLock(path.join(stateDir, 'runtime.lock'), { flockPath: reviewedAbsoluteFlockPath })`; push the returned release function onto the existing cleanup stack immediately, before any following await. Retain lifecycle abort handling.
3. Keep runtime.lock as a persistent empty file. Shutdown tests must assert reacquisition/no held descriptor, not file absence. Never unlink it during normal cleanup, crash recovery or another startup.
4. Declare and preflight the Linux util-linux flock binary in the release package/dependencies, including its reviewed path and required flags. The default here is `/usr/bin/flock`; allow only a reviewed explicit absolute override. No installed dependency or production change made here.
5. State directory must be private/owned. Do not mix this protocol with running legacy code that removes lock files. Nonempty legacy records are refused; stop the old runtime and review migration before removing an obsolete record. No automatic PID-based reclaim.
6. Run actual composed runtime start/crash/restart/shutdown tests with listener/Helios children. Test that their spawn descriptors do not retain this parent-only lock after owner death. Preserve fd6 snapshot lifecycle and P cache/deadline changes. Root tests do not prove these integration steps or RPC independence.

This standalone commit adds only the lock module/tests, not an alternative runtime or changes to B's active tree.
