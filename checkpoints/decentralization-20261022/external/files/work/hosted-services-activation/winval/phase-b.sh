#!/bin/bash
# PHASE B (run 2): upload the composed scenario texts, verify their bytes and PARSE them (PowerShell 5.1) on minipc; then run
# each one as -EncodedCommand (no script file is executed, the machine execution policy is untouched), one at a time under
# a local timeout. Then download the run logs and report (read-only) any process or task of ours still present.
set -uo pipefail
cd "$(dirname "$0")"; . ./lib.sh
RES=${RES:-results}; mkdir -p "$RES"
ps_remote "New-Item -ItemType Directory -Path '$VROOT\composed' -Force | Out-Null; 'ok'"
scp -q "${SSHOPT[@]}" composed/*.ps1 "minipc:$VROOT_SFTP/composed/"
echo "== verify + parse the composed texts on minipc"
want=$(cd composed && sha256sum *.ps1 | awk '{printf "%s=%s;", $2, $1}')
ps_remote "
\$want = @{}; foreach (\$kv in '$want'.TrimEnd(';').Split(';')) { \$k, \$v = \$kv.Split('='); \$want[\$k] = \$v }
\$bad = 0
foreach (\$f in Get-ChildItem -LiteralPath '$VROOT\composed' -Filter *.ps1) {
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath \$f.FullName).Hash.ToLower() -ne \$want[\$f.Name]) { 'HASH MISMATCH ' + \$f.Name; \$bad++; continue }
  \$t = \$null; \$e = \$null
  [void][System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText(\$f.FullName), [ref]\$t, [ref]\$e)
  if (\$e.Count) { \$bad++; foreach (\$x in \$e) { 'PARSE ERROR ' + \$f.Name + ':' + \$x.Extent.StartLineNumber + ' ' + \$x.Message } } else { 'parsed + verified ' + \$f.Name }
}
if (\$bad) { exit 4 }
" || { echo "REFUSED: a composed text failed verification or parsing; nothing executed"; exit 4; }
for w in ${SCEN:-w1-serve w3-orphans w2-alloc w1-cpu w5-restart w8-localservice w6-real}; do
  echo "== $w"
  # a tiny bootstrap (cmd.exe caps command lines at 8191 chars): run the composed text ONLY if its sha256 is exactly the
  # verified-and-parsed one; the text runs as a script block, never as a script file (execution policy untouched)
  h=$(sha256sum "composed/$w.ps1" | cut -c1-64)
  boot="\$f='$VROOT\\composed\\$w.ps1'; if ((Get-FileHash -Algorithm SHA256 -LiteralPath \$f).Hash.ToLower() -ne '$h') { 'REFUSED: hash mismatch'; exit 5 }; . ([scriptblock]::Create([IO.File]::ReadAllText(\$f)))"
  enc=$(printf '%s' "$boot" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)
  [ ${#enc} -lt 8000 ] || { echo "bootstrap too long"; exit 6; }
  timeout 420 ssh -n "${SSHOPT[@]}" minipc powershell -NoProfile -NonInteractive -EncodedCommand "$enc" > "$RES/$w.out" 2> "$RES/$w.err"
  rc=$?
  tr -d '\r' < "$RES/$w.out" > "$RES/$w.json"; rm -f "$RES/$w.out"
  echo "exit $rc ($w)"; cat "$RES/$w.json"; grep -v "post-quantum\|vulnerable\|upgraded\|WARNING: connection" "$RES/$w.err" | head -15
done
echo "== download the run logs (evidence)"
rm -rf "$RES/runs"; mkdir -p "$RES/runs"
scp -q -r "${SSHOPT[@]}" "minipc:$VROOT_SFTP/runs/*" "$RES/runs/" && find "$RES/runs" -type f -name '*.log' | sort
echo "== leftovers (read-only): our executables under the validation root"
ps_remote "@(Get-CimInstance Win32_Process | Where-Object { \$_.ExecutablePath -and \$_.ExecutablePath.StartsWith('$VROOT', 'OrdinalIgnoreCase') } | ForEach-Object { '' + \$_.ProcessId + ' ' + \$_.Name }).Count.ToString() + ' process(es) of ours still running'; @(Get-ScheduledTask | Where-Object { \$_.TaskName -like 'EnclaveHostServicesValidation-20261021*' }).Count.ToString() + ' validation task(s)'"
