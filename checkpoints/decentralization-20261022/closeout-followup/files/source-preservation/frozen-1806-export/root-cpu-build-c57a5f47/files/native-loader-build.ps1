$ErrorActionPreference='Stop'
$stage='C:\ProgramData\Enclave\hotfix\cpu-loader-build-20261023'
$receipt=Join-Path $stage 'build-result.json'
if(Test-Path $receipt){throw 'Build already has a receipt'}
$manifest=Get-Content (Join-Path $stage 'native-loader-source.json') -Raw|ConvertFrom-Json
$source=Join-Path $stage 'source'
foreach($f in $manifest.files){$actual=(Get-FileHash -Algorithm SHA256 (Join-Path $source $f.path)).Hash.ToLower();if($actual -ne $f.sha256){throw ('Source mismatch '+$f.path)}}
$vs='C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if(-not (Test-Path $vs)){throw 'Missing existing vcvars64'}
$cmd=Join-Path $stage 'build.cmd'
@('@echo off',('call "'+$vs+'" >nul'),'if errorlevel 1 exit /b %errorlevel%',('cd /d "'+$source+'"'),'set "RUSTUP_TOOLCHAIN=nightly-x86_64-pc-windows-msvc"','set "CARGO_BUILD_JOBS=1"',('set "CARGO_TARGET_DIR='+$stage+'\target"'),('"C:\Users\claude\.cargo\bin\cargo.exe" build --offline --locked --release --target x86_64-pc-windows-msvc --bin vbslike-host'),'set "BUILD_EXIT=%errorlevel%"',('echo %BUILD_EXIT%>"'+$stage+'\build-exit.txt"'),'exit /b %BUILD_EXIT%')|Set-Content -Encoding ASCII $cmd
$proc=$null;$reason=$null;$peak=0;$minFree=1e12;$start=(Get-Date).ToUniversalTime().ToString('o')
try {
 $os=Get-CimInstance Win32_OperatingSystem
 if($os.FreePhysicalMemory -lt 18*1024*1024){throw 'Native build needs 18 GiB free before start'}
 $proc=Start-Process cmd.exe -ArgumentList @('/d','/c',('"'+$cmd+'"')) -WorkingDirectory $stage -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stage 'build.out') -RedirectStandardError (Join-Path $stage 'build.err')
 $started=$proc.StartTime;$deadline=(Get-Date).AddMinutes(15)
 while(-not $proc.WaitForExit(2000)){
  $all=@(Get-CimInstance Win32_Process);$owned=@([int]$proc.Id);do{$new=@($all|Where-Object {$_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned}|ForEach-Object {[int]$_.ProcessId});$owned+= $new}while($new.Count)
  $rss=($all|Where-Object {$_.ProcessId -in $owned}|Measure-Object WorkingSetSize -Sum).Sum
  $peak=[Math]::Max($peak,$rss);$free=(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory*1024;$minFree=[Math]::Min($minFree,$free)
  if($rss -gt 1536MB){throw 'Native build tree exceeded 1536 MiB'}
  if($free -lt 16GB){throw 'Native physical headroom below 16 GiB'}
  if((Get-Date) -gt $deadline){throw 'Native build exceeded 15 minutes'}
 }
 $proc.WaitForExit();$exitFile=Join-Path $stage 'build-exit.txt';if(-not(Test-Path $exitFile)){throw 'Missing command exit receipt'};$exit=[int]([IO.File]::ReadAllText($exitFile).Trim())
 if($exit -ne 0){throw ('Cargo exited '+$exit)}
 $bin=Join-Path $stage 'target\x86_64-pc-windows-msvc\release\vbslike-host.exe'
 if(-not(Test-Path $bin)){throw 'Missing output binary'}
 @{ok=$true;at=(Get-Date).ToUniversalTime().ToString('o');started=$start;commit=$manifest.commit;binary=$bin;sha256=(Get-FileHash -Algorithm SHA256 $bin).Hash.ToLower();bytes=(Get-Item $bin).Length;peakTreeBytes=$peak;minFreeBytes=$minFree;exit=$exit}|ConvertTo-Json -Depth 4|Set-Content -Encoding UTF8 $receipt
}catch{
 $reason=$_.Exception.Message
 if($proc -and -not $proc.HasExited){$now=Get-Process -Id $proc.Id -ErrorAction SilentlyContinue;if($now -and $now.StartTime -eq $started){& taskkill.exe /PID $proc.Id /T /F|Out-Null}}
 @{ok=$false;at=(Get-Date).ToUniversalTime().ToString('o');started=$start;commit=$manifest.commit;error=$reason;peakTreeBytes=$peak;minFreeBytes=$minFree}|ConvertTo-Json -Depth 4|Set-Content -Encoding UTF8 $receipt
 exit 1
}
