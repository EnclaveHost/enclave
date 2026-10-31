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
$controller=Join-Path $work 'qualification-controller.exe'
$entry=Join-Path $work 'owned-entry.exe'
$records=New-Object Collections.Generic.List[object]
function Invoke-FiniteProcess([string]$Executable,[string[]]$Arguments,[int]$DeadlineMs,[string]$Label){
    foreach($a in $Arguments){if($a -match '["\r\n]'){throw 'Unexpected fixture argument'}}
    $out=Join-Path $work ($Label+'.out');$err=Join-Path $work ($Label+'.err')
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $launch=@{FilePath=$Executable;PassThru=$true;NoNewWindow=$true;RedirectStandardOutput=$out;RedirectStandardError=$err}
    if($Arguments.Count -gt 0){$launch.ArgumentList=(($Arguments|ForEach-Object{'"'+$_+'"'}) -join ' ')}
    $p=Start-Process @launch
    $handle=$p.Handle # Retain the process we created, never terminate by a later PID lookup.
    $failure=$null;$maximumObservedWorkingSet=0L
    try{
        $p.ProcessorAffinity=[intptr]2
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
    if($failure -or $record.exitCode -ne 0){throw ($Label+' failed: '+($record|ConvertTo-Json -Compress))}
}
try{
    $sources=@((Join-Path $root 'windows\rpc\BoundedWorker.cs'),(Join-Path $root 'windows\rpc\OwnerObserver.cs'),(Join-Path $root 'windows\rpc\VmStartGuardian.cs'),(Join-Path $root 'windows\rpc\ProtectedAttempt.cs'),(Join-Path $root 'windows\rpc\ProviderStart.cs'),(Join-Path $root 'windows\rpc\ProviderStop.cs'),(Join-Path $root 'windows\rpc\HostPhysicalPool.cs'),(Join-Path $root 'windows\rpc\OwnedVmPermit.cs'),(Join-Path $root 'windows\rpc\WindowsStartAdmission.cs'),(Join-Path $root 'windows\rpc\ProviderWorkerEntry.cs'))
    $shared=@('/nologo','/target:exe','/platform:x64','/r:System.Management.dll','/r:System.Web.Extensions.dll','/r:Microsoft.CSharp.dll')
    Invoke-FiniteProcess $csc ($shared+@('/main:Enclave.OwnedRpc.ProviderWorkerEntry',('/out:'+$entry))+$sources) 20000 'entry-compile'
    Invoke-FiniteProcess $csc ($shared+@('/main:ProviderWorkerQualification',('/out:'+$controller),(Join-Path $root 'test\rpc-windows-worker\ProviderWorkerQualification.cs'))+$sources) 20000 'controller-compile'
    $transaction=Join-Path $work 'transaction-tests.exe'
    Invoke-FiniteProcess $csc ($shared+@('/main:ProviderStartHarness',('/out:'+$transaction),(Join-Path $root 'test\rpc-windows-worker\ProviderStartHarness.cs'))+$sources) 20000 'transaction-compile'
    Invoke-FiniteProcess $transaction @() 20000 'transactions'
    $lines=@(Get-Content -LiteralPath (Join-Path $work 'transactions.out'))
    if(@($lines|Where-Object{$_ -like 'PASS *'}).Count -ne 39 -or $lines[-1] -cne 'RESULT tests=39 providerCallsAreFakes=true vmChanged=false'){throw 'Incomplete transaction regressions'}
    $stops=Join-Path $work 'stop-tests.exe'
    Invoke-FiniteProcess $csc ($shared+@('/main:ProviderStopHarness',('/out:'+$stops),(Join-Path $root 'test\rpc-windows-worker\ProviderStopHarness.cs'))+$sources) 20000 'stop-compile'
    Invoke-FiniteProcess $stops @() 20000 'stops'
    $stopLines=@(Get-Content -LiteralPath (Join-Path $work 'stops.out'))
    if(@($stopLines|Where-Object{$_ -like 'PASS *'}).Count -ne 24 -or $stopLines[-1] -cne 'RESULT tests=24 providerCallsAreFakes=true vmChanged=false'){throw 'Incomplete cleanup regressions'}
    $poolTests=Join-Path $work 'physical-pool-tests.exe'
    Invoke-FiniteProcess $csc ($shared+@('/main:HostPhysicalPoolHarness',('/out:'+$poolTests),(Join-Path $root 'test\rpc-windows-worker\HostPhysicalPoolHarness.cs'))+$sources) 20000 'pool-compile'
    Invoke-FiniteProcess $poolTests @() 20000 'physical-pool'
    $poolLines=@(Get-Content -LiteralPath (Join-Path $work 'physical-pool.out'))
    if(@($poolLines|Where-Object{$_ -like 'PASS *'}).Count -ne 14 -or $poolLines[-1] -cne 'RESULT tests=14 nativeFileSharing=true providerCalls=false vmChanged=false'){throw 'Shared physical pool qualification incomplete'}
    foreach($case in @('admission-fixtures','reconcile','denied-start','guardian-bind','guardian-publication-failure','stop-too-early')){
        $launchOrigin=[long][decimal]::Floor(([decimal][Diagnostics.Stopwatch]::GetTimestamp()*1000)/[Diagnostics.Stopwatch]::Frequency)
        $launchDeadline=$launchOrigin+30000
        Invoke-FiniteProcess $controller @(('--hosted-'+$case),$entry,(Get-FileHash -Algorithm SHA256 -LiteralPath $entry).Hash.ToLowerInvariant(),[guid]::NewGuid().ToString('N'),[string]$launchOrigin,[string]$launchDeadline) 30000 $case
        $result=Get-Content -Raw -LiteralPath (Join-Path $work ($case+'.out'))|ConvertFrom-Json
        if(-not $result.passed -or $result.nativeSubmitted -cne $false -or $result.vmsChanged -cne $false -or $result.providerFenced -or $result.reservationMayRelease){throw 'Provider worker qualification incomplete'}
        if($case -eq 'admission-fixtures' -and $result.fixtures -ne 6){throw 'Pending authority fixtures incomplete'}
        $result|ConvertTo-Json -Depth 5
    }
}finally{
    # Helpers have no unbounded loop: sleeps <=5s, allocation <=192MiB. These
    # source bounds do not interrupt a stuck native call; the disposable CI runner
    # and independent process supervisor remain the outer containment boundary.
    # Preserve records on failure; do not use a broad process kill or any VM cleanup.
    $records|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $work 'process-results.json')
    Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root 'windows\rpc\BoundedWorker.cs'),(Join-Path $root 'windows\rpc\OwnerObserver.cs'),(Join-Path $root 'windows\rpc\VmStartGuardian.cs'),(Join-Path $root 'windows\rpc\ProtectedAttempt.cs'),(Join-Path $root 'windows\rpc\ProviderStart.cs'),(Join-Path $root 'windows\rpc\ProviderStop.cs'),(Join-Path $root 'windows\rpc\HostPhysicalPool.cs'),(Join-Path $root 'windows\rpc\OwnedVmPermit.cs'),(Join-Path $root 'windows\rpc\WindowsStartAdmission.cs'),(Join-Path $root 'windows\rpc\ProviderWorkerEntry.cs'),(Join-Path $root 'test\rpc-windows-worker\ProviderWorkerQualification.cs'),(Join-Path $root 'test\rpc-windows-worker\ProviderStartHarness.cs'),(Join-Path $root 'test\rpc-windows-worker\ProviderStopHarness.cs'),(Join-Path $root 'test\rpc-windows-worker\HostPhysicalPoolHarness.cs'),$csc|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'pins.json')
    if(Test-Path -LiteralPath $controller){Get-FileHash -Algorithm SHA256 -LiteralPath $controller|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'controller-artifact.json')}
    if(Test-Path -LiteralPath $entry){Get-FileHash -Algorithm SHA256 -LiteralPath $entry|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'entry-artifact.json')}
    # Never export the raw work directory. Failed truncation or unexpected compiler
    # output must not turn an always-upload step into unbounded publication.
    $publish=Join-Path $env:RUNNER_TEMP ('rpc-worker-results-'+[guid]::NewGuid().ToString('N'))
    $null=New-Item -ItemType Directory -Path $publish
    $published=New-Object Collections.Generic.List[object];$total=0L
    foreach($name in @('pool-compile.out','pool-compile.err','physical-pool.out','physical-pool.err','stop-compile.out','stop-compile.err','stops.out','stops.err','stop-too-early.out','stop-too-early.err','guardian-publication-failure.out','guardian-publication-failure.err','guardian-bind.out','guardian-bind.err','admission-fixtures.out','admission-fixtures.err','transaction-compile.out','transaction-compile.err','transactions.out','transactions.err','reconcile.out','reconcile.err','denied-start.out','denied-start.err','controller-compile.out','controller-compile.err','entry-compile.out','entry-compile.err','inert.out','inert.err','process-results.json','pins.json','controller-artifact.json','entry-artifact.json','qualification-controller.exe','owned-entry.exe')){
        $file=Join-Path $work $name
        if(Test-Path -LiteralPath $file){
            $item=Get-Item -LiteralPath $file;$limit=65536L
            if($name -eq 'qualification-controller.exe' -or $name -eq 'owned-entry.exe'){$limit=262144L}
            if($item.Length -le $limit -and $total+$item.Length -le 1048576){
                # Exact finite compiler/harness processes have exited before here;
                # use a bounded held read anyway, not a copy of a mutable path.
                $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
                try{
                    if($stream.Length -gt $limit){throw 'Artifact changed beyond bound'}
                    $bytes=New-Object byte[] ([int]$stream.Length);$offset=0
                    while($offset -lt $bytes.Length){$n=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($n -le 0){throw 'Short artifact read'};$offset+=$n}
                    [IO.File]::WriteAllBytes((Join-Path $publish $name),$bytes);$total+=$bytes.Length
                    $published.Add([pscustomobject]@{name=$name;bytes=$bytes.Length;included=$true})
                }finally{$stream.Dispose()}
            }else{$published.Add([pscustomobject]@{name=$name;bytes=$item.Length;included=$false})}
        }
    }
    $published|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $publish 'publication.json')
    # Export only after every included file was read under its bound. Any earlier
    # exception leaves the upload variable unset, so the raw logs remain unexposed.
    ('RPC_WORKER_RESULT='+$publish)|Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
