#!/usr/bin/env bash
# user-out-of-service.sh - ROLLBACK step 1 after the role STARTED here (the operator user, on warden-host). The LAN forwarder
# (if installed) and the role are stopped, disabled, their unit files moved aside (no-clobber) and masked; then out of
# service is verified on every channel - inactive, masked, no role or relay process of this user's release, nothing on
# :8549, nothing answering /v1/info as the payee. Only then the receipt (create-only) records the journal - the key's
# journal now - by sha256 and public shape, and TARGET OUT OF SERVICE is printed. Idempotent. The key and journal are never
# moved, opened or printed. Next: user-journal-back.sh, then eu-source-restore.sh --after-target-start on the source.
#   bash user-out-of-service.sh
set -euo pipefail
. "$(dirname "$0")/user-common.sh"
[ $# -eq 0 ] || { echo "usage: user-out-of-service.sh"; exit 2; }
need_user
owned_dir "$MIG" || { echo "REFUSED: $MIG is not this user's staged target"; exit 2; }
fail() { journal "out-of-service FAILED: $1"; echo "NOT OUT OF SERVICE: $1 (fix and re-run; the journal must not be copied back yet)"; exit 1; }
journal "out-of-service begin"
for u in "$LAN_UNIT:$LAN_UNIT_PATH" "$UNIT:$UNIT_PATH"; do
  name=${u%%:*}; file=${u#*:}
  "${SYSTEMCTL[@]}" stop "$name" >/dev/null 2>&1 || true
  for i in $(seq 1 30); do [ "$(show ActiveState "$name")" != active ] && break; sleep 1; done
  [ "$(show ActiveState "$name")" != active ] || fail "$name is still active"
  "${SYSTEMCTL[@]}" disable "$name" >/dev/null 2>&1 || true
  if [ -f "$file" ] && [ ! -L "$file" ]; then n=$MIG/$name.out-of-service; [ -e "$n" ] && n=$n-$(date -u +%Y%m%dT%H%M%SZ); mv --no-clobber -T "$file" "$n" || fail "$file could not be moved aside"; fi
  if ! masked_link "$file"; then "${SYSTEMCTL[@]}" daemon-reload || fail "daemon-reload failed"; "${SYSTEMCTL[@]}" mask "$name" >/dev/null 2>&1 || fail "systemctl --user mask $name failed"; fi
done
"${SYSTEMCTL[@]}" daemon-reload || fail "daemon-reload after mask failed"
masked_link "$UNIT_PATH" && [ "$(show LoadState)" = masked ] && [ "$(show ActiveState)" != active ] || fail "$UNIT is not masked and inactive (LoadState $(show LoadState))"
for i in $(seq 1 30); do ! relay_process && ! listener && break; sleep 1; done
! relay_process || fail "a process of this release's role or relay still runs"
! listener || fail "something still listens on :$PORT"
! answers_as_payee || fail "something still answers $INFO_URL as $PAYEE"
owned_file "$STATE" || fail "the journal $STATE is absent or not this user's file: settle by hand"
shape=$(state_shape); r=$MIG/out-of-service-receipt.json
if [ -f "$r" ]; then echo "an earlier receipt exists ($r); verified again"
  grep -q "\"stateSha256\":\"$(sha "$STATE")\"" "$r" || fail "the journal changed since the earlier receipt: settle by hand"
else ( set -o noclobber; printf '{"outOfServiceAt":"%s","masked":true,"everStarted":%s,"stateSha256":"%s","stateShape":"%s"}\n' "$(now)" "$([ -e "$EVER_STARTED" ] && echo true || echo false)" "$(sha "$STATE")" "$shape" > "$r" ) || fail "the receipt could not be written"; fi
journal "out-of-service done ($shape)"
say "TARGET OUT OF SERVICE: $UNIT (and $LAN_UNIT) stopped, disabled, masked; nothing serves as $PAYEE here. Journal: $shape"
