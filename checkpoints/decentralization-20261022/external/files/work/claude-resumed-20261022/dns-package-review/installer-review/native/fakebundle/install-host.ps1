# HARMLESS STAND-IN for install-host.ps1 (installer-r5-native fixture only; NOT an installer). It changes nothing: it prints one
# stdout line, ONE stderr line, waits 3 s, writes a completion marker ONLY inside its own staging directory, and exits 7.
# The marker answers whether the PARENT (the updater's Install function) let it finish after it wrote to stderr.
param([string]$Name = "", [string]$Owner = "", [string]$SetupExe = "", [switch]$Delta)
$ErrorActionPreference = "Continue"
[Console]::Out.WriteLine("fake-installer: start name=$Name owner=$Owner")
[Console]::Error.WriteLine("fake-installer: stderr line (expected by the fixture)")
Start-Sleep -Seconds 3
$own = Split-Path -Parent (Split-Path -Parent $PSCommandPath)          # ...\<stage>\fakebundle\install-host.ps1 -> <stage>
if ($SetupExe -and [IO.Path]::GetFullPath($SetupExe).StartsWith($own + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  [IO.File]::WriteAllText($SetupExe, "completed") }
[Console]::Out.WriteLine("fake-installer: end")
exit 7
