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
    $p=Start-Process -FilePath $Executable -ArgumentList (($Arguments|ForEach-Object{'"'+$_+'"'}) -join ' ') -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
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
$sources=@('BoundedWorker.cs','OwnerObserver.cs','ProtectedAttempt.cs','HostBootstrapEntry.cs','HostBootstrapChannels.cs')|ForEach-Object{Join-Path $root ('windows\rpc\'+$_)}
$fixture=Join-Path $root 'test\rpc-windows-worker\HostBootstrapFixture.cs'
$actorSource=Join-Path $root 'test\rpc-windows-worker\HostBootstrapActor.cs'
$qualification=Join-Path $root 'test\rpc-windows-worker\HostBootstrapQualification.cs'
$actor=Join-Path $work 'fixture-actor.exe';$production=Join-Path $work 'production-entry.exe'
$cases=@($env:RPC_BOOTSTRAP_CASES -split ',')
$allowed=@('normal','wrong-source','wrong-key','malformed','observer-loss','blocked-tpm','blocked-monitor')
if($cases.Count -lt 1 -or $cases.Count -gt 7 -or @($cases|Select-Object -Unique).Count -ne $cases.Count){throw 'Finite unique cases required'}
foreach($case in $cases){if($allowed -cnotcontains $case){throw 'Unreviewed fixture case'}}
$caseResults=New-Object Collections.Generic.List[object]
try{
    $compile=@('/nologo','/target:exe','/platform:x64','/r:System.Web.Extensions.dll')
    Invoke-FiniteProcess $csc ($compile+@('/main:Enclave.OwnedRpc.HostBootstrapEntry',('/out:'+$production))+$sources) 20000 'production-compile'
    Invoke-FiniteProcess $csc ($compile+@('/define:RPC_BOOTSTRAP_CI','/main:Enclave.OwnedRpc.HostBootstrapEntry',('/out:'+$entry))+$sources+@($fixture)) 20000 'fixture-compile'
    Invoke-FiniteProcess $csc ($compile+@('/main:HostBootstrapActor',('/out:'+$actor),$actorSource)) 20000 'actor-compile'
    Invoke-FiniteProcess $csc ($compile+@('/r:System.Management.dll','/r:Microsoft.CSharp.dll','/main:HostBootstrapQualification',('/out:'+$controller))+$sources+@($qualification)) 20000 'controller-compile'
    foreach($case in $cases){
        $origin=[long][decimal]::Floor(([decimal][Diagnostics.Stopwatch]::GetTimestamp()*1000)/[Diagnostics.Stopwatch]::Frequency)
        $deadline=$origin+8000
        Invoke-FiniteProcess $controller @($case,$entry,(Get-FileHash -Algorithm SHA256 -LiteralPath $entry).Hash.ToLowerInvariant(),$actor,(Get-FileHash -Algorithm SHA256 -LiteralPath $actor).Hash.ToLowerInvariant(),$root,[guid]::NewGuid().ToString('N'),[string]$origin,[string]$deadline) 9000 ('case-'+$case)
        $result=Get-Content -Raw -LiteralPath (Join-Path $work ('case-'+$case+'.out'))|ConvertFrom-Json
        if(-not $result.passed -or $result.mode -cne $case -or $result.origin -ne $origin -or $result.deadline -ne $deadline -or -not $result.hardwareSynthetic -or -not $result.nodeActorSynthetic -or $result.rpcReady -or $result.providerOperationFenced -or $result.reservationMayRelease){throw 'Fixture result binding failed'}
        $caseResults.Add($result)
    }
}finally{
    $records|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $work 'process-results.json')
    $caseResults|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $work 'case-results.json')
    Get-FileHash -Algorithm SHA256 -LiteralPath ($sources+@($fixture,$actorSource,$qualification,$csc))|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'pins.json')
    $binaries=@($production,$entry,$actor,$controller)|Where-Object{Test-Path -LiteralPath $_}
    if($binaries.Count){Get-FileHash -Algorithm SHA256 -LiteralPath $binaries|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'binaries.json')}
    $publish=Join-Path $env:RUNNER_TEMP ('rpc-bootstrap-composition-results-'+[guid]::NewGuid().ToString('N'))
    $null=New-Item -ItemType Directory -Path $publish
    $names=@('process-results.json','case-results.json','pins.json','binaries.json','production-entry.exe','owned-entry.exe','fixture-actor.exe','qualification-controller.exe')
    foreach($label in @('production-compile','fixture-compile','actor-compile','controller-compile')+@($cases|ForEach-Object{'case-'+$_})){$names+=@($label+'.out',$label+'.err')}
    $total=0L
    foreach($name in $names){
        $file=Join-Path $work $name
        if(Test-Path -LiteralPath $file){
            $limit=65536L;if($name.EndsWith('.exe')){$limit=262144L}
            $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            try{
                if($stream.Length -gt $limit -or $total+$stream.Length -gt 2097152){throw 'Published fixture artifact bound'}
                $bytes=New-Object byte[] ([int]$stream.Length);$offset=0
                while($offset -lt $bytes.Length){$n=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($n -le 0){throw 'Short artifact read'};$offset+=$n}
                [IO.File]::WriteAllBytes((Join-Path $publish $name),$bytes);$total+=$bytes.Length
            }finally{$stream.Dispose()}
        }
    }
    ('RPC_BOOTSTRAP_COMPOSITION_RESULT='+$publish)|Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
