#!/usr/bin/env bash
# Starts step 2 (arg on) or its rollback (arg off) DETACHED as the transient user unit rr-<on|off>-apply-<UTC>.service:
# lines to release-on.log, the exit code to rr-<on|off>-<unit>.rc.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh; source ~/enclave-bench/release-on-20260925/lib-ro.sh
X=${1:?on or off}; [[ "$X" =~ ^(on|off)$ ]] || { echo "on or off"; exit 2; }
S=$RO/rr-on-apply.sh; [ "$X" = off ] && S=$RO/rr-off.sh
U2=rr-$X-apply-$(date -u +%Y%m%dT%H%M%SZ)
systemctl --user list-units --plain --no-legend --all 'rr-*-apply-*' 's4c*-apply-*' | grep -q . && { say "REFUSING: a run is already active"; exit 3; }
systemd-run --user --unit="$U2" --collect -q -p Environment=PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin \
  --working-directory="$HOME" bash -c '"$0"; echo $? > "$1"' "$S" "$RO/rr-$X-$U2.rc"
say "release-$X started DETACHED as $U2 (exit code -> rr-$X-$U2.rc); follow: tail -f $LOGR"
