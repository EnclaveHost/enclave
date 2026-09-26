#!/usr/bin/env bash
# Starts n2b-apply.sh DETACHED as the transient user unit n2b-apply-<UTC>.service (enclave-e3's pattern): lines to n2b.log,
# the exit code to n2b-<unit>.rc. Follow: tail -f ~/enclave-bench/n2-20260926/n2b.log
set -euo pipefail; N2D=~/enclave-bench/n2-20260926
U=n2b-apply-$(date -u +%Y%m%dT%H%M%SZ)
systemctl --user list-units --plain --no-legend --all 'n2b-apply-*' 's?t-apply-*' 's4c*-apply-*' | grep -q . && { echo "REFUSING: a rollout run is already active"; exit 3; }
systemd-run --user --unit="$U" --collect -q -p Environment=PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin \
  --working-directory="$HOME" bash -c '"$0"; echo $? > "$1"' "$N2D/n2b-apply.sh" "$N2D/n2b-$U.rc"
echo "$(date -u +%H:%M:%SZ) N2-b started DETACHED as $U (exit code -> n2b-$U.rc); follow: tail -f $N2D/n2b.log" | tee -a $N2D/n2b.log
