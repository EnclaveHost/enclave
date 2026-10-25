# Recipe as run, local inputs, and portability

## Jobs exactly as run

All four were run from `work/rpc-production-final-20261025` on the build host:

```
attested-image-stage/tools/q.sh 1024 attimg3-g0  bash attested-image-stage/tools/g0-gates.sh     # clones + bundle gates
attested-image-stage/tools/q.sh 1024 attimg3-b1a bash attested-image-stage/tools/b1-direct.sh a  # build A (16:13:59-16:15:36Z)
attested-image-stage/tools/q.sh 1024 attimg3-b1b bash attested-image-stage/tools/b1-direct.sh b  # build B (16:18:04-16:19:41Z)
attested-image-stage/tools/q.sh 1024 attimg3-v1  bash attested-image-stage/tools/v1-direct.sh    # A==B, measurement B, verifier
```

**`tools/q.sh`:** runs the command through the shared `work/claude-test-queue.py` (memory guard, 16 GiB host floor) inside
`unshare -r -n` with only `lo` up. It retries only exit 98 ("not started"); b1b and v1 each waited once (`*.retries`).

**The build step itself**, run per side from that side's independent clean clone:

```
python3 metal/overlay-control-image.py --control direct --chain-verifier-dir "$V" "$BASE" "$OUT" 0235e7d96
```

**What each job script does:**

| script | steps |
|---|---|
| `tools/c0-clone.sh` | A = `--local --no-hardlinks` clone of `$REPO`; B = `--no-local` clone of A (no alternates); same commit and tree, clean |
| `tools/p2-rebuild.sh` + `tools/p2-nm-match.py` | every committed guest bundle rebuilt == committed; recorded `node_modules` inputs == the linked installs |
| `tools/p4-fixpoint.sh` | dependency-ordered fixed point (host-admission → lease-gas → relay/build-network → platform-api → mcp; pass 2 == pass 1; A == B) |
| `tools/b1-direct.sh` | pins → calibration → overlay unittest (0 skips) → overlay → cmdline check → measurement → artifacts.sha256 |
| `tools/v1-direct.sh` | A == B, receipts, measurement recomputed, `tools/verify-image-direct.py` |

## Local inputs (absolute paths on the build host; pins enforced by the scripts and re-checked by validation)

| input | path (`tools/env.sh`, `b1-direct.sh`) | pin |
|---|---|---|
| source repository (c0 `$REPO`) | `work/linux-rpc-consumer-closure-20261023/repo` | holds `0235e7d96`, tree `d36f220a…` |
| source commit, also | `attested-verifier-source`, remote-tracking `github/fix/rpc-attested-verifier-20261025` (as of its last fetch) | same tree |
| production base dist (`$BASE`) | `/home/steven/enclave-prod/dist-sdshield-2857356cd` | manifest `cc2571bb5b0c85b5…`, initramfs `516d766d9e31f07c…`, vmlinuz `1a3a02d5a982946e…`, measurement `b8376e15…` |
| OVMF (`$OVMF`) | `~/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd` | `142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9` |
| measurement tool | `~/.local/bin/sev-snp-measure` | version 0.0.13 (by version string only, not hashed) |
| natives (`$V`) | `work/resume-after-checkpoint-20261022/linux-rpc-runtime-launch/chain-verifier-inputs` | `PINS.sha256` (copied to `receipts/chain-verifier-inputs.PINS.sha256`); the image record `metal/chain-verifier-image.json` at the commit `23ac96ad…` |
| KEPT runtime, calibration only | `work/linux-post-adoption-release/stage/dist-leasegas-deabf8f90` | initramfs `c190c040485974a8…`, measurement `ed918e4b…` |
| overlay tool | `metal/overlay-control-image.py` at the commit | `10db3d3d43a8319e…` (as the reviewed ec56 build) |
| `node_modules` for the bundle gates | linked installs per `tools/p2-nm-match.py` | every recorded manifest input hash matched |

## Portability (assessed, not claimed)

**Reproducibly locatable:**
- the source, by commit and tree;
- every input, by hash;
- the expected outputs, by hash and measurement;
- the verifier records, as committed receipts that `validation/check-package.py` re-derives.

**NOT portable as is:**
- **Hardcoded paths:** `tools/env.sh`, `b1-direct.sh` and `verify-image-direct.py` (`BASE = Path(...)`) hardcode this
  host's absolute paths and `$HOME` tools.
- **Inputs not in git:** the base dist, OVMF and the natives are not reproducible from git.
- **Measurement tool:** it is identified by version string only.

Reproducing elsewhere needs the same-hash base dist, OVMF, natives and `sev-snp-measure` 0.0.13 at those paths, or edited
path variables.

**The scripts here are the exact bytes as run.** They are not generalized: editing them would make them no longer the
receipts of this build.

## Re-checking this package (read-only, on the build host)

`validation/v0.sh` (run via the shared queue at 512 MiB): `validation/check-package.py PKG IMAGE_STAGE SOURCE_REPO
CLONE_REPO BASE OVMF KEPT V`. Result: `validation/check-package.out`, 30/30.
