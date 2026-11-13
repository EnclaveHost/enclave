# NucBox, 2026-11-13: load the approved native desktop release (SVN18, a2272bcd...) in the installed Shield manager.
#
# Run by shield-svn18.sh over ssh, fed on standard input, so every statement is one line.
# C:\ProgramData\Enclave\run-shield.cmd sets the desktop release before its restart loop, so the Shield task itself
# is ended and started again; the manager then lists the running app VMs as recovered and the node gives each a
# fresh boot inside its lease. The previous file is kept beside it and put back if the manager refuses to start
# or does not report the release.
#
# The task is \Enclave\Shield. The first copy of this script named it without its folder: ending and starting it
# failed, only the manager process was ended, and the task's old restart loop brought it back on the old release
# (twice, 20:08Z and 20:10Z). This copy stops before changing anything if the task is not found, and ends the
# old loop before the manager so the old release cannot come back.
$f='C:\ProgramData\Enclave\run-shield.cmd'
$old='2e801d0fde8259b29a44e53d7854dab2ddaeed7f8db8578e00bec0fde734bff3'
$new='a2272bcd8f7d5db883ae212ee1cb499a8bf100f9cc6f23073e61b68343f185f9'
$bak="$f.bak-20261113-before-svn18"
$log='C:\ProgramData\Enclave\logs\shield.log'
$tp='\Enclave\'
$ErrorActionPreference='Stop'
$task=$null
$task=Get-ScheduledTask -TaskPath $tp -TaskName Shield
if (-not $task) { 'STOP: the task \Enclave\Shield was not found; nothing changed'; exit 1 }
"task " + $task.TaskPath + $task.TaskName + " is " + $task.State
"before: VMs " + ((Get-VM | Where-Object { $_.State -eq 'Running' } | ForEach-Object { $_.Name.Substring(0,[Math]::Min(22,$_.Name.Length)) }) -join ' ')
if (-not (Test-Path -LiteralPath $bak)) { Copy-Item -LiteralPath $f -Destination $bak }
$t=[IO.File]::ReadAllText($f)
$n=$t.Replace("releases\$old\native-desktop-env.cmd","releases\$new\native-desktop-env.cmd")
if ($n -eq $t) { 'STOP: the line to change was not found; nothing changed'; exit 1 }
[IO.File]::WriteAllText($f,$n,(New-Object Text.ASCIIEncoding))
"edited: " + ((Get-Content -LiteralPath $f | Select-String -Pattern 'native-desktop-env').Line)
$mark=(Get-Item -LiteralPath $log).Length
Stop-ScheduledTask -TaskPath $tp -TaskName Shield
Start-Sleep -Seconds 4
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match 'run-shield' } | ForEach-Object { "the task's restart loop is still running as pid " + $_.ProcessId + "; ending it"; Stop-Process -Id $_.ProcessId -Force }
$l=Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($l) { "manager still listening as pid " + $l.OwningProcess + "; ending that process"; Stop-Process -Id $l.OwningProcess -Force; Start-Sleep -Seconds 2 }
Start-ScheduledTask -TaskPath $tp -TaskName Shield
"task restarted " + (Get-Date).ToUniversalTime().ToString('HH:mm:ssZ')
$h=$null
1..30 | ForEach-Object { if (-not $h) { Start-Sleep -Seconds 3; try { $h=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8091/health' -TimeoutSec 5).Content | ConvertFrom-Json } catch {} } }
$fs=[IO.File]::Open($log,'Open','Read','ReadWrite'); $null=$fs.Seek($mark,'Begin'); $sr=New-Object IO.StreamReader($fs); $tail=$sr.ReadToEnd(); $sr.Close()
"--- shield.log since restart"
$tail -split "`n" | Select-Object -First 25 | ForEach-Object { $_.Substring(0,[Math]::Min(300,$_.Length)) }
$refused = $tail -match 'REFUSING TO START'
if ($h) { "health: canStart=" + $h.canStart + " epoch=" + $h.managerEpoch + " desktop.ready=" + $h.desktop.ready + " igvm=" + $h.desktop.igvmSha256 + " profile=" + $h.desktop.profileSha256 + " inventory=" + ($h.inventory | ConvertTo-Json -Compress) } else { "health: no answer in 90 s" }
if ($refused -or -not $h -or $h.desktop.igvmSha256 -ne $new -or $h.desktop.ready -ne $true) { "REVERTING to the previous run-shield.cmd"; Copy-Item -LiteralPath $bak -Destination $f -Force; Stop-ScheduledTask -TaskPath $tp -TaskName Shield; Start-Sleep -Seconds 4; Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match 'run-shield' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; Start-ScheduledTask -TaskPath $tp -TaskName Shield; Start-Sleep -Seconds 20; try { "after revert: " + ((Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8091/health' -TimeoutSec 8).Content.Substring(0,200)) } catch { "after revert: no health answer yet" } } else { "DONE: the manager reports the approved release" }
