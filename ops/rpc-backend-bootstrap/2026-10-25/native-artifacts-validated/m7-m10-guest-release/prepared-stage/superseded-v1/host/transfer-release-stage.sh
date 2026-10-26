#!/bin/bash
# HOST (root-reviewed; NOT run by Claude): upload the small release bundle to a NEW guest stage. Follows the reviewed
# transfer-m10-guest-stage.sh (b52eeb0c). Runs NO preflight here (it needs run-2's collected receipt pins; the launcher runs it).
set -euo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m7-m10-combined-release/bundle
F=/home/steven/.local/state/enclave-rpc-production/ssh_config
W=${1:?release bundle MANIFEST.sha256 sha256 (from README)}
D=/srv/m10-guest-validation/stage-release-1
[ "$(sha256sum < "$S/MANIFEST.sha256" | cut -c1-64)" = "$W" ]
(cd "$S" && sha256sum -c --quiet --strict MANIFEST.sha256)
ssh -F "$F" enclave-rpc "sudo test ! -e $D && getent passwd m10build >/dev/null && sudo test -d /srv/m10-guest-validation/stage && sudo install -d -m 0755 $D"
tar -C "$S" -cf - . | ssh -F "$F" enclave-rpc "sudo tar --no-same-owner -xf - -C $D"
ssh -F "$F" enclave-rpc "cd $D && sudo sha256sum -c --quiet --strict MANIFEST.sha256 && echo '## release stage transferred and verified'"
