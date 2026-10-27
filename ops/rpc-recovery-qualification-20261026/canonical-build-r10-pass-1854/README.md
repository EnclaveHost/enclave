# Canonical build wrapper: actual process-control regressions passed

R10 separates ownership of an unreaped child from whether that child is still running. It continues handling deadlines after EOF, stops the owned process group on capture write/fsync failure, and disarms signal forwarding before the final reap.

Actual r10 results:10 disk-guard +6 mount-identity +16 gate/capture tests passed. The new16-test suite ran in9.324seconds, with no warnings/skips/failure markers. Queue peak79MiB, minimum host24357MiB; existing256MiB lane retained the4096MiB concurrent reservation and16GiB host floor. Afterward no test sleep/writer processes remained in the checked process list.

The independently queued r9 namespace suite passed all5 cases, including production home/tmp recursive read-only handling inside a nested private mount namespace, with the parent still writable afterward. Namespace code in r10 differs only in labels; its own stage-bound5-case test is queued on the512MiB exclusive lane. R9 remains unsuitable for production because its capture code is defective. Do not substitute r9 qualification for r10's required receipt.

R10 independent review is pending. No production build or recovered database validation was performed. Canonical Rust remains uncompiled. All265 parts must be independently confirmed before building, and structural/state/chain-anchor checks remain required. USB writes, paused downloads and RPC VM startup remain paused.
