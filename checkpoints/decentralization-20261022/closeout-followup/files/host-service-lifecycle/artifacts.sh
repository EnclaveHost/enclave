#!/usr/bin/env bash
# Scans of the exact commit range, then the JS release artifacts rebuilt from the COMMITTED candidate (offline namespace),
# compared with C's reproducible 427780bb set (windows-host-services-compose/cold/artifacts.sha256). Go is deliberately
# not on PATH: network/build.mjs writes and checks every JS bundle first, then stops at its Go step (Go artifacts change
# with any new commit anyway: they embed vcs.revision).
set -uo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-lifecycle
C=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/windows-host-services-compose/cold/artifacts.sha256
cd "$HERE/candidate"; export TMPDIR="$HERE/tmp/t"
R=427780bbc0fc524f8091893614eae8a653518139..HEAD
git log --format='%H %an <%ae> / %cn <%ce> %s' $R
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo DIRTY; exit 5; }
timeout -k 5 300 python3 .githooks/scan-crypto-keys.py --range $R; s=$?
cfg=$(mktemp); git show HEAD:.gitleaks.toml > "$cfg"
timeout -k 5 300 /home/steven/.local/bin/gitleaks git . --config "$cfg" --log-opts="$R" --no-banner --redact --exit-code 1 --report-format json --report-path "$HERE/gitleaks-range.json"; g=$?; rm -f "$cfg"
echo "[scan] scan-crypto-keys=$s gitleaks=$g"
O="$HERE/tmp/artifacts"; rm -rf "$O" network/host-services/packages; mkdir -p "$O"
export PATH="$HERE/stubs:/usr/bin:/bin"; [ "$(command -v go)" = "$HERE/stubs/go" ] || { echo "go stub not first on PATH"; exit 6; }
timeout -k 10 400 unshare -rn --pid --fork --kill-child --mount-proc sh -c "node relay/build-network.mjs >/dev/null && node scripts/build-host-service-packages.mjs | tail -1 && node scripts/network/build-consumers.mjs '$O/consumers' >/dev/null; node network/build.mjs '$O/dist' >/dev/null 2>'$O/build.err'; echo network/build.mjs exit=\$?"; b=$?
grep -m1 "denied: go" "$O/build.err"
cp network/host-services/packages/* "$O/"; cp relay/network-runtime.bundle.mjs "$O/"; rm -f "$O/build.err"
(cd "$O" && find . -type f ! -name build-manifest.json | sort | xargs sha256sum) > "$HERE/artifacts-24fb993c.sha256"
python3 -I - "$C" "$HERE/artifacts-24fb993c.sha256" <<'PY'
import sys
r = lambda f: {l.split()[1]: l.split()[0] for l in open(f) if l.strip()}
c, n = r(sys.argv[1]), r(sys.argv[2])
for k in sorted(set(c) | set(n)):
    print(('SAME   ' if c.get(k) == n.get(k) else 'CHANGED' if k in c and k in n else 'ONLY-C ' if k in c else 'ONLY-N ') , k, c.get(k, '-')[:8], '->', n.get(k, '-')[:8])
PY
echo "[job] build=$b"; [ $s -eq 0 ] && [ $g -eq 0 ]
