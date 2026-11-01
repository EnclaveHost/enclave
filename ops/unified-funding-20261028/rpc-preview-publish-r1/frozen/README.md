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
