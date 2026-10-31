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


$controller=Join-Path $work 'fixture-preparer.exe'
$ci=Join-Path $work 'ci-fixture.exe'
$records=New-Object Collections.Generic.List[object]
function Invoke-FiniteProcess([string]$Executable,[string[]]$Arguments,[int]$DeadlineMs,[string]$Label,[int]$ExpectedExit=0,[string]$InputPath=''){
    foreach($a in $Arguments){if($a -match '["\r\n]'){throw 'Unexpected fixture argument'}}
    $out=Join-Path $work ($Label+'.out');$err=Join-Path $work ($Label+'.err')
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $options=@{FilePath=$Executable;ArgumentList=(($Arguments|ForEach-Object{'"'+$_+'"'}) -join ' ');PassThru=$true;NoNewWindow=$true;RedirectStandardOutput=$out;RedirectStandardError=$err}
    if($InputPath){$options.RedirectStandardInput=$InputPath}
    $p=Start-Process @options
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

$sources=@((Join-Path $root 'windows\rpc\BoundedWorker.cs'),(Join-Path $root 'windows\rpc\ProtectedAttempt.cs'),(Join-Path $root 'windows\rpc\TransitionFiles.cs'))
$admin=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544');$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
function DirectoryFixture([string]$kind,[string]$nonce){
 $parent='C:\EnclaveRpc'+$kind+'-'+$nonce;$dir=Join-Path $parent $nonce
 foreach($path in @($parent,$dir)){
  $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($admin);$acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @($admin,$system)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
  [void][IO.Directory]::CreateDirectory($path,$acl)
 };return $dir
}
function WriteFixture([string]$path,[byte[]]$raw){
 [IO.File]::WriteAllBytes($path,$raw);$acl=New-Object Security.AccessControl.FileSecurity;$acl.SetOwner($admin);$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($admin,$system)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))}
 [IO.File]::SetAccessControl($path,$acl)
}
function Bytes([string]$value){return [Text.Encoding]::UTF8.GetBytes($value)}
function Hash([byte[]]$raw){return [Enclave.OwnedRpc.ProtectedAttempt]::Hash($raw)}
function InvokeCase([string]$operation,[string]$nonce,$payload,[string]$label,[int]$exitCode=0,[string]$expectedBoot=$boot){
 $request=@{schema='owned-rpc-transition-files/1';operation=$operation;nonce=$nonce;windowsBoot=$expectedBoot;vmAttempt=$vmNonce;origin=$original;deadline=($original+900000);payload=$payload}
 $path=Join-Path $work ($label+'.input');[IO.File]::WriteAllBytes($path,(Bytes ($request|ConvertTo-Json -Depth 12 -Compress)))
 $origin=[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds()
 Invoke-FiniteProcess $exe @('--target',$operation,$nonce,$expectedBoot,[string]$origin,[string]($origin+5000),$imageHash) 8000 $label $exitCode $path
 if($exitCode -eq 0){$result=Get-Content -Raw (Join-Path $work ($label+'.out'))|ConvertFrom-Json
  if($result.requestHash -cne (Hash ([IO.File]::ReadAllBytes($path))) -or $result.vmChanged -or $result.rpcReady -or $result.reservationMayRelease -or -not $result.envelope.MembershipVerified -or -not $result.envelope.LimitsVerified -or $result.envelope.JobCommitLimitBytes -ne 128MB -or $result.envelope.BootstrapPrivateBytes -gt 64MB){throw 'Native result/envelope differs'}
  return $result
 }
 if((Get-Item (Join-Path $work ($label+'.out'))).Length -ne 0){throw 'Refusal emitted success output'}
}

try{
 $fixtureSource=Join-Path $root 'test\rpc-windows-worker\PrepareFileFixture.cs'
 $fixtureSources=@($sources[0],$sources[1],$fixtureSource)
 $compile=@('/nologo','/target:exe','/platform:x64','/r:System.Web.Extensions.dll','/main:Enclave.OwnedRpc.PrepareFileFixture')
 Invoke-FiniteProcess $csc ($compile+@(('/out:'+$controller))+$fixtureSources) 20000 'production-compile'
 Invoke-FiniteProcess $csc ($compile+@('/define:FILE_FIXTURE_CI',('/out:'+$ci))+$fixtureSources) 20000 'ci-compile'
 $helper=Join-Path $work 'ci-transition-files.exe'
 Invoke-FiniteProcess $csc (@('/nologo','/target:exe','/platform:x64','/r:System.Web.Extensions.dll','/main:Enclave.OwnedRpc.TransitionFiles','/define:TRANSITION_FILES_CI',('/out:'+$helper))+$sources) 20000 'helper-compile'
 [void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($controller))
 $boot=[Enclave.OwnedRpc.ProtectedAttempt]::CurrentBoot();$original=[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds()
 $vmNonce=[guid]::NewGuid().ToString('N');$handoffNonce=[guid]::NewGuid().ToString('N');$mediaNonce=[guid]::NewGuid().ToString('N')
 $imageRoot=DirectoryFixture 'Fixture' ([guid]::NewGuid().ToString('N'))
 $prep=Join-Path $imageRoot 'fixture-preparer.exe';WriteFixture $prep ([IO.File]::ReadAllBytes($ci));$prepHash=Hash ([IO.File]::ReadAllBytes($prep))
 $origin=[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds()
 Invoke-FiniteProcess $prep @('--target',$boot,[string]$origin,[string]($origin+5000),[string]$original,[string]($original+900000),$handoffNonce,$vmNonce,$mediaNonce,$prepHash) 8000 'prepare'
 $prepared=Get-Content -Raw (Join-Path $work 'prepare.out')|ConvertFrom-Json
 if(-not $prepared.success -or -not $prepared.fixtureOnly -or $prepared.vmChanged -or -not $prepared.envelope.MembershipVerified -or -not $prepared.envelope.LimitsVerified -or $prepared.envelope.JobCommitLimitBytes -ne 128MB -or $prepared.envelope.BootstrapPrivateBytes -gt 64MB){throw 'Native fixture envelope/result differs'}
 $origin=[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds()
 Invoke-FiniteProcess $prep @('--target',$boot,[string]$origin,[string]($origin+5000),[string]$original,[string]($original+900000),$handoffNonce,$vmNonce,$mediaNonce,$prepHash) 8000 'prepare-consumed' 1
 $wrongHandoff=[guid]::NewGuid().ToString('N');$origin=[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds()
 Invoke-FiniteProcess $prep @('--target',('0'*32),[string]$origin,[string]($origin+5000),[string]$original,[string]($original+900000),$wrongHandoff,([guid]::NewGuid().ToString('N')),([guid]::NewGuid().ToString('N')),$prepHash) 8000 'wrong-boot' 1
 if(Test-Path ('C:\EnclaveRpcLegacyHandoff-'+$wrongHandoff)){throw 'Wrong boot created namespace'}
 $exe=Join-Path $imageRoot 'transition-files.exe';WriteFixture $exe ([IO.File]::ReadAllBytes($helper));$imageHash=Hash ([IO.File]::ReadAllBytes($exe))
 $collected=InvokeCase 'collect-cut' ([guid]::NewGuid().ToString('N')) $prepared.collect 'collect'
 if($collected.result.files.Count -ne 3){throw 'Collected evidence incomplete'}
 $copied=InvokeCase 'copy-media' ([guid]::NewGuid().ToString('N')) $prepared.copy 'copy'
 if($copied.result.currentVmOffObserved -or $copied.result.mediaAttached -or $copied.result.privateContentsPrinted -or $copied.result.files.Count -ne 2){throw 'Dummy copy evidence differs'}
 foreach($row in $prepared.dummyFiles){
  $source=Join-Path $prepared.copy.sourceRoot $row.name;$dest=Join-Path $prepared.vmRoot $row.name
  if((Get-Item $dest).Length -ne $row.bytes -or (Get-FileHash $source).Hash.ToLowerInvariant() -cne $row.sha256 -or (Get-FileHash $dest).Hash.ToLowerInvariant() -cne $row.sha256){throw 'Dummy source/destination differs'}
 }
 [pscustomobject]@{passed=$true;tests=5;prepare=$prepared;collect=$collected;copy=$copied;nativeVmProof=$false;targetQualified=$false;productionBinaryExecuted=$false}|ConvertTo-Json -Depth 12|Set-Content (Join-Path $work 'RESULT.json')
}finally{
 $records|ConvertTo-Json -Depth 5|Set-Content (Join-Path $work 'process-results.json')
 Get-FileHash -Algorithm SHA256 -LiteralPath ($sources+@((Join-Path $root 'test\rpc-windows-worker\PrepareFileFixture.cs'),$csc))|ConvertTo-Json|Set-Content (Join-Path $work 'pins.json')
 if(Test-Path $controller){Get-FileHash $controller -Algorithm SHA256|ConvertTo-Json|Set-Content (Join-Path $work 'controller-artifact.json')}
 $publish=Join-Path $env:RUNNER_TEMP ('rpc-file-fixture-results-'+[guid]::NewGuid().ToString('N'));$null=New-Item -ItemType Directory -Path $publish;$total=0L
 $names=@('production-compile.out','production-compile.err','ci-compile.out','ci-compile.err','helper-compile.out','helper-compile.err','prepare.out','prepare.err','prepare-consumed.out','prepare-consumed.err','wrong-boot.out','wrong-boot.err','collect.out','collect.err','copy.out','copy.err','RESULT.json','process-results.json','pins.json','controller-artifact.json','fixture-preparer.exe')
 foreach($name in $names){$path=Join-Path $work $name;if(Test-Path $path){$f=Get-Item $path;$limit=65536L;if($name -eq 'fixture-preparer.exe'){$limit=262144L};if($f.Length -gt $limit -or $total+$f.Length -gt 1048576){throw 'Publication bound'};[IO.File]::Copy($path,(Join-Path $publish $name),$false);$total+=$f.Length}}
 ('RPC_WORKER_RESULT='+$publish)|Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
