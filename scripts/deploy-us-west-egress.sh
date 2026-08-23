#!/usr/bin/env bash
# deploy-us-west-egress.sh — stand up the EGRESS relay on us-west so a
# deployment routed through us-west egresses through it too (both directions
# through the designated relay). Run from a machine that has THIS repo checked
# out AND SSH access to us-west; the shared egress token comes from nan-relay
# (or pass EGRESS_RELAY_TOKEN=... in the environment).
#
# Why us-west egress is PLAIN (no EGRESS_PREFIX): us-west owns no routed /64,
# so it can't source-bind a deployment's dedicated IPv6. The enclave (v0.5.487+)
# knows this — it sends NO source for us-west-routed deployments, and the relay
# dials out from us-west's own address. Dedicated-IP egress stays on nan-relay
# (the /64 owner) via network.relay:"nan". See egress.js / relay/egress-relay.js.
#
#   Usage:  bash scripts/deploy-us-west-egress.sh [us-west-ssh-alias]
#   Env:    EGRESS_RELAY_TOKEN  the fleet egress token (optional; else pulled
#                               from nan-relay:/etc/nan-relay/egress-relay.env)
#           NAN_RELAY           ssh alias for nan-relay (default: nan-relay)
set -euo pipefail

UW="${1:-us-west-relay}"                 # us-west ssh alias (root@5.78.85.108)
NAN_RELAY="${NAN_RELAY:-nan-relay}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "[us-west-egress] target: $UW"
ssh -o BatchMode=yes -o ConnectTimeout=8 "$UW" 'echo "[us-west-egress] reached $(hostname)"' \
  || { echo "FATAL: cannot SSH to $UW — add your key to us-west or fix the alias"; exit 1; }

# 1) the fleet egress token (same value on every relay + enclave, like SECRET)
TOKEN="${EGRESS_RELAY_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "[us-west-egress] pulling EGRESS_RELAY_TOKEN from $NAN_RELAY"
  TOKEN="$(ssh -o BatchMode=yes "$NAN_RELAY" 'grep -oP "^EGRESS_RELAY_TOKEN=\K.*" /etc/nan-relay/egress-relay.env')"
fi
[ -n "$TOKEN" ] || { echo "FATAL: no EGRESS_RELAY_TOKEN (set it in the env or ensure $NAN_RELAY has it)"; exit 1; }

# 2) code: the CURRENT egress-relay.js + its deps (us-west's copy is stale — it
#    is not in relay/deploy.sh). package files so `npm ci` matches the lockfile.
echo "[us-west-egress] copying relay code"
ssh -o BatchMode=yes "$UW" 'mkdir -p /opt/nan-relay'
scp -o BatchMode=yes \
  "$HERE"/relay/egress-relay.js "$HERE"/relay/fleet.mjs "$HERE"/relay/net-guard.mjs \
  "$HERE"/relay/package.json "$HERE"/relay/package-lock.json \
  "$UW":/opt/nan-relay/
scp -o BatchMode=yes "$HERE"/relay/systemd/enclave-egress-relay.service "$UW":/etc/systemd/system/

# 3) env — PLAIN egress: RELAY_NAME=us-west, fleet discovery, NO EGRESS_PREFIX.
echo "[us-west-egress] writing env + installing deps + starting"
ssh -o BatchMode=yes "$UW" "TOKEN='$TOKEN' bash -s" <<'REMOTE'
set -euo pipefail
cd /opt/nan-relay
[ -d node_modules ] || npm ci --omit=dev
umask 077
cat > /etc/nan-relay/egress-relay.env <<ENV
EGRESS_RELAY_TOKEN=${TOKEN}
RELAY_NAME=us-west
REGISTRY_ADDRESS=0xCB65f487eba6564D57FfB860cF9aE701584cB4a2
ADDRESS_BOOK_ADDRESS=0xab214342d5A490150A4A977063A2f88E21F80907
BASE_RPC=https://base-rpc.publicnode.com
TRUSTED_OPERATORS=0x390e2e0e0bc34b7f428f1e31c9b6770d5028ecc1
ENV
# NO EGRESS_PREFIX -> the unit's `ip -6 route add local` self-ignores, and the
# relay dials plain from us-west's own address (the enclave sends no source).
systemctl daemon-reload
systemctl enable --now enclave-egress-relay
sleep 4
systemctl is-active enclave-egress-relay
journalctl -u enclave-egress-relay --since "-30s" -o cat | grep -iE "control channel up|egress relay" | tail -4
REMOTE
echo "[us-west-egress] done — us-west now attaches to the fleet as relay 'us-west' and carries egress."
echo "[us-west-egress] verify: an app routed via us-west should egress FROM us-west (fast R2 reads)."
