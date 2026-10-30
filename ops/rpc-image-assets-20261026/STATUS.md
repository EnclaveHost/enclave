# Verified image asset packaging

Root1361 passed all25 overlay tests with zero failures or skips, including actual pinned native v3, both Helios builds, witness/listener and glibc files. All6 new derived-reader asset tests passed, including corrupted-native rejection. Root1356 had2 explicitly input-gated skips;1361 supplied those existing chain-verifier inputs and closed both. Root1354 failed before tests because63 tracked-but-ignored files were omitted during reconstruction; the separate harness uses git add-f-A only in the private exported repository and requires the unchanged exact5052bd58 tree before tests.

The patch composes against qualified consumer r4 tree929fc19a. No native binaries are added to Git; the exact public build/input pins and existing build provenance remain in the image record. This does not establish a new accepted measurement or SNP hardware qualification. Backend endpoint wiring and protected state enrollment/recovery remain outstanding, so this image cannot yet replace production RPC authority. No live activation occurred.

Checkpoint2e8502e6 was accepted by the actual reader and expires2026-11-01T19:21:59Z. This expiry is a remaining operational requirement, not an automatically refreshed trust anchor.
