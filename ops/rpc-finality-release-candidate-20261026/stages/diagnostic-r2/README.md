# guest-call-timeout-diagnostic-stage/r2 (PREPARED; FROZEN; nothing run by Claude). r1 (stage-root files, SHA256SUMS 4bff3fcf...) untouched.
Same read-only diagnostic as r1 (own EL :18645 / CL :15052 only; frozen canary r3 bundle; pinned checkpoint 2e8502e6; probes
el_probe.mjs / helios_probe.mjs / rpc_log_proxy.py byte-identical to r1; no source, binary, RPC-source or timeout-policy change) with
review fixes: queue claim 768 MiB (guest aggregate Helios 512M + relay 128M = 640M), host floor 16 GiB unchanged; Q=400 only with
DIAG_VARIANTS="100 400" (root coordinates with the KVM owner); rolling evidence snapshot after every phase; capture -> stop own processes
-> re-capture -> fetch -> delete (delete refuses while any own process remains); truthful status (tools/status.py) and rc
0 complete / 10 incomplete / 20 setup or host-floor stop / 30 invariant violation (production PIDs changed, own listener left bound,
PIDs never re-checked) / 40 cleanup failed. Diagnostic observations are kept separate from invariants and are never a readiness verdict.
Note: the guest Base snapshot unit was in DOWNLOAD (root's logs), not extraction; r2 records its unit state, it infers nothing from it.
Root: python3 -u ../claude-test-queue.py --mib 768 --log guest-call-timeout-diagnostic-stage/r2/logs/root-guest-call-diagnostic-r2.guard -- bash guest-call-timeout-diagnostic-stage/r2/jobs/root-guest-call-diagnostic-r2.sh
