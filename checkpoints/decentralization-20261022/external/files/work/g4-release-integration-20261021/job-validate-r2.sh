#!/usr/bin/env bash
# the EXISTING offline validator (g4-live-config-prep, unchanged) over the relocated block r2
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-live-config-prep-20261021/validate
date -u +%FT%TZ; sha256sum validate-offline.mjs ../../g4-release-integration-20261021/config/challengeReplica.block.r2.json | cut -c1-16,65-
VALIDATE_BLOCK=/home/steven/Documents/Codex/2026-10-18/wo/work/g4-release-integration-20261021/config/challengeReplica.block.r2.json timeout 180 node --import ./register.mjs validate-offline.mjs > /home/steven/Documents/Codex/2026-10-18/wo/work/g4-release-integration-20261021/evidence/validate-r2.out 2>&1; echo "rc=$?"
python3 -c "import json;d=json.load(open('/home/steven/Documents/Codex/2026-10-18/wo/work/g4-release-integration-20261021/evidence/validate-r2.out'));print(d['result'],{k:v for k,v in d['checks'].items() if v!='PASS'})"
date -u +%FT%TZ
