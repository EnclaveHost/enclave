#!/usr/bin/env bash
# app-browser-run.sh <out_dir> <apk> <code_hash> -- the LAB browser channel on the phone (PVM-CPU.md; NOT production, test
# signing): a REAL headless browser loads the lab page from the site (web/lab-site.mjs, an origin that is not the relay's),
# verifies the pVM's v2 evidence itself (its own nonce and pins, WebCrypto only) and seals its request to the VM's attested
# app key; the relay (the hub's web carrier) and the phone's Android app carry bytes. A malicious relay
# (cpu/evil-web-relay.mjs) tries replayed evidence, its own app key, a v1 downgrade, a forged chain from its own CA, a
# flipped request, a flipped response, a replayed request and another boot's request.
#   launch 1: chromium honest | evil pass (control; records) | evil replay | swap-appkey | downgrade | own-ca |
#             tamper-request | tamper-response | replay-sealed | wrong app | wrong runtime | firefox honest |
#             native TLS client on v2 evidence | termination (after STOP: no evidence, nothing sent)
#   launch 2 (reconnect): chromium honest (a new app key) | launch 1's evidence replayed | launch 1's sealed request replayed
set -uo pipefail
OUT="$1"; APK="$2"; CODE="$3"; H="$(cd "$(dirname "$0")/.." && pwd)"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; P=host.enclave.anchor.avf
V="$H/runtime/conformance"; BUNDLE="$V/bundles/ggml-probe.wasm"; GRAPH="${GRAPH:-gemma-4-e2b-it-q4_0}"; NAME=pixel10-pvm-cpu
F=/data/user/0/$P/files; PORT=18443; APPPORT=18445; EVPORT=18446; WEBPORT=18447; SEALPORT=18448; SITEPORT=18450; EVILPORT=18457
RUN_ID="${RUN_ID:-$(date +%m%d%H%M%S)}"
AUTH=cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f   # gitleaks:allow -- public, not a secret: sha512 of the TEST APK signing certificate (pins.py), in every attestation chain
APPID=$(sha256sum "$BUNDLE" | cut -c1-64); HELLO=$(sha256sum "$V/bundles/hello-v1.wasm" | cut -c1-64); REQ="/?graph=$GRAPH&steps=8"
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
[ -e "$OUT" ] && { echo "$OUT exists: refusing to mix runs"; exit 2; }
mkdir -p "$OUT" || exit 2
log() { echo "$(date +%T) $*" | tee -a "$OUT/run.log"; }
want=$(sha256sum "$APK" | cut -c1-64); have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64)
if [ "$want" != "$have" ]; then timeout 300 "$ADB" install -r "$APK" </dev/null >/dev/null 2>&1 || { log "install failed"; exit 2; }
  have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64); fi
[ "$want" = "$have" ] || { log "installed APK $have is not $want"; exit 2; }
log "apk $want installed; the PAGE pins code hash $CODE, app $APPID, the pVM runtime, Google's roots (served by the site, not the relay)"
"$ADB" push "$BUNDLE" /data/local/tmp/app-ggml-probe.wasm </dev/null >/dev/null && sh_ "run-as $P cp /data/local/tmp/app-ggml-probe.wasm files/app-ggml-probe.wasm" >/dev/null
( cd "$H" && exec node cpu/local-hub.mjs --port $PORT --code-hash "$CODE" --authority $AUTH \
    --model-sha 5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48 --selftest-sha 9c4c7f764bf657c708cb19c6493a0be303db49093fd7df1432664cfd3801ce2f \
    --min-tok-s 10 --app-id "$APPID" --app-port $APPPORT --evidence-port $EVPORT --sealed-port $SEALPORT --web-port $WEBPORT \
    --web-origin http://127.0.0.1:$SITEPORT --app-name $NAME --seconds 2400 > "$OUT/hub.jsonl" 2> "$OUT/hub.err" ) &
HUB=$!
( cd "$H" && exec node web/lab-site.mjs --port $SITEPORT --results "$OUT/results.jsonl" --app "$APPID" --code-hash "$CODE" --authority $AUTH \
    --connect "http://127.0.0.1:$WEBPORT http://127.0.0.1:$EVILPORT" > "$OUT/site.jsonl" 2> "$OUT/site.err" ) &
SITE=$!; sleep 2
"$ADB" reverse tcp:$PORT tcp:$PORT >/dev/null || { log "adb reverse failed"; kill $HUB $SITE; exit 2; }
EVIL=""
cleanup() { [ -n "$EVIL" ] && kill $EVIL 2>/dev/null; kill $HUB $SITE 2>/dev/null; "$ADB" reverse --remove tcp:$PORT >/dev/null 2>&1; }
trap cleanup EXIT
BR() { node "$H/cpu/browser-run.mjs" --site http://127.0.0.1:$SITEPORT/lab.html --results "$OUT/results.jsonl" --path "$REQ" "$@" >> "$OUT/browser.jsonl"; tail -1 "$OUT/browser.jsonl" | cut -c1-200 | tee -a "$OUT/run.log"; }
HONEST=(--relay http://127.0.0.1:$WEBPORT); EVILR=(--relay http://127.0.0.1:$EVILPORT)
evil() {   # evil <mode> [args]: a malicious relay in front of the honest hub's carrier
  [ -n "$EVIL" ] && { kill $EVIL 2>/dev/null; wait $EVIL 2>/dev/null; }
  ( cd "$H" && exec node cpu/evil-web-relay.mjs --mode "$1" --listen $EVILPORT --up http://127.0.0.1:$WEBPORT --origin http://127.0.0.1:$SITEPORT \
      --code-hash "$CODE" --app "$APPID" "${@:2}" >> "$OUT/evil.jsonl" 2>> "$OUT/evil.err" ) & EVIL=$!; sleep 2; }
launch() {
  local l="$RUN_ID-$1"
  [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$l.log && echo USED'")" = USED ] && { log "$l: label used"; return 1; }
  sh_ "am force-stop $P; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard" >/dev/null; sleep 2
  local pw; pw=$(sh_ "dumpsys power"); grep -q 'mWakefulness=Awake' <<<"$pw" || { log "PHONE NOT AWAKE"; return 1; }
  sh_ "am start -S -n $P/.Main --es mode app --es vmname anchorlocal --es model $F/model.gguf --es app $F/app-ggml-probe.wasm --es app_graph $GRAPH --ei app_tls 1 --ei app_serve_s ${SERVE_S:-300} --es relay ws://127.0.0.1:$PORT/v1/fleet-tunnel --es name $NAME --es capture $l" > "$OUT/$1.am"
  LABEL=$l; local t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt 400 ]; do
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep 'APP evidence endpoint on vsock')" ] && { log "$1: the VM serves https + sealed and answers evidence ($(( $(date +%s) - t0 )) s)"; return 0; }
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep '^CAPTURE END')" ] && { log "$1: the run ended before serving"; return 1; }
    sleep 5; done
  log "$1: not serving within 400 s"; return 1; }
fetch() { sh_ "run-as $P cat files/capture/$1.log" > "$OUT/$2.log"; }
wait_end() { local t0=$(date +%s); while [ $(( $(date +%s) - t0 )) -lt 500 ]; do [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$1.complete && echo Y'")" = Y ] && return 0; sleep 5; done; return 1; }
pause() { sleep 3; }   # the VM answers evidence at most once every 2 s

log "== launch 1"
launch l1 || exit 1; L1=$LABEL
BR --browser chromium "${HONEST[@]}" --label honest; pause
evil pass --record-evidence "$OUT/l1-evidence.json" --record-sealed "$OUT/l1-sealed.bin"; BR --browser chromium "${EVILR[@]}" --label evil-pass; pause
for m in replay swap-appkey downgrade own-ca tamper-request tamper-response replay-sealed; do
  evil $m --replay "$OUT/l1-evidence.json"; BR --browser chromium "${EVILR[@]}" --label evil-$m; pause; done
kill $EVIL 2>/dev/null; EVIL=""
BR --browser chromium "${HONEST[@]}" --label wrong-app --extra "&app=$HELLO"; pause
BR --browser chromium "${HONEST[@]}" --label wrong-runtime --extra "&runtime=$(printf 'a%.0s' $(seq 64))"; pause
BR --browser firefox "${HONEST[@]}" --label firefox-honest; pause
node "$H/cpu/app-verify-client.mjs" --app "$APPID" --code-hash "$CODE" --authority $AUTH --path "$REQ" --evidence 127.0.0.1:$EVPORT --app-endpoint 127.0.0.1:$APPPORT --label native-v2 | tee -a "$OUT/client.jsonl" | cut -c1-200
log "termination: waiting for the lab STOP and the run's end"
wait_end "$L1" || log "launch 1 did not end in time"; fetch "$L1" l1; sleep 3
BR --browser chromium "${HONEST[@]}" --label after-termination

log "== launch 2 (reconnect)"
launch l2 || exit 1; L2=$LABEL
BR --browser chromium "${HONEST[@]}" --label reconnect-honest; pause
evil replay --replay "$OUT/l1-evidence.json"; BR --browser chromium "${EVILR[@]}" --label reconnect-old-evidence; pause
evil replay-old-sealed --replay-sealed "$OUT/l1-sealed.bin"; BR --browser chromium "${EVILR[@]}" --label reconnect-old-sealed
kill $EVIL 2>/dev/null; EVIL=""
wait_end "$L2" || log "launch 2 did not end in time"; fetch "$L2" l2
cleanup; trap - EXIT; sleep 1
python3 "$V/check-app-browser.py" "$OUT"
