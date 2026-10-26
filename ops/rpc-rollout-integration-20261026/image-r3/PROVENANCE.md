# accepted-image-assets-stage/r3 provenance (prepared; NOT run by Claude)

## Source
| tree | how it is made |
|---|---|
| `929fc19a53e13a78d4d182f4eb969e76b619910d` | the qualified final-consumer r4 (`final-consumer-composition-stage/r4`, SUMS `afd35070…`; runs package/integration/relay/mutants all ok) |
| `5052bd58e8399f9d5040aef911b91ca8632a2501` | + r1 `patches/accepted-image-assets-vs-r4.patch` (r1 SUMS `2210d3e3…`, frozen) |
| `c0a5f4e461f6383ced0fbc01e8b1a7569ded63c8` | + r2 `patches/accepted-image-assets-r2-vs-r1.patch` (r2 SUMS `be7ba0cf…`, frozen) |
| **`59e112516acdb77040687a03729fa2b808ecbe00`** | + r3 `patches/accepted-image-assets-r3-vs-r2.patch`: ONLY `test/derived-reader-endpoints.test.mjs` |

- **Trees:** all are reproduced with `git add -f -A` in a private export, because r4 has tracked files that `.gitignore` matches. Root's 1354 lesson.
- **The r3 change:** the r2 test forged an endpoint on `canonicalDirectConfig`'s deep-frozen output. That produced a `TypeError` instead of the role's `derived_reader_endpoint` refusal.
  - It now forges on a `structuredClone`, and asserts that the canonical object is frozen.
  - The role, measured-control, the installer, the template and the record are unchanged from r2.

## Failure evidence preserved (`inputs/root-1366/`)
**Root 1366** ran root's `accepted-image-endpoint-harness-stage`, over the frozen r2 source.
- **Copied:** the failure note, the `.out`/`.rc`/`.guard` files, the r2 run's endpoint TAP and the tail of the affected-suite TAP.
- **Endpoint tests:** 5/6. The failure is `Cannot assign to read only property 'derivedReader'`.
- **Overlay:** 25/25 with zero skips, using the real inputs.
- **Platform suites:** they timed out ("timed out waiting for a primary running the relay"), because `relay/network-runtime.bundle.mjs` was never built in that harness. That is a harness gap, and **it is NOT counted as a pass or as equal-to-baseline**.

## Build and qualification inputs (the r3 job verifies each)
- **Dependency tree:** `rpc-final-candidate-20261026/tree` at clean `64156dcd`.
  - lock `9ada1611…`; viem 2.53.1;
  - root/network/relay `node_modules` bind-mounted **read-only**, with locks equal;
  - anvil `10c1c727…`.
- **Shared relay runtime:** must equal pin **`e12c5baf…`**. Derived sidecar `schedule_reader.mjs`: pin `688b7a1f…`.
- **Reader inputs:** `accepted-image-assets-stage/runs/run-20261026T135941Z-assets-1865301/inputs` (root 1354/1361), hashed against the committed `metal/derived-reader-image.json`.
- **Chain-verifier inputs:** `canonical-integration-actual/run/regress-20261026T005955Z/chain-verifier-inputs`. The overlay tests refuse any file that is not pinned.
- **Contract artifacts:** relay tests use `offchain-registration-fixture-stage/runs/20261026T040819Z-831175`, checked against `rig-artifact-closure-stage/r2/.../ARTIFACTS-after-final.sha256`. Writer tests use the two ABIs from the dependency tree, as in r4.
- **Expected counts:**
  - from `rpc-final-candidate-20261026/TESTS.tsv`: native-relay-chain-authority 8, relay-chain-consumers 10;
  - from r4's verdicts: writer 23, relay reader 4, KVM 33;
  - new: endpoints 6, overlay 25 (6 derived-reader).
  - Other files must show an actual TAP with every test passing and 0 skip/todo/cancelled.

## Files
- `jobs/root-accepted-image-endpoints-r3.sh`: the root harness (modes `check`, `image`).
- `jobs/unenrolled-startup-config.mjs`: the stage helper. It runs the ROLE's composition (`composeDerivedReader`) for the relay startup case.
