from pathlib import Path
import importlib.util,json,hashlib
P=Path(__file__).resolve().parent;W=next(x for x in P.parents if x.name=='work');T=W/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(T.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('t',T);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
code=r"""$rows=@();foreach($p in 'C:\','C:\ProgramData','C:\ProgramData\Enclave','C:\ProgramData\Enclave\backup','C:\ProgramData\Enclave\node-config.local.cmd'){$r=[ordered]@{path=$p;present=(Test-Path -LiteralPath $p)};if($r.present){$i=Get-Item -LiteralPath $p -Force;$a=Get-Acl -LiteralPath $p;$r.reparse=(([int]$i.Attributes -band 1024)-ne 0);$r.owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;$r.protected=$a.AreAccessRulesProtected;$r.rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|%{[ordered]@{sid=$_.IdentityReference.Value;type=[string]$_.AccessControlType;rights=[int]$_.FileSystemRights;inherit=[string]$_.InheritanceFlags;propagation=[string]$_.PropagationFlags}})};$rows+=,$r};@{at=[DateTime]::UtcNow.ToString('o');rows=$rows}|ConvertTo-Json -Compress -Depth 7"""
r=m.ps(code,60)
with (P/'path-access-fresh.json').open('x') as f:json.dump(r,f,indent=2)
print(json.dumps(r))
raise SystemExit(1 if 'error' in r else 0)
