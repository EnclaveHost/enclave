from pathlib import Path
import datetime,hashlib,importlib.util,json,subprocess,uuid
p=Path(__file__).resolve().parent;t=p.parent.parent/'nucbox-tls-20261021/root-activate-reviewed.py'
sha=lambda x:hashlib.sha256(x.read_bytes()).hexdigest()
assert sha(t)=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
spec=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
stage=r'C:\ProgramData\Enclave\staging\cutover-http-integration-'+uuid.uuid4().hex[:12]
q=lambda s:"'"+s.replace("'","''")+"'"
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':stage,'files':{f:sha(p/f) for f in ['cutover.ps1','native-test.ps1']}}
with (p/'native-attempt.json').open('x') as f:json.dump(r,f,indent=2)
created=False
try:
 r['created']=m.ps(f"$s={q(stage)};if(Test-Path -LiteralPath $s){{throw 'stage exists'}};$null=New-Item -ItemType Directory -Path $s;@{{created=$s}}|ConvertTo-Json -Compress",40)
 created=r['created'].get('created')==stage
 if not created:raise RuntimeError('stage creation unconfirmed')
 for f in r['files']:subprocess.run(['timeout','40','scp','-q','-o','BatchMode=yes',str(p/f),'minipc:/'+stage.replace('\\','/')+'/'+f],check=True,capture_output=True)
 checks=';'.join(f"if((FileSha ($s+'\\{f}')) -ne '{h}'){{throw 'pin mismatch'}}" for f,h in r['files'].items())
 r['validation']=m.ps(f"$s={q(stage)};{checks};& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ($s+'\\native-test.ps1') -Stage $s;if($LASTEXITCODE -ne 0){{exit $LASTEXITCODE}}",90)
except Exception as e:r['error']=str(e)
finally:
 if created:r['cleanup']=m.ps(f"$s={q(stage)};Remove-Item -LiteralPath $s -Recurse -Force;@{{gone=(-not(Test-Path -LiteralPath $s))}}|ConvertTo-Json -Compress",40)
 (p/'native-result.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r))
raise SystemExit(0 if r.get('validation',{}).get('pass') and r.get('cleanup',{}).get('gone') else 1)
