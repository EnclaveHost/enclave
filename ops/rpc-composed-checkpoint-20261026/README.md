# Composed RPC candidate checkpoint

Source committed and pushed to `fix/rpc-runtime-final-20261026` at `10cdf913b9b8bb168156e42da2a9a2a26c2526ad`. This is not a production release or completed RPC replacement.

The initial 41-file run had 36 clean files (297 passing cases). Subsequent targeted runs resolved session host pricing (7/7), MCP independent authority (13/13), and hosted MCP route assertions (7/7). The attached receipts cover session and hosted MCP fixes. The MCP independent receipt remains in the local artifact run; do not infer it from these attached receipts. Total qualified cases across the composed run and replacements: 324. Two original files still have unresolved checks: historical registry source-byte verification and CLI owner-secrets routing. No skipped case counts as passed.

The session fixture now uses an authenticated HTTPS capacity record and explicitly selects its local test address book. It checks signed capacity requests, grant deployment/funding, admin catalog changes, and absence of Enclave API requests. The hosted MCP assertion matches the actual combined MCP/verifier routes.

The prepared canonical runner targets this exact committed source with existing pinned Reth, Helios, witness and listener binaries. Its current run is still in progress; no result is claimed here. The local synthetic-chain tests cannot substitute for live finality, historical blob coverage, production proof serving, outage/restart behavior or consumer cutover.

At 2026-10-26 04:45:50 UTC, Ethereum was synchronized and nonoptimistic, while Base had downloaded 502.04/770.80 GB of the current snapshot batch (65.1%, estimated 5h34 remaining for that batch alone). Additional archives, extraction, synchronization and validation remain. Public RPC consumers have not been cut over. Administrator controls remain intact.

Dependency trees, compiler outputs, binaries, private temporary fixture state, and the pending historical-source restoration patch are deliberately excluded. The scripts retain exact original local paths for reproducibility.
