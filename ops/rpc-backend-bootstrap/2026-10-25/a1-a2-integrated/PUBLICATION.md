# Reviewed integration results, 2026-10-25 22:25 UTC

Actual full baseline: Python33+2+1, Node8, all passed, zero skips. All33 negative controls were killed by genuine expected assertion failures:25 Python guard removals with explicit named tests and8 JS guard removals. Root foreground job root-a1-a2-mutants-fixed-2225 exited0; peak141MiB, minimum host available21578MiB. The earlier failed Node baseline (missing dependency environment) is retained and is not counted as a kill.

This integrates the original-game recheck with the stopped-database procedure in source. The local provenance files require trusted root production and pinned input hashes; they are not independent SNP attestation. Tests use synthetic fixtures. No live database mutation or snapshot authentication occurred. Bytecode OPEN_GAPS is still enforced; this package alone cannot authorize production activation.
