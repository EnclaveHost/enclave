#!/usr/bin/env bash
# warden-activate.sh - ROOT runs this ON warden after transfer-to-warden.sh printed "transferred". It starts main's lease
# relay HOST ROLE with the MOVED key and journal - only when the moved journal is reconciled with the chain, and only for as
# long as the role answers as the moved payee.
#   sudo bash warden-activate.sh --check      READ-ONLY: every precondition
#   sudo bash warden-activate.sh --activate
# --activate, in order (any failure stops there and FAILS CLOSED; nothing is ever started twice):
#   0. preconditions: the staging receipt; the installed config, package, record, staged unit and gate are the staged bytes
#      (CAS); the moved key and journal are present (0600, root; the key is never opened); relay.address is absent or
#      exactly the moved payee; no unit file; not active; nothing on :8549; the role never started here before.
#   1. relay.address is written create-only = the moved payee. The role's `init` then KEEPS the moved key (it generates one
#      only when relay.key is absent) - but relay.address is only a label: the payee the relay serves is derived from the
#      key itself, so step 5 checks the running relay, not this file.
#   2. the migration gate (main's lease-relay-migration-check.mjs, 80d64e2f) with an EXPLICIT environment: the staged
#      config's public relay settings, STATE = the moved journal, EXPECTED_PAYEE, SOURCE_ORIGIN = eu-central's https front
#      (must NOT answer as the payee). It proves from the chain that the journal is reconciled with the key's nonce.
#   3. $EVER_STARTED is written create-only - BEFORE anything can start. From then on this host's journal is the key's
#      journal (rollback: warden-out-of-service.sh, transfer-journal-back.sh, eu-source-restore.sh --after-target-start).
#   4. the reviewed unit is installed create-only (sha d279eb49), daemon-reload, start (NOT enable yet).
#   5. within 120 s the role must answer GET /v1/info at its bind as EXACTLY the moved payee, chain 8453 and the record's
#      reserve and executor. A wrong answer: stop, move the unit aside, mask, exit 4. No answer (a start failure, or the
#      platform host policy refusing this host): stop, disable, exit 1 - the key and journal stay here, untouched.
#   6. enable; activate-receipt.json.
set -euo pipefail
. "$(dirname "$0")/warden-common.sh"
MODE=${1:-}; [ "$MODE" = --check ] || [ "$MODE" = --activate ] || { echo "usage: warden-activate.sh --check | --activate"; exit 2; }
need_root

problems=()
[ -f "$MIG/staging-receipt.json" ] || problems+=("no staging receipt (warden-stage.sh --stage)")
[ -f "$CONFIG" ] && [ -f "$MIG/config.sha256" ] && [ "$(sha "$CONFIG")" = "$(cat "$MIG/config.sha256")" ] || problems+=("$CONFIG is not the staged configuration")
[ -f "$PKG_DIR/lease-relay.package.json" ] && [ "sha256:$(sha "$PKG_DIR/lease-relay.package.json")" = "$PKG_PIN" ] || problems+=("the package manifest is not $PKG_PIN")
[ -f "$PKG_DIR/lease-relay.mjs" ] && [ "$(sha "$PKG_DIR/lease-relay.mjs")" = "$BUNDLE_SHA" ] || problems+=("the package bundle is not $BUNDLE_SHA")
[ -f "$RECORD" ] && [ "$(sha "$RECORD")" = "$RECORD_SHA" ] || problems+=("the deployment record is not $RECORD_SHA")
[ -f "$STAGED_UNIT" ] && [ "$(sha "$STAGED_UNIT")" = "$UNIT_SHA" ] || problems+=("the staged unit is not $UNIT_SHA")
[ -f "$GATE" ] && [ "$(sha "$GATE")" = "$GATE_SHA" ] || problems+=("the staged gate is not $GATE_SHA")
[ -f "$REPO/network/host-services/lease-relay-host.mjs" ] && [ "$(sha "$REPO/network/host-services/lease-relay-host.mjs")" = "$HOST_MJS_SHA" ] || problems+=("the role supervisor in $REPO is not main's $HOST_MJS_SHA")
if moved_ok "$KEY"; then echo "moved key: present, $(stat -c '%s bytes, mode %a, owner %U' "$KEY") (content not read)"; else problems+=("the moved key is not a non-empty 0600 root-owned regular file at $KEY"); fi
shape=$(state_shape); echo "moved send record: $shape"
moved_ok "$STATE" || problems+=("the moved send record is not a non-empty 0600 root-owned regular file at $STATE")
case "$shape" in absent|"not a send record") problems+=("the moved send record is $shape") ;; esac
if [ -e "$ADDR" ]; then [ "$(cat "$ADDR")" = "$PAYEE" ] || problems+=("$ADDR names another address"); fi
extra=$(ls -A "$DIR" 2>/dev/null | grep -vxE 'relay\.key|relay-send\.json|relay\.address' || true); [ -z "$extra" ] || problems+=("$DIR holds other files: $(echo $extra | head -c 120)")
[ ! -e "$UNIT_PATH" ] && [ ! -L "$UNIT_PATH" ] || problems+=("$UNIT_PATH exists (installed, or masked by an earlier run)")
[ "$(show ActiveState)" != active ] || problems+=("$UNIT is active")
! listener || problems+=("something already listens on :$PORT")
[ ! -e "$EVER_STARTED" ] || problems+=("the role already started here once ($EVER_STARTED): a second activation needs a new review")
if [ ${#problems[@]} -gt 0 ]; then for p in "${problems[@]}"; do echo "PRECONDITION FAILED: $p"; done; echo "NOTHING CHANGED"; exit 2; fi
if [ "$MODE" = --check ]; then echo "CHECK OK: every precondition holds (read-only; nothing changed)"; exit 0; fi

fail() { journal "activate FAILED at $1: $2"; echo "ACTIVATION INCOMPLETE at step $1: $2"; exit "${3:-1}"; }
stop_closed() {   # the role must not run: stop, disable; with $1 = mask also move the unit aside and mask it
  systemctl stop "$UNIT" >/dev/null 2>&1 || true; systemctl disable "$UNIT" >/dev/null 2>&1 || true
  if [ "${1:-}" = mask ] && [ -f "$UNIT_PATH" ] && [ ! -L "$UNIT_PATH" ]; then mv --no-clobber -T "$UNIT_PATH" "$MIG/unit.refused" && systemctl daemon-reload && systemctl mask "$UNIT" >/dev/null 2>&1 || true; fi
  for i in $(seq 1 30); do [ "$(show ActiveState)" != active ] && ! listener && break; sleep 1; done
  [ "$(show ActiveState)" != active ] && ! listener && echo "the role is STOPPED$([ "${1:-}" = mask ] && masked_link && echo ' and masked')" || echo "WARNING: the role did not verifiably stop: stop it by hand (systemctl stop $UNIT)"; }
journal "activate begin; journal $shape"
# ---- 1. the payee label
[ -e "$ADDR" ] || ( set -o noclobber; printf '%s\n' "$PAYEE" > "$ADDR" && chmod 0644 "$ADDR" ) || fail 1 "relay.address could not be written"
[ "$(cat "$ADDR")" = "$PAYEE" ] || fail 1 "relay.address is not the moved payee"
# ---- 2. the gate (explicit environment: public settings from the staged config, nothing inherited)
env -i PATH="$PATH" LEASE_RELAY_RECORD="$RECORD" LEASE_RELAY_DIGEST="$(cfg relay.digest)" LEASE_RELAY_RPCS="$(cfg relay.rpc)" LEASE_RELAY_QUORUM="$(cfg relay.quorum)" \
  LEASE_RELAY_MAX_FLOAT_ETH="$(cfg relay.maxFloatEth)" LEASE_RELAY_STATE="$STATE" LEASE_RELAY_EXPECTED_PAYEE="$PAYEE" LEASE_RELAY_SOURCE_ORIGIN="$SOURCE_ORIGIN" \
  "$NODE" "$GATE" || fail 2 "the migration gate did not pass (nothing started; the moved files are untouched)" 2
journal "step 2 done: gate passed"
# ---- 3. from here on this host's journal is the key's journal
( set -o noclobber; printf '{"at":"%s","stateSha256":"%s","stateShape":"%s"}\n' "$(now)" "$(sha "$STATE")" "$shape" > "$EVER_STARTED" ) || fail 3 "the target-ever-started marker could not be written (nothing started)"
journal "step 3 done: target-ever-started"
# ---- 4. install the reviewed unit (create-only) and start it, not yet enabled
cp "$STAGED_UNIT" "$UNIT_PATH.activate-tmp" && chmod 0644 "$UNIT_PATH.activate-tmp" && [ "$(sha "$UNIT_PATH.activate-tmp")" = "$UNIT_SHA" ] || fail 4 "the unit could not be staged"
mv --no-clobber -T "$UNIT_PATH.activate-tmp" "$UNIT_PATH" && [ ! -e "$UNIT_PATH.activate-tmp" ] && [ "$(sha "$UNIT_PATH")" = "$UNIT_SHA" ] || fail 4 "the unit could not be installed"
systemctl daemon-reload || fail 4 "daemon-reload failed (nothing started)"
systemctl start "$UNIT" || { stop_closed; fail 4 "systemctl start failed (see journalctl -u $UNIT)"; }
journal "step 4 done: started"
# ---- 5. it must answer as exactly the moved payee, for this deployment
want=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log([8453,r.reserve,r.executor].join(" ").toLowerCase())' "$RECORD")
ans=""; wait_s=${ACTIVATE_ANSWER_WAIT_S:-120}
for i in $(seq 1 "$wait_s"); do ans=$(curl -fsS --max-time 5 "$(info_url)" 2>/dev/null || true); [ -n "$ans" ] && break; sleep 1; done
[ -n "$ans" ] || { stop_closed; fail 5 "the role did not answer $(info_url) within $wait_s s (a start failure, or the platform host policy refusing this host: journalctl -u $UNIT)"; }
got=$(printf '%s' "$ans" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log([j.chainId,j.reserve,j.executor].join(" ").toLowerCase()+"|"+String(j.payee||""))}catch{console.log("unparsable|")}})')
if [ "$(echo "${got#*|}" | lc)" != "$(echo "$PAYEE" | lc)" ] || [ "${got%%|*}" != "$want" ]; then
  stop_closed mask; fail 5 "REFUSED: the role answered as '${got#*|}' for '${got%%|*}', not the moved payee $PAYEE for '$want'" 4
fi
journal "step 5 done: answers as $PAYEE"
# ---- 6. enable; receipt
systemctl enable "$UNIT" >/dev/null 2>&1 || fail 6 "systemctl enable failed (the role runs, answering as the payee; enable it by hand)"
( set -o noclobber; printf '{"activatedAt":"%s","unitSha256":"%s","package":"%s","configSha256":"%s","payee":"%s","info":"%s","journalAtStart":"%s"}\n' \
  "$(now)" "$UNIT_SHA" "$PKG_PIN" "$(sha "$CONFIG")" "$PAYEE" "$(info_url)" "$shape" > "$MIG/activate-receipt.json" ) || true
journal "activate done"
say "ACTIVATED: $UNIT enabled and active, answering $(info_url) as $PAYEE (journal at start: $shape)"
