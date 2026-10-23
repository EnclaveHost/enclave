# Windows host RAM accounting mismatch

The actual Host.capacity() reduces the app pool by each running record's declared memMb floor. Hyper-V uses appMemoryForShare(poolMiB,cpuShare,minimumMiB), reserving the purchased CPU share of the entire pool. The isolated branch records the catalog floor before returning through its isolation reconciliation; no appMiB reservation is reflected in capacity().

The bounded offline probe imports the real Host and allocator from the pinned candidate and supplies one synthetic running isolated app (25% CPU, 512 MiB minimum). At64GiB the node reports63.5GiB free while the manager's app-pool reservation leaves48GiB; at96GiB it reports95.5GiB instead of72GiB. Hyper-V VM overhead/host physical memory are additional constraints, not included in these app-pool numbers. The manager's independent admission check remains present; this does not prove actual over-allocation or explain a particular queued app incident.

This also means the UI's47.9GiB figure is not a physical-free-memory measurement. Root's earlier Windows CIM observation independently measured45.27GiB free at09:45. Raising the configured pool does not add physical RAM.

Actual test: no Hyper-V VM or production action, no chain writes/public RPC; local fake chain only, source accounting functions real, exit0 and peak87MiB under256MiB queue. Fix ownership is separate; no production/source implementation changed by this review.
