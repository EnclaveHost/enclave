#!/bin/sh
# guestd on hardware: two apps, two SNP guests, through the /vms contract the supervisor already speaks.
#
# What must hold, each checked from OUTSIDE guestd where it matters - guestd verifying its own guests would be a
# check that covers nothing if guestd were wrong:
#   G1  guestd will not start unless enabled by name, and not over a firmware that is not pinned as verifying
#   G2  two different bundles become two RUNNING guests, each reported only after guestd's own attestation
#   G3  the measurement guestd reports for each equals a prediction this test makes ITSELF from the same bundle,
#       and the two differ: the app is in each guest's measurement
#   G4  an independent client, holding each app's own expectations, ATTESTS each guest; holding the OTHER app's,
#       it REFUSES - so the two guests are distinguishable to a verifier and not interchangeable
#   G5  the live daemon refuses what it cannot honour (owner secrets) and what has no contract identity
#   G6  a guest that dies is reported "failed" (what the supervisor's instanceAlive reads)
#   G7  DELETE ends each guest exactly as the supervisor expects (200, then 404), its unit is gone, its workdir is
#       gone and its forwarder is closed; SIGTERM leaves no guestd unit behind
#
# This is ONE app per SNP guest (M4a's shape). It is not the M4b plane path, and it says nothing about planes.
#
#   usage: test-guestd.sh [workdir]
set -e
here=$(cd "$(dirname "$0")" && pwd)
iso=$(cd "$here/.." && pwd)
W=${1:-$HOME/enclave-bench/guestd-test-$(date +%H%M%S)}
mkdir -p "$W"; W=$(cd "$W" && pwd)
fails=0
check() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
BT=$here/.bundle
[ -x "$BT" ] || (cd "$iso/contract" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags='-s -w -buildid=' -o "$BT" ./cmd/bundle)
(cd "$here/guestd" && go build -o "$W/guestd" .)
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
api() {   # api METHOD PATH [JSON] -> prints the HTTP code; the body lands in $W/api.body
  if [ -n "${3:-}" ]; then
    curl -s -o "$W/api.body" -w '%{http_code}' -X "$1" "http://127.0.0.1:$P$2" -H 'content-type: application/json' --data "$3"
  else
    curl -s -o "$W/api.body" -w '%{http_code}' -X "$1" "http://127.0.0.1:$P$2"
  fi
}
field() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get(sys.argv[2], ""))' "$W/api.body" "$1"; }

# two genuinely different apps: the label is compiled into the component
for L in AAAAA BBBBB; do
  M2_LABEL=$L cargo build --release --locked --target wasm32-wasip2 --manifest-path "$iso/m2/app/Cargo.toml" \
    --target-dir "$W/target-$L" 2> "$W/cargo-$L.txt"
  cp "$W/target-$L/wasm32-wasip2/release/m2_app.wasm" "$W/app-$L.wasm"
done
"$BT" build -label A -cpu 100 -mem 512 -vcpus 1 "$W/app-AAAAA.wasm" "$W/A.bundle" > /dev/null
"$BT" build -label B -cpu 100 -mem 512 -vcpus 1 "$W/app-BBBBB.wasm" "$W/B.bundle" > /dev/null
idA=$("$BT" id "$W/A.bundle"); idB=$("$BT" id "$W/B.bundle")

# G1 ------------------------------------------------------------------------------------------------------------
P=$(port)
r=ok
"$W/guestd" -isolation "$iso" -listen "127.0.0.1:$P" -root "$W/root" > "$W/g1-disabled.txt" 2>&1 && r=no
grep -q "guestd is disabled" "$W/g1-disabled.txt" || r=no
GUESTD_ENABLE=1 "$W/guestd" -isolation "$iso" -listen "127.0.0.1:$P" -root "$W/root" \
  -ovmf /usr/share/edk2/x64/OVMF.4m.fd > "$W/g1-distrofw.txt" 2>&1 && r=no
grep -q "is not pinned as VERIFYING" "$W/g1-distrofw.txt" || r=no
GUESTD_ENABLE=1 "$W/guestd" -isolation "$iso" -listen "0.0.0.0:$P" -root "$W/root" > "$W/g1-remote.txt" 2>&1 && r=no
grep -q "must be a loopback address" "$W/g1-remote.txt" || r=no
check "G1 guestd refuses to start when not enabled, over the distro firmware, or off loopback" $r

GUESTD_ENABLE=1 "$W/guestd" -isolation "$iso" -listen "127.0.0.1:$P" -root "$W/root" > "$W/guestd.log" 2>&1 &
GPID=$!
trap 'kill $GPID 2>/dev/null || true' EXIT
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$P/health" > /dev/null && break; sleep 1; done

# G2 ------------------------------------------------------------------------------------------------------------
body() { printf '{"image":"file://%s","name":"%s","cpuShare":0.25,"gpuShare":0,"appPort":8080,"ports":[],"config":"","configCid":"","egress":""}' "$1" "$2"; }
[ "$(api POST /vms "$(body "$W/A.bundle" 0xaaaa)")" = 201 ] && vA=$(field id) || vA=
cp "$W/api.body" "$W/create-A.json"
[ "$(api POST /vms "$(body "$W/B.bundle" 0xbbbb)")" = 201 ] && vB=$(field id) || vB=
cp "$W/api.body" "$W/create-B.json"
st() { api GET "/vms/$1" > /dev/null; field status; }
for _ in $(seq 400); do
  a=$(st "$vA"); b=$(st "$vB")
  case "$a$b" in *failed*) break ;; runningrunning) break ;; esac
  sleep 1
done
api GET "/vms/$vA" > /dev/null; cp "$W/api.body" "$W/A.vm.json"
api GET "/vms/$vB" > /dev/null; cp "$W/api.body" "$W/B.vm.json"
j() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$1" "$2"; }
echo "   A: $(cat "$W/A.vm.json")"
echo "   B: $(cat "$W/B.vm.json")"
[ -n "$vA" ] && [ -n "$vB" ] && [ "$(j "$W/A.vm.json" status)" = running ] && [ "$(j "$W/B.vm.json" status)" = running ] \
  && [ "$(j "$W/A.vm.json" verdict)" = attested ] && [ "$(j "$W/B.vm.json" appId)" = "$idB" ] \
  && [ "$(j "$W/A.vm.json" appId)" = "$idA" ] && r=ok || r=no
check "G2 two different bundles are two RUNNING guests, each attested by guestd as its own app" $r

# G3 ------------------------------------------------------------------------------------------------------------
"$here/build-app-guest.sh" "$W/A.bundle" "$W/A.pred.cpio.gz" 1 > "$W/A.pred.txt"
"$here/build-app-guest.sh" "$W/B.bundle" "$W/B.pred.cpio.gz" 1 > "$W/B.pred.txt"
pA=$(sed -n 's/^predicted measurement: //p' "$W/A.pred.txt" | tr A-F a-f)
pB=$(sed -n 's/^predicted measurement: //p' "$W/B.pred.txt" | tr A-F a-f)
[ ${#pA} = 96 ] && [ "$pA" = "$(j "$W/A.vm.json" measurement)" ] && [ "$pB" = "$(j "$W/B.vm.json" measurement)" ] \
  && [ "$pA" != "$pB" ] && r=ok || r=no
check "G3 each guest's measurement equals this test's own prediction from its bundle, and the two differ" $r

# G4 ------------------------------------------------------------------------------------------------------------
MINTCB=$HOME/.cache/enclave-isolation/m3-clean/min-tcb.json
TR="--no-kds --vcek $HOME/.cache/enclave-isolation/m3-clean/vcek.der --amd-chain Turin=$iso/../test/fixtures/amd/Turin-cert_chain.pem --min-tcb @$MINTCB"
"$iso/contract/runtime-identity.sh" "$(command -v wasmtime)" > "$W/runtime.json"
cl() { o=$1; hp=$2; shift 2; timeout 300 node "$iso/m2/client.mjs" "https://127.0.0.1:$hp" "$@" $TR --runtime "$W/runtime.json" > "$W/$o" 2>&1 || true; }
hA=$(j "$W/A.vm.json" hostPort); hB=$(j "$W/B.vm.json" hostPort)
cl A.client "$hA" --measurement "$pA" --app-sha "$idA"
cl B.client "$hB" --measurement "$pB" --app-sha "$idB"
cl A-at-B.client "$hB" --measurement "$pA" --app-sha "$idA"
cl B-at-A.client "$hA" --measurement "$pB" --app-sha "$idB"
v() { sed -n 's/^VERDICT \([a-z-]*\).*/\1/p' "$W/$1" | head -1; }
for f in A.client B.client A-at-B.client B-at-A.client; do echo "   $f: $(grep -a '^VERDICT' "$W/$f" | cut -c1-110)"; done
echo "   A served $(grep -a '^RESULT app_body=' "$W/A.client")   B served $(grep -a '^RESULT app_body=' "$W/B.client")"
[ "$(v A.client)" = attested ] && [ "$(v B.client)" = attested ] && [ "$(v A-at-B.client)" = reject ] \
  && [ "$(v B-at-A.client)" = reject ] && grep -q 'app_body="APP AAAAA' "$W/A.client" \
  && grep -q 'app_body="APP BBBBB' "$W/B.client" && r=ok || r=no
check "G4 an independent client ATTESTS each guest as its own app, and REFUSES each with the other app's expectations" $r

# G5 ------------------------------------------------------------------------------------------------------------
r=ok
[ "$(api POST /vms '{"image":"file://'"$W"'/A.bundle","name":"0xcccc","secrets":{"K":"v"}}')" = 422 ] || r=no
grep -q "secrets" "$W/api.body" || r=no
[ "$(api POST /vms '{"image":"file://'"$W"'/app-AAAAA.wasm","name":"0xdddd"}')" = 422 ] || r=no
[ "$(api POST /vms '{"image":"ipfs://bafyexample","name":"0xeeee"}')" = 422 ] || r=no
check "G5 the live daemon refuses owner secrets, a bare component and a catalog CID it cannot map to a bundle" $r

# G6 ------------------------------------------------------------------------------------------------------------
uB=$(sed -n 's/.* unit=\([^ ]*\).*/\1/p' "$W/root/$vB/$vB.host" | head -1)
systemctl --user kill -s KILL "$uB" 2>/dev/null || true
for _ in $(seq 30); do [ "$(st "$vB")" = failed ] && break; sleep 1; done
api GET "/vms/$vB" > /dev/null; cp "$W/api.body" "$W/B.dead.json"
echo "   B after its guest was killed: $(cat "$W/B.dead.json")"
[ "$(j "$W/B.dead.json" status)" = failed ] && r=ok || r=no
check "G6 a guest that dies is reported failed, which is what the supervisor's instanceAlive reads" $r

# G7 ------------------------------------------------------------------------------------------------------------
uA=$(sed -n 's/.* unit=\([^ ]*\).*/\1/p' "$W/root/$vA/$vA.host" | head -1)
r=ok
[ "$(api DELETE "/vms/$vA")" = 200 ] || r=no
[ "$(api DELETE "/vms/$vA")" = 404 ] || r=no
[ "$(api DELETE "/vms/$vB")" = 200 ] || r=no
systemctl --user is-active -q "$uA" 2>/dev/null && r=no
[ -e "$W/root/$vA" ] && r=no
[ -e "$W/root/$vB" ] && r=no
curl -s -m 3 -k "https://127.0.0.1:$hA/" > /dev/null 2>&1 && r=no
kill "$GPID"; wait "$GPID" 2>/dev/null || true
trap - EXIT
[ -z "$(systemctl --user list-units --plain --no-legend --all 'm2-gd*' 2>/dev/null)" ] || r=no
check "G7 DELETE confirms (200 then 404), the unit, workdir and forwarder are gone, and SIGTERM leaves no guest" $r

echo
echo "guestd: $([ $fails -eq 0 ] && echo "all checks passed" || echo "$fails check(s) not passed")  (workdir $W)"
exit $fails
