"""Root reviewed installation of inert challenge artifacts and an empty protected directory.
Only new paths; no activation, restart, service edits, wallet operations or certificate orders.
"""
import datetime,hashlib,importlib.util,json,pathlib,subprocess,sys,uuid
P=pathlib.Path(__file__).resolve().parent;W=P.parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
T=W/'nucbox-tls-20261021/root-activate-reviewed.py'
assert sha(T)=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('transport',T);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
files={'prepare.ps1':P/'prepare.ps1',**{f:W/'certificate-release-prep/release/dist'/f for f in ['dns.mjs','network-runtime.bundle.mjs','dns.mjs.manifest.json']},'network-profile-base.json':W/'enclave/contracts/deployments/network-profile-base.json'}
pins=json.loads((W/'challenge-host-tls-20261021/g4/ROOT-RELEASE-APPROVAL.json').read_text())['files'];pins['network-profile-base.json']='ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8'
for f,h in pins.items():assert sha(files[f])==h,f
pins['prepare.ps1']=sha(files['prepare.ps1'])
if sys.argv[1:]!=['--execute']:
 if sys.argv[1:]:raise SystemExit('usage: run.py [--execute]')
 print(json.dumps({'planOnly':True,'files':pins}));raise SystemExit(0)
stage=r'C:\ProgramData\Enclave\staging\challenge-prep-'+uuid.uuid4().hex[:12];q=lambda s:"'"+s.replace("'","''")+"'"
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':stage,'pins':pins,'ok':False}
with (P/'attempt.json').open('x') as f:json.dump(r,f,indent=2)
created=False
try:
 r['create']=m.ps(f"$s={q(stage)};if(Test-Path -LiteralPath $s){{throw 'stage exists'}};$null=New-Item -ItemType Directory -Path $s;@{{created=$s}}|ConvertTo-Json -Compress",40)
 created=r['create'].get('created')==stage
 if not created:raise RuntimeError('stage creation unconfirmed')
 for f,src in files.items():subprocess.run(['timeout','40','scp','-q','-o','BatchMode=yes',str(src),'minipc:/'+stage.replace('\\','/')+'/'+f],check=True,capture_output=True)
 def call(mode):return m.ps(f"$s={q(stage)};if((FileSha ($s+'\\prepare.ps1')) -ne '{pins['prepare.ps1']}'){{throw 'script changed'}};& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ($s+'\\prepare.ps1') -Mode {mode} -Stage $s;if($LASTEXITCODE -ne 0){{exit $LASTEXITCODE}}",90)
 r['inspect']=call('inspect')
 if r['inspect'].get('ok') is not True or 'error' in r['inspect']:raise RuntimeError('preflight refused; no installation')
 # The helper rechecks all preconditions before its first write.
 r['apply']=call('apply');a=r['apply'];r['ok']=a.get('ok') is True and 'error' not in a and a.get('files')=={k:v for k,v in pins.items() if k!='prepare.ps1'} and a.get('releaseInstalled') is True and a.get('declarationCreated') is True
except Exception as e:r['error']=str(e)
finally:
 if created:r['cleanup']=m.ps(f"$s={q(stage)};Remove-Item -LiteralPath $s -Recurse -Force;@{{gone=(-not(Test-Path -LiteralPath $s))}}|ConvertTo-Json -Compress",40)
 r['ok']=r['ok'] and r.get('cleanup',{}).get('gone') is True
 (P/'result.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r,indent=2));raise SystemExit(0 if r['ok'] else 1)
