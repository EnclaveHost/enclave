import pathlib,hashlib,json,subprocess,importlib.util,argparse
p=pathlib.Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('helper','work/nucbox-tls-20261021/root-activate-reviewed.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
a=argparse.ArgumentParser();a.add_argument('step',choices=['stage','start','run','read']);step=a.parse_args().step
stage=r'C:\ProgramData\Enclave\hotfix\cpu-loader-build-20261023';manifest=json.loads((p/'native-loader-source.json').read_text())
sha=hashlib.sha256((p/'native-loader-build.ps1').read_bytes()).hexdigest()
if step=='stage':
 r=m.ps("$p='"+stage+"';if(Test-Path (Join-Path $p 'source')){throw 'Existing native build source'};New-Item -ItemType Directory -Force -Path $p|Out-Null;@{ok=$true}|ConvertTo-Json -Compress",20)
 assert r.get('ok'),r
 for name in ['native-loader-source.zip','native-loader-source.json','native-loader-build.ps1']:
  subprocess.run(['scp','-o','BatchMode=yes','-o','ConnectTimeout=10',str(p/name),'minipc:'+stage.replace('\\','/')+'/'+name],check=True,timeout=30,capture_output=True)
 script="$s='"+stage+"';$z=Join-Path $s 'native-loader-source.zip';$f=Join-Path $s 'native-loader-build.ps1';if((FileSha $z) -ne '"+manifest['zipSha256']+"' -or (FileSha $f) -ne '"+sha+"'){throw 'Staged hash mismatch'};$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile($f,[ref]$t,[ref]$e);if($e.Count){throw ($e|Out-String)};Expand-Archive $z (Join-Path $s 'source');@{ok=$true;at=(Get-Date).ToUniversalTime().ToString('o');scriptSha=(FileSha $f)}|ConvertTo-Json -Compress"
 r=m.ps(script,35)
elif step=='start':
 script="$s='"+stage+"';$f=Join-Path $s 'native-loader-build.ps1';if((FileSha $f) -ne '"+sha+"'){throw 'Build script changed'};if(Test-Path (Join-Path $s 'build-start.json')){throw 'Build already started'};$p=Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$f) -WorkingDirectory $s -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $s 'guard.out') -RedirectStandardError (Join-Path $s 'guard.err');$r=@{ok=$true;at=(Get-Date).ToUniversalTime().ToString('o');guardPid=$p.Id;scriptSha=(FileSha $f)};$r|ConvertTo-Json -Compress|Set-Content (Join-Path $s 'build-start.json');$r|ConvertTo-Json -Compress"
 r=m.ps(script,20)
elif step=='run':
 script="$s='"+stage+"';$f=Join-Path $s 'native-loader-build.ps1';if((FileSha $f) -ne '"+sha+"'){throw 'Build script changed'};if(Test-Path (Join-Path $s 'build.cmd')){throw 'Build previously entered; inspect first'};& ([ScriptBlock]::Create([IO.File]::ReadAllText($f)));Get-Content (Join-Path $s 'build-result.json') -Raw|ConvertFrom-Json|ConvertTo-Json -Compress"
 r=m.ps(script,950)
else:
 script="$s='"+stage+"';$f=Join-Path $s 'build-result.json';$r=$null;if(Test-Path $f){$r=Get-Content $f -Raw|ConvertFrom-Json};@{at=(Get-Date).ToUniversalTime().ToString('o');result=$r;stderr=[string]::Join([Environment]::NewLine,@(Get-Content (Join-Path $s 'build.err') -Tail 30 -ErrorAction SilentlyContinue));guardError=[string]::Join([Environment]::NewLine,@(Get-Content (Join-Path $s 'guard.err') -Tail 15 -ErrorAction SilentlyContinue))}|ConvertTo-Json -Depth 5 -Compress"
 r=m.ps(script,20)
(p/('native-loader-'+step+'.json')).write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
if step!='read' and not r.get('ok'):raise SystemExit(1)
