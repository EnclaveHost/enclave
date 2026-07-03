#!/usr/bin/env bash
# deploy.sh - push the relay daemons + systemd units to the relay box and
# restart them. Mirrors site/deploy.sh: paths are relative to relay/ however
# this script is invoked, and the box is addressed by the `nan-relay` ssh
# alias (Host nan-relay in ~/.ssh/config; CI writes an equivalent one).
#
# Host layout it targets (see README): /opt/nan-relay/ holds the daemons and
# their node_modules; units live in /etc/systemd/system; env files under
# /etc/nan-relay/ are host state and are NOT touched here.
set -euo pipefail
cd "$(dirname "$0")"
scp relay.js api-relay.js udp-relay.js package.json nan-relay:/opt/nan-relay/
scp systemd/nan-api-relay.service systemd/nan-tcp-relay.service systemd/nan-udp-relay.service \
    nan-relay:/etc/systemd/system/
ssh nan-relay 'cd /opt/nan-relay && npm install --omit=dev --no-audit --no-fund \
  && systemctl daemon-reload \
  && systemctl restart nan-api-relay nan-tcp-relay nan-udp-relay \
  && systemctl is-active nan-api-relay nan-tcp-relay nan-udp-relay'
