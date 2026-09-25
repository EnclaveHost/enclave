# tpm-pcr-read.ps1 - the host TPM's SHA-256 PCRs 0-23 and the current SRTM log, through TPM Base Services.
# Used by the trust-root review (evidence/trust-root-2026-09-25.md). Verify with verify/tcglog/tcglog.py replay.
# READ-ONLY: TPM2_PCR_Read (sha256, PCR 0-23) and the current SRTM log, through TPM Base Services.
# Creates no key, extends no PCR, writes nothing to the TPM.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class Tbs {
  [StructLayout(LayoutKind.Sequential)] public struct P2 { public uint version; public uint flags; }
  [DllImport("tbs.dll")] public static extern uint Tbsi_Context_Create(ref P2 p, out IntPtr ctx);
  [DllImport("tbs.dll")] public static extern uint Tbsip_Context_Close(IntPtr ctx);
  [DllImport("tbs.dll")] public static extern uint Tbsip_Submit_Command(IntPtr ctx, uint loc, uint prio, byte[] cmd, uint cmdLen, byte[] res, ref uint resLen);
  [DllImport("tbs.dll")] public static extern uint Tbsi_Get_TCG_Log_Ex(uint logType, byte[] buf, ref uint len);
}
"@
function BE16([int]$v) { [byte[]]@((($v -shr 8) -band 0xff), ($v -band 0xff)) }
function BE32([uint32]$v) { [byte[]]@((($v -shr 24) -band 0xff), (($v -shr 16) -band 0xff), (($v -shr 8) -band 0xff), ($v -band 0xff)) }
function RD16($b, $o) { ([int]$b[$o] -shl 8) -bor $b[$o+1] }
function RD32($b, $o) { ([uint32]$b[$o] -shl 24) -bor ([uint32]$b[$o+1] -shl 16) -bor ([uint32]$b[$o+2] -shl 8) -bor $b[$o+3] }
$p = New-Object Tbs+P2; $p.version = 2; $p.flags = 4      # TBS_CONTEXT_VERSION_TWO, includeTpm20
$ctx = [IntPtr]::Zero
$rc = [Tbs]::Tbsi_Context_Create([ref]$p, [ref]$ctx); if ($rc) { throw ("Tbsi_Context_Create 0x{0:x8}" -f $rc) }
try {
  $want = 0x00FFFFFF; $got = @{}
  for ($round = 0; $round -lt 8 -and $want; $round++) {
    $sel = [byte[]]@(($want -band 0xff), (($want -shr 8) -band 0xff), (($want -shr 16) -band 0xff))
    $body = (BE32 0x0000017E) + (BE32 1) + (BE16 0x000B) + [byte[]]@(3) + $sel
    $cmd = [byte[]]((BE16 0x8001) + (BE32 (10 + $body.Length - 4)) + $body)
    $res = New-Object byte[] 4096; $len = [uint32]$res.Length
    $rc = [Tbs]::Tbsip_Submit_Command($ctx, 0, 200, $cmd, [uint32]$cmd.Length, $res, [ref]$len)
    if ($rc) { throw ("Tbsip_Submit_Command 0x{0:x8}" -f $rc) }
    $trc = RD32 $res 6; if ($trc) { throw ("TPM2_PCR_Read rc 0x{0:x8}" -f $trc) }
    $o = 14; $nsel = RD32 $res $o; $o += 4
    $outMask = 0
    for ($i = 0; $i -lt $nsel; $i++) { $alg = RD16 $res $o; $sz = $res[$o+2]; for ($k = 0; $k -lt $sz; $k++) { $outMask = $outMask -bor ([int]$res[$o+3+$k] -shl (8*$k)) }; $o += 3 + $sz }
    $nd = RD32 $res $o; $o += 4
    $idx = @(0..23 | Where-Object { $outMask -band (1 -shl $_) })
    if ($idx.Count -ne $nd) { throw "PCR_Read returned $nd digests for $($idx.Count) selected PCRs" }
    foreach ($i in $idx) { $dl = RD16 $res $o; $got[$i] = ($res[($o+2)..($o+1+$dl)] | ForEach-Object { $_.ToString('x2') }) -join ''; $o += 2 + $dl }
    $want = $want -band (-bnot $outMask)
    if ($outMask -eq 0) { break }
  }
  foreach ($i in 0..23) { if ($got.ContainsKey($i)) { "PCR{0:d2} sha256 {1}" -f $i, $got[$i] } else { "PCR{0:d2} NOT RETURNED" -f $i } }
} finally { [void][Tbs]::Tbsip_Context_Close($ctx) }
$len = [uint32]0; [void][Tbs]::Tbsi_Get_TCG_Log_Ex(0, $null, [ref]$len)
$buf = New-Object byte[] $len; $rc = [Tbs]::Tbsi_Get_TCG_Log_Ex(0, $buf, [ref]$len)
if ($rc) { throw ("Tbsi_Get_TCG_Log_Ex 0x{0:x8}" -f $rc) }
$out = "C:\Users\claude\vbs-evidence\tcglog-current-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')).bin"
[IO.File]::WriteAllBytes($out, $buf[0..($len-1)])
"current SRTM log: $len bytes -> $out sha256 $((Get-FileHash $out -Algorithm SHA256).Hash.ToLower())"
$mb = Get-ChildItem C:\Windows\Logs\MeasuredBoot\*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1
"MeasuredBoot newest: $($mb.Name) $($mb.Length) bytes sha256 $((Get-FileHash $mb.FullName -Algorithm SHA256).Hash.ToLower())"
"host boot time UTC: $((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('s'))"
