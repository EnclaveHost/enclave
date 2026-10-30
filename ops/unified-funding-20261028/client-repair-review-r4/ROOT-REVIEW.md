# Funding migration repair r4 qualification

Reviewed source snapshot; not installed or a complete production release. Staging imports and input manifests are retained exactly, so this evidence snapshot is not a portable independent test package. No owner signing, deployment, migration, USDC movement or production relay restart occurred.

## Demonstrated repairs

The real original SessionVault stores apps=[] as anyApp=false, while explicit ["*"] stores anyApp=true. The previous client and scripted fixtures conflated these. r4 validates empty, explicit wildcard and finite canonical IDs separately, preserving exact legacy scope and refusing ambiguity. Its default relay client now normalizes decimal+n JSON strings for success, pending and error responses; the previous native test wrapper concealed the missing production-client normalization.

51 offline checks PASS, zero skips, including 18 receipt, three independent reorg, 14 offline, seven partition, seven scope and two wire tests. The frozen root preview is byte-identical to the finished author sources tested here. Chain-proof, utility and v2-store implementations are unchanged from r3. Author REPORT.md is retained unedited, but its statement that the live stored grant defaults to [] is unsupported and WRONG as a statement about chain scope: the two-provider read at 53211722 found live=true, anyApp=true, finite apps=[], balance30USDC, spent0. This does NOT retrieve or reconstruct the persisted signed browser grant. Actual migration must read and match that original record.

## Native local integration

The initial r4 native run failed before the intended lost-reply stage. A diagnostic run exposed receipt_malformed: finalized header identity zero. The fixture's Anvil default epoch32 left finalized at genesis during setup. Root added --slots-in-an-epoch 1 to this owned local Anvil and asserted nonzero finalized header before signing. No production proof rule or RPC response was changed or mocked. This is accelerated local finality, not production finality qualification. Failed runs and the author-original fixture remain.

The resulting empty-scope/nine-app native flow PASS (1/1, zero skips). A second root variant PASS (1/1, zero skips): explicit original wildcard preserved, local30 ->29 legacy same key +0.8 eight finite apps +0.2 two finite apps, separate nonextractable keys, all ten gas operations settle with actual debits/ETH reserve changes. Both use actual native P256, real HTTP/createSessionsService/one TxQueue, existing original/successor bytecode and actual receipts. Lost legacy and first gas replies recover after a relay restart without a duplicate send; API authority, refund, budget conservation, finite cross-app denial, intake-off end/terminate/withdraw refusal and actual evm_revert proof-loss refusal are asserted. Existing book and deployment ownership stay unchanged. The root ten-app patch is saved separately.

Fixtures use publicly known Anvil owner keys and TEST-only mock USDC/EIP3009, registry/key attestations, DEX reserves/price and fixed fee policy. All ten fixture deployments are wallet-held; old-vault-held apps were separately tested by earlier Base fork evidence, not by this migration fixture. No production wallet signature, real Base market/fee path, production terms approval, actual pending HTTP202, or browser migration/reload is established by these runs. Both owned Anvils were cleaned up by the test. 768MiB/no-swap/CPU1 queue guard and inner700MiB/floor27648 used; ten-app peak224MiB/minhost90214MiB.

The test split0.8/0.2 is NOT an approved production split or a fresh fee quote. Current recovery inventory has ten apps (eight NucBox, image and EyesOff Metal0). Refresh finite IDs, ownership, prices, quotes and each partition budget before presenting exact new grants. Do not silently enlarge or duplicate grants.

## Browser and deployment boundary

The prior separate Chromium storage primitive test passed nonextractable key cloning,25 CAS races and reload durability. Actual migration browser integration is now being prepared in client-browser-migration-r1; it is not yet run. Raw site-patch remains unqualified and FUNDING_RUNTIME defaults null.

The production owner nonce1175 request remains UNKNOWN/nohash, helper expired; no resend or inferred rejection from unused nonce. Original30USDC remains untouched. Controller artifact provenance is included as separately verified offline evidence only: candidate8377c63d,20 remote source tests,18 transport tests, exact three image path changes, unchanged kernel/cmdline, temporary transport cleanup complete. It is unbooted with no new measured identity or production adoption.
