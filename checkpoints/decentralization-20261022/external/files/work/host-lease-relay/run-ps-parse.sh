#!/usr/bin/env bash
# READ-ONLY on minipc: PowerShell 5 parses install-lease-relay.ps1 (content streamed on stdin; nothing written or run).
set -eu
cd "$(dirname "$0")"
python3 - <<'PY' | ssh -o BatchMode=yes -o ConnectTimeout=15 minipc powershell -NoProfile -NonInteractive -Command -
import base64
b = base64.b64encode(open("tree/windows/installer/install-lease-relay.ps1", "rb").read()).decode()
print("$ErrorActionPreference='Stop'")
print(f"$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{b}'))")
print("$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($t,[ref]$null,[ref]$e);'parse install-lease-relay.ps1: '+$(if($e.Count){'ERRORS '+(($e|ForEach-Object{$_.Message+' @'+$_.Extent.StartLineNumber})-join ' | ')}else{'ok'})")
PY
