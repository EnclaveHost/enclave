# Disposable GitHub-hosted runner only. Never a production-host bootstrap script.
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted'){
    throw 'This qualification entry point requires a disposable GitHub-hosted runner'
}
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$work=Join-Path $env:RUNNER_TEMP ('rpc-worker-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $work
$os=Get-CimInstance Win32_OperatingSystem
if([long]$os.FreePhysicalMemory*1024 -lt 3GB){throw 'Insufficient disposable-runner headroom'}
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(-not (Test-Path -LiteralPath $csc)){throw 'Exact 64-bit Framework compiler missing; no fallback'}


$entry=Join-Path $work 'clock-sample.exe'
$controller=Join-Path $work 'clock-controller.exe'
$ci=Join-Path $work 'ci-controller.exe'
$records=New-Object Collections.Generic.List[object]
function Invoke-FiniteProcess([string]$Executable,[string[]]$Arguments,[int]$DeadlineMs,[string]$Label,[int]$ExpectedExit=0){
    foreach($a in $Arguments){if($a -match '["\r\n]'){throw 'Unexpected fixture argument'}}
    $out=Join-Path $work ($Label+'.out');$err=Join-Path $work ($Label+'.err')
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $p=Start-Process -FilePath $Executable -ArgumentList (($Arguments|ForEach-Object{'"'+$_+'"'}) -join ' ') -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
    $handle=$p.Handle # Retain the process we created, never terminate by a later PID lookup.
    $failure=$null;$maximumObservedWorkingSet=0L
    try{
        if(-not $p.HasExited){try{$p.ProcessorAffinity=[intptr]2}catch{if(-not $p.HasExited){throw}}}
        while(-not $p.WaitForExit(25)){
            $p.Refresh()
            $maximumObservedWorkingSet=[Math]::Max($maximumObservedWorkingSet,$p.WorkingSet64)
            $bytes=0L
            foreach($file in @($out,$err)){if(Test-Path -LiteralPath $file){$bytes+=(Get-Item -LiteralPath $file).Length}}
            if($clock.ElapsedMilliseconds -gt $DeadlineMs){$failure='deadline';break}
            if($p.WorkingSet64 -gt 450MB -or $p.PrivateMemorySize64 -gt 512MB){$failure='observed process memory';break}
            if($bytes -gt 65536){$failure='output bound';break}
        }
    }catch{$failure=$_.Exception.Message}
    finally{
        if(-not $p.HasExited){$p.Kill()}
        if(-not $p.WaitForExit(3000)){throw 'Exact CI process death unconfirmed'}
        $finalBytes=0L
        foreach($file in @($out,$err)){if(Test-Path -LiteralPath $file){$finalBytes+=(Get-Item -LiteralPath $file).Length}}
        if($clock.ElapsedMilliseconds -gt $DeadlineMs){$failure='final deadline exceeded'}
        if($finalBytes -gt 65536){
            $failure='final output bound'
            # Record original counts, preserve at most32KiB from each stream.
            # Never read or upload an oversized diagnostic file in full.
            foreach($file in @($out,$err)){
                if((Get-Item -LiteralPath $file).Length -gt 32768){
                    $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None)
                    try{$stream.SetLength(32768)}finally{$stream.Dispose()}
                }
            }
        }
        $record=[pscustomobject]@{label=$Label;pid=$p.Id;exitCode=$p.ExitCode;elapsedMs=$clock.ElapsedMilliseconds;failure=$failure;processExited=$p.HasExited;maximumObservedWorkingSet=$maximumObservedWorkingSet;outputBytes=$finalBytes}
        $records.Add($record);$p.Dispose()
    }
    if($failure -or $record.exitCode -ne $ExpectedExit){throw ($Label+' failed: '+($record|ConvertTo-Json -Compress))}
}
$sources=@((Join-Path $root 'windows\rpc\BoundedWorker.cs'),(Join-Path $root 'windows\rpc\ProtectedAttempt.cs'),(Join-Path $root 'windows\rpc\ClockSample.cs'),(Join-Path $root 'windows\rpc\ClockQualification.cs'))
try{
 $base=@('/nologo','/target:exe','/platform:x64','/r:System.Web.Extensions.dll')
 Invoke-FiniteProcess $csc ($base+@('/main:Enclave.OwnedRpc.ClockSample',('/out:'+$entry))+$sources) 20000 'sample-compile'
 Invoke-FiniteProcess $csc ($base+@('/main:Enclave.OwnedRpc.ClockQualification',('/out:'+$controller))+$sources) 20000 'controller-compile'
 Invoke-FiniteProcess $csc ($base+@('/define:CLOCK_QUALIFICATION_CI','/main:Enclave.OwnedRpc.ClockQualification',('/out:'+$ci))+$sources) 20000 'ci-compile'
 $nonce=[guid]::NewGuid().ToString('N');$parent='C:\EnclaveRpcClock-'+$nonce;$target=Join-Path $parent $nonce
 $admin=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544');$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
 foreach($dir in @($parent,$target)){
  $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($admin);$acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @($admin,$system)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
  [void][IO.Directory]::CreateDirectory($dir,$acl)
 }
 $input=@{'clock-sample.exe'=$entry;'entry.exe'=$entry;'clock-controller.exe'=$ci}
 foreach($name in $input.Keys){
  $path=Join-Path $target $name;[IO.File]::Copy($input[$name],$path,$false)
  $acl=New-Object Security.AccessControl.FileSecurity;$acl.SetOwner($admin);$acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @($admin,$system)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))}
  [IO.File]::SetAccessControl($path,$acl)
 }
 [void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($entry));$boot=[Enclave.OwnedRpc.ProtectedAttempt]::CurrentBoot()
 $sampleHash=(Get-FileHash $entry -Algorithm SHA256).Hash.ToLowerInvariant();$ciHash=(Get-FileHash $ci -Algorithm SHA256).Hash.ToLowerInvariant()
 $arguments=@('--hosted-ci',$target,$nonce,$boot,$sampleHash,$ciHash,'none')
 Invoke-FiniteProcess (Join-Path $target 'clock-controller.exe') $arguments 8000 'normal'
 $result=Get-Content -Raw (Join-Path $work 'normal.out')|ConvertFrom-Json
 if(-not $result.passed -or -not $result.hostedCi -or -not $result.samplerExactDeath -or $result.samplerExit -ne 0 -or $result.vmChanged -or $result.productionClockAssigned -or $result.systemContextQualified -or -not $result.supervisorEnvelope.MembershipVerified -or -not $result.supervisorEnvelope.LimitsVerified){throw 'Controller qualification receipt differs'}
 Invoke-FiniteProcess (Join-Path $target 'clock-controller.exe') $arguments 8000 'consumed' 1
 if((Get-Item (Join-Path $work 'consumed.out')).Length -ne 0 -or (Get-Content -Raw (Join-Path $work 'consumed.err')) -notmatch 'exist'){throw 'Consumed contract not refused'}
 [pscustomobject]@{passed=$true;tests=2;result=$result;productionBinarySha256=(Get-FileHash $controller -Algorithm SHA256).Hash.ToLowerInvariant();productionBinaryExecuted=$false;targetQualified=$false}|ConvertTo-Json -Depth 9|Set-Content (Join-Path $work 'RESULT.json')
}finally{
 $records|ConvertTo-Json -Depth 5|Set-Content (Join-Path $work 'process-results.json')
 Get-FileHash -Algorithm SHA256 -LiteralPath ($sources+@($csc))|ConvertTo-Json|Set-Content (Join-Path $work 'pins.json')
 if(Test-Path $controller){Get-FileHash $controller -Algorithm SHA256|ConvertTo-Json|Set-Content (Join-Path $work 'controller-artifact.json')}
 $publish=Join-Path $env:RUNNER_TEMP ('rpc-clock-controller-results-'+[guid]::NewGuid().ToString('N'));$null=New-Item -ItemType Directory -Path $publish
 $names=@('sample-compile.out','sample-compile.err','controller-compile.out','controller-compile.err','ci-compile.out','ci-compile.err','normal.out','normal.err','consumed.out','consumed.err','RESULT.json','process-results.json','pins.json','controller-artifact.json','clock-controller.exe');$total=0L
 foreach($name in $names){$path=Join-Path $work $name;if(Test-Path $path){
  $f=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try{$limit=65536L;if($name -eq 'clock-controller.exe'){$limit=262144L};if($f.Length -gt $limit -or $total+$f.Length -gt 1048576){throw 'Publication bound'}
   $b=New-Object byte[] ([int]$f.Length);$offset=0;while($offset -lt $b.Length){$n=$f.Read($b,$offset,$b.Length-$offset);if($n -le 0){throw 'Short publication'};$offset+=$n};[IO.File]::WriteAllBytes((Join-Path $publish $name),$b);$total+=$b.Length
  }finally{$f.Dispose()}
 }}
 ('RPC_WORKER_RESULT='+$publish)|Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
