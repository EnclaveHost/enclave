public-config-read-fallback r3 - verified multi-gateway read for pinned configs (fetchConfigCid)
Status: final candidate for root review; not built, not deployed. Receipts: RESULT.json. r2 kept in r2-snapshot/.

APPLY (root, in the site stage, after the accepted media patch 04836638)
  patch -p1 < patch/config-read-fallback.r3.patch     # 8b2d9db9; catalog.js, storage-plan.js, unixfs.js + NEW site/js/core/ipfs-car.js
  The one build then emits ipfs-car.js as one more same-origin chunk. CSP already allows https: connect/img sources.

PROOF (same as the runtime, wasm/ipfs_fetch.py fetch_verified)
  raw:    the bytes hash to the CID.
  dag-pb: a CAR (?format=car&dag-scope=all) whose blocks all hash to their CIDs, holding the requested root, rebuilt by the
          runtime's walk with its visit budget; any layout the runtime runs (CIDv0 dag-pb leaves, raw/mixed leaves, any chunking).
          Profile file bytes are accepted on a gateway without CAR only if they re-import to the same root.
  Bare bytes are never trusted.

LIMITS: see RESULT.json runtimeSemanticLimits (inherited from the runtime) and stricterThanRuntime (framing; depth > 900).

TESTS (queue only)
  tools/run-unit.sh <tag> src                                             # 36/36
  tools/run-unit.sh <tag> mut3-*|r2-snapshot/src test/car-verify-oracle.test.mjs test/config-read-fallback.test.mjs
                                                                          # controls, intended failures
