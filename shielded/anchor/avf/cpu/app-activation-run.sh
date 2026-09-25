#!/usr/bin/env bash
# app-activation-run.sh <out_dir> <apk> <code_hash> -- the installed client's EXPLICIT ACTIVATION against the real Pixel 10
# VM (client/DESIGN.md "Activation"; LAB, not production, CLI only). The accepted 0.3.0 artifact (pinned by sha) is copied
# into a lab install directory OUTSIDE the repository, with fresh isolated state; lab keys are made for this run outside
# the repository. A clearly labelled LAB next-version artifact (client/tools/lab-next.mjs: the base's code, version 0.3.1)
# is signed with the lab keys, delivered over an untrusted HTTP carrier, staged, and explicitly activated. Then:
#   0.3.0 baseline stream | staged but not active: still 0.3.0 | activate | 0.3.1 stream + whole | a planted marker on the
#   launcher (still delegates) | policy 2 through 0.3.1 | a policy-key ROTATION committed by 0.3.1 (a policy naming the
#   successor key, then one signed by the successor; the retired key refused) | the active file TAMPERED in place:
#   refused, nothing sent; the same artifact cannot overwrite it; removed; re-published; stream | the active file MISSING:
#   refused; repaired; stream | an older policy under the successor key through 0.3.1: a rollback, refused. After the
#   rotation a repair needs a manifest countersigned by the successor: the original countersignature is refused too.
# A snapshot of the state, `staged` and the install directory (inodes) is taken after every step. The checker is
# runtime/conformance/check-app-activation.py. A failed run is kept as it is: never reuse an output directory.
set -uo pipefail
OUT="$1"; APK="$2"; CODE="$3"; H="$(cd "$(dirname "$0")/.." && pwd)"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; P=host.enclave.anchor.avf
V="$H/runtime/conformance"; BUNDLE="$V/bundles/stream-probe.wasm"; GRAPH="${GRAPH:-gemma-4-e2b-it-q4_0}"; NAME=pixel10-pvm-cpu
F=/data/user/0/$P/files; PORT=18443; APPPORT=18445; EVPORT=18446; WEBPORT=18447; SEALPORT=18448; POLPORT=18460; UPDPORT=18461
RUN_ID="${RUN_ID:-$(date +%m%d%H%M%S)}"; STEPS=24
DIST="$H/client/dist/pvm-client.mjs"; SIGN="$H/client/tools/lab-sign.mjs"; NEXTTOOL="$H/client/tools/lab-next.mjs"
BASE_SHA=fad5ba229c5dbbb339aa6d3d505e31c6a07eaaabadbe2431533cf882fb0f6aa4; BASE_COMMIT=0f4c79fdc90d3bf80575a7822f18c3059fe481af   # the accepted 0.3.0
NEXT_V=0.3.1; NEXT_SHA_WANT="${NEXT_SHA_WANT:-ed82869d033964081b2dcb45dd9ae8b238db79693f3ff10cf1cdfef510bde84c}"
KEYS="${KEYS:-$HOME/.cache/enclave-pvm-client-lab/$RUN_ID}"; INSTALL="$KEYS/install"; UPD="$KEYS/updates"   # outside the repository
AUTH=cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f   # gitleaks:allow -- public, not a secret: sha512 of the TEST APK signing certificate (pins.py)
PIXEL_RID=d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba; ROOT22=cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc; ROOT25=6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0
APPID=$(sha256sum "$BUNDLE" | cut -c1-64); REQ="/?graph=$GRAPH&steps=$STEPS"
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
[ -e "$OUT" ] && { echo "$OUT exists: refusing to mix runs"; exit 2; }
mkdir -p "$OUT/policies" || exit 2
log() { echo "$(date -u +%H:%M:%SZ) $*" | tee -a "$OUT/run.log"; }   # UTC, like the signed documents
# ---- preflight, before anything touches the phone: the capture code this run sources must stop on a capture failure ----
bash "$H/cpu/preflight-activation-capture.sh" "$OUT/preflight.txt" > /dev/null || { log "capture preflight FAILED (preflight.txt): not running"; exit 3; }
log "capture preflight: $(tail -1 "$OUT/preflight.txt")"
# ---- the launcher: the accepted 0.3.0, copied into a lab install directory ----
[ "$(sha256sum "$DIST" | cut -c1-64)" = "$BASE_SHA" ] || { log "client/dist/pvm-client.mjs is not the accepted 0.3.0 ($BASE_SHA): refusing"; exit 2; }
[ -e "$KEYS" ] && { log "$KEYS exists: refusing to reuse lab keys or an install directory"; exit 2; }
mkdir -p "$INSTALL" "$UPD" && chmod 700 "$KEYS" && cp "$DIST" "$INSTALL/pvm-client.mjs" || exit 2
CLI="$INSTALL/pvm-client.mjs"; STATE="$OUT/cli-state.d"
# ---- lab keys, policies, the next-version artifact and its signed manifest ----
node "$SIGN" keygen --keys "$KEYS" --name policy > "$OUT/policy-key.json" && node "$SIGN" keygen --keys "$KEYS" --name release > "$OUT/release-key.json" \
  && node "$SIGN" keygen --keys "$KEYS/successor" --name policy > "$OUT/successor-key.json" || { log "keygen failed"; exit 2; }
SUCC=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["key"])' "$OUT/successor-key.json")
PFP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["fingerprint"])' "$OUT/policy-key.json"); RFP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["fingerprint"])' "$OUT/release-key.json")
body() {   # body <serial> [nextPolicyKey]
  python3 - "$1" "$CODE" "$AUTH" "$PIXEL_RID" "$APPID" "$ROOT22" "$ROOT25" "${2:-}" <<'PY'
import json, sys, time
serial, code, auth, rid, app, r22, r25, nxt = sys.argv[1:9]
t = lambda s: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + s))
print(json.dumps({"type": "enclave-pvm-client-policy", "key": "", "serial": int(serial), "notBefore": t(-3600), "notAfter": t(6 * 3600), "codeHashes": [code],
     "authorityHashes": [auth], "runtimeIds": [rid], "appIds": [app], "googleRootPins": [r22, r25], "formats": ["enclave-pvm-app-evidence/v2"],
     "sealedModes": ["chunked", "whole"], "sealedWindow": {"seconds": 600, "maxRequests": 256}, "minClientVersion": "0.1.0", "nextPolicyKey": nxt or None}))
PY
}
mkpol() { body "$3" "${4:-}" > "$KEYS/$1.body.json" && node "$SIGN" policy --keys "$2" --body "$KEYS/$1.body.json" --out "$OUT/policies/$1.json"; }   # mkpol <name> <keys> <serial> [nextPolicyKey]
mkpol policy-1 "$KEYS" 1 && mkpol policy-2 "$KEYS" 2 && mkpol rotate-3 "$KEYS" 3 "$SUCC" && mkpol successor-4 "$KEYS/successor" 4 \
  && mkpol retired-5 "$KEYS" 5 && mkpol rollback-3 "$KEYS/successor" 3 || { log "policy signing failed"; exit 2; }
NEXT="$UPD/pvm-client-$NEXT_V-lab.mjs"
node "$NEXTTOOL" --base "$CLI" --version "$NEXT_V" --out "$NEXT" > "$OUT/lab-next.json" || { log "lab-next failed"; exit 2; }
NEXT_SHA=$(sha256sum "$NEXT" | cut -c1-64)
[ "$NEXT_SHA" = "$NEXT_SHA_WANT" ] || { log "the lab next-version artifact is $NEXT_SHA, not the announced $NEXT_SHA_WANT: refusing"; exit 2; }
node "$SIGN" update --keys "$KEYS" --artifact "$NEXT" --version "$NEXT_V" --source-commit "$BASE_COMMIT" \
  --not-after "$(date -u -d '+6 hours' +%Y-%m-%dT%H:%M:%SZ)" --out "$UPD/manifest-$NEXT_V.json" && cp "$UPD/manifest-$NEXT_V.json" "$OUT/manifest-$NEXT_V.json" || { log "update signing failed"; exit 2; }
# the same artifact, countersigned by the SUCCESSOR policy key: after the rotation the original countersignature is retired
# too, so a repair needs a manifest valid under the current keys (the release key is unchanged)
cp "$KEYS/release.key" "$KEYS/successor/release.key" && chmod 600 "$KEYS/successor/release.key" \
  && node "$SIGN" update --keys "$KEYS/successor" --artifact "$NEXT" --version "$NEXT_V" --source-commit "$BASE_COMMIT" \
       --not-after "$(date -u -d '+6 hours' +%Y-%m-%dT%H:%M:%SZ)" --out "$UPD/manifest-$NEXT_V-rotated.json" && cp "$UPD/manifest-$NEXT_V-rotated.json" "$OUT/" || { log "update signing failed"; exit 2; }
TAMPER="$UPD/tampered.mjs"; { cat "$NEXT"; echo "// LAB TAMPER: one appended comment line, not the signed bytes"; } > "$TAMPER"
python3 -c 'import hashlib,json,sys; b=open(sys.argv[1],"rb").read(); print(json.dumps({"sha256":hashlib.sha256(b).hexdigest(),"size":len(b),"how":"the signed bytes plus one appended comment line, written IN PLACE over the active file"}))' "$TAMPER" > "$OUT/tampered.json"
ACTIVE_FILE="$INSTALL/pvm-client-$NEXT_V-$NEXT_SHA.mjs"
log "launcher $(node "$CLI" version) sha256 $BASE_SHA (commit $BASE_COMMIT), install dir $INSTALL, lab keys $KEYS (not in the repository)"
log "lab next-version artifact: $(cat "$OUT/lab-next.json")"
# ---- the phone, the hub, the carriers ----
want=$(sha256sum "$APK" | cut -c1-64); have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64)
if [ "$want" != "$have" ]; then timeout 300 "$ADB" install -r "$APK" </dev/null >/dev/null 2>&1 || { log "install failed"; exit 2; }; fi
"$ADB" push "$BUNDLE" /data/local/tmp/app-stream-probe.wasm </dev/null >/dev/null && sh_ "run-as $P cp /data/local/tmp/app-stream-probe.wasm files/app-stream-probe.wasm" >/dev/null
( cd "$H" && exec node cpu/local-hub.mjs --port $PORT --code-hash "$CODE" --authority $AUTH \
    --model-sha 5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48 --selftest-sha 9c4c7f764bf657c708cb19c6493a0be303db49093fd7df1432664cfd3801ce2f \
    --min-tok-s 10 --app-id "$APPID" --app-port $APPPORT --evidence-port $EVPORT --sealed-port $SEALPORT --web-port $WEBPORT --app-name $NAME --seconds 2400 \
    --record-evidence "$OUT/evidence" > "$OUT/hub.jsonl" 2> "$OUT/hub.err" ) & HUB=$!
RUN_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "{\"evidence\":\"every /evidence exchange recorded as received in evidence/ (public; sealed traffic is not recorded)\",\"clock\":\"UTC\",\"runStart\":\"$RUN_START\",\"preflight\":\"preflight.txt\"}" > "$OUT/capture.json"
mkdir -p "$OUT/carrier"; ( exec python3 -m http.server $POLPORT --bind 127.0.0.1 --directory "$OUT/carrier" > "$OUT/carrier.log" 2>&1 ) & POL=$!
( exec python3 -m http.server $UPDPORT --bind 127.0.0.1 --directory "$UPD" > "$OUT/update-carrier.log" 2>&1 ) & UPC=$!
sleep 2
"$ADB" reverse tcp:$PORT tcp:$PORT >/dev/null || { log "adb reverse failed"; kill $HUB $POL $UPC; exit 2; }
cleanup() { kill $HUB $POL $UPC 2>/dev/null; "$ADB" reverse --remove tcp:$PORT >/dev/null 2>&1; }
trap cleanup EXIT
carry() { cp "$OUT/policies/$1.json" "$OUT/carrier/current.json"; }   # what the (untrusted) policy carrier serves now
POLURL=http://127.0.0.1:$POLPORT/current.json; RELAY=http://127.0.0.1:$WEBPORT; UPDURL=http://127.0.0.1:$UPDPORT
# cl <label> <command...>: the installed launcher with the isolated state and install directory, and its per-call capture
# (the committed state after every call, the evidence exchanges it made) -- cpu/activation-capture.sh, the file the preflight
# above exercised. A capture failure stops the run with exit 3; the results so far are kept.
source "$H/cpu/activation-capture.sh"
R() { local label="$1"; shift; cl "$label" run --policy $POLURL --relay $RELAY --app "$APPID" --path "$REQ" "$@"; }
UPDATE() { cl "$1" update --manifest "$UPDURL/${2:-manifest-$NEXT_V.json}" --artifact "$UPDURL/pvm-client-$NEXT_V-lab.mjs"; }   # UPDATE <label> [manifest]
snap() {   # the committed state, `staged` (both records, bytesMatch), and the install directory with inodes
  node "$CLI" state --state "$STATE" > "$OUT/state-$1.json" || capture_fail "snap $1" "\`pvm-client state\` exited non-zero"
  node "$CLI" staged --state "$STATE" --install-dir "$INSTALL" > "$OUT/staged-$1.json"; echo $? > "$OUT/staged-$1.rc"
  ( cd "$INSTALL" && for f in $(ls -A | sort); do stat -c '%i %s %a %n' "$f"; done ) > "$OUT/install-$1.txt"; }
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
node "$CLI" install --state "$STATE" --policy-key-fp "$PFP" --serial-floor 1 --release-key-fp "$RFP" > "$OUT/cli-install.json"; echo $? > "$OUT/cli-install.rc"; snap 0-installed
log "-- 0.3.0, the launcher itself"
carry policy-1; R base-stream; pause
log "-- stage the lab next-version artifact (from an untrusted carrier); nothing runs it yet"
UPDATE update; snap 1-staged
R staged-not-active; pause
log "-- activate (explicit)"
cl activate activate; snap 2-activated
log "-- 0.3.1, delegated: real evidence verified by the activated bytes, sealed request, streamed answer"
R active-stream; pause
cl active-whole run --policy $POLURL --relay $RELAY --app "$APPID" --path "/?graph=$GRAPH&steps=8" --whole; pause
ENCLAVE_PVM_CLIENT_DELEGATED="0.3.0:$(printf '0%.0s' $(seq 64))" R planted-marker; pause   # a marker planted on the launcher: ignored, it still delegates
carry policy-2; R active-policy-2; pause; snap 3-policy-2
log "-- a policy-key rotation, committed by the delegated 0.3.1"
carry rotate-3; R rotate-3; pause
carry successor-4; R successor-4; pause
carry retired-5; R retired-5; snap 3b-rotated
carry successor-4
log "-- the active file tampered IN PLACE"
chmod u+w "$ACTIVE_FILE" && cat "$TAMPER" > "$ACTIVE_FILE"; snap 4-tampered
R tampered; UPDATE repair-refused "manifest-$NEXT_V-rotated.json"; snap 5-tampered-after
rm -f "$ACTIVE_FILE"; UPDATE repair-old-key; UPDATE repair-1 "manifest-$NEXT_V-rotated.json"; snap 6-repaired
R repaired-stream; pause
log "-- the active file missing"
rm -f "$ACTIVE_FILE"; R missing; snap 7-missing
UPDATE repair-2 "manifest-$NEXT_V-rotated.json"; snap 8-repaired-2; R repaired-2-stream; pause
log "-- an older policy under the successor key, through 0.3.1: the floor held through every failure"
carry rollback-3; R rollback; snap 9-final
log "waiting for the lab STOP"
wait_end "$L1" || log "the launch did not end in time"; sh_ "run-as $P cat files/capture/$L1.log" > "$OUT/l1.log"
cleanup; trap - EXIT; sleep 1
python3 - "$OUT" "$RUN_START" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" <<'PY'
import json, sys
out, start, end = sys.argv[1:4]
rows = [json.loads(l) for l in open(f"{out}/exchanges.jsonl")]
json.dump({"preflight": "preflight.txt", "evidence": "every /evidence exchange recorded as received in evidence/: evidence-NNN.request (the client's nonce line), "
           "evidence-NNN.json (the VM's envelope, byte for byte), evidence-NNN.meta.json (UTC times, sizes); nothing parsed, stripped or "
           "reordered; public; sealed traffic and session secrets are never recorded", "clock": "UTC", "runStart": start, "runEnd": end,
           "exchanges": [{"n": n, "label": r["label"], "stateAfter": r["after"]} for r in rows for n in r["exchanges"]]}, open(f"{out}/capture.json", "w"), indent=1)
PY
[ $? = 0 ] || { log "capture.json could not be assembled: stopping (exit 3)"; exit 3; }
python3 "$V/check-app-activation.py" "$OUT" | tee "$OUT/check.txt"
