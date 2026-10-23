#!/bin/bash
set -euo pipefail
node --experimental-vm-modules work/resume-after-checkpoint-20261022/root-wallet-rpc-review/probe.mjs
python3 work/resume-after-checkpoint-20261022/root-checkpoint-0630-review/verify.py
