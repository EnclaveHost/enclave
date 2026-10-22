#!/usr/bin/env bash
# eu-source-stop.sh - ROOT runs this ON the DigitalOcean eu-central relay host, FIRST, before the key is copied anywhere.
# (The us-west do-source-stop.sh root used on 2026-10-21, unchanged except for its names and eu-source-common.sh.)
#   sudo bash eu-source-stop.sh --check     READ-ONLY: every precondition below, and the actual unit/env sha256 and states
#   sudo bash eu-source-stop.sh --stop      the exclusive stop (each step verified; journaled in $MIG/progress.log)
# --stop, in order (any failure stops there, FAILS CLOSED and leaves the service STOPPED if it got that far; it never
# starts anything; the matching restore is printed):
#   0. preconditions, read-only:
#      - the unit file is the reviewed one (CAS sha256) at FragmentPath;
#      - relay.env is the reviewed one;
#      - the key is present (0600, root);
#      - the send record is present and well-formed;
#      - $MIG does not exist.
#   1. $MIG is created 0700 (create-only), with a create-only PROTECTED copy of the unit (unit.rollback, sha verified) and
#      state-pre-stop.sha256: AUDIT ONLY (an in-flight send may still settle while the relay stops).
#   2. systemctl stop. Verified: inactive, no lease-relay.mjs process, nothing listening on :8549, and neither the local
#      listener nor the https front answers /v1/info as the payee. ONLY THEN the AUTHORITATIVE stopped journal is captured
#      (create-only): state-at-stop.sha256 and its public shape. Both rollbacks judge the record against THAT.
#   3. systemctl disable; verified "disabled".
#   4. The unit file is MOVED aside, no-clobber, to $MIG/unit.moved (sha verified). A unit FILE in /etc/systemd/system
#      blocks `systemctl mask`, so this comes first.
#   5. daemon-reload, systemctl mask (a persistent /dev/null link), daemon-reload. Verified: LoadState masked, inactive.
#   6. stop-receipt.json (create-only), written only when the record still IS the stopped journal: the stopped sha
#      (authoritative), the pre-stop sha (audit), whether the journal changed during the stop, the unit sha.
# Every write is preceded by an immediate compare-and-swap recheck of the unit file and relay.env.
# The key and send record are never moved, opened or printed (the record's shape and sha are public).
set -euo pipefail
. "$(dirname "$0")/eu-source-common.sh"
MODE=${1:-}; [ "$MODE" = --check ] || [ "$MODE" = --stop ] || { echo "usage: eu-source-stop.sh --check | --stop"; exit 2; }
need_root

# ---- 0. preconditions (read-only)
problems=()
frag=$(show FragmentPath); act=$(show ActiveState); ufs=$(show UnitFileState)
echo "unit $UNIT: ActiveState=$act UnitFileState=$ufs FragmentPath=$frag"
[ "$frag" = "$UNIT_PATH" ] || [ "$frag" = "/etc/systemd/system/$UNIT" ] || problems+=("FragmentPath is '$frag', not $UNIT_PATH")
if [ -f "$UNIT_PATH" ] && [ ! -L "$UNIT_PATH" ]; then
  u=$(sha "$UNIT_PATH"); echo "unit file sha256 $u (reviewed $UNIT_SHA)"; [ "$u" = "$UNIT_SHA" ] || problems+=("the unit file is $u, not the reviewed $UNIT_SHA")
else problems+=("$UNIT_PATH is not a regular unit file"); fi
if [ -f "$ENV_FILE" ]; then e=$(sha "$ENV_FILE"); echo "relay.env sha256 $e (reviewed $ENV_SHA)"; [ "$e" = "$ENV_SHA" ] || problems+=("relay.env is $e, not the reviewed $ENV_SHA"); else problems+=("$ENV_FILE is absent"); fi
if key_ok; then echo "key file: present, $(stat -c '%s bytes, mode %a, owner %U' "$KEY") (content not read)"; else problems+=("the key file is not a non-empty 0600 root-owned regular file"); fi
shape=$(state_shape); echo "send record: $shape"
case "$shape" in absent|"not a send record") problems+=("the send record is $shape: it must exist and travel with the key") ;; esac
[ -e "$MIG" ] && problems+=("$MIG already exists (an earlier run): inspect it; nothing is reused")
[ "$act" = active ] || echo "note: the unit is not active now ($act)"
if [ ${#problems[@]} -gt 0 ]; then for p in "${problems[@]}"; do echo "PRECONDITION FAILED: $p"; done; echo "NOTHING CHANGED"; exit 2; fi
if [ "$MODE" = --check ]; then echo "CHECK OK: every precondition holds (read-only; nothing changed)"; exit 0; fi

fail() { journal "FAILED at $1: $2"; echo "STOP INCOMPLETE at step $1: $2"
  if [ -f "$MIG/state-at-stop.sha256" ]; then echo "the stopped journal WAS captured (state-at-stop.sha256)"; else echo "no stopped journal was captured (the stop was not verified); no receipt is written"; fi
  echo "the service is NOT restarted. To abort the move: sudo bash eu-source-restore.sh --abort-before-transfer"; exit 1; }
cas() { cas_unit_at "$UNIT_PATH" && cas_env || fail "$1" "the unit file or relay.env is no longer the reviewed bytes (checked right before this write)"; }
# ---- 1. protected rollback copy (create-only)
mkdir -m 0700 "$MIG" || { echo "could not create $MIG; NOTHING CHANGED"; exit 1; }
journal "step 1 begin; unit $UNIT_SHA"
cas 1
cp --no-clobber --preserve=mode,timestamps "$UNIT_PATH" "$MIG/unit.rollback" && chmod 0600 "$MIG/unit.rollback" || fail 1 "the rollback copy could not be written (the service still runs)"
[ "$(sha "$MIG/unit.rollback")" = "$UNIT_SHA" ] || fail 1 "the rollback copy is not the reviewed unit (the service still runs)"
( set -o noclobber; sha "$STATE" > "$MIG/state-pre-stop.sha256" ) || fail 1 "the pre-stop audit sha could not be written"
journal "step 1 done: unit.rollback; pre-stop record sha (audit only) $(cat "$MIG/state-pre-stop.sha256")"
# ---- 2. stop, verified on every channel; then the stopped journal
cas 2
systemctl stop "$UNIT" || true
for i in $(seq 1 30); do [ "$(show ActiveState)" != active ] && ! relay_process && ! listener && break; sleep 1; done
[ "$(show ActiveState)" != active ] || fail 2 "the unit is still active"
! relay_process || fail 2 "a lease-relay.mjs process still runs"
! listener || fail 2 "something still listens on :8549"
! answers_as_payee || fail 2 "something still answers /v1/info as $PAYEE (local or $FRONT)"
[ -f "$STATE" ] || fail 2 "the send record vanished during the stop"
( set -o noclobber; sha "$STATE" > "$MIG/state-at-stop.sha256" ) || fail 2 "the stopped journal sha could not be written"
journal "step 2 done: stopped; stopped journal sha $(cat "$MIG/state-at-stop.sha256") ($(state_shape))"
# ---- 3. disable
systemctl disable "$UNIT" >/dev/null 2>&1 || true
[ "$(show UnitFileState)" = disabled ] || fail 3 "the unit is $(show UnitFileState), not disabled (it is stopped)"
journal "step 3 done: disabled"
# ---- 4. move the unit FILE aside (no-clobber), only now
cas 4
mv --no-clobber -T "$UNIT_PATH" "$MIG/unit.moved" || fail 4 "the unit file could not be moved aside"
[ ! -e "$UNIT_PATH" ] && [ "$(sha "$MIG/unit.moved")" = "$UNIT_SHA" ] || fail 4 "the moved unit is not intact or the original is still in place"
journal "step 4 done: unit.moved"
# ---- 5. persistent mask
systemctl daemon-reload || fail 5 "daemon-reload failed (the unit file is moved aside, not yet masked)"
systemctl mask "$UNIT" >/dev/null 2>&1 || fail 5 "systemctl mask failed (the unit file is moved aside)"
systemctl daemon-reload || fail 5 "daemon-reload after mask failed"
masked_link && [ "$(show LoadState)" = masked ] && [ "$(show ActiveState)" != active ] || fail 5 "the unit is not masked and inactive (LoadState $(show LoadState))"
journal "step 5 done: masked"
# ---- 6. receipt (create-only), only for the record that IS the stopped journal
stopped=$(cat "$MIG/state-at-stop.sha256"); pre=$(cat "$MIG/state-pre-stop.sha256")
[ "$(sha "$STATE")" = "$stopped" ] || fail 6 "the send record changed AFTER the verified stop: no receipt (inspect it; the source is stopped and masked)"
shape=$(state_shape); changed=false; [ "$pre" = "$stopped" ] || changed=true
( set -o noclobber; printf '{"stoppedAt":"%s","unit":"%s","unitSha256":"%s","masked":true,"keyMoved":false,"stateSha256":"%s","stateShape":"%s","preStopStateSha256":"%s","journalChangedDuringStop":%s}\n' \
  "$(now)" "$UNIT" "$UNIT_SHA" "$stopped" "$shape" "$pre" "$changed" > "$MIG/stop-receipt.json" ) || fail 6 "the receipt could not be written (the source IS stopped and masked)"
journal "step 6 done: receipt"
[ "$changed" = true ] && say "note: an in-flight send settled during the stop; the stopped journal ($shape) is the authoritative one"
say "SOURCE STOPPED (masked; unit file kept at $MIG/unit.moved and $MIG/unit.rollback; key and send record in place). Send record: $shape"
