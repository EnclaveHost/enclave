#!/usr/bin/env bash
# app-stability-run.sh <out_dir> <apk> <code_hash> -- product acceptance target 9 (PVM-CPU.md "Product acceptance target"):
# 50 consecutive MIXED turns with no engine error, on the Pixel 10's real VM, through the INSTALLED client 0.4.1 (pinned
# by sha, copied into a lab install directory outside the repository; fresh isolated state; lab keys made for this run
# outside the repository). LAB, not production. Turns cycle through ten shapes: stream and whole answers, 8 to 128 decoded
# tokens, selected by deployment (the signed table) or by app. Every turn fetches fresh evidence over its own nonce.
#   - Every ATTEMPT is recorded (turns.jsonl, the per-call capture in exchanges.jsonl, the raw evidence envelopes the relay
#     carrier recorded, thermal.jsonl before each turn, host.jsonl every ten turns).
#   - The run STOPS at the first turn that is not a valid completed answer -- a refusal, a timeout, an incomplete stream,
#     an error -- after saving diagnostics. The count is never restarted: an early failure is the result.
#   - A turn that does not end within TURN_TIMEOUT seconds is killed and recorded as a timeout (never a pass).
# The capture is cpu/activation-capture.sh, preflighted first (preflight.txt; the run does not start if it fails). After
# the turns the VM's capture is read and the lab app stopped (the VM ends with it). The checker is
# runtime/conformance/check-app-stability.py. Never reuse an output directory.
set -uo pipefail
OUT="$1"; APK="$2"; CODE="$3"; H="$(cd "$(dirname "$0")/.." && pwd)"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; P=host.enclave.anchor.avf
V="$H/runtime/conformance"; BUNDLE="$V/bundles/stream-probe.wasm"; GRAPH="${GRAPH:-gemma-4-e2b-it-q4_0}"; NAME=pixel10-pvm-cpu
F=/data/user/0/$P/files; PORT=18443; APPPORT=18445; EVPORT=18446; WEBPORT=18447; SEALPORT=18448; POLPORT=18460
RUN_ID="${RUN_ID:-$(date +%m%d%H%M%S)}"; TURNS="${TURNS:-50}"; TURN_TIMEOUT="${TURN_TIMEOUT:-180}"; SERVE_S="${SERVE_S:-1800}"
DIST="$H/client/dist/pvm-client.mjs"; SIGN="$H/client/tools/lab-sign.mjs"
BASE_SHA=58f0edddb0f7db85df7edf9e56bbab043194a19a8d4e5d903ef31a5b5705abc4; BASE_COMMIT=c1341ee32b301bd31ca7710ae428022a0fc9f254   # the installed 0.4.1
KEYS="${KEYS:-$HOME/.cache/enclave-pvm-client-lab/$RUN_ID}"; INSTALL="$KEYS/install"   # outside the repository
AUTH=cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f   # gitleaks:allow -- public, not a secret: sha512 of the TEST APK signing certificate (pins.py)
PIXEL_RID=d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba; ROOT22=cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc; ROOT25=6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0
APPID=$(sha256sum "$BUNDLE" | cut -c1-64); DEP="0x$(printf 'lab: pixel10 pvm-cpu stability' | sha256sum | cut -c1-64)"
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
[ -e "$OUT" ] && { echo "$OUT exists: refusing to mix runs"; exit 2; }
mkdir -p "$OUT/policies" "$OUT/diag" || exit 2
log() { echo "$(date -u +%H:%M:%SZ) $*" | tee -a "$OUT/run.log"; }   # UTC
# ---- preflight, before anything touches the phone ----
bash "$H/cpu/preflight-activation-capture.sh" "$OUT/preflight.txt" > /dev/null || { log "capture preflight FAILED (preflight.txt): not running"; exit 3; }
log "capture preflight: $(tail -1 "$OUT/preflight.txt")"
# ---- the installed client 0.4.1, isolated state, lab keys and the policy (one serial, a deployment table) ----
[ "$(sha256sum "$DIST" | cut -c1-64)" = "$BASE_SHA" ] || { log "client/dist/pvm-client.mjs is not the pinned 0.4.1 ($BASE_SHA): refusing"; exit 2; }
[ -e "$KEYS" ] && { log "$KEYS exists: refusing to reuse lab keys or an install directory"; exit 2; }
mkdir -p "$INSTALL" && chmod 700 "$KEYS" && cp "$DIST" "$INSTALL/pvm-client.mjs" || exit 2
CLI="$INSTALL/pvm-client.mjs"; STATE="$OUT/cli-state.d"
node "$SIGN" keygen --keys "$KEYS" --name policy > "$OUT/policy-key.json" && node "$SIGN" keygen --keys "$KEYS" --name release > "$OUT/release-key.json" || { log "keygen failed"; exit 2; }
PFP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["fingerprint"])' "$OUT/policy-key.json"); RFP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["fingerprint"])' "$OUT/release-key.json")
python3 - "$CODE" "$AUTH" "$PIXEL_RID" "$APPID" "$ROOT22" "$ROOT25" "$DEP" > "$KEYS/policy-1.body.json" <<'PY'
import json, sys, time
code, auth, rid, app, r22, r25, dep = sys.argv[1:8]
t = lambda s: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + s))
print(json.dumps({"type": "enclave-pvm-client-policy", "key": "", "serial": 1, "notBefore": t(-3600), "notAfter": t(6 * 3600), "codeHashes": [code],
     "authorityHashes": [auth], "runtimeIds": [rid], "appIds": [app], "googleRootPins": [r22, r25], "formats": ["enclave-pvm-app-evidence/v2"],
     "sealedModes": ["chunked", "whole"], "sealedWindow": {"seconds": 600, "maxRequests": 256}, "minClientVersion": "0.1.0", "nextPolicyKey": None,
     "deployments": [{"id": dep, "app": app}]}))
PY
node "$SIGN" policy --keys "$KEYS" --body "$KEYS/policy-1.body.json" --out "$OUT/policies/policy-1.json" || { log "policy signing failed (the signer checks it with the client's own rules)"; exit 2; }
log "installed client $(node "$CLI" version) sha256 $BASE_SHA (commit $BASE_COMMIT); deployment $DEP -> app $APPID; lab keys $KEYS (not in the repository)"
# ---- the phone, the hub (recording every evidence exchange), the policy carrier ----
want=$(sha256sum "$APK" | cut -c1-64); have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64)
if [ "$want" != "$have" ]; then timeout 300 "$ADB" install -r "$APK" </dev/null >/dev/null 2>&1 || { log "install failed"; exit 2; }; fi
"$ADB" push "$BUNDLE" /data/local/tmp/app-stream-probe.wasm </dev/null >/dev/null && sh_ "run-as $P cp /data/local/tmp/app-stream-probe.wasm files/app-stream-probe.wasm" >/dev/null
( cd "$H" && exec node cpu/local-hub.mjs --port $PORT --code-hash "$CODE" --authority $AUTH \
    --model-sha 5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48 --selftest-sha 9c4c7f764bf657c708cb19c6493a0be303db49093fd7df1432664cfd3801ce2f \
    --min-tok-s 10 --app-id "$APPID" --app-port $APPPORT --evidence-port $EVPORT --sealed-port $SEALPORT --web-port $WEBPORT --app-name $NAME --seconds $((SERVE_S + 600)) \
    --record-evidence "$OUT/evidence" > "$OUT/hub.jsonl" 2> "$OUT/hub.err" ) & HUB=$!
mkdir -p "$OUT/carrier"; ( exec python3 -m http.server $POLPORT --bind 127.0.0.1 --directory "$OUT/carrier" > "$OUT/carrier.log" 2>&1 ) & POL=$!
RUN_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 2
"$ADB" reverse tcp:$PORT tcp:$PORT >/dev/null || { log "adb reverse failed"; kill $HUB $POL; exit 2; }
cleanup() { kill $HUB $POL 2>/dev/null; "$ADB" reverse --remove tcp:$PORT >/dev/null 2>&1; }
trap cleanup EXIT
cp "$OUT/policies/policy-1.json" "$OUT/carrier/current.json"
POLURL=http://127.0.0.1:$POLPORT/current.json; RELAY=http://127.0.0.1:$WEBPORT
source "$H/cpu/activation-capture.sh"   # cl: the preflighted capture (a capture failure stops the run with exit 3)
snap() { node "$CLI" state --state "$STATE" > "$OUT/state-$1.json" || capture_fail "snap $1" "\`pvm-client state\` exited non-zero"; }
thermal() {   # before each turn: the thermal status and the battery temperature (tenths of a degree C)
  local th bt; th=$(sh_ "dumpsys thermalservice" | sed -n 's/^Thermal Status: \([0-9]*\).*/\1/p' | head -1); bt=$(sh_ "dumpsys battery" | sed -n 's/^ *temperature: \([0-9]*\).*/\1/p' | head -1)
  echo "{\"turn\":$1,\"utc\":\"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\",\"thermalStatus\":${th:-null},\"batteryTempTenthsC\":${bt:-null}}" >> "$OUT/thermal.jsonl"; }
host() { echo "{\"turn\":$1,\"utc\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"loadavg\":\"$(cut -d' ' -f1-3 /proc/loadavg)\"}" >> "$OUT/host.jsonl"; }
launch() {
  local l="$RUN_ID-$1"
  sh_ "am force-stop $P; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard" >/dev/null; sleep 2
  local pw; pw=$(sh_ "dumpsys power"); grep -q 'mWakefulness=Awake' <<<"$pw" || { log "PHONE NOT AWAKE"; return 1; }
  sh_ "am start -S -n $P/.Main --es mode app --es vmname anchorlocal --es model $F/model.gguf --es app $F/app-stream-probe.wasm --es app_graph $GRAPH --ei app_tls 1 --ei app_serve_s $SERVE_S --es relay ws://127.0.0.1:$PORT/v1/fleet-tunnel --es name $NAME --es capture $l" > "$OUT/$1.am"
  LABEL=$l; local t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt 400 ]; do
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep 'APP evidence endpoint on vsock')" ] && { log "$1: the VM serves ($(( $(date +%s) - t0 )) s)"; return 0; }
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep '^CAPTURE END')" ] && { log "$1: ended before serving"; return 1; }
    sleep 5; done; log "$1: not serving within 400 s"; return 1; }
# the ten turn shapes, cycled: mode steps selection
SHAPES=("stream 24 dep" "whole 8 app" "stream 64 dep" "stream 8 app" "whole 24 dep" "stream 128 dep" "stream 24 app" "whole 64 dep" "stream 16 dep" "stream 48 app")
classify() {   # classify <turn> <label> <mode> <steps> <sel> <rc>: one turns.jsonl row; exit 0 only for a valid completed answer
  python3 - "$OUT/$2.jsonl" "$@" "$DEP" "$APPID" >> "$OUT/turns.jsonl" <<'PY'
import json, sys
f, turn, label, mode, steps, sel, rc, dep, app = sys.argv[1:10]; steps, rc = int(steps), int(rc)
lines = [json.loads(l) for l in open(f) if l.startswith("{")]
res = next((x["result"] for x in reversed(lines) if "result" in x), None)
toks, done = [], None
def parse(t):
    try: return json.loads(t)
    except Exception: return {"unparsed": t[:120]}
body = [parse(x["line"]) for x in lines if "line" in x] if mode == "stream" else [parse(l) for l in ((res or {}).get("body") or "").splitlines() if l.startswith("{")]
for b in body:
    if "token" in b: toks.append(b["token"])
    if b.get("done"): done = b
row = {"turn": int(turn), "label": label, "mode": mode, "steps": steps, "selection": sel, "rc": rc, "tokens": len(toks), "tokenIds": toks,
       "done": done, "firstTokenMs": (res or {}).get("firstTokenMs"), "ms": (res or {}).get("ms"), "stateGen": (res or {}).get("stateGen"),
       "nonce": ((res or {}).get("verified") or {}).get("nonce"), "deployment": (res or {}).get("deployment"), "clientVersion": (res or {}).get("clientVersion")}
if rc in (124, 137): cls = "timeout"
elif res is None: cls = "error: no result line" + (f" ({lines[-1].get('error')})" if lines and lines[-1].get("error") else "")
elif res.get("step") not in (None, "sealed") and res.get("refused"): cls = f"refused at {res['step']}: {res['refused'][:160]}"
elif mode == "stream" and not (res.get("complete") is True and res.get("tokens") == steps and len(toks) == steps and done and done.get("tokens") == steps): cls = f"incomplete stream: {res.get('error') or res.get('refused') or ''} tokens {res.get('tokens')}/{steps}"
elif mode == "whole" and not (res.get("status") == 200 and len(toks) == steps and done and done.get("tokens") == steps): cls = f"incomplete whole answer: status {res.get('status')} tokens {len(toks)}/{steps}"
elif res.get("clientVersion") != "0.4.1": cls = f"answered by {res.get('clientVersion')}, not the installed 0.4.1"
elif sel == "dep" and res.get("deployment") != {"id": dep, "app": app}: cls = f"deployment not bound: {res.get('deployment')}"
elif rc != 0: cls = f"exit {rc} with a complete answer"
else: cls = "valid"
row["class"] = cls; row["valid"] = cls == "valid"
print(json.dumps(row)); sys.exit(0 if row["valid"] else 1)
PY
}
diagnose() {   # the VM's capture so far, the hub's errors, the full thermal service dump
  sh_ "run-as $P cat files/capture/$L1.log" > "$OUT/diag/turn-$1-vm.log"; tail -50 "$OUT/hub.err" > "$OUT/diag/turn-$1-hub.err"; tail -50 "$OUT/hub.jsonl" > "$OUT/diag/turn-$1-hub.jsonl"
  sh_ "dumpsys thermalservice" > "$OUT/diag/turn-$1-thermal.txt"; sh_ "dumpsys power" | grep -E 'mWakefulness|mHoldingDisplay' > "$OUT/diag/turn-$1-power.txt"; }

log "== launch (VM serves $SERVE_S s)"
launch l1 || exit 1; L1=$LABEL
node "$CLI" install --state "$STATE" --policy-key-fp "$PFP" --serial-floor 1 --release-key-fp "$RFP" > "$OUT/cli-install.json"; echo $? > "$OUT/cli-install.rc"; snap 0-installed
host 0
attempted=0; valid=0; stopped=""
for i in $(seq 1 "$TURNS"); do
  read -r mode steps sel <<<"${SHAPES[$(( (i - 1) % ${#SHAPES[@]} ))]}"
  label=$(printf 'turn-%02d' "$i"); thermal "$i"
  args=(run --policy "$POLURL" --relay "$RELAY" --path "/?graph=$GRAPH&steps=$steps")
  [ "$mode" = whole ] && args+=(--whole)
  [ "$sel" = dep ] && args+=(--deployment "$DEP") || args+=(--app "$APPID")
  CL_TIMEOUT=$TURN_TIMEOUT cl "$label" "${args[@]}"; rc=$?
  attempted=$i
  if classify "$i" "$label" "$mode" "$steps" "$sel" "$rc"; then valid=$((valid + 1))
  else stopped="turn $i: $(tail -1 "$OUT/turns.jsonl" | python3 -c 'import json,sys; print(json.load(sys.stdin)["class"])')"; log "STOPPING at $stopped -- no restart; diagnostics in diag/"; diagnose "$i"; break; fi
  [ $((i % 10)) = 0 ] && host "$i"
  sleep 2
done
thermal '"end"'; host '"end"'; snap final
log "attempted $attempted, valid $valid${stopped:+, stopped at $stopped}"
sleep 3; sh_ "run-as $P cat files/capture/$L1.log" > "$OUT/l1.log"
sh_ "am force-stop $P" >/dev/null; log "the lab app was stopped by the script after the turns (the VM ends with it)"
cleanup; trap - EXIT; sleep 1
python3 - "$OUT" "$RUN_START" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$attempted" "$valid" "$stopped" <<'PY'
import json, sys
out, start, end, att, val, stopped = sys.argv[1:7]
rows = [json.loads(l) for l in open(f"{out}/exchanges.jsonl")]
json.dump({"preflight": "preflight.txt", "evidence": "every /evidence exchange recorded as received in evidence/ (public; sealed traffic and session secrets are never recorded)",
           "clock": "UTC", "runStart": start, "runEnd": end, "turnsPlanned": 50, "turnsAttempted": int(att), "turnsValid": int(val), "stoppedAt": stopped or None,
           "exchanges": [{"n": n, "label": r["label"], "stateAfter": r["after"]} for r in rows for n in r["exchanges"]]}, open(f"{out}/capture.json", "w"), indent=1)
PY
[ $? = 0 ] || { log "capture.json could not be assembled: stopping (exit 3)"; exit 3; }
python3 "$V/check-app-stability.py" "$OUT" | tee "$OUT/check.txt"
