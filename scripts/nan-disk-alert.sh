#!/usr/bin/env bash
# nan-disk-alert.sh — warn when nan's root filesystem crosses a usage threshold.
# The root fs holds the Kubo repo that serves the site AND every pinned app
# wasm; pins never GC and there's no cleanup yet, so this fills monotonically.
# When the disk fills, `ipfs add` fails and site deploys + app publishing + the
# enclaves fetching wasm all break at once — so we want warning well before then.
#
# Emits a WARNING to the journal always (tag: nan-disk-alert). If DISK_ALERT_WEBHOOK
# is set (e.g. a Slack incoming-webhook URL), also POSTs {"text": "..."} to it.
# Installed as nan-disk-alert.service + .timer (every 15 min) on the nan box.
# Optional env in /etc/nan-disk-alert.env: DISK_ALERT_THRESHOLD (default 80),
# DISK_ALERT_WEBHOOK.
set -euo pipefail
THRESH=${DISK_ALERT_THRESHOLD:-80}
USE=$(df --output=pcent / | tail -1 | tr -dc '0-9')
AVAIL=$(df -h --output=avail / | tail -1 | tr -d ' ')
if [ "${USE:-0}" -ge "$THRESH" ]; then
  MSG="nan disk ${USE}% used on / (${AVAIL} free) — Kubo repo + pinned app wasm live here; ipfs add fails when full. Threshold ${THRESH}%."
  logger -t nan-disk-alert -p user.warning "$MSG"
  echo "WARN: $MSG" >&2
  if [ -n "${DISK_ALERT_WEBHOOK:-}" ]; then
    curl -fsS -m 10 -X POST -H 'content-type: application/json' \
      --data "$(printf '{"text":"%s"}' "$MSG")" "$DISK_ALERT_WEBHOOK" >/dev/null || true
  fi
else
  logger -t nan-disk-alert -p user.info "nan disk ${USE}% used on / (${AVAIL} free) — below ${THRESH}%"
fi
