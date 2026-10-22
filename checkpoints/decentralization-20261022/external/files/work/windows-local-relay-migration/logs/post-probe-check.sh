#!/usr/bin/env bash
# READ-ONLY: no SFTP server left behind by the probe on either host; the probe directories are gone; then the real parse check
set -u
cd "$(dirname "$0")/.."; . root/transfer-lib.sh
echo "minipc sftp-server processes: $(_ps minipc "@(Get-CimInstance Win32_Process -Filter \"Name='sftp-server.exe'\").Count")"
echo "minipc probe dirs left: $(_ps minipc "@(Get-ChildItem -LiteralPath 'C:\\ProgramData\\Enclave' -Directory -Filter 'claude-transport-probe-*').Count")"
echo "us-west sftp-server processes: $(_lx us-west "pgrep -c -f sftp-server || true")"
echo "us-west probe dirs left: $(_lx us-west "ls -d /root/claude-transport-probe-* 2>/dev/null | wc -l")"
bash root/ps-readonly-checks.sh minipc; echo "parse-check exit $?"
