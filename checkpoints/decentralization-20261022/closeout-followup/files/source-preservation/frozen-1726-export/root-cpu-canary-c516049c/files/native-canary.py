"""Root-only staging and execution of the reviewed, isolated CPU canary; never edits live control files."""
import argparse,datetime,hashlib,importlib.util,json,pathlib,subprocess
HERE=pathlib.Path(__file__).resolve().parent
BASE=HERE.parent
ROOT=BASE.parents[1]
s=importlib.util.spec_from_file_location('helper',ROOT/'work/nucbox-tls-20261021/root-activate-reviewed.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=argparse.ArgumentParser();p.add_argument('step',choices=['stage','run','read']);a=p.parse_args()
remote=r'C:\ProgramData\Enclave\hotfix\cpu-canary-20261023-1658'
out=remote+r'\results'
commit='15ad00420'
allowed={'windows/vbslike/manager/'+x+'.mjs' for x in ['cpu-share','egress','psrun','wmi-launcher','wmiserve-run']}
allowed|={'windows/vbslike/manager/ops/launcher-canary.mjs','windows/vbslike/verify/boot-statements.mjs'}
manifest=json.loads((BASE/'native-canary/KIT-MANIFEST.json').read_text())
assert {r['path'] for r in manifest['kit']}==allowed
rows=[]
for row in manifest['kit']:
 rel=row['path'];src=BASE/'native-canary/kit'/rel
 data=src.read_bytes()
 assert hashlib.sha256(data).hexdigest()==row['sha256']
 assert data==subprocess.check_output(['git','-C',str(BASE/'repo'),'show',commit+':'+rel])
 rows.append((src,rel,row['sha256']))
runner=BASE/'native-canary/run-cpu-canary.ps1'
runner_sha=hashlib.sha256(runner.read_bytes()).hexdigest()
assert runner_sha==manifest['runner']['sha256']
rows.append((runner,'run-cpu-canary.ps1',runner_sha))
receipt=HERE/'stage.json'
checks=''.join("if((FileSha '"+remote+'\\'+rel.replace('/','\\')+"') -ne '"+sha+"'){throw 'Canary file changed: "+rel+"'};" for _,rel,sha in rows)
def invoke_script(script,seconds):
 local=HERE/('native-'+a.step+'.ps1')
 local.write_text(script+'\n')
 sha=hashlib.sha256(local.read_bytes()).hexdigest()
 dst=remote+'\\native-'+a.step+'.ps1'
 subprocess.run(['scp','-o','BatchMode=yes','-o','ConnectTimeout=15',str(local),'minipc:'+dst.replace('\\','/')],check=True,timeout=45,capture_output=True,text=True)
 return m.ps("$p='"+dst+"';if((FileSha $p) -ne '"+sha+"'){throw 'Root script changed'};& ([ScriptBlock]::Create([IO.File]::ReadAllText($p)))",seconds)
if a.step=='stage':
 dirs=sorted({str(pathlib.PurePosixPath(rel).parent) for _,rel,_ in rows})
 script=''.join("New-Item -ItemType Directory -Force -Path '"+remote+'\\'+d.replace('/','\\')+"'|Out-Null;" for d in dirs)
 r=m.ps(script+"@{ok=$true}|ConvertTo-Json -Compress",30)
 assert r.get('ok'),r
 for src,rel,_ in rows:
  subprocess.run(['scp','-o','BatchMode=yes','-o','ConnectTimeout=15',str(src),'minipc:'+remote.replace('\\','/')+'/'+rel],check=True,timeout=45)
 script=checks+r'''$err=$null;$tokens=$null;$null=[Management.Automation.Language.Parser]::ParseFile('RUNNER',[ref]$tokens,[ref]$err);if($err.Count){throw ($err|Out-String)};$os=Get-CimInstance Win32_OperatingSystem;if($os.FreePhysicalMemory -lt 8*1024*1024){throw 'Less than 8 GiB physical headroom'};if(@(Get-VM|Where-Object {$_.Name.StartsWith('enclave-cpucanary-')}).Count){throw 'Canary prefix already occupied'};$m=@(Get-NetTCPConnection -LocalPort 8091 -State Listen);if($m.Count -ne 1){throw 'Expected one Shield listener'};@{ok=$true;at=(Get-Date).ToUniversalTime().ToString('o');shieldPid=$m[0].OwningProcess;freePhysicalKiB=$os.FreePhysicalMemory;vms=@(Get-VM|Select-Object Id,Name,State)}|ConvertTo-Json -Depth 4 -Compress'''.replace('RUNNER',remote+r'\run-cpu-canary.ps1')
 r=invoke_script(script,45)
 if r.get('ok'):
  receipt.write_text(json.dumps({'commit':subprocess.check_output(['git','-C',str(BASE/'repo'),'rev-parse',commit],text=True).strip(),'manifest':manifest,'result':r},indent=2)+'\n')
elif a.step=='run':
 prior=json.loads(receipt.read_text());assert prior['manifest']==manifest
 age=datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(prior['result']['at'].replace('Z','+00:00'))
 assert age.total_seconds()<900,'Staged preflight stale'
 pid=int(prior['result']['shieldPid'])
 script=checks+f"$m=@(Get-NetTCPConnection -LocalPort 8091 -State Listen);if($m.Count -ne 1 -or $m[0].OwningProcess -ne {pid}){{throw 'Shield changed since staging'}};"
 script+="& ([ScriptBlock]::Create([IO.File]::ReadAllText('"+remote+"\\run-cpu-canary.ps1'))) -Kit '"+remote+"' -Shares @(0.01,0.21,0.13) -Out '"+out+"'"
 r=invoke_script(script,420)
 (HERE/'run.json').write_text(json.dumps(r,indent=2)+'\n')
else:
 script=r'''$files=@(Get-ChildItem -LiteralPath 'OUT' -File -ErrorAction SilentlyContinue|Where-Object {$_.Name -match '^(summary\.json|out-.+\.jsonl|err-.+\.txt)$'}|ForEach-Object {@{name=$_.Name;text=[IO.File]::ReadAllText($_.FullName)}});@{at=(Get-Date).ToUniversalTime().ToString('o');files=$files;vms=@(Get-VM|Select-Object Id,Name,State);shield=@(Get-NetTCPConnection -LocalPort 8091 -State Listen|Select-Object OwningProcess)}|ConvertTo-Json -Depth 5 -Compress'''.replace('OUT',out)
 r=invoke_script(script,45)
 (HERE/'read.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r))
if a.step!='read' and not r.get('ok'):raise SystemExit(1)
