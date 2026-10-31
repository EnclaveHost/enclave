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


$controller=Join-Path $work 'transition-files.exe'
$ci=Join-Path $work 'ci-files.exe'
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
 $compile=@('/nologo','/target:exe','/platform:x64','/r:System.Web.Extensions.dll','/main:Enclave.OwnedRpc.TransitionFiles')
 Invoke-FiniteProcess $csc ($compile+@('/out:'+$controller)+$sources) 20000 'production-compile'
 Invoke-FiniteProcess $csc ($compile+@('/define:TRANSITION_FILES_CI','/out:'+$ci)+$sources) 20000 'ci-compile'
 [void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($controller))
 $boot=[Enclave.OwnedRpc.ProtectedAttempt]::CurrentBoot();$original=[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds()
 $vmNonce=[guid]::NewGuid().ToString('N');$imageRoot=DirectoryFixture 'FileHelper' ([guid]::NewGuid().ToString('N'));$exe=Join-Path $imageRoot 'transition-files.exe'
 WriteFixture $exe ([IO.File]::ReadAllBytes($ci));$imageHash=Hash ([IO.File]::ReadAllBytes($exe))
 $observation=Bytes (@{rc=0;failure=$null;readOnly=$true;observation=@{bootNative=$boot}}|ConvertTo-Json -Depth 4 -Compress)
 $stage=@{files=@(@{name='observation.json';sha256=(Hash $observation);base64=[Convert]::ToBase64String($observation)})};$stageNonce=[guid]::NewGuid().ToString('N')
 $staged=InvokeCase 'stage-inputs' $stageNonce $stage 'stage'
 if($staged.result.files.Count -ne 1 -or (Get-FileHash (Join-Path $staged.result.root 'observation.json')).Hash.ToLowerInvariant() -cne (Hash $observation)){throw 'Staged readback differs'}
 InvokeCase 'stage-inputs' $stageNonce $stage 'stage-consumed' 1
 $handoffNonce=[guid]::NewGuid().ToString('N');$handoffRoot=DirectoryFixture 'LegacyHandoff' $handoffNonce
 $contract=Bytes ((@('owned-rpc-legacy-handoff-v1',$handoffNonce,$boot,[string]$original,[string]($original+20000),('a'*64),'legacy-memory-cut-seed-v1',('b'*64),'') -join "`n"))
 $activation=@{schema='legacy-pool-seed/2';creationMode='retained-fenced-rpc-only/1';manifest=('b'*64);boot=$boot;configPath='C:\Fixture\pool.txt';poolHash=('c'*64);capacityBytes=79267102720L;initialBytes=16154361856L;initialCount=4;physicalBytes=120070115328L;nonPoolReserveBytes=20401094656L;floorBytes=19327352832L;variationBytes=1073741824L;prospectiveBytes=41301311488L;cutHash=('d'*64);inventoryHash=('e'*64);providerSettled=$false;capacityAdmitted=$false;reservationMayRelease=$false}
 $activationRaw=Bytes ($activation|ConvertTo-Json -Compress);WriteFixture (Join-Path $handoffRoot 'contract.txt') $contract;WriteFixture (Join-Path $handoffRoot 'pool.activation') $activationRaw;WriteFixture (Join-Path $handoffRoot 'pool.complete') (Bytes (Hash $activationRaw))
 $collect=@{root=$handoffRoot;contractHash=(Hash $contract);activation=$activation}
 $collected=InvokeCase 'collect-cut' ([guid]::NewGuid().ToString('N')) $collect 'collect'
 if($collected.result.files.Count -ne 3 -or [Convert]::FromBase64String($collected.result.files[1].base64).Length -ne $activationRaw.Length){throw 'Exact collected bytes differ'}
 $collect.contractHash='0'*64;InvokeCase 'collect-cut' ([guid]::NewGuid().ToString('N')) $collect 'wrong-contract' 1
 $vmRoot=DirectoryFixture 'Vm' $vmNonce;$badSource=DirectoryFixture 'PrivateMedia' ([guid]::NewGuid().ToString('N'));$goodSource=DirectoryFixture 'PrivateMedia' ([guid]::NewGuid().ToString('N'))
 $dummyBoot=New-Object byte[] 32768;$dummySeed=Bytes 'INERT-CI-SEED-NO-CREDENTIALS'
 foreach($dir in @($badSource,$goodSource)){WriteFixture (Join-Path $dir 'boot.vhdx') $dummyBoot;WriteFixture (Join-Path $dir 'seed.iso') $dummySeed}
 $plan=Bytes ((@('owned-rpc-definition/1',$vmNonce,$boot,('f'*64),('a'*64),$vmRoot,[string]$original,[string]($original+900000),(Hash $dummyBoot),(Hash $dummySeed),'generation-2-ubuntu;guest=20401094656;support=1073741824;vcpus=4;start=false','') -join "`n"))
 WriteFixture (Join-Path $vmRoot 'definition-plan.txt') $plan
 $receipt=Bytes '{"fixture":"synthetic-off-definition"}';$systemRaw=Bytes (@{receipt=(Hash $receipt);system='Msvm_ComputerSystem.CreationClassName="Msvm_ComputerSystem",Name="00000000-0000-0000-0000-000000000001"'}|ConvertTo-Json -Compress)
 WriteFixture (Join-Path $vmRoot 'definition.receipt') $receipt;WriteFixture (Join-Path $vmRoot 'definition.system') $systemRaw;WriteFixture (Join-Path $vmRoot 'definition.off') (Bytes ((Hash $systemRaw)+';'+(Hash $plan)+';owned-off-zero;start-authorized=false'))
 $acl=[IO.File]::GetAccessControl((Join-Path $badSource 'seed.iso'));$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('Everyone','Read','Allow')));[IO.File]::SetAccessControl((Join-Path $badSource 'seed.iso'),$acl)
 InvokeCase 'copy-media' ([guid]::NewGuid().ToString('N')) @{sourceRoot=$badSource;planHash=(Hash $plan)} 'foreign-read' 1
 if(Test-Path (Join-Path $vmRoot 'media-copy.intent')){throw 'Foreign readable source consumed copy intent'}
 $copy=@{sourceRoot=$goodSource;planHash=(Hash $plan)};$copied=InvokeCase 'copy-media' ([guid]::NewGuid().ToString('N')) $copy 'copy'
 if($copied.result.currentVmOffObserved -or $copied.result.mediaAttached -or $copied.result.privateContentsPrinted -or $copied.result.files.Count -ne 2){throw 'Copy evidence claims native VM qualification'}
 foreach($name in @('boot.vhdx','seed.iso')){if((Get-FileHash (Join-Path $goodSource $name)).Hash -cne (Get-FileHash (Join-Path $vmRoot $name)).Hash){throw 'Copy/source digest differs'}}
 InvokeCase 'copy-media' ([guid]::NewGuid().ToString('N')) $copy 'copy-consumed' 1
 InvokeCase 'stage-inputs' ([guid]::NewGuid().ToString('N')) $stage 'wrong-boot' 1 ('0'*32)
 # Independently held controller with stdin deliberately left open. Native
 # watchdog must terminate before the external five-second fixture deadline.
 $origin=[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds();$nonce=[guid]::NewGuid().ToString('N')
 $psi=New-Object Diagnostics.ProcessStartInfo($exe,('--target stage-inputs '+$nonce+' '+$boot+' '+$origin+' '+($origin+1500)+' '+$imageHash));$psi.UseShellExecute=$false;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.CreateNoWindow=$true
 $blocked=[Diagnostics.Process]::Start($psi);$held=$blocked.Handle;$timer=[Diagnostics.Stopwatch]::StartNew();$externalKill=$false
 try{if(-not $blocked.WaitForExit(5000)){$externalKill=$true;$blocked.Kill();if(-not $blocked.WaitForExit(3000)){throw 'Exact blocked fixture death unconfirmed'}};if($externalKill -or $blocked.ExitCode -ne 124){throw 'Blocked stdin watchdog not independently proven'}
  $watchdog=@{pid=$blocked.Id;exitCode=$blocked.ExitCode;elapsedMs=$timer.ElapsedMilliseconds;externalKill=$externalKill;exactExited=$blocked.HasExited}
 }finally{$blocked.Dispose()}
 [pscustomobject]@{passed=$true;tests=9;watchdog=$watchdog;stageEnvelope=$staged.envelope;copyEnvelope=$copied.envelope;dummyBytes=($dummyBoot.Length+$dummySeed.Length);nativeVmProof=$false;targetQualified=$false;productionBinaryExecuted=$false}|ConvertTo-Json -Depth 6|Set-Content (Join-Path $work 'RESULT.json')
}finally{
 $records|ConvertTo-Json -Depth 5|Set-Content (Join-Path $work 'process-results.json')
 Get-FileHash -Algorithm SHA256 -LiteralPath ($sources+@($csc))|ConvertTo-Json|Set-Content (Join-Path $work 'pins.json')
 if(Test-Path $controller){Get-FileHash $controller -Algorithm SHA256|ConvertTo-Json|Set-Content (Join-Path $work 'controller-artifact.json')}
 $publish=Join-Path $env:RUNNER_TEMP ('rpc-transition-files-results-'+[guid]::NewGuid().ToString('N'));$null=New-Item -ItemType Directory -Path $publish;$total=0L
 $names=@('production-compile.out','production-compile.err','ci-compile.out','ci-compile.err','stage.out','stage.err','stage-consumed.out','stage-consumed.err','collect.out','collect.err','wrong-contract.out','wrong-contract.err','foreign-read.out','foreign-read.err','copy.out','copy.err','copy-consumed.out','copy-consumed.err','wrong-boot.out','wrong-boot.err','RESULT.json','process-results.json','pins.json','controller-artifact.json','transition-files.exe')
 foreach($name in $names){$path=Join-Path $work $name;if(Test-Path $path){$f=Get-Item $path;$limit=65536L;if($name -eq 'transition-files.exe'){$limit=262144L};if($f.Length -gt $limit -or $total+$f.Length -gt 1048576){throw 'Publication bound'};[IO.File]::Copy($path,(Join-Path $publish $name),$false);$total+=$f.Length}}
 ('RPC_WORKER_RESULT='+$publish)|Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
