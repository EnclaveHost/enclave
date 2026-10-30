# NONRUNNABLE SOURCE TEMPLATE: unresolved literals intentionally refuse. No staging or automatic retry.
# Execute ONLY inside pinned r2 owned-job.exe after coordinator's source/build/staging/admission review.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$probe='__EXACT_REVIEWED_OWNED_PROBE_PATH__'
$expected='__PINNED_LOCALLY_BUILT_PROBE_SHA256__'
$pendingHeadroomMiB=__ACCOUNTED_PENDING_MIB__
if($pendingHeadroomMiB -lt 0){throw 'explicit nonnegative accounted pending required'}
if($probe -notmatch '^C:\\Windows\\Temp\\enclave-job-test-[0-9a-f]{32}\\job-probe.exe$' -or $expected -notmatch '^[0-9a-f]{64}$'){throw 'unreviewed staging identity'}
$cursor=Get-Item -LiteralPath $probe
if($cursor.PSIsContainer){throw 'probe not regular file'}
while($null -ne $cursor){
 if($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse path refused'}
 $parent=[IO.Path]::GetDirectoryName($cursor.FullName)
 if([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor.FullName){break}
 $cursor=Get-Item -LiteralPath $parent
}
if((Get-FileHash -LiteralPath $probe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected){throw 'probe hash drift'}
$free=[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)
if($free -lt 17408+256+$pendingHeadroomMiB){throw 'headroom refused'}
$psi=New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName=$probe;$psi.Arguments='';$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
$child=New-Object System.Diagnostics.Process;$child.StartInfo=$psi;$null=$child.Start()
if(-not $child.WaitForExit(15000)){try{$child.Kill()}catch{};throw 'owned probe timeout; no qualification'}
$out=$child.StandardOutput.ReadToEnd();$err=$child.StandardError.ReadToEnd()
if($out.Length -gt 4096 -or $err.Length -ne 0 -or $child.ExitCode -ne 0){throw 'owned probe failed; no qualification'}
$r=$out|ConvertFrom-Json
if($r.schema -ne 'enclave-disposable-job-probe/2' -or $r.evidenceCollected -ne $true -or $r.scopePassed -ne $false -or $r.limitAttributionQualified -ne $false -or $r.ownerDeathQualified -ne $false){throw 'unexpected probe result'}
@{schema='enclave-job-observation/2';receiptOnly=$true;limitAttributionEvidence='pending review';availableMiB=$free;pendingMiB=$pendingHeadroomMiB;probe=$r;jobFullyQualified=$false;ownerDeathEvidence='pending';exlockAuthorized=$false}|ConvertTo-Json -Depth 8 -Compress
