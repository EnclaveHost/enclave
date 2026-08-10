#!/usr/bin/env bash
# deploy-wasm-tools-set.sh — ship the SET-relaxed `wasm-tools` to the upload
# gateway box and point WASM_TOOLS at it.
#
# Build it first: scripts/build-wasm-tools-set.sh (writes dist/wasm-tools-set,
# a static musl binary — the gateway VM needs no Rust and no libc match).
#
# Lives in /opt/enclave-gateway next to ipfs-add-gateway.py, deliberately
# OUTSIDE /opt/nan-site — site/deploy.sh replaces that whole tree every deploy
# and would delete the binary (that is how the gateway script itself got
# deleted on 2026-07-07). WASM_TOOLS is set through a systemd DROP-IN rather
# than by editing the unit: drop-ins are applied after the unit file, so the
# same key overrides whatever the unit sets, and reverting is `rm` + reload.
#
# Idempotent. Verifies AFTER restart that the gateway is running with Tier 2 on.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${GATEWAY_HOST:-nan}"
BIN=dist/wasm-tools-set
DEST=/opt/enclave-gateway/wasm-tools-set
# SSH_OPTS lets a non-interactive caller pass `-i ~/.ssh/nan-ci-deploy`; the
# interactive default is whatever the agent holds.
read -r -a SSH_OPTS <<< "${SSH_OPTS:-}"

[ -x "$BIN" ] || { echo "missing $BIN — run scripts/build-wasm-tools-set.sh first" >&2; exit 1; }

# Never dump `-p Environment` whole: the gateway's env carries UPLOAD_KEY (the
# HMAC secret it shares with the api-relay), and this output ends up in
# terminals and CI logs. Only WASM_TOOLS is our business here.
show_state() {
  ssh "${SSH_OPTS[@]}" "$HOST" \
    'systemctl show nan-wasm-gateway -p Environment | tr " " "\n" | grep -E "^WASM_TOOLS=" || echo "WASM_TOOLS=(unset)"
     systemctl is-active nan-wasm-gateway'
}

echo "== before =="
show_state || true

ssh "${SSH_OPTS[@]}" "$HOST" 'mkdir -p /opt/enclave-gateway'
# Stage then move: the running gateway may be mid-validate on the old binary,
# and overwriting a busy executable in place is ETXTBSY. A rename is atomic and
# leaves any in-flight exec on the old inode.
scp "${SSH_OPTS[@]}" "$BIN" "$HOST:${DEST}.new"
ssh "${SSH_OPTS[@]}" "$HOST" "chmod 0755 ${DEST}.new && mv -f ${DEST}.new ${DEST} && ${DEST} --version"

ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p /etc/systemd/system/nan-wasm-gateway.service.d && \
  printf '[Service]\nEnvironment=WASM_TOOLS=%s\n' '${DEST}' \
    > /etc/systemd/system/nan-wasm-gateway.service.d/wasm-tools.conf && \
  systemctl daemon-reload && systemctl restart nan-wasm-gateway"

echo "== after =="
show_state
ssh "${SSH_OPTS[@]}" "$HOST" 'journalctl -u nan-wasm-gateway -n 5 --no-pager'

echo
echo 'Expect the startup line to read "(wasm-tools on)" — "(header-only)" means'
echo 'WASM_TOOLS did not reach the process and Tier 2 is silently off.'
