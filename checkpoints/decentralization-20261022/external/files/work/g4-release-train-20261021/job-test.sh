#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-release-train-20261021
date -u +%FT%TZ; sha256sum check-release.py test_check_release.py required-release-files.json evidence/on-disk-live.json | cut -c1-16,65-
timeout 300 python3 test_check_release.py 2>&1 | tail -12; echo rc=$?
echo "== S3 detail (synthetic newer publish of 2026.10.12.47 content over installed 2026.10.12.47)"
python3 -c "
import importlib.util,json,copy,pathlib
s=importlib.util.spec_from_file_location('c','check-release.py');c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
m=c.load('evidence/manifest-2026.10.12.47.json');n=copy.deepcopy(m);n['version']='2026.10.21'
r,rc=c.judge(m,n,c.load('required-release-files.json'),c.load('evidence/on-disk-live.json'))
print(json.dumps({k:v for k,v in r.items() if k!='required'}));[print(' ',p,v) for p,v in r['required'].items()]"
date -u +%FT%TZ
