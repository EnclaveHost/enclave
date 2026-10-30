#!/usr/bin/env bash
# READ-ONLY canary: does a running consumer open ANY connection to the public Base RPC providers in actual use (live refresh
# consumer-cutover-plan-2205 §1)? Samples the sockets of every process in a systemd unit's cgroup (or explicit PIDs) for N
# seconds and matches remote addresses against the providers' CURRENT resolved addresses. Changes nothing; sends nothing.
#   public-rpc-egress-observe.sh <unit|pid:PID[,PID]> <seconds> [extra-host ...]     exit 0 none seen | 1 seen | 2 usage | 3 not running
# A pass proves only "no connection observed in the window" (CDN addresses rotate; run it across a full read cycle).
set -uo pipefail
[ $# -ge 2 ] || { sed -n 2,7p "$0"; exit 2; }
TARGET=$1 SECS=$2; shift 2
HOSTS="base-rpc.publicnode.com base.drpc.org mainnet.base.org base-mainnet.public.blastapi.io 1rpc.io $*"
declare -A IP; for h in $HOSTS; do for a in $(getent ahosts "$h" | awk '{print $1}' | sort -u); do IP[$a]=$h; done; done
[ ${#IP[@]} -gt 0 ] || { echo "no provider address resolved (resolver down?): canary INCONCLUSIVE"; exit 2; }
pids() { case $TARGET in pid:*) echo "${TARGET#pid:}" | tr , ' ';;
  *) cg=$(systemctl show -p ControlGroup --value "$TARGET" 2>/dev/null); [ -n "$cg" ] && cat "/sys/fs/cgroup$cg/cgroup.procs" 2>/dev/null | tr '\n' ' ';; esac; }
[ -n "$(pids)" ] || { echo "$TARGET is not running: canary NOT RUN"; exit 3; }
hits=0; end=$((SECONDS + SECS))
while [ $SECONDS -lt $end ]; do
  P=" $(pids) "
  while read -r st rq sq loc rem proc; do
    r=${rem%:*}; r=${r#[}; r=${r%]}; pid=$(sed -n 's/.*pid=\([0-9]*\).*/\1/p' <<<"$proc")
    if [ -n "${IP[$r]:-}" ] && [[ "$P" == *" $pid "* ]]; then echo "HIT $(date -u +%FT%TZ) pid=$pid -> ${IP[$r]} ($rem) state=$st"; hits=$((hits+1)); fi
  done < <(ss -tnpH 2>/dev/null)
  sleep 2
done
echo "## $TARGET: $hits provider connection sample(s) in ${SECS}s over ${#IP[@]} resolved provider address(es)"
[ $hits = 0 ]
