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

$entry=Join-Path $work 'provider-events.exe'
$fixture=Join-Path $work 'event-fixture.exe'
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
$sources=@((Join-Path $root 'windows\rpc\BoundedWorker.cs'),(Join-Path $root 'windows\rpc\ProtectedAttempt.cs'),(Join-Path $root 'windows\rpc\ClockSample.cs'),(Join-Path $root 'windows\rpc\ProviderEventEvidence.cs'))
try{
    $base=@('/nologo','/target:exe','/platform:x64','/r:System.Core.dll','/r:System.Web.Extensions.dll')
    Invoke-FiniteProcess $csc ($base+@('/main:Enclave.OwnedRpc.ProviderEventEvidenceEntry',('/out:'+$entry))+$sources) 20000 'sample-compile'
    Invoke-FiniteProcess $csc ($base+@('/main:ProviderEventEvidenceHarness',('/out:'+$fixture))+$sources+@((Join-Path $root 'test\rpc-windows-worker\ProviderEventEvidenceHarness.cs'))) 20000 'fixture-compile'
    $sha=(Get-FileHash -Algorithm SHA256 -LiteralPath $entry).Hash.ToLowerInvariant()
    $attempt='a'*32;$vm='b'*32
    [void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($entry))
    $boot=[Enclave.OwnedRpc.ProtectedAttempt]::CurrentBoot()
    $start=([datetime]'2000-01-01T00:00:00Z').ToUniversalTime().ToFileTimeUtc();$end=$start+10000000
    Invoke-FiniteProcess $fixture @('fixtures') 8000 'fixtures'
    $lines=@(Get-Content -LiteralPath (Join-Path $work 'fixtures.out'))
    if(@($lines|Where-Object{$_ -like 'PASS *'}).Count -ne 12 -or $lines[-1] -cne 'RESULT tests=12 fixtureEvents=true providerCalls=false'){throw 'Incomplete event evidence fixtures'}
    Invoke-FiniteProcess $entry @($attempt,$vm,$boot,[string]$PID,[string]$start,[string]$end,$sha) 8000 'normal'
    $lines=@(Get-Content -LiteralPath (Join-Path $work 'normal.out'))
    if($lines.Count -ne 2){throw 'Exact entered/result pair required'}
    $entered=$lines[0]|ConvertFrom-Json;$sample=$lines[1]|ConvertFrom-Json
    if($entered.schema -cne 'owned-rpc-event-reader-entered/1' -or $entered.nonce -cne $attempt -or $entered.pid -le 0 -or $entered.creationFileTime -le 0 -or $entered.jobCommitLimitBytes -ne 134217728 -or $entered.deadline-$entered.origin -ne 5000){throw 'Reader envelope/identity binding differs'}
    if($sample.schema -cne 'owned-rpc-provider-event-evidence/1' -or $sample.nonce -cne $attempt -or $sample.vmAttempt -cne $vm -or $sample.boot -cne $boot -or $sample.clientPid -ne $PID -or $sample.clientCreationFileTime -ne $start -or $sample.endFileTime -ne $end -or $sample.providerSettled -or $sample.reservationMayRelease -or -not $sample.absenceProvesNothing -or @($sample.channels).Count -ne 3){throw 'Evidence selection/authority differs'}
    foreach($channel in $sample.channels){if($channel.State -cne 'query-ended' -and $channel.State -cne 'unavailable'){throw 'Unqualified channel result'}}
    Invoke-FiniteProcess $entry @($attempt,$vm,$boot,[string]$PID,[string]$start,[string]$end,('0'*64)) 8000 'wrong-image' 1
    Invoke-FiniteProcess $entry @($attempt,$vm,$boot,[string]$PID,[string]$end,[string]$start,$sha) 8000 'bad-window' 1
    Invoke-FiniteProcess $entry @($attempt,$vm,('0'*32),[string]$PID,[string]$start,[string]$end,$sha) 8000 'wrong-boot' 1
    Invoke-FiniteProcess $entry @($attempt) 8000 'arity' 64
    foreach($label in @('wrong-image','bad-window','wrong-boot','arity')){if((Get-Item (Join-Path $work ($label+'.out'))).Length -ne 0){throw 'Refusal emitted evidence'}}
    Invoke-FiniteProcess $fixture @('blocked-main') 8000 'watchdog' 124
    $r=$records[$records.Count-1]
    if($r.elapsedMs -lt 4500 -or $r.elapsedMs -gt 7500 -or (Get-Content -Raw (Join-Path $work 'watchdog.out')).Trim() -cne 'watchdog-armed'){throw 'Independent watchdog death not observed'}
    [pscustomobject]@{passed=$true;tests=18;fixtureTests=12;actualReader=$sample;entered=$entered;watchdog=$r;targetQualified=$false;vmChanged=$false;providerSettled=$false}|ConvertTo-Json -Depth 10|Set-Content (Join-Path $work 'RESULT.json')
}finally{
    $records|ConvertTo-Json -Depth 5|Set-Content (Join-Path $work 'process-results.json')
    Get-FileHash -Algorithm SHA256 -LiteralPath ($sources+@((Join-Path $root 'test\rpc-windows-worker\ProviderEventEvidenceHarness.cs'),$csc))|ConvertTo-Json|Set-Content (Join-Path $work 'pins.json')
    if(Test-Path $entry){Get-FileHash -Algorithm SHA256 -LiteralPath $entry|ConvertTo-Json|Set-Content (Join-Path $work 'entry-artifact.json')}
    $publish=Join-Path $env:RUNNER_TEMP ('rpc-event-results-'+[guid]::NewGuid().ToString('N'))
    $null=New-Item -ItemType Directory -Path $publish
    $names=@('sample-compile.out','sample-compile.err','fixture-compile.out','fixture-compile.err','fixtures.out','fixtures.err','normal.out','normal.err','wrong-image.out','wrong-image.err','bad-window.out','bad-window.err','wrong-boot.out','wrong-boot.err','arity.out','arity.err','watchdog.out','watchdog.err','RESULT.json','process-results.json','pins.json','entry-artifact.json','provider-events.exe')
    $total=0L
    foreach($name in $names){
        $path=Join-Path $work $name
        if(Test-Path -LiteralPath $path){
            $file=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            try{
                $limit=65536L;if($name -eq 'provider-events.exe'){$limit=262144L}
                if($file.Length -gt $limit -or $total+$file.Length -gt 1048576){throw 'Publication bound exceeded'}
                $bytes=New-Object byte[] ([int]$file.Length);$offset=0
                while($offset -lt $bytes.Length){$n=$file.Read($bytes,$offset,$bytes.Length-$offset);if($n -le 0){throw 'Short publication read'};$offset+=$n}
                [IO.File]::WriteAllBytes((Join-Path $publish $name),$bytes);$total+=$bytes.Length
            }finally{$file.Dispose()}
        }
    }
    ('RPC_WORKER_RESULT='+$publish)|Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
