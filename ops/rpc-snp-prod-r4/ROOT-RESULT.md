# Enclave RPC production run r4 (image r6) — RUNNING, syncing; Base not attached

r3 stopped through QMP power-off (clients stopped cleanly, guest powered down, exit 0).
Image r6 adds an allowlisted read-only beacon passthrough on the front
(`GET /beacon/eth/{v1/beacon/blobs|blob_sidecars|headers|genesis|states/*/finality_checkpoints,
v2/beacon/blocks, v1/node/{syncing,version,identity}, v1/config/spec}`) so the Base L1
coverage gate can read the enclave's own beacon node. Live: /beacon/eth/v1/node/syncing
answered; blobs for slot 15505000 (inside Base's derivation range from L1 origin
26265939) served 262 KB from the preserved CL DB; /beacon/eth/v1/debug/... refused (404).

State at start: reth head 26279499 (after MerkleExecute), pipeline toward 26285152;
beacon ~39.2k slots behind. Host disk guard enclave-rpc-snp-disk-guard-r4 (200 GiB floor).
Storage: deleted two qwen3.5-122b model folders (user decision) and superseded image
builds r1-r4; /vm free 458 GB. Base still needs codex-archive and .pixel10 cut over to
their verified USB copies (user approval pending; copies at ~25 MB/s).
