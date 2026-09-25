# host-read-guest.ps1 - can the ordinary Windows host read this guest's memory?
#
# THE ONLY THING THAT MAKES THIS AN EXPERIMENT is that the SAME reader runs against a type-16
# partition and a type-1 one. Type 16 is IsolationType::None, where the root partition can map every
# guest page by construction, so it is the POSITIVE CONTROL: the reader MUST find the marker there.
# A reader that finds nothing on type 16 is broken, and its silence on type 1 means nothing at all.
# That is the whole reason this script refuses to report a type-1 "not found" as anything on its own.
#
# WHAT IT DOES. Hyper-V's worker process (vmwp.exe) hosts the partition. For a non-isolated VM it
# maps guest RAM into its own address space, so an ordinary host-side ReadProcessMemory over its
# committed regions can see guest pages. This walks those regions and searches for a marker.
#
# WHAT IT IS NOT. It is a READ. It modifies nothing, injects nothing, and bypasses nothing. It is
# the documented host-side observation the boundary claim has to survive, run on our own canary VM.
#
# WHAT A RESULT MEANS, stated so a transcript cannot be read as more:
#   - marker found on type 16      -> the reader works. Nothing about type 1 yet.
#   - marker NOT found on type 16  -> THE READER IS BROKEN. Both runs are void.
#   - marker not found on type 1, with a working reader and comparable bytes scanned
#                                  -> evidence that the root could not read that marker THIS WAY.
#                                     It is not proof of host exclusion: another path may exist,
#                                     and the hypervisor, the root's VTL1, the firmware and physical
#                                     access all remain trusted.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $VmId,      # the partition's GUID
  [Parameter(Mandatory = $true)][string] $Marker,    # ASCII marker pushed into the guest this run
  # A CANARY: a string the GUEST ITSELF printed, so it is certainly resident in guest RAM. It
  # separates the two ways a miss can happen. No canary and no marker means the reader cannot see
  # guest memory at all; canary found and marker missing means the reader works and the marker
  # simply is not there. Without this the first type-16 control was ambiguous and therefore useless.
  [string] $Canary = "MON ready control_port=9000",
  [int] $MaxRegionMiB = 4096,
  [string] $Label = ''
)
$ErrorActionPreference = 'Stop'
function Note($m){ "{0} {1}" -f (Get-Date -Format HH:mm:ss), $m | Tee-Object -Append -FilePath $script:Log }
$script:Log = "C:\Users\claude\vbs-evidence\hostread-$(Get-Date -Format yyyyMMdd-HHmmss)$(if($Label){"-$Label"}).log"
New-Item -ItemType Directory -Force -Path C:\Users\claude\vbs-evidence | Out-Null

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class HR {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(int a, bool i, int p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadProcessMemory(
    IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [StructLayout(LayoutKind.Sequential)] public struct MBI {
    public IntPtr BaseAddress; public IntPtr AllocationBase; public int AllocationProtect;
    public IntPtr RegionSize; public int State; public int Protect; public int Type;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr VirtualQueryEx(
    IntPtr h, IntPtr addr, out MBI mbi, IntPtr len);
}
"@

$vm = Get-VM -Id $VmId -ErrorAction SilentlyContinue
if (-not $vm) { throw "no VM with id $VmId" }
Note "VM $VmId state=$($vm.State) isolation=$(try{(Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemSettingData | Where-Object { $_.ConfigurationID -eq $VmId }).GuestStateIsolationType}catch{'?'})"

# The worker process for THIS partition: vmwp.exe is started with the VM's GUID as its argument.
$wp = Get-CimInstance Win32_Process -Filter "Name='vmwp.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($VmId.ToLower()) }
if (-not $wp) { throw "no vmwp.exe carrying $VmId (the reader has nothing to read; this is NOT a negative result)" }
Note "worker vmwp.exe pid=$($wp.ProcessId)"

# SeDebugPrivilege, or OpenProcess fails on the worker and EVERY run is VOID for a reason that has
# nothing to do with isolation (enclave-53).
try { [Diagnostics.Process]::EnterDebugMode(); Note "debug privilege enabled" }
catch { Note "could not enable the debug privilege: $($_.Exception.Message) - OpenProcess may fail, and that would be a VOID run, not a negative one" }
$PROCESS_VM_READ = 0x0010; $PROCESS_QUERY_INFORMATION = 0x0400
$h = [HR]::OpenProcess($PROCESS_VM_READ -bor $PROCESS_QUERY_INFORMATION, $false, $wp.ProcessId)
if ($h -eq [IntPtr]::Zero) { throw "OpenProcess on pid $($wp.ProcessId) failed: $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message) (the reader could not attach; NOT a negative result)" }

$needle  = [Text.Encoding]::ASCII.GetBytes($Marker)
$canaryText = $Canary
$canaryBytes = if ($Canary) { [Text.Encoding]::ASCII.GetBytes($Canary) } else { $null }
$MEM_COMMIT = 0x1000
$mbiSize = [IntPtr][Runtime.InteropServices.Marshal]::SizeOf([type][HR+MBI])
$addr = [IntPtr]::Zero
$regions = 0; $scanned = 0L; $readFailed = 0; $largest = 0L
$hits = @(); $canaryHits = @()
$byType = @{}
$needles = @{}
try {
  while ($true) {
    $mbi = New-Object HR+MBI
    if ([HR]::VirtualQueryEx($h, $addr, [ref] $mbi, $mbiSize) -eq [IntPtr]::Zero) { break }
    $size = [int64] $mbi.RegionSize
    if ($size -le 0) { break }
    # Every committed region, whatever its Type. The first version also required nothing else, but
    # it is worth saying why Type is not filtered: guest RAM is mapped into the worker rather than
    # privately allocated, so filtering to MEM_PRIVATE would exclude the only thing being looked for.
    if ($mbi.State -eq $MEM_COMMIT -and $size -le ($MaxRegionMiB * 1MB)) {
      $tk = switch ($mbi.Type) { 0x20000 { 'PRIVATE' } 0x40000 { 'MAPPED' } 0x1000000 { 'IMAGE' } default { "0x$('{0:x}' -f $mbi.Type)" } }
      if (-not $byType.ContainsKey($tk)) { $byType[$tk] = @{ n = 0; bytes = [int64]0 } }
      $byType[$tk].n++; $byType[$tk].bytes += $size
      $regions++
      if ($size -gt $largest) { $largest = $size }
      # Chunked, with the needle length overlapped so a marker straddling a chunk is still found.
      $chunk = 4MB; $off = 0L
      while ($off -lt $size) {
        $n = [int][Math]::Min($chunk, $size - $off)
        $buf = New-Object byte[] $n
        $read = [IntPtr]::Zero
        if ([HR]::ReadProcessMemory($h, [IntPtr]([int64]$mbi.BaseAddress + $off), $buf, [IntPtr]$n, [ref] $read)) {
          $got = [int]$read
          $scanned += $got
          foreach ($pair in @(@{ n = $needle; into = 'm' }, @{ n = $canaryBytes; into = 'c' })) {
            $nd = $pair.n
            if ($null -eq $nd -or $nd.Length -eq 0) { continue }
            $idx = 0
            while ($idx -ge 0 -and $idx -le ($got - $nd.Length)) {
              $idx = [Array]::IndexOf($buf, $nd[0], $idx)
              if ($idx -lt 0 -or $idx -gt ($got - $nd.Length)) { break }
              $match = $true
              for ($k = 1; $k -lt $nd.Length; $k++) { if ($buf[$idx + $k] -ne $nd[$k]) { $match = $false; break } }
              if ($match) {
                $at = "0x{0:x}" -f ([int64]$mbi.BaseAddress + $off + $idx)
                if ($pair.into -eq 'm') { $hits += $at } else { $canaryHits += $at }
              }
              $idx++
            }
          }
        } else { $readFailed++ }
        $off += $n - $needle.Length      # overlap
        if ($n -lt $chunk) { break }
      }
    }
    $next = [int64]$mbi.BaseAddress + $size
    if ($next -le [int64]$addr) { break }
    $addr = [IntPtr]$next
  }
} finally { [void][HR]::CloseHandle($h) }

Note "regions scanned : $regions"
Note "bytes read      : $scanned ($([math]::Round($scanned/1MB,1)) MiB); largest region $([math]::Round($largest/1MB,1)) MiB"
Note "regions unread  : $readFailed"
Note "marker          : '$Marker' ($($needle.Length) bytes)"
foreach ($k in ($byType.Keys | Sort-Object)) { Note "  type $k : $($byType[$k].n) regions, $([math]::Round($byType[$k].bytes/1MB,1)) MiB" }
Note "canary          : '$canaryText' -> $($canaryHits.Count) hit(s)"
Note "HITS            : $($hits.Count)$(if($hits.Count){' at ' + (($hits | Select-Object -First 5) -join ', ')})"
if ($scanned -eq 0) { Note "VERDICT: THE READER SCANNED NOTHING. This run is VOID, not a negative result." }
elseif ($hits.Count -gt 0) { Note "VERDICT: MARKER FOUND. The host read it out of the worker's address space." }
elseif ($canaryHits.Count -gt 0) { Note "VERDICT: marker not found, but the CANARY was, after $([math]::Round($scanned/1MB,1)) MiB. The reader can see guest-resident bytes; this marker was not among them." }
else { Note "VERDICT: VOID - neither the marker NOR the canary was found after $([math]::Round($scanned/1MB,1)) MiB. A string the guest itself printed is certainly in guest RAM, so failing to find it means THIS READER CANNOT SEE GUEST MEMORY. It proves nothing about isolation and must not be reported as if it did." }
Note "evidence: $script:Log"
[pscustomobject]@{ vmId=$VmId; pid=$wp.ProcessId; regions=$regions; bytesScanned=$scanned; largestRegion=$largest; unreadRegions=$readFailed; hits=$hits.Count; canaryHits=$canaryHits.Count; log=$script:Log } | ConvertTo-Json -Compress
