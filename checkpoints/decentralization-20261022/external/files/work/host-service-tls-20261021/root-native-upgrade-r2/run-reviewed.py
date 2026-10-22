import pathlib,hashlib,importlib.util,json,subprocess,datetime,sys,uuid,base64
p=pathlib.Path(__file__).resolve().parent;src=p.parent/'upgrade'
sp=importlib.util.spec_from_file_location('transport',pathlib.Path('work/nucbox-tls-20261021/root-activate-reviewed.py').resolve());m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
pins={'hs2-upgrade.ps1':'b17360b2bb77b6bce393064022dfd7ce1a8d399e96693d91dc53aea420dc935c','upgrade-fixture.ps1':'287ef197971e09d5b499282b5fff278ed317a1830c5615df7232552eb18be0d5'}
for f,h in pins.items():assert hashlib.sha256((src/f).read_bytes()).hexdigest()==h,f
def ps(s,secs=60):
 return m.ps('[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);'+s,secs=secs)
rec=p/'stage.json'
if '--run' not in sys.argv:
 assert not rec.exists(),'inspect existing stage receipt before reuse'
 tag=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')+'-'+uuid.uuid4().hex[:6]
 d=r'C:\ProgramData\Enclave\staging\hs2up-root-'+uuid.uuid4().hex[:12]
 r=ps(r"""$os=Get-CimInstance Win32_OperatingSystem;$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2';$xml=Export-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2';$h=[Security.Cryptography.SHA256]::Create();$x=-join($h.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$xml))|ForEach-Object{$_.ToString('x2')});@{freeMiB=[math]::Floor($os.FreePhysicalMemory/1024);taskState=[string]$t.State;taskXmlSha=$x;configSha=FileSha 'C:\ProgramData\Enclave\host-services\hs2\config\host-services.json';nodeSha=FileSha 'C:\Program Files\nodejs\node.exe'}|ConvertTo-Json -Compress""",60)
 assert not r.get('error') and r.get('freeMiB',0)>=2048 and r.get('taskState')=='Running',r
 assert r['nodeSha']=='b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3',r
 o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':d,'runTag':tag,'pins':pins,'preflight':r};rec.write_text(json.dumps(o,indent=2)+'\n')
 r=ps("$d='"+d+"';if(Test-Path -LiteralPath $d){throw 'stage exists'};New-Item -ItemType Directory -Path $d|Out-Null;@{created=$d}|ConvertTo-Json -Compress",30);assert r.get('created')==d,r
 for f in pins:
  q=subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=15',str(src/f),'minipc:/'+d.replace('\\','/')+'/'+f],capture_output=True,text=True,timeout=60);assert q.returncode==0,q.stderr
 r=ps("$d='"+d+"';$a=@();foreach($f in @('hs2-upgrade.ps1','upgrade-fixture.ps1')){$t=$null;$e=$null;$w=Join-Path $d $f;[void][System.Management.Automation.Language.Parser]::ParseFile($w,[ref]$t,[ref]$e);$a+=@{file=$f;sha256=FileSha $w;errors=@($e|ForEach-Object{@{line=$_.Extent.StartLineNumber;message=$_.Message}})}};@{files=$a}|ConvertTo-Json -Depth 5 -Compress",40)
 o['parse']=r;rec.write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o,indent=2))
 assert not r.get('error') and len(r.get('files',[]))==2,r
 for row in r['files']:assert row['sha256']==pins[row['file']] and row['errors']==[],row
else:
 o=json.loads(rec.read_text());assert o['pins']==pins
 for row in o['parse']['files']:assert row['errors']==[] and row['sha256']==pins[row['file']]
 d=o['stage'];tag=o['runTag']
 script="$d='"+d+"';$f=Join-Path $d 'upgrade-fixture.ps1';$h=Join-Path $d 'hs2-upgrade.ps1';if((FileSha $f) -ne '"+pins['upgrade-fixture.ps1']+"' -or (FileSha $h) -ne '"+pins['hs2-upgrade.ps1']+"'){throw 'staged drift'};$z=@(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $f -Helper $h -HelperSha256 '"+pins['hs2-upgrade.ps1']+"' -RunTag '"+tag+"' -WatchdogMinutes 10 -OnlyScenario emptylock,crashlock,crashreplace,drift,revert 2>&1);$rc=$LASTEXITCODE;@{exit=$rc;output=[string]::Join(\"`n\",$z)}|ConvertTo-Json -Compress"
 r=ps(script,675);(p/'execution.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2));assert not r.get('error') and r.get('exit')==0,r
