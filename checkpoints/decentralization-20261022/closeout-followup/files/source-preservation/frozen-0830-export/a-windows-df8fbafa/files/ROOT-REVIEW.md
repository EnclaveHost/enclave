Verified snapshot lifecycle review, 2026-10-23

Base: 2efc4a83ec6636f875fa4523d50674bda06bcdcb. Source only; no bundle, image, production activation or live chain test.

The independent policy reader copied deadline logic without the corresponding operation cancellation/post-await checks. Root reproduced a final header arriving after chain_timeout and moving the accepted-block floor to100, causing the next otherwise valid block99 snapshot to fail chain_rollback, even though no block100 snapshot had been accepted. The public in-process verifier interface permits transports that ignore their timeout; no assumptions about interrupting arbitrary JavaScript are valid.

Fix: every request checks operation liveness before and after awaiting its transport; the final state commit checks it again. Each operation has an AbortController passed to custom transports and combined with the HTTP request timeout. Settlement (success, failure, deadline) closes the client and aborts pending HTTP work. Retained metadata-only methods now also refuse after closure. A custom transport may ignore cancellation and continue its own work; its answer cannot change the accepted floor or yield a successful snapshot.

Evidence:
- Three focused lifecycle cases pass. On exact exported base2efc, all three fail behaviorally: late floor mutation, retained metadata answers, and uncancelled local HTTP request after callback failure.
- Nine existing verified-chain tests pass with the change (service-index, policy snapshots, governance configuration, whole callback timeout, freshness/reorg and unsupported-method refusal).
- All five caller wiring cases pass on these same final source bytes. Four passed in caller-final-r2; CLI case initially failed because the sparse checkout omitted verifier dependencies, then passed alone in caller-final-r3 after restoring tracked files. No production source was changed between those runs.
- Initial parallel regression allocation exceeded256MiB and was stopped with99 (not a pass). Serialized runs stayed within256 (peak230MiB for CLI). Early sparse dependency errors were setup failures, not baseline regressions.
- No new dependency. node_modules reuses the unchanged base dependency installation. No raw RPC fallback, governance change or authority/finality upgrade.

The tests use actual reader functions with a scripted local endpoint and a real loopback HTTP server, not real Helios execution. Full composed Helios/Reth E2E remains required in the runtime integration. Apply this one-file source correction when merging A's later caller commits; A's active tree was never edited.
