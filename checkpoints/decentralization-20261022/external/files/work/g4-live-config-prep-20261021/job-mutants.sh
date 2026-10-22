#!/usr/bin/env bash
# NEGATIVE CONTROLS (queue 256, local): each mutant block must FAIL exactly its targeted check.
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-live-config-prep-20261021/validate
date -u +%FT%TZ; ok=0; n=0
for f in mutants/*.json; do n=$((n+1)); want=$(python3 -c "import json;print(json.load(open('$f'))['expectFail'])"); python3 -c "import json;json.dump(json.load(open('$f'))['block'],open('/tmp/mutant-block.json','w'))"
  VALIDATE_BLOCK=/tmp/mutant-block.json timeout 180 node --import ./register.mjs validate-offline.mjs > /tmp/mutant.out 2>&1; rc=$?
  got=$(python3 -c "import json;d=json.load(open('/tmp/mutant.out'));print(d['checks'].get('$want',''))" 2>/dev/null)
  case "$got" in FAIL*) [ $rc -ne 0 ] && { ok=$((ok+1)); echo "KILLED $(basename $f) -> $want: ${got:0:140}"; } || echo "NOT KILLED $(basename $f)";; *) echo "NOT KILLED $(basename $f) rc=$rc got=$got";; esac
done; rm -f /tmp/mutant-block.json /tmp/mutant.out; echo "killed $ok/$n"; date -u +%FT%TZ
