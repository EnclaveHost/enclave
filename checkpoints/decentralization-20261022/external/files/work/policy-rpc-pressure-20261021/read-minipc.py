#!/usr/bin/env python3
"""READ-ONLY policy-pressure audit of minipc through the existing root-activate-reviewed.py ps() transport (in-session
watchdog, primitive JSON). A: sha256 of installed node files + the privacy agent's script; tracked-deployment COUNT and
10-char prefixes from host-state.json (no other field). B: per-hour COUNTS of node/network lifecycle lines, plus a few
[host]/[privacy] lines (300 chars, redacted). No env, config values, keys, secrets or app output. -> minipc.json"""
import base64, importlib.util, json, pathlib, sys
here = pathlib.Path(__file__).resolve().parent
s = importlib.util.spec_from_file_location('t', here.parent / 'nucbox-tls-20261021' / 'root-activate-reviewed.py')
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
RED = "$x=[regex]::Replace($x,'(?i)((?:secret|token|password|authorization|api_key|key)\\s*[:=]\\s*)[^\\s,;]+','$1[REDACTED]');"
A = r"""$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');files=[ordered]@{}};$d='C:\Program Files\Enclave\control\windows\node';
foreach($n in @('host.mjs','host-admission.bundle.mjs','chain.mjs','agent.mjs','network-enroll.mjs','lease-gas-runtime.bundle.mjs','isolation-lifecycle.mjs','isolation-client.mjs','verification-checkpoints.mjs','gas-runway.mjs')){$o.files[$n]=FileSha (Join-Path $d $n)};
$pa=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object{$_.CommandLine -match 'privacy-agent'});
$o.agent=@($pa|ForEach-Object{$m=[regex]::Match([string]$_.CommandLine,'[A-Za-z]:\\[^"]*?privacy-agent[^"\s]*\.mjs');[ordered]@{started=$_.CreationDate.ToUniversalTime().ToString('o');script=$m.Value;sha=$(if($m.Success){FileSha $m.Value}else{'?'})}});
$na=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object{$_.CommandLine -match 'windows\\node\\agent\.mjs'});
$o.node=@($na|ForEach-Object{[ordered]@{pid=$_.ProcessId;started=$_.CreationDate.ToUniversalTime().ToString('o')}});
$h=@(Get-ChildItem -Path 'C:\ProgramData\Enclave' -Recurse -Depth 3 -Filter 'host-state.json' -File -ErrorAction SilentlyContinue|Select-Object -First 2);
$o.state=@($h|ForEach-Object{$j=Get-Content -Raw -LiteralPath $_.FullName|ConvertFrom-Json;[ordered]@{mtime=$_.LastWriteTimeUtc.ToString('o');tracked=@($j.tracked).Count;ids=@($j.tracked|ForEach-Object{([string]$_).Substring(0,10)})}});
$j=$o|ConvertTo-Json -Depth 5 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress"""
B = (r"""$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};$L='C:\ProgramData\Enclave\logs';
$k=[ordered]@{walletUnknown='host wallet policy unavailable';retired='isolated domain retired';ckFail='checkpoint .* failed';ckFree='no checkpoints for';renewed='\] renewed 0x';renewFail='renew failed';leaseGas='lease-gas';proofErr='\] proof: ';tickErr='\] tick: '};
$n=@(Get-Content -LiteralPath (Join-Path $L 'node.log') -Tail 30000|Where-Object{$_ -match '^\d\d:\d\d:\d\d \[node\] \[host\]'});
$o.nodeSpan=@($n[0].Substring(0,8),$n[-1].Substring(0,8));$o.node=[ordered]@{};
foreach($e in $k.GetEnumerator()){$h=[ordered]@{};foreach($x in ($n -match $e.Value)){$t=$x.Substring(0,2);$h[$t]=1+[int]$h[$t]};$o.node[$e.Key]=$h};
$o.nodeLast=@($n|Where-Object{$_ -match 'renewed 0x59f1273d|59f1273d renew|no checkpoints for|lease-gas|wallet policy unavailable'}|Select-Object -Last 6|ForEach-Object{$x=[string]$_;""" + RED + r"""$x.Substring(0,[Math]::Min(300,$x.Length))});
$w=@(Get-Content -LiteralPath (Join-Path $L 'network.log') -Tail 30000|Where-Object{$_ -match '^\d\d:\d\d:\d\d \[privacy\] (chain|app 0x[0-9a-f]{8} egress)'});
$o.netSpan=@($w[0].Substring(0,8),$w[-1].Substring(0,8));$o.net=[ordered]@{};
foreach($e in ([ordered]@{chainFail='chain authorization read failed';chainLate='chain read answered after';egressOff='egress OFF';egressBack='egress back'}).GetEnumerator()){$h=[ordered]@{};foreach($x in ($w -match $e.Value)){$t=$x.Substring(0,2);$h[$t]=1+[int]$h[$t]};$o.net[$e.Key]=$h};
$o.netLast=@($w -match 'chain authorization read failed'|Select-Object -Last 2|ForEach-Object{$x=[string]$_;""" + RED + r"""$x.Substring(0,[Math]::Min(300,$x.Length))});
$j=$o|ConvertTo-Json -Depth 5 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress""")
out = {}
for name, script in (("A", A), ("B", B)):
    r = m.ps(script.replace("\n", ""), secs=90)
    if r.get('payload'): r = json.loads(base64.b64decode(r['payload']).decode('utf-8'))
    out[name] = r
(here / 'minipc.json').write_text(json.dumps(out, indent=1) + '\n'); print(json.dumps(out, indent=1))
sys.exit(1 if any(v.get('error') for v in out.values()) else 0)
