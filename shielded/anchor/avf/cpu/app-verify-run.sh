#!/usr/bin/env bash
# app-verify-run.sh <out_dir> <apk> <code_hash> -- the LAB client-verified channel on the phone (PVM-CPU.md; NOT production,
# test signing): the client verifies the pVM ITSELF (its own nonce, its own pins) and takes nothing from the relay but bytes
# (cpu/app-verify-client.mjs); a malicious relay (cpu/evil-relay.mjs) tries replayed evidence, its own key, a forged chain
# from its own CA, and its own TLS; the client must refuse each before sending a request.
#   launch 1: honest ok (evidence saved) | evil replay | evil swap-key | evil own-ca | evil mitm-tls | evil pass (control) |
#             wrong app expected | wrong runtime pinned | termination (after STOP: no evidence, nothing sent)
#   launch 2 (reconnect): ok with the new boot's key; launch 1's evidence replayed: refused
set -uo pipefail
OUT="$1"; APK="$2"; CODE="$3"; H="$(cd "$(dirname "$0")/.." && pwd)"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; P=host.enclave.anchor.avf
V="$H/runtime/conformance"; BUNDLE="$V/bundles/ggml-probe.wasm"; GRAPH="${GRAPH:-gemma-4-e2b-it-q4_0}"; NAME=pixel10-pvm-cpu
F=/data/user/0/$P/files; PORT=18443; APPPORT=18445; EVPORT=18446; RUN_ID="${RUN_ID:-$(date +%m%d%H%M%S)}"
AUTH=cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f   # gitleaks:allow -- public, not a secret: sha512 of the TEST APK signing certificate (pins.py), in every attestation chain
APPID=$(sha256sum "$BUNDLE" | cut -c1-64); HELLO=$(sha256sum "$V/bundles/hello-v1.wasm" | cut -c1-64); REQ="/?graph=$GRAPH&steps=8"
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
mkdir -p "$OUT" || exit 2
log() { echo "$(date +%T) $*" | tee -a "$OUT/run.log"; }
want=$(sha256sum "$APK" | cut -c1-64); have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64)
if [ "$want" != "$have" ]; then timeout 300 "$ADB" install -r "$APK" </dev/null >/dev/null 2>&1 || { log "install failed"; exit 2; }
  have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64); fi
[ "$want" = "$have" ] || { log "installed APK $have is not $want"; exit 2; }
log "apk $want installed; the CLIENT pins code hash $CODE, app $APPID, the pVM runtime, Google's roots"
"$ADB" push "$BUNDLE" /data/local/tmp/app-ggml-probe.wasm </dev/null >/dev/null && sh_ "run-as $P cp /data/local/tmp/app-ggml-probe.wasm files/app-ggml-probe.wasm" >/dev/null
( cd "$H" && exec node cpu/local-hub.mjs --port $PORT --code-hash "$CODE" --authority $AUTH \
    --model-sha 5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48 --selftest-sha 9c4c7f764bf657c708cb19c6493a0be303db49093fd7df1432664cfd3801ce2f \
    --min-tok-s 10 --app-id "$APPID" --app-port $APPPORT --evidence-port $EVPORT --app-name $NAME --seconds 1800 > "$OUT/hub.jsonl" 2> "$OUT/hub.err" ) &
HUB=$!; sleep 2
"$ADB" reverse tcp:$PORT tcp:$PORT >/dev/null || { log "adb reverse failed"; kill $HUB; exit 2; }
EVIL=""
cleanup() { [ -n "$EVIL" ] && kill $EVIL 2>/dev/null; kill $HUB 2>/dev/null; "$ADB" reverse --remove tcp:$PORT >/dev/null 2>&1; }
trap cleanup EXIT
VC() { node "$H/cpu/app-verify-client.mjs" --app "$APPID" --code-hash "$CODE" --authority $AUTH --path "$REQ" "$@" | tee -a "$OUT/client.jsonl"; }
HONEST=(--evidence 127.0.0.1:$EVPORT --app-endpoint 127.0.0.1:$APPPORT)
THROUGH_EVIL=(--evidence 127.0.0.1:18456 --app-endpoint 127.0.0.1:18455)
evil() {   # evil <mode> [args]: a malicious relay in front of the honest hub
  [ -n "$EVIL" ] && { kill $EVIL 2>/dev/null; wait $EVIL 2>/dev/null; }
  ( cd "$H" && exec node cpu/evil-relay.mjs --mode "$1" --evidence-listen 18456 --app-listen 18455 --evidence-up 127.0.0.1:$EVPORT --app-up 127.0.0.1:$APPPORT \
      --code-hash "$CODE" --app "$APPID" "${@:2}" >> "$OUT/evil.jsonl" 2>> "$OUT/evil.err" ) & EVIL=$!; sleep 2; }
launch() {
  local l="$RUN_ID-$1"
  [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$l.log && echo USED'")" = USED ] && { log "$l: label used"; return 1; }
  sh_ "am force-stop $P; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard" >/dev/null; sleep 2
  local pw; pw=$(sh_ "dumpsys power"); grep -q 'mWakefulness=Awake' <<<"$pw" || { log "PHONE NOT AWAKE"; return 1; }
  sh_ "am start -S -n $P/.Main --es mode app --es vmname anchorlocal --es model $F/model.gguf --es app $F/app-ggml-probe.wasm --es app_graph $GRAPH --ei app_tls 1 --ei app_serve_s ${SERVE_S:-200} --es relay ws://127.0.0.1:$PORT/v1/fleet-tunnel --es name $NAME --es capture $l" > "$OUT/$1.am"
  LABEL=$l; local t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt 400 ]; do
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep 'APP evidence endpoint on vsock')" ] && { log "$1: the VM serves https and answers evidence ($(( $(date +%s) - t0 )) s)"; return 0; }
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep '^CAPTURE END')" ] && { log "$1: the run ended before serving"; return 1; }
    sleep 5; done
  log "$1: not serving within 400 s"; return 1; }
fetch() { sh_ "run-as $P cat files/capture/$1.log" > "$OUT/$2.log"; }
wait_end() { local t0=$(date +%s); while [ $(( $(date +%s) - t0 )) -lt 400 ]; do [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$1.complete && echo Y'")" = Y ] && return 0; sleep 5; done; return 1; }
pause() { sleep 3; }   # the VM answers evidence at most once every 2 s

log "== launch 1"
launch l1 || exit 1; L1=$LABEL
VC "${HONEST[@]}" --label honest-ok --save-evidence "$OUT/l1-evidence.json"; pause
evil replay --replay "$OUT/l1-evidence.json"; VC "${THROUGH_EVIL[@]}" --label evil-replay; pause
evil swap-key; VC "${THROUGH_EVIL[@]}" --label evil-swap-key; pause
evil own-ca; VC "${THROUGH_EVIL[@]}" --label evil-own-ca; pause
evil mitm-tls; VC "${THROUGH_EVIL[@]}" --label evil-mitm-tls; pause
evil pass; VC "${THROUGH_EVIL[@]}" --label evil-pass-control; pause
kill $EVIL 2>/dev/null; EVIL=""
node "$H/cpu/app-verify-client.mjs" --app "$HELLO" --code-hash "$CODE" --authority $AUTH --path "$REQ" "${HONEST[@]}" --label wrong-app | tee -a "$OUT/client.jsonl"; pause
VC "${HONEST[@]}" --label wrong-runtime --runtime-id "$(printf 'a%.0s' $(seq 64))"; pause
log "termination: waiting for the lab STOP and the run's end"
wait_end "$L1" || log "launch 1 did not end in time"; fetch "$L1" l1; sleep 3
VC "${HONEST[@]}" --label after-termination

log "== launch 2 (reconnect)"
launch l2 || exit 1; L2=$LABEL
VC "${HONEST[@]}" --label reconnect-ok --save-evidence "$OUT/l2-evidence.json"; pause
evil replay --replay "$OUT/l1-evidence.json"; VC "${THROUGH_EVIL[@]}" --label reconnect-old-evidence
kill $EVIL 2>/dev/null; EVIL=""
wait_end "$L2" || log "launch 2 did not end in time"; fetch "$L2" l2
cleanup; trap - EXIT; sleep 1
python3 "$V/check-app-verify.py" "$OUT"
