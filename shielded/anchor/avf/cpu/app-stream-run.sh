#!/usr/bin/env bash
# app-stream-run.sh <out_dir> <apk> <code_hash> -- the LAB streaming sealed responses on the phone (SEALED-STREAMING.md;
# NOT production, test signing): a REAL headless browser verifies the pVM's v2 evidence and sends a chunked sealed request
# to the lab streaming app (runtime/conformance/bundles/stream-probe.wasm: one padded NDJSON line per decoded token); the
# answer arrives chunk by chunk, each opened only after its tag verifies. A malicious relay (cpu/evil-web-relay.mjs)
# mutates the VM's stream every way the protocol text lists; each mutated stream is saved (traces/) with the page's
# opening context so the verdicts re-check offline (test/pvm-stream-traces.test.mjs).
#   launch 1: chromium stream | firefox stream | whole-mode regression | evil stream-pass (records) | swap | dup | drop |
#             truncate | forge-fin | flip | fin-flag | forge-chunk | trailing | replay | mode-flip | cancel after 4 of
#             200 tokens, then at once a fresh stream (the VM freed) | termination
#   launch 2 (reconnect): chromium stream (a new app key) | launch 1's recorded stream replayed
#   ONLY=cancel: launch 1 with the cancel cases alone (1, 4, 10 of 200 tokens), each followed at once by a fresh stream
set -uo pipefail
OUT="$1"; APK="$2"; CODE="$3"; H="$(cd "$(dirname "$0")/.." && pwd)"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; P=host.enclave.anchor.avf
V="$H/runtime/conformance"; BUNDLE="$V/bundles/stream-probe.wasm"; GRAPH="${GRAPH:-gemma-4-e2b-it-q4_0}"; NAME=pixel10-pvm-cpu
F=/data/user/0/$P/files; PORT=18443; APPPORT=18445; EVPORT=18446; WEBPORT=18447; SEALPORT=18448; SITEPORT=18450; EVILPORT=18457
RUN_ID="${RUN_ID:-$(date +%m%d%H%M%S)}"; STEPS="${STEPS:-24}"
AUTH=cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f   # gitleaks:allow -- public, not a secret: sha512 of the TEST APK signing certificate (pins.py), in every attestation chain
APPID=$(sha256sum "$BUNDLE" | cut -c1-64); REQ="/?graph=$GRAPH&steps=$STEPS"
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
[ -e "$OUT" ] && { echo "$OUT exists: refusing to mix runs"; exit 2; }
mkdir -p "$OUT/traces" || exit 2
log() { echo "$(date +%T) $*" | tee -a "$OUT/run.log"; }
want=$(sha256sum "$APK" | cut -c1-64); have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64)
if [ "$want" != "$have" ]; then timeout 300 "$ADB" install -r "$APK" </dev/null >/dev/null 2>&1 || { log "install failed"; exit 2; }
  have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64); fi
[ "$want" = "$have" ] || { log "installed APK $have is not $want"; exit 2; }
log "apk $want installed; the PAGE pins code hash $CODE, app $APPID (stream-probe), the pVM runtime, Google's roots (served by the site)"
"$ADB" push "$BUNDLE" /data/local/tmp/app-stream-probe.wasm </dev/null >/dev/null && sh_ "run-as $P cp /data/local/tmp/app-stream-probe.wasm files/app-stream-probe.wasm" >/dev/null
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
BR() { node "$H/cpu/browser-run.mjs" --site http://127.0.0.1:$SITEPORT/lab.html --results "$OUT/results.jsonl" "$@" >> "$OUT/browser.jsonl"; tail -1 "$OUT/browser.jsonl" | python3 -c 'import json,sys; r=json.loads(sys.stdin.read()); print(json.dumps({k:r.get(k) for k in ["label","browser","complete","status","tokens","firstTokenMs","ms","step","error","refused"]})[:300])' | tee -a "$OUT/run.log"; }
HONEST=(--relay http://127.0.0.1:$WEBPORT); EVILR=(--relay http://127.0.0.1:$EVILPORT); STREAM="&mode=stream&trace=1"
evil() {
  [ -n "$EVIL" ] && { kill $EVIL 2>/dev/null; wait $EVIL 2>/dev/null; }
  ( cd "$H" && exec node cpu/evil-web-relay.mjs --mode "$1" --listen $EVILPORT --up http://127.0.0.1:$WEBPORT --origin http://127.0.0.1:$SITEPORT \
      --code-hash "$CODE" --app "$APPID" --traces "${TRACES:-$OUT/traces}" "${@:2}" >> "$OUT/evil.jsonl" 2>> "$OUT/evil.err" ) & EVIL=$!; sleep 2; }
launch() {
  local l="$RUN_ID-$1"
  [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$l.log && echo USED'")" = USED ] && { log "$l: label used"; return 1; }
  sh_ "am force-stop $P; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard" >/dev/null; sleep 2
  local pw; pw=$(sh_ "dumpsys power"); grep -q 'mWakefulness=Awake' <<<"$pw" || { log "PHONE NOT AWAKE"; return 1; }
  sh_ "am start -S -n $P/.Main --es mode app --es vmname anchorlocal --es model $F/model.gguf --es app $F/app-stream-probe.wasm --es app_graph $GRAPH --ei app_tls 1 --ei app_serve_s ${SERVE_S:-480} --es relay ws://127.0.0.1:$PORT/v1/fleet-tunnel --es name $NAME --es capture $l" > "$OUT/$1.am"
  LABEL=$l; local t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt 400 ]; do
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep 'APP evidence endpoint on vsock')" ] && { log "$1: the VM serves and answers evidence ($(( $(date +%s) - t0 )) s)"; return 0; }
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep '^CAPTURE END')" ] && { log "$1: the run ended before serving"; return 1; }
    sleep 5; done
  log "$1: not serving within 400 s"; return 1; }
fetch() { sh_ "run-as $P cat files/capture/$1.log" > "$OUT/$2.log"; }
wait_end() { local t0=$(date +%s); while [ $(( $(date +%s) - t0 )) -lt 700 ]; do [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$1.complete && echo Y'")" = Y ] && return 0; sleep 5; done; return 1; }
pause() { sleep 3; }   # the VM answers evidence at most once every 2 s

log "== launch 1"
launch l1 || exit 1; L1=$LABEL
if [ "${ONLY:-}" = cancel ]; then   # the cancel cases alone: 1, 4 and 10 of 200 tokens, each followed at once by a fresh stream
  for k in 1 4 10; do
    BR --browser chromium "${HONEST[@]}" --label cancel-$k --path "/?graph=$GRAPH&steps=200" --extra "$STREAM&cancel=$k"; sleep 2
    BR --browser chromium "${HONEST[@]}" --label after-cancel-$k --path "/?graph=$GRAPH&steps=8" --extra "$STREAM"; pause
  done
  log "termination: waiting for the lab STOP and the run's end"
  wait_end "$L1" || log "launch 1 did not end in time"; fetch "$L1" l1
  cleanup; trap - EXIT; sleep 1
  python3 "$V/check-app-stream.py" "$OUT" --cancel; exit $?
fi
BR --browser chromium "${HONEST[@]}" --label stream-honest --path "$REQ" --extra "$STREAM"; pause
BR --browser firefox "${HONEST[@]}" --label stream-firefox --path "$REQ" --extra "$STREAM"; pause
BR --browser chromium "${HONEST[@]}" --label whole-honest --path "/?graph=$GRAPH&steps=8"; pause
evil stream-pass --record-stream "$OUT/l1-stream.bin"; BR --browser chromium "${EVILR[@]}" --label evil-stream-pass --path "$REQ" --extra "$STREAM"; pause
for m in stream-swap stream-dup stream-drop stream-truncate stream-forge-fin stream-flip stream-fin-flag stream-forge-chunk stream-trailing mode-flip; do
  evil $m; BR --browser chromium "${EVILR[@]}" --label evil-$m --path "$REQ" --extra "$STREAM"; pause; done
evil stream-replay --replay-stream "$OUT/l1-stream.bin"; BR --browser chromium "${EVILR[@]}" --label evil-stream-replay --path "$REQ" --extra "$STREAM"; pause
kill $EVIL 2>/dev/null; EVIL=""
BR --browser chromium "${HONEST[@]}" --label cancel --path "/?graph=$GRAPH&steps=200" --extra "$STREAM&cancel=4"; sleep 2   # the evidence rate limit; a decode that kept going would still hold the VM for ~20 s
BR --browser chromium "${HONEST[@]}" --label after-cancel --path "/?graph=$GRAPH&steps=8" --extra "$STREAM"; pause
log "termination: waiting for the lab STOP and the run's end"
wait_end "$L1" || log "launch 1 did not end in time"; fetch "$L1" l1; sleep 3
BR --browser chromium "${HONEST[@]}" --label after-termination --path "$REQ" --extra "$STREAM"

log "== launch 2 (reconnect)"
launch l2 || exit 1; L2=$LABEL
BR --browser chromium "${HONEST[@]}" --label reconnect-stream --path "$REQ" --extra "$STREAM"; pause
TRACES="$OUT/traces/l2" evil stream-replay --replay-stream "$OUT/l1-stream.bin"; BR --browser chromium "${EVILR[@]}" --label reconnect-old-stream --path "$REQ" --extra "$STREAM"
kill $EVIL 2>/dev/null; EVIL=""
wait_end "$L2" || log "launch 2 did not end in time"; fetch "$L2" l2
cleanup; trap - EXIT; sleep 1
python3 "$V/check-app-stream.py" "$OUT"
