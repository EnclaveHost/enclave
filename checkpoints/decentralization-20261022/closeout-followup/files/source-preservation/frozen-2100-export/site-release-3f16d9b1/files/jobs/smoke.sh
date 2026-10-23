#!/bin/bash
set -euo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-site-release-20261023
R=$S/release/bafybeiax6ngccp7bxoiex5pqv2yoz2ekfk227pthlzfrqkv32v6jt7stmi
timeout -k 5 240 node $S/tools/inert-smoke.mjs $R $S/check/release-check.json $S/check/inert-smoke.json
