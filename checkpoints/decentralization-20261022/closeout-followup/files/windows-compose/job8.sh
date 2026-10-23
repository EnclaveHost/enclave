#!/usr/bin/env bash
# job8.sh: the repository's own two secret scanners over every composed commit (f58e03ec4..HEAD), as .githooks/pre-push runs
# them: scan-crypto-keys.py --range, then gitleaks git with the commit's .gitleaks.toml. Findings fully redacted.
set -uo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/windows-compose
cd "$HERE/candidate"; export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"
git log --format='%H %an <%ae> / %cn <%ce>' f58e03ec4..HEAD
timeout -k 5 300 python3 .githooks/scan-crypto-keys.py --range f58e03ec4..HEAD; s=$?
cfg=$(mktemp); git show HEAD:.gitleaks.toml > "$cfg"
timeout -k 5 300 /home/steven/.local/bin/gitleaks git . --config "$cfg" --log-opts="f58e03ec4..HEAD" --no-banner --redact --exit-code 1; g=$?; rm -f "$cfg"
echo "[job8] scan-crypto-keys=$s gitleaks=$g"; [ $s -eq 0 ] && [ $g -eq 0 ]
