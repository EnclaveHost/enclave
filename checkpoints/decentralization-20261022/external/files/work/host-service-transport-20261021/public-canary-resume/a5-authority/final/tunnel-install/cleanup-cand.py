#!/usr/bin/env python3
"""Remove ONLY this helper's own leftover candidate-check staging dirs (tunnel-cand2026*: the .ps1, block.txt and sshd_config.candidate copies
staged at 21:03Z when the check failed before its own cleanup). Lists them first; nothing else is touched."""
import importlib.util, json, pathlib
s = importlib.util.spec_from_file_location('t', pathlib.Path(__file__).with_name('tunnel_install.py')); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
r = m.ps(r"""$b='C:\ProgramData\Enclave\staging';$o=[ordered]@{found=@()};
foreach($x in @(Get-ChildItem -LiteralPath $b -Directory -Filter 'tunnel-cand2026*' -ErrorAction SilentlyContinue)){
 $f=@(Get-ChildItem -LiteralPath $x.FullName -File|ForEach-Object{$_.Name});
 if(@($f|Where-Object{$_ -notin 'tunnel-receiver.ps1','block.txt','sshd_config.candidate'}).Count -eq 0){Remove-Item -LiteralPath $x.FullName -Recurse -Force;$o.found+=[ordered]@{dir=$x.Name;files=$f;removed=-not (Test-Path -LiteralPath $x.FullName)}}
 else{$o.found+=[ordered]@{dir=$x.Name;files=$f;removed=$false;why='unexpected files: left for root'}}}""")
print(json.dumps(r, indent=1)); m.rec("cleanup-cand", r)
