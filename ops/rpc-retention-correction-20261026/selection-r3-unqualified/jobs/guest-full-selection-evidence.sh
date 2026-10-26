#!/bin/bash
# base-retention-stage/selection-r3: READ-ONLY full-selection evidence, ROOT inside the RPC guest, ONLY after enclave-base-retention.service
# has exited (the verifier itself refuses while it runs). Installs nothing, changes no unit, marker, guard or datadir file.
#   copy this stage's verify_full_selection.py, cached_download_preflight.py and SHA256SUMS to a root-owned temp dir in the guest, then:
#   bash guest-full-selection-evidence.sh /path/to/that/dir > /root/retention-full-selection-evidence.json
set -uo pipefail
export PATH=/usr/bin:/bin
D=${1:?usage: guest-full-selection-evidence.sh STAGE_COPY_DIR}
[ "$(id -u)" = 0 ] || { echo "root only" >&2; exit 2; }
(cd "$D" && grep -E ' (\./)?(verify_full_selection|cached_download_preflight)\.py$' SHA256SUMS | sha256sum -c --quiet -) || { echo "stage copy != SHA256SUMS" >&2; exit 2; }
exec /usr/bin/python3 -I "$D/verify_full_selection.py" --manifest /opt/enclave-rpc/snapshots/base-1792886410-manifest.json --root /srv/enclave-base-holder
