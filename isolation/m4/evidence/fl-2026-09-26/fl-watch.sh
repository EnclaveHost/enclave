#!/usr/bin/env bash
# Polls the chain every ~30 s (>= 2 of 4 RPCs agreeing) for each of Steven's 3 apps; when an app's envelope first asks for
# snp-guest-per-app (his S6 setConfig), records the time and the envelope's sha256 and starts fl-check.sh for it as its own
# transient unit. Changes nothing anywhere. Ends when all 3 have been seen, or after 8 h. Run: systemd-run --user ... (below).
set -uo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh; source ~/enclave-bench/release-on-20260925/lib-ro.sh; source ~/enclave-bench/e5-20260926/lib-e5.sh; source ~/enclave-bench/fl-20260926/lib-fl.sh
end=$(( $(date +%s) + 28800 )); say "watch: polling the chain for a69dcbba, d9798e4c, a77d0c57, 7ae476a3 (envelope requires snp-guest-per-app)"
for a in a69dcbba d9798e4c a77d0c57 7ae476a3; do app $a; e=$(envelope $AFULL) && { set -- $e; say "watch: $a now: envelope sha ${1:0:16}, requires snp: $2, network.relay $3"; } || say "watch: $a now: the ledger read failed (retrying)"; done
while [ $(date +%s) -lt $end ]; do
  left=0
  for a in a69dcbba d9798e4c a77d0c57 7ae476a3; do
    [ -e $FST/$a-detected ] && continue; left=$((left+1)); app $a
    e=$(envelope $AFULL) || continue
    set -- $e
    if [ "$2" = true ]; then
      T0=$(date -u '+%Y-%m-%d %H:%M:%S'); printf 'T0=%s\nENVSHA=%s\nRELAY=%s\n' "$T0" "$1" "$3" > $FST/$a-detected
      say "watch: $a's envelope NOW requires snp-guest-per-app (sha ${1:0:16}, network.relay $3; T0 $T0 UTC): starting its first-launch check"
      U=fl-check-$a-$(date -u +%Y%m%dT%H%M%SZ)
      systemd-run --user --unit="$U" --collect -q -p Environment=PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin --working-directory="$HOME" \
        bash -c '"$0" "$1"; echo $? > "$2"' $FL/fl-check.sh $a $FST/$a-check.rc || say "watch: could not start $U"
    fi
  done
  [ $left = 0 ] && { say "watch: all 4 seen; done"; exit 0; }
  sleep 30
done
say "watch: 8 h without all 4 envelopes changing; stopping"
