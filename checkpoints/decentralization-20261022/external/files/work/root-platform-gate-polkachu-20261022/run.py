from pathlib import Path
import base64,gzip,hashlib,importlib.util,json,subprocess
R=Path(__file__).resolve().parent;W=R.parent.parent
plan=json.loads((R/'plan.json').read_text());script=(R/'gate.ps1').read_text();gate=R/'gate-proof.mjs'
assert hashlib.sha256(script.encode()).hexdigest()==plan['psSha'];assert hashlib.sha256(gate.read_bytes()).hexdigest()==plan['gateSha']
t=W/'work/nucbox-tls-20261021/root-activate-reviewed.py';assert hashlib.sha256(t.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
q=lambda s:"'"+s.replace("'","''")+"'"
z=base64.b64encode(gzip.compress(script.encode(),mtime=0)).decode()
parse="$z=[Convert]::FromBase64String('"+z+"');$ms=New-Object IO.MemoryStream(,$z);$gz=New-Object IO.Compression.GZipStream($ms,[IO.Compression.CompressionMode]::Decompress);$sr=New-Object IO.StreamReader($gz,[Text.Encoding]::UTF8);$t=$sr.ReadToEnd();$sr.Close();$tk=$null;$er=$null;$null=[Management.Automation.Language.Parser]::ParseInput($t,[ref]$tk,[ref]$er);[ordered]@{errors=@($er).Count;sha=(-join([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($t))|%{$_.ToString('x2')}));ids=@($er|%{$_.ErrorId})}|ConvertTo-Json -Compress"
for txt in [script,parse]:assert len(base64.b64encode((m.HEAD.replace('SECS','90')+txt).encode('utf-16-le')))<=7900
result={'plan':plan};stage=plan['stage'];remote=stage+'\\gate-proof.mjs'
with (R/'attempt.json').open('x') as f:json.dump(plan,f)
result['parse']=m.ps(parse,60);assert result['parse'].get('errors')==0 and result['parse'].get('sha')==plan['psSha'],result
try:
 result['mkdir']=m.ps("$d="+q(stage)+";if(Test-Path -LiteralPath $d){throw 'stage exists'};$null=New-Item -ItemType Directory -Path $d;@{created=$d}|ConvertTo-Json -Compress",60)
 assert result['mkdir'].get('created')==stage,result
 cp=subprocess.run(['timeout','120','scp','-q','-o','BatchMode=yes',str(gate),'minipc:/'+remote.replace('\\','/')],capture_output=True,text=True)
 assert cp.returncode==0,cp.stderr[-400:]
 result['gate']=m.ps(script,90)
 if result['gate'].get('exitConfirmed'):
  result['cleanup']=m.ps("$d="+q(stage)+";$f="+q(remote)+";if((FileSha $f) -ne "+q(plan['gateSha'])+"){throw 'own source changed'};if(@(Get-ChildItem -LiteralPath $d -Force).Count -ne 1){throw 'unexpected stage content'};Remove-Item -LiteralPath $f;Remove-Item -LiteralPath $d;@{gone=(-not(Test-Path -LiteralPath $d))}|ConvertTo-Json -Compress",60)
finally:
 with (R/'result.json').open('x') as f:json.dump(result,f,indent=2)
 print(json.dumps(result,indent=2))
raise SystemExit(0 if result.get('gate',{}).get('result',{}).get('verdict')=='ADMISSIBLE' and result.get('cleanup',{}).get('gone') else 3)
