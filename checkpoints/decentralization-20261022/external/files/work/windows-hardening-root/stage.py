from pathlib import Path
import hashlib,json,subprocess,base64,shutil,datetime
src=Path('work/windows-hardening-release'); root=Path('work/windows-hardening-root')
m=json.loads((src/'manifest.json').read_text()); expected='fb926d42fa1f08cff8e2287ed5bb65ab732fdaf3da1f0cf7b813e9856a7d1985'
z=src/m['zip']['file']; assert hashlib.sha256(z.read_bytes()).hexdigest()==expected==m['zip']['sha256']
for name,sha in m['scripts'].items():assert hashlib.sha256((src/'stage'/name).read_bytes()).hexdigest()==sha,name
for row in m['changes']:assert hashlib.sha256((Path('work/enclave')/row['path']).read_bytes()).hexdigest()==row['after'],row['path']
for row in json.loads((src/'stage/control-plan.json').read_text())['unchanged']:assert hashlib.sha256((Path('work/enclave')/row['path']).read_bytes()).hexdigest()==row['sha256'],row['path']
archive=root/'hardening-fb926d42.zip';shutil.copy2(z,archive);(root/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
remote=r'C:\ProgramData\Enclave\activation-stage\hardening-fb926d42';remotezip=remote+'.zip'
def ps(s,timeout=60):
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-EncodedCommand',base64.b64encode(s.encode('utf-16le')).decode()],capture_output=True,text=True,timeout=timeout)
 if r.returncode:raise RuntimeError(r.stdout+'\n'+r.stderr)
 return r.stdout
ps("$ErrorActionPreference='Stop';if((Test-Path -LiteralPath '"+remote+"') -or (Test-Path -LiteralPath '"+remotezip+"')){throw 'stage or zip exists: inspect instead of overwriting'}")
r=subprocess.run(['scp','-q',str(archive),'minipc:C:/ProgramData/Enclave/activation-stage/hardening-fb926d42.zip'],capture_output=True,text=True,timeout=90);assert r.returncode==0,r.stderr
out=ps("$ErrorActionPreference='Stop';$z='"+remotezip+"';$s='"+remote+"';if((Get-FileHash -LiteralPath $z -Algorithm SHA256).Hash.ToLower() -ne '"+expected+"'){throw 'archive mismatch'};if(Test-Path -LiteralPath $s){throw 'stage exists'};Expand-Archive -LiteralPath $z -DestinationPath $s;[pscustomobject]@{stage=$s;archiveHash='"+expected+"';activated=$false}|ConvertTo-Json -Compress")
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'remote':json.loads(out),'mainClosureVerified':80,'changes':3,'productionActivated':False}
Path('outputs/app-lease-gas-review/windows-hardening-staged.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
