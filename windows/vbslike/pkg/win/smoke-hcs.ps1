# smoke-hcs.ps1 -- boot the package's guest and serve its first app, end to end, on the hcs-dev profile
# (windows/vbslike/pkg/README.md). RUN BY THE BOX OWNER: it starts Hyper-V child partitions on the box.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\claude\vbs-like\pkg\<id16>\win\smoke-hcs.ps1 -ManifestSha256 <64 hex>
#
# It is a client of the box's own launcher, `vbslike-host lab` (windows/vbslike/host/src/lab.rs), not a second one:
#   1. verify the package (check.ps1's checks) -- nothing starts on a package that does not verify;
#   2. start the launcher on the package's kernel and monitor initrd; its ready line must name THOSE two hashes;
#   3. `load` the app's bundle; the monitor's own hash of what arrived must be the package's AppID;
#   4. GET the app through the launcher's relay (TLS ends in the domain) and compare it with the manifest's answer;
#   5. `destroy` and `quit` whatever happened -- and the launcher's partitions end with its process in any case
#      (ShouldTerminateOnLastHandleClosed).
# Writes only <pkg>\runs\hcs-<utc>\ (the launcher's --out, its transcript and smoke.json). HCS on Virtual Machine
# Platform only: no role, no feature, no host setting, no reboot. The boundary is an HCS child partition, which does
# NOT exclude this host: a development path, never verified or host-excluded capacity. Exit 0 = served as pinned.
param(
  [Parameter(Mandatory = $true)][string]$ManifestSha256,
  [string]$App = 'hello-world',
  [int]$MemMiB = 512,
  [int]$Cpus = 1,
  [int]$TcpBase = 19400,
  [int]$StartSec = 60,
  [int]$LoadSec = 120,
  [int]$ReadySec = 90,               # the guest's readiness, then the app's first exact answer
  [string]$Dir = ''                 # default: the package directory this script sits in
)
$ErrorActionPreference = 'Stop'
# $PSScriptRoot is empty in a param() default under Windows PowerShell 5.1 -File, so it is read here
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'pkg.lib.ps1')
if (-not $Dir) { $Dir = Split-Path -Parent $here }
$Dir = Resolve-PkgDir $Dir
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')

$R = New-Results
$M = Read-PkgManifest $R $Dir $ManifestSha256
if ($M) { Test-PkgFiles $R $Dir $M }
$a = if ($M) { Get-PkgApp $M $App } else { $null }
if ($M -and -not $a) { [void](Add-Result $R $false "app $App" 'not in this package') }
if ($a -and -not $a.servable) { [void](Add-Result $R $false "app $App" "not servable in this package: $($a.blockedOn)") }
if (-not (Test-ResultsOk $R)) { Write-Results $R; 'FAIL smoke: the package does not verify; nothing was started'; exit 1 }

$P = $M.profiles.'hcs-dev'
$exe = Get-PkgFilePath $Dir $P.launcher; $kernel = Get-PkgFilePath $Dir $P.kernel; $initrd = Get-PkgFilePath $Dir $P.initrd
$bundle = Get-PkgFilePath $Dir "$($a.dir)/app.bundle"
$pin = @{}; foreach ($f in $M.files) { $pin[$f.path] = $f.sha256 }
$runs = Join-Path $Dir "runs\hcs-$stamp"; New-Item -ItemType Directory -Force -Path $runs | Out-Null
$transcript = New-Object System.Collections.ArrayList

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.Arguments = "lab --kernel `"$kernel`" --initrd `"$initrd`" --out `"$runs\lab`" --mem $MemMiB --cpus $Cpus --tcp-base $TcpBase"
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$psi.WorkingDirectory = $runs
$proc = $null; $errTask = $null; $pending = $null
# One JSON answer per line; a line that is not JSON is kept in the transcript and skipped, as backend-hcs.mjs does.
# A read that times out leaves its task pending, so the next read waits on THAT task rather than starting a second
# one on the same stream.
function Read-Answer([int]$Sec) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Sec)
  while ($true) {
    $left = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
    $t = if ($script:pending) { $script:pending } else { $proc.StandardOutput.ReadLineAsync() }
    if (-not $t.Wait($left)) { $script:pending = $t; throw "the launcher did not answer within $Sec s" }
    $script:pending = $null
    $line = $t.Result
    if ($null -eq $line) { throw 'the launcher closed its output' }
    [void]$transcript.Add("< $line")
    $j = $null
    try { $j = $line | ConvertFrom-Json } catch { $j = $null }
    if ($null -ne $j -and $j -is [System.Management.Automation.PSCustomObject]) { return $j }
  }
}
function Send-Line([string]$L) { [void]$transcript.Add("> $L"); $proc.StandardInput.WriteLine($L); $proc.StandardInput.Flush() }

# After a load the guest agreed on: ready, a document for OUR nonce judged against THIS session's key, and the app's
# exact answer -- all on ONE certificate (isolation/m3/HV-GUEST.md: "running"). A guest that declares no readiness or
# attestation surface (no `guest` in the manifest) gets only the answer, polled until the deadline.
function Test-Served($loaded, $hello) {
  $port = [int]$loaded.tcpPort; $certs = @{}
  $G = if ($M.PSObject.Properties.Name -contains 'guest') { $M.guest } else { $null }
  $deadline = (Get-Date).AddSeconds($ReadySec)
  if ($G) {
    $rd = $null; $why = 'no answer'
    while ((Get-Date) -lt $deadline) {
      try { $rd = Invoke-TlsRequest '127.0.0.1' $port $G.readyPath; $certs[$rd.CertB64] = 1; if ($rd.Status -eq 200) { break }; $why = "$($rd.Status) $($rd.Body)" }
      catch { $why = $_.Exception.Message }
      Start-Sleep -Milliseconds 500
    }
    $rj = $null; if ($rd -and $rd.Status -eq 200) { try { $rj = $rd.Body | ConvertFrom-Json } catch { } }
    $okRd = $rj -and $rj.ready -eq $true -and [string]$rj.appId -eq $a.appId
    [void](Add-Result $R $okRd "the guest says ready for this app ($($G.readyPath))" $(if ($okRd) { "200 mode=$($rj.mode) port=$($rj.port)" } else { $why }))
    $nb = New-Object byte[] 32; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($nb); $rng.Dispose()
    $nonceHex = ([System.BitConverter]::ToString($nb) -replace '-', '').ToLower()
    $att = $null
    try { $att = Invoke-TlsRequest '127.0.0.1' $port "$($G.attestationPath)?nonce=$nonceHex"; $certs[$att.CertB64] = 1 } catch { $why = $_.Exception.Message }
    if ($att -and $att.Status -eq 200) {
      $ev = [ordered]@{ docRaw = $att.Body; certB64 = $att.CertB64; nonceHex = $nonceHex; expectedAppSha256 = $a.appId
                        launcherKey = [string]$hello.launcherKey; expectedVmId = [string]$loaded.vmId; expectedImageSha256 = $pin[$P.initrd]
                        runtimeRaw = [System.IO.File]::ReadAllText((Get-PkgFilePath $Dir $M.runtime.file)) }
      $evFile = Join-Path $runs 'evidence.json'
      [System.IO.File]::WriteAllText($evFile, ($ev | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
      $jline = & node (Get-PkgFilePath $Dir $G.judgeRun) $evFile 2>&1 | Select-Object -Last 1
      $j = $null; try { $j = "$jline" | ConvertFrom-Json } catch { }
      $okJ = $j -and $j.verdict -eq 'monitor-signed'
      $script:verdict = if ($j) { [string]$j.verdict } else { 'reject' }
      [void](Add-Result $R $okJ 'the document for our nonce, judged on this session''s key (judge-hv)' $(if ($okJ) { "monitor-signed (T0-hv: signed by the launcher in the root partition, host NOT excluded), spki $($j.spkiSha256.Substring(0, 16))" } else { "$jline" }))
    } else { [void](Add-Result $R $false "attestation document ($($G.attestationPath))" $(if ($att) { "$($att.Status) $($att.Body)" } else { $why })) }
  }
  $g = $null; $why = 'no answer'
  do {
    try { $g = Invoke-TlsRequest '127.0.0.1' $port '/'; $certs[$g.CertB64] = 1; if ($g.Status -eq [int]$a.expect.status -and $g.BodySha256 -eq $a.expect.bodySha256) { break }; $why = "$($g.Status) '$($g.Body)'" }
    catch { $why = $_.Exception.Message }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  $okGet = $g -and $g.Status -eq [int]$a.expect.status -and $g.BodySha256 -eq $a.expect.bodySha256
  $script:served = [ordered]@{ url = "https://127.0.0.1:$port/"; status = $(if ($g) { $g.Status } else { 0 }); body = $(if ($g) { $g.Body } else { '' }); bodySha256 = $(if ($g) { $g.BodySha256 } else { '' }) }
  [void](Add-Result $R $okGet "GET https://127.0.0.1:$port/ answers exactly the pinned bytes" $(if ($okGet) { "$($g.Status) $($g.Body | ConvertTo-Json -Compress) ($($a.expect.bodySha256.Substring(0, 16)))" } else { "$why; want $($a.expect.status) $($a.expect.body | ConvertTo-Json -Compress)" }))
  [void](Add-Result $R ($certs.Count -eq 1) 'every request saw the same certificate' "$($certs.Count) distinct")
}

$loaded = $null; $served = $null; $verdict = $null
try {
  $proc = [System.Diagnostics.Process]::Start($psi)
  $errTask = $proc.StandardError.ReadToEndAsync()                     # drained, or the child blocks on a full pipe
  $hello = Read-Answer $StartSec
  $okReady = ($hello.ready -eq $true) -and ([string]$hello.kernelSha256 -eq $pin[$P.kernel]) -and ([string]$hello.initrdSha256 -eq $pin[$P.initrd])
  [void](Add-Result $R $okReady 'the launcher booted THIS kernel and monitor initrd' $(if ($okReady) { "kernel $($pin[$P.kernel].Substring(0, 16)), initrd $($pin[$P.initrd].Substring(0, 16)); boundary $($hello.boundary | ConvertTo-Json -Compress)" } else { "ready line: $($hello | ConvertTo-Json -Compress)" }))
  if ($okReady) {
    Send-Line "load $($a.name) $bundle"
    $ans = Read-Answer $LoadSec
    if ($ans.PSObject.Properties.Name -contains 'loaded') {
      $loaded = $ans.loaded
      $okApp = [string]$loaded.appSha256 -eq $a.appId
      [void](Add-Result $R $okApp "the monitor's hash of what arrived is the AppID" $(if ($okApp) { "$($a.appId) in partition $($loaded.vmId), relay 127.0.0.1:$($loaded.tcpPort)" } else { "the monitor computed $($loaded.appSha256), the package pins $($a.appId)" }))
      if ($okApp) { Test-Served $loaded $hello }
    } else { [void](Add-Result $R $false 'load' "the launcher refused: $($ans | ConvertTo-Json -Compress)") }
  }
} catch {
  [void](Add-Result $R $false 'smoke' $_.Exception.Message)
} finally {
  if ($proc -and -not $proc.HasExited) {
    try {
      if ($loaded) { Send-Line "destroy $($loaded.id)"; $d = Read-Answer 60; [void](Add-Result $R ($d.PSObject.Properties.Name -contains 'destroyed') 'destroy the partition' ($d | ConvertTo-Json -Compress)) }
      Send-Line 'quit'
      $x = Read-Answer 60
      [void](Add-Result $R ($x.exit -eq $true) 'the launcher exited cleanly' ($x | ConvertTo-Json -Compress))
    } catch { [void](Add-Result $R $false 'teardown' $_.Exception.Message) }
    if (-not $proc.WaitForExit(30000)) { $proc.Kill(); [void](Add-Result $R $false 'teardown' 'the launcher had to be killed (its partitions end with it)') }
  }
  if ($errTask -and $errTask.Wait(5000)) { [System.IO.File]::WriteAllText((Join-Path $runs 'launcher.stderr'), $errTask.Result) }
  [System.IO.File]::WriteAllLines((Join-Path $runs 'transcript.txt'), [string[]]$transcript)
}

$ok = Test-ResultsOk $R
$rec = [ordered]@{
  type = 'enclave-vbslike-package-smoke/1'; manifestSha256 = $ManifestSha256.ToLower(); boot = 'hcs-dev'; ok = $ok; atUtc = $stamp
  app = "$($a.name) $($a.version)"; appId = $a.appId; guestAppId = $(if ($loaded) { [string]$loaded.appSha256 } else { $null })
  vmId = $(if ($loaded) { [string]$loaded.vmId } else { $null }); served = $served; verdict = $verdict
  tier = $M.tier.name; hostExcluded = $false; boundary = $P.boundary
  results = @($R | ForEach-Object { [ordered]@{ ok = $_.Ok; name = $_.Name; detail = $_.Detail } })
}
[System.IO.File]::WriteAllText((Join-Path $runs 'smoke.json'), ($rec | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Write-Results $R
if ($ok) { "SERVED $($a.name) $($a.version) (AppID $($a.appId.Substring(0, 16))) from the package's monitor image on hcs-dev -- tier $($M.tier.name), host NOT excluded. Record: $runs\smoke.json"; exit 0 }
"FAIL smoke. Record: $runs\smoke.json"
exit 1
