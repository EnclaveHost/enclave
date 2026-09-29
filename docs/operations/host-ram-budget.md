# Host RAM budgets

For the Windows node, `NODE_APP_RAM_GB` sets the hosted-app admission budget in GiB independently of `RESERVED_SHARE` (CPU reservation). It is bounded by `NODE_RAM_GB` / detected physical memory. Invalid or negative explicit values offer zero memory. Omission preserves the previous reserved-share formula. `nodeRamGb` reports the resulting hosting pool; `machineRamGb` reports physical capacity. Existing instances are preserved when a budget is lowered.

For the Linux isolated guest manager, `-guest-mem-mib` sets the pool. Reservations include guest memory plus 768 MiB of unit overhead. Lowering the budget does not shrink existing guests. Recovery preserves verified guests, marks an oversized pool overcommitted and refuses new creates until it fits. **Existing apps cannot restart while their required reservation does not fit.** Do not confuse this admission limit with an immediately enforced physical-memory ceiling.

## 2026-09-29 request and audit

Steven requested 64 GiB for nucbox-k11 and metal0, retaining NucBox's separate 12 GiB GPU pool.

NucBox: four existing guest VMs preserved, node-only restart. Pool changed to 64 GiB, 47.8 GiB unreserved by app floors; physical RAM remains 112 GiB. The GPU pool remains 12 GiB. Per-VM/runtime overhead also consumes physical RAM outside the catalog floor accounting.

Metal0: configured pool changed from 88 to 64 GiB after all six guests passed adoption checks. Six instances remained running. They reserve 86272 MiB (84.25 GiB); the pool correctly reports overcommitted and zero new capacity. This does not complete the reduction of actual RAM consumption. Eyesoff alone has a 73728 MiB (72 GiB) guest. The other five plus unit overhead leave at most 52992 MiB for its guest within a 64 GiB total pool.

Eyesoff's catalog declares 4096 MiB for GPU execution and 38912 MiB CPU fallback. Shield inference currently retains weights and KV in private guest RAM and independently enforces a model-specific floor. More untrusted GPU VRAM does not automatically replace that private storage. The measured runtime has eight active sessions plus six conversation-cache and eight shared-prefix states; both ordinary and MTP contexts incur memory costs. The previous recovery raised the floor after real chat plus warmup exceeded the old guest allowance. Lowering this floor without qualifying the runtime can reproduce crashes.

No orphaned Metal0 guests were reported at the audit; host memory PSI averages were zero. Eyesoff's unit held about 62.6 GiB, mostly private guest memory reported as unevictable file-backed pages. This is not proof of absent application leaks, and clearing host page cache would not reclaim those guest pages. Investigate bounded cache retention, release of expired state, and peak memory across repeated chat/warmup cycles before reducing the measured runtime floor. Do not erase useful prefill caches or reduce the eight-session requirement without an explicit design decision.

Local rollout evidence: `/home/steven/enclave-bench/host-ram-64g-20260929/`. NucBox backup: `C:\Users\claude\vbs-evidence\market-qualification-20260929\ram64-backup`. Metal0 override: `enclave-guestd.service.d/90-host-ram-budget.conf`; removing this override restores the preceding 88 GiB budget without changing app allocations.
