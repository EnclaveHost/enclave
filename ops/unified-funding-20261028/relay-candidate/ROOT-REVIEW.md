# Root review: relay candidate remains disabled

Claude completed source-only preparation (33 turns, no tools executing code). Root inspected the deterministic generator, generated isolated ABI/patched copies, and ran 41 offline Node tests: all pass, zero skips. Transport and receipts are synthetic fixtures; no signatures are actually verified by these Node tests. The separate contract/Base-fork tests provide that different layer of evidence. The patched host itself has not been executed or deployed.

Both funding activation and opening remain disabled: reviewed fee/accept policy is absent and successor owner management is not implemented. Original routes/factory/queue/admin functions remain intact. There is no new wallet/nonce queue and no signed transaction or old session mutation.

Root identified additional release blockers beyond the Claude report: quote op-limit/uint32 and uint64 nonce exhaustion, pending vault-wide offchain revocation, receipt canonicality (especially zero-block-hash Base preconfirmations), and strict result/log encodings. The original TxQueue also accepts receipts without canonical block validation; module guards cannot retroactively turn that journal behavior into finality proof. A separate Claude successor-owner task is addressing module/control gaps, not changing production. Never activate this candidate just because41 mocked tests pass.

The report's statement that pinned identities cannot drift is too strong: address-book mappings and proxy implementations can change. Codehash pins alone do not pin proxy storage. The library substring check is not callsite verification; actual linked runtime build verification is mandatory. Identity reads from one RPC at a numbered block are not independent consensus proofs. User-owned controls, original $30, custody and deployment ownership must remain intact.

The portable package also passed all41 tests, zero skips. Log trailing whitespace is omitted; original local logs remain.
