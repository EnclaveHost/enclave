#!/bin/bash
# Scan (unchanged scanners) then commit ONLY this task's files; root's live files stay untracked.
set -euo pipefail
cd "$(dirname "$0")"
FILES="verify-recipient-proofkey.mjs tests/recipient-proofkey.test.mjs PROOFKEY.md commit-proofkey.sh logs/proofkey-tests-1.out logs/proofkey-tests-1.guard.log logs/proofkey-tests-1.rc"
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
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "metal0 legacy control: proof-key verification around setProofKey (source + offline tests; not run live)

measured-control-verify does not apply (metal0 runs the legacy control, no /.well-known/enclave-control). Three parts:
A fresh nonce-bound quote via frozen attest-control.mjs; B the supervisor's /t/metal0/v1/attestation proof key + document
bound to the same transport key and measurement (relay-routed, not hardware-bound); C quorum registry row. Status
verified-legacy | pending-registry (exit 2) | rejected | unknown. Tests 5/5."
git log -1 --format='%H %an <%ae>'
