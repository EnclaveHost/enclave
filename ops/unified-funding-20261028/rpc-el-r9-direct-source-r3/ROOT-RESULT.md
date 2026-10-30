# EL r9 terminal result — 2026-10-30 20:03 UTC

The single admitted invocation 7e9733f7884a46cd8b79fda5e93079b2 ended status 2. MainPID is zero; all nine recorded local processes are gone. All 33 source and 18 runtime pins match. No repeat was executed.

The full 3600-second recovery window ended without RPC. MerkleUnwind remained active, with 18 semantic markers, 356 valid diagnostic samples and no proven checkpoint commit. Last observed work was 2.1 seconds old, but no semantic marker had advanced for 3134.6 seconds. Parent memory reached the 2304 MiB cap (6181 max events, no OOM). Last client memory: 582 MB anonymous, 1154 MB file, 676 MB kernel including 498 MB page tables. The process recorded 778277 major faults, 4486250496 read bytes, 864792576 write bytes and 45.09 CPU seconds. These measurements suggest storage waits compounded by memory-map working-set pressure; they do not isolate disk, network transport and reclaim latency.

The exact bound exit receipt reports main exit code 1/status 0, but Reth logged its own five-second runtime shutdown timeout. Process exit is not a clean database checkpoint certificate. Main cleanup and final independent cleanup passed; original and frozen r6 backing are unchanged; private r9 COW is retained. The subsequent STOP_POST assertion resources-without-watchdog is retained separately and not erased by the successful final cleanup.

Production RPC, pairing, synchronization, Base and consumer cutover remain unqualified. No funds, refunds, application state or serving managers were changed. No unchanged rerun, automatic cap increase or timeout extension is justified. Read-only source/evidence diagnosis requested from peer; separate already-qualified Nan allocator trial may proceed only with fresh admission.
