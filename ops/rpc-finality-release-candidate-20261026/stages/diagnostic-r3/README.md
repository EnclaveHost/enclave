# guest-call-timeout-diagnostic-stage/r3 (PREPARED; FROZEN; nothing run by Claude). r1 + r2 frozen and untouched.
r3 = r2 + repair delta: guest/el_probe.mjs (r2 crashed on the first request: params=[] -> undefined.slice, aborting phase A; now a
guarded block summary; OUT rewritten atomically after every request; complete:true only after the last step), guest/helios_probe.mjs
(same incremental flush/complete flag; READY_MS env, default 900 s), tools/status.py (complete ONLY with runner rc 0 + probe complete:true
+ phase content; aborted/killed/never-ready -> incomplete), tests/test_probes.py (7 offline fixture tests of the ACTUAL probes against a
127.0.0.1 mock, pinned noble keccak from the canary r3 bundle), jobs/root-probe-fixture-tests.sh (queue 256), and
jobs/root-guest-call-diagnostic-r3.sh (= r2's job; REFUSES without a PASS fixture RESULT for these exact bytes; queue 768).
guest/diag.sh, guest/cleanup.sh, guest/rpc_log_proxy.py are byte-identical to r2. No capture timeout/binary/RPC-source change.
