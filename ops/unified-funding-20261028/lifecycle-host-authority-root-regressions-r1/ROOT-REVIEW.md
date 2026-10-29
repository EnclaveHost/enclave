# Independent host composition regressions

Status: two regressions reproduced against a frozen **partial** host-authority r2 author snapshot on 2026-10-29. This is not the author's final delivery, a deployment candidate, or a production incident. Source hashes and origin are in source-pins.json. The active author workspace was not edited.

## Evidence that changes the next implementation step

1. Reconciliation of an existing Running assignment returns `running`, but publishes cpuShare=0 instead of the authenticated snapshot's 0.1. The dispatch records only an in-process start reservation. Recovery therefore loses the resource commitment in its host record. The repair must retain allocations across recovery and uncertainty, and release them only after confirmed retirement; simply setting a number once is insufficient. The real host capacity aggregation and pending starts must be checked together.
2. With generationAuthority enabled, the real runner re-verifies the generation chain and replaces `snapshot.admitted` with anchor host admission. This erases the dispatch's later host-owner denial. A positive control serves successfully using the same fixture; after the local owner disables hosting, no queue/stop intent is prepared. Runtime serving refusal gives a local fence, not the ledger revocation requested by the user. Preserve proof verification while monotonically retaining current host-local refusals. Do not rewrite authenticated anchor facts or permit a local allow to elevate authority. Also preserve pending-intent reconciliation.

The actual runner and generation verifier execute against mock authenticated-anchor inputs, no certificates beyond the anchored generation, mock runtime and transaction adapters. No production key, network payment or real ledger mutation is used. Both tests failed at the intended assertions, not at fixture setup. No duplicate payment or physical over-allocation was demonstrated.

Run: shared small allocation 256 MiB/no swap; inner RSS 220 MiB, host available floor 27648 MiB; one CPU; 60-second test timeout. Queue peak 196 MiB, minimum observed host available 34224 MiB. Exit 1, 0 passing, 2 failing, 0 skipped. Failure output is root-before.log. No automatic retry or cap increase.

## Additional known integration work

The partial author's authority module explicitly names remaining r6 dependencies: global catalog moderation in `enabled`, mutable address-book equality, administrator changes blocking starts, and absent resource fields. Those admissions are correct limits, not evidence of a fully independent runtime. Actual schema-3 emergency controller/ledger/prover integration is separately in progress. No source here authorizes a contract deployment or migration.

The next author repair must address these two demonstrated regressions in the complete host/runner path and run the existing owner-race and attached-host tests. Then qualify the real chain-adapter composition rather than using fake positive authority flags as deployment evidence.
