# Catalog preview published; RPC remains offline

Owner-wallet publication succeeded in Base block 53362069, transaction
0x27b491e437136e597046915f301684793b336a292f0b5a1cd8baf5429470f3c0.
App ID: 0x0f628585d36c4272ae23c55b4f9ec6d5805f25e26d4744474710e46e4edbb537.
One UI submission; user signed. Receipt status 1. Actual catalog listing and
version detail confirmed, banner visibly rendered. Version 0.0.1-preview,
128 MiB / CPU1 GFLOPS / no GPU / zero publisher fee. No app deployment or funds.
Session did not authorize app.publish; explicit owner fallback approval obtained.

Actual offline compilation and wasm-tools validation PASS; artifact 100352 bytes,
SHA256 e5a1c1621a8f6f6b9ccbbf026c54aa0b79dddcc953f7d6698d8afd771b27558a.
Actual wasmtime HTTP checks: five PASS. GET/HEAD root is a preview page; other
requests return 503/rpcReady false. No native client, upstream proxy or secrets.
First compile failed Method PartialEq; corrected matches! and retained failure.
HTTP r1/r2 stopped before server on loopback permissions; r3 linker refused
missing CLI imports; r4 used reviewed host-loopback with explicit CLI imports.
All attempts retained; completed helpers must not be rerun.

Publishing service upload endpoints failed (502/network error); signed uploads
were not catalog transactions. Public bytes pinned using existing local Kubo,
raw block exact-byte readback plus CAR exports. Independent immutable artifact
routes installed on us-west and ca-east only, preserving live Caddy routes.
US-west first postcondition caught Caddy generated hide-path mismatch; separate
narrow repair succeeded with exact disk/live match. AP/Europe refused memory
admission before writes. Do not relax floors or replay successful helpers.
Two edge replicas plus local Kubo are established, not four-edge reliability.
Underlying publishing app 7ae remains unrecovered. No upload auth bypass.

Source and media state accurately describe an unfinished RPC backend. This is
not production RPC, attestation, sync/finality, storage or consumer-cutover proof.
Next remains actual native CPU app profile/controller and app-owned persistent
storage integration. No more manually managed VM-as-production trials.
