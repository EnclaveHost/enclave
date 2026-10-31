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

$entry=Join-Path $work 'vm-endpoint.exe'
$fixture=Join-Path $work 'endpoint-fixture.exe'
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
$sources=@((Join-Path $root 'windows/rpc/BoundedWorker.cs'),(Join-Path $root 'windows/rpc/ProtectedAttempt.cs'),(Join-Path $root 'windows/rpc/ProviderStart.cs'),(Join-Path $root 'windows/rpc/OwnedVmPermit.cs'),(Join-Path $root 'windows/rpc/BootStartBinding.cs'),(Join-Path $root 'windows/rpc/VmEndpoint.cs'))
try{
    $base=@('/nologo','/target:exe','/platform:x64','/r:System.Management.dll','/r:System.Web.Extensions.dll','/r:Microsoft.CSharp.dll')
    Invoke-FiniteProcess $csc ($base+@('/main:Enclave.OwnedRpc.VmEndpoint',('/out:'+$entry))+$sources) 20000 'endpoint-compile'
    $harness=@((Join-Path $root 'windows/rpc/OwnedVmDefinition.cs'),(Join-Path $root 'windows/rpc/OwnedVmBoot.cs'),(Join-Path $root 'test/rpc-windows-worker/OwnedVmBootHarness.cs'),(Join-Path $root 'test/rpc-windows-worker/VmEndpointHarness.cs'))
    Invoke-FiniteProcess $csc ($base+@('/main:VmEndpointHarness',('/out:'+$fixture))+$sources+$harness) 20000 'fixture-compile'
    if((Get-Item $entry).Length -gt 262144){throw 'Endpoint executable bound'}
    Invoke-FiniteProcess $fixture @() 15000 'inert'
    $lines=@(Get-Content -LiteralPath (Join-Path $work 'inert.out'))
    if(@($lines|Where-Object{$_ -like 'PASS *'}).Count -ne 51 -or $lines[-1] -cne 'RESULT endpoint=13 boot=38 providerCalls=false vmChanged=false targetQualified=false'){throw 'Incomplete endpoint fixtures'}
    Invoke-FiniteProcess $fixture @('blocked-main') 4000 'watchdog' 124
    $r=$records[$records.Count-1]
    if($r.elapsedMs -lt 850 -or $r.elapsedMs -gt 3000 -or (Get-Content -Raw (Join-Path $work 'watchdog.out')).Trim() -cne 'watchdog-armed'){throw 'Independent deadline proof missing'}
    [pscustomobject]@{passed=$true;selectorTests=13;bootTests=38;watchdog=$r;providerCalls=$false;targetQualified=$false;vmChanged=$false}|ConvertTo-Json -Depth 6|Set-Content (Join-Path $work 'RESULT.json')
}finally{
    $records|ConvertTo-Json -Depth 5|Set-Content (Join-Path $work 'process-results.json')
    Get-FileHash -Algorithm SHA256 -LiteralPath ($sources+@($csc))|ConvertTo-Json|Set-Content (Join-Path $work 'pins.json')
    if(Test-Path $entry){Get-FileHash -Algorithm SHA256 -LiteralPath $entry|ConvertTo-Json|Set-Content (Join-Path $work 'entry-artifact.json')}
    $publish=Join-Path $env:RUNNER_TEMP ('rpc-endpoint-results-'+[guid]::NewGuid().ToString('N'))
    $null=New-Item -ItemType Directory -Path $publish
    $names=@('endpoint-compile.out','endpoint-compile.err','fixture-compile.out','fixture-compile.err','inert.out','inert.err','watchdog.out','watchdog.err','RESULT.json','process-results.json','pins.json','entry-artifact.json','vm-endpoint.exe')
    $total=0L
    foreach($name in $names){
        $path=Join-Path $work $name
        if(Test-Path -LiteralPath $path){
            $file=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            try{
                $limit=65536L;if($name -eq 'vm-endpoint.exe'){$limit=262144L}
                if($file.Length -gt $limit -or $total+$file.Length -gt 1048576){
                    ($name+' bytes='+$file.Length+' omitted: original publication bound')|Add-Content (Join-Path $publish 'OMITTED.txt');continue
                }
                $bytes=New-Object byte[] ([int]$file.Length);$offset=0
                while($offset -lt $bytes.Length){$n=$file.Read($bytes,$offset,$bytes.Length-$offset);if($n -le 0){throw 'Short publication read'};$offset+=$n}
                [IO.File]::WriteAllBytes((Join-Path $publish $name),$bytes);$total+=$bytes.Length
            }finally{$file.Dispose()}
        }
    }
    ('RPC_WORKER_RESULT='+$publish)|Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
