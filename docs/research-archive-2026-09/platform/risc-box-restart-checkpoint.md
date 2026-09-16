# RISC Box restart checkpoint — 2026-09-05

Stopped tuning at the user's request for system upgrades. Local test runtime,
Moonlight, and native bridge processes have been stopped. No build is running.
The private remote deployment remains live independently of this computer.

## Saved and deployed

- Source pushed to `EnclaveHost/enclave-apps` main: `70fc67e7ff3ac0fd4dc96e98afa35cd49b0e9c8e`.
- Enclave platform main `959e2671` already pushed and deployed; runtime shared-memory adapter support is live.
- App `agent/risc-box-perf`, version `0.1.4-set64-queue`, catalog index 4.
- Live URL: https://c34499ee.app.enclave.host/
- Deployment: `0xc34499ee0e252ef82a97b219f941b54732113c9d0b7ced1d1503604d3fe152d8`.
- Actual running artifact: `bafybeig7dtbv66j5kmv4xaygujynnxodxajdofmc43rhte7ezx5e6hkfty`.
- SHA256: `533692386cc170907bad7299f998b1bcf797d00469abb15ed5f02b5686666d18`.
- Private deployment is awaiting catalog approval for public visibility; it is running and owner-accessible now.
- Metal0 allocation remains 35% CPU, 1% GPU, about 21.3 GiB RAM.
- Funding expires around **02:40 AM Phoenix, September 5** (09:40 UTC). No further top-up scheduled.

## Requirements and validation

Keep **960×600, wasm64, share-everything threads, and application SET**.
Keep fullscreen Doom with stereo effects/music. Resolution reduction is deferred.
The artifact was validated for shared memory64, shared function types, canonical
thread spawning, and SET lifecycle exports.

Completed full local demo1: 31.46 game FPS, 31.55 stream generation updates/sec;
previous live artifact local comparison: 29.60 and 30.20. These are single runs,
and stream generation updates can include band updates. This is not 60 game FPS
and does not establish that subjective smoothness is good enough.

Final live check: 27.9–30.1 source updates/sec, sound present in all sampled audio
intervals, no audio FEC or decoder errors. Chromium showed the full game/HUD;
Escape opened the menu and Escape resumed play. Native streaming used NVENC H264
and NVIDIA VDPAU decode (RTX 3070 encoder/decoder activity verified).

42 emulator tests passed (12 existing ignored); 31 bridge tests passed; all 12
Moonlight C audio-loss interoperability cases passed. Static/new-viewer/overlay
expiry/resume and palette gamma checks passed.

## Resume

All work is under `/home/steven/Documents/Codex/2026-09-04/lo/work/risc-perf/`.
Start with `CHECKPOINT.md` and `release-queue-palette-manifest.json`. The artifact
is `queue-palette-aot-set64.wasm`; `config-palette.json` contains credential
references, not secret values. Existing secret files remain local and private.
The matching quiet R2 snapshot is `risc-perf-agent/warm960-palette.snap`, containing
`/tmp/xdoom-palette-complete` and `/tmp/doom-palette-probe`. Restarting the app
restores that quiet snapshot and launches a fresh game with music.

Before another paid action, check the deployment's current funding/state. Reuse
the existing deployment; do not create a duplicate. If its browser cookie has
expired, refresh owner authentication. Use Chromium, not the internal browser.

To reconnect the existing native bridge after verifying the app is running:

```sh
cd /home/steven/Documents/Codex/2026-09-04/lo
python3 work/risc-perf/switch-bridge.py --base https://c34499ee.app.enclave.host --frames pull --stream --label resumed-queue-palette
```

The custom compiler lived in `/tmp`. Its complete `w64` and `set64` directories
were archived and tar-verified as `work/risc-perf/toolchain-before-reboot.tar`
(3,852,247,040 bytes). If the reboot clears `/tmp`, restore them to their original
location before using the saved, tested `build-candidate.sh` recipe:

```sh
mkdir -p /tmp/claude-1000/-home-steven-Projects-enclave/ca99429b-95d2-495c-b160-7aedc575621b/scratchpad
tar -xf work/risc-perf/toolchain-before-reboot.tar -C /tmp/claude-1000/-home-steven-Projects-enclave/ca99429b-95d2-495c-b160-7aedc575621b/scratchpad
```

The 174-region split-profile experiment was rejected and was never deployed.
Historical untracked binary builds/backups and Python wheels in the repositories
were preserved locally; they are not pending source changes or release inputs.
