#!/usr/bin/env bash
# check-replica.sh - show that the replica derived the sequencer's chain from
# L1 alone: wait until the replica's safe head reaches TARGET (default: the
# sequencer's current unsafe head), then compare block hashes and state roots
# at every STEP-th height plus TARGET itself, and the runtime code of any
# ADDRS. Prints one JSON object; exits 1 on any mismatch.
#
# Env: SEQ_RPC (default http://127.0.0.1:9545), SEQ_NODE (:9547),
#      REPLICA_RPC (:9645), REPLICA_NODE (:9647), TARGET, STEP (default 100),
#      ADDRS (space-separated contract addresses), TIMEOUT (s, default 1800).
set -euo pipefail
SEQ_RPC=${SEQ_RPC:-http://127.0.0.1:9545}; SEQ_NODE=${SEQ_NODE:-http://127.0.0.1:9547}
REPLICA_RPC=${REPLICA_RPC:-http://127.0.0.1:9645}; REPLICA_NODE=${REPLICA_NODE:-http://127.0.0.1:9647}
STEP=${STEP:-100}; TIMEOUT=${TIMEOUT:-1800}
sync() { curl -sf -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"optimism_syncStatus","params":[]}' "$1" | jq -c .result; }
TARGET=${TARGET:-$(cast block-number --rpc-url "$SEQ_RPC")}
start=$(date +%s)
until [ "$(sync "$REPLICA_NODE" | jq .safe_l2.number)" -ge "$TARGET" ]; do
  [ $(( $(date +%s) - start )) -lt "$TIMEOUT" ] || { echo "check-replica: replica safe head did not reach $TARGET in ${TIMEOUT}s" >&2; exit 1; }
  sleep 10
done
waited=$(( $(date +%s) - start ))
mismatch=0; checked=0
for n in $(seq 0 "$STEP" "$TARGET") "$TARGET"; do
  a=$(cast block "$n" --rpc-url "$SEQ_RPC" --json | jq -c '{hash, stateRoot}')
  b=$(cast block "$n" --rpc-url "$REPLICA_RPC" --json | jq -c '{hash, stateRoot}')
  checked=$((checked + 1)); [ "$a" = "$b" ] || { mismatch=$((mismatch + 1)); echo "check-replica: block $n differs: $a vs $b" >&2; }
done
code=()
for addr in ${ADDRS:-}; do
  x=$(cast keccak "$(cast code "$addr" --rpc-url "$SEQ_RPC")"); y=$(cast keccak "$(cast code "$addr" --rpc-url "$REPLICA_RPC")")
  [ "$x" = "$y" ] || mismatch=$((mismatch + 1))
  code+=("$(jq -cn --arg a "$addr" --arg s "$x" --arg r "$y" '{address:$a, sequencerCodeHash:$s, replicaCodeHash:$r}')")
done
jq -n --argjson target "$TARGET" --argjson checked "$checked" --argjson mismatch "$mismatch" --argjson waited "$waited" \
  --arg tip "$(cast block "$TARGET" --rpc-url "$REPLICA_RPC" --json | jq -r .hash)" \
  --argjson seq "$(sync "$SEQ_NODE")" --argjson rep "$(sync "$REPLICA_NODE")" \
  --argjson code "$(printf '%s\n' "${code[@]:-}" | jq -sc 'map(select(. != null))')" \
  '{target:$target, targetHash:$tip, heightsCompared:$checked, mismatches:$mismatch, secondsWaitedForReplicaSafe:$waited,
    contractCode:$code,
    sequencer:{unsafe:$seq.unsafe_l2.number, safe:$seq.safe_l2.number, finalized:$seq.finalized_l2.number, l1:$seq.head_l1.number},
    replica:{unsafe:$rep.unsafe_l2.number, safe:$rep.safe_l2.number, finalized:$rep.finalized_l2.number, l1:$rep.current_l1.number}}'
[ "$mismatch" = 0 ]
