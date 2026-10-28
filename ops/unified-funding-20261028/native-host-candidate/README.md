# Native HTTP successor integration

Stage r6 and packaged r2 each pass the complete real-signature HTTP flow with zero failures/skips. See ROOT-REVIEW.md for exactly what is real, mocked and unqualified. No production mutation.

Requires adjacent session-candidate build artifacts, successor-host-candidate generated relay, client-candidate codec and repository viem. Build fixture/ with forge build --offline, run python3 prepare.py, then node test/native-host.test.mjs through the shared resource queue. Direct Node still executes node:test; --test adds an unnecessary process that exceeded the small allocation. No checks are skipped. Anvil path is explicit and calls target its owned loopback instance.

Ambiguous ledger/adapter artifacts are selected by exact root-reviewed hashes. Rebuild drift refuses and must be reviewed. Initial package reserve import mismatch was corrected to the existing pinned reserve fixture. portable-test-r2.txt records the successful package run.

Production baseline is read-only. Existing sessions/sessions ABI/store hashes match the test checkout. api-relay.js and snp-verify.mjs differ: preserve running versions and every service/environment/admin configuration; never replace the whole relay directory from this checkout.
