"""Root-only C# component test. Does not run any .ps1 file or change execution policy."""
import importlib.util,pathlib,hashlib,json,subprocess,uuid,datetime,sys
P=pathlib.Path(__file__).resolve().parent.parent
T=P.parent/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(T.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('transport',T);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
FILES={n:hashlib.sha256((P/'native'/n).read_bytes()).hexdigest() for n in ['FixtureJob.cs','FixtureJobCheck.cs']}
M=hashlib.sha256(json.dumps(FILES,sort_keys=True).encode()).hexdigest()
if sys.argv[1:]!=['--execute',M]:print(json.dumps({'mode':'plan','manifest':M,'files':FILES}));sys.exit(0 if len(sys.argv)==1 else 2)
stage='C:\\ProgramData\\Enclave\\staging\\bootstrap-job-component-'+uuid.uuid4().hex[:12]
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':stage,'manifest':M,'files':FILES}
with (P/'component-attempt.json').open('x') as f:json.dump(r,f)
started=False;clean=False
try:
 r['created']=m.ps("$s='%s';if(Test-Path -LiteralPath $s){throw 'exists'};$null=New-Item -ItemType Directory -Path $s;@{created=$s}|ConvertTo-Json -Compress"%stage,30)
 if r['created'].get('created')!=stage:raise RuntimeError('creation not confirmed')
 for n in FILES:subprocess.run(['timeout','30','scp','-q','-o','BatchMode=yes',str(P/'native'/n),'minipc:/'+stage.replace('\\','/')+'/'+n],check=True,capture_output=True)
 pin=''.join("if((FileSha ($s+'\\%s')) -ne '%s'){throw 'pin differs'};"%(n,h) for n,h in FILES.items())
 # Inline compiler/program invocation, not a .ps1 file or changed script policy.
 code=r"""$s='STAGE';PINS
$csc=$env:WINDIR+'\Microsoft.NET\Framework64\v4.0.30319\csc.exe';
function Run($file,$argsText,$seconds){
 $i=New-Object Diagnostics.ProcessStartInfo $file;$i.Arguments=$argsText;$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;
 $p=New-Object Diagnostics.Process;$p.StartInfo=$i;[void]$p.Start();$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();$done=$p.WaitForExit($seconds*1000);$timeout=-not $done;
 if(-not $done){$p.Kill();$done=$p.WaitForExit(5000)};
 $outDone=$false;if($done){$outDone=$o.Wait(3000) -and $e.Wait(1000)};
 @{exited=$done;timedOut=$timeout;complete=$outDone;code=$(if($done){$p.ExitCode}else{-1});output=$(if($outDone){$o.Result+$e.Result}else{'output incomplete'})}
};
$b=Run $csc ('/nologo /target:exe /out:"'+$s+'\Check.exe" "'+$s+'\FixtureJob.cs" "'+$s+'\FixtureJobCheck.cs"') 30;
$t=$null;if($b.exited -and -not $b.timedOut -and $b.code -eq 0){$t=Run ($s+'\Check.exe') ('"'+$s+'"') 60};
@{build=$b;test=$t;executionPolicy=[string](Get-ExecutionPolicy)}|ConvertTo-Json -Compress -Depth 5
""".replace('STAGE',stage).replace('PINS',pin)
 started=True;r['validation']=m.ps(code,120)
 v=r['validation'];t=v.get('test',{}) or {};b=v.get('build',{}) or {}
 clean=t.get('code')==0 and t.get('exited') is True and not t.get('timedOut') and t.get('complete') is True and 'ALL PASS' in t.get('output','')
 r['ok']=clean and b.get('code')==0
except BaseException as e:r['error']=type(e).__name__+': '+str(e);r['ok']=False
finally:
 if clean:
  try:r['cleanup']=m.ps("$s='%s';Remove-Item -LiteralPath $s -Recurse -Force;@{gone=(-not(Test-Path -LiteralPath $s))}|ConvertTo-Json -Compress"%stage,30)
  except BaseException as e:r['cleanup']={'gone':'unknown','error':str(e)}
 else:r['cleanup']={'gone':'unknown','leftForRecovery':stage}
 (P/'component-result.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r));sys.exit(0 if r.get('ok') and r.get('cleanup',{}).get('gone') is True else 1)
