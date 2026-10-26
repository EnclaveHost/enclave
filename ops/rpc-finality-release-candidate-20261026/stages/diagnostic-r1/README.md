# guest-call-timeout-diagnostic-stage (PREPARED; nothing run by Claude). Read-only, bounded diagnostic of canary r3's terminal failure
(run-20261026T071038Z-0aa8a393: Helios-verified eth_call anchorStateRegistry() on the portal aborted at the A1 reader's 20 s timeout).
No timeout, binary, RPC source or canary change: phase A times our own EL directly (eth_call / eth_createAccessList / eth_getProof at the
finalized block, sequential); phase B runs the frozen r3 bundle's pinned Helios with executionRpc through a transparent logging relay to the
SAME own EL (127.0.0.1:18646 -> :18645), repeats A1's exact first call (20 s) and a 240 s diagnostic of it, at CPUQuota 100% (canary) and 400%
(comparison only), recording scope cpu.stat/memory/PSI and guest load. Report: ../logs/claude-guest-call-timeout-diagnosis.md
