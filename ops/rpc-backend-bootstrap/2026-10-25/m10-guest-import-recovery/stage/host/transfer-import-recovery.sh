#!/bin/bash
# HOST (root-reviewed; NOT run by Claude): upload the small run-2 repair bundle to a NEW guest stage and run the guest preflight.
# Follows the reviewed transfer-m10-guest-stage.sh (b52eeb0c). The OLD stage, run-1 logs/receipts and caches are not written.
set -euo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m10-guest-import-recovery/bundle
F=/home/steven/.local/state/enclave-rpc-production/ssh_config
W=1864c8526dd9487d5a07a12d311f8d887214fe85eed66eb9d9d8535e126b6d29
D=/srv/m10-guest-validation/stage-import-recovery
[ "$(sha256sum < "$S/MANIFEST.sha256" | cut -c1-64)" = "$W" ]
(cd "$S" && sha256sum -c --quiet --strict MANIFEST.sha256)
ssh -F "$F" enclave-rpc "sudo test ! -e $D && getent passwd m10build >/dev/null && sudo test -d /srv/m10-guest-validation/stage && sudo install -d -m 0755 $D"
tar -C "$S" -cf - . | ssh -F "$F" enclave-rpc "sudo tar --no-same-owner -xf - -C $D"
ssh -F "$F" enclave-rpc "sudo bash $D/runner/verify-stage-2.sh $D $W"
