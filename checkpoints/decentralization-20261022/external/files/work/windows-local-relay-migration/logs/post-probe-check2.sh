#!/usr/bin/env bash
# READ-ONLY: SFTP server processes on us-west, counted without matching this command itself; then the parse check again
set -u
cd "$(dirname "$0")/.."; . root/transfer-lib.sh
echo "us-west sftp-server processes: $(_lx us-west "pgrep -c -f '[s]ftp-server' || true")"
echo "minipc sftp-server processes: $(_ps minipc "@(Get-CimInstance Win32_Process -Filter \"Name='sftp-server.exe'\").Count")"
bash root/ps-readonly-checks.sh minipc | grep -E "PARSE-RESULT|OK:|FAIL"; echo "parse-check exit ${PIPESTATUS[0]}"
