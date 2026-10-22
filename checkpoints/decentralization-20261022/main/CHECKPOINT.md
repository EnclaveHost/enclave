# Decentralization checkpoint, 2026-10-22 (main repository)

This is a preservation snapshot of the local `decentralize/nan-retirement` work. It is not a production rollout. It does
not show that the work is complete or that it passes tests. No test suite was re-run to produce it.

## Lineage

- The parent is the published, rewritten `decentralize/nan-retirement` at `d09f377d`. That commit is the rewrite of the
  local commit `fd1cc627`, "Reuse deployed contracts for Nan retirement".
- Equivalence was checked on all 7764 paths: T(tree `fd1cc627`) equals tree `d09f377d`. 21 of those paths differ only
  by T. T is the 2026-10-21 history transform: the removed provider name, first capitalized and then lower-case,
  becomes `Cloud Provider`, byte-exact, on every blob and message.
- Three local commits that were never published were re-created on top of that parent with T applied. Each keeps its
  original author, committer and date:
  - "Restore production custody source and isolate optional pinned variant"
  - "Publish Android host releases to explicit verified targets"
  - "Ship supervisor storage imports in the Linux image"

  After the replay, the tree is T-equivalent to the local HEAD `e762a9c5` on all 7769 paths.
- The checkpoint commit then adds the dirty working tree, also with T applied. `inventory.json` lists every dirty path:
  its status, size, the sha256 of its original bytes, the decision taken, the committed blob, and whether T changed it.
- No pre-rewrite commit or object is part of this branch.
- A trial merge with `main` (`7752a423`, the PRODUCT.md/README.md claims correction and the sso commit) is clean.
  README.md auto-merges, and this branch does not touch PRODUCT.md.

## Excluded (recorded with hashes in inventory.json)

- `cache/test-failures`: a generated failure cache. The tracked file stays at its base version.
- `relay/api-relay.js.orig`: a patch(1) backup. It is the pre-patch state, and the current `relay/api-relay.js` carries
  the patch.
- `metal/guest/platform-api.bundle.mjs` (8.5 MB) and `metal/guest/mcp-server.bundle.mjs` (4.9 MB), with their manifests:
  generated outputs of `scripts/build-platform-api-guest-bundle.mjs` and `scripts/build-mcp-guest-bundle.mjs`. Build
  `relay/network-runtime.bundle.mjs` first with `node relay/build-network.mjs`. The local platform-api bundle had not
  been rebuilt after the argv-guard fix.
- `network/host-services/packages/*`: generated host-role packages ("do not edit"), up to 4.8 MB each, produced by
  `scripts/build-host-service-packages.mjs`. Tests that read these packages need a rebuild first.
- Gitignored runtime and generated state: `relay/network-runtime.bundle.mjs` and its manifest, `e2e/.stack.json`,
  `e2e/.data/`.

## Included despite the ignore rules

- `isolation/m2/encvol/roots/cacert-2026-09-25.pem` is the public Mozilla CA extract published by curl. It contains no
  key material. `//go:embed` in `isolation/m2/encvol/store.go` requires it, and its sha256 matches the pin there. The
  blanket `*.pem` ignore rule has no exception for it yet.
- Small generated bundles are kept where tracked siblings already follow that convention:
  `metal/guest/lease-gas-conduit.bundle.mjs` and `windows/node/lease-gas-runtime.bundle.mjs`, with their manifests, and
  the new `site/vendor/*` bundles.

## Appendix

`appendix/enclave-root-work/host-capacity-integration/` holds scratch from the repository's own `work/`: the
host-capacity integration script, its patches and three tests. Those patches are only partly present in the tree.
`cli-enclave`, `cli-independent-test` and `windows-agent` reverse-apply cleanly. `supervisor`, `dockerfile` and
`cli-docs` do not reverse-apply. These files are not wired into the build or the test runner.

## Known defects and unfinished state (not fixed in this snapshot)

- The rate-0 renewal cost model in the lease-gas owner is known to be inaccurate. This covers
  `network/lease-gas-owner.mjs` `renewalsFor` and the days-based reserve budget and warnings. Do not use its numbers as
  a funding forecast.
- T broke the attestation route literal: it is now `/.well-known/Cloud Provider-attestation`, with a space, in
  `supervisor.js` and `relay/api-relay.js`. The same break exists in the published base. The relay lower-cases
  own-surface paths, so the route does not match. The restore patch is still pending root approval. T also changes the
  predicate URL in `test/helpers/cli-independent-rig.mjs`.
- T changed byte-exact historical fixtures, whose hash pins no longer match:
  - `test/fixtures/registry-schema4/EnclaveRegistry.sol`
  - `test/fixtures/EnclaveRegistry.schema4.sol`
  - `test/fixtures/custodian-9d43e63/relay/snp-verify.mjs`
  - `test/fixtures/custodian-9d43e63/verifier/metal-box.mjs`

  These files are checked by `test/deployed-sources.test.mjs`, `test/lease-gas-fixtures.test.mjs` and
  `MANIFEST.json`. The original sha256 values are in `inventory.json`.
- This checkpoint contains in-progress decentralization work that has not been reviewed: independent CLI, MCP, signer
  and capacity; app-funded leases and the lease relay; host-service roles; encrypted and model volumes; the measured
  control guest; credit-vault independence; custody rewrap; and site release tooling. Release pins and deployed
  packages are unchanged.
- `secret-scan.json` holds the classified scan of all content this checkpoint adds. It stores no values. Every hit is
  either a test literal, a public development key, or a hash/ABI false positive.
