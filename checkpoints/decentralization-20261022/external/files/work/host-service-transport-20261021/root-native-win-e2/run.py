import pathlib,json,hashlib,importlib.util,uuid,subprocess,sys
p=pathlib.Path(__file__).resolve().parent;pins=json.loads((p/'pins.json').read_text())
s=importlib.util.spec_from_file_location('t',pathlib.Path('work/nucbox-tls-20261021/root-activate-reviewed.py').resolve());m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
for f,h in pins.items():assert hashlib.sha256((p/f).read_bytes()).hexdigest()==h
assert not (p/'stage.json').exists(),'do not duplicate native run'
d=r'C:\ProgramData\Enclave\staging\native-win-root-'+uuid.uuid4().hex[:12]
(p/'stage.json').write_text(json.dumps({'stage':d,'pins':pins},indent=2)+'\n')
r=m.ps("$d='"+d+"';if(Test-Path -LiteralPath $d){throw 'stage exists'};New-Item -ItemType Directory -Path $d|Out-Null;@{created=$d}|ConvertTo-Json -Compress",secs=30);assert r.get('created')==d,r
for f in pins:
 r=subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=15',str(p/f),'minipc:/'+d.replace('\\','/')+'/'+f],capture_output=True,text=True,timeout=60);assert r.returncode==0,r.stderr
ck=';'.join("if((FileSha (Join-Path $d '"+f+"')) -ne '"+h+"'){throw 'pin mismatch "+f+"'}" for f,h in pins.items())
code="$d='"+d+"';"+ck+";$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $d 'win-udp-fixture.ps1'),[ref]$t,[ref]$e);if($e.Count){throw ($e|Out-String)};if((FileSha 'C:\\Program Files\\nodejs\\node.exe') -ne 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3'){throw 'node pin'};$o=@(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $d 'win-udp-fixture.ps1') -NewWgExe (Join-Path $d 'enclave-wg.exe') -WgTestExe (Join-Path $d 'wg-udp-test.exe') -NodeExe 'C:\\Program Files\\nodejs\\node.exe' -Peer '134.199.235.187:51821' -E2Only 2>&1);$rc=$LASTEXITCODE;@{exit=$rc;output=[string]::Join(\"`n\",$o)}|ConvertTo-Json -Compress"
r=m.ps(code,secs=1200);(p/'execution.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
assert r.get('exit')==0 and 'NATIVE-WIN-RC=0' in r.get('output',''),r
