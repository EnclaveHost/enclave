#!/usr/bin/env bash
# Starts 4c-a (arg a) or 4c-b (arg b) DETACHED as the transient user unit s4c<a|b>-apply-<UTC>.service (enclave-e3's
# pattern from 4d): lines to rollout.log, the exit code to 4c<a|b>-<unit>.rc. Follow: tail -f ~/enclave-bench/s4c-20260925/rollout.log
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4c.sh
X=${1:?a or b}; [[ "$X" =~ ^[ab]$ ]] || { echo "a or b"; exit 2; }
U4=s4c$X-apply-$(date -u +%Y%m%dT%H%M%SZ)
systemctl --user list-units --plain --no-legend --all 's4c?-apply-*' | grep -q . && { say "REFUSING: a 4c run is already active"; exit 3; }
systemd-run --user --unit="$U4" --collect -q -p Environment=PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin \
  --working-directory="$HOME" bash -c '"$0"; echo $? > "$1"' "$S4C/s4c$X-apply.sh" "$S4C/4c$X-$U4.rc"
say "4c-$X started DETACHED as $U4 (exit code -> 4c$X-$U4.rc); follow: tail -f $LOGC"
