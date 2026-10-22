#!/usr/bin/env bash
# READ-ONLY on the Windows host, for ROOT (no PowerShell here): streams every staged .ps1 to PowerShell 5.1 as base64 TEXT and
# only PARSES it (System.Management.Automation.Language.Parser); nothing is written, imported, dot-sourced or run.
#   bash ps-parse-check.sh <ssh alias of minipc>
set -eu
HOST=${1:?ssh alias}
cd "$(dirname "$0")/.."
python3 - <<'PY' | ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" powershell -NoProfile -NonInteractive -Command -
import base64, glob, os
print("$ErrorActionPreference='Stop'; $bad=0")
for f in sorted(glob.glob("*.ps1")):
    b = base64.b64encode(open(f, 'rb').read()).decode()
    print(f"$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{b}'));$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($t,[ref]$null,[ref]$e);if($e.Count){$bad++;'{f}: '+($e|ForEach-Object{$_.Message}|Select-Object -First 3) -join '; '}else{'{f}: parses'}")
print("if($bad){'PARSE FAILED'}else{'ALL PARSE'}")
PY
