# Signed lifecycle permissions through actual TLS ingress

Three tests PASS,0 skip. The frozen completion-r3 real signed protocol is connected in the TEST harness to actual app-ingress, app-broker and broker-client modules. It uses real TCP/TLS and a private Unix socket inside an owned network namespace with only loopback enabled. No Enclave DNS, control relay, external RPC or chain is contacted.

1. A real witness-quorum permit admits TLS traffic for independent.example; data echoes through the app-bound broker to an actual local TLS server. Foreign SNI is refused before the broker forwards it, and the correct app stays connected.
2. The caller's authenticated same-generation Offline evidence causes the real gate to revoke its tracked actual ingress/broker resources. Active TLS closes and a fresh connection is refused.
3. A different host's authority update and Offline evidence leave the current app's active TLS connection usable. There is no foreign-host veto in this tested path.

The test's explicit gate.track callback connects existing resource-revocation primitives. This is not installed production composition. Authority, readiness, VM manager and witness transport are still labelled TEST doubles; host status comes from an injected authenticated fixture, not an independently verified Base read. The TLS server is a fixture with an ephemeral local certificate, not an attested guest. Storage/secrets callbacks remain synthetic. No claim of hardware, production authority, persistence-owner repair, automatic gas funding or full censorship resistance follows.

SOURCE-AUDIT.md identifies the existing direct authenticated GuestdIngress path and the missing process-independent compute enforcement. The legacy guest manager intentionally does not reap tenants when its supervisor is silent; do not silently reinterpret that legacy lease as a lifecycle serving permit or change live legacy behavior.

## Run and pins

U/lifecycle-real-ingress-boundary-r1; unit enclave-lifecycle-ingress-boundary-r1-20261029 invocationba732369729542fd96dcba622ffa2652 completedexit0/MainPID0. Bounds256MiB/noSwap/220RSS/floor27648/oneCPU/160s/child80s. Actual16 protocol modules plus4 network modules and the fixture/runner/package manifests make24 input pins, unchanged before/after. The inner tree peaked120MiB/minavailable33950; full outer metrics are in queue.log. Test listeners, sockets and ephemeral signer/TLS key files are cleaned by the owned harness; no production key is read/exported. No owned test remains.

Raw hashes retain exact test logs before publishing whitespace normalization. package-pins.json binds published sources/evidence. Absolute input paths preserve staging provenance; the runner is not authorization for blindly reusing old service names or output directories. Current Claude ownership repair is separately active and was not modified/executed by this test.
