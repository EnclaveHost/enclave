#!/usr/bin/env bash
# Starts s4t-apply.sh (the S4 tree switch) DETACHED, as the transient user unit s4t-apply-<UTC stamp>.service, exactly as
# s4d-run.sh starts 4d (enclave-e3): nothing on this side can cut it between its restart and its checks. Its lines go to
# install.log and its exit code to s4/4t-<unit>.rc. Follow with: tail -f ~/enclave-bench/pool-rollout-20260925/s4/install.log
# Usage: s4t-run.sh   (no arguments: the binary is the live 4d one, the target tree is lib4.sh's)
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/pool-rollout-20260925/s4/lib4.sh
U4=s4t-apply-$(date -u +%Y%m%dT%H%M%SZ)
systemctl --user list-units --plain --no-legend --all 's4t-apply-*' | grep -q . && { say4 "REFUSING: a tree-switch run is already active"; exit 3; }
systemd-run --user --unit="$U4" --collect -q -p Environment=PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin \
  --working-directory="$HOME" bash -c '"$0" "$1" "$2"; echo $? > "$3"' "$S4/s4t-apply.sh" "" "" "$S4/4t-$U4.rc"
say4 "4T started DETACHED as $U4 (exit code -> s4/4t-$U4.rc); follow: tail -f $LOG4"
