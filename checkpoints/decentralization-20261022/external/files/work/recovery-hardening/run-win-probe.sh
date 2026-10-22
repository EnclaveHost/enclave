#!/usr/bin/env bash
# Runs win-fsync-probe.mjs on minipc with the host's own node.exe, passed as an argument (nothing is copied to the host;
# the probe makes and removes its own TEMP directory). Read-only with respect to every Enclave file.
set -eu
cd "$(dirname "$0")"
enc=$(python3 - <<'PY'
import base64
code = open("win-fsync-probe.mjs", encoding="utf-8").read()
b64 = base64.b64encode(code.encode("utf-8")).decode()
ps = ("$ErrorActionPreference='Stop';"
      "& 'C:\\Program Files\\Enclave\\runtime\\node\\node.exe' --input-type=module -e \"await import('data:text/javascript;base64," + b64 + "')\"")
print(base64.b64encode(ps.encode("utf-16le")).decode())
PY
)
ssh -o BatchMode=yes -o ConnectTimeout=15 minipc powershell -NoProfile -NonInteractive -EncodedCommand "$enc"
