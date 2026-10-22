#!/bin/bash
# READ-ONLY capacity and environment probe of minipc before any validation write.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
ps_remote '
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor
$pf = Get-CimInstance Win32_PageFileUsage
$disk = Get-PSDrive C
[ordered]@{
  at = (Get-Date).ToUniversalTime().ToString("o"); host = $env:COMPUTERNAME; os = $os.Caption + " " + $os.Version
  totalMiB = [int]($os.TotalVisibleMemorySize/1024); freeMiB = [int]($os.FreePhysicalMemory/1024)
  commitLimitMiB = [int]($os.TotalVirtualMemorySize/1024); commitFreeMiB = [int]($os.FreeVirtualMemory/1024)
  pagefiles = @($pf | ForEach-Object { "$($_.Name) alloc=$($_.AllocatedBaseSize)MB used=$($_.CurrentUsage)MB" })
  logicalCpus = $cs.NumberOfLogicalProcessors; cpuLoadPct = ($cpu | Measure-Object -Property LoadPercentage -Average).Average
  diskCFreeGiB = [math]::Round($disk.Free/1GB,1)
  psVersion = $PSVersionTable.PSVersion.ToString()
  node = (Get-Command node -ErrorAction SilentlyContinue).Source; nodeVersion = $(try { & node --version } catch { $null })
  whoami = (whoami); isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  validationRootExists = (Test-Path -LiteralPath "C:\ProgramData\Enclave\host-services-validation-20261021")
  ourTasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "EnclaveHostServicesValidation-20261021*" } | ForEach-Object { $_.TaskPath + $_.TaskName })
  enclaveTasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "*Enclave*" -or $_.TaskPath -like "*Enclave*" } | ForEach-Object { $_.TaskPath + $_.TaskName + " [" + $_.State + "]" })
  tarExe = (Get-Command tar -ErrorAction SilentlyContinue).Source
} | ConvertTo-Json -Depth 3
'
