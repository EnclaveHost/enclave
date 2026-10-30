# Root source review before executing r1

Do not run r1 on the original yet.

1. `run_bounded` uses communicate(), reaping the leader, then checks/kills its old process-group ID. That defeats the stated unreaped-leader safety invariant. It also lacks a parent-cancellation handler/finally around the owned child; a queue cancellation can leave qemu-io running. Reuse the already qualified MDBX r4 bounded_run and signal deferral (exact pinned source or same audited algorithm), instead of a new subtly different lifecycle. No signalling groups after leader reap. Include parent SIGTERM, orphan-held stdout, timeout and output-bound fixtures. No broad framework needed.
2. Verify qemu-io `read -C` output parsing. Local help describes machine-parsable stats; current success searches human `read N/N bytes`. Use a real tiny read fixture, not assumed output text, then parse exact bytes reported or retain verified human stats with no -v.
3. Tiny known-pattern fixture currently only checks that content was NOT printed; it does not verify expected bytes/offset. Add qemu -P known constant positive plus mismatching-pattern negative on the fixture only. No original-data dump or pattern assumption.
4. Current peer L1 comparison process2378668 is reading the same USB array (~54% complete22:20). Do not interfere. Any measured throughput is under concurrent load, not isolated disk throughput. Record this limitation. Root will check actual processes again at measurement time.
5. Avoid return0 success meaning allsamplescompleted when timeout/failedread rows exist; retain explicit complete count and measured-byte count versus requested/read budget, inconclusive if incomplete. Don't infer whole DB validation/copyETA.

Read-only recovery already authorized; original writes/download/VMboot staypaused. r1 source preserved unexecuted. Root will run corrected minimalstage fixtures then bounded original measurement.
