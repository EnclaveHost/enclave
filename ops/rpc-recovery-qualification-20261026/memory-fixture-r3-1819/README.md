# Test-only file-handle fix; not executed

Independent r2 review found one remaining concrete blocker: the old-directory snapshot helper leaked open files, which the test gate correctly rejects as ResourceWarning. Root replaced that helper with context-managed reads in r3. The runtime and walker are byte-identical to reviewed r2; job paths now select r3. Static Python/shell parsing passed. No actual test suite or FUSE workload has run.

After the KVM session completes or releases its reserved test window, run the eleven unit tests in the shared 512 MiB lane. Only a passing receipt permits the separate 768 MiB synthetic mechanism run. Neither source review nor a later synthetic measurement establishes production RPC readiness.
