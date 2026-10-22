#!/usr/bin/env bash
# user-activate.sh - the operator user runs this on warden-host after user-transfer.sh printed "transferred". It starts main's
# lease relay HOST ROLE as the user service, with the MOVED key and journal - only when the moved journal is reconciled with
# the chain, and only for as long as the role answers as the moved payee.
#   bash user-activate.sh --check      READ-ONLY: every precondition
#   bash user-activate.sh --activate
# --activate, in order (any failure stops there and FAILS CLOSED; nothing is ever started twice):
#   0. preconditions: the staging receipt; the release verifies (every file); the installed config, the record and the
#      rendered unit are the staged bytes (CAS); the moved key and journal are present, 0600, owned by this user, regular,
#      not links, under an owned 0700 path (the key is never opened); relay.address is absent or exactly the moved payee;
#      no unit file or mask link; not active; nothing on :8549; the role never started here.
#   1. relay.address = the moved payee (create-only). It is a label: the relay serves the key's own address, so step 5
#      checks the running relay. (The unit has no `init`: a missing key can never be replaced by a new one.)
#   2. the migration gate (the release's lease-relay-migration-check.mjs) with an EXPLICIT environment: the staged config's
#      public relay settings, STATE = the moved journal, EXPECTED_PAYEE, SOURCE_ORIGIN = eu-central's https front (must not
#      answer as the payee). It proves from the chain that the journal is reconciled with the key's nonce.
#   3. target-ever-started is written create-only BEFORE anything can start. From then on this host's journal is the key's
#      journal (rollback: user-out-of-service.sh, user-journal-back.sh, eu-source-restore.sh --after-target-start).
#   4. the rendered unit is installed create-only, daemon-reload, start (NOT enable yet).
#   5. within a bound (120 s) GET http://127.0.0.1:8549/v1/info must answer as EXACTLY the moved payee, chain 8453 and the
#      record's reserve and executor. A wrong answer: stop, move the unit aside, mask, exit 4. No answer (a start failure,
#      or the platform host policy refusing this host): stop, disable, exit 1 - the key and journal stay, untouched.
#   6. enable; activate-receipt.json.
set -euo pipefail
. "$(dirname "$0")/user-common.sh"
MODE=${1:-}; [ "$MODE" = --check ] || [ "$MODE" = --activate ] || { echo "usage: user-activate.sh --check | --activate"; exit 2; }
[ $# -eq 1 ] || { echo "usage: user-activate.sh --check | --activate"; exit 2; }
need_user

problems=()
[ -f "$MIG/staging-receipt.json" ] || problems+=("no complete staging (user-stage.sh --stage): an incomplete stage never starts")
owned_dir "$MIG" && chain_ok "$MIG" || problems+=("$MIG is not this user's 0700 directory (owned by uid $EXPECTED_UID, no symlink)")
if [ ${#problems[@]} -eq 0 ]; then
  r=$(verify_release 2>&1 | tail -1); echo "release: $r"; [[ "$r" == "release $(release_id) verified"* ]] || problems+=("release: $r")
  owned_file "$CONFIG" && [ "$(sha "$CONFIG")" = "$(cat "$MIG/config.sha256")" ] || problems+=("$CONFIG is not the staged configuration")
  owned_file "$RECORD" && [ "$(sha "$RECORD")" = "$RECORD_SHA" ] || problems+=("the deployment record is not $RECORD_SHA")
  rc=$(cat "$MIG/staging-receipt.json")
  owned_file "$MIG/$UNIT.staged" && [[ "$rc" == *"\"unitStagedSha256\":\"$(sha "$MIG/$UNIT.staged")\""* ]] || problems+=("the rendered unit is not the staged one")
  chain_ok "$DIR" && owned_dir "$DIR" || problems+=("$DIR is not this user's 0700 directory under an owned path")
  if owned_file "$KEY"; then echo "moved key: present, $(stat -c '%s bytes, mode %a, uid %u' "$KEY") (content not read)"; else problems+=("the moved key is not a non-empty 0600 regular file owned by uid $EXPECTED_UID at $KEY"); fi
  shape=$(state_shape); echo "moved send record: $shape"
  owned_file "$STATE" || problems+=("the moved send record is not a non-empty 0600 regular file owned by uid $EXPECTED_UID at $STATE")
  case "$shape" in absent|"not a send record") problems+=("the moved send record is $shape") ;; esac
  if [ -e "$ADDR" ] || [ -L "$ADDR" ]; then owned_file "$ADDR" && [ "$(cat "$ADDR")" = "$PAYEE" ] || problems+=("$ADDR names another address or is not this user's file"); fi
  extra=$(ls -A "$DIR" 2>/dev/null | grep -vxE 'relay\.key|relay-send\.json|relay\.address' || true); [ -z "$extra" ] || problems+=("$DIR holds other files: $(echo $extra | head -c 120)")
fi
[ ! -e "$UNIT_PATH" ] && [ ! -L "$UNIT_PATH" ] || problems+=("$UNIT_PATH exists (installed, or masked by an earlier run)")
[ "$(show ActiveState)" != active ] || problems+=("$UNIT is active")
! listener || problems+=("something already listens on :$PORT")
[ ! -e "$EVER_STARTED" ] || problems+=("the role already started here once ($EVER_STARTED): a second activation needs a new review")
if [ ${#problems[@]} -gt 0 ]; then for p in "${problems[@]}"; do echo "PRECONDITION FAILED: $p"; done; echo "NOTHING CHANGED"; exit 2; fi
if [ "$MODE" = --check ]; then echo "CHECK OK: every precondition holds (read-only; nothing changed)"; exit 0; fi

fail() { journal "activate FAILED at $1: $2"; echo "ACTIVATION INCOMPLETE at step $1: $2"; exit "${3:-1}"; }
stop_closed() {   # the role must not run: stop, disable; with $1 = mask also move the unit aside and mask it
  "${SYSTEMCTL[@]}" stop "$UNIT" >/dev/null 2>&1 || true; "${SYSTEMCTL[@]}" disable "$UNIT" >/dev/null 2>&1 || true
  if [ "${1:-}" = mask ] && [ -f "$UNIT_PATH" ] && [ ! -L "$UNIT_PATH" ]; then mv --no-clobber -T "$UNIT_PATH" "$MIG/unit.refused" && "${SYSTEMCTL[@]}" daemon-reload && "${SYSTEMCTL[@]}" mask "$UNIT" >/dev/null 2>&1 || true; fi
  for i in $(seq 1 30); do [ "$(show ActiveState)" != active ] && ! listener && break; sleep 1; done
  [ "$(show ActiveState)" != active ] && ! listener && echo "the role is STOPPED$([ "${1:-}" = mask ] && masked_link && echo ' and masked')" || echo "WARNING: the role did not verifiably stop: stop it by hand (systemctl --user stop $UNIT)"; }
umask 077
journal "activate begin; journal $shape; release $(release_id)"
# ---- 1. the payee label
[ -e "$ADDR" ] || ( set -o noclobber; printf '%s\n' "$PAYEE" > "$ADDR" ) || fail 1 "relay.address could not be written"
chmod 0600 "$ADDR"; [ "$(cat "$ADDR")" = "$PAYEE" ] && owned_file "$ADDR" || fail 1 "relay.address is not the moved payee"
# ---- 2. the gate (explicit environment: public settings from the staged config, nothing inherited)
env -i PATH=/usr/bin:/bin LEASE_RELAY_RECORD="$RECORD" LEASE_RELAY_DIGEST="$(cfg relay.digest)" LEASE_RELAY_RPCS="$(cfg relay.rpc)" LEASE_RELAY_QUORUM="$(cfg relay.quorum)" \
  LEASE_RELAY_MAX_FLOAT_ETH="$(cfg relay.maxFloatEth)" LEASE_RELAY_STATE="$STATE" LEASE_RELAY_EXPECTED_PAYEE="$PAYEE" LEASE_RELAY_SOURCE_ORIGIN="$SOURCE_ORIGIN" \
  "$NODE" "$(gate_path)" || fail 2 "the migration gate did not pass (nothing started; the moved files are untouched)" 2
journal "step 2 done: gate passed"
# ---- 3. from here on this host's journal is the key's journal
( set -o noclobber; printf '{"at":"%s","stateSha256":"%s","stateShape":"%s","release":"%s"}\n' "$(now)" "$(sha "$STATE")" "$shape" "$(release_id)" > "$EVER_STARTED" ) || fail 3 "the target-ever-started marker could not be written (nothing started)"
journal "step 3 done: target-ever-started"
# ---- 4. install the rendered unit (create-only) and start it, not yet enabled
cp "$MIG/$UNIT.staged" "$UNIT_PATH.activate-tmp" && chmod 0600 "$UNIT_PATH.activate-tmp" && [ "$(sha "$UNIT_PATH.activate-tmp")" = "$(sha "$MIG/$UNIT.staged")" ] || fail 4 "the unit could not be staged"
mv --no-clobber -T "$UNIT_PATH.activate-tmp" "$UNIT_PATH" && [ ! -e "$UNIT_PATH.activate-tmp" ] && [ "$(sha "$UNIT_PATH")" = "$(sha "$MIG/$UNIT.staged")" ] || fail 4 "the unit could not be installed"
"${SYSTEMCTL[@]}" daemon-reload || fail 4 "daemon-reload failed (nothing started)"
"${SYSTEMCTL[@]}" start "$UNIT" || { stop_closed; fail 4 "systemctl --user start failed (see journalctl --user -u $UNIT)"; }
journal "step 4 done: started"
# ---- 5. it must answer as exactly the moved payee, for this deployment (bounded)
want=$("$NODE" -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log([8453,r.reserve,r.executor].join(" ").toLowerCase())' "$RECORD")
ans=""; wait_s=${ACTIVATE_ANSWER_WAIT_S:-120}; [[ "$wait_s" =~ ^[0-9]{1,3}$ ]] && [ "$wait_s" -le 120 ] || wait_s=120
for i in $(seq 1 "$wait_s"); do ans=$(curl -fsS --max-time 5 "$INFO_URL" 2>/dev/null || true); [ -n "$ans" ] && break; sleep 1; done
[ -n "$ans" ] || { stop_closed; fail 5 "the role did not answer $INFO_URL within $wait_s s (a start failure, or the platform host policy refusing this host: journalctl --user -u $UNIT)"; }
got=$(printf '%s' "$ans" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log([j.chainId,j.reserve,j.executor].join(" ").toLowerCase()+"|"+String(j.payee||""))}catch{console.log("unparsable|")}})')
if [ "$(echo "${got#*|}" | lc)" != "$(echo "$PAYEE" | lc)" ] || [ "${got%%|*}" != "$want" ]; then
  stop_closed mask; fail 5 "REFUSED: the role answered as '${got#*|}' for '${got%%|*}', not the moved payee $PAYEE for '$want'" 4
fi
journal "step 5 done: answers as $PAYEE"
# ---- 6. enable; receipt
"${SYSTEMCTL[@]}" enable "$UNIT" >/dev/null 2>&1 || fail 6 "systemctl --user enable failed (the role runs, answering as the payee; enable it by hand)"
( set -o noclobber; printf '{"activatedAt":"%s","unit":"%s","unitSha256":"%s","release":"%s","configSha256":"%s","payee":"%s","info":"%s","journalAtStart":"%s"}\n' \
  "$(now)" "$UNIT" "$(sha "$UNIT_PATH")" "$(release_id)" "$(sha "$CONFIG")" "$PAYEE" "$INFO_URL" "$shape" > "$MIG/activate-receipt.json" ) || true
journal "activate done"
say "ACTIVATED: $UNIT (user) enabled and active, answering $INFO_URL as $PAYEE (journal at start: $shape)"
