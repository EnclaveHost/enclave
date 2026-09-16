# Official RISC Box upload

Publish a new version of the existing official `risc-box` app. The current catalog
version is 0.6.53; suggested new label: **0.6.54**.

Upload `risc-box-0.6.54-set64-aot.wasm` (23,677,756 bytes). It is byte-for-byte the
verified 0.1.4-set64-queue lab release: wasm64, core share-everything threads,
application SET, AOT, completed-frame duplicate suppression, palette-matched
profile, and the GPU/audio queue improvements.

SHA256: `533692386cc170907bad7299f998b1bcf797d00469abb15ed5f02b5686666d18`

Existing IPFS CID: `bafybeig7dtbv66j5kmv4xaygujynnxodxajdofmc43rhte7ezx5e6hkfty`.

## Choose the default behavior

- **Desktop:** use `risc-box-0.6.54-desktop-config.json`. This preserves every
  existing official default and adds `set: true`. The existing rootfs boots
  normally. Emulator fixes apply, but the old guest executable does not contain
  the completed-frame frontend and is not the guest used for the measured gains.
- **Tested Doom setup:** use `risc-box-0.6.54-doom-config.json`. It restores the
  updated guest from `machines/risc-perf-agent/warm960-palette.snap`, then starts
  fullscreen Doom with music/sound automatically. The object exists in the
  current bucket (101,423,076 bytes); no S3 upload is needed. The original kernel
  and base rootfs must remain unchanged because the snapshot is bound to them.

The Doom preset fixes `ramMiB` to **21764**, the guest RAM recorded in the
snapshot. `ramMiB: auto` restores this snapshot only when the allocation yields
that same number; otherwise the app ignores it and cold-boots, losing the
matched guest/launcher. The tested Metal0 allocation was 35% CPU and 1% GPU.
Performance on smaller allocations is not verified. `snapshotSaveKey` directs
later snapshot saves away from the shared release seed; use a separate save key
for each deployment if saving independent machines.

Both configurations preserve 960×600, realtime, mem64, the official title,
media, API-key reference and S3 credential references. Keep existing secret
values in Enclave; neither configuration contains private credentials.

Keep official resource requirements and exposed ports unless deliberately
changing them: RAM minimum 3072 MiB, CPU minimum 250 GFLOPS, GPU/VRAM minimum 0;
ports `http:8000,tcp:2222,tcp:47984,tcp:47989,tcp:48010,udp:47998,udp:47999,udp:48000`.
These are catalog minimums, not the allocation used for the performance test.

## Apply the version

After publishing, select the new version on the deployment's **Version → Change
version** control. Existing per-deployment configuration overrides take
precedence over catalog defaults; update those to the chosen configuration too.
Publishing alone does not change an already running instance.

## Moonlight bridge

The Opus timing and FEC fixes are in the native `gs-bridge`, not this WASM.
The tested updated bridge is already built locally at
`/home/steven/Projects/enclave-apps/risc-box/gs-bridge/target/release/gs-bridge`.
Other bridge hosts need to update/build that directory from source commit
`70fc67e7ff3ac0fd4dc96e98afa35cd49b0e9c8e` (or later including these changes).
The validated stream used `--frames pull --fb 960x600`, NVENC H264 encoding,
and NVIDIA hardware decoding in Moonlight.
