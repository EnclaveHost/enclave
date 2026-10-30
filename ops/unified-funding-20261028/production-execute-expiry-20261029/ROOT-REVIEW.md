# Production expired-unused payment recovery

The first production gas execution was refused before TxQueue because its required gas exceeded the old cap. The separate live cap correction is commit 1435c3ab8744. This change resolves an expired UNKNOWN call only after checking a finalized Base block beyond both deadlines, exact implementation/clone identities, and the exact lane sequence. A fresh quote and signature can then replace the journal entry by CAS while retaining its full public predecessor. No automatic payment or repeated signature is introduced.

Claude candidate independently reviewed; 37 focused tests pass, zero skips. Initial failure was a copied stale test that expected invalid duplicate record ids to be accepted by storage. Storage already refuses them; root corrected the fixture, then corrected its assertion to inspect the original valid record. Neither failure demonstrates a duplicate debit. Both failed logs retained. Product implementation remained unchanged after candidate review.

Actual Chromium/native-P256/owned-Anvil/real HTTP/one TxQueue test passed: nonextractable IndexedDB key and UNKNOWN survived reload; finalized expiry proof caused no debit/signature/send; concurrent fresh confirmations admitted one HTTP execute; exact one mock debit settled; predecessor preserved. TEST uses public fixture keys, mock USDC/DEX and a controlled 900-second Anvil time advance. It is not Base finality latency or production payment qualification. Owned server and Anvil stopped; TEST DB retained.

Production SDK retains all six other modules from the previously qualified f23ba cutover SDK byte-for-byte. Only gas-execution and its export entry change. Main source SDK integrates those same two changes and rebuilds its own vendor; its existing migration baseline is distinct from the production cutover snapshot preserved here. UI change only appends the status explanation. All runtime, grant, budget and approval terms remain byte-identical.

Additive release preserves all 1126 original site files and retains old deployed trees. Composite 1131 files, CID bafybeib5sztqg7jh6l5dattcrc4pd7kihydn2zuxn7zslv7f5hzrsr3gmy. Exact two-root Caddy CAS per edge; TLS/hash checks cover five additions and three existing files. No relay restart, financial broadcast or scope change in this release.

Initial builder correctly refused old hard pins; the copied builder's exact three content pins were updated after review. Subsequent root assertion incorrectly expected a nonexistent lib input key; corrected to the actual four changed overlay inputs. Both failures retained; no integrity check bypass.

Operational helpers are single-use evidence, not rerunnable installation instructions. Tests refer to staging fixtures and need those paths or reviewed remapping; not a portable standalone suite. No pending payment or app recovery completion is claimed by these tests.

Production read-only recovery after release hit Failed to fetch on the page's hardcoded public RPC. Its normal funding context already uses sessions config RPC https://api.enclave.host/rpc/base. No expiry status or payment success claimed yet; follow-up aligns recovery with that existing route while retaining public fallback when config is unavailable.

Initial push refused one generic-api-key false positive: the public PRE_FUNDING_API enum pre-funding-api-404-r1, already explicitly allowed in its original cutover archive. Added an exact single-path/single-literal/rule allowlist for this byte-preserved snapshot; no broad scanner bypass.
