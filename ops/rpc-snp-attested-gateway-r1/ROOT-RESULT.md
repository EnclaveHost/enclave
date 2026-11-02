# Attested RPC upstream for the gateway, r1 (live against production enclave r3)

`rpc/snp/attested-fetch.mjs` + `rpc/gateway.mjs` (`attested` config key): before using an
attested origin the gateway fetches its attestation, requires the served TLS certificate
to equal the attested one, and verifies the SNP report with relay/snp-verify.mjs
(VCEK->ASK->ARK, VMPL0, no DEBUG/MIGRATE_MA, measurement allowlist, report_data ==
sha256(served SPKI)); requests then go only over TLS pinned to that key. A key change
(enclave reboot) re-attests once; anything else fails closed. Concurrent first requests
share one attestation (found by a CLI smoke test: the second parallel call previously ran
its own attestation and hit the gateway's 3 s timeout).

live-test.tap: 4/4 PASS against https://127.0.0.1:18443 (prod r3, measurement from
ops/rpc-snp-prod-r3/EXPECTED-MEASUREMENT-8VCPU.txt): mainnet L1 reads through the gateway,
non-allowlisted measurement refused, concurrent first requests, stale pin recovery.
Existing test/rpc-gateway.test.mjs 7/7 PASS. No consumer configuration changed yet.
