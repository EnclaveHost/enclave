# Live backfill diagnostic — 2026-10-25 18:07 UTC

The running Lighthouse reconstructed 19 blobs from three sampled slots before its checkpoint: 15505056, 15506081 and 15508000 (checkpoint 15508320). The pinned coverage kzgcheck recomputed every blob commitment and all matched the served beacon commitments. This confirms historical blob reconstruction works for these samples; it is not a complete range check or authenticated canonical-history proof.

All sampled blocks still carried `execution_optimistic: true`; their `finalized: true` field is insufficient while execution remains unverified. The paired reth is still executing its catch-up range. Nothing changed `coverageVerified` or activated Base/consumers.

The diagnostic made seven bounded read-only loopback requests and ran under the shared 256 MiB queue allocation: exit 0, peak 39 MiB, host available minimum 21,213 MiB. It uses the previously tested coverage helper and pinned kzgcheck binary `00b3eeb94efece39e4f2cf8e34d5d3450d532328ccc667a6a74e83b151be10eb`. Its absolute paths describe this workstation; no blob bodies, keys or binary artifacts are published. `l1-diagnostic.json` records the earlier 18:06 state and must not be read as current readiness.

Full acceptance still requires the extracted snapshot's actual safe-head origin, every required historical block/receipt/blob, non-optimistic paired clients, and subsequent Base safe/finalized advancement.
