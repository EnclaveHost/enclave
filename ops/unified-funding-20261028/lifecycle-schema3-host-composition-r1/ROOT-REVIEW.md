# Explicit schema3 host composition

Status: staged and fixture-qualified; NOT installed or production-ready. This feature is the highest-priority part of the censorship-resistant decentralization goal.

The newly qualified schema3 chain adapter could not be consumed by the prior host composer: snapshot admission and route binding were hardcoded to independent-r1/schema2. The two root regressions failed at those checks (before.log), without any production action.

The narrow repair adds explicit independent-schema3-r1 selection, schema3/proof2 checks, exact reviewed compiler bundle identity and finite paired route manifests. Unknown profiles, implicit upgrades, wrong chain, mismatched bindings and changed snapshots refuse. independent-r1 remains the default snapshot-admission behavior and retains its schema2 route shape. The authenticated recursive code/immutable/snapshot checks remain the responsibility of the qualified adapter; profile labels alone never authenticate chain data.

The composer distinguishes an unconfigured emergency reporter from schema incompatibility. It does not install an independent reporter or write host registry Offline. The new registry, sponsorship, capacity evidence, refill authority and fenced production migration remain required. Existing grants are not authority for new contracts.

## Evidence

- Before: two intended failures, zero passes/skips, unchanged original modules pinned in baseline-pins.json and before-source/.
- After narrow repair: both initial checks pass.
- Combined suite: 92 pass, zero failures/skips (85 existing + seven new profile/composition checks), reviewed-tests.log.
- Final focused suite: eight pass, zero failures/skips, including the seven checks and one additional generated Host test. That test exercises actual Host.shareUse/occupies/enforceOff, dispatcher and runner: unknown authority retains allocated resources, unsuccessful removal retains them, confirmed removal releases them. Lifecycle adapter, authority, runtime, inventory and financial effects are TEST mocks; the Host fixture uses loopback fake legacy RPC/public TEST keys. These 93 distinct passing checks are NOT an actual schema3-chain Host integration result.
- Final focused changes were fixture parameterization/additional test, product comments and accurate schema error text only; no semantic product change after the combined suite.
- Shared small queue256MiB, inner220MiB, available floor27648MiB, one CPU, no swap. Full run outer242/inner181MiB/min34127; final focused outer219/inner168/min34062. All commands exited0 and owned temporary children were cleaned.

The independent adapter's separate 80 actual local-chain checks are documented in lifecycle-schema3-adapter-review-r1; they are not counted again here and do not establish the new composer wired to that real adapter. The next integration must compose those exact artifacts with durable journal/runtime interfaces and actual local-chain transitions before any production plan. Positive live Base authority and deployed registry/reporters remain absent.

## Scope and reproducibility

src/ and test/ are a frozen derivative of lifecycle-independent-composition-review-r3. The prior host/journal/adapter generators are retained byte-identically; the schema3 adapter generator belongs to the separate adapter package and must be explicitly selected in any assembly. Never use the old schema2 adapter generator here as a schema3 builder. The four modified/new product files are the host profile helper, host composer, host dispatch and documentation; no Solidity, installed host, controller, funding, wallet or site mutation occurred.

Test resolution depends on frozen sibling stages, the lifecycle checkout and its node_modules. The runner pin is75590c8e4be2095b9011ea3b482ceef90a1d21f92ad676dba41578093e7db668. This package is not a portable installer. run-before.py and run-after.py record historical commands against their then-current stage; retained original source/logs distinguish them from the final snapshot. Do not rerun commands against production or overwrite preserved logs. Future assembly must pin every imported source and generate a fresh owned tree.
