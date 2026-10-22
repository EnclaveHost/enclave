#!/usr/bin/env python3
"""READ-ONLY: where is host-admission*.mjs under Program Files\\Enclave, its size/sha256/ACL, and which node file imports it
(booleans only). No content returned."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, '..', 'probe.py')).read().split("LOGS = r")[0]
ns = {}; exec(compile(src, 'probe.py', 'exec'), ns)
print(json.dumps(ns['ps'](r"""$r='C:\Program Files\Enclave\control';$f=@(Get-ChildItem -LiteralPath $r -Recurse -File -Filter 'host-admission*' -ErrorAction SilentlyContinue);
$o=@($f|ForEach-Object{[ordered]@{path=$_.FullName.Substring($r.Length+1);bytes=$_.Length;sha=(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower();
mtime=$_.LastWriteTimeUtc.ToString('o');acl=(Get-Acl -LiteralPath $_.FullName).Sddl}});
$imp=[bool](Select-String -LiteralPath (Join-Path $r 'windows\node\host.mjs') -SimpleMatch -Quiet -Pattern 'host-admission');
$imp2=[bool](Select-String -LiteralPath (Join-Path $r 'windows\node\agent.mjs') -SimpleMatch -Quiet -Pattern 'host-admission');
[ordered]@{files=$o;hostImports=$imp;agentImports=$imp2;dirAcl=(Get-Acl -LiteralPath (Join-Path $r 'windows\node')).Sddl}|ConvertTo-Json -Compress -Depth 4""".replace('\n', ''), 120), indent=1))
