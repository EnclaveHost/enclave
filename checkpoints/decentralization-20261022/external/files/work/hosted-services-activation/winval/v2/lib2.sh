# Shared by the install-validation round (W2 probe + W9 real install). Only this NEW root and our own task namespace.
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3)
VAL='C:\ProgramData\Enclave\host-services-install-validation-20261021'
VAL_SFTP='/C:/ProgramData/Enclave/host-services-install-validation-20261021'
ps_remote() { local enc; enc=$(printf '%s' "\$ErrorActionPreference='Stop'; \$ProgressPreference='SilentlyContinue'; $1" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)
  ssh -n "${SSHOPT[@]}" minipc powershell -NoProfile -NonInteractive -EncodedCommand "$enc" 2> >(grep -v "post-quantum\|vulnerable to\|may need to be upgraded" >&2) | tr -d '\r'; }
# upload a PS text, verify its sha256 and PARSE it (PS 5.1) on minipc, then run it through a hash-pinned bootstrap as a
# script block (never a script file: the machine execution policy is untouched). $1 local file, $2 timeout s, $3 out.
run_ps() { local f=$1 n; n=$(basename "$1"); local h; h=$(sha256sum "$f" | cut -c1-64)
  scp -q "${SSHOPT[@]}" "$f" "minipc:$VAL_SFTP/harness/$n" 2> >(grep -v "post-quantum\|vulnerable to\|may need" >&2)
  ps_remote "\$f='$VAL\\harness\\$n'; if ((Get-FileHash -Algorithm SHA256 -LiteralPath \$f).Hash.ToLower() -ne '$h') { 'REFUSED: hash'; exit 5 }
\$t=\$null; \$e=\$null; [void][System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText(\$f), [ref]\$t, [ref]\$e)
if (\$e.Count) { foreach (\$x in \$e) { 'PARSE ERROR ' + \$x.Extent.StartLineNumber + ' ' + \$x.Message }; exit 4 }; 'parsed + verified $n $h'" || return $?
  # watchdog: a separate PowerShell holding THIS session's process handle (no PID reuse) ends it after $2 s or above
  # 1 GiB private memory, and exits by itself when the session ends (a harness bug must never eat the host's headroom)
  local wd='$t = Get-Process -Id PIDX; $e = (Get-Date).AddSeconds(SECS); while (-not $t.WaitForExit(2000)) { $t.Refresh(); if ($t.PrivateMemorySize64 -gt 1GB -or (Get-Date) -gt $e) { $t.Kill(); break } }'
  wd=${wd/SECS/$2}
  local boot="\$f='$VAL\\harness\\$n'; if ((Get-FileHash -Algorithm SHA256 -LiteralPath \$f).Hash.ToLower() -ne '$h') { 'REFUSED: hash'; exit 5 }; \$null = Start-Process -FilePath (\$env:SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', ('$wd' -replace 'PIDX', \$PID)) -WindowStyle Hidden; . ([scriptblock]::Create([IO.File]::ReadAllText(\$f)))"
  local enc; enc=$(printf '%s' "$boot" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)
  timeout "$(( $2 + 30 ))" ssh -n "${SSHOPT[@]}" minipc powershell -NoProfile -NonInteractive -EncodedCommand "$enc" 2> >(grep -v "post-quantum\|vulnerable to\|may need to be upgraded\|CLIXML\|<Objs" >&2) | tr -d '\r' > "$3"
  local rc=${PIPESTATUS[0]}; echo "exit $rc ($n)"; return $rc; }
capacity_gate() { # read-only; 16 GiB must stay free after our largest job (1024 MiB); a busy CPU is reported, not worked around
  local cap; cap=$(ps_remote '$os = Get-CimInstance Win32_OperatingSystem; $cpu = Get-CimInstance Win32_Processor
[ordered]@{ at = (Get-Date).ToUniversalTime().ToString("o"); freeMiB = [int]($os.FreePhysicalMemory/1024); commitFreeMiB = [int]($os.FreeVirtualMemory/1024)
 cpuLoadPct = ($cpu | Measure-Object -Property LoadPercentage -Average).Average; pagefileUsedMB = @(Get-CimInstance Win32_PageFileUsage | ForEach-Object CurrentUsage)
 valRootExists = (Test-Path -LiteralPath "C:\ProgramData\Enclave\host-services-install-validation-20261021")
 ourTasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -like "*EnclaveHostServicesInstallValidation-20261021*" -or $_.TaskPath -like "*EnclaveHostServicesInstallValidation-20261021*" } | ForEach-Object { $_.TaskPath + $_.TaskName }) } | ConvertTo-Json -Compress')
  echo "capacity $cap"
  echo "$cap" | python3 -c 'import json,sys; c=json.load(sys.stdin); ok=c["freeMiB"]>=16384+1024 and c["commitFreeMiB"]>=16384+1024 and (c["cpuLoadPct"] or 0)<70; print("capacity", "OK" if ok else "INSUFFICIENT"); sys.exit(0 if ok else 9)'; }
# every task, its state and its action: production must be identical before and after (read-only)
task_snapshot() { ps_remote '@(Get-ScheduledTask | Sort-Object TaskPath, TaskName | ForEach-Object { $_.TaskPath + $_.TaskName + " | " + $_.State + " | " + (@($_.Actions | ForEach-Object { $_.Execute + " " + $_.Arguments }) -join "; ") + " | triggers " + @($_.Triggers).Count })' > "$1"; }
