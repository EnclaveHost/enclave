from pathlib import Path
import importlib.util,json,hashlib
P=Path(__file__).resolve().parent.parent;T=P.parent/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(T.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('t',T);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=json.loads((P/'component-result.json').read_text());stage=r['stage']
code=r"""$s='STAGE';$rows=@();foreach($n in 'target.cmd','backup\target.cmd'){$p=$s+'\'+$n;$a=Get-Acl -LiteralPath $p;$rows+=,[ordered]@{name=$n;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;accessSddl=$a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);hash=FileSha $p}};@{rows=$rows}|ConvertTo-Json -Compress -Depth 5""".replace('STAGE',stage)
out=m.ps(code,40)
(P/'owner-replace-diagnostic.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
