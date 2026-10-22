#!/usr/bin/env bash
# READ-ONLY on minipc: PowerShell 5 parses every next-version script (content streamed on stdin, nothing written) and shows
# the single-object .Count behaviour behind the 00:06 observer exit, with this probe's OWN process only.
set -eu
cd "$(dirname "$0")"
python3 - <<'PY' | ssh -o BatchMode=yes -o ConnectTimeout=15 minipc powershell -NoProfile -NonInteractive -Command -
import base64, glob, os
print("$ErrorActionPreference='Stop'")
print("$files=@{}")
for f in sorted(glob.glob("scripts/*.ps1")):
    print(f"$files['{os.path.basename(f)}']='{base64.b64encode(open(f, 'rb').read()).decode()}'")
print("foreach($k in ($files.Keys|Sort-Object)){$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($files[$k]));$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($t,[ref]$null,[ref]$e);'parse '+$k+': '+$(if($e.Count){'ERRORS '+(($e|ForEach-Object{$_.Message})-join ' | ')}else{'ok'})}")
print("function OneProc { @(Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)) }")
print("'PS '+$PSVersionTable.PSVersion.ToString()+': (OneProc).Count='+$(if($null -eq (OneProc).Count){'null'}else{(OneProc).Count})+'  @(OneProc).Count='+@(OneProc).Count")
PY
