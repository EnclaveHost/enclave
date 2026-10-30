# RPC startup fixes and first-bootstrap validation — 2026-10-26

Production RPC replacement remains incomplete. Administrator controls are preserved.

The frozen wrapper patch fixes a confirmed startup blocker: the pruned Ethereum node refuses block-zero requests with error 4444. It accepts only that exact refusal and requires mainnet consensus identity plus a fresh, non-optimistic finalized beacon payload paired to the local execution node. Existing startup gates remain enforced. This is operational identity trusting the local consensus client; it does not replace cryptographic A1 verification.

Root reviewed the code and independent review. Offline qualification passed 49 tests (34 existing, 15 new), reproduced the original failure, and killed 18 targeted mutants. The corrected test runner explicitly checks baseline exit status. Its second receipt is retained.

Root then ran exact wrapper SHA256 6a4d7aa5da385bf1d8dea74c37060eb1332d5d468625d54ae02ae878c7135189 via stdin against the real guest with only the `l1-ready` command. It passed: execution head26275660, finalized26275576, recent blob slot15514931, and mainnet-consensus-paired pruned identity. Queue exit0; host minimum available18226MiB. No code installation, service start/restart, or Base activation occurred. This newer live evidence supersedes the frozen wrapper README's earlier statement that live validation was pending.

The first-bootstrap closure reviews record defects and their provisional fixes. Review2 supersedes older findings where stated. The separate original-game canary is PREPARED ONLY: its composition/consumer inputs remain null and it refuses to run until filled from qualified final bytes. No canary success is claimed here.

Remaining integration: final bootstrap wiring, exact pinned receipt/binary packaging, activation mapping, unified source-pin cascade, affected-suite qualification, actual original-game and cold-reader canaries, final Base snapshot retention/extraction, historical blob validation, safe/finalized synchronization, transaction inclusion, and consumer cutover. No production readiness follows merely from this live L1 check.
