#!/bin/bash
# Offline (unshare -rn) behaviour of the PINNED reth v2.8.0 / base v1.5.1 binaries on tiny throwaway datadirs.
# Shows how a launch with prune CLI flags rewrites reth.toml. Never touches live data.
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
HERE=$W/prune-recovery-stage
RETH=$W/payload/bin/reth; BASE=$W/payload/bin/base
ip link set lo up
sha256sum "$RETH" "$BASE"
T=$(mktemp -d /tmp/prunerec.XXXXXX); trap 'rm -rf "$T"' EXIT
export HOME=$T/home; mkdir -p "$HOME"
echo "== help: reth node prune flags"; "$RETH" node --help 2>&1 | grep -E -- '--(full|minimal|prune\.)' | sed 's/^ *//' | head -60
echo "== help: base rpc prune flags"; "$BASE" --chain mainnet rpc --help 2>&1 | grep -E -- '--(full|minimal|prune\.)' | sed 's/^ *//' | head -60
OLD=(--prune.transaction-lookup.distance 140000)
# Exactly chain_service.prune_args(snapshot profile) (asserted by test_snapshot_profile_maps_to_complete_flags).
NEW=(--prune.block-interval 5 --prune.minimum-distance 10064 --prune.sender-recovery.full
     --prune.receipts.distance 140000 --prune.account-history.distance 140000
     --prune.storage-history.distance 140000 --prune.bodies.distance 140000 --prune.transaction-lookup.distance 140000)
seed() { mkdir -p "$1"; cp "$HERE/snapshot-profile.toml" "$1/reth.toml"; }
launch() { # bin dir args...
  local bin=$1 d=$2; shift 2
  if [ "$bin" = reth ]; then
    timeout -k 5 ${SECS:-25} "$RETH" node --chain mainnet --datadir "$d" --http --http.addr 127.0.0.1 --ipcdisable \
      --nat none --disable-discovery "$@" > "$d.log" 2>&1
  else
    timeout -k 5 ${SECS:-25} "$BASE" --chain mainnet rpc --datadir "$d" --ipcdisable --disable-discovery \
      --l1-eth-rpc http://127.0.0.1:9 --l1-beacon http://127.0.0.1:9 "$@" > "$d.log" 2>&1
  fi
  echo "-- $bin exit=$? ($(grep -c 'Saving prune config' "$d.log") 'Saving prune config' lines)"; grep -iE 'error|prune' "$d.log" | sed 's/\x1b\[[0-9;]*m//g' | tail -4
}
show() { echo "-- $1/reth.toml sha=$(sha256sum < "$1/reth.toml" | cut -c1-16)"; python3 "$HERE/prune_section.py" "$1/reth.toml"; }
for bin in reth base; do
  echo "=========== $bin: OLD argv (lookup flag only)"; seed $T/$bin-old; show $T/$bin-old; launch $bin $T/$bin-old "${OLD[@]}"; show $T/$bin-old
  cp $T/$bin-old/reth.toml "$HERE/logs/$bin-defect-reth.toml"
  echo "=========== $bin: NEW argv (complete profile)"; seed $T/$bin-new; launch $bin $T/$bin-new "${NEW[@]}"; show $T/$bin-new
  cp $T/$bin-new/reth.toml "$HERE/logs/$bin-new-first-reth.toml"
  echo "=========== $bin: NEW argv second launch (must not rewrite)"; b=$(sha256sum < $T/$bin-new/reth.toml)
  launch $bin $T/$bin-new "${NEW[@]}"; a=$(sha256sum < $T/$bin-new/reth.toml); [ "$a" = "$b" ] && echo "STABLE: second launch left reth.toml byte-identical" || echo "CHANGED on second launch"
  if [ -f "$HERE/prune_profile_repair.py" ]; then
    echo "=========== $bin: repair the defect file, then NEW argv launch (must not rewrite)"
    cp $T/$bin-old/reth.toml $T/$bin-old/defect.toml
    python3 "$HERE/prune_profile_repair.py" --reth-toml $T/$bin-old/reth.toml --client $bin --binary $([ $bin = reth ] && echo "$RETH" || echo "$BASE") --apply --expect-sha256 $(sha256sum < $T/$bin-old/reth.toml | cut -d' ' -f1); echo "repair exit=$?"
    show $T/$bin-old; b=$(sha256sum < $T/$bin-old/reth.toml)
    launch $bin $T/$bin-old "${NEW[@]}"; a=$(sha256sum < $T/$bin-old/reth.toml); [ "$a" = "$b" ] && echo "REPAIR-CANONICAL: launch left repaired reth.toml byte-identical" || { echo "REPAIRED FILE REWRITTEN by client"; show $T/$bin-old; }
    python3 - $T/$bin-old/defect.toml $T/$bin-old/reth.toml <<'PY'
import sys, tomllib
a, b = (tomllib.load(open(p, 'rb')) for p in sys.argv[1:])
pa, pb = a.pop('prune'), b.pop('prune')
print('non-prune content preserved:', a == b, '| prune before:', pa, '| after:', pb)
PY
  fi
done
