#!/bin/bash
# Secret scans over exactly this integration's commits on A's final (df8fbafa..HEAD), with the repo's own scanners/config.
set -uo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-runtime-final-integration/repo
echo "HEAD $(git rev-parse HEAD) commits $(git rev-list --count df8fbafae081321f3c9a9c774e41007200913f32..HEAD)"
python3 -I .githooks/scan-crypto-keys.py --range df8fbafae081321f3c9a9c774e41007200913f32..HEAD; echo "scan-crypto-keys rc=$?"
gitleaks git --config .gitleaks.toml --log-opts="df8fbafae081321f3c9a9c774e41007200913f32..HEAD" --report-path ../jobs/scan-gitleaks.json --no-banner; echo "gitleaks rc=$?"
