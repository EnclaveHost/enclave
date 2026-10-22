# distribution-bootstrap NATIVE fixture (ROOT-ONLY; Windows PowerShell 5.1). Proves on minipc, with Windows' own in-box
# .NET Framework 4 csc (no install, no download, no Wine, no new dependency), that the staged EnclaveSetup.cs
# (policy pinning + relaunch quoting) compiles exactly as build-setup.cmd compiles it, that its PinPolicy/QuoteArgs behave
# (BootstrapCheck.cs), and that the repo's own native harness (test\windows-native\run.ps1: EnclaveSetup.cs ReleaseChannel,
# cli\host.ps1 and the Node verifier over one fixture set, plus bounded transfers on 127.0.0.1) passes on it.
# Writes ONLY inside -Stage and fresh %TEMP% folders it removes. The built EnclaveSetup.exe is hashed and NEVER started.
# No task, service, process (other than its own children), network beyond 127.0.0.1, ProgramData\Enclave-setup or
# Program Files is touched. The fixture policies are TEST data (mirror.invalid); nothing here is a release authority.
param([string]$Stage, [string]$NodeExe = 'C:\Program Files\nodejs\node.exe', [string]$NodeSha = 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3')
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$sw = [Diagnostics.Stopwatch]::StartNew(); $BOUND_SEC = 900
$out = [ordered]@{ pass = $false; boundSec = $BOUND_SEC; psVersion = $PSVersionTable.PSVersion.ToString() }
trap { $out.pass = $false; $out.error = 'fixture error: ' + $_.Exception.Message; $out | ConvertTo-Json -Compress -Depth 6; exit 3 }
if ($PSVersionTable.PSVersion.Major -ne 5 -or [string]$PSVersionTable.PSEdition -ne 'Desktop') { $out.error = 'not Windows PowerShell 5.1 Desktop'; $out | ConvertTo-Json -Compress; exit 4 }
function Sha($p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
# every other staged file, exactly (the driver pins THIS script; this script pins the rest before anything runs)
$PIN = [ordered]@{
  'BootstrapCheck.cs' = '327adb168958d9159768390a6a95a7c9a118faa34036670b52165989da3b81fa'
  'repo\cli\host.ps1' = '9c396209801be2edeae0d8e55d76d268b495e4755a3a464925843ed21b696488'
  'repo\test\windows-native\Harness.cs' = '5ec0768735a8bba108062e804ec348ca2d2397028abe92ac839bce2387ec3547'
  'repo\test\windows-native\fixtures.json' = '4e27f00729086ebbf0a550dcffa8cf8ecf0f34d377abd400acab18bc89127721'
  'repo\test\windows-native\make-fixtures.mjs' = '94608d043f00739e34913c47c678853cd40d5bcd00b5eb9e865185a36008983e'
  'repo\test\windows-native\node-verdicts.json' = 'bbd28794165202f292dec38d9540defeb5971f7af8ebb45efc207839bdec1a9d'
  'repo\test\windows-native\run.ps1' = 'bc337ae54703a9560bc1cbace2dd503fc7bfea58bf8ddf00f3187602e8d86d1b'
  'repo\windows\installer\EnclaveSetup.cs' = '6d707db7c6ef95a4e3f127dd1220b8856186203bf37b3eff69a999ab2d0fb60a'
  'repo\windows\installer\EnclaveSetup.manifest' = 'e2b9315ca02b67d5b9de90a9b246d32d5e6e134aaf041e0b12bc674a2de468cc'
  'repo\windows\installer\install-host.ps1' = '1d1580c8f9ac22f6ec96a34cea8455853b21a21cff5214187710f3483953b721'
  'repo\windows\installer\update-host.ps1' = '36f9e0d61afe58b77e566033ad1155d5c771252874f622592837c33e0a990112'
  'repo\windows\node\release-channel.mjs' = 'f690c29b606879468db94b7b78f283e7de09f94a262803e13ee4dc61b447f942'
  'repo\windows\node\update-watch.mjs' = '9104b137b884ae5d46dfa94f2ec8529d36ee2cd51c89f204eec9335cd1af46a7'
  'repo\windows\tray\TrayTheme.cs' = '6de0a61684121d635772735772908521a3eb0179a5583abf1fc1ab13469d9284'
}
$bad = @($PIN.Keys | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Stage $_)) -or (Sha (Join-Path $Stage $_)) -ne $PIN[$_] })
$out.pins = ($bad.Count -eq 0); if ($bad.Count) { $out.error = 'staged bytes are not the pinned files: ' + ($bad -join ', '); $out | ConvertTo-Json -Compress; exit 3 }
function Native([string]$Exe, [string[]]$A, [int]$Ms = 300000) {   # own child only; bounded; stderr never terminating
  $si = New-Object Diagnostics.ProcessStartInfo $Exe; $si.Arguments = (($A | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
  $si.UseShellExecute = $false; $si.RedirectStandardOutput = $true; $si.RedirectStandardError = $true; $si.CreateNoWindow = $true
  $p = [Diagnostics.Process]::Start($si); $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  $to = -not $p.WaitForExit($Ms); if ($to) { try { $p.Kill() } catch { }; [void]$p.WaitForExit(10000) }
  [pscustomobject]@{ code = $(if ($p.HasExited) { $p.ExitCode } else { $null }); timedOut = $to; out = [string]$o.Result; err = [string]$e.Result } }
$R = Join-Path $Stage 'repo'; $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
$out.csc = [ordered]@{ path = $csc; sha256 = $(if (Test-Path -LiteralPath $csc) { Sha $csc } else { 'absent' }); version = $(if (Test-Path -LiteralPath $csc) { (Get-Item -LiteralPath $csc).VersionInfo.FileVersion } else { $null }) }
$work = Join-Path $env:TEMP ('enclave-bootstrap-' + [guid]::NewGuid().ToString('N').Substring(0, 8)); [void][IO.Directory]::CreateDirectory($work)
$checks = [ordered]@{}
try {
  # ---- 1 the shipping scripts parse with Windows PowerShell 5.1
  $parse = [ordered]@{}
  foreach ($s in 'cli\host.ps1', 'windows\installer\install-host.ps1', 'windows\installer\update-host.ps1', 'test\windows-native\run.ps1') {
    $t = $null; $er = $null; [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $R $s), [ref]$t, [ref]$er); $parse[$s] = $er.Count }
  $out.parseErrors = $parse; $checks.parse = (@($parse.Values | Where-Object { $_ -ne 0 }).Count -eq 0)

  # ---- 2 EnclaveSetup.exe exactly as build-setup.cmd builds it (its flags and references), except /win32icon (cosmetic only:
  #      the icon comes from a tray build that downloads WebView2; this compile adds no dependency). Built, hashed, NEVER run.
  $refs = @('/r:System.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll')
  $setupExe = Join-Path $work 'EnclaveSetup.exe'
  $b = Native $csc (@('/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/warn:4', '/main:Enclave.Setup.SetupProgram', ('/win32manifest:' + (Join-Path $R 'windows\installer\EnclaveSetup.manifest')), ('/out:' + $setupExe)) + $refs +
                    @((Join-Path $R 'windows\installer\EnclaveSetup.cs'), (Join-Path $R 'windows\tray\TrayTheme.cs')))
  $out.setupBuild = [ordered]@{ code = $b.code; timedOut = $b.timedOut; output = ($b.out + $b.err).Trim(); exeSha256 = $(if (Test-Path -LiteralPath $setupExe) { Sha $setupExe } else { $null }); exeBytes = $(if (Test-Path -LiteralPath $setupExe) { (Get-Item -LiteralPath $setupExe).Length } else { $null }) }
  $checks.setupCompiles = ($b.code -eq 0 -and (Test-Path -LiteralPath $setupExe))

  # ---- 3 BootstrapCheck: the real PinPolicy / SetupOptions / QuoteArgs from the same EnclaveSetup.cs, in %TEMP% only
  $chkExe = Join-Path $work 'BootstrapCheck.exe'
  $c = Native $csc (@('/nologo', '/target:exe', '/platform:anycpu', '/main:Enclave.Setup.BootstrapCheck', ('/out:' + $chkExe)) + $refs +
                    @((Join-Path $R 'windows\installer\EnclaveSetup.cs'), (Join-Path $R 'windows\tray\TrayTheme.cs'), (Join-Path $Stage 'BootstrapCheck.cs')))
  $out.checkBuild = [ordered]@{ code = $c.code; output = ($c.out + $c.err).Trim() }
  if ($c.code -eq 0) {
    $bw = Join-Path $work 'bootstrap'; [void][IO.Directory]::CreateDirectory($bw)
    $r = Native $chkExe @((Join-Path $R 'test\windows-native\fixtures.json'), $bw) 120000
    $out.bootstrap = [ordered]@{ code = $r.code; lines = @($r.out -split "`r?`n" | Where-Object { $_ }) }
    $checks.bootstrap = ($r.code -eq 0 -and ($r.out -match 'ALL PASS'))
  } else { $checks.bootstrap = $false }

  # ---- 4 the repo's own native harness over the staged tree (its own %TEMP% work folder; 127.0.0.1 only)
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $hargs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $R 'test\windows-native\run.ps1'))
  $out.nodeUsed = ((Test-Path -LiteralPath $NodeExe) -and (Sha $NodeExe) -eq $NodeSha); if ($out.nodeUsed) { $hargs += @('-Node', $NodeExe) }
  $h = Native $ps $hargs 600000
  $lines = @($h.out -split "`r?`n" | Where-Object { $_ })
  $out.harness = [ordered]@{ code = $h.code; timedOut = $h.timedOut; pass = @($lines | Where-Object { $_ -like 'PASS*' }).Count; fail = @($lines | Where-Object { $_ -like 'FAIL*' }).Count
                             skip = @($lines | Where-Object { $_ -like 'SKIP*' }).Count; failLines = @($lines | Where-Object { $_ -like 'FAIL*' } | Select-Object -First 20) }
  $checks.harness = ($h.code -eq 0 -and -not $h.timedOut -and $out.harness.fail -eq 0 -and $out.harness.pass -gt 0)
  $hw = @($lines | Where-Object { $_ -like 'work folder: *' } | ForEach-Object { $_.Substring(13).Trim() }) | Select-Object -First 1
  if ($hw -and [IO.Path]::GetFullPath($hw).StartsWith([IO.Path]::GetFullPath($env:TEMP), [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $hw) -like 'enclave-native-*') {
    $res = Join-Path $hw 'results.json'; if (Test-Path -LiteralPath $res) { $out.harnessResultsSha256 = Sha $res }
    Remove-Item -LiteralPath $hw -Recurse -Force; $out.harnessWorkRemoved = -not (Test-Path -LiteralPath $hw) }
} finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
  $out.workRemoved = -not (Test-Path -LiteralPath $work)
}
$out.checks = $checks; $out.seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
$out.pass = [bool](@($checks.Values | Where-Object { -not $_ }).Count -eq 0 -and $checks.Count -eq 4 -and $out.workRemoved -and $sw.Elapsed.TotalSeconds -le $BOUND_SEC)
$out | ConvertTo-Json -Compress -Depth 6
if ($out.pass) { exit 0 } else { exit 1 }
