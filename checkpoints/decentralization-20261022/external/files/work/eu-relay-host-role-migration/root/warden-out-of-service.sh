#!/usr/bin/env bash
# warden-out-of-service.sh - ROLLBACK step 1 after the role STARTED on warden (root; ON warden). The role is stopped,
# disabled, its unit file moved aside (no-clobber) and masked, then verified out of service on every channel: inactive,
# masked, no supervisor or relay process, nothing on :8549, nothing answering /v1/info as the payee. Only then the receipt
# (create-only) records the journal - which is the key's journal now - by sha256 and public shape, and TARGET OUT OF
# SERVICE is printed. Idempotent: on an already out-of-service host it verifies again and prints the same.
# Next: transfer-journal-back.sh (workstation), then eu-source-restore.sh --after-target-start --target-out-of-service.
# The key and journal are never moved, opened or printed here.
#   sudo bash warden-out-of-service.sh
set -euo pipefail
. "$(dirname "$0")/warden-common.sh"
[ $# -eq 0 ] || { echo "usage: warden-out-of-service.sh"; exit 2; }
need_root
[ -d "$MIG" ] || { echo "REFUSED: $MIG is absent: nothing was staged here"; exit 2; }
fail() { journal "out-of-service FAILED: $1"; echo "NOT OUT OF SERVICE: $1 (fix and re-run; the journal must not be copied back yet)"; exit 1; }
journal "out-of-service begin"
systemctl stop "$UNIT" >/dev/null 2>&1 || true
for i in $(seq 1 30); do [ "$(show ActiveState)" != active ] && ! relay_process && ! listener && break; sleep 1; done
[ "$(show ActiveState)" != active ] || fail "the unit is still active"
systemctl disable "$UNIT" >/dev/null 2>&1 || true
if [ -f "$UNIT_PATH" ] && [ ! -L "$UNIT_PATH" ]; then
  [ "$(sha "$UNIT_PATH")" = "$UNIT_SHA" ] || echo "note: $UNIT_PATH is not the reviewed unit ($(sha "$UNIT_PATH")); it is moved aside all the same"
  n=$MIG/unit.out-of-service; [ -e "$n" ] && n=$n-$(date -u +%Y%m%dT%H%M%SZ)
  mv --no-clobber -T "$UNIT_PATH" "$n" || fail "the unit file could not be moved aside"
fi
masked_link || { systemctl daemon-reload || fail "daemon-reload failed"; systemctl mask "$UNIT" >/dev/null 2>&1 || fail "systemctl mask failed"; systemctl daemon-reload || fail "daemon-reload after mask failed"; }
masked_link && [ "$(show LoadState)" = masked ] && [ "$(show ActiveState)" != active ] || fail "the unit is not masked and inactive (LoadState $(show LoadState))"
! relay_process || fail "a lease-relay-host.mjs or lease-relay.mjs process still runs"
! listener || fail "something still listens on :$PORT"
! answers_as_payee || fail "something still answers $(info_url) as $PAYEE"
[ -f "$STATE" ] || fail "the journal $STATE is absent: settle by hand"
shape=$(state_shape)
r=$MIG/out-of-service-receipt.json
if [ -f "$r" ]; then echo "an earlier receipt exists ($r); verified again"
else ( set -o noclobber; printf '{"outOfServiceAt":"%s","masked":true,"everStarted":%s,"stateSha256":"%s","stateShape":"%s"}\n' "$(now)" "$([ -e "$EVER_STARTED" ] && echo true || echo false)" "$(sha "$STATE")" "$shape" > "$r" ) || fail "the receipt could not be written"; fi
journal "out-of-service done ($shape)"
say "TARGET OUT OF SERVICE: $UNIT stopped, disabled, masked; nothing serves as $PAYEE here. Journal: $shape ($(sha "$STATE"))"
