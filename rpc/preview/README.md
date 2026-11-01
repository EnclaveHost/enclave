# Enclave RPC catalog preview

User-requested placeholder publication, separate from the unqualified V9 native
RPC runtime. This ordinary WASI HTTP 0.2 component serves a static preview page
at GET/HEAD `/`. Other paths and methods return HTTP 503 with `rpcReady:false`.
It has no native clients, upstream RPC, chain storage, wallet, or secrets.

Catalog: `enclave-rpc`, version `0.0.1-preview`, display `Enclave RPC Preview`.
128 MiB / 1 GFLOPS CPU / no GPU / no extra ports / zero publisher fee.
Runtime hosting may still cost money; publishing does not fund a deployment.

Build offline with `cargo build --release --target wasm32-wasip2 --offline -j1`.
The logo and banner are original SVG source, with no external resources.
Publishing this preview is not production RPC readiness or attestation evidence.

Published catalog entry: https://enclave.host/apps?app=0x0f628585d36c4272ae23c55b4f9ec6d5805f25e26d4744474710e46e4edbb537

Base transaction: `0x27b491e437136e597046915f301684793b336a292f0b5a1cd8baf5429470f3c0`, block 53362069.
Owner wallet explicitly authorized this one publication because the existing
session lacks app.publish. Artifact CIDs and qualification evidence are in
`ops/unified-funding-20261028/rpc-preview-publish-r2`. The failed upload service
was bypassed using public immutable replicas on two edges plus a local IPFS pin;
this does not repair the publishing service or establish four-edge availability.
