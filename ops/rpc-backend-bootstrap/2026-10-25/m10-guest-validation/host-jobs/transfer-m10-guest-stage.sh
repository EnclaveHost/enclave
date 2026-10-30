#!/bin/bash
set -euo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m10-guest-validation/stage-1
F=/home/steven/.local/state/enclave-rpc-production/ssh_config
W=dd9df0ab82e9f8b53a90063808bdd2199b873eafcf037fb6313d4406d4fb49ee
[ "$(sha256sum < "$S/MANIFEST.sha256" | cut -c1-64)" = "$W" ]
(cd "$S" && sha256sum -c --quiet --strict MANIFEST.sha256)
ssh -F "$F" enclave-rpc 'sudo test ! -e /srv/m10-guest-validation && ! getent passwd m10build >/dev/null && sudo install -d -m 0755 /srv/m10-guest-validation/stage && sudo useradd --system --user-group --home-dir /srv/m10-guest-validation --no-create-home --shell /usr/sbin/nologin m10build'
tar -C "$S" -cf - . | ssh -F "$F" enclave-rpc 'sudo tar --no-same-owner -xf - -C /srv/m10-guest-validation/stage'
ssh -F "$F" enclave-rpc "sudo bash /srv/m10-guest-validation/stage/runner/verify-stage.sh /srv/m10-guest-validation/stage $W"
