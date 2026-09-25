# tpm-quote-run.ps1 - ONE session of the node's own TPM helper (windows/node/tpmattest.c at a80c919e) for a
# verifier-driven quote. What the helper does to the TPM, from its source:
#   - CreatePrimary of a restricted RSA-2048 signing key in the NULL hierarchy (transient, never persisted);
#   - for activation, CreatePrimary of the TCG-template EK under the endorsement hierarchy (transient), a
#     PolicySecret session, ActivateCredential; both flushed;
#   - Quote of SHA-256 PCRs 0,7,12,13,14 with the verifier's nonce as extraData; PCR_Read; FlushContext at quit.
#   No EvictControl, no Clear, no hierarchy/auth change, no NV write. It reads Windows' endorsement authorization
#   through Tbsi_Get_OwnerAuth, in process only, to authorize the EK; it prints only its length.
# If this process is killed, TPM Base Services closes the context and flushes its transient objects.
# The VERIFIER's inputs (MakeCredential blob/secret and a fresh nonce) arrive as in.txt, written by
# verify/tpmquote/quote-verify.mjs on another machine after it has read keys.txt.
param([Parameter(Mandatory = $true)][string] $Stamp, [int] $WaitSeconds = 240)
$ErrorActionPreference = 'Stop'
$D = "C:\Users\claude\vbs-evidence\quote-$Stamp"
New-Item -ItemType Directory -Force -Path $D | Out-Null
$exe = 'C:\Users\claude\vbs\node\tpmattest.exe'
function Meta($m) { Add-Content -Path "$D\meta.txt" -Value ("{0} {1}" -f (Get-Date).ToUniversalTime().ToString('HH:mm:ss'), $m) }
Meta "tpmattest $exe sha256 $((Get-FileHash $exe -Algorithm SHA256).Hash.ToLower())"
Meta "host boot UTC $((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('s'))"
$psi = New-Object System.Diagnostics.ProcessStartInfo $exe
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)
$errTask = $p.StandardError.ReadToEndAsync()
$deadline = (Get-Date).AddSeconds($WaitSeconds)
function ReadReply([string]$file) {
  while ((Get-Date) -lt $deadline) {
    $t = $p.StandardOutput.ReadLineAsync()
    if (-not $t.Wait(60000)) { throw "no reply from tpmattest within 60 s" }
    $l = $t.Result
    if ($null -eq $l) { throw "tpmattest closed its output" }
    Add-Content -Path $file -Value $l
    if ($l -eq 'ok' -or $l.StartsWith('err') -or $l.StartsWith('ready ')) { return $l }
  }
  throw "deadline"
}
function Send([string]$line, [string]$file) { $p.StandardInput.WriteLine($line); $p.StandardInput.Flush(); ReadReply $file }
try {
  Meta "started pid $($p.Id)"
  $r = ReadReply "$D\ready.txt";   Meta "startup: $r"; if (-not $r.StartsWith('ready ')) { throw "helper did not start: $r" }
  $r = Send 'keys' "$D\keys.txt";  Meta "keys: $r";    if ($r -ne 'ok') { throw "keys: $r" }
  $in = "$D\in.txt"
  while (-not (Test-Path $in) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Path $in)) { throw "the verifier never supplied in.txt" }
  Start-Sleep -Milliseconds 500
  $kv = @{}; foreach ($l in Get-Content $in) { $a = $l -split '=', 2; if ($a.Count -eq 2) { $kv[$a[0].Trim()] = $a[1].Trim() } }
  foreach ($k in 'blob', 'secret', 'nonce') { if (-not ($kv[$k] -match '^[0-9a-f]+$')) { throw "in.txt: $k missing or not hex" } }
  Meta "verifier input received (nonce $($kv.nonce.Substring(0,16))...)"
  $r = Send "activate $($kv.blob) $($kv.secret)" "$D\activate.txt"; Meta "activate: $r"
  $r = Send "quote $($kv.nonce)" "$D\quote.txt";                     Meta "quote: $r"
  $r = Send 'pcr 0' "$D\pcr0.txt";                                    Meta "pcr 0: $r"
  $r = Send 'log' "$D\log.txt";                                       Meta "log: $r"
  $lp = ((Get-Content "$D\log.txt") | Where-Object { $_ -like 'log *' } | Select-Object -First 1) -replace '^log ', ''
  if ($lp -and (Test-Path $lp)) { Copy-Item $lp "$D\measuredboot.log" -Force; Meta "copied $lp sha256 $((Get-FileHash "$D\measuredboot.log" -Algorithm SHA256).Hash.ToLower())" }
  $r = Send 'quit' "$D\quit.txt"; Meta "quit: $r"
  if (-not $p.WaitForExit(15000)) { throw "tpmattest did not exit after quit" }
  Meta "exit code $($p.ExitCode) (the helper flushes its attestation key at quit)"
} catch {
  Meta "RUN FAILED: $($_.Exception.Message)"
} finally {
  if (-not $p.HasExited) { $p.Kill(); [void]$p.WaitForExit(5000); Meta "KILLED: TPM Base Services closed the context, which flushes its transient objects" }
  try { Set-Content -Path "$D\stderr.txt" -Value $errTask.Result } catch { }
  Meta "running helpers now: $(@(Get-Process tpmattest -EA SilentlyContinue).Count)"
  Meta "DONE"
}
