#!/usr/bin/env bash
# up.sh - render the devnet runtime directory from deploy-l1.sh's output and
# start l2/devnet/compose.yml. Keys are copied into per-service env files
# (mode 0600) under $DEVNET, never into the repo or onto a command line.
#
# Env: WORK (deploy-l1.sh output), KEYS, DEVNET (runtime dir, outside the repo),
#      SEQ_L1_RPC, SEQ_L1_BEACON, REPLICA_L1_RPC, REPLICA_L1_BEACON,
#      BATCHER_MAX_CHANNEL_DURATION (L1 blocks, default 25 = ~5 min),
#      PROPOSAL_INTERVAL (default 1h), SEQ_L1_CONFS (default 4).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${WORK:?}" "${KEYS:?}" "${DEVNET:?}" "${SEQ_L1_RPC:?}" "${SEQ_L1_BEACON:?}" "${REPLICA_L1_RPC:?}" "${REPLICA_L1_BEACON:?}"
case "$DEVNET" in "$(cd "$here/../.." && pwd)"*) echo "up: DEVNET must be outside the repo" >&2; exit 1;; esac
umask 077
mkdir -p "$DEVNET"/{cfg,prestates,challenger,seq/reth,seq/node,replica/reth,replica/node}
cp "$WORK/rollup.json" "$WORK/genesis.json" "$DEVNET/cfg/"
chain=$(jq -r .l2_chain_id "$WORK/rollup.json")
# op-challenger's static dependency set for a cluster of one
jq -n --arg c "$chain" '{dependencies: {($c): {chainIndex: ($c|tonumber), activationTime: 0, historyMinTime: 0}}, overrideMessageExpiryWindow: 0}' > "$DEVNET/cfg/depset.json"
pre=$(cat "$WORK/prestate-super.txt")
cp "$WORK/prestate-out/prestate-artifacts-cannon-interop/$pre.bin.gz" "$DEVNET/prestates/"
for side in seq replica; do [ -s "$DEVNET/$side/jwt.hex" ] || openssl rand -hex 32 > "$DEVNET/$side/jwt.hex"; done
k() { tr -d '\n' < "$KEYS/$1.key" | sed 's/^0x//'; }
echo "OP_NODE_P2P_SEQUENCER_KEY=$(k sequencer)"  > "$DEVNET/secrets-sequencer.env"
echo "OP_BATCHER_PRIVATE_KEY=$(k batcher)"       > "$DEVNET/secrets-batcher.env"
echo "OP_PROPOSER_PRIVATE_KEY=$(k proposer)"     > "$DEVNET/secrets-proposer.env"
echo "OP_CHALLENGER_PRIVATE_KEY=$(k challenger)" > "$DEVNET/secrets-challenger.env"
cat > "$DEVNET/.env" <<EOF
DEVNET=$DEVNET
SEQ_L1_RPC=$SEQ_L1_RPC
SEQ_L1_BEACON=$SEQ_L1_BEACON
REPLICA_L1_RPC=$REPLICA_L1_RPC
REPLICA_L1_BEACON=$REPLICA_L1_BEACON
SEQ_L1_CONFS=${SEQ_L1_CONFS:-4}
BATCHER_MAX_CHANNEL_DURATION=${BATCHER_MAX_CHANNEL_DURATION:-25}
PROPOSAL_INTERVAL=${PROPOSAL_INTERVAL:-1h}
DISPUTE_GAME_FACTORY=$(jq -r .DisputeGameFactoryProxy "$WORK/chain-addresses.json")
EOF
chmod 600 "$DEVNET"/*.env
# containers run as root or as an image user; make data dirs writable for either
chmod -R a+rwX "$DEVNET"/seq "$DEVNET"/replica "$DEVNET"/challenger
chmod a+r "$DEVNET"/seq/jwt.hex "$DEVNET"/replica/jwt.hex "$DEVNET"/cfg/* "$DEVNET"/prestates/*
docker compose --env-file "$DEVNET/.env" -f "$here/compose.yml" up -d "$@"
