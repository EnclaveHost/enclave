from pathlib import Path
import importlib.util,hashlib,json,subprocess,datetime,uuid,sys
P=Path(__file__).resolve().parent
T=P.parent/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(T.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
files={n:hashlib.sha256((P/'native'/n).read_bytes()).hexdigest() for n in ['FixtureJob.cs','ConfigNativeFixture.cs']}
spec=importlib.util.spec_from_file_location('t',T);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
stage=r'C:\ProgramData\Enclave\staging\config-fixture-compile-check-'+uuid.uuid4().hex[:12]
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'compile only; resulting executable NEVER run; no PowerShell file or policy change','stage':stage,'files':files}
with (P/'attempt.json').open('x') as f:json.dump(r,f)
try:
 r['created']=m.ps("$s='%s';if(Test-Path -LiteralPath $s){throw 'exists'};$null=New-Item -ItemType Directory -Path $s;@{created=$s}|ConvertTo-Json -Compress"%stage,30)
 assert r['created'].get('created')==stage
 for n in files:subprocess.run(['timeout','30','scp','-q','-o','BatchMode=yes',str(P/'native'/n),'minipc:/'+stage.replace('\\','/')+'/'+n],check=True,capture_output=True)
 pins=''.join("if((FileSha ($s+'\\%s')) -ne '%s'){throw 'pin mismatch'};"%(n,h) for n,h in files.items())
 code=r'''$s='STAGE';PINS
$i=New-Object Diagnostics.ProcessStartInfo ($env:WINDIR+'\Microsoft.NET\Framework64\v4.0.30319\csc.exe');
$i.Arguments='/nologo /target:exe /r:System.Web.Extensions.dll /out:"'+$s+'\Fixture.exe" "'+$s+'\FixtureJob.cs" "'+$s+'\ConfigNativeFixture.cs"';
$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;
$p=New-Object Diagnostics.Process;$p.StartInfo=$i;[void]$p.Start();$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();
$done=$p.WaitForExit(60000);$timed=-not $done;if(-not $done){try{$p.Kill()}catch{};$done=$p.WaitForExit(5000)};
$complete=$done -and $o.Wait(3000) -and $e.Wait(1000);
@{exited=$done;timedOut=$timed;complete=$complete;code=$(if($done){$p.ExitCode}else{-1});output=$(if($complete){$o.Result+$e.Result}else{'incomplete'});executionPolicy=[string](Get-ExecutionPolicy)}|ConvertTo-Json -Compress
'''.replace('STAGE',stage).replace('PINS',pins)
 r['compile']=b=m.ps(code,90)
 if b.get('exited') is True and b.get('complete') is True and b.get('timedOut') is False:
  r['cleanup']=m.ps("$s='%s';$allowed=@('FixtureJob.cs','ConfigNativeFixture.cs','Fixture.exe');$all=@(Get-Item -LiteralPath $s)+@(Get-ChildItem -LiteralPath $s -Force -Recurse);if(@($all|Where-Object{$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'link: preserve stage'};if(@(Get-ChildItem -LiteralPath $s -Force|Where-Object{$_.PSIsContainer -or $allowed -notcontains $_.Name}).Count){throw 'unknown file: preserve stage'};Remove-Item -LiteralPath $s -Recurse -Force;@{gone=(-not(Test-Path -LiteralPath $s))}|ConvertTo-Json -Compress"%stage,30)
 else:r['cleanup']={'gone':'unknown','leftForRecovery':stage}
 r['ok']=b.get('code')==0 and r['cleanup'].get('gone') is True
except Exception as e:r['error']=str(e);r['ok']=False
finally:(P/'result.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r));sys.exit(0 if r.get('ok') else 1)
