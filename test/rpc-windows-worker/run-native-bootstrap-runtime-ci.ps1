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
$compilerOptions=@('/nologo','/define:NATIVE_RPC_ONLY','/noconfig','/nostdlib+','/langversion:5','/optimize+','/debug-','/deterministic+','/target:exe','/platform:x64')+@($references|ForEach-Object{'/r:'+$_})
$controller=Join-Path $work 'qualification-controller.exe'
$entry=Join-Path $work 'keeper-compiled.exe'
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
    $production=@('BoundedWorker.cs','HostBootstrapChannels.cs','HostBootstrapEntry.cs','HostBootstrapFiles.cs','HostPhysicalPool.cs','LegacyHandoff.cs','LegacyLaunchCohort.cs','LegacyTemplateFence.cs','NativeRpcAuthority.cs','NativeRpcBootstrapBinding.cs','NativeRpcBootstrapLauncher.cs','NativeRpcCleanup.cs','NativeRpcCleanupWitness.cs','NativeRpcController.cs','NativeRpcDefinition.cs','NativeRpcFiles.cs','NativeRpcLifecycle.cs','NativeRpcLifecycleEntry.cs','NativeRpcLifecycleWatch.cs','NativeRpcManagerTransport.cs','NativeRpcPeerPins.cs','NativeRpcStart.cs','NativeRpcStartAuthority.cs','NativeRpcStartLauncher.cs','NativeRpcWmi.cs','NativeRpcWorkerEntry.cs','OwnedVmPermit.cs','OwnerObserver.cs','ProtectedAttempt.cs','ProviderStart.cs','WindowsStartAdmission.cs')|ForEach-Object{Join-Path $root ('windows\rpc\'+$_)}
    $compiled=New-Object Collections.Generic.List[object]
    $unitSources=@('BoundedWorker.cs','OwnerObserver.cs','ProtectedAttempt.cs','ProviderStart.cs','OwnedVmPermit.cs','HostPhysicalPool.cs','WindowsStartAdmission.cs','LegacyTemplateFence.cs','LegacyLaunchCohort.cs','LegacyHandoff.cs','NativeRpcDefinition.cs','NativeRpcStart.cs','NativeRpcCleanup.cs','NativeRpcAuthority.cs','NativeRpcFiles.cs','NativeRpcLifecycle.cs','NativeRpcLifecycleWatch.cs','NativeRpcPeerPins.cs','NativeRpcLifecycleEntry.cs')|ForEach-Object{Join-Path $root ('windows\rpc\'+$_)}
    Invoke-FiniteProcess $csc ($compilerOptions+@('/main:Enclave.OwnedRpc.NativeRpcLifecycleEntry',('/out:'+(Join-Path $work 'keeper-compiled.exe')))+$unitSources) 20000 'keeper-compile'
    $binary=Join-Path $work 'keeper-compiled.exe';if((Get-Item -LiteralPath $binary).Length -gt 262144){throw 'keeper image bound'}
    $compiled.Add([pscustomobject]@{entry='keeper';sourceCount=$unitSources.Count;bytes=(Get-Item -LiteralPath $binary).Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant();executed=$false;binaryExported=$false})
    $compiled|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $work 'artifact.json')
    $unitSources=@('BoundedWorker.cs','OwnerObserver.cs','ProtectedAttempt.cs','ProviderStart.cs','OwnedVmPermit.cs','HostPhysicalPool.cs','WindowsStartAdmission.cs','LegacyTemplateFence.cs','LegacyLaunchCohort.cs','LegacyHandoff.cs','NativeRpcDefinition.cs','NativeRpcWmi.cs','NativeRpcStart.cs','NativeRpcCleanup.cs','NativeRpcCleanupWitness.cs','NativeRpcAuthority.cs','NativeRpcWorkerEntry.cs','NativeRpcLifecycle.cs','NativeRpcStartAuthority.cs','NativeRpcPeerPins.cs')|ForEach-Object{Join-Path $root ('windows\rpc\'+$_)}
    Invoke-FiniteProcess $csc ($compilerOptions+@('/main:Enclave.OwnedRpc.NativeRpcWorkerEntry',('/out:'+(Join-Path $work 'system-worker.exe')))+$unitSources) 20000 'system-compile'
    $binary=Join-Path $work 'system-worker.exe';if((Get-Item -LiteralPath $binary).Length -gt 262144){throw 'system image bound'}
    $compiled.Add([pscustomobject]@{entry='system';sourceCount=$unitSources.Count;bytes=(Get-Item -LiteralPath $binary).Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant();executed=$false;binaryExported=$true})
    $compiled|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $work 'artifact.json')
    $unitSources=@('BoundedWorker.cs','OwnerObserver.cs','ProtectedAttempt.cs','ProviderStart.cs','OwnedVmPermit.cs','HostPhysicalPool.cs','WindowsStartAdmission.cs','LegacyTemplateFence.cs','LegacyLaunchCohort.cs','LegacyHandoff.cs','NativeRpcDefinition.cs','NativeRpcStart.cs','NativeRpcCleanup.cs','NativeRpcAuthority.cs','NativeRpcFiles.cs','NativeRpcLifecycle.cs','NativeRpcController.cs','NativeRpcManagerTransport.cs','NativeRpcStartLauncher.cs')|ForEach-Object{Join-Path $root ('windows\rpc\'+$_)}
    Invoke-FiniteProcess $csc ($compilerOptions+@('/define:NATIVE_RPC_ONLY,NATIVE_RPC_START_CONTROLLER','/main:Enclave.OwnedRpc.NativeRpcControllerEntry',('/out:'+(Join-Path $work 'start-compiled.exe')))+$unitSources) 20000 'start-compile'
    $binary=Join-Path $work 'start-compiled.exe';if((Get-Item -LiteralPath $binary).Length -gt 262144){throw 'start image bound'}
    $compiled.Add([pscustomobject]@{entry='start';sourceCount=$unitSources.Count;bytes=(Get-Item -LiteralPath $binary).Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant();executed=$false;binaryExported=$false})
    $compiled|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $work 'artifact.json')
    $unitSources=@('BoundedWorker.cs','OwnerObserver.cs','ProtectedAttempt.cs','ProviderStart.cs','OwnedVmPermit.cs','HostPhysicalPool.cs','WindowsStartAdmission.cs','LegacyTemplateFence.cs','LegacyLaunchCohort.cs','LegacyHandoff.cs','NativeRpcDefinition.cs','NativeRpcStart.cs','NativeRpcCleanup.cs','NativeRpcAuthority.cs','NativeRpcLifecycle.cs','NativeRpcBootstrapBinding.cs','HostBootstrapFiles.cs','HostBootstrapEntry.cs','HostBootstrapChannels.cs')|ForEach-Object{Join-Path $root ('windows\rpc\'+$_)}
    Invoke-FiniteProcess $csc ($compilerOptions+@('/main:Enclave.OwnedRpc.HostBootstrapEntry',('/out:'+(Join-Path $work 'native-worker.exe')))+$unitSources) 20000 'bootstrap-compile'
    $binary=Join-Path $work 'native-worker.exe';if((Get-Item -LiteralPath $binary).Length -gt 262144){throw 'bootstrap image bound'}
    $compiled.Add([pscustomobject]@{entry='bootstrap';sourceCount=$unitSources.Count;bytes=(Get-Item -LiteralPath $binary).Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant();executed=$false;binaryExported=$true})
    $compiled|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $work 'artifact.json')
    $unitSources=@('BoundedWorker.cs','OwnerObserver.cs','ProtectedAttempt.cs','ProviderStart.cs','OwnedVmPermit.cs','HostPhysicalPool.cs','WindowsStartAdmission.cs','LegacyTemplateFence.cs','LegacyLaunchCohort.cs','LegacyHandoff.cs','NativeRpcDefinition.cs','NativeRpcStart.cs','NativeRpcCleanup.cs','NativeRpcAuthority.cs','NativeRpcLifecycle.cs','NativeRpcBootstrapBinding.cs','HostBootstrapFiles.cs','NativeRpcFiles.cs','NativeRpcController.cs','NativeRpcBootstrapLauncher.cs')|ForEach-Object{Join-Path $root ('windows\rpc\'+$_)}
    Invoke-FiniteProcess $csc ($compilerOptions+@('/define:NATIVE_RPC_ONLY,NATIVE_RPC_START_CONTROLLER,NATIVE_RPC_BOOTSTRAP_CONTROLLER','/main:Enclave.OwnedRpc.NativeRpcBootstrapControllerEntry',('/out:'+(Join-Path $work 'manager-worker.exe')))+$unitSources) 20000 'controller-compile'
    $binary=Join-Path $work 'manager-worker.exe';if((Get-Item -LiteralPath $binary).Length -gt 262144){throw 'controller image bound'}
    $compiled.Add([pscustomobject]@{entry='controller';sourceCount=$unitSources.Count;bytes=(Get-Item -LiteralPath $binary).Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant();executed=$false;binaryExported=$true})
    $compiled|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $work 'artifact.json')
}finally{
    foreach($pin in $toolPins){if((Get-FileHash -Algorithm SHA256 -LiteralPath $pin.Path).Hash -cne $pin.Hash){throw "Compiler/reference changed"}}
    $records|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $work 'process-results.json')
    Get-FileHash -Algorithm SHA256 -LiteralPath ($production+@($csc))|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $work 'pins.json')
    $publish=Join-Path $env:RUNNER_TEMP ('rpc-native-bootstrap-runtime-results-'+[guid]::NewGuid().ToString('N'))
    $null=New-Item -ItemType Directory -Path $publish
    ('RPC_WORKER_RESULT='+$publish)|Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
    $total=0L
    foreach($name in @('toolchain.json','process-results.json','pins.json','artifact.json','keeper-compile.out','keeper-compile.err','system-compile.out','system-compile.err','start-compile.out','start-compile.err','bootstrap-compile.out','bootstrap-compile.err','controller-compile.out','controller-compile.err','manager-worker.exe','system-worker.exe','native-worker.exe')){
        $file=Join-Path $work $name
        if(Test-Path -LiteralPath $file){
            $limit=65536L;if($name -eq 'keeper-compiled.exe' -or $name -eq 'native-worker.exe' -or $name -eq 'system-worker.exe' -or $name -eq 'manager-worker.exe'){$limit=262144L}
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
