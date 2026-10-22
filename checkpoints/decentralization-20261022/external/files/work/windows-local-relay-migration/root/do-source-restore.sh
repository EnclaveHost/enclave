#!/usr/bin/env bash
# do-source-restore.sh - ROLLBACK of do-source-stop.sh (root; ON the us-west host). Two DIFFERENT cases:
#
#   sudo bash do-source-restore.sh --abort-before-transfer
#       The key never started anywhere else: root stopped here (completely or partway) and aborts BEFORE the target's relay
#       ever ran (no transfer, or a transferred copy that was never started). The send record here is still the key's only
#       journal, so it must be byte-identical to the STOPPED journal (state-at-stop.sha256, captured after the verified
#       stop; the pre-stop sha is audit only - an in-flight send may have settled during the stop). If the stop failed
#       BEFORE that capture, there is no stop receipt, so the key never became transferable (transfer-relay-files.sh
#       requires the receipt): with the relay verified stopped now, its own current record is the authoritative journal.
#       That is recorded (create-only) and never overwritten. The unit is restored and started.
#
#   sudo bash do-source-restore.sh --after-target-start --windows-out-of-service <gate.mjs>
#       The key DID run on the Windows target, so the target's send record is the journal now. Required:
#         - root's explicit attestation that 95-rollback-relay.ps1 printed OUT OF SERVICE there;
#         - that record streamed back here as $STATE.from-windows (create-only pipe);
#         - the migration gate (the stage's relay/lease-relay-migration-check.mjs) passing for it, run with an EXPLICIT
#           environment (relay-source-common.sh run_gate): THIS host's public relay.env names, KEY_FILE = the protected
#           original key (the unit's KEY_FILE is a LoadCredential copy that vanished with the stop), STATE = the record;
#         - the stop receipt (a completed stop: the only way the key was transferred).
#       Only then: the current record is kept create-only as $MIG/relay-send.json.before-restore, the returned one is
#       installed, and the unit is restored and started.
#
# Unit restoration (both cases), each step verified, compare-and-swap:
#   - a /dev/null mask link is removed with systemctl unmask;
#   - the unit file is put back from $MIG/unit.moved (or the protected unit.rollback) ONLY if the unit path is empty, and
#     only bytes whose sha256 is the reviewed unit's. A unit path holding anything else is refused, never overwritten;
#   - then daemon-reload, enable, start; verified: active, and /v1/info answers as the payee.
# Nothing is deleted: $MIG keeps the copies and a restore receipt. No key or record content is printed.
set -euo pipefail
. "$(dirname "$0")/relay-source-common.sh"
need_root
MODE=${1:-}
case "$MODE" in
  --abort-before-transfer) [ $# -eq 1 ] || { echo "usage: do-source-restore.sh --abort-before-transfer"; exit 2; } ;;
  --after-target-start) [ "${2:-}" = --windows-out-of-service ] && [ -n "${3:-}" ] || { echo "usage: do-source-restore.sh --after-target-start --windows-out-of-service <gate.mjs>"; exit 2; }; GATE=$3 ;;
  *) echo "usage: do-source-restore.sh --abort-before-transfer | --after-target-start --windows-out-of-service <gate.mjs>"; exit 2 ;;
esac
refuse() { journal "restore REFUSED: $*"; echo "REFUSED: $*; nothing (more) was changed"; exit 2; }
fail() { journal "restore FAILED at $1: $2"; echo "RESTORE INCOMPLETE at $1: $2 (the service is not running; fix and re-run: every step is idempotent)"; exit 1; }
[ -d "$MIG" ] || refuse "$MIG is absent: do-source-stop.sh never ran here (nothing to restore)"
journal "restore begin $MODE"
# the protected copy decides what "the reviewed unit" is
[ -f "$MIG/unit.rollback" ] && [ "$(sha "$MIG/unit.rollback")" = "$UNIT_SHA" ] || refuse "$MIG/unit.rollback is missing or not the reviewed unit"
cas_env || refuse "relay.env is not the reviewed bytes ($(sha "$ENV_FILE" 2>/dev/null || echo absent))"
key_ok || refuse "the protected original key is not a non-empty 0600 root-owned regular file"
if [ "$(show ActiveState)" = active ]; then
  # a stop that failed at step 2 leaves the relay running with its unit untouched: that is already the restored state
  if [ "$MODE" = --abort-before-transfer ] && [ -f "$UNIT_PATH" ] && [ ! -L "$UNIT_PATH" ] && [ "$(sha "$UNIT_PATH")" = "$UNIT_SHA" ] && answers_as_payee; then
    journal "restore: nothing to do, the source still runs"; say "NOTHING TO RESTORE: $UNIT is still active from its own unit file and answers as $PAYEE"; exit 0; fi
  refuse "the unit is already active"
fi

# ---- the journal
if [ "$MODE" = --abort-before-transfer ]; then
  [ ! -e "$STATE.from-windows" ] || refuse "$STATE.from-windows exists: the key ran on the target; use --after-target-start"
  [ -f "$STATE" ] || refuse "the send record is absent"
  if [ -f "$MIG/state-at-stop.sha256" ]; then
    [ "$(sha "$STATE")" = "$(cat "$MIG/state-at-stop.sha256")" ] || refuse "the send record differs from the STOPPED journal: this is not a before-transfer abort"
    echo "the send record is the stopped journal ($(state_shape))"
  else
    # the stop failed before its journal was captured: no receipt, so no transfer was possible; prove the relay is stopped NOW
    [ ! -e "$MIG/stop-receipt.json" ] || refuse "a stop receipt exists without a stopped journal sha: inconsistent; settle by hand"
    [ "$(show ActiveState)" != active ] && ! relay_process && ! listener || refuse "the relay is not verifiably stopped now"
    ! answers_as_payee || refuse "something still answers /v1/info as $PAYEE (local or $FRONT): the key may be serving elsewhere"
    ( set -o noclobber; sha "$STATE" > "$MIG/state-authority-at-abort.sha256" ) 2>/dev/null || [ "$(cat "$MIG/state-authority-at-abort.sha256")" = "$(sha "$STATE")" ] || refuse "the record changed since an earlier abort attempt"
    echo "no stopped journal was captured (the stop failed before it) and no receipt exists: the stopped relay's own record is the authoritative journal ($(state_shape)); kept as is"
  fi
else
  [ -f "$MIG/stop-receipt.json" ] && [ -f "$MIG/state-at-stop.sha256" ] || refuse "no completed stop (receipt and stopped journal): the key cannot have run on the target; use --abort-before-transfer"
  [ -f "$STATE.from-windows" ] && [ -s "$STATE.from-windows" ] || refuse "$STATE.from-windows is absent: stream the Windows send record back first"
  run_gate "$GATE" "$STATE.from-windows" || refuse "the migration gate did not pass for the returned record"
  if [ "$(sha "$STATE.from-windows")" != "$(sha "$STATE")" ]; then
    [ -e "$MIG/relay-send.json.before-restore" ] || cp --no-clobber --preserve=mode,ownership,timestamps "$STATE" "$MIG/relay-send.json.before-restore" || fail journal "the current record could not be preserved"
    [ "$(sha "$MIG/relay-send.json.before-restore")" = "$(cat "$MIG/state-at-stop.sha256")" ] || fail journal "the preserved record is not the stopped journal"
    install -m 0600 -o "$(stat -c %u "$STATE")" -g "$(stat -c %g "$STATE")" "$STATE.from-windows" "$STATE.restore-tmp" && mv -T "$STATE.restore-tmp" "$STATE" || fail journal "the returned record could not be installed"
    [ "$(sha "$STATE")" = "$(sha "$STATE.from-windows")" ] || fail journal "the installed record is not the returned one"
  fi
  journal "the returned record is installed"
  echo "the returned send record is installed ($(state_shape))"
fi

# ---- the unit (compare-and-swap; rechecked right before the writes)
cas_env && [ "$(sha "$MIG/unit.rollback")" = "$UNIT_SHA" ] || fail unit "relay.env or the protected unit copy changed during the restore"
if masked_link; then systemctl unmask "$UNIT" >/dev/null 2>&1 || fail unmask "systemctl unmask failed"; ! masked_link || fail unmask "the mask link is still there"; journal "unmasked"; fi
if [ -L "$UNIT_PATH" ]; then fail unit "$UNIT_PATH is a link to $(readlink "$UNIT_PATH"): refused, not overwritten"; fi
if [ -e "$UNIT_PATH" ]; then
  [ -f "$UNIT_PATH" ] && [ "$(sha "$UNIT_PATH")" = "$UNIT_SHA" ] || fail unit "$UNIT_PATH holds another file ($(sha "$UNIT_PATH")): refused, not overwritten"
  echo "the unit file is in place (it was never moved)"
else
  src="$MIG/unit.moved"; [ -f "$src" ] && [ "$(sha "$src")" = "$UNIT_SHA" ] || src="$MIG/unit.rollback"
  cp --preserve=timestamps "$src" "$UNIT_PATH.restore-tmp" && chmod 0644 "$UNIT_PATH.restore-tmp" || fail unit "the unit could not be staged"
  [ "$(sha "$UNIT_PATH.restore-tmp")" = "$UNIT_SHA" ] || fail unit "the staged unit is not the reviewed one"
  [ ! -e "$UNIT_PATH" ] || fail unit "$UNIT_PATH appeared meanwhile: refused"
  mv --no-clobber -T "$UNIT_PATH.restore-tmp" "$UNIT_PATH" && [ ! -e "$UNIT_PATH.restore-tmp" ] || fail unit "the unit could not be put back"
  [ "$(sha "$UNIT_PATH")" = "$UNIT_SHA" ] || fail unit "the restored unit is not the reviewed one"
  journal "unit restored from $(basename "$src")"
fi
systemctl daemon-reload || fail reload "daemon-reload failed"
systemctl enable "$UNIT" >/dev/null 2>&1 || fail enable "systemctl enable failed"
systemctl start "$UNIT" || fail start "systemctl start failed"
for i in $(seq 1 60); do [ "$(show ActiveState)" = active ] && answers_as_payee && break; sleep 1; done
[ "$(show ActiveState)" = active ] || fail start "the unit is not active"
answers_as_payee || fail start "the relay does not answer as $PAYEE"
( set -o noclobber; printf '{"restoredAt":"%s","mode":"%s","unitSha256":"%s","stateSha256":"%s"}\n' "$(now)" "$MODE" "$UNIT_SHA" "$(sha "$STATE")" > "$MIG/restore-receipt-$(date -u +%Y%m%dT%H%M%SZ).json" ) || true
journal "restore done $MODE"
say "RESTORED ($MODE): $UNIT active and enabled, answering as $PAYEE; copies kept in $MIG"
