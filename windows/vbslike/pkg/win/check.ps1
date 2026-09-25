# check.ps1 -- is this package what the commit says, and can this host boot it? (windows/vbslike/pkg/README.md)
#
#   check.ps1 -ManifestSha256 <64 hex>                      the package + each profile's host readiness (read-only)
#   check.ps1 -ManifestSha256 <id> -Require igvm            ... and exit 3 unless that profile's host is ready
#   check.ps1 -ManifestSha256 <id> -Fetch                   ... and fetch each servable app's component by CID with
#                                                           the package's own fetcher, into <pkg>\fetched\
#   check.ps1 -ManifestSha256 <id> -Phase serve -Boot <hcs-dev|igvm> -Url https://127.0.0.1:<port>/ -LoadJson <file|json>
#                                                           an app some launcher served: its AppID as the GUEST computed
#                                                           it, and its answer, against the manifest
#   check.ps1 -ManifestSha256 <id> -SelfTest                the checks themselves must FAIL on a tampered copy
#   check.ps1 -ManifestSha256 <id> -ManagerDir C:\Users\claude\vbs\manager
#                                                           ... and ask the manager actually being run the igvm question
#
# Writes only under this package directory (fetched\, runs\, .selftest\). Exit: 0 ok, 1 FAIL, 3 a -Require'd profile
# is BLOCKED by its host. BLOCKED is never a package failure: the package can be right while the host is not ready.
# HOST CHECKS PASS is only what these read-only checks see: whether a profile BOOTS is shown by running it, not here.
param(
  [Parameter(Mandatory = $true)][string]$ManifestSha256,
  [ValidateSet('package', 'serve')][string]$Phase = 'package',
  [ValidateSet('', 'hcs-dev', 'igvm', 'uefi')][string]$Require = '',
  [ValidateSet('', 'hcs-dev', 'igvm')][string]$Boot = '',
  [string]$App = 'hello-world',
  [string]$Url = '',
  [string]$LoadJson = '',
  [switch]$Fetch,
  [switch]$SelfTest,
  [string]$ManagerDir = '',          # also ask a manager OUTSIDE the package (e.g. the one being run) the igvm question
  [string]$Dir = ''                 # default: the package directory this script sits in
)
$ErrorActionPreference = 'Stop'
# $PSScriptRoot is empty in a param() default under Windows PowerShell 5.1 -File, so it is read here
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'pkg.lib.ps1')
if (-not $Dir) { $Dir = Split-Path -Parent $here }
$Dir = Resolve-PkgDir $Dir
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')

# ---- -SelfTest: every check below must be able to say FAIL ----------------------------------------------------------
if ($SelfTest) {
  $root = Join-Path $Dir ".selftest\$stamp"
  $cases = New-Object System.Collections.ArrayList
  function Case([string]$Name, [bool]$WantOk, $Rows) {
    $got = Test-ResultsOk $Rows
    [void]$cases.Add([pscustomobject]@{ Name = $Name; Pass = ($got -eq $WantOk); Want = $WantOk; Got = $got })
  }
  try {
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $a = Join-Path $root 'a.txt'; [System.IO.File]::WriteAllText($a, 'enclave-vbslike-package selftest')
    $M1 = [pscustomobject]@{ files = @([pscustomobject]@{ path = 'a.txt'; sha256 = (Get-Sha256 $a) }) }
    $r = New-Results; Test-PkgFiles $r $root $M1; Case 'control: the file as pinned' $true $r
    [System.IO.File]::WriteAllText($a, 'enclave-vbslike-package selftesT')
    $r = New-Results; Test-PkgFiles $r $root $M1; Case 'one byte changed' $false $r
    Remove-Item -LiteralPath $a
    $r = New-Results; Test-PkgFiles $r $root $M1; Case 'the file removed' $false $r
    [System.IO.File]::WriteAllText($a, 'enclave-vbslike-package selftest')
    [System.IO.File]::WriteAllText((Join-Path $root 'b.txt'), 'x')
    $r = New-Results; Test-PkgFiles $r $root $M1; Case 'a file the manifest does not name' $false $r
    Remove-Item -LiteralPath (Join-Path $root 'b.txt')
    $M2 = [pscustomobject]@{ files = @([pscustomobject]@{ path = '../a.txt'; sha256 = $M1.files[0].sha256 }) }
    $r = New-Results; Test-PkgFiles $r $root $M2; Case 'a path that leaves the package' $false $r
    $r = New-Results; Test-VmWorkerRead $r $a 'a.txt'; Case 'no grant for the VM worker' $false $r
    & icacls.exe $a /grant "*$($script:VmWorkerSid):(R)" | Out-Null
    $r = New-Results; Test-VmWorkerRead $r $a 'a.txt'; Case 'after the grant' $true $r
    $r = New-Results; [void](Read-PkgManifest $r $Dir ('0' * 64)); Case 'another manifest id' $false $r
    $r = New-Results; [void](Read-PkgManifest $r $Dir $ManifestSha256); Case 'control: this manifest id' $true $r
    # a blank guest-state master the manifest pins as a box file: each corruption refused for its own reason
    $Ms = Read-PkgManifest (New-Results) $Dir $ManifestSha256
    $bvs = @()
    if ($Ms -and ($Ms.hostChecks.PSObject.Properties.Name -contains 'vbsLinux') -and ($Ms.hostChecks.vbsLinux.PSObject.Properties.Name -contains 'boxFiles')) {
      $bvs = @($Ms.hostChecks.vbsLinux.boxFiles | Where-Object { @($_.PSObject.Properties.Name) -contains 'blankVmgs' }) }
    foreach ($bv in $bvs) {
      if (-not (Test-Path -LiteralPath $bv.path -PathType Leaf)) {
        [void]$cases.Add([pscustomobject]@{ Name = "box file $($bv.name): the master to copy"; Pass = $false; Want = 'present'; Got = "absent at $($bv.path)" }); continue }
      $vr = Join-Path $root 'vmgs'; New-Item -ItemType Directory -Force -Path $vr | Out-Null
      foreach ($c in (Invoke-BlankVmgsSelfTest $vr $bv.path $bv.blankVmgs $bv.sha256)) {
        [void]$cases.Add([pscustomobject]@{ Name = "box file $($bv.name) $($c.Name)"; Pass = $c.Pass; Want = $c.Want; Got = $c.Got }) }
    }
  } finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    # and .selftest itself once nothing is left in it: a staged package keeps no empty directory from a self-test
    $st = Split-Path -Parent $root
    if ((Test-Path -LiteralPath $st) -and -not @(Get-ChildItem -LiteralPath $st -Force -ErrorAction SilentlyContinue).Count) { Remove-Item -LiteralPath $st -Force -ErrorAction SilentlyContinue }
  }
  foreach ($c in $cases) {
    $w = if ($c.Want -is [bool]) { "ok=$($c.Want)" } else { [string]$c.Want }; $g = if ($c.Got -is [bool]) { "ok=$($c.Got)" } else { [string]$c.Got }
    "{0} {1} (want {2}, got {3})" -f $(if ($c.Pass) { 'ok  ' } else { 'FAIL' }), $c.Name, $w, $g }
  $bad = @($cases | Where-Object { -not $_.Pass }).Count
  if ($bad -eq 0) { "SELFTEST PASS $($cases.Count)/$($cases.Count)"; exit 0 }
  "SELFTEST FAIL $bad of $($cases.Count)"; exit 1
}

$R = New-Results
$M = Read-PkgManifest $R $Dir $ManifestSha256
if (-not $M) { Write-Results $R; 'FAIL check: the manifest is not the one named'; exit 1 }
Test-PkgFiles $R $Dir $M
Test-NpmTree $R $Dir $M
# the rollback version's staged files (from v39), hashed read-only and reported: a missing or changed one is BLOCKED, never
# a failure of THIS package
if ($M.PSObject.Properties.Name -contains 'rollback') {
  $rb = $M.rollback
  foreach ($f in @($rb.files)) {
    $p = Join-Path $rb.stagedAt ($f.path -replace '/', '\')
    $h = $null; if (Test-Path -LiteralPath $p -PathType Leaf) { $h = Get-Sha256 $p }
    $ok = ($null -ne $h) -and ($h -eq $f.sha256)
    [void](Add-Result $R $ok "rollback to v$($rb.version): $($f.path)" $(if ($ok) { "$p sha256 $h" } elseif ($null -eq $h) { "absent at $p" } else { "$p hashes $h, not $($f.sha256)" }) 'blocked')
  }
}
foreach ($p in @($M.vmWorkerRead)) { Test-VmWorkerRead $R (Get-PkgFilePath $Dir $p) $p }
$tier = $M.tier
if ($M.profiles.igvm.PSObject.Properties.Name -contains 'manager') {
  $pm = Split-Path -Parent (Get-PkgFilePath $Dir $M.control.manager)
  Test-ManagerCreatesIsolated $R $Dir $M $pm "[igvm] the package's manager creates its VM with a guest-state isolation type"
  if ($ManagerDir) {
    Test-ManagerCreatesIsolated $R $Dir $M $ManagerDir "[igvm] the manager at $ManagerDir creates its VM with a guest-state isolation type"
    foreach ($f in @($M.files | Where-Object { $_.role -eq 'control.manager' })) {
      $other = Join-Path $ManagerDir (Split-Path -Leaf ($f.path -replace '/', '\'))
      $h = if (Test-Path -LiteralPath $other) { Get-Sha256 $other } else { 'absent' }
      [void](Add-Result $R $true "manager at $ManagerDir\$(Split-Path -Leaf ($f.path -replace '/', '\'))" $(if ($h -eq $f.sha256) { 'the package''s bytes' } else { "differs from the package ($h)" }) 'info')
    }
  }
}
[void](Add-Result $R ($tier.name -eq 'T0-hv' -and $tier.hostExcluded -eq $false -and $tier.snp -eq $false) 'tier' "$($tier.name): host NOT excluded, no SNP, no VMPL" 'info')

# ---- serve: an answer tied to these bytes -----------------------------------------------------------------------------
if ($Phase -eq 'serve') {
  $a = Get-PkgApp $M $App
  if (-not $a) { [void](Add-Result $R $false "app $App" 'not in this package') }
  elseif (-not $a.servable) { [void](Add-Result $R $false "app $App" "not servable in this package: $($a.blockedOn)") }
  elseif (-not $Boot) { [void](Add-Result $R $false 'serve' '-Boot hcs-dev|igvm: which profile served it') }
  else {
    $slot = @($M.slots | Where-Object { $_.role -eq 'control.datapath' })[0]
    if ($Boot -eq 'igvm' -and $slot -and $slot.state -ne 'pinned') {
      [void](Add-Result $R $false 'serve on igvm' "this package has no datapath (slot control.datapath is $($slot.state), owner $($slot.owner)): nothing here can load a bundle into an IGVM guest" 'blocked')
    } else {
      $lj = $LoadJson
      if ($lj -and (Test-Path -LiteralPath $lj)) { $lj = [System.IO.File]::ReadAllText($lj) }
      $load = $null; if ($lj) { try { $load = $lj | ConvertFrom-Json } catch { $load = $null } }
      $guestApp = $null
      if ($load -and ($load.PSObject.Properties.Name -contains 'loaded')) { $guestApp = [string]$load.loaded.appSha256 }
      elseif ($load -and ($load.PSObject.Properties.Name -contains 'appSha256')) { $guestApp = [string]$load.appSha256 }
      [void](Add-Result $R ($guestApp -eq $a.appId) "the guest computed this app's AppID" $(if ($guestApp -eq $a.appId) { $a.appId } elseif ($guestApp) { "the guest computed $guestApp, the package pins $($a.appId)" } else { '-LoadJson carries no loaded.appSha256: without the guest''s own hash nothing ties the answer to these bytes' }))
      if (-not $Url) { [void](Add-Result $R $false 'serve' '-Url: where the app answers') }
      else {
        $runs = Join-Path $Dir "runs\serve-$stamp"; New-Item -ItemType Directory -Force -Path $runs | Out-Null
        $g = Invoke-PkgGet $Url (Join-Path $runs 'body')
        $ok = $g.Status -eq [int]$a.expect.status -and $g.BodySha256 -eq $a.expect.bodySha256
        [void](Add-Result $R $ok "GET $Url answers exactly the pinned bytes" $(if ($ok) { "$($g.Status) $($g.Body | ConvertTo-Json -Compress)" } else { "got $($g.Status) $($g.Body | ConvertTo-Json -Compress) (curl exit $($g.Exit)), want $($a.expect.status) $($a.expect.body | ConvertTo-Json -Compress)" }))
        $rec = [ordered]@{ type = 'enclave-vbslike-package-serve/1'; manifestSha256 = $ManifestSha256.ToLower(); boot = $Boot; app = "$($a.name) $($a.version)"
                           appId = $a.appId; guestAppId = $guestApp; url = $Url; status = $g.Status; body = $g.Body; bodySha256 = $g.BodySha256; atUtc = $stamp; tier = $M.tier.name; hostExcluded = $false }
        [System.IO.File]::WriteAllText((Join-Path $runs 'serve.json'), ($rec | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
      }
    }
  }
  Write-Results $R
  if (Test-ResultsOk $R) { "SERVED $App ($($a.version), AppID $($a.appId.Substring(0, 16))) on $Boot at $Url -- tier $($M.tier.name), host NOT excluded"; exit 0 }
  'FAIL serve'; exit 1
}

# ---- package: fetch (optional), host readiness, and what to run ---------------------------------------------------------
if ($Fetch) {
  $fetcher = Get-PkgFilePath $Dir $M.control.fetcher
  $out = Join-Path $Dir 'fetched'; New-Item -ItemType Directory -Force -Path $out | Out-Null
  foreach ($a in @($M.apps | Where-Object { $_.servable })) {
    $dst = Join-Path $out "$($a.cid).wasm"
    # -B: write no bytecode. Without it Python leaves __pycache__\ipfs_fetch.*.pyc inside the package, and the next check
    # (correctly) fails the package for a file the manifest does not name.
    $line = & python -B $fetcher $a.cid $dst 2>&1 | Select-Object -Last 1
    $ok = ($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath $dst) -and ((Get-Sha256 $dst) -eq $a.componentSha256)
    [void](Add-Result $R $ok "fetch $($a.name) $($a.version) by CID with the package's fetcher" $(if ($ok) { "$line" } else { "exit $LASTEXITCODE`: $line" }))
  }
}
$ready = @{}
$profiles = @($M.hostChecks.PSObject.Properties.Name)   # every profile the manifest states host checks for
foreach ($p in $profiles) { $ready[$p] = Test-HostProfile $R $M $p }
$task = Get-ScheduledTask -TaskName EnclaveWindowsNode -ErrorAction SilentlyContinue
[void](Add-Result $R $true 'live node (not touched by this package)' $(if ($task) { "EnclaveWindowsNode $($task.State)" } else { 'no EnclaveWindowsNode task' }) 'info')
Write-Results $R

$pkgOk = Test-ResultsOk $R
if (-not $pkgOk) { 'FAIL package: see the FAIL lines'; exit 1 }
"PACKAGE OK $($M.name) v$($M.version) $($ManifestSha256.ToLower())"
foreach ($p in $profiles) {
  $pr = $M.profiles.$p
  # host checks passing is what this script can see; it is not a boot, which only the box owner's run shows
  # name what blocks it: a profile line that only restated what the profile needs read as if all of it were missing
  $blockers = @($R | Where-Object { $_.Kind -eq 'blocked' -and -not $_.Ok -and $_.Name.StartsWith("[$p] ") } | ForEach-Object { $_.Name.Substring($p.Length + 3) })
  if ($ready[$p]) { "PROFILE $p HOST CHECKS PASS -- $($pr.status)" } else { "PROFILE $p BLOCKED by $($blockers -join ', ') -- $($pr.status)" }
}
$d = $Dir
''
'# igvm profile: the manager, pinned to this package (run after the Hyper-V role is enabled; see README)'
"`$env:ENCLAVE_GUEST_IGVM        = '$(Get-PkgFilePath $d $M.profiles.igvm.image)'"
"`$env:ENCLAVE_GUEST_IGVM_SHA256 = '$(@($M.files | Where-Object { $_.path -eq $M.profiles.igvm.image })[0].sha256)'"
# the runtime IDENTITY (the image's runtime.json), never a hash: from 72c82fc6 main.mjs derives the RuntimeID from it,
# and refuses to start when only ENCLAVE_RUNTIME_ID is set (a hash cannot pin a runtime field by field)
"`$env:ENCLAVE_RUNTIME_IDENTITY  = '$(Get-PkgFilePath $d $M.runtime.file)'   # RuntimeID $($M.runtime.runtimeId)"
"`$env:ENCLAVE_CID_FETCHER       = '$(Get-PkgFilePath $d $M.control.fetcher)'"
"node $(Get-PkgFilePath $d $M.control.manager)"
if (($M.profiles.PSObject.Properties.Name -contains 'vbsLinux') -and ($M.profiles.vbsLinux.PSObject.Properties.Name -contains 'managerEnv')) {
  # the manager of this package's control tree, with the environment the box acceptance starts it with (<...> = fill in)
  $bf = @(); if (($M.hostChecks.PSObject.Properties.Name -contains 'vbsLinux') -and ($M.hostChecks.vbsLinux.PSObject.Properties.Name -contains 'boxFiles')) { $bf = @($M.hostChecks.vbsLinux.boxFiles) }
  ''
  '# vbsLinux profile: the manager, pinned to this package (box files are hash-checked above and again by the launcher)'
  foreach ($e in @($M.profiles.vbsLinux.managerEnv)) {
    $k = @($e.PSObject.Properties.Name)
    $val = ''
    if ($k -contains 'value') { $val = [string]$e.value }
    if ($k -contains 'file') { $val = Get-PkgFilePath $d $e.file }
    if ($k -contains 'dir') { $val = Get-PkgFilePath $d $e.dir }
    if ($k -contains 'sha256Of') { $val = [string](@($M.files | Where-Object { $_.path -eq $e.sha256Of })[0].sha256) }
    if ($k -contains 'boxFile') { $val = [string](@($bf | Where-Object { $_.name -eq $e.boxFile })[0].path) }
    if ($k -contains 'boxFileSha256') { $val = [string](@($bf | Where-Object { $_.name -eq $e.boxFileSha256 })[0].sha256) }
    $c = ''; if ($k -contains 'note') { $c = "   # $($e.note)" }
    "`$env:$($e.name) = '$val'$c"
  }
  "node $(Get-PkgFilePath $d $M.control.manager)"
}
''
'# hcs-dev profile: boot the same monitor image and serve the first app, end to end (development path, host NOT excluded)'
"powershell -NoProfile -ExecutionPolicy Bypass -File $d\win\smoke-hcs.ps1 -ManifestSha256 $($ManifestSha256.ToLower())"
if ($M.PSObject.Properties.Name -contains 'acceptance') {
  $a = $M.acceptance
  ''
  '# the box acceptance run (enclave-5d''s harness against the running manager; it creates and retires ONE instance, and refuses'
  '# if the manager already holds one). Run by the box owner. Fill in the manager port, the data-plane port and the launcher key:'
  "`$env:HVACC_NODE_TREE    = '$(Get-PkgFilePath $d $a.nodeTree)'"
  "`$env:HVACC_JUDGE        = '$(Get-PkgFilePath $d $a.judge)'"
  "`$env:HVACC_RUNTIME      = '$(Get-PkgFilePath $d $M.runtime.file)'"
  "`$env:HVACC_PYTHON       = 'python'"
  "`$env:HVACC_MANAGER      = 'http://127.0.0.1:<manager port>'"
  "`$env:HVACC_DATA         = '127.0.0.1:<ENCLAVE_DATAPLANE_PORT>'"
  "`$env:HVACC_LAUNCHER_KEY = '<the launcher''s report key, as the report''s launcher.key carries it>'"
  "node $(Get-PkgFilePath $d $a.harness)"
}
if ($M.profiles.PSObject.Properties.Name -contains 'uefi') {
  $u = $M.profiles.uefi
  ''
  '# uefi profile (DEV boot, host exclusion NOT established): the files enclave-d1''s VM definition points at'
  "firmware (FirmwareFile): $(Get-PkgFilePath $d $u.firmware)"
  "boot medium (Gen2 SCSI DVD, read-only): $(Get-PkgFilePath $d $u.medium)"
  "fallback medium (Gen2 SCSI disk): $(Get-PkgFilePath $d $u.fallbackMedium)"
}
if ($M.profiles.PSObject.Properties.Name -contains 'vbs') {
  $v = $M.profiles.vbs
  ''
  '# vbs profile (GuestStateIsolationType 1, an EXPERIMENT until enclave-d1''s evidence says what it did): the files its VM definition points at'
  "firmware (FirmwareFile, the cvm build): $(Get-PkgFilePath $d $v.firmware)"
  "boot medium (the PRODUCTION medium, read-only): $(Get-PkgFilePath $d $v.medium)"
  "PROBE medium (NOT production; never serves an app): $(Get-PkgFilePath $d $v.probeMedium)"
  if ($v.measuredVtl0Candidate -and $v.measuredVtl0Candidate.file -and @($M.files | Where-Object { $_.path -eq $v.measuredVtl0Candidate.file }).Count) {
    "measured-VTL0 candidate (FirmwareFile for a -LinuxDirect run; not booted when pinned): $(Get-PkgFilePath $d $v.measuredVtl0Candidate.file)"
    "  its DEBUG TWIN (TRUSTS THE HOST COMMAND LINE; diagnosis only, never serving): $(Get-PkgFilePath $d $v.measuredVtl0Candidate.debugTwinFile)"
  }
}
if ($Require -and -not $ready[$Require]) { "REQUIRED PROFILE $Require IS BLOCKED"; exit 3 }
exit 0
