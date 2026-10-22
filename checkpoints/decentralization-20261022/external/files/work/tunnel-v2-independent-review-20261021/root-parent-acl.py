"""Read-only parent-directory ACL proof for the SYSTEM task staging gate."""
import base64, datetime, importlib.util, json, pathlib

W = pathlib.Path(__file__).resolve().parents[1]
s = importlib.util.spec_from_file_location('transport', W / 'nucbox-tls-20261021/root-activate-reviewed.py')
t = importlib.util.module_from_spec(s)
s.loader.exec_module(t)
script = r'''$ErrorActionPreference='Stop';$sid=[Security.Principal.SecurityIdentifier];$facts=@();
foreach($p in @('C:\ProgramData\Enclave','C:\ProgramData\Enclave\staging')){
 $i=Get-Item -LiteralPath $p -Force;$a=Get-Acl -LiteralPath $p;
 $aces=@($a.GetAccessRules($true,$true,$sid)|ForEach-Object{
  [ordered]@{sid=$_.IdentityReference.Value;type=[string]$_.AccessControlType;rights=[int]$_.FileSystemRights;inheritance=[string]$_.InheritanceFlags;propagation=[string]$_.PropagationFlags}});
 $facts+=[ordered]@{path=$p;owner=$a.GetOwner($sid).Value;reparse=[bool]($i.Attributes -band 1024);sddl=$a.Sddl;aces=$aces}}
$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');facts=$facts};
$j=$o|ConvertTo-Json -Depth 6 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress'''
r = t.ps(script, secs=45)
if not r.get('payload'):
    raise RuntimeError('No complete ACL response: ' + str(r))
e = json.loads(base64.b64decode(r['payload']))
e['purpose'] = 'read-only staging parent ACL evidence; no ACL or service changes'
p = pathlib.Path(__file__).with_name('root-parent-acl-result.json')
p.write_text(json.dumps(e, indent=2) + '\n')
print(json.dumps(e, indent=2))
