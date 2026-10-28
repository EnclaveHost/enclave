# Successor funding session: source qualification, not deployment

October 28, 2026. Original contracts, factories, address-book entries, owner controls and funded session remain unchanged. This package is an opt-in successor with a new EIP-712 version 2 and explicit action 10 gas.fund. It is NOT a runtime upgrade of immutable old clones or permission to reinterpret old signatures.

## Observed results

55 offline contract tests passed, zero failed/skipped (44 gas tests, nine legacy-behavior regressions, two root regressions). The harness uses the native P256 precompile and independent owner/session typed-data digests. Ledger, catalog, address book, payment router, reserve, old factory and old-vault sources are actual repository sources. The offline DEX/token mocks are not live liquidity or production attestations.

Root reproduced two failures in the original candidate: SessionOp reported the reserved maximum instead of actual spending, and a relayer-fee callback could change deployment ownership after the adapter's final check. The final code returns actual spending for the event and rechecks owner/app/environment scope after fee payment. The adversarial callback test instruments a mock token and mock owner with vm.etch; this does not replace P256 or establish production token upgrade safety.

Maximum input plus the signed fee is reserved before external calls. Actual swap debit plus one fee remains spent; unused input restores the same session balance, total/period spend and aggregate locked liability. The operation count is retained. The linked FundingGasLib receives the caller's exact session storage pointer under the original nonreentrant lock. Session arithmetic remains checked. The caller's unchecked locked refund is bounded by the maximum reservation just deducted, so it can restore at most the prior locked value. Exact token deltas, zero residual approvals, final scope and solvency checks remain enforced.

Wallet-held records are always production. Original-factory-held records are recognized only through the immutable trusted factory's isVault/vaultFor(owner), exact owner, and held environment. No record or custody ownership moves. ABI comparison preserves 100 original vault function/event/error signatures and five factory signatures; only open/openWithDeposit/grantDigest and factory openFor/openWithDepositFor intentionally change their Grant tuples. This surface comparison does not prove full behavior equivalence. Original release still resolves the original address-book key. Gas fees go directly to the actual successful submitter; non-gas fee routing remains unchanged.

## Size, compilation and provenance

Solidity 0.8.35, optimizer runs 1, viaIR, Osaka. Native P256 tests require this execution environment. Base's official Azul specification describes Osaka alignment: https://www.base.org/blog/introducing-base-azul (April 21, 2026 announcement). Actual deployment simulation and runtime/link verification are still required.

Early candidate runtime sizes were 24759, 24643, 24669 (rejected hash-helper experiment), 24597 and 24584 bytes. All above the 24576-byte EIP170 limit were rejected despite Foundry test deployment succeeding. Final build explicitly omits the IPFS metadata hash (`bytecode_hash = "none"`), saving 41 metadata bytes; no size override or security check was removed. Solidity's version metadata remains. Distribute the source manifest and exact compiler settings for verification; metadata discovery through IPFS is unavailable.

Final runtime: vault 24543 bytes (33 bytes headroom), factory 2091, original-behavior linked library 10686, gas library 7777. Factory initcode including seven constructor words is checked below 49152. Any source/settings/library change must be remeasured. `ROOT-RESULT-r6.json` records original stage hashes, sizes and link offsets; the portable package also passed all55 tests and the independent verify-build.py source/size guard. First package import remapping failed before tests; a distinct reserve-fixture prefix fixed the overlapping-prefix resolution. Linked addresses and immutable substitutions must be verified before activation.

The deterministic generator requires original SessionVault SHA a447add6f44ca65ecdf19625450623dce5c41270a28f0ab2b3240382d3ceeb1c and exact edit counts. `python3 prepare.py --check` prints the derived hash without writing. The generated source hash remains 492ec6cf93e167b5c800f59f5ef031b9b94363a0a84c158b7bb891a1220b4538. The EIP712 envelope uses standard 66-byte memory-safe encoding; independent signatures pass. Archived initial Claude comments saying unreviewed or stronger readiness claims are superseded by this review.

## Remaining release gates and limitations

The complete session-to-live-DEX Base-fork stage passed four tests; see base-fork/README.md and retained failures/successes. Adapter-only tests are insufficient. First fork attempt failed artifact discovery for an external linked library before tests. The corrected harness copies exact verified sources into its own src directory. Do not treat that infrastructure failure as a skipped/passing test.

No contracts deployed or real funds spent. Current old session lacks gas/deployment authority. New owner grant and deposit/migration signatures are required only after concrete reviewed activation is ready. Preserve the existing $30 and all original controls until then. Relay queue integration, optional factory admission, SDK/dashboard/CLI, owner emergency controls, code/link verification, actual canary and rollback remain required. Owner authorization cannot be inferred from a fork prank or fabricated test USDC.

No oracle fairness guarantee: exact output, signed input/price ceilings and slippage bind execution, but do not guarantee the best market price. DEX liquidity/MEV, chain reorg, RPC availability, USDC proxy administration and relayer availability remain dependencies. This is root source review, not an independent security audit. Restricted compute credit cannot be routed to the withdrawable reserve without source-aware backing/refund restrictions. ETH-to-service and eligible-credit paths remain incomplete. This package alone is not the complete unified-funding release.

Evidence text logs omit trailing whitespace only; raw stage logs remain preserved locally.
