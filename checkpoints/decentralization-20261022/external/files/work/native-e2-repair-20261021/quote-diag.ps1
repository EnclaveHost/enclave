# NO-WRITE native diagnostic for the E2 --eval quoting self-check (work/native-e2-repair-20261021). It writes no file, installs
# nothing, touches no firewall or configuration: it launches node.exe twice with the fixture's own Quote-Arg/Run logic and
# prints ONE RESULT JSON line comparing the OLD parse (@($json | ConvertFrom-Json)) with the FIXED parse.
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File quote-diag.ps1 -NodeExe 'C:\Program Files\nodejs\node.exe' -Probe <probe.mjs>
param([Parameter(Mandatory)][string]$NodeExe, [Parameter(Mandatory)][string]$Probe)
$ErrorActionPreference = 'Stop'
function Quote-Arg([string]$a) {   # byte-identical to the fixture's
  if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { return $a }
  $sb = New-Object System.Text.StringBuilder; [void]$sb.Append('"'); $bs = 0
  foreach ($ch in $a.ToCharArray()) {
    if ($ch -eq [char]92) { $bs++; continue }
    if ($ch -eq [char]34) { [void]$sb.Append([string]::new([char]92, 2 * $bs + 1)); [void]$sb.Append([char]34); $bs = 0; continue }
    if ($bs) { [void]$sb.Append([string]::new([char]92, $bs)); $bs = 0 }
    [void]$sb.Append($ch) }
  [void]$sb.Append([string]::new([char]92, 2 * $bs)); [void]$sb.Append([char]34); return $sb.ToString() }
function RunNode([string[]]$argv) {   # bounded 30 s; stdout+stderr
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $NodeExe; $psi.Arguments = (@($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi); $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit(30000)) { try { $p.Kill() } catch {}; return @{ code = -9; out = 'TIMEOUT' } }
  $p.WaitForExit(); return @{ code = $p.ExitCode; out = ($o.Result + $e.Result) } }
function Sha([string]$t) { $h = [Security.Cryptography.SHA256]::Create(); (-join ($h.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$t)) | ForEach-Object { $_.ToString('x2') })).Substring(0, 16) }
$src = [IO.File]::ReadAllText($Probe)
$want = @('--input-type=module', '--eval', $src, 'probe.mjs', '18001', '18002')
$r = RunNode (@('-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--') + $want)
$old = $null; try { $old = @($r.out | ConvertFrom-Json) } catch {}
$parsed = $null; $new = $null; try { $parsed = ConvertFrom-Json -InputObject $r.out; $new = @(foreach ($el in $parsed) { $el }) } catch {}
$rows = @(); for ($i = 0; $i -lt $want.Count; $i++) {
  $g = if ($null -ne $new -and $i -lt $new.Count) { [string]$new[$i] } else { $null }
  $rows += [ordered]@{ i = $i; wantLen = $want[$i].Length; gotLen = $(if ($null -eq $g) { -1 } else { $g.Length }); wantSha = (Sha $want[$i]); gotSha = $(if ($null -eq $g) { '' } else { Sha $g })
    equal = [string]::Equals($g, $want[$i], [StringComparison]::Ordinal) } }
$o = [ordered]@{ psVersion = $PSVersionTable.PSVersion.ToString(); nodeExit = $r.code; outLen = $r.out.Length; wantCount = $want.Count
  oldParseCount = $(if ($null -eq $old) { 'null' } else { $old.Count }); oldElem0Type = $(if ($null -ne $old -and $old.Count) { $old[0].GetType().FullName } else { 'none' })
  parsedType = $(if ($null -eq $parsed) { 'null' } else { $parsed.GetType().FullName }); newParseCount = $(if ($null -eq $new) { 'null' } else { $new.Count })
  allEqual = (@($rows | Where-Object { -not $_.equal }).Count -eq 0) -and ($null -ne $new) -and ($new.Count -eq $want.Count); rows = $rows }
'RESULT ' + ($o | ConvertTo-Json -Compress -Depth 4)
