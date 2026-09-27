# Owner app restoration — 2026-09-27

Four existing owner deployments required an explicit `isolation.require=snp-guest-per-app` option before metal-iso0 could claim them. Owner-approved Trezor transactions added that option while preserving existing configuration bytes, deployment IDs, versions, shares, caps and routing. No redeployment, top-up or weaker-host fallback was used.

## Confirmed owner transactions

| App | Deployment prefix | Base transaction | Block |
| --- | --- | --- | --- |
| S3-IPFS adapter | `7ae476a3` | `0xd0ec95e4b09a0f8890ab87c89ba2d49f31991b57e8182772d7b714cfdcf1cadc` | 51846273 |
| IPNS Publisher | `d9798e4c` | `0x8cc875ff5d3db8a5d80624483bb33a4190544e63f23b5d59e0187dfab4b4b829` | 51846311 |
| API-MCP adapter | `a69dcbba` | `0x8fe292564a646dd2af0670d8043ca6ae57b794f8d8e25e84a13a0deff95733ee` | 51846375 |
| Jot | `a77d0c57` | `0xb84b04684d1e7727605499925cc3c3ed17f5a2de51f3faf677c89a3131827125` | 51847110 |

Both independent RPCs agreed on the successful receipts and exact calldata. State was checked at each transaction's block. Checking `rate` at the latest block produces a false failure after a later `claim`: claim legitimately updates the rate to the new host's price. The owner update itself preserved the rate.

## Activation checks

All four apps passed browser-trusted HTTPS and independent guest-attestation checks. Verification required the admitted release, expected application/image, runtime identity, AMD chain, minimum TCB, fresh nonce, deployment HOST_DATA and binding to the TLS handshake key. Release:

`aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532`

- S3-IPFS health returned 200; the index was ready with 1,199 files and no reported error.
- IPNS health returned 200; HTTPS delegate publication and IPNI announcement succeeded. Direct DHT connections failed under the current HTTPS-only egress restriction; full DHT operation is not established.
- API-MCP ping returned 200; status reported configured, authentication enabled and eight tools. An unauthenticated tools/list request correctly returned 401. Authenticated downstream tool execution was not tested.
- Jot ping returned 200 over WebPKI-valid HTTPS. Fresh attestation passed for guest gd1907c983, expected image and deployment, with certificate SPKI b8aceca0322fee11d451b8a2989db00b95b81afcba5493496241c945b32fbbca.

## Jot optional key

The stored secret names lacked JOT_MASTER_KEY, although the existing configuration referenced it. The exact catalog artifact was retrieved and its CID recomputed:

`bafybeifzjpkwqv6b2ld63c5a4lz3jtxxk772a3c6x4wgomwokeryqejeiq`

Running that artifact locally with the same unresolved optional reference, without customer data or credentials, returned `encrypted:false`: the app clears an unresolved reference. Restoration preserves that existing mode. No replacement key was generated and no note data was modified. Note-level encryption at rest is therefore not enabled by this restoration, and access to existing encrypted notes was not tested.

## Funding and outstanding work

At activation, balances covered approximately 5.93 hours for S3-IPFS, 3.65 hours for IPNS, 3.99 hours for API-MCP and 3.66 hours for Jot. These are runtimes at metal-iso0's price, not the old dashboard estimate. Hosting consumes those balances normally.

RISC Box remains queued. Its current version requests a GPU and multiple TCP/UDP ports absent from this per-app runtime. Clearing its GPU request alone would not restore it. No shares, ports or version were changed. The owner requested Enclave Shield GPU exposure. Code inspection found RISC Box uses NVENC for video encoding: wasm/nvenc-shim/enclave_nvenc.c copies unmasked NV12/YUV/RGB frames into the encoder input buffer. The current shielded worker protects field GEMM operations; it has no protected video-encoding operation. The per-app guest currently rejects GPU/shielded requests and extra ports. Exposing the existing encoder would not establish frame confidentiality. A protected video path and per-app transport integration remain outstanding.

Detailed local receipts, names-only checks, transaction verification and attestation results are under `/home/steven/enclave-bench/codex-takeover/owner-restore/`. No secret values or wallet keys are included in this report.
