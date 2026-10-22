#!/usr/bin/env python3
"""READ-ONLY: the privacy agent's privacy-config.json chain.rpc HOST NAMES + mtime (no other field), and node.log
'[network]' enrollment line counts + last 3 (200 chars, redacted). -> minipc-c.json"""
import base64, importlib.util, json, pathlib, sys
here = pathlib.Path(__file__).resolve().parent
s = importlib.util.spec_from_file_location('t', here.parent / 'nucbox-tls-20261021' / 'root-activate-reviewed.py')
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
C = r"""$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};
$f='C:\Program Files\Enclave\network\privacy-config.json';if(-not (Test-Path -LiteralPath $f)){$f=@(Get-ChildItem -Path 'C:\Program Files\Enclave','C:\ProgramData\Enclave' -Recurse -Depth 3 -Filter 'privacy-config.json' -File -ErrorAction SilentlyContinue|Sort-Object LastWriteTimeUtc -Descending|Select-Object -First 1)[0].FullName};
$j=Get-Content -Raw -LiteralPath $f|ConvertFrom-Json;$o.privacy=[ordered]@{mtime=(Get-Item -LiteralPath $f).LastWriteTimeUtc.ToString('o');rpcHosts=@($j.chain.rpc|ForEach-Object{([uri]$_).Host});apps=@($j.apps).Count};
$n=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 30000|Where-Object{$_ -match '^\d\d:\d\d:\d\d \[node\] \[network\]'});
$o.enroll=[ordered]@{lines=$n.Count;errors=@($n -match 'enrollment: ').Count;rpcChange=@($n -match 'chain RPCs now').Count};
$o.enrollLast=@($n|Select-Object -Last 3|ForEach-Object{$x=[string]$_;$x=[regex]::Replace($x,'(?i)((?:secret|token|password|authorization|api_key|key)\s*[:=]\s*)[^\s,;]+','$1[REDACTED]');$x.Substring(0,[Math]::Min(200,$x.Length))});
$j=$o|ConvertTo-Json -Depth 5 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress"""
r = m.ps(C.replace("\n", ""), secs=90)
if r.get('payload'): r = json.loads(base64.b64decode(r['payload']).decode('utf-8'))
(here / 'minipc-c.json').write_text(json.dumps(r, indent=1) + '\n'); print(json.dumps(r, indent=1))
sys.exit(1 if r.get('error') else 0)
