#!/usr/bin/env python3
"""READ-ONLY: the minipc node agent's record for 0x38f368d6 (GET 127.0.0.1:9600/v1/deployments, the list the console's
fleet reason is read from). Only status/reason-like fields of THIS deployment are returned, redacted by probe.redact."""
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location('probe', 'probe.py')
sys.argv = ['probe.py', 'none']
src = open('probe.py').read().split("LOGS = r")[0]          # reuse ps() and redact() only, not the CLI part
ns = {}; exec(compile(src, 'probe.py', 'exec'), ns)
res = ns['ps']("$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:9600/v1/deployments';$j=$r.Content|ConvertFrom-Json;"
               "$all=@($j.deployments);if(-not $all){$all=@($j)};$d=@($all|Where-Object{[string]$_.id -like '0x38f368d6*'});"
               "$o=@($d|ForEach-Object{[ordered]@{id=[string]$_.id;status=[string]$_.status;reason=[string]$_.reason;lastError=[string]$_.lastError;"
               "appRef=[string]$_.appRef;updatedAt=[string]$_.updatedAt;fleet=[string]($_.fleet|ConvertTo-Json -Compress -Depth 3)}});"
               "[ordered]@{http=[int]$r.StatusCode;count=$all.Count;match=$o}|ConvertTo-Json -Compress -Depth 4", 90)
if isinstance(res, dict):
    for m in res.get('match') or []:
        for k in list(m): m[k] = ns['redact'](m[k] or '')[:400]
print(json.dumps(res, indent=1))
