#!/usr/bin/env bash
# v0 (queue 512, read-only): cross-consistency of the receipt package vs the stage's outputs, local pinned inputs and git.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/attested-image-publish-stage/ops/rpc-attested-image/2026-10-25
python3 -u $P/validation/check-package.py $P /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/attested-image-stage /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/attested-verifier-source \
  /home/steven/Documents/Codex/2026-10-18/wo/work/linux-rpc-consumer-closure-20261023/repo /home/steven/enclave-prod/dist-sdshield-2857356cd \
  $HOME/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd /home/steven/Documents/Codex/2026-10-18/wo/work/linux-post-adoption-release/stage/dist-leasegas-deabf8f90 \
  /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-rpc-runtime-launch/chain-verifier-inputs
