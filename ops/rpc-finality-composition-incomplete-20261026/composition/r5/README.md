# r5: r4's runner + ONLY the generated-closure corrections (same candidate c4de37a3; r3/r4 frozen; nothing run)
| file | what |
|---|---|
| `jobs/r5-build-validate.sh` | r4's runner with: network-runtime built first (both passes, byte-identical), Windows lease runtime added, check-only site vendor builders, relay/vendor copiedFrom equality, EXACT generated-path allowlist (GENERATED.txt, untracked and ignored included), post-regeneration static staleness of EVERY committed manifest, native overlay tests with the root-0104 chain-verifier inputs (no skip), r4 stage pinned |
| `GENERATED.txt` | the 20 tracked paths a regeneration may change |
| `GENERATORS.txt` | 15 pinned builder blobs (r4's 8 + windows lease runtime + 6 vendor builders) |
| `tools/` | deps-identity.py (from r4), manifest-staleness.py (from closure-review) |
