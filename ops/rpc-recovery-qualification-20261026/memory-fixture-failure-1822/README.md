# Actual r3 unit run failed; no synthetic workload was started

Eleven tests ran: ten passed and test 10 errored. The runtime initialized walkerVmRssKiB/walkerVmPteKiB but its sampler used walkerVmRSSKiB/walkerVmPTEKiB. The resulting KeyError also exposed missing finally-cleanup in that test, producing subprocess and file-handle ResourceWarnings. The gate correctly failed. Root checked the reported child PID was gone and no memory-fixture mount existed after queue completion.

The retained failed tmp data remains local; this archive contains diagnostics only. A narrow r4 fix is being prepared. No actual FUSE workload, scope limit change, production validation or RPC cutover has occurred. Do not count this run as passing qualification.
