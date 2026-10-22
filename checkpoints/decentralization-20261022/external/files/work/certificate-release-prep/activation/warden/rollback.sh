#!/bin/bash
# Root: remove ONLY what install.sh added, and only files whose bytes still match the receipt (a changed file is kept and
# reported, exit 4). Stops and disables the unit first. Nothing public changes: stage 1 has no delegation or advertisement.
#   sudo bash rollback.sh <label>
set -uo pipefail
ETC=/etc/enclave-challenge/$1; RECEIPT=$ETC/install-receipt.txt; rc=0
systemctl disable --now enclave-challenge-host.service 2>/dev/null || true
[ -f "$RECEIPT" ] || { echo "no receipt at $RECEIPT"; exit 3; }
while read -r h f; do
  if [ -e "$f" ] && [ "$(sha256sum "$f" | cut -c1-64)" = "$h" ]; then rm -f "$f"; echo "removed $f"; elif [ -e "$f" ]; then echo "KEPT (changed since install) $f"; rc=4; fi
done < "$RECEIPT"
systemctl daemon-reload
echo "front key and receipt kept for root: $ETC/front.key $RECEIPT (remove by hand when done)"; exit $rc
