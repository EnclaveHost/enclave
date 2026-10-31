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
$controller=Join-Path $work 'legacy-handoff.exe'
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
    $sources=@((Join-Path $root 'windows\rpc\BoundedWorker.cs'),(Join-Path $root 'windows\rpc\OwnerObserver.cs'),(Join-Path $root 'windows\rpc\VmStartGuardian.cs'),(Join-Path $root 'windows\rpc\ProtectedAttempt.cs'),(Join-Path $root 'windows\rpc\ProviderStart.cs'),(Join-Path $root 'windows\rpc\ProviderStop.cs'),(Join-Path $root 'windows\rpc\HostPhysicalPool.cs'),(Join-Path $root 'windows\rpc\PhysicalPoolCommand.cs'),(Join-Path $root 'windows\rpc\OwnedVmPermit.cs'),(Join-Path $root 'windows\rpc\WindowsStartAdmission.cs'),(Join-Path $root 'windows\rpc\ProviderWorkerEntry.cs'),(Join-Path $root 'windows\rpc\LegacyTemplateFence.cs'),(Join-Path $root 'windows\rpc\InertEntry.cs'),(Join-Path $root 'windows\rpc\InertQualification.cs'),(Join-Path $root 'windows\rpc\LegacyLaunchCohort.cs'),(Join-Path $root 'windows\rpc\LegacyHandoff.cs'),(Join-Path $root 'windows\rpc\LegacyHandoffEntry.cs'),(Join-Path $root 'windows\rpc\LegacyHandoffController.cs'),(Join-Path $root 'test\rpc-windows-worker\LegacyHandoffHarness.cs'))
    $references=@('/nologo','/target:exe','/platform:x64','/main:LegacyHandoffHarness','/r:System.Management.dll','/r:System.Web.Extensions.dll','/r:Microsoft.CSharp.dll')
    Invoke-FiniteProcess $csc ($references+@('/out:'+$controller)+$sources) 20000 'compile'
    Invoke-FiniteProcess $controller @() 15000 'handoff'
    $entry=Join-Path $work 'handoff-entry.exe';$target=Join-Path $work 'handoff-controller.exe'
    $base=@($references|Where-Object{$_ -notlike '/main:*'})
    Invoke-FiniteProcess $csc ($base+@('/main:Enclave.OwnedRpc.LegacyHandoffEntry',('/out:'+$entry))+$sources) 20000 'compile-entry'
    Invoke-FiniteProcess $csc ($base+@('/main:LegacyHandoffController',('/out:'+$target))+$sources) 20000 'compile-controller'
    $lines=@(Get-Content -LiteralPath (Join-Path $work 'handoff.out'))
    if(@($lines|Where-Object{$_ -like 'PASS *'}).Count -ne 31 -or $lines[-1] -cne 'RESULT tests=31 providerCalls=false vmChanged=false targetInventoryQualified=false'){throw 'Handoff qualification incomplete'}
}finally{
    $records|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $work 'process-results.json')
    Get-FileHash -Algorithm SHA256 -LiteralPath ($sources+@($csc))|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'pins.json')
    if(Test-Path -LiteralPath $controller){Get-FileHash -Algorithm SHA256 -LiteralPath $controller|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'controller-artifact.json')}
    $publish=Join-Path $env:RUNNER_TEMP ('rpc-handoff-results-'+[guid]::NewGuid().ToString('N'))
    $null=New-Item -ItemType Directory -Path $publish
    $total=0L
    foreach($name in @('compile.out','compile.err','compile-entry.out','compile-entry.err','compile-controller.out','compile-controller.err','handoff.out','handoff.err','process-results.json','pins.json','controller-artifact.json','legacy-handoff.exe','handoff-entry.exe','handoff-controller.exe')){
        $file=Join-Path $work $name
        if(Test-Path -LiteralPath $file){
            $limit=65536L;if($name.EndsWith('.exe')){$limit=262144L}
            $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            try{
                if($stream.Length -gt $limit -or $total+$stream.Length -gt 1048576){throw 'Artifact bound'}
                $bytes=New-Object byte[] ([int]$stream.Length);$offset=0
                while($offset -lt $bytes.Length){$n=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($n -le 0){throw 'Short artifact'};$offset+=$n}
                if($stream.ReadByte() -ne -1){throw 'Artifact grew'}
                [IO.File]::WriteAllBytes((Join-Path $publish $name),$bytes);$total+=$bytes.Length
            }finally{$stream.Dispose()}
        }
    }
    ('RPC_WORKER_RESULT='+$publish)|Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
