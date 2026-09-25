# host-read-savedstate.ps1 - the documented host-side path to a guest's memory: save the VM and read
# the saved state.
#
# WHY A SECOND READER. The first one walked the partition worker's committed regions with
# ReadProcessMemory. On the type-16 POSITIVE CONTROL - where the root can map every guest page by
# construction - it found neither the marker nor a canary the guest itself had printed, after 68 MiB
# across 662 regions with a largest region of 8.4 MiB against a 2 GiB guest. Guest RAM is simply not
# in vmwp's enumerable committed regions, so that instrument was measuring nothing. This one uses
# Hyper-V's own documented mechanism instead: Save-VM writes the guest's memory to a .vmrs.
#
# THE CONTROL IS THE POINT, and it is the same discipline as before:
#   - the marker is pushed into the guest THIS run, so a hit cannot be a previous run's bytes;
#   - the canary is a string the GUEST ITSELF printed, so it is certainly resident;
#   - on type 16 the reader MUST find them. If it does not, the reader is broken and nothing it says
#     about type 1 means anything.
#
# AND THE ONE THAT MATTERS FOR TYPE 1: Save-VM may be REFUSED on an isolated VM - OpenHCL declines
# hibernation and servicing there. A REFUSAL IS NOT PROTECTION. It is recorded as REFUSED, and a
# refusal can never be reported as evidence that memory was unreadable, because nothing was read.
#
# It reads and saves. It modifies no guest, injects nothing, bypasses nothing, and touches only the
# canary VM whose id is passed in.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $VmId,
  [Parameter(Mandatory = $true)][string] $Marker,
  [string] $Canary = "MON ready control_port=9000",
  [string] $Label = '',
  [switch] $ResumeAfter
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path C:\Users\claude\vbs-evidence | Out-Null
$script:Log = "C:\Users\claude\vbs-evidence\savedstate-$(Get-Date -Format yyyyMMdd-HHmmss)$(if($Label){"-$Label"}).log"
function Note($m){ "{0} {1}" -f (Get-Date -Format HH:mm:ss), $m | Tee-Object -Append -FilePath $script:Log }

$vm = Get-VM -Id $VmId -ErrorAction SilentlyContinue
if (-not $vm) { throw "no VM with id $VmId" }
$iso = try { (Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemSettingData |
              Where-Object { $_.ConfigurationID -eq $VmId }).GuestStateIsolationType } catch { '?' }
Note "VM $VmId state=$($vm.State) GuestStateIsolationType=$iso"

# 1. SAVE. A refusal here is a refusal, and is reported as one.
$saved = $false
try {
  $t0 = Get-Date
  Save-VM -VM $vm -ErrorAction Stop
  $saved = $true
  Note "Save-VM returned in $([int]((Get-Date)-$t0).TotalMilliseconds) ms; state now $((Get-VM -Id $VmId).State)"
} catch {
  Note "Save-VM REFUSED: $($_.Exception.Message -replace "`r?`n",' ')"
  Note "VERDICT: REFUSED - nothing was read, so this says NOTHING about whether the memory is readable."
  Note "         A refusal to save is not evidence of isolation and must never be reported as any."
  [pscustomobject]@{ vmId=$VmId; isolationType=$iso; verdict='REFUSED'; saved=$false; log=$script:Log } | ConvertTo-Json -Compress
  exit 3
}

# 2. FIND the saved-state file this save just produced.
$root = $vm.ConfigurationLocation
$short = $VmId.Replace('-','')
$files = @(Get-ChildItem -Path $root -Recurse -Include *.vmrs,*.bin,*.vsv -ErrorAction SilentlyContinue |
           Where-Object { $_.LastWriteTime -ge $t0.AddMinutes(-2) })
if (-not $files.Count) { $files = @(Get-ChildItem -Path $root -Recurse -Include *.vmrs,*.bin,*.vsv -ErrorAction SilentlyContinue) }
# WAIT FOR THE FILE TO STOP GROWING. Save-VM RETURNS BEFORE THE SAVED STATE IS FULLY WRITTEN:
# measured, a 2 GiB guest's .VMRS read 165,654,528 bytes moments after Save-VM returned and
# 2,147,512,320 bytes later - and searching the truncated file produced a confident VOID that was
# purely an artifact of reading it too early. Size is polled until it is stable.
foreach ($f in $files) {
  $last = -1; $stableFor = 0
  $dl = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $dl) {
    $now = (Get-Item $f.FullName -ErrorAction SilentlyContinue).Length
    if ($now -eq $last) { $stableFor++ ; if ($stableFor -ge 3) { break } } else { $stableFor = 0 }
    $last = $now
    Start-Sleep -Milliseconds 700
  }
  $f.Refresh()
  Note "saved-state candidate: $($f.FullName) ($((Get-Item $f.FullName).Length) bytes, settled after $([int]((Get-Date)-$t0).TotalSeconds)s)"
}
$files = @($files | ForEach-Object { Get-Item $_.FullName })
if (-not $files.Count) {
  Note "VERDICT: VOID - Save-VM succeeded but no saved-state file was found under $root, so nothing was searched."
  [pscustomobject]@{ vmId=$VmId; isolationType=$iso; verdict='VOID'; saved=$true; scanned=0; log=$script:Log } | ConvertTo-Json -Compress
  exit 3
}

# 3. SEARCH. Streamed with an overlap, so a needle spanning a chunk boundary is still found.
function Find-InFile([string]$path, [byte[]]$needle) {
  $hits = 0
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  try {
    $chunk = 8MB
    $buf = New-Object byte[] ($chunk + $needle.Length)
    $carry = 0
    while ($true) {
      $n = $fs.Read($buf, $carry, $chunk)
      if ($n -le 0) { break }
      $have = $carry + $n
      $i = 0
      while ($i -ge 0 -and $i -le ($have - $needle.Length)) {
        $i = [Array]::IndexOf($buf, $needle[0], $i, $have - $i)
        if ($i -lt 0 -or $i -gt ($have - $needle.Length)) { break }
        $ok = $true
        for ($k = 1; $k -lt $needle.Length; $k++) { if ($buf[$i + $k] -ne $needle[$k]) { $ok = $false; break } }
        if ($ok) { $hits++ }
        $i++
      }
      $carry = [Math]::Min($needle.Length - 1, $have)
      [Array]::Copy($buf, $have - $carry, $buf, 0, $carry)
    }
  } finally { $fs.Dispose() }
  return $hits
}

$mBytes = [Text.Encoding]::ASCII.GetBytes($Marker)
$cBytes = if ($Canary) { [Text.Encoding]::ASCII.GetBytes($Canary) } else { $null }
$mHits = 0; $cHits = 0; $scanned = 0L
foreach ($f in $files) {
  $scanned += $f.Length
  $mHits += Find-InFile $f.FullName $mBytes
  if ($cBytes) { $cHits += Find-InFile $f.FullName $cBytes }
}
Note "bytes searched : $scanned ($([math]::Round($scanned/1MB,1)) MiB) across $($files.Count) file(s)"
Note "marker         : '$Marker' -> $mHits hit(s)"
Note "canary         : '$Canary' -> $cHits hit(s)"

if ($ResumeAfter -and (Get-VM -Id $VmId).State -eq 'Saved') {
  try { Start-VM -VM (Get-VM -Id $VmId) -ErrorAction Stop; Note "resumed; state $((Get-VM -Id $VmId).State)" }
  catch { Note "resume failed: $($_.Exception.Message -replace "`r?`n",' ')" }
}

$verdict =
  if ($scanned -eq 0) { 'VOID' }
  elseif ($mHits -gt 0) { 'MARKER-FOUND' }
  elseif ($cHits -gt 0) { 'CANARY-ONLY' }
  else { 'VOID' }
switch ($verdict) {
  'MARKER-FOUND' { Note "VERDICT: MARKER FOUND in the saved state. The host read this guest's memory." }
  'CANARY-ONLY'  { Note "VERDICT: the canary was found and the marker was not. The reader WORKS; this marker was not resident." }
  'VOID'         { Note "VERDICT: VOID - neither the marker NOR the canary was found in $([math]::Round($scanned/1MB,1)) MiB. A string the guest printed is certainly in its RAM, so this reader is not seeing guest memory. It proves nothing about isolation." }
}
[pscustomobject]@{ vmId=$VmId; isolationType=$iso; verdict=$verdict; saved=$true; files=$files.Count;
                   scanned=$scanned; markerHits=$mHits; canaryHits=$cHits; log=$script:Log } | ConvertTo-Json -Compress
exit $(if ($verdict -eq 'MARKER-FOUND' -or $verdict -eq 'CANARY-ONLY') { 0 } else { 3 })
