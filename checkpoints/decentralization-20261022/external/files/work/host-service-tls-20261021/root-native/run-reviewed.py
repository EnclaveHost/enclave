import pathlib,hashlib,importlib.util,json,subprocess,datetime,sys,uuid
p=pathlib.Path(__file__).resolve().parent;src=p.parent/'native'
sp=importlib.util.spec_from_file_location('transport',pathlib.Path('work/nucbox-tls-20261021/root-activate-reviewed.py').resolve());m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
pins={'run-localservice.ps1':'9d12f0865064e1bb8627aaa9cb83e08dfe603790cadc6e6d7c51ad2b10495727','g3-native.bundle.mjs':'6853dd16e824c5a546b01ba87e227af440d8a39b5f29fefb7fb642609cb16524'}
for f,want in pins.items():assert hashlib.sha256((src/f).read_bytes()).hexdigest()==want,f
record=p/'stage.json'
if '--run' not in sys.argv:
 assert not record.exists(),'existing stage receipt; inspect rather than overwrite'
 d=r'C:\ProgramData\Enclave\staging\g3-root-'+uuid.uuid4().hex[:12]
 r=m.ps("$n='C:\\Program Files\\nodejs\\node.exe';$s='C:\\ProgramData\\Enclave\\host-services\\hs2\\state';$v=(& $n --version | Out-String).Trim();@{nodeSha256=FileSha $n;nodeVersion=$v;stateExists=(Test-Path -LiteralPath $s -PathType Container);taskFolderExists=([bool](Get-ScheduledTask -TaskPath '\\Enclave\\' -ErrorAction SilentlyContinue))}|ConvertTo-Json -Compress",secs=40)
 assert not r.get('error') and r.get('nodeVersion')=='v24.16.0' and r.get('stateExists') and r.get('taskFolderExists'),r
 o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':d,'preflight':r,'pins':pins};record.write_text(json.dumps(o,indent=2)+'\n')
 s=m.ps("$d='"+d+"';if(Test-Path -LiteralPath $d){throw 'stage exists'};New-Item -ItemType Directory -Path $d|Out-Null;@{created=$d}|ConvertTo-Json -Compress",secs=30);assert s.get('created')==d,s
 for f in pins:
  dest='minipc:/'+d.replace('\\','/')+'/'+f
  q=subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=15',str(src/f),dest],capture_output=True,text=True,timeout=90);assert q.returncode==0,q.stderr
 r=m.ps("$d='"+d+"';$w=Join-Path $d 'run-localservice.ps1';$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($w,[ref]$t,[ref]$e);@{wrapperSha256=FileSha $w;bundleSha256=FileSha (Join-Path $d 'g3-native.bundle.mjs');parseErrors=@($e|ForEach-Object{$_.Message})}|ConvertTo-Json -Compress",secs=40)
 o['parse']=r;record.write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o,indent=2))
 assert not r.get('error') and r.get('parseErrors')==[] and r.get('wrapperSha256')==pins['run-localservice.ps1'] and r.get('bundleSha256')==pins['g3-native.bundle.mjs'],r
else:
 o=json.loads(record.read_text());assert o['pins']==pins and o['parse']['parseErrors']==[];d=o['stage'];ns=o['preflight']['nodeSha256']
 script="$d='"+d+"';$w=Join-Path $d 'run-localservice.ps1';$b=Join-Path $d 'g3-native.bundle.mjs';if((FileSha $w) -ne '"+pins['run-localservice.ps1']+"' -or (FileSha $b) -ne '"+pins['g3-native.bundle.mjs']+"'){throw 'staged files drifted'};$o=@(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $w -BundlePath $b -NodeSha256 '"+ns+"' 2>&1);$rc=$LASTEXITCODE;@{exit=$rc;output=[string]::Join(\"`n\",$o)}|ConvertTo-Json -Compress"
 r=m.ps(script,secs=180);(p/'execution.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2));assert not r.get('error') and r.get('exit')==0,r
