#!/usr/bin/env python3
"""READ-ONLY: node.log [host] lines carrying '(N RPC failure' (the per-RPC diagnostics of the bundle deployed 15:00Z):
time, N, and the RPC host LABELS named only (no other text). -> minipc-d.json"""
import base64, importlib.util, json, pathlib, sys
here = pathlib.Path(__file__).resolve().parent
s = importlib.util.spec_from_file_location('t', here.parent / 'nucbox-tls-20261021' / 'root-activate-reviewed.py')
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
D = r"""$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};
$n=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 30000|Where-Object{$_ -match '^\d\d:\d\d:\d\d \[node\] \[(host|network)\].*\(\d+ RPC failure'});
$o.count=$n.Count;$o.rows=@($n|Select-Object -Last 40|ForEach-Object{$x=[string]$_;$c=[regex]::Match($x,'\((\d+) RPC failure');$k=[regex]::Match($x,'no fresh agreeing chain quorum|chain quorum unavailable|no fresh agreeing chain quorum within \d+ ms').Value;
[ordered]@{t=$x.Substring(0,8);n=[int]$c.Groups[1].Value;kind=$k;labels=@([regex]::Matches($x,'https://([a-z0-9.-]+): (head|read)')|ForEach-Object{$_.Groups[1].Value+' '+$_.Groups[2].Value})}});
$j=$o|ConvertTo-Json -Depth 5 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress"""
r = m.ps(D.replace("\n", ""), secs=90)
if r.get('payload'): r = json.loads(base64.b64decode(r['payload']).decode('utf-8'))
(here / 'minipc-d.json').write_text(json.dumps(r, indent=1) + '\n'); print(json.dumps(r)[:4000])
sys.exit(1 if r.get('error') else 0)
