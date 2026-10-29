$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
try {
 $listeners=@(Get-NetTCPConnection -LocalPort 8097 -State Listen -ErrorAction Stop|Select-Object -ExpandProperty OwningProcess -Unique)
 if($listeners.Count -ne 1){throw 'listener identity unknown'}
 $pr=Get-CimInstance -OperationTimeoutSec 3 Win32_Process -Filter ('ProcessId='+$listeners[0]);if(-not $pr){throw 'listener exited'}
 $exe=[string]$pr.ExecutablePath
 if($exe -ne 'C:\Program Files\Enclave\runtime\node\node.exe' -or (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3'){throw 'Node executable pin differs'}
 # Inspect only this known public bootstrap argument shape. Never emit commandline/environment.
 $pattern='"(?<entry>C:\\ProgramData\\Enclave\\native-manager\\releases\\[0-9a-f]{64}\\bootstrap\.mjs)"\s+router\s+(?<manifest>[0-9a-f]{64})\s+"(?<config>C:\\ProgramData\\Enclave\\native-desktop\\releases\\[0-9a-f]{64}\\router-config\.json)"\s+(?<configPin>[0-9a-f]{64})(?:\s|$)'
 $m=[regex]::Match($pr.CommandLine,$pattern)
 if(-not $m.Success){throw 'unrecognized public bootstrap/config shape'}
 $entry=$m.Groups['entry'].Value;$mp=$m.Groups['manifest'].Value;$config=$m.Groups['config'].Value;$cp=$m.Groups['configPin'].Value
 $js="eval(Buffer.from('__VALIDATOR_BASE64__','base64').toString('utf8'))"
 $psi=New-Object Diagnostics.ProcessStartInfo;$psi.FileName=$exe
 $psi.Arguments='--max-old-space-size=32 --max-semi-space-size=1 --input-type=commonjs -e "'+$js+'" "'+$entry+'" '+$mp+' "'+$config+'" '+$cp
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.EnvironmentVariables.Remove('NODE_OPTIONS')
 $child=New-Object Diagnostics.Process;$child.StartInfo=$psi;$null=$child.Start()
 if(-not $child.WaitForExit(16000)){try{$child.Kill()}catch{};throw 'owned diagnostic child timeout'}
 $out=$child.StandardOutput.ReadToEnd();$err=$child.StandardError.ReadToEnd()
 if($child.ExitCode -ne 0 -or $out.Length -gt 16384 -or $err.Length -gt 4096){throw 'validator refused (raw output withheld)'}
 $j=$out|ConvertFrom-Json
 $os=Get-CimInstance -ClassName Win32_OperatingSystem -OperationTimeoutSec 3
 $mem=Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Memory -OperationTimeoutSec 3
 $resources=@{observedAt=[DateTime]::UtcNow.ToString('o');freePhysicalKiB=[uint64]$os.FreePhysicalMemory;commitLimitBytes=[uint64]$mem.CommitLimit;committedBytes=[uint64]$mem.CommittedBytes;availableCommitBytes=$null;notAtomicReservation=$true}
 if([uint64]$mem.CommitLimit -ge [uint64]$mem.CommittedBytes){$resources.availableCommitBytes=[uint64]$mem.CommitLimit-[uint64]$mem.CommittedBytes}

 $after=Get-CimInstance -OperationTimeoutSec 3 Win32_Process -Filter ('ProcessId='+$listeners[0])
 $ports=@(Get-NetTCPConnection -LocalPort 8097 -State Listen -ErrorAction Stop|Select-Object -ExpandProperty OwningProcess -Unique)
 if(-not $after -or $after.CreationDate -ne $pr.CreationDate -or $after.CommandLine -cne $pr.CommandLine -or $ports.Count -ne 1 -or $ports[0] -ne $listeners[0]){throw 'listener changed'}
 @{schema='enclave-router-admission-observation/1';checkedAt=[DateTime]::UtcNow.ToString('o');port=8097;pid=$listeners[0];created=$pr.CreationDate.ToUniversalTime().ToString('o');entry=$entry;configPath=$config;publicPins=$j;resources=$resources;totalPendingMiB=$null;enforcedEarlyBootstrapMiB=$null;enforcedObserverMiB=$null;admissible=$false;remainingUnknown=@('future launches','other host commitments','concurrent/direct admissions')}|ConvertTo-Json -Depth 10 -Compress
} catch {
 @{schema='enclave-router-admission-observation/1';checkedAt=[DateTime]::UtcNow.ToString('o');known=$false;admissible=$false;reason='readonly identity/pin/chain/stability validation refused; no budget inferred'}|ConvertTo-Json -Compress
 exit 1
}
