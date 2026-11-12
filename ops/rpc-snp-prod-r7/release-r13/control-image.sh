#!/bin/bash
# Put metal0 on the control image whose platform host policy read quorum answers, so that it takes work again, then
# follow Enclave RPC r13 up (finish.sh).
#
#   control-image.sh apply [STATUS_URL] [CVM_SSH]   relay allowlist, image switch with rollback, wait for the claim, finish.sh
#   control-image.sh rollback                       back to the previous image (its measurement stays allowlisted)
#
# Why: the image b4446c3 reads the policy through 3 of 4 public Base RPCs, of which one is closed and one rate-limits
# keyless traffic, so the host logs "not serving: policy unreadable: only 2 RPCs answered (need 3)" and its claim sweep
# skips every deployment. 16520ea is the same tree with five endpoints that answer (majority 3); nothing else differs.
set -euo pipefail

STATUS=${2:-http://127.0.0.1:42291/status}; CVM=${3:-/vm/enclave-volumes/rpc-snp-release-r13/cvm.sh}
HERE=$(cd "$(dirname "$0")" && pwd)
NEW=/home/steven/enclave-prod/dist-snpvm-16520ea
OLD=/home/steven/enclave-prod/dist-snpvm-b4446c3
MEAS=a74528dc6910b64656f5c9e5126e2f4eb04b39232a5358c1248c206ea03a9fbe10c0a4d509f2d8d22ed08cea3e0ee1e8
OLD_MEAS=c9fe2438ecd90e3313cec6e2557587c621b5f45714c35a993ac7ef2342133af11efa7fdaf788d14b16038ca5d94e12d5
INITRD_SHA=a6b7e1a7694087ef2e00c1f8d53d90923bd68aaaf1b55d7891a6451b7e3d51e0
CFG=/home/steven/Projects/enclave/metal/config.json
BAK=$CFG.before-snpvm-16520ea
UNIT=enclave-metal.service
ID=0x5ff56a4d600191f13ac43e1c600965673555f229472846a9da201785d396454f

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
log_since() { journalctl --user -u $UNIT --since "$1" --no-pager -o cat; }
# wait_log SECONDS SINCE PATTERN: poll the unit's journal every 10 s
wait_log() { local left=$1; until log_since "$2" | grep -qE "$3"; do left=$((left-10)); [ $left -gt 0 ] || return 1; sleep 10; done; }
dist_of() { python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["dist"])' "$CFG"; }
set_dist() {
  python3 -I - "$CFG" "$1" <<'PY'
import json, os, sys
f, dist = sys.argv[1:]; c = json.load(open(f)); c["dist"] = dist
st = os.stat(f); fd = os.open(f + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, st.st_mode & 0o777)
os.write(fd, (json.dumps(c, indent=2) + "\n").encode()); os.close(fd); os.replace(f + ".new", f)
PY
}
leased() { [ "$(curl -s -m 40 "$STATUS" | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("leased"))' 2>/dev/null)" = True ]; }

rollback() {
  [ -f "$BAK" ] || { say "no previous config kept ($BAK)"; exit 1; }
  cp -p "$BAK" "$CFG.new"; mv "$CFG.new" "$CFG"
  systemctl --user restart $UNIT
  say "metal0 restarted on $(dist_of)"
}

apply() {
  [ "$(sha256sum "$NEW/initramfs.cpio.gz" | cut -d' ' -f1)" = "$INITRD_SHA" ] && [ "$(cat "$NEW/MEASUREMENT")" = "$MEAS" ] ||
    { say "$NEW is not the recorded image"; exit 1; }

  # the relay attaches a metal host only on a listed measurement
  "$CVM" 'sudo -n python3 -I -' <<PY
import os, shutil, subprocess, time
f = "/etc/nan-relay/linux-leasegas-measurements.env"; new = "$MEAS"; old = "$OLD_MEAS"
lines = open(f).read().splitlines()
assert len(lines) == 1 and lines[0].startswith("METAL_ALLOWED_MEASUREMENTS="), "unexpected file shape"
have = lines[0].split("=", 1)[1].split(",")
assert old in have, "the running image's measurement is not listed"
if new in have: print("relay: measurement already listed")
else:
    bak = f + ".before-snpvm-16520ea"
    if not os.path.exists(bak): shutil.copy2(f, bak)
    st = os.stat(f); tmp = f + ".new"
    open(tmp, "w").write(lines[0] + "," + new + "\n"); os.chmod(tmp, st.st_mode & 0o777); os.chown(tmp, st.st_uid, st.st_gid); os.replace(tmp, f)
    subprocess.run(["systemctl", "restart", "enclave-api-relay"], check=True); time.sleep(8)
    print("relay: measurement listed (%d), previous file kept as %s" % (len(have) + 1, os.path.basename(bak)))
state = subprocess.run(["systemctl", "is-active", "enclave-api-relay"], capture_output=True, text=True).stdout.strip()
print("relay:", state); assert state == "active"
PY

  local since
  if [ "$(dist_of)" = "$NEW" ] && [ "$(systemctl --user is-active $UNIT)" = active ]; then
    say "metal0 already runs $NEW"
    since=$(systemctl --user show $UNIT -p ActiveEnterTimestamp --value)
  else
    [ "$(dist_of)" = "$OLD" ] || { say "metal0's config names $(dist_of), not $OLD; not touching it"; exit 1; }
    [ -f "$BAK" ] || cp -p "$CFG" "$BAK"
    set_dist "$NEW"
    since=$(date '+%Y-%m-%d %H:%M:%S')
    systemctl --user restart $UNIT
    say "metal0 restarted on $NEW"
    if ! wait_log 300 "$since" "attest ACCEPTED meas=${MEAS:0:16}"; then
      log_since "$since" | grep -E 'attest|agent\]|error|FAILED' | tail -n 8 | cut -c1-220
      say "the relay did not accept the new image within 5 minutes; putting the previous image back"; rollback; exit 1
    fi
    say "relay accepted measurement ${MEAS:0:16}…"
  fi

  if wait_log 420 "$since" 'host-policy\] this host is ADMITTED'; then say "platform host policy read: metal0 is admitted and taking work"
  else log_since "$since" | grep 'host-policy' | tail -n 4 | cut -c1-220; say "metal0 is not admitted yet; see the lines above"; exit 1; fi
  wait_log 300 "$since" 'adopted: app=' || say "no app re-adopted yet"
  log_since "$since" | grep -E 'adopted: app=' | cut -c1-140 || true

  say "waiting for metal0 to claim $ID"
  local left=1200; until leased; do left=$((left-15)); [ $left -gt 0 ] || break; sleep 15; done
  log_since "$since" | grep -E "${ID:0:10}" | grep -v 'sweep skips' | tail -n 6 | cut -c1-260 || true
  leased || { say "not claimed after 20 minutes; the lines above say why"; exit 1; }
  say "claimed"

  if pgrep -f 'release-r13/finish\.sh' >/dev/null; then say "finish.sh is already running in another terminal; it carries on from here"
  else exec bash "$HERE/finish.sh" "$STATUS" "$CVM"; fi
}

case ${1:-} in
  apply) apply;;
  rollback) rollback;;
  *) sed -n 2,10p "$0"; exit 2;;
esac
