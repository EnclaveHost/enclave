
$D = 'C:\Users\claude\d1-parse51-20260926T074452Z'
$Hk = 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization'
$Gcs = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices'
$Sand = 'HKCU:\Software\EnclaveFwTest-20260926T074622Z-absent'
function Snap {
  $k = Get-Item -LiteralPath $Hk -ErrorAction Stop
  $vals = foreach ($n in ($k.GetValueNames() | Sort-Object)) { "$n=$($k.GetValue($n))($($k.GetValueKind($n)))" }
  $sub = @(Get-ChildItem -LiteralPath $Gcs -ErrorAction Stop | ForEach-Object { $_.PSChildName } | Sort-Object)
  [pscustomobject]@{ fw = $(if (@($k.GetValueNames()) -contains 'AllowFirmwareLoadFromFile') { "$($k.GetValue('AllowFirmwareLoadFromFile')) ($($k.GetValueKind('AllowFirmwareLoadFromFile')))" } else { 'ABSENT' });
                     all = ($vals -join '; '); gcs = ($sub -join ','); sandbox = (Test-Path -LiteralPath $Sand) }
}
"PS " + $PSVersionTable.PSVersion.ToString() + " " + $PSVersionTable.PSEdition + " host=" + $env:COMPUTERNAME
$b = Snap
"BEFORE $((Get-Date).ToUniversalTime().ToString('HH:mm:ss.fff'))Z HKLM AllowFirmwareLoadFromFile = $($b.fw)"
"BEFORE Virtualization values: $($b.all)"
"BEFORE GCS subkeys: $($b.gcs)"
"BEFORE sandbox key $Sand exists: $($b.sandbox)"
if ($b.sandbox) { "STOP: the sandbox key already exists; nothing run"; return }
foreach ($f in 'uefi-dev-boot.ps1','judge-probe.tests.ps1','firmware-setting.tests.sandbox.ps1') { "$f sha256=$((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $D $f)).Hash.ToLower())" }
foreach ($t in 'judge-probe.tests.ps1','firmware-setting.tests.sandbox.ps1') {
  $out = Join-Path $D ($t + '.ps51-output.txt')
  $e = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $D $t) *> $out
  $rc = $LASTEXITCODE; $ErrorActionPreference = $e
  "RUN $t exit=$rc at $((Get-Date).ToUniversalTime().ToString('HH:mm:ss'))Z output sha256=$((Get-FileHash -Algorithm SHA256 -LiteralPath $out).Hash.ToLower()) lines=$(@(Get-Content -LiteralPath $out).Count)"
  $a = Snap
  if ($a.fw -ne $b.fw -or $a.all -ne $b.all -or $a.gcs -ne $b.gcs) { "STOP: HKLM CHANGED after $t : fw $($b.fw) -> $($a.fw); values $($a.all); gcs $($a.gcs)"; return }
  "  HKLM unchanged after $t (fw $($a.fw)); sandbox key exists: $($a.sandbox)"
}
$a = Snap
"AFTER $((Get-Date).ToUniversalTime().ToString('HH:mm:ss.fff'))Z HKLM AllowFirmwareLoadFromFile = $($a.fw)"
"AFTER Virtualization values: $($a.all)"
"AFTER GCS subkeys: $($a.gcs)"
"IDENTICAL: $([bool]($a.fw -eq $b.fw -and $a.all -eq $b.all -and $a.gcs -eq $b.gcs))"
if ($a.sandbox) { Remove-Item -LiteralPath $Sand -Recurse -Force; "sandbox key EXISTED after the run and was removed; now exists: $(Test-Path -LiteralPath $Sand)" } else { "sandbox key never existed (none to remove)" }
"FAIL/ok summary judge: " + ((Get-Content -LiteralPath (Join-Path $D 'judge-probe.tests.ps1.ps51-output.txt') | Select-String -Pattern '^(ok|FAIL|NOT OK)' | Group-Object { ($_.Line -split ' ')[0] } | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ' ')
"FAIL/ok summary firmware: " + ((Get-Content -LiteralPath (Join-Path $D 'firmware-setting.tests.sandbox.ps1.ps51-output.txt') | Select-String -Pattern '^(ok|FAIL|NOT OK)' | Group-Object { ($_.Line -split ' ')[0] } | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ' ')
"--- judge tail"; Get-Content -LiteralPath (Join-Path $D 'judge-probe.tests.ps1.ps51-output.txt') | Select-Object -Last 3
"--- firmware tail"; Get-Content -LiteralPath (Join-Path $D 'firmware-setting.tests.sandbox.ps1.ps51-output.txt') | Select-Object -Last 3
