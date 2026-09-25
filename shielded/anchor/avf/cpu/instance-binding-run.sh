#!/usr/bin/env bash
# instance-binding-run.sh <out_dir> <apk1> <code1> <apk2> <code2> -- the DEVICE capture for instance binding
# (INSTANCE-BINDING.md "The device campaign"; LAB, not production), on the Pixel 10's real VM, through the built client 0.5.0
# (pinned by sha, copied into a lab install directory outside the repository; lab keys made for this run outside it).
#   A. APK1: the VM logs its InstanceID; the client ENROLLS it (`pvm-client instance`, real v3 evidence under Google's roots,
#      the signer's own nonce); a type-2 policy binds the deployment to that InstanceID; then
#        - the bound deployment answers (v3, deployment.instance = the enrolled id);
#        - a second deployment of the same app, bound to ANOTHER instance, is refused by the client (the same genuine VM);
#        - an unbound deployment of the same app still answers over v2.
#   B. RESTART: the app and its VM stopped and started -- the InstanceID is logged again and compared; the bound deployment
#      answers under the SAME policy (a new transport key, the same instance).
#   C. SAME-KEY UPDATE: APK2 (a rebuild of the same sources: other bytes, another code hash, the same signing key) installed
#      over APK1 with its data kept -- the InstanceID is compared; the bound deployment is tried under the same policy
#      (which pins both code hashes). If APK2's VM does not serve, APK1 is reinstalled and relaunched (recovery, recorded).
# Every attempt is kept (exchanges.jsonl, the raw envelopes the carrier recorded, each call's output, each VM capture); a
# failure stops the run where it is, never retried. Re-provisioning (a new instance.img) is NOT done here: it wipes the lab
# app's data. The checker is runtime/conformance/check-instance-binding.py. Never reuse an output directory.
set -uo pipefail
OUT="$1"; APK1="$2"; CODE1="$3"; APK2="$4"; CODE2="$5"; H="$(cd "$(dirname "$0")/.." && pwd)"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; P=host.enclave.anchor.avf
V="$H/runtime/conformance"; BUNDLE="$V/bundles/stream-probe.wasm"; GRAPH="${GRAPH:-gemma-4-e2b-it-q4_0}"; NAME=pixel10-pvm-cpu
F=/data/user/0/$P/files; PORT=18443; APPPORT=18445; EVPORT=18446; WEBPORT=18447; SEALPORT=18448; POLPORT=18460; SERVE_S="${SERVE_S:-900}"
RUN_ID="${RUN_ID:-$(date +%m%d%H%M%S)}"; DIST="$H/client/dist/pvm-client.mjs"; SIGN="$H/client/tools/lab-sign.mjs"
BASE_SHA=32dad95102aebfafdc816b6f05420ca9d9a8a4de38adc6bbb2f9b14ffc0c580c   # the 0.5.0 dist results/pvm-cpu-instance-binding ran with; a new run pins the dist it runs
KEYS="${KEYS:-$HOME/.cache/enclave-pvm-client-lab/$RUN_ID}"; INSTALL="$KEYS/install"   # outside the repository
AUTH=cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f   # gitleaks:allow -- public, not a secret: sha512 of the TEST APK signing certificate (pins.py)
PIXEL_RID=d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba; ROOT22=cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc; ROOT25=6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0
APPID=$(sha256sum "$BUNDLE" | cut -c1-64)
DEP="0x$(printf 'lab: pixel10 instance binding, bound' | sha256sum | cut -c1-64)"; DEP_OTHER="0x$(printf 'lab: pixel10 instance binding, other instance' | sha256sum | cut -c1-64)"
DEP_UNBOUND="0x$(printf 'lab: pixel10 instance binding, unbound' | sha256sum | cut -c1-64)"; OTHER_INSTANCE=$(printf 'lab: an instance that is not this phone' | sha256sum | cut -c1-64)
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
[ -e "$OUT" ] && { echo "$OUT exists: refusing to mix runs"; exit 2; }
mkdir -p "$OUT/policies" "$OUT/vm" || exit 2
log() { echo "$(date -u +%H:%M:%SZ) $*" | tee -a "$OUT/run.log"; }
bash "$H/cpu/preflight-activation-capture.sh" "$OUT/preflight.txt" > /dev/null || { log "capture preflight FAILED (preflight.txt): not running"; exit 3; }
log "capture preflight: $(tail -1 "$OUT/preflight.txt")"
# ---- the built client 0.5.0, isolated state, lab keys ----
[ "$(sha256sum "$DIST" | cut -c1-64)" = "$BASE_SHA" ] || { log "client/dist/pvm-client.mjs is not the pinned 0.5.0 ($BASE_SHA): refusing"; exit 2; }
[ -e "$KEYS" ] && { log "$KEYS exists: refusing to reuse lab keys"; exit 2; }
mkdir -p "$INSTALL" && chmod 700 "$KEYS" && cp "$DIST" "$INSTALL/pvm-client.mjs" || exit 2
CLI="$INSTALL/pvm-client.mjs"; STATE="$OUT/cli-state.d"
node "$SIGN" keygen --keys "$KEYS" --name policy > "$OUT/policy-key.json" && node "$SIGN" keygen --keys "$KEYS" --name release > "$OUT/release-key.json" || { log "keygen failed"; exit 2; }
PFP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["fingerprint"])' "$OUT/policy-key.json"); RFP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["fingerprint"])' "$OUT/release-key.json")
sign_policy() {   # sign_policy <serial> <deployments json>: a TYPE-2 policy pinning both builds, formats v3 and v2
  python3 - "$1" "$2" "$CODE1" "$CODE2" "$AUTH" "$PIXEL_RID" "$APPID" "$ROOT22" "$ROOT25" > "$KEYS/policy-$1.body.json" <<'PY'
import json, sys, time
serial, deps, c1, c2, auth, rid, app, r22, r25 = sys.argv[1:10]
t = lambda s: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + s))
print(json.dumps({"type": "enclave-pvm-client-policy/2", "key": "", "serial": int(serial), "notBefore": t(-3600), "notAfter": t(6 * 3600), "codeHashes": [c1, c2],
     "authorityHashes": [auth], "runtimeIds": [rid], "appIds": [app], "googleRootPins": [r22, r25],
     "formats": ["enclave-pvm-app-evidence/v3", "enclave-pvm-app-evidence/v2"], "sealedModes": ["chunked", "whole"],
     "sealedWindow": {"seconds": 600, "maxRequests": 256}, "minClientVersion": "0.5.0", "nextPolicyKey": None, "deployments": json.loads(deps)}))
PY
  node "$SIGN" policy --keys "$KEYS" --body "$KEYS/policy-$1.body.json" --out "$OUT/policies/policy-$1.json" && cp "$OUT/policies/policy-$1.json" "$OUT/carrier/current.json"; }
mkdir -p "$OUT/carrier"
sign_policy 1 "[{\"id\":\"$DEP\",\"app\":\"$APPID\"}]" || { log "policy 1 signing failed"; exit 2; }
log "client $(node "$CLI" version) sha256 $BASE_SHA; app $APPID; APK1 code $CODE1, APK2 code $CODE2; lab keys $KEYS (not in the repository)"
# ---- the phone, the hub (the branch's tunnel.js: it verifies the instance-bound attach frame), the carriers ----
install_apk() { local want have; want=$(sha256sum "$1" | cut -c1-64); have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64)
  [ "$want" = "$have" ] && { log "installed APK is already $(basename "$1") ($want)"; return 0; }
  timeout 300 "$ADB" install -r "$1" </dev/null > "$OUT/install-$(basename "$1").txt" 2>&1 || { log "install of $(basename "$1") FAILED"; return 1; }
  log "installed $(basename "$1") over the previous build, data kept ($want)"; }
install_apk "$APK1" || exit 2
"$ADB" push "$BUNDLE" /data/local/tmp/app-stream-probe.wasm </dev/null >/dev/null && sh_ "run-as $P cp /data/local/tmp/app-stream-probe.wasm files/app-stream-probe.wasm" >/dev/null
( cd "$H" && exec node cpu/local-hub.mjs --port $PORT --code-hash "$CODE1,$CODE2" --authority $AUTH \
    --model-sha 5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48 --selftest-sha 9c4c7f764bf657c708cb19c6493a0be303db49093fd7df1432664cfd3801ce2f \
    --min-tok-s 10 --app-id "$APPID" --app-port $APPPORT --evidence-port $EVPORT --sealed-port $SEALPORT --web-port $WEBPORT --app-name $NAME --seconds $((3 * SERVE_S + 900)) \
    --record-evidence "$OUT/evidence" > "$OUT/hub.jsonl" 2> "$OUT/hub.err" ) & HUB=$!
( exec python3 -m http.server $POLPORT --bind 127.0.0.1 --directory "$OUT/carrier" > "$OUT/carrier.log" 2>&1 ) & POL=$!
sleep 2
# the hub must be RUNNING before the phone is sent to it (attempt 1 of this run crashed at startup and the VM waited 400 s)
kill -0 $HUB 2>/dev/null || { log "the hub exited at startup: $(tail -3 "$OUT/hub.err" | tr '\n' ' ')"; kill $POL; exit 2; }
"$ADB" reverse tcp:$PORT tcp:$PORT >/dev/null || { log "adb reverse failed"; kill $HUB $POL; exit 2; }
cleanup() { kill $HUB $POL 2>/dev/null; "$ADB" reverse --remove tcp:$PORT >/dev/null 2>&1; }
trap cleanup EXIT
POLURL=http://127.0.0.1:$POLPORT/current.json; RELAY=http://127.0.0.1:$WEBPORT
source "$H/cpu/activation-capture.sh"
launch() {   # launch <phase>: the lab app and its VM, serving the stream probe; sets LABEL; 0 once the evidence endpoint serves
  local l="$RUN_ID-$1"
  sh_ "am force-stop $P; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard" >/dev/null; sleep 2
  grep -q 'mWakefulness=Awake' <<<"$(sh_ "dumpsys power")" || { log "PHONE NOT AWAKE"; return 1; }
  sh_ "am start -S -n $P/.Main --es mode app --es vmname anchorlocal --es model $F/model.gguf --es app $F/app-stream-probe.wasm --es app_graph $GRAPH --ei app_tls 1 --ei app_serve_s $SERVE_S --es relay ws://127.0.0.1:$PORT/v1/fleet-tunnel --es name $NAME --es capture $l" > "$OUT/$1.am"
  LABEL=$l; local t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt 400 ]; do
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep 'APP evidence endpoint on vsock')" ] && { log "$1: the VM serves ($(( $(date +%s) - t0 )) s)"; return 0; }
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep '^CAPTURE END')" ] && { log "$1: ended before serving"; return 1; }
    sleep 5; done; log "$1: not serving within 400 s"; return 1; }
vmlog() { sh_ "run-as $P cat files/capture/$1.log" > "$OUT/vm/$2.log"; }
instance_of() { grep -o 'INSTANCE id=[0-9a-f]\{64\}' "$OUT/vm/$1.log" | head -1 | cut -d= -f2; }
result_of() { python3 -c 'import json,sys
r=[json.loads(l) for l in open(sys.argv[1]) if l.startswith("{")]
x=next((y for y in reversed(r) if "result" in y or "enroll" in y), {})
print(json.dumps(x.get("result") or x.get("enroll") or {}))' "$OUT/$1.jsonl"; }
fail() { log "STOP: $*"; vmlog "$LABEL" "stop-$PHASE"; sh_ "am force-stop $P" >/dev/null; exit 1; }
# the VM answers at most one evidence request every 2 s (payload evidence_server): every exchange waits 3 s first (attempt 2
# of this run sent the bound turn 1 s after the enrollment and got the VM's pace refusal)
turn() { sleep 3; CL_TIMEOUT=240 cl "$1" run --policy "$POLURL" --relay "$RELAY" --deployment "$2" --path "/?graph=$GRAPH&steps=8"; }

node "$CLI" install --state "$STATE" --policy-key-fp "$PFP" --serial-floor 1 --release-key-fp "$RFP" > "$OUT/cli-install.json" || { log "client install failed"; exit 2; }
# ================= A. APK1: enroll, bind, serve; another instance refused; unbound still served =================
PHASE=A; log "== A: APK1"
launch a || fail "APK1's VM did not serve"; LA=$LABEL; sleep 3; vmlog "$LA" a
X1=$(instance_of a); [ -n "$X1" ] || fail "no INSTANCE line in the VM's capture"
log "A: the VM logged INSTANCE $X1"
sleep 3; CL_TIMEOUT=240 cl enroll-a instance --policy "$POLURL" --relay "$RELAY" --deployment "$DEP" --out "$OUT/enroll-a.json"
E=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("instanceId",""))' "$OUT/enroll-a.json" 2>/dev/null)
log "A: enrolled $E (the client's own v3 exchange, Google's roots) -- the VM logged $X1"
[ "$E" = "$X1" ] || fail "the enrolled InstanceID ($E) is not the one the VM logged ($X1)"
sign_policy 2 "[{\"id\":\"$DEP\",\"app\":\"$APPID\",\"instances\":[\"$E\"]},{\"id\":\"$DEP_OTHER\",\"app\":\"$APPID\",\"instances\":[\"$OTHER_INSTANCE\"]},{\"id\":\"$DEP_UNBOUND\",\"app\":\"$APPID\"}]" || fail "policy 2 signing failed"
turn bound-a "$DEP"; R=$(result_of bound-a); log "A: bound $DEP -> $(python3 -c 'import json,sys; r=json.loads(sys.argv[1]); print({k: r.get(k) for k in ("complete","step","refused","deployment")})' "$R")"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); sys.exit(0 if r.get("complete") is True and r["deployment"]["instance"] == sys.argv[2] and r["verified"]["format"].endswith("/v3") else 1)' "$R" "$E" || fail "the bound deployment did not answer as bound"
turn other-a "$DEP_OTHER"; R=$(result_of other-a); log "A: another deployment bound to another instance -> $(python3 -c 'import json,sys; r=json.loads(sys.argv[1]); print({k: r.get(k) for k in ("step","refused","sent")})' "$R")"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); sys.exit(0 if r.get("step") == "verify" and "not one bound" in (r.get("refused") or "") and r.get("sent") is False else 1)' "$R" || fail "the other deployment's binding was not enforced"
turn unbound-a "$DEP_UNBOUND"; R=$(result_of unbound-a); log "A: unbound -> $(python3 -c 'import json,sys; r=json.loads(sys.argv[1]); print({k: r.get(k) for k in ("complete","deployment")}, r.get("verified",{}).get("format"))' "$R")"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); sys.exit(0 if r.get("complete") is True and r["deployment"]["bound"] is False and r["verified"]["format"].endswith("/v2") else 1)' "$R" || fail "the unbound deployment did not answer over v2"
vmlog "$LA" a
# ================= B. RESTART: the same instance, a new transport key =================
PHASE=B; log "== B: restart"
launch b || fail "the VM did not serve after the restart"; LB=$LABEL; sleep 3; vmlog "$LB" b
X2=$(instance_of b); log "B: the VM logged INSTANCE $X2 after the restart ($([ "$X2" = "$X1" ] && echo SAME || echo DIFFERENT))"
turn bound-b "$DEP"; R=$(result_of bound-b); log "B: bound $DEP -> $(python3 -c 'import json,sys; r=json.loads(sys.argv[1]); print({k: r.get(k) for k in ("complete","step","refused","deployment")})' "$R")"
vmlog "$LB" b
# ================= C. SAME-KEY UPDATE: APK2 over APK1, data kept =================
PHASE=C; log "== C: APK2 (same key, other bytes and code hash) installed over APK1, data kept"
sh_ "am force-stop $P" >/dev/null; install_apk "$APK2" || fail "APK2 did not install"
if launch c; then LC=$LABEL; sleep 3; vmlog "$LC" c
  X3=$(instance_of c); log "C: the VM logged INSTANCE $X3 after the update ($([ "$X3" = "$X1" ] && echo SAME || echo DIFFERENT))"
  turn bound-c "$DEP"; R=$(result_of bound-c); log "C: bound $DEP -> $(python3 -c 'import json,sys; r=json.loads(sys.argv[1]); print({k: r.get(k) for k in ("complete","step","refused","deployment")})' "$R")"
  vmlog "$LC" c
else
  LC=$LABEL; vmlog "$LC" c; log "C: APK2's VM did not serve: recovering with APK1"
  sh_ "am force-stop $P" >/dev/null; install_apk "$APK1" && launch d && { vmlog "$LABEL" d; log "D: APK1 serves again; INSTANCE $(instance_of d)"; } || log "D: APK1 did NOT recover the lab VM"
fi
sh_ "am force-stop $P" >/dev/null; log "the lab app was stopped by the script (the VM ends with it)"
cp "$OUT/hub.jsonl" "$OUT/hub-final.jsonl" 2>/dev/null
log "done: A $X1 / B ${X2:-none} / C ${X3:-none}"
