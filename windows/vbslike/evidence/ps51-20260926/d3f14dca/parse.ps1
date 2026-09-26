$D = 'C:\Users\claude\d1-parse51-20260926T073508Z'
"PS " + $PSVersionTable.PSVersion.ToString() + " " + $PSVersionTable.PSEdition + " host=" + $env:COMPUTERNAME + " now=" + (Get-Date).ToUniversalTime().ToString('s') + 'Z'
foreach ($f in 'uefi-dev-boot.ps1','firmware-setting.tests.ps1') {
  $p = Join-Path $D $f
  $h = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower()
  $t = $null; $e = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$t, [ref]$e)
  "$f sha256=$h tokens=$($t.Count) parseErrors=$($e.Count)"
  foreach ($x in @($e) | Select-Object -First 8) { "  ERR line $($x.Extent.StartLineNumber): $($x.Message)" }
  if ($f -eq 'uefi-dev-boot.ps1') { $main = $ast }
}
# the six firmware functions as 5.1's AST sees them
$want = 'Read-Setting','FirmwareAlreadyOn','Assert-FirmwareRunnable','Invoke-FirmwareApply','Invoke-FirmwareRestore','FirmwareWatchdogRestore'
$fns = @($main.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] })
foreach ($w in $want) { $m = @($fns | Where-Object { $_.Name -eq $w }); "fn $w top-level defs=$($m.Count) line=$(if ($m.Count) { $m[0].Extent.StartLineNumber })" }
$top = @($main.EndBlock.Statements)
for ($i = 0; $i -lt $top.Count; $i++) {
  if ($top[$i].Extent.Text -match '^\$before\s*=\s*Read-Setting') { "top-level: line $($top[$i].Extent.StartLineNumber) '$($top[$i].Extent.Text)' then line $($top[$i+1].Extent.StartLineNumber) '$($top[$i+1].Extent.Text)'" }
}
# the watchdog as it would be RENDERED, for each prior state: string expansion only (two pure functions + Join-Path)
foreach ($n in 'FirmwareAlreadyOn','FirmwareWatchdogRestore') { . ([scriptblock]::Create((@($fns | Where-Object { $_.Name -eq $n })[0].Extent.Text))) }
$wdAsg = @($top | Where-Object { $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -eq '$wd' })
"watchdog here-string assignments at top level: $($wdAsg.Count) (line $($wdAsg[0].Extent.StartLineNumber))"
$RegPath = 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization'; $RegName = 'AllowFirmwareLoadFromFile'
$SvcPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices'; $ReportSvcGuid = '{0:x8}-facb-11e6-bd58-64006a7986d3' -f 9001
$wdCeiling = 1320; $myStartTicks = 638000000000000000; $MARKER = 'stub-marker'; $name = 'enclave-uefi-PARSECHECK'
$sentinel = 'C:\Users\claude\uefi-probe-active-PARSECHECK.txt'; $wdFired = 'C:\Users\claude\uefi-watchdog-fired-PARSECHECK.txt'; $script:logPath = 'C:\Users\claude\uefi-dev-boot-PARSECHECK.log'
$states = @( @{ S='NoKey' }, @{ S='Absent' }, @{ S='Present'; V=0; K='DWord' }, @{ S='Present'; V=1; K='DWord' } )
foreach ($before in $states) {
  $txt = Invoke-Expression $wdAsg[0].Right.Extent.Text
  $t = $null; $e = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput($txt, [ref]$t, [ref]$e)
  $line = ($txt -split "`r?`n" | Where-Object { $_ -match 'AllowFirmwareLoadFromFile' } | ForEach-Object { $_.Trim() }) -join ' | '
  "rendered watchdog before=$($before.S)$(if ($before.S -eq 'Present') { '=' + $before.V }): parseErrors=$($e.Count) restore: $line"
  foreach ($x in @($e) | Select-Object -First 4) { "  ERR line $($x.Extent.StartLineNumber): $($x.Message)" }
}
