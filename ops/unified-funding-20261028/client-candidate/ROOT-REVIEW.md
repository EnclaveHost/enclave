# Funding client codec: offline qualification

Pure opt-in version-2 typed data, gas intent, policy preflight and settlement parsing. Existing version-1 SDK and original session remain unchanged. No network, signing, key storage or submission is implemented here. Caller-supplied state/logs are explicitly `chainAuthenticated: false`; trusted configuration object identity does not verify chain state.

30 Node tests pass, zero skipped. Independent EIP712 encodings cover grant/call/owner operations and domain separation; exact integers, field bounds, deadlines, nonce lanes, maximum budget/period accounting, scope and canonical log/result checks are covered.

Original Claude job timed out after writing source/tests; no completion report was produced. Root's first run had 25/28 passing tests. The three initial failures were fixture errors (JSON BigInt serialization, incorrect huge-price boundary/budget fixture, and wrong expected canonical-log error). Corrected fixtures passed. Root then demonstrated and fixed two actual codec gaps: uint32 periodOps exhaustion with unlimited policy and settlement acceptance of an internally consistent foreign-payer call. Their failed test logs are retained. Only actual-debit SessionOp semantics are now supported; the rejected maximum-reporting contract candidate was never deployed.

Receipt inclusion/finality, fresh on-chain policy/identity/code pins, live quotes and fee estimation, signature authorization and contract simulation must be supplied by the integration. Existing limits may change between preflight and inclusion; the contract remains authoritative. No production integration, contract deployment, spending or grant migration occurred. No independent audit claim.

Run from this directory after the repository's viem dependency is installed: `node funding-codec.test.mjs`. Packaged import uses bare viem, preserving code behavior. Root stage logs and initial source are preserved; the portable package gets a separate test run.
