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
$target=Join-Path $work 'definition-controller.exe'
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
    $candidate=Join-Path $env:GITHUB_WORKSPACE 'candidate/native-worker.exe'
    if((Get-Item -LiteralPath $candidate).Length -ne 237568 -or (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash.ToLowerInvariant() -cne '22e033958a4bbd695342b74248079ddf90b2788f1efe8f83def023710c4deb6f'){throw 'Exact previously compiled candidate required'}
    $node=(Get-Command node.exe -CommandType Application).Source
    if(-not [IO.Path]::IsPathRooted($node)){throw 'Absolute CI node path required'}
    $nodeHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $node).Hash.ToLowerInvariant()
    $sources=@((Join-Path $root 'windows/rpc/BoundedWorker.cs'),(Join-Path $root 'test/rpc-windows-worker/NativeRpcProcessHarness.cs'))
    Invoke-FiniteProcess $csc (@('/nologo','/optimize+','/target:exe','/platform:x64','/r:System.Web.Extensions.dll','/main:NativeRpcProcessHarness',('/out:'+$entry))+$sources) 20000 'harness-compile'
    Invoke-FiniteProcess $entry @($node,(Join-Path $root 'test/rpc-windows-worker/native-manager-process.mjs'),$candidate) 55000 'process-composition'
    if((Get-FileHash -Algorithm SHA256 -LiteralPath $node).Hash.ToLowerInvariant() -cne $nodeHash){throw 'CI Node image changed'}
    [pscustomobject]@{compiled=$true;fixtureExecuted=$true;nativeControllerExecuted=$true;nativeProviderExecuted=$false;rpcReady=$false;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $entry).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $entry).Length;nodePath=$node;nodeSha256=$nodeHash;nodeVersion=(Get-Item -LiteralPath $node).VersionInfo.ProductVersion;candidateSha256='22e033958a4bbd695342b74248079ddf90b2788f1efe8f83def023710c4deb6f';candidateBytes=237568;candidateSource='841e7b7e007fc19d1e7cd13a204faa00d3e37901';candidateRun=41327394900}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'artifact.json')
    Copy-Item -LiteralPath (Join-Path $root 'SOURCE.json') -Destination (Join-Path $work 'source-pins.json')
}finally{
    $records|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $work 'process-results.json')
    Get-FileHash -Algorithm SHA256 -LiteralPath ($sources+@($csc))|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'pins.json')
    $publish=Join-Path $env:RUNNER_TEMP ('rpc-native-manager-process-results-'+[guid]::NewGuid().ToString('N'))
    $null=New-Item -ItemType Directory -Path $publish
    ('RPC_WORKER_RESULT='+$publish)|Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
    $total=0L
    foreach($name in @('harness-compile.out','harness-compile.err','process-composition.out','process-composition.err','process-results.json','pins.json','source-pins.json','artifact.json','owned-entry.exe')){
        $file=Join-Path $work $name
        if(Test-Path -LiteralPath $file){
            $limit=65536L;if($name -eq 'owned-entry.exe' -or $name -eq 'native-worker.exe'){$limit=262144L}
            $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            try{
                if($stream.Length -gt $limit -or $total+$stream.Length -gt 1048576){[pscustomobject]@{name=$name;bytes=$stream.Length;limit=$limit;total=$total}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $publish 'artifact-bound-failure.json');throw 'Published artifact bound'}
                $bytes=New-Object byte[] ([int]$stream.Length);$offset=0
                while($offset -lt $bytes.Length){$n=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($n -le 0){throw 'Short artifact read'};$offset+=$n}
                [IO.File]::WriteAllBytes((Join-Path $publish $name),$bytes);$total+=$bytes.Length
            }finally{$stream.Dispose()}
        }
    }
    ('RPC_WORKER_RESULT='+$publish)|Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
