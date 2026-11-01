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
if((Get-PSDrive -Name C).Free -lt 5GB){throw 'Insufficient disposable-runner disk headroom'}
# Standalone Roslyn, never MSBuild or /shared/VBCSCompiler. No package install.
$csc='C:\Program Files\Microsoft Visual Studio\18\Enterprise\MSBuild\Current\Bin\Roslyn\csc.exe'
$framework='C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8'
$references=@('mscorlib.dll','System.dll','System.Core.dll','System.Management.dll','System.Web.Extensions.dll','Microsoft.CSharp.dll','System.Xml.dll','System.Security.dll','System.Configuration.dll','System.Data.dll')|ForEach-Object{Join-Path $framework $_}
$toolFiles=@($csc)+@($references)
$preflight=Join-Path $work 'preflight';$null=New-Item -ItemType Directory -Path $preflight
('RPC_WORKER_RESULT='+$preflight)|Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
$presence=@($toolFiles|ForEach-Object{[pscustomobject]@{path=$_;present=(Test-Path -LiteralPath $_)}})
$presence|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $preflight 'toolchain-preflight.json')
foreach($file in $toolFiles){if(-not(Test-Path -LiteralPath $file) -or ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw ('Fixed compiler/reference unavailable: '+$file)}}
$toolPins=@(Get-FileHash -Algorithm SHA256 -LiteralPath $toolFiles)
[pscustomobject]@{implementation='VS2026 standalone Roslyn';version=(Get-Item -LiteralPath $csc).VersionInfo.FileVersion;server=$false;pins=$toolPins}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $work 'toolchain.json')
$compilerOptions=@('/nologo','/noconfig','/nostdlib+','/langversion:5','/optimize+','/debug-','/deterministic+','/target:exe','/platform:x64')+@($references|ForEach-Object{'/r:'+$_})
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
        $record=[pscustomobject]@{label=$Label;pid=$p.Id;exitCode=$p.ExitCode;elapsedMs=$clock.ElapsedMilliseconds;failure=$failure;processExited=$p.HasExited;maximumObservedWorkingSet=$maximumObservedWorkingSet;cpuMs=$p.TotalProcessorTime.TotalMilliseconds;outputBytes=$finalBytes}
        $records.Add($record);$p.Dispose()
    }
    if($failure -or $record.exitCode -ne 0){throw ($Label+' failed: '+($record|ConvertTo-Json -Compress))}
}
try{
    $production=@('BoundedWorker.cs','OwnerObserver.cs','ProtectedAttempt.cs','ProviderStart.cs','OwnedVmPermit.cs','HostPhysicalPool.cs','WindowsStartAdmission.cs','LegacyTemplateFence.cs','LegacyLaunchCohort.cs','LegacyHandoff.cs','NativeRpcDefinition.cs','NativeRpcWmi.cs','NativeRpcStart.cs','NativeRpcCleanup.cs','NativeRpcCleanupWitness.cs','NativeRpcAuthority.cs','NativeRpcWorkerEntry.cs','NativeRpcController.cs','NativeRpcManagerTransport.cs')|ForEach-Object{Join-Path $root ('windows\rpc\'+$_)}
    $sources=@($production|Where-Object{[IO.Path]::GetFileName($_) -notin @('NativeRpcWorkerEntry.cs','NativeRpcController.cs','NativeRpcManagerTransport.cs')})+@(Join-Path $root 'test\rpc-windows-worker\NativeRpcProgressHarness.cs')
    Invoke-FiniteProcess $csc ($compilerOptions+@('/main:NativeRpcProgressHarness',('/out:'+$entry))+$sources) 20000 'harness-compile'
    Invoke-FiniteProcess $entry @() 20000 'worker-harness'
    $worker=Join-Path $work 'native-worker.exe'
    Invoke-FiniteProcess $csc ($compilerOptions+@('/main:Enclave.OwnedRpc.NativeRpcControllerEntry',('/out:'+$worker))+@($production|Where-Object{[IO.Path]::GetFileName($_) -notin @('NativeRpcWorkerEntry.cs','NativeRpcWmi.cs','NativeRpcStart.cs','NativeRpcCleanup.cs','NativeRpcCleanupWitness.cs')})) 20000 'worker-compile'
    if((Get-Item -LiteralPath $worker).Length -gt 262144){throw 'Native worker image bound'}
    [pscustomobject]@{compiled=$true;workerExecuted=$false;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $worker).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $worker).Length}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'worker-artifact.json')
    $systemWorker=Join-Path $work 'system-worker.exe'
    Invoke-FiniteProcess $csc ($compilerOptions+@('/main:Enclave.OwnedRpc.NativeRpcWorkerEntry',('/out:'+$systemWorker))+@($production|Where-Object{[IO.Path]::GetFileName($_) -notin @('NativeRpcController.cs','NativeRpcManagerTransport.cs')})) 20000 'system-worker-compile'
    if((Get-Item -LiteralPath $systemWorker).Length -gt 262144){throw 'Native SYSTEM worker image bound'}
    [pscustomobject]@{compiled=$true;workerExecuted=$false;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $systemWorker).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $systemWorker).Length}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'system-worker-artifact.json')
    [pscustomobject]@{compiled=$true;fixtureExecuted=$true;nativeProviderExecuted=$false;rpcReady=$false;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $entry).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $entry).Length}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'artifact.json')
}finally{
    foreach($pin in $toolPins){if((Get-FileHash -Algorithm SHA256 -LiteralPath $pin.Path).Hash -cne $pin.Hash){throw "Compiler/reference changed"}}
    $records|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $work 'process-results.json')
    Get-FileHash -Algorithm SHA256 -LiteralPath ($production+@(Join-Path $root 'test\rpc-windows-worker\NativeRpcProgressHarness.cs')+@($csc))|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'pins.json')
    $publish=Join-Path $env:RUNNER_TEMP ('rpc-native-progress-results-'+[guid]::NewGuid().ToString('N'))
    $null=New-Item -ItemType Directory -Path $publish
    ('RPC_WORKER_RESULT='+$publish)|Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
    $total=0L
    foreach($name in @('toolchain.json','harness-compile.out','harness-compile.err','worker-harness.out','worker-harness.err','worker-compile.out','worker-compile.err','process-results.json','pins.json','artifact.json','worker-artifact.json','owned-entry.exe','native-worker.exe','system-worker.exe','system-worker-compile.out','system-worker-compile.err','system-worker-artifact.json')){
        $file=Join-Path $work $name
        if(Test-Path -LiteralPath $file){
            $limit=65536L;if($name -eq 'owned-entry.exe' -or $name -eq 'native-worker.exe' -or $name -eq 'system-worker.exe'){$limit=262144L}
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
