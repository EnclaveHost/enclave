import pathlib,hashlib,json,subprocess,importlib.util,argparse
p=pathlib.Path(__file__).resolve().parent;s=importlib.util.spec_from_file_location('helper','work/nucbox-tls-20261021/root-activate-reviewed.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
a=argparse.ArgumentParser();a.add_argument('step',choices=['stage','run','read']);step=a.parse_args().step
remote=r'C:\ProgramData\Enclave\hotfix\cpu-workload-exact-20261023';kit=p/'workload-exact-kit';manifest=json.loads((kit/'manifest.json').read_text());runner=p/'run-workload-exact.ps1';runnerSha=hashlib.sha256(runner.read_bytes()).hexdigest()
if step=='stage':
 dirs=sorted(set(str(pathlib.PurePosixPath(f['path']).parent).replace('/','\\') for f in manifest['files']))
 r=m.ps("$p='"+remote+"';if(Test-Path $p){throw 'Stage occupied'};"+''.join("New-Item -ItemType Directory -Force -Path '"+remote+'\\'+d+"'|Out-Null;" for d in dirs)+"@{ok=$true}|ConvertTo-Json -Compress",30);assert r.get('ok'),r
 for f in manifest['files']:
  src=kit/f['path'];assert hashlib.file_digest(open(src,'rb'),'sha256').hexdigest()==f['sha256'];subprocess.run(['scp','-o','BatchMode=yes','-o','ConnectTimeout=10',str(src),'minipc:'+remote.replace('\\','/')+'/'+f['path']],check=True,timeout=90,capture_output=True)
 for src in [kit/'manifest.json',runner]:subprocess.run(['scp','-o','BatchMode=yes','-o','ConnectTimeout=10',str(src),'minipc:'+remote.replace('\\','/')+'/'+src.name],check=True,timeout=30,capture_output=True)
 script="$s='"+remote+"';$f=Join-Path $s 'run-workload-exact.ps1';if((FileSha $f) -ne '"+runnerSha+"'){throw 'Runner changed'};$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile($f,[ref]$t,[ref]$e);if($e.Count){throw ($e|Out-String)};$r=Get-Content (Join-Path $s 'manifest.json') -Raw|ConvertFrom-Json;foreach($x in $r.files){if((FileSha (Join-Path $s $x.path)) -ne $x.sha256){throw ('Pin mismatch '+$x.path)}};@{ok=$true;at=(Get-Date).ToUniversalTime().ToString('o');files=$r.files.Count}|ConvertTo-Json -Compress"
 r=m.ps(script,35)
elif step=='run':
 assert json.loads((p/'workload-exact-stage.json').read_text()).get('ok')
 r=m.ps("$f='"+remote+"\\run-workload-exact.ps1';if((FileSha $f) -ne '"+runnerSha+"'){throw 'Runner changed'};& ([ScriptBlock]::Create([IO.File]::ReadAllText($f))) -Kit '"+remote+"'",550)
else:
 r=m.ps("$p='"+remote+"\\results';$result=$null;if(Test-Path (Join-Path $p 'result.json')){$result=Get-Content (Join-Path $p 'result.json') -Raw|ConvertFrom-Json};@{result=$result;stdout=[string]::Join([Environment]::NewLine,@(Get-Content (Join-Path $p 'workload.jsonl') -Tail 12 -EA SilentlyContinue));stderr=[string]::Join([Environment]::NewLine,@(Get-Content (Join-Path $p 'stderr.txt') -Tail 12 -EA SilentlyContinue))}|ConvertTo-Json -Depth 9 -Compress",25)
(p/('workload-exact-'+step+'.json')).write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r));raise SystemExit(0 if step=='read' or r.get('ok') else 1)
