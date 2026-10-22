#!/bin/bash
# PHASE A (no script execution): create the NEW validation root (refuse if it exists), ACL it, copy node.exe into it,
# upload the exact files by SFTP, verify every sha256 ON minipc, and PARSE every .ps1 with the PowerShell 5.1 parser.
set -euo pipefail
cd "$(dirname "$0")"; . ./lib.sh
echo "== create $VROOT"
ps_remote "
if (Test-Path -LiteralPath '$VROOT') { throw 'refusing: the validation root already exists' }
foreach (\$d in '', 'bin', 'packages', 'fixtures', 'harness', 'stage-scripts', 'node', 'runs') { New-Item -ItemType Directory -Path (Join-Path '$VROOT' \$d) -Force | Out-Null }
& icacls.exe '$VROOT' /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
if (\$LASTEXITCODE -ne 0) { throw 'icacls failed' }
Copy-Item -LiteralPath 'C:\Program Files\nodejs\node.exe' -Destination '$VROOT\node\node.exe'
'created; node copy ' + (Get-FileHash -Algorithm SHA256 -LiteralPath '$VROOT\node\node.exe').Hash.ToLower() + ' ' + (& '$VROOT\node\node.exe' --version)
"
echo "== upload (SFTP)"
for d in bin packages fixtures harness stage-scripts; do scp -q "${SSHOPT[@]}" upload/$d/* "minipc:$VROOT_SFTP/$d/"; done
scp -q -r "${SSHOPT[@]}" upload/runs/* "minipc:$VROOT_SFTP/runs/"
scp -q "${SSHOPT[@]}" upload/MANIFEST.sha256 "minipc:$VROOT_SFTP/MANIFEST.sha256"
echo "== the LOCAL SERVICE scenario's state directory is writable by LOCAL SERVICE (inside our root only)"
ps_remote "& icacls.exe '$VROOT\runs\w8\state' /grant:r '*S-1-5-19:(OI)(CI)M' | Out-Null; if (\$LASTEXITCODE -ne 0) { throw 'icacls w8 failed' }; 'ok'"
echo "== verify every uploaded byte on minipc"
ps_remote "
\$bad = @(); \$n = 0
foreach (\$line in Get-Content -LiteralPath '$VROOT\MANIFEST.sha256') {
  \$h, \$rel = \$line -split '  ', 2; \$n++
  \$f = Join-Path '$VROOT' (\$rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath \$f) -or (Get-FileHash -Algorithm SHA256 -LiteralPath \$f).Hash.ToLower() -ne \$h) { \$bad += \$rel }
}
'verified ' + \$n + ' files; mismatches: ' + (\$bad -join ', ')
if (\$bad.Count) { exit 3 }
"
echo "== PowerShell 5.1 parser on every .ps1 (nothing is executed)"
ps_remote "
\$fail = 0
foreach (\$f in Get-ChildItem -LiteralPath '$VROOT\harness', '$VROOT\stage-scripts' -Filter *.ps1) {
  \$tokens = \$null; \$errors = \$null
  [void][System.Management.Automation.Language.Parser]::ParseFile(\$f.FullName, [ref]\$tokens, [ref]\$errors)
  if (\$errors.Count) { \$fail++; foreach (\$e in \$errors) { 'PARSE ERROR ' + \$f.Name + ':' + \$e.Extent.StartLineNumber + ' ' + \$e.Message } } else { 'parsed ' + \$f.Directory.Name + '\' + \$f.Name }
}
'PSVersion ' + \$PSVersionTable.PSVersion + '; files with parse errors: ' + \$fail
if (\$fail) { exit 4 }
"
