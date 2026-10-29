# EnclaveDNS owner and host payout review — 2026-10-29 23:13 UTC

User requires payout wallet `0x0b2d009c0c9Af05b12100D77F3c815fea822eE61` for all currently running enclave.host hosts. No payout mutation, signature, payment, migration, host pause or restart was performed.

## Result and assurance

Two independent-RPC quorum attempts FAILED and are retained. Initial publicnode/drpc failed before quorum. Alternate configured 1rpc/mainnet endpoints did not agree; do not describe either attempt as passing chain verification.

A separate explicitly single-provider diagnostic at api.enclave.host read block 53263038/hash ca4c857ba0e58b60b339f2bf705c0c6b0780173851d62426db7e03d21fb8b0c4 on Base. This is NOT independently confirmed or finality evidence and cannot authorize financial/payout mutation.

- EnclaveDNS `59f1273d...` has owner `0xB794C4DD0e1C5E6B72281799F282BfdE7654345D`, stored rate 2 microUSDC/s, cap 14, publisher fee 0. Its lease is expired.
- Its recorded last host `2fcef48d...` (`nucbox-k11-4`) already has the expected payout wallet. Contract `rateFor` reports 2, so this particular discrepancy is NOT explained solely by a stale rate or initial cap.
- Follow-up block 53263078/hash 020d825ad3684ad330c2a79db028842fe89c9bdebd8d5f72dfba1a2ba03f9d4b reports the B794 vault owner is the user's expected wallet. Legacy factory reports isVault=true and vaultFor(wallet)=B794, with factory code hash matching the existing reviewed legacy pin.
- API MCP Adapter `a69dcbba...` has direct owner equal to the user's wallet, stored rate 0, and the same recorded last host. This explains the current panel split: legacy contract equality recognizes the direct wallet but does not resolve ownership through the recognized vault.
- Registry schema 4 has 11 rows. Active enclave.host rows us-west, nucbox-k11-2, nucbox-k11-3 have zero payout. metal0, nucbox-k11, pixel10-pvm-cpu and nucbox-k11-4 match. kryptos also matches. Inactive metal-iso0 differs; tuna/wg-provider rows are outside the requested enclave.host scope. An active registry row is NOT proof of a currently running host; identify actual live instances before any declaration change.

## Source-grounded interpretation

Current source EnclaveDeployments.sol `_hostRate` returns zero only when registry payoutWallet equals deployment.owner. `rateFor` adds the publisher fee. A new deployment's stored rate begins as its cap. The shipped Top up frontend routes by stored snapshot.rate, so host-specific pricing can also differ for queued records. Do not assume every positive stored rate is a real target-host runtime charge. For this exact diagnostic, host-specific price remains positive because the recognized vault address differs from its beneficial owner's wallet.

The intended self-host behavior should recognize authenticated wallet ownership through a supported vault. Any implementation must verify supported factory/provenance and actual owner binding, not trust an arbitrary contract owner() getter. Do NOT change payout to B794, declare an unrelated wallet, cancel/recreate/transfer existing deployments, repeat old session migrations, or force a zero UI rate as a workaround. Existing live immutable ledger behavior needs an actual supported protocol/custody migration or reviewed pricing capability; a frontend label cannot change the contract charge. Separate publisher fees remain explicit.

## Next bounded work

1. Obtain independent fresh chain confirmation and map actual running enclave.host instances to registry IDs; prepare exact missing payout declarations only for applicable instances using the requested wallet. No broad registry sweep to mutate stale or unrelated rows.
2. Carry the recognized-vault self-host pricing defect into the replacement protocol and its UI: resolve verified economic owner, preserve direct owner authority/session restrictions, and use an actual intended-host quote with explicit placement/fallback semantics. Preserve balances, reserve owner keys, secrets and fenced migration.
3. Preserve current allocation author; do not modify its pinned inputs or launch a competing author. No frontend/backend deployment or payment occurred during this review.

All four reads used the shared 256 MiB small lane, inner 220 MiB RSS / 27648 MiB available floor / CPU1 / no swap, with bounded 90 or 60 second child timeouts. The two diagnostics completed; the first two failed for RPC availability. All four root units have MainPID=0. These are reads, not tests. Peak aggregate RSS 159/161/158/153 MiB; minimum available >=31709 MiB. Queue and inner logs, failed attempts and diagnostic results are retained. No new native Windows/Base execution qualification.
