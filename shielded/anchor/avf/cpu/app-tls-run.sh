#!/usr/bin/env bash
# app-tls-run.sh <out_dir> <apk> <code_hash> -- the LAB serving prototype on the phone (PVM-CPU.md; NOT production, test signing):
# a portable app (enclave-apps' ggml-probe, bytes unchanged) served over TLS 1.3 terminating INSIDE the pVM with its attested
# transport key, reached through the relay's own hub (cpu/local-hub.mjs, on this machine) and the phone's Android app,
# which forwards opaque bytes. The hub issues the fresh nonce and verifies the app's ABI/2 evidence itself; the client pins
# the key the hub verified before it sends a byte (cpu/app-tls-client.mjs).
#   launch 1: ok (recorded) | wrong-pin | tamper | replay | plaintext | ok again | termination (after STOP: refused)
#   launch 2 (reconnect): a new boot, a new nonce, a new key: ok with it, the first boot's key refused
# Then: neither the Android captures nor the hub's log may hold the request or the response in the clear.
set -uo pipefail
OUT="$1"; APK="$2"; CODE="$3"; H="$(cd "$(dirname "$0")/.." && pwd)"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; P=host.enclave.anchor.avf
V="$H/runtime/conformance"; BUNDLE="$V/bundles/ggml-probe.wasm"; GRAPH="${GRAPH:-gemma-4-e2b-it-q4_0}"; NAME=pixel10-pvm-cpu
F=/data/user/0/$P/files; PORT=18443; APPPORT=18445; RUN_ID="${RUN_ID:-$(date +%m%d%H%M%S)}"
AUTH=cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f   # gitleaks:allow -- public, not a secret: sha512 of the TEST APK signing certificate (pins.py), in every attestation chain
APPID=$(sha256sum "$BUNDLE" | cut -c1-64); REQ="/?graph=$GRAPH&steps=8"
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
mkdir -p "$OUT" || exit 2
log() { echo "$(date +%T) $*" | tee -a "$OUT/run.log"; }
want=$(sha256sum "$APK" | cut -c1-64); have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64)
if [ "$want" != "$have" ]; then timeout 300 "$ADB" install -r "$APK" </dev/null >/dev/null 2>&1 || { log "install failed"; exit 2; }
  have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64); fi
[ "$want" = "$have" ] || { log "installed APK $have is not $want"; exit 2; }
log "apk $want installed (hashed on the device); code hash pinned by the hub: $CODE; app $APPID"
"$ADB" push "$BUNDLE" /data/local/tmp/app-ggml-probe.wasm </dev/null >/dev/null && sh_ "run-as $P cp /data/local/tmp/app-ggml-probe.wasm files/app-ggml-probe.wasm" >/dev/null
# the hub (lab), and the phone's way to it
( cd "$H" && exec node cpu/local-hub.mjs --port $PORT --code-hash "$CODE" --authority $AUTH \
    --model-sha 5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48 --selftest-sha 9c4c7f764bf657c708cb19c6493a0be303db49093fd7df1432664cfd3801ce2f \
    --min-tok-s 10 --app-id "$APPID" --app-port $APPPORT --app-name $NAME --seconds 1500 > "$OUT/hub.jsonl" 2> "$OUT/hub.err" ) &
HUB=$!; sleep 2
"$ADB" reverse tcp:$PORT tcp:$PORT >/dev/null || { log "adb reverse failed"; kill $HUB; exit 2; }
cleanup() { kill $HUB 2>/dev/null; "$ADB" reverse --remove tcp:$PORT >/dev/null 2>&1; }
trap cleanup EXIT
C() { node "$H/cpu/app-tls-client.mjs" --hub http://127.0.0.1:$PORT --name $NAME --app-port $APPPORT --path "$REQ" "$@"; }
launch() {   # launch <label>: start the app, wait until the VM serves https and the hub has verified the app
  local l="$RUN_ID-$1"
  [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$l.log && echo USED'")" = USED ] && { log "$l: label used"; return 1; }
  sh_ "am force-stop $P; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard" >/dev/null; sleep 2
  local pw; pw=$(sh_ "dumpsys power"); grep -q 'mWakefulness=Awake' <<<"$pw" || { log "PHONE NOT AWAKE"; return 1; }
  sh_ "am start -S -n $P/.Main --es mode app --es vmname anchorlocal --es model $F/model.gguf --es app $F/app-ggml-probe.wasm --es app_graph $GRAPH --ei app_tls 1 --ei app_serve_s ${SERVE_S:-120} --es relay ws://127.0.0.1:$PORT/v1/fleet-tunnel --es name $NAME --es capture $l" > "$OUT/$1.am"
  LABEL=$l; local t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt 400 ]; do
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep 'APP serving https')" ] && { log "$1: the VM serves https ($(( $(date +%s) - t0 )) s)"; return 0; }
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep '^CAPTURE END')" ] && { log "$1: the run ended before serving"; return 1; }
    sleep 5; done
  log "$1: no 'APP serving https' within 400 s"; return 1; }
fetch() { sh_ "run-as $P cat files/capture/$1.log" > "$OUT/$2.log"; }
wait_end() { local t0=$(date +%s); while [ $(( $(date +%s) - t0 )) -lt 300 ]; do [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$1.complete && echo Y'")" = Y ] && return 0; sleep 5; done; return 1; }

log "== launch 1"
launch l1 || exit 1; L1=$LABEL
curl -s http://127.0.0.1:$PORT/pvm-app/$NAME > "$OUT/pvm-app-l1.json"; log "hub: $(cat "$OUT/pvm-app-l1.json")"
C --mode ok --record "$OUT/l1-session.json" | tee -a "$OUT/client.jsonl"
C --mode wrong-pin | tee -a "$OUT/client.jsonl"
C --mode tamper | tee -a "$OUT/client.jsonl"
C --mode replay --record "$OUT/l1-session.json" | tee -a "$OUT/client.jsonl"
C --mode plaintext | tee -a "$OUT/client.jsonl"
C --mode ok | tee -a "$OUT/client.jsonl"
log "termination: waiting for the lab STOP and the run's end"
wait_end "$L1" || log "launch 1 did not end within 300 s"; fetch "$L1" l1; sleep 3
C --mode ok | sed 's/"mode":"ok"/"mode":"after-termination"/' | tee -a "$OUT/client.jsonl"

log "== launch 2 (reconnect)"
KEY1=$(python3 -c "import json;print(json.load(open('$OUT/pvm-app-l1.json'))['transportSpki'])")
launch l2 || exit 1; L2=$LABEL
curl -s http://127.0.0.1:$PORT/pvm-app/$NAME > "$OUT/pvm-app-l2.json"; log "hub: $(cat "$OUT/pvm-app-l2.json")"
C --mode ok | sed 's/"mode":"ok"/"mode":"reconnect-ok"/' | tee -a "$OUT/client.jsonl"
C --mode ok --pin "$KEY1" | sed 's/"mode":"ok"/"mode":"reconnect-old-key"/' | tee -a "$OUT/client.jsonl"
# the tamper case again on this boot (the check judges this one): the 2026-09-23 run's launch-1 carrier did not tamper
C --mode tamper | sed 's/"mode":"tamper"/"mode":"tamper-l2"/' | tee -a "$OUT/client.jsonl"
wait_end "$L2" || log "launch 2 did not end within 300 s"; fetch "$L2" l2
cleanup; trap - EXIT; sleep 1
python3 "$V/check-app-tls.py" "$OUT"
