#!/usr/bin/env bash
# app-client-run.sh <out_dir> <apk> <code_hash> -- the INSTALLED pVM client on the phone (client/DESIGN.md; LAB, not
# production, test signing, lab keys made for this run OUTSIDE the repository): the built CLI (client/dist/pvm-client.mjs)
# and the built browser extension (client/dist/pvm-client-ext.zip, in Chrome for Testing) talk to the Pixel's VM only
# under a policy signed by the key anchored at install, fetched from a carrier they do not trust.
#   CLI: install | stream | whole | attacker's policy | policy 2 | rollback to 1 | roots narrowed off the Pixel's root |
#        minimum version above it | another app only | a relay swapping the app key
#   extension (through a relay that can turn malicious): install | stream (pass) | policy 2 | attacker's policy |
#        rollback | relay swaps the app key | relay truncates the stream
set -uo pipefail
OUT="$1"; APK="$2"; CODE="$3"; H="$(cd "$(dirname "$0")/.." && pwd)"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; P=host.enclave.anchor.avf
V="$H/runtime/conformance"; BUNDLE="$V/bundles/stream-probe.wasm"; GRAPH="${GRAPH:-gemma-4-e2b-it-q4_0}"; NAME=pixel10-pvm-cpu
F=/data/user/0/$P/files; PORT=18443; APPPORT=18445; EVPORT=18446; WEBPORT=18447; SEALPORT=18448; SINKPORT=18450; EVILPORT=18457; POLPORT=18460
RUN_ID="${RUN_ID:-$(date +%m%d%H%M%S)}"; STEPS=24
CFT="${CFT:-$HOME/.cache/ms-playwright/chromium-1232/chrome-linux64/chrome}"; CLI="$H/client/dist/pvm-client.mjs"; SIGN="$H/client/tools/lab-sign.mjs"
KEYS="${KEYS:-$HOME/.cache/enclave-pvm-client-lab/$RUN_ID}"   # lab keys: outside the repository, never committed
AUTH=cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f   # gitleaks:allow -- public, not a secret: sha512 of the TEST APK signing certificate (pins.py)
PIXEL_RID=d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba; ROOT22=cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc; ROOT25=6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0
APPID=$(sha256sum "$BUNDLE" | cut -c1-64); HELLO=$(sha256sum "$V/bundles/hello-v1.wasm" | cut -c1-64); REQ="/?graph=$GRAPH&steps=$STEPS"
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
[ -e "$OUT" ] && { echo "$OUT exists: refusing to mix runs"; exit 2; }
mkdir -p "$OUT/policies" || exit 2
log() { echo "$(date +%T) $*" | tee -a "$OUT/run.log"; }
[ -x "$CFT" ] || { log "no Chrome for Testing at $CFT"; exit 2; }
# ---- lab keys and signed policies (the signed documents are public; the keys stay in $KEYS) ----
node "$SIGN" keygen --keys "$KEYS" --name policy > "$OUT/policy-key.json" && node "$SIGN" keygen --keys "$KEYS" --name release > "$OUT/release-key.json" \
  && node "$SIGN" keygen --keys "$KEYS/attacker" --name policy > "$OUT/attacker-key.json" || { log "keygen failed"; exit 2; }
PFP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["fingerprint"])' "$OUT/policy-key.json"); RFP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["fingerprint"])' "$OUT/release-key.json")
body() {   # body <serial> [python dict overrides]
  python3 - "$1" "${2:-{\}}" "$CODE" "$AUTH" "$PIXEL_RID" "$APPID" "$ROOT22" "$ROOT25" <<'PY'
import json, sys, time
serial, over, code, auth, rid, app, r22, r25 = sys.argv[1:9]
t = lambda s: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + s))
b = {"type": "enclave-pvm-client-policy", "key": "", "serial": int(serial), "notBefore": t(-3600), "notAfter": t(6 * 3600), "codeHashes": [code],
     "authorityHashes": [auth], "runtimeIds": [rid], "appIds": [app], "googleRootPins": [r22, r25], "formats": ["enclave-pvm-app-evidence/v2"],
     "sealedModes": ["chunked", "whole"], "sealedWindow": {"seconds": 600, "maxRequests": 256}, "minClientVersion": "0.1.0", "nextPolicyKey": None}
b.update(eval(over)); print(json.dumps(b))
PY
}
mkpol() { local name="$1" keys="$2"; shift 2; body "$@" > "$KEYS/$name.body.json" && node "$SIGN" policy --keys "$keys" --body "$KEYS/$name.body.json" --out "$OUT/policies/$name.json"; }
mkpol policy-1 "$KEYS" 1 && mkpol policy-2 "$KEYS" 2 && mkpol attacker "$KEYS/attacker" 3 \
  && mkpol narrow-roots "$KEYS" 3 "{'googleRootPins': ['$ROOT22']}" && mkpol min-version "$KEYS" 4 "{'minClientVersion': '9.0.0'}" \
  && mkpol other-app "$KEYS" 5 "{'appIds': ['$HELLO']}" && mkpol policy-6 "$KEYS" 6 || { log "signing failed"; exit 2; }
log "lab anchors: policy key $PFP, release key $RFP (keys in $KEYS, not in the repository); client $(node "$CLI" version)"
# ---- the phone, the hub, the carriers ----
want=$(sha256sum "$APK" | cut -c1-64); have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64)
if [ "$want" != "$have" ]; then timeout 300 "$ADB" install -r "$APK" </dev/null >/dev/null 2>&1 || { log "install failed"; exit 2; }; fi
"$ADB" push "$BUNDLE" /data/local/tmp/app-stream-probe.wasm </dev/null >/dev/null && sh_ "run-as $P cp /data/local/tmp/app-stream-probe.wasm files/app-stream-probe.wasm" >/dev/null
( cd "$H" && exec node cpu/local-hub.mjs --port $PORT --code-hash "$CODE" --authority $AUTH \
    --model-sha 5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48 --selftest-sha 9c4c7f764bf657c708cb19c6493a0be303db49093fd7df1432664cfd3801ce2f \
    --min-tok-s 10 --app-id "$APPID" --app-port $APPPORT --evidence-port $EVPORT --sealed-port $SEALPORT --web-port $WEBPORT --app-name $NAME --seconds 2400 > "$OUT/hub.jsonl" 2> "$OUT/hub.err" ) & HUB=$!
( cd "$H" && exec node web/lab-site.mjs --port $SINKPORT --results "$OUT/ext-results.jsonl" --app "$APPID" --code-hash "$CODE" --authority $AUTH > "$OUT/sink.jsonl" 2> "$OUT/sink.err" ) & SINK=$!
mkdir -p "$OUT/carrier"; ( exec python3 -m http.server $POLPORT --bind 127.0.0.1 --directory "$OUT/carrier" > "$OUT/carrier.log" 2>&1 ) & POL=$!
sleep 2
"$ADB" reverse tcp:$PORT tcp:$PORT >/dev/null || { log "adb reverse failed"; kill $HUB $SINK $POL; exit 2; }
EVIL=""
cleanup() { [ -n "$EVIL" ] && kill $EVIL 2>/dev/null; kill $HUB $SINK $POL 2>/dev/null; "$ADB" reverse --remove tcp:$PORT >/dev/null 2>&1; }
trap cleanup EXIT
evil() { [ -n "$EVIL" ] && { kill $EVIL 2>/dev/null; wait $EVIL 2>/dev/null; }
  ( cd "$H" && exec node cpu/evil-web-relay.mjs --mode "$1" --listen $EVILPORT --up http://127.0.0.1:$WEBPORT --origin null --code-hash "$CODE" --app "$APPID" >> "$OUT/evil.jsonl" 2>> "$OUT/evil.err" ) & EVIL=$!; sleep 2; }
carry() { cp "$OUT/policies/$1.json" "$OUT/carrier/current.json"; }   # what the (untrusted) policy carrier serves now
STATE="$OUT/cli-state.d"   # the CLI's generation log (client/DESIGN.md "State"); read back through its `state` command
C() { local label="$1"; shift; node "$CLI" run --state "$STATE" --label "$label" "$@" > "$OUT/$label.jsonl"; local rc=$?
  tail -1 "$OUT/$label.jsonl" | python3 -c 'import json,sys; r=json.loads(sys.stdin.read())["result"]; print(json.dumps({k:r.get(k) for k in ["label","complete","status","tokens","firstTokenMs","ms","step","refused","policySerial"]})[:280])' | tee -a "$OUT/run.log"; return $rc; }
EXT="$OUT/ext-unpacked"; mkdir -p "$EXT" && unzip -q "$H/client/dist/pvm-client-ext.zip" -d "$EXT"
EXTID=$(python3 -c "import hashlib,sys; h=hashlib.sha256(sys.argv[1].encode()).hexdigest()[:32]; print(''.join(chr(97+int(c,16)) for c in h))" "$EXT")
PROF="$(mktemp -d)"
X() {   # X <url> <label>: one page load of the installed extension; waits for its outcome at the sink ("install": the install report)
  local url="$1" label="$2" b pat; [ "$label" = install ] && pat='"installed":true' || pat="\"label\":\"$label\""   # its outcome: not its policy-committed event
  rm -rf "$PROF/Default/Sessions" "$PROF/Default/Current Session" "$PROF/Default/Current Tabs" "$PROF/Default/Last Session" "$PROF/Default/Last Tabs"   # no restored tab may re-run a page
  setsid "$CFT" --headless=new --disable-session-crashed-bubble --no-first-run --no-default-browser-check --user-data-dir="$PROF" --disable-extensions-except="$EXT" --load-extension="$EXT" "$url" >/dev/null 2>&1 & b=$!
  for i in $(seq 1 60); do grep "$pat" "$OUT/ext-results.jsonl" 2>/dev/null | grep -qv '"event":' && break; sleep 0.5; done
  sleep 1; kill -- -$b 2>/dev/null; wait $b 2>/dev/null; sleep 0.5   # the browser's whole process group, by the PID it started
  { grep "$pat" "$OUT/ext-results.jsonl" 2>/dev/null | grep -v '"event":' | tail -1 || true; } | python3 -c 'import json,sys; t=sys.stdin.read().strip(); r=json.loads(t) if t else {"label":sys.argv[1],"refused":"no outcome reached the sink"}; print(json.dumps({k:r.get(k) for k in ["label","installed","complete","status","tokens","firstTokenMs","ms","step","refused","policySerial"]})[:280])' "$label" | tee -a "$OUT/run.log"; }
pause() { sleep 3; }
launch() {
  local l="$RUN_ID-$1"
  sh_ "am force-stop $P; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard" >/dev/null; sleep 2
  local pw; pw=$(sh_ "dumpsys power"); grep -q 'mWakefulness=Awake' <<<"$pw" || { log "PHONE NOT AWAKE"; return 1; }
  sh_ "am start -S -n $P/.Main --es mode app --es vmname anchorlocal --es model $F/model.gguf --es app $F/app-stream-probe.wasm --es app_graph $GRAPH --ei app_tls 1 --ei app_serve_s ${SERVE_S:-420} --es relay ws://127.0.0.1:$PORT/v1/fleet-tunnel --es name $NAME --es capture $l" > "$OUT/$1.am"
  LABEL=$l; local t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt 400 ]; do
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep 'APP evidence endpoint on vsock')" ] && { log "$1: the VM serves ($(( $(date +%s) - t0 )) s)"; return 0; }
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep '^CAPTURE END')" ] && { log "$1: ended before serving"; return 1; }
    sleep 5; done; log "$1: not serving within 400 s"; return 1; }
wait_end() { local t0=$(date +%s); while [ $(( $(date +%s) - t0 )) -lt 600 ]; do [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$1.complete && echo Y'")" = Y ] && return 0; sleep 5; done; return 1; }

log "== launch"
launch l1 || exit 1; L1=$LABEL
POLURL=http://127.0.0.1:$POLPORT/current.json; RELAY=http://127.0.0.1:$WEBPORT
log "-- the CLI (state $STATE)"
node "$CLI" install --state "$STATE" --policy-key-fp "$PFP" --serial-floor 1 --release-key-fp "$RFP" | tee "$OUT/cli-install.json" | tee -a "$OUT/run.log"
carry policy-1; C cli-stream --policy $POLURL --relay $RELAY --app "$APPID" --path "$REQ"; pause
C cli-whole --policy $POLURL --relay $RELAY --app "$APPID" --path "/?graph=$GRAPH&steps=8" --whole; pause
carry attacker; C cli-attacker-policy --policy $POLURL --relay $RELAY --app "$APPID" --path "$REQ"; pause
carry policy-2; C cli-policy-2 --policy $POLURL --relay $RELAY --app "$APPID" --path "$REQ"; pause
carry policy-1; C cli-rollback --policy $POLURL --relay $RELAY --app "$APPID" --path "$REQ"; pause
carry narrow-roots; C cli-narrow-roots --policy $POLURL --relay $RELAY --app "$APPID" --path "$REQ"; pause
carry min-version; C cli-min-version --policy $POLURL --relay $RELAY --app "$APPID" --path "$REQ"; pause
carry other-app; C cli-other-app --policy $POLURL --relay $RELAY --app "$APPID" --path "$REQ"; pause
# a genuine newer policy (serial 6: the ones before were accepted as policies, so an older one is a rollback), through a relay swapping the app key
carry policy-6; evil swap-appkey; C cli-relay-swaps-key --policy $POLURL --relay http://127.0.0.1:$EVILPORT --app "$APPID" --path "$REQ"; pause
node "$CLI" state --state "$STATE" > "$OUT/cli-state-cmd.json"; log "CLI state: $(cat "$OUT/cli-state-cmd.json" | head -c 300)"
log "-- the extension ($EXTID, Chrome for Testing), through a relay that can turn malicious"
X "chrome-extension://$EXTID/options.html?install=1&policyKeyFp=$PFP&serialFloor=1&releaseKeyFp=$RFP&policyUrl=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' $POLURL)&relayUrl=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' http://127.0.0.1:$EVILPORT)&appId=$APPID&resultUrl=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' http://127.0.0.1:$SINKPORT/result)" install
QP=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$REQ")
evil pass; carry policy-1; X "chrome-extension://$EXTID/client.html?label=ext-stream&path=$QP" ext-stream; pause
carry policy-2; X "chrome-extension://$EXTID/client.html?label=ext-policy-2&path=$QP" ext-policy-2; pause
carry attacker; X "chrome-extension://$EXTID/client.html?label=ext-attacker-policy&path=$QP" ext-attacker-policy; pause
carry policy-1; X "chrome-extension://$EXTID/client.html?label=ext-rollback&path=$QP" ext-rollback; pause
carry policy-2; evil swap-appkey; X "chrome-extension://$EXTID/client.html?label=ext-relay-swaps-key&path=$QP" ext-relay-swaps-key; pause
evil stream-truncate; X "chrome-extension://$EXTID/client.html?label=ext-relay-truncates&path=$QP" ext-relay-truncates; pause
kill $EVIL 2>/dev/null; EVIL=""
log "waiting for the lab STOP"
wait_end "$L1" || log "the launch did not end in time"; sh_ "run-as $P cat files/capture/$L1.log" > "$OUT/l1.log"
cleanup; trap - EXIT; rm -rf "$PROF" "$EXT"; sleep 1
python3 "$V/check-app-client.py" "$OUT"
