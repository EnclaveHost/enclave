#!/bin/bash
# Scan (unchanged scanners) then commit ONLY this task's files; root's live files (admission, plan, preflight, root logs) stay untracked.
set -euo pipefail
cd "$(dirname "$0")"
FILES="attest-control.mjs check-attestation-verdict.py mutants-attest.py ATTESTATION.md .gitignore tests/attest-control.test.mjs tests/test_verdict_check.py commit-attest.sh logs/attest-tests-1.out logs/attest-tests-1.guard.log logs/attest-tests-1.rc logs/attest-tests-2.out logs/attest-tests-2.guard.log logs/attest-tests-2.rc logs/attest-mutants-1.out logs/attest-mutants-1.guard.log logs/attest-mutants-1.rc logs/attest-mutants-2.out logs/attest-mutants-2.guard.log logs/attest-mutants-2.rc logs/attest-mutants-3.out logs/attest-mutants-3.guard.log logs/attest-mutants-3.rc"
CKR=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo
st=$(mktemp -d); for f in $FILES; do mkdir -p "$st/$(dirname $f)"; cp "$f" "$st/$f"; done
cfg=$(mktemp); git -C "$CKR" show HEAD:.gitleaks.toml > "$cfg"
/home/steven/.local/bin/gitleaks dir "$st" --config "$cfg" --no-banner --redact --exit-code 1 --report-format json --report-path /dev/null
find "$st" -type f -print0 | xargs -0 python3 "$CKR/.githooks/scan-crypto-keys.py" --files
python3 - "$st" <<'PY'
import pathlib, sys
OLD = bytes.fromhex('54696e666f696c'); bad = [str(p) for p in pathlib.Path(sys.argv[1]).rglob('*') if p.is_file() and (OLD in p.read_bytes() or OLD.lower() in p.read_bytes())]
assert not bad, bad; print('literal: none')
PY
rm -rf "$st" "$cfg"; echo "[scan] clean"
git add -- $FILES
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "metal0 control: nonce-bound SEV-SNP verification probe for the recipient image ee5df6b8 (source + offline tests; not run live)

attest-control.mjs wraps the existing trusted verifier (verifier/consumer.mjs verifyMetalBox at a6b1378c, 9 module hashes
pinned): our nonce, AMD chain to the pinned ARK, CRL, policy/VMPL, Turin TCB floor, measurement caller-pinned to ee5df6b8 and
re-tied to the reviewed staged image. Public verdict only (raw 0600 gitignored, no chip id); UNAVAILABLE never counted as PASS.
check-attestation-verdict.py is the strict check root runs before keep.py (whose evidence test is a substring). Offline:
6/6 + 21/21, mutants 9/9 killed with a passing control."
git log -1 --format='%H %an <%ae>'
