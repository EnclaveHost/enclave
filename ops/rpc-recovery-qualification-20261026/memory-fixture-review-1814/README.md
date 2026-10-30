# r1 fixture review: do not execute the mechanism run

No actual tests have run. Independent review identified unbounded cleanup/main-lane occupancy, incomplete reservation accounting, whole-scope throttling effects and missing cancellation-path tests. Root requested a narrow new r2; r1 remains frozen and unqualified. Root additionally requires refused runs not to write receipts into a pre-existing unowned run directory.

The review's F5 estimate treats the entire MemoryHigh budget as walker memory and then adds other scope processes. That double counts them: MemoryHigh applies to the entire scope. A soft stop remains possible because the threshold is not a ceiling and RSS accounting differs from cgroup accounting, but the claimed probability is not established.

Main-lane tests remain deferred until the KVM session completes or releases its pending build/test window. All production stages, the recovery driver, original array and shared queue remain unchanged.
