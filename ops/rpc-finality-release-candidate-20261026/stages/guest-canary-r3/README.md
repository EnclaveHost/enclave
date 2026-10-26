# guest-capture-canary-stage/r3 (PREPARED; PENDING r10 freeze; nothing run by Claude). r1/r2 frozen and untouched.
Same safety envelope as r2 (512M scope, MemorySwapMax=0, CPUQuota=100%, 16 GiB host floor watchdog, owned cleanup trap, PIDs-unchanged
invariant, own CL :15052 / EL :18645 only, no public RPC, unchanged checkpoint 2e8502e6 + provenance c8629825). Bytes come ONLY from
base-finality-proof-stage/r10's own install/MANIFEST.json + bundle-origin.json (tools/assemble_canary_bundle.py), gated by R10-REVIEW-PINS.json
(all null now -> refuses). Runs: initial capture+verify, consumer-owned expected initial sha, recheck-capture+verify(expected), elUrl ==
http://127.0.0.1:18645 asserted AND bound by verify's boundInputs in both modes, finality-core import/runtime compatibility on guest node.
Live Base proof: NOT RUN (Base not synced; no launch record); never simulated.
Freeze after r10: fill R10-REVIEW-PINS.json from r10's frozen files, then regenerate SHA256SUMS.
Root: `python3 -u ../claude-test-queue.py --mib 512 --log guest-capture-canary-stage/r3/logs/root-guest-capture-canary.guard -- bash guest-capture-canary-stage/r3/jobs/root-guest-capture-canary.sh`
Report: ../../logs/claude-guest-capture-canary-r3.md
