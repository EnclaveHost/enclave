# Nan n9 terminal result

The same invocation a3a3381868dc484cb4056f6bf32d28a0 ended with local exit 2. The exact Lighthouse invocation f63230c298cf4f7896bc21bbf4c167c5 was OOM-killed at 17:55:16 UTC (Result=oom-kill, ExecMainCode=2, ExecMainStatus=9), before RPC startup. This is an actual memory failure, not expiration of the 1800-second startup allowance. No unchanged retry or cap increase is admitted.

The parent slice reached 4294967296 bytes. Last pre-death sample reports approximately 3.23 GiB anonymous memory plus 0.51 GiB file memory; its sampled OOM counters were still zero before the later unit OOM result. Do not use those pre-death counters to deny the OOM. Source markers advanced through persisted fork choice and Block production enabled, then two hot-state loads. These markers are not RPC/sync readiness.

All runtime pins are unchanged and all known local process IDs are gone. Independent remote cleanup, unmount/NBD teardown and socket closure passed; original backing unchanged and private n9 COW retained. No Base startup, production consumer changes, funds or app recovery. Full RESULT.json and failed evidence remain authoritative. The next step is exact-version source review for lower startup memory, not another unchanged longer run. EL r9 author preparation is received but unlaunched/unreviewed.
