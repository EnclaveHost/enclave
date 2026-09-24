#!/bin/sh
# guestd-control/1 through the REAL binary's flags, locally: no guest is launched. What the unit tests cannot reach
# is the wiring - -gen-key, -auth-key, the refusal to start on a bad key file, and the lab mode without one.
#
#   C1  -gen-key writes a 0600 key once and refuses to overwrite it
#   C2  guestd refuses to START on a group- or world-readable key file, and on a malformed one
#   C3  with a key: every unauthenticated request is refused (401) and nothing is created
#   C4  with a key: the supervisor's client (control-client.mjs) handshakes, reads and leases over signed requests
#   C5  without a key: lab mode, loopback only, and the handshake refuses, so the client fails closed
#   C6  off loopback: refused whether or not a key is configured (the transport bridge is not built)
#
#   usage: test-guestd-control.sh [workdir]
set -e
here=$(cd "$(dirname "$0")" && pwd)
iso=$(cd "$here/.." && pwd)
W=${1:-$HOME/enclave-bench/guestd-control-test-$(date +%H%M%S)}
mkdir -p "$W"; W=$(cd "$W" && pwd)
fails=0
check() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
(cd "$here/guestd" && go build -o "$W/guestd" .)
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
up() { for _ in $(seq 60); do curl -s -o /dev/null "http://127.0.0.1:$1/control/hello" && return 0; sleep 0.5; done; return 1; }

# C1 ------------------------------------------------------------------------------------------------------------
r=ok
"$W/guestd" -gen-key "$W/pair.key" > "$W/genkey.txt" || r=no
[ "$(stat -c %a "$W/pair.key")" = 600 ] || r=no
grep -qE '^[0-9a-f]{64}$' "$W/pair.key" || r=no
cp "$W/pair.key" "$W/pair.key.before"
"$W/guestd" -gen-key "$W/pair.key" > /dev/null 2>&1 && r=no
cmp -s "$W/pair.key" "$W/pair.key.before" || r=no
check "C1 -gen-key writes a private key once and refuses to overwrite it ($(cat "$W/genkey.txt" | cut -c1-20))" $r

# C2 ------------------------------------------------------------------------------------------------------------
r=ok; P=$(port)
for bad in 640 604; do
  cp "$W/pair.key" "$W/bad.key"; chmod "$bad" "$W/bad.key"
  GUESTD_ENABLE=1 "$W/guestd" -isolation "$iso" -listen "127.0.0.1:$P" -root "$W/root" -auth-key "$W/bad.key" \
    > "$W/bad-$bad.txt" 2>&1 && r=no
  grep -q "readable or writable by others" "$W/bad-$bad.txt" || r=no
  rm -f "$W/bad.key"
done
printf 'nothex\n' > "$W/junk.key"; chmod 600 "$W/junk.key"
GUESTD_ENABLE=1 "$W/guestd" -isolation "$iso" -listen "127.0.0.1:$P" -root "$W/root" -auth-key "$W/junk.key" \
  > "$W/bad-junk.txt" 2>&1 && r=no
grep -q "exactly 64 lowercase hex" "$W/bad-junk.txt" || r=no
check "C2 guestd refuses to start on a group- or world-readable key and on a malformed one" $r

# C3 + C4 -------------------------------------------------------------------------------------------------------
P=$(port)
GUESTD_ENABLE=1 "$W/guestd" -isolation "$iso" -listen "127.0.0.1:$P" -root "$W/root" -auth-key "$W/pair.key" \
  > "$W/auth.log" 2>&1 &
GPID=$!
trap 'kill $GPID 2>/dev/null || true' EXIT
up "$P" || { echo "guestd did not come up:"; tail -5 "$W/auth.log"; exit 1; }
r=ok
for q in "GET /health" "GET /vms" "POST /vms/lease" "POST /vms" "POST /prefetch"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X "${q% *}" "http://127.0.0.1:$P${q#* }" -H 'content-type: application/json' -d '{}')
  [ "$code" = 401 ] || { echo "     $q: $code"; r=no; }
done
check "C3 with a key, every unauthenticated request is refused (401)" $r
node --input-type=module -e '
import { GuestdControl, parseKey } from "'"$here"'/guestd/control-client.mjs";
import fs from "node:fs";
const c = new GuestdControl(process.argv[1], parseKey(fs.readFileSync(process.argv[2], "utf8")));
const h = await c.request("GET", "/health");
const v = await c.request("GET", "/vms");
const l = await c.request("POST", "/vms/lease", { ids: [] });
console.log(JSON.stringify({ health: h.status, backend: h.body.backend, vms: v.body.vms.length, lease: l.status, instance: c.instance }));
' "http://127.0.0.1:$P" "$W/pair.key" > "$W/client.json" 2> "$W/client.err" || true
echo "     client: $(cat "$W/client.json" "$W/client.err" | head -2)"
r=ok
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["health"]==200 and d["backend"]=="snp-guest-per-app" and d["vms"]==0 and d["lease"]==200 else 1)' "$W/client.json" || r=no
grep -q "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["instance"])' "$W/client.json" 2>/dev/null || echo NONE)" "$W/auth.log" || r=no
check "C4 with a key, the supervisor's client handshakes with THIS instance and its signed requests are served" $r
kill $GPID; wait $GPID 2>/dev/null || true
trap - EXIT

# C5 ------------------------------------------------------------------------------------------------------------
P=$(port)
GUESTD_ENABLE=1 "$W/guestd" -isolation "$iso" -listen "127.0.0.1:$P" -root "$W/root" > "$W/lab.log" 2>&1 &
GPID=$!
trap 'kill $GPID 2>/dev/null || true' EXIT
up "$P" || { echo "guestd (lab) did not come up"; exit 1; }
r=ok
grep -q "NO pairing key: unauthenticated LAB mode, loopback only" "$W/lab.log" || r=no
node --input-type=module -e '
import { GuestdControl, parseKey } from "'"$here"'/guestd/control-client.mjs";
import fs from "node:fs";
await new GuestdControl(process.argv[1], parseKey(fs.readFileSync(process.argv[2], "utf8"))).request("GET", "/health");
' "http://127.0.0.1:$P" "$W/pair.key" > /dev/null 2> "$W/lab-client.err" && r=no
grep -q "does not speak guestd-control/1" "$W/lab-client.err" || r=no
kill $GPID; wait $GPID 2>/dev/null || true
trap - EXIT
check "C5 without a key: lab mode, and the client refuses it rather than falling back" $r

# C6 ------------------------------------------------------------------------------------------------------------
r=ok
for k in "" "-auth-key $W/pair.key"; do
  # shellcheck disable=SC2086
  GUESTD_ENABLE=1 "$W/guestd" -isolation "$iso" -listen "0.0.0.0:$(port)" -root "$W/root" $k > "$W/remote.txt" 2>&1 && r=no
  grep -q "must be a loopback address" "$W/remote.txt" || r=no
done
check "C6 a non-loopback listener is refused with and without a key" $r

echo
echo "guestd-control: $([ $fails -eq 0 ] && echo "all checks passed" || echo "$fails check(s) not passed")  (workdir $W)"
exit $fails
