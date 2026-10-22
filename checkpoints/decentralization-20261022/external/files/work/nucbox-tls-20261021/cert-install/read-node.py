#!/usr/bin/env python3
"""READ-ONLY on the nucbox (root's reviewed transport, root-activate-reviewed.py ps()): the node's certificate lines for
0x59f1273d ONLY (never the 'isolation adopted' flood), and the live hashes of the certificate pipeline files. Nothing is
written, restarted or asked of any service. Output: primitive JSON -> read-node.json."""
import importlib.util, json, pathlib
here = pathlib.Path(__file__).resolve().parent
s = importlib.util.spec_from_file_location('activation', here.parent / 'root-activate-reviewed.py')
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
ps = r"""$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};
$o.certLines=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 30000|Where-Object {$_ -match '0x59f1273d certificate:|\] certificates:'}|Select-Object -Last 14|ForEach-Object {$x=([string]$_) -replace '[^\x20-\x7E]','~'; if($x.Length -gt 420){$x.Substring(0,420)}else{$x}});
$p=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object {$_.CommandLine -match 'agent\.mjs'});
$o.agents=@($p|ForEach-Object {[ordered]@{pid=$_.ProcessId;started=$_.CreationDate.ToUniversalTime().ToString('o');script=([regex]::Match($_.CommandLine,'[A-Za-z]:\\[^"]*?agent\.mjs')).Value}});
$o.files=@();
foreach($a in $o.agents){ if(-not $a.script){continue}; $d=Split-Path -Parent $a.script; $root=Split-Path -Parent (Split-Path -Parent $d);
 foreach($rel in @('windows\node\hvcert.mjs','windows\node\apptls.mjs','windows\node\agent.mjs','isolation\m4\guestd\supervisor-guestcert.mjs','isolation\m4\guestd\supervisor-splice.mjs','windows\vbslike\verify\judge-hv.mjs')){
  $f=Join-Path $root $rel; $o.files+=[ordered]@{path=$f;sha256=$(if(Test-Path -LiteralPath $f){(Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower()}else{'absent'});mtime=$(if(Test-Path -LiteralPath $f){(Get-Item -LiteralPath $f).LastWriteTimeUtc.ToString('o')}else{''})}}};
$o|ConvertTo-Json -Depth 5 -Compress"""
r = m.ps(ps, secs=60)
(here / 'read-node.json').write_text(json.dumps(r, indent=1) + '\n'); print(json.dumps(r, indent=1))
