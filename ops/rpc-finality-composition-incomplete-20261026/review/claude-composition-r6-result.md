# Composition r6: generator order from a static dependency graph (prepared only; nothing run)

Stage: `rpc-runtime-composition-stage/r6/` (SHA256SUMS `9f000bd99a9524ce…`); runner `jobs/r6-build-validate.sh` `3ba7140020c4b215…`, 34 changed lines vs r5.
- **Frozen and untouched:** r5 and r4; the runner checks both are unchanged.
- **Candidate unchanged:** c4de37a3.
- **No runtime code change:** the graph has no source import cycle.
- **What ran here:** a static git read, `bash -n`, and a dry run of the order guard's Python on the recorded graph. No tests, builds, queue, network, SSH or commits.

## r5 failure (root-composition-r5-0202, before tests)
`relay/build-network.mjs` ran first. Its entry `relay/network-runtime.mjs` reaches `windows/node/chain-reader.mjs`, which imports `chainVerifierFromEnv` and `verifiedStateReader` from `./host-admission.bundle.mjs`. Those exist only in the **regenerated** host-admission bundle, because the composition added them to network/host-admission-node.mjs. So host-admission must precede network-runtime.

## Static import-to-bundle graph (`tools/depgraph.py` → `DEPGRAPH.json`)
- **Method:**
  - 13 generators: 7 regenerated and 6 check-only vendors;
  - entries scanned transitively over the candidate's git objects (static and dynamic imports, export-from, node-style resolution);
  - each generated output is a node, so reaching one adds a producer → consumer edge;
  - cross-checked against every committed manifest's recorded esbuild inputs.
- **Static edges:**
  - host-admission → network-runtime (via windows/node/host-admission.bundle.mjs);
  - host-admission → mcp;
  - network-runtime → host-service-packages and network-runtime → platform-api (via relay/network-runtime.bundle.mjs);
  - metal-lease-gas → platform-api (via the conduit bundle).
- **Manifest-only edges:** host-admission → host-service-packages and host-admission → platform-api. Both are transitive through network-runtime, so they are consistent.
- **Independent:** windows-lease-runtime, metal-lease-gas (from the other bundles) and all 6 vendors depend on no generated artifact.
- **Result:** **no cycle, no unresolved relative import.**
- **Executed order:** host-admission → windows-lease-runtime → metal-lease-gas → network-runtime → host-service-packages → mcp → platform-api (vendors are check-only). This applies to both passes.

## New guard (before any generator runs)
The runner recomputes the graph from the candidate and requires it to equal the reviewed DEPGRAPH.json. It refuses any executed order that violates an edge, and any edge to a check-only or unknown generator. The dry run of that guard passed the r6 order and **refused r5's order** (network-runtime before host-admission).

## Root command (shared queue, 2560, offline)
    ./jobs/q-exit-status.sh rpc-runtime-composition-r6-1 2560 unshare -rn bash rpc-runtime-composition-stage/r6/jobs/r6-build-validate.sh [--precheck-only]

## Unchanged from r5, and still unproven
- **Kept as in r5:** the exact 20-path allowlist, the post-regeneration staleness of all 18 manifests, the vendor checks, the guest-verify exports, native tests with the 0104 inputs and no skip, the closure identity, and the tri-state result.
- **Limit of the graph:** it is static. A bundling failure that is not an import edge (for example an export missing from a source module) would still surface only at build time.
- **Still unknown:** consumer tests, stack tests and vendor checks run for the first time in this job. No image, SNP measurement or push exists.
