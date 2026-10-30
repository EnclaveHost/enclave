# RPC recovery and integration status — 2026-10-26 16:05 UTC

Production RPC replacement remains incomplete. Administrator controls remain required and unchanged.

The initial Base snapshot completed, but the historical-retention invocation deleted the finalized state database and began downloading it again. No recovery copy has been found; surviving static files are retained. The retention invocation stopped at15:53:59UTC because host available memory crossed below16GiB. Its sparse state partial survived the stop but has no trustworthy completion map; do not restart reth over it. The ordinary staging RPC VM then shut down gracefully at16:00:53UTC after clean L1 service stops and sync. Host available memory recovered to approximately81GiB. It remains off pending reviewed resource configuration. Existing production apps were not stopped.

Verified: lifecycle-r6 passed66 tests with zero failures/cancellations/skips/todos. The archived runner removes only an unwanted HOME override from the frozen original; source/test inputs and provenance assertions are unchanged. KVM journal-r3 full suite passed65 tests plus its native-owner check. The first full run failed because its private network namespace had loopback down; the successful rerun explicitly enabled loopback and used exactly the same frozen source/test closure.

Prepared, not production-qualified: enrollment r3/r4/r5 archives and reports. r5 addresses the independent review; its slice is still running at this writing, full composed release is unrun. Recovery client r2 is under independent review and not deployed. These artifacts do not establish live derivation, SNP readiness, recent write authority, independent quorum, or decentralized custody. Never-enrolled archive recovery remains an explicit missing path.

The memory report records pre-shutdown observations; later live values above supersede them. No new download, extraction, on-chain action, or consumer cutover is claimed here.
