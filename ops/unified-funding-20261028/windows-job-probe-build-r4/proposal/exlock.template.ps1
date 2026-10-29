# NONRUNNABLE TEMPLATE. Separate Job qualification and current admission required; no auto follow-on.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
# Root must supply a reviewed, nonnegative pending-headroom amount. No implicit zero/default.
$pendingHeadroomMiB=__PENDING_HEADROOM_MIB__
if($pendingHeadroomMiB -lt 0){throw 'known pending headroom required'}
$availableMiB=[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)
$requiredMiB=17408+256+$pendingHeadroomMiB
if($availableMiB -lt $requiredMiB){throw 'memory admission refused'}
$exe='C:\Program Files\Enclave\runtime\node\node.exe'
if((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3'){throw 'observed Node executable drift'}
$js="eval(Buffer.from('__NODE_JS_BASE64__','base64').toString('utf8'))"
$psi=New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName=$exe;$psi.Arguments='--max-old-space-size=32 --max-semi-space-size=1 --input-type=commonjs -e "'+$js+'"'
if($psi.Arguments.Length -gt 30000){throw 'Node command line exceeds budget'}
$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
$psi.EnvironmentVariables.Remove('NODE_OPTIONS')
$child=New-Object System.Diagnostics.Process;$child.StartInfo=$psi;$null=$child.Start()
try{$child.ProcessorAffinity=[IntPtr]1}catch{try{$child.Kill()}catch{};throw 'could not enforce one CPU on owned test parent'}
if(-not $child.WaitForExit(25000)){try{$child.Kill()}catch{};throw 'owned test parent exceeded25s; self-bounded child expires within2.5s; inspect owned-path cleanup receipt'}
$out=$child.StandardOutput.ReadToEnd();$err=$child.StandardError.ReadToEnd()
if($out.Length -gt 16384 -or $err.Length -gt 4096){throw 'test output limit'}
if($err.Length -gt 0){throw 'test stderr nonempty; raw output withheld'}
$result=$out|ConvertFrom-Json
@{availableMiB=$availableMiB;requiredMiB=$requiredMiB;pendingHeadroomMiB=$pendingHeadroomMiB;exitCode=$child.ExitCode;result=$result}|ConvertTo-Json -Depth 8 -Compress
