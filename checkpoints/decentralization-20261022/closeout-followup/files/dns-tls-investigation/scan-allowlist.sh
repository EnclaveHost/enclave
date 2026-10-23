#!/usr/bin/env bash
# the existing scanners on EXACTLY the allowlisted files: .githooks/scan-crypto-keys.py --files, then gitleaks dir with the
# repository's .gitleaks.toml over a staged copy that holds only those files
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/dns-tls-investigation
cd "$H"; mapfile -t F < <(grep -v '^#' ALLOWLIST.txt | sed '/^$/d')
rc=0
echo "=== crypto scan (${#F[@]} files)"; python3 candidate/.githooks/scan-crypto-keys.py --files "${F[@]}"; c=$?; echo "=== crypto exit=$c"; [ $c -ne 0 ] && rc=1
S="$H/tmp/scan-stage"; rm -rf "$S"; mkdir -p "$S"; cp --parents "${F[@]}" "$S/"
echo "=== gitleaks dir"; gitleaks dir --no-banner --config candidate/.gitleaks.toml --report-format json --report-path "$H/logs/allowlist-gitleaks-r2.json" "$S"; g=$?; echo "=== gitleaks exit=$g"; [ $g -ne 0 ] && rc=1
rm -rf "$S"; exit $rc
