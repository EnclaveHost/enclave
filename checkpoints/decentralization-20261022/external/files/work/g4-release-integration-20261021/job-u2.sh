#!/usr/bin/env bash
# U2 on the ACTUAL baseline (root native 23:12:08Z: installed manifest 5b966e81 = 2026.10.12.47, legacy updater e0d9df1c)
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-release-integration-20261021
T=../g4-release-train-20261021; date -u +%FT%T.%3NZ
sha256sum $T/evidence/manifest-2026.10.12.47.json evidence/latest.json $T/check-release.py | cut -c1-16,65-
python3 -c "import json;l=json.load(open('evidence/latest.json'));print('latest names manifest',l['manifest'],l['manifestSha256'][:16])"
timeout 120 python3 $T/check-release.py --installed $T/evidence/manifest-2026.10.12.47.json --new $T/evidence/manifest-2026.10.12.47.json --required $T/required-release-files.json --on-disk $T/evidence/on-disk-live.json; echo "check-release rc=$?"
date -u +%FT%T.%3NZ
